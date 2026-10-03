import {
  HonkAuthError,
  HonkConflictError,
  HonkError,
  HonkNetworkError,
  HonkQuotaError,
  HonkServerError,
  HonkTimeoutError,
  HonkValidationError,
  type FieldError,
  type HonkErrorInit,
} from './errors.js';
import type { Defaults, HelperOptions, HonkOptions, Message, SendOptions, SendResult, Severity } from './types.js';
import { uuidv7 } from './uuid.js';
import { buildBody, checkIdempotencyKey } from './validate.js';

export const VERSION = '0.1.0';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 4;
const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 8_000;

/** Seconds from a Retry-After header (delta-seconds or HTTP date), or undefined. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

class TimeoutSignal {}

/**
 * Client for `POST /v1/messages`. Create one per process and reuse it (connections are kept alive).
 *
 * ```ts
 * const honk = new Honk({ url: process.env.HONK_URL!, key: process.env.HONK_KEY! });
 * await honk.send({ title: 'Backup finished', message: 'nightly pg_dump took 42 s', severity: 'success' });
 * ```
 */
export class Honk {
  readonly url: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly deadlineMs: number;
  readonly defaults: Readonly<Defaults>;
  readonly validate: boolean;
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #backoffBase: number;
  readonly #backoffMax: number;
  readonly #userAgent: string;

  constructor(options: HonkOptions) {
    if (options === null || typeof options !== 'object') throw new TypeError('Honk: pass options like { url, key }');
    this.url = normalizeUrl(options.url);
    this.#key = normalizeKey(options.key);
    this.timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.deadlineMs = positive(options.deadlineMs, DEFAULT_DEADLINE_MS, 'deadlineMs');
    this.retries = options.retries ?? DEFAULT_RETRIES;
    if (!Number.isInteger(this.retries) || this.retries < 0) throw new TypeError('Honk: retries must be an integer ≥ 0');
    this.#backoffBase = positive(options.backoff?.baseMs, DEFAULT_BACKOFF_BASE_MS, 'backoff.baseMs');
    this.#backoffMax = positive(options.backoff?.maxMs, DEFAULT_BACKOFF_MAX_MS, 'backoff.maxMs');
    this.defaults = Object.freeze({ ...(options.defaults ?? {}) });
    this.validate = options.validate ?? true;
    const f = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof f !== 'function') throw new TypeError('Honk: no fetch available; use Node 18+ or pass options.fetch');
    this.#fetch = f;
    this.#userAgent = `honk-me-node/${VERSION}${options.userAgent ? ` ${options.userAgent}` : ''}`;
  }

  /**
   * Reads `HONK_URL`, `HONK_KEY` and optionally `HONK_SOURCE`, `HONK_ENVIRONMENT`, `HONK_CHANNEL`
   * from the environment. `options` override them.
   */
  static fromEnv(options: Partial<HonkOptions> = {}): Honk {
    const env = (name: string): string | undefined => {
      const g = globalThis as {
        process?: { env?: Record<string, string | undefined> };
        Deno?: { env?: { get(n: string): string | undefined } };
      };
      return g.process?.env?.[name] ?? g.Deno?.env?.get(name);
    };
    return new Honk({
      ...options,
      url: options.url ?? env('HONK_URL') ?? '',
      key: options.key ?? env('HONK_KEY') ?? '',
      defaults: {
        source: env('HONK_SOURCE'),
        environment: env('HONK_ENVIRONMENT'),
        channel: env('HONK_CHANNEL'),
        ...options.defaults,
      },
    });
  }

  /**
   * Sends one event. Resolves once Honk has durably stored it (`202`), which does not mean a push
   * was delivered. Retries network errors, 429 and 5xx with the same Idempotency-Key until
   * `retries` or `deadlineMs` runs out, then throws a {@link HonkError}.
   */
  async send(message: Message, options: SendOptions = {}): Promise<SendResult> {
    const body = JSON.stringify(buildBody(message, this.defaults, this.validate));
    const idempotencyKey = options.idempotencyKey === undefined ? await uuidv7() : checkIdempotencyKey(options.idempotencyKey);
    const signal = options.signal;
    const started = Date.now();
    const deadline = started + this.deadlineMs;

    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      let failure: HonkError;
      try {
        const res = await this.#post(body, idempotencyKey, Math.max(1, Math.min(this.timeoutMs, deadline - Date.now())), signal);
        if (res.status >= 200 && res.status < 300) return accepted(res, idempotencyKey, attempt);
        failure = errorFor(res, idempotencyKey, attempt);
        if (!(failure instanceof HonkQuotaError || failure instanceof HonkServerError)) throw failure;
      } catch (err) {
        if (err instanceof HonkError && !(err instanceof HonkQuotaError || err instanceof HonkServerError)) throw err;
        if (signal?.aborted) throw signal.reason;
        failure = err instanceof HonkError ? err : networkError(err, idempotencyKey, attempt);
      }
      if (attempt > this.retries) throw failure;
      const jitter = Math.random() * Math.min(this.#backoffMax, this.#backoffBase * 2 ** (attempt - 1));
      const wait = Math.max(jitter, (failure.retryAfter ?? 0) * 1000);
      if (Date.now() + wait >= deadline) throw failure;
      await sleep(wait, signal);
    }
  }

  /** A `problem` for `groupKey` (opens or continues an incident). Severity defaults to `long` (error). */
  problem(groupKey: string, title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#helper({ ...options, severity: options.severity ?? 'error', groupKey, eventType: 'problem' }, title, message);
  }

  /** A `recovery` for `groupKey` (closes its open incident). Severity defaults to `beep` (success). */
  recovery(groupKey: string, title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#helper({ ...options, severity: options.severity ?? 'success', groupKey, eventType: 'recovery' }, title, message);
  }

  /** A light honk (severity info). */
  light(title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#severity('info', title, message, options);
  }

  /** A beep-beep (severity success). */
  beep(title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#severity('success', title, message, options);
  }

  /** A loud honk (severity warning). */
  loud(title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#severity('warning', title, message, options);
  }

  /** A long honk (severity error; pushes at least as high priority). */
  long(title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#severity('error', title, message, options);
  }

  /** A blast (severity critical; pushes at least as high priority). */
  blast(title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#severity('critical', title, message, options);
  }

  /** Synonym of {@link light}. */
  info(title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#severity('info', title, message, options);
  }

  /** Synonym of {@link beep}. */
  success(title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#severity('success', title, message, options);
  }

  /** Synonym of {@link loud}. */
  warning(title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#severity('warning', title, message, options);
  }

  /** Synonym of {@link long}. */
  error(title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#severity('error', title, message, options);
  }

  /** Synonym of {@link blast}. */
  critical(title: string | null, message: string, options: HelperOptions = {}): Promise<SendResult> {
    return this.#severity('critical', title, message, options);
  }

  #severity(severity: Severity, title: string | null, message: string, options: HelperOptions): Promise<SendResult> {
    return this.#helper({ ...options, severity }, title, message);
  }

  #helper(options: HelperOptions, title: string | null, message: string): Promise<SendResult> {
    const { idempotencyKey, signal, ...fields } = options;
    return this.send({ ...fields, title, message }, { idempotencyKey, signal });
  }

  async #post(body: string, idempotencyKey: string, timeoutMs: number, signal?: AbortSignal): Promise<RawResponse> {
    const controller = new AbortController();
    const timeout = new TimeoutSignal();
    const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.#fetch(`${this.url}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#key}`,
          'idempotency-key': idempotencyKey,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': this.#userAgent,
        },
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    } catch (err) {
      if (controller.signal.reason === timeout) throw new TimeoutSignalError(timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

class TimeoutSignalError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`attempt timed out after ${timeoutMs} ms`);
  }
}

function accepted(res: RawResponse, idempotencyKey: string, attempts: number): SendResult {
  const data = parseJson(res.text) as { id?: unknown; duplicate?: unknown; received_at?: unknown } | undefined;
  if (!data || typeof data.id !== 'string') {
    throw new HonkError(`Honk answered ${res.status} without a message id`, { status: res.status, idempotencyKey, attempts, body: data ?? res.text });
  }
  const receivedAt = typeof data.received_at === 'string' ? new Date(data.received_at) : new Date(Number.NaN);
  return { id: data.id, duplicate: data.duplicate === true, receivedAt };
}

function errorFor(res: RawResponse, idempotencyKey: string, attempts: number): HonkError {
  const data = parseJson(res.text) as
    | { error?: { code?: unknown; message?: unknown; request_id?: unknown; fields?: unknown } }
    | undefined;
  const e = data?.error;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const detail = typeof e?.message === 'string' ? e.message : res.text.slice(0, 200).trim() || `HTTP ${res.status}`;
  const init: HonkErrorInit = {
    status: res.status,
    code,
    requestId: typeof e?.request_id === 'string' ? e.request_id : (res.headers.get('x-request-id') ?? undefined),
    idempotencyKey,
    attempts,
    retryAfter: parseRetryAfter(res.headers.get('retry-after')),
    body: data ?? (res.text || undefined),
  };
  const s = res.status;
  const label = `Honk ${s}${code ? ` ${code}` : ''}: ${detail}`;
  if (s === 400 || s === 413 || s === 415 || s === 422) {
    const fields = Array.isArray(e?.fields) ? (e.fields as FieldError[]) : [];
    const list = fields.map((f) => `${f.field} ${f.message ?? f.code}`).join('; ');
    return new HonkValidationError(list ? `${label} (${list})` : label, { ...init, fields });
  }
  if (s === 401 || s === 403) return new HonkAuthError(label, init);
  if (s === 409) return new HonkConflictError(label, init);
  if (s === 429) return new HonkQuotaError(label, init);
  if (s >= 500) return new HonkServerError(label, init);
  if (s >= 300 && s < 400) {
    const to = res.headers.get('location');
    return new HonkError(`Honk answered ${s} redirect${to ? ` to ${to}` : ''}; set url to the final https address`, init);
  }
  if (s === 404) return new HonkError(`${label} (is url the base address of your Honk server?)`, init);
  return new HonkError(label, init);
}

function networkError(err: unknown, idempotencyKey: string, attempts: number): HonkError {
  if (err instanceof TimeoutSignalError) {
    return new HonkTimeoutError(`Honk did not answer: ${err.message} (the event may or may not have been stored; retrying with the same idempotency key is safe)`, {
      code: 'timeout',
      idempotencyKey,
      attempts,
      cause: err,
    });
  }
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const reason = cause?.code ?? cause?.message ?? (err as Error)?.message ?? String(err);
  return new HonkNetworkError(`Could not reach Honk: ${reason}`, { code: 'network_error', idempotencyKey, attempts, cause: err });
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeUrl(url: unknown): string {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new TypeError('Honk: url is required (the base address of your Honk server, e.g. https://honk.example.com; is HONK_URL set?)');
  }
  let u = url.trim().replace(/\/+$/, '');
  u = u.replace(/\/v1\/messages$/, '');
  if (!/^https?:\/\/[^/]+/i.test(u)) throw new TypeError(`Honk: url must start with https:// (got ${JSON.stringify(url)})`);
  return u;
}

function normalizeKey(key: unknown): string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new TypeError('Honk: key is required (a project ingestion key honk_…; is HONK_KEY set?)');
  }
  const k = key.trim();
  if (!/^honk_[\x21-\x7e]+$/.test(k)) {
    throw new TypeError('Honk: key must be a project ingestion key starting with honk_ (create one under Project → Keys)');
  }
  return k;
}

function positive(v: number | undefined, def: number, name: string): number {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new TypeError(`Honk: ${name} must be a positive number of milliseconds`);
  return v;
}
