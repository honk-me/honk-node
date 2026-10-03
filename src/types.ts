/**
 * Canonical severity, lowest to highest. `error` and `critical` raise the effective priority to
 * at least `high`. Inputs also accept the horn aliases of the Honk scale ({@link SeverityAlias}).
 */
export type Severity = 'info' | 'success' | 'warning' | 'error' | 'critical';

/** The Honk scale: light (info), beep (success), loud (warning), long (error), blast (critical). */
export type SeverityAlias = 'light' | 'beep' | 'loud' | 'long' | 'blast';

/** Any accepted spelling of a severity: canonical or horn alias, lower, Capitalized or UPPER case. */
export type SeverityInput =
  | Severity
  | SeverityAlias
  | Capitalize<Severity | SeverityAlias>
  | Uppercase<Severity | SeverityAlias>;

/**
 * Severity constants. The horn names are aliases of the canonical values:
 * `Severity.Loud === Severity.Warning === 'warning'`.
 */
export const Severity = {
  Light: 'info',
  Beep: 'success',
  Loud: 'warning',
  Long: 'error',
  Blast: 'critical',
  Info: 'info',
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
  Critical: 'critical',
} as const satisfies Record<string, Severity>;

/** Horn alias → canonical severity. */
export const SEVERITY_ALIASES: Readonly<Record<SeverityAlias, Severity>> = {
  light: 'info',
  beep: 'success',
  loud: 'warning',
  long: 'error',
  blast: 'critical',
};

/**
 * Returns the canonical severity for a canonical value or horn alias (case-insensitive), or
 * undefined when it is neither: `normalizeSeverity('LOUD') === 'warning'`.
 */
export function normalizeSeverity(value: string): Severity | undefined {
  const v = value.trim().toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(v)) return v as Severity;
  return (SEVERITY_ALIASES as Record<string, Severity>)[v];
}

/** Declared priority. `urgent` needs an ingestion key with `allow_urgent`. */
export type Priority = 'low' | 'normal' | 'high' | 'urgent';

/** `problem` opens an incident for its group; `recovery` closes it (both need `groupKey`). */
export type EventType = 'event' | 'problem' | 'recovery';

/** Category taxonomy v1. */
export type Category =
  | 'infrastructure'
  | 'security'
  | 'backups'
  | 'deployments'
  | 'payments'
  | 'customers'
  | 'sales'
  | 'automation'
  | 'personal'
  | 'other';

export const SEVERITIES: readonly Severity[] = ['info', 'success', 'warning', 'error', 'critical'];
export const PRIORITIES: readonly Priority[] = ['low', 'normal', 'high', 'urgent'];
export const EVENT_TYPES: readonly EventType[] = ['event', 'problem', 'recovery'];
export const CATEGORIES: readonly Category[] = [
  'infrastructure',
  'security',
  'backups',
  'deployments',
  'payments',
  'customers',
  'sales',
  'automation',
  'personal',
  'other',
];

export type MetadataValue = string | number | boolean;

/**
 * One event for `POST /v1/messages`. Only `message` is required. Fields are camelCase here and
 * sent as the snake_case names of the API (`groupKey` → `group_key`). Empty optional strings
 * and `null`/`undefined` are omitted.
 */
export interface Message {
  /** Plain text, 1–8192 bytes of UTF-8. Line breaks and tabs are allowed. */
  message: string;
  /** ≤ 160 characters, one line. Defaults to the first line of `message`. */
  title?: string | null;
  /**
   * Default `light` (info). Horn names or canonical values, case-insensitive: `light`/`info`,
   * `beep`/`success`, `loud`/`warning`, `long`/`error`, `blast`/`critical`. Sent canonical.
   */
  severity?: SeverityInput | null;
  /** Default `normal`. */
  priority?: Priority | null;
  category?: Category | null;
  /** ≤ 64 characters. Default `api` (or the client's `defaults.source`). */
  source?: string | null;
  /** ≤ 32 characters. Default `default` (or the client's `defaults.environment`). */
  environment?: string | null;
  /** ≤ 64 characters. Default `general` (or the client's `defaults.channel`). */
  channel?: string | null;
  /**
   * ≤ 128 characters. Messages with the same key (per environment, source and channel) form one
   * group: one push, then calm updates. Use one key per customer request (`requests/<id>`), a
   * shared key only for repeats of the same problem.
   */
  groupKey?: string | null;
  /** Default `event`. `recovery` requires `groupKey`. */
  eventType?: EventType | null;
  /** When it happened at the source (informational). A Date or an RFC 3339 string. */
  occurredAt?: Date | string | null;
  /** HTTPS link shown as "Open link". No credentials. ≤ 2048 bytes. */
  url?: string | null;
  /** HTTPS image fetched by the server after ingestion. No credentials or fragment. ≤ 2048 bytes. */
  imageUrl?: string | null;
  /** ≤ 16 keys matching `[A-Za-z0-9_.-]{1,64}`; values are strings (≤ 512 chars), numbers or booleans. */
  metadata?: Record<string, MetadataValue> | null;
  /** Push lifetime, 60–86400 seconds. Default 3600. */
  ttlSeconds?: number | null;
  /** Monotonic counter per source stream (0 … 2^53-1) for problem/recovery ordering. Requires `groupKey`. */
  sourceSequence?: number | null;
}

/** Values applied when a message leaves the field unset. */
export interface Defaults {
  source?: string | null;
  environment?: string | null;
  channel?: string | null;
}

export interface HonkOptions {
  /** Base URL of your Honk server, e.g. `https://honk.example.com`. */
  url: string;
  /** Project ingestion key `honk_…`. Server-side only: never ship it to a browser. */
  key: string;
  /** Timeout of one HTTP attempt. Default 5000 ms. */
  timeoutMs?: number;
  /** Retries after the first attempt (network errors, 429 and 5xx only). Default 4. */
  retries?: number;
  /** Total time budget for `send()`, waits included. Default 30000 ms. */
  deadlineMs?: number;
  /** Applied to every message that does not set these fields. */
  defaults?: Defaults;
  /** Validate messages locally before sending. Default `true`. The server always validates. */
  validate?: boolean;
  /** Exponential backoff with full jitter: attempt n waits random(0, min(maxMs, baseMs·2ⁿ)). Default 500 / 8000 ms. */
  backoff?: { baseMs?: number; maxMs?: number };
  /** Custom fetch (proxies, instrumentation). Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Appended to the User-Agent header. */
  userAgent?: string;
}

export interface SendOptions {
  /**
   * Stable key for this event (1–128 printable ASCII characters), e.g. `request-4812`. Reused on
   * every retry. Default: a new UUIDv7 per `send()` call.
   */
  idempotencyKey?: string;
  /** Cancels the call (including retries and waits). */
  signal?: AbortSignal;
}

/** Message fields and send options together, for the helper methods. */
export type HelperOptions = Partial<Omit<Message, 'message' | 'title'>> & SendOptions;

export interface SendResult {
  /** Message id (`msg_…`). The original id when `duplicate` is true. */
  id: string;
  /** True when this idempotency key was already accepted with the same payload (within 24 h). */
  duplicate: boolean;
  /** When the server accepted the message (the first time, for a duplicate). */
  receivedAt: Date;
}
