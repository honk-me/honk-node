export type ErrorKind =
  | 'validation'
  | 'auth'
  | 'quota'
  | 'conflict'
  | 'network'
  | 'timeout'
  | 'server'
  | 'http';

/** One invalid field, as reported by the server (`error.fields[]`) or by local validation. */
export interface FieldError {
  /** Wire name, e.g. `group_key`, `metadata.region`, `Idempotency-Key`, `body`. */
  field: string;
  /** `required`, `too_long`, `too_short`, `invalid_enum`, `invalid_format`, `out_of_range`, `not_allowed`, `requires_group_key`, … */
  code: string;
  message?: string;
}

export interface HonkErrorInit {
  status?: number;
  code?: string;
  requestId?: string;
  idempotencyKey?: string;
  attempts?: number;
  retryAfter?: number;
  fields?: FieldError[];
  body?: unknown;
  cause?: unknown;
}

/**
 * Base class of every error thrown by `send()`. Check `kind` (or `instanceof`) to decide what to do:
 * `retryable` errors can be retried later with the same `idempotencyKey` without creating duplicates.
 */
export class HonkError extends Error {
  readonly kind: ErrorKind = 'http';
  /** HTTP status, when the server answered. */
  readonly status?: number;
  /** API error code (`invalid_key`, `quota_exceeded`, …) or `network_error` / `timeout`. */
  readonly code?: string;
  /** Server request id (`req_…`), useful in bug reports. */
  readonly requestId?: string;
  /** The Idempotency-Key that was used. Retry later with the same key to stay duplicate-free. */
  readonly idempotencyKey?: string;
  /** Number of HTTP attempts made (0 when the message was rejected locally). */
  readonly attempts: number;
  /** Seconds the server asked to wait (`Retry-After`), when present. */
  readonly retryAfter?: number;
  /** Parsed error body, when the server answered with JSON. */
  readonly body?: unknown;

  constructor(message: string, init: HonkErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'HonkError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.idempotencyKey = init.idempotencyKey;
    this.attempts = init.attempts ?? 0;
    this.retryAfter = init.retryAfter;
    this.body = init.body;
  }

  /** True when sending the same event again later (same idempotency key) may succeed. */
  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'quota';
  }
}

/** The message is invalid: rejected locally before sending, or by the server (400, 413, 415, 422). Fix the message. */
export class HonkValidationError extends HonkError {
  override readonly kind = 'validation' as const;
  readonly fields: FieldError[];
  /** True when the SDK rejected the message before any request was made. */
  readonly local: boolean;
  constructor(message: string, init: HonkErrorInit & { local?: boolean } = {}) {
    super(message, init);
    this.name = 'HonkValidationError';
    this.fields = init.fields ?? [];
    this.local = init.local ?? false;
  }
}

/** 401/403: invalid or revoked key, `priority_not_allowed` (urgent without allow_urgent), suspended project/workspace. */
export class HonkAuthError extends HonkError {
  override readonly kind = 'auth' as const;
  constructor(message: string, init: HonkErrorInit = {}) {
    super(message, init);
    this.name = 'HonkAuthError';
  }
}

/** 429: `quota_exceeded` (daily messages_per_day, until UTC midnight) or `rate_limited`, after retries. See `retryAfter`. */
export class HonkQuotaError extends HonkError {
  override readonly kind = 'quota' as const;
  constructor(message: string, init: HonkErrorInit = {}) {
    super(message, init);
    this.name = 'HonkQuotaError';
  }
}

/** 409 `idempotency_conflict`: this idempotency key was already used with a different payload in the last 24 h. */
export class HonkConflictError extends HonkError {
  override readonly kind = 'conflict' as const;
  constructor(message: string, init: HonkErrorInit = {}) {
    super(message, init);
    this.name = 'HonkConflictError';
  }
}

/** The server could not be reached (or the connection broke) on every attempt until the deadline. */
export class HonkNetworkError extends HonkError {
  override readonly kind: 'network' | 'timeout' = 'network';
  constructor(message: string, init: HonkErrorInit = {}) {
    super(message, init);
    this.name = 'HonkNetworkError';
  }
}

/** An attempt timed out and no later attempt succeeded before the deadline. The event may or may not have been stored. */
export class HonkTimeoutError extends HonkNetworkError {
  override readonly kind = 'timeout' as const;
  constructor(message: string, init: HonkErrorInit = {}) {
    super(message, init);
    this.name = 'HonkTimeoutError';
  }
}

/** 5xx on every attempt until the deadline (e.g. `503 unavailable`). */
export class HonkServerError extends HonkError {
  override readonly kind = 'server' as const;
  constructor(message: string, init: HonkErrorInit = {}) {
    super(message, init);
    this.name = 'HonkServerError';
  }
}
