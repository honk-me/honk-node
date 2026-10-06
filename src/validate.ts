import { HonkValidationError, type FieldError } from './errors.js';
import { CATEGORIES, EVENT_TYPES, PRIORITIES, SEVERITIES, SEVERITY_ALIASES, normalizeSeverity, type Defaults, type Message } from './types.js';

/** Limits from contracts/openapi.yaml (and the server's validator). */
export const LIMITS = {
  bodyBytes: 16 * 1024,
  messageBytes: 8192,
  title: 160,
  source: 64,
  environment: 32,
  channel: 64,
  groupKey: 128,
  urlBytes: 2048,
  actions: 3,
  actionTitle: 40,
  metadataKeys: 16,
  metadataValue: 512,
  ttlMin: 60,
  ttlMax: 86400,
  idempotencyKey: 128,
} as const;

// camelCase SDK field → snake_case wire field, in a stable order.
const FIELDS = {
  title: 'title',
  message: 'message',
  severity: 'severity',
  priority: 'priority',
  category: 'category',
  source: 'source',
  environment: 'environment',
  channel: 'channel',
  groupKey: 'group_key',
  eventType: 'event_type',
  occurredAt: 'occurred_at',
  url: 'url',
  imageUrl: 'image_url',
  actions: 'actions',
  metadata: 'metadata',
  ttlSeconds: 'ttl_seconds',
  sourceSequence: 'source_sequence',
} as const satisfies Record<keyof Message, string>;

const WIRE_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(FIELDS).map(([k, v]) => [v, k]),
);

// Go's unicode.IsControl (C0, DEL, C1) plus the Unicode line/paragraph separators, as on the server.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_EXCEPT_BREAKS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const METADATA_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;
// Unicode White_Space outside the control characters (Go's unicode.IsSpace, as on the server).
const SPACE = /[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
// The number of a tel: or sms: action: an optional leading +, digits and - . ( ) separators.
const PHONE_NUMBER = /^\+?[0-9().-]*[0-9][0-9().-]*$/;
// A single plain mailto: address, once percent-decoded: dot-atom@dot-atom with a dotted domain
// (or an IPv4 literal).
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~\\-\\u{80}-\\u{10ffff}]+";
const MAIL_ADDRESS = new RegExp(`^${ATOM}(\\.${ATOM})*@(${ATOM}(\\.${ATOM})+|\\[[0-9.]*\\.[0-9.]*\\])$`, 'u');
const BAD_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

const encoder = new TextEncoder();
export const byteLength = (s: string): number => encoder.encode(s).length;
const codePoints = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

const isBlank = (v: unknown): boolean => v === undefined || v === null || v === '';

/** Checks an Idempotency-Key: 1–128 printable ASCII characters (0x21–0x7E). */
export function checkIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
    throw new HonkValidationError(
      'Invalid idempotency key: use 1–128 printable ASCII characters without spaces, e.g. "request-4812"',
      { local: true, code: 'validation_failed', fields: [{ field: 'Idempotency-Key', code: 'invalid_format', message: '1-128 printable ASCII characters' }] },
    );
  }
  return key;
}

/**
 * Turns a message into the wire object of `POST /v1/messages`, applying `defaults` and (unless
 * `validate` is false) the cheap checks the server would apply anyway. Throws HonkValidationError
 * listing every invalid field.
 */
export function buildBody(input: Message, defaults: Defaults = {}, validate = true): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new HonkValidationError('Invalid Honk message: expected an object like { title, message }', {
      local: true,
      code: 'validation_failed',
      fields: [{ field: 'body', code: 'invalid_format', message: 'must be an object' }],
    });
  }
  const errors: FieldError[] = [];
  const add = (field: string, code: string, message: string) => errors.push({ field, code, message });
  const msg = input as unknown as Record<string, unknown>;

  for (const key of Object.keys(msg)) {
    if (!(key in FIELDS)) {
      const hint = WIRE_TO_FIELD[key] ? ` (use ${WIRE_TO_FIELD[key]})` : '';
      add(key, 'not_allowed', `unknown field${hint}`);
    }
  }

  const value = (name: keyof Message): unknown => {
    const v = msg[name];
    if (!isBlank(v)) return v;
    if (name === 'source' || name === 'environment' || name === 'channel') {
      const d = defaults[name];
      return isBlank(d) ? undefined : d;
    }
    return undefined;
  };

  const body: Record<string, unknown> = {};
  for (const name of Object.keys(FIELDS) as (keyof Message)[]) {
    const v = value(name);
    if (v === undefined || (name === 'actions' && Array.isArray(v) && v.length === 0)) continue;
    const wire = FIELDS[name];
    if (name === 'occurredAt') {
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) add(wire, 'invalid_format', 'must be a valid date');
        else body[wire] = v.toISOString();
        continue;
      }
      if (validate && (typeof v !== 'string' || !RFC3339.test(v.trim()))) {
        add(wire, 'invalid_format', 'must be a Date or an RFC 3339 timestamp like 2026-10-01T21:10:00Z');
        continue;
      }
    }
    // Horn aliases (and any case) become the canonical value, even with validate: false, so
    // the idempotency payload is canonical and older servers understand it.
    body[wire] = name === 'severity' && typeof v === 'string' ? (normalizeSeverity(v) ?? v) : v;
  }

  if (validate) {
    checkMessage(body, add);
  } else if (msg.message === undefined || msg.message === null) {
    add('message', 'required', 'message is required');
  }

  if (errors.length === 0) {
    const size = byteLength(JSON.stringify(body));
    if (size > LIMITS.bodyBytes) add('body', 'too_long', `the JSON body is ${size} bytes; Honk accepts at most 16 KiB`);
  }
  if (errors.length > 0) {
    const summary = errors.map((e) => `${e.field} ${e.message}`).join('; ');
    throw new HonkValidationError(`Invalid Honk message: ${summary}`, { local: true, code: 'validation_failed', fields: errors });
  }
  return body;
}

type Add = (field: string, code: string, message: string) => void;

function checkMessage(b: Record<string, unknown>, add: Add): void {
  const m = b.message;
  if (m === undefined) add('message', 'required', 'message is required');
  else if (typeof m !== 'string') add('message', 'invalid_format', 'must be a string');
  else if (byteLength(m) > LIMITS.messageBytes) add('message', 'too_long', `must be at most ${LIMITS.messageBytes} bytes of UTF-8 (got ${byteLength(m)})`);
  else if (m.trim() === '') add('message', 'too_short', 'must not be blank');
  else if (CONTROL_EXCEPT_BREAKS.test(m)) add('message', 'invalid_format', 'must not contain control characters other than line breaks and tabs');

  shortText(b, 'title', LIMITS.title, add);
  shortText(b, 'source', LIMITS.source, add);
  shortText(b, 'environment', LIMITS.environment, add);
  shortText(b, 'channel', LIMITS.channel, add);
  shortText(b, 'group_key', LIMITS.groupKey, add);

  if (b.severity !== undefined && (typeof b.severity !== 'string' || !(SEVERITIES as readonly string[]).includes(b.severity))) {
    const aliases = Object.entries(SEVERITY_ALIASES).map(([alias, canonical]) => `${alias} (${canonical})`);
    add('severity', 'invalid_enum', `must be one of ${aliases.join(', ')}`);
  }
  oneOf(b, 'priority', PRIORITIES, add);
  oneOf(b, 'event_type', EVENT_TYPES, add);
  oneOf(b, 'category', CATEGORIES, add);

  const seq = b.source_sequence;
  if (seq !== undefined && (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0)) {
    add('source_sequence', 'out_of_range', 'must be an integer between 0 and 2^53-1');
  }
  if (b.group_key === undefined) {
    if (b.event_type === 'recovery') add('group_key', 'requires_group_key', 'recovery events require group_key');
    if (seq !== undefined) add('source_sequence', 'requires_group_key', 'source_sequence requires group_key');
  }

  if (b.url !== undefined && !validUrl(b.url, false)) {
    add('url', 'invalid_format', 'must be an https URL without credentials, at most 2048 bytes');
  }
  if (b.image_url !== undefined && !validUrl(b.image_url, true)) {
    add('image_url', 'invalid_format', 'must be an https URL without credentials or fragment, at most 2048 bytes');
  }
  checkActions(b.actions, add);

  const md = b.metadata;
  if (md !== undefined) {
    if (typeof md !== 'object' || md === null || Array.isArray(md)) {
      add('metadata', 'invalid_format', 'must be an object of strings, numbers and booleans');
    } else {
      const entries = Object.entries(md);
      if (entries.length > LIMITS.metadataKeys) add('metadata', 'too_long', `at most ${LIMITS.metadataKeys} keys`);
      for (const [k, v] of entries) {
        const field = `metadata.${k}`;
        if (!METADATA_KEY.test(k)) add(field, 'invalid_format', 'keys must match [A-Za-z0-9_.-]{1,64}');
        else if (typeof v === 'string') {
          if (codePoints(v) > LIMITS.metadataValue || CONTROL_EXCEPT_BREAKS.test(v)) {
            add(field, 'invalid_format', `strings must be at most ${LIMITS.metadataValue} characters without control characters`);
          }
        } else if (typeof v === 'number') {
          if (!Number.isFinite(v)) add(field, 'invalid_format', 'numbers must be finite');
        } else if (typeof v !== 'boolean') {
          add(field, 'invalid_format', 'values must be strings, numbers or booleans');
        }
      }
    }
  }

  const ttl = b.ttl_seconds;
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < LIMITS.ttlMin || ttl > LIMITS.ttlMax)) {
    add('ttl_seconds', 'out_of_range', `must be an integer between ${LIMITS.ttlMin} and ${LIMITS.ttlMax}`);
  }
}

function checkActions(v: unknown, add: Add): void {
  if (v === undefined) return;
  const format = 'must be an array of at most 3 { title, url } objects';
  if (!Array.isArray(v)) return add('actions', 'invalid_format', format);
  if (v.length > LIMITS.actions) return add('actions', 'too_long', `at most ${LIMITS.actions} actions`);
  if (v.some((a) => a === null || typeof a !== 'object' || Array.isArray(a))) return add('actions', 'invalid_format', format);
  (v as Record<string, unknown>[]).forEach((a, i) => {
    const field = `actions[${i}]`;
    const title = typeof a.title === 'string' ? a.title.trim() : a.title;
    if (title === undefined || title === null || title === '') add(`${field}.title`, 'required', 'title is required');
    else if (typeof title !== 'string') add(`${field}.title`, 'invalid_format', 'must be a string');
    else if (codePoints(title) > LIMITS.actionTitle) add(`${field}.title`, 'too_long', `must be at most ${LIMITS.actionTitle} characters`);
    else if (CONTROL.test(title)) add(`${field}.title`, 'invalid_format', 'must be one line without control characters');

    const url = typeof a.url === 'string' ? a.url.trim() : a.url;
    if (url === undefined || url === null || url === '') add(`${field}.url`, 'required', 'url is required');
    else if (typeof url !== 'string') add(`${field}.url`, 'invalid_format', 'must be a string');
    else if (byteLength(url) > LIMITS.urlBytes) add(`${field}.url`, 'too_long', `must be at most ${LIMITS.urlBytes} bytes`);
    else if (!validActionUrl(url)) add(`${field}.url`, 'invalid_format', 'must be an https://, mailto:, tel: or sms: URL without spaces');

    for (const key of Object.keys(a).sort()) {
      if (key !== 'title' && key !== 'url') add(`${field}.${key}`, 'not_allowed', 'unknown field (an action has title and url)');
    }
  });
}

/**
 * The server's check of a (trimmed) action URL, scheme in any case: `https://` with a host and
 * no credentials (as `url`), `mailto:` with one address and an optional `?subject=…&body=…`,
 * `tel:` / `tel://` with a number, `sms:` with a number and an optional `?body=…`.
 */
export function validActionUrl(s: string): boolean {
  if (CONTROL.test(s) || SPACE.test(s)) return false;
  const colon = s.indexOf(':');
  if (colon < 0) return false;
  const rest = s.slice(colon + 1);
  const [head, query] = splitOnce(rest, '?');
  switch (s.slice(0, colon).toLowerCase()) {
    case 'https':
      return validUrl(s, false);
    case 'mailto':
      return mailAddress(head) && actionQuery(query, ['subject', 'body']);
    case 'tel':
      return PHONE_NUMBER.test(rest.startsWith('//') ? rest.slice(2) : rest);
    case 'sms':
      return PHONE_NUMBER.test(head) && actionQuery(query, ['body']);
    default:
      return false;
  }
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

function mailAddress(s: string): boolean {
  if (BAD_ESCAPE.test(s)) return false;
  try {
    return MAIL_ADDRESS.test(decodeURIComponent(s));
  } catch {
    return false;
  }
}

// Valid percent-encoding, no ";" separators and only the allowed keys ("" is no query).
function actionQuery(q: string, allowed: string[]): boolean {
  for (const pair of q.split('&')) {
    if (pair.includes(';') || BAD_ESCAPE.test(pair)) return false;
    if (pair === '') continue;
    const [key] = splitOnce(pair, '=');
    try {
      if (!allowed.includes(decodeURIComponent(key.replace(/\+/g, ' ')))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function shortText(b: Record<string, unknown>, field: string, max: number, add: Add): void {
  const v = b[field];
  if (v === undefined) return;
  if (typeof v !== 'string') return add(field, 'invalid_format', 'must be a string');
  const s = v.trim();
  if (s === '') add(field, 'too_short', 'must not be empty');
  else if (codePoints(s) > max) add(field, 'too_long', `must be at most ${max} characters`);
  else if (CONTROL.test(s)) add(field, 'invalid_format', 'must not contain control characters or line breaks');
}

function oneOf(b: Record<string, unknown>, field: string, allowed: readonly string[], add: Add): void {
  const v = b[field];
  if (v !== undefined && (typeof v !== 'string' || !allowed.includes(v))) {
    add(field, 'invalid_enum', `must be one of ${allowed.join(', ')}`);
  }
}

/** Syntactic check matching the server: https, a host, no credentials, no spaces/backslashes, ≤ 2048 bytes. */
export function validUrl(raw: unknown, image: boolean): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (s === '' || byteLength(s) > LIMITS.urlBytes || CONTROL.test(s) || /[ \\]/.test(s)) return false;
  if (!/^https:\/\//i.test(s)) return false;
  if (image && s.includes('#')) return false;
  const rest = s.slice('https://'.length);
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  if (authority === '' || authority.includes('@')) return false;
  let host = authority;
  let port = '';
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return false;
    host = authority.slice(0, end + 1);
    const after = authority.slice(end + 1);
    if (after !== '' && !after.startsWith(':')) return false;
    port = after.slice(1);
  } else {
    const i = authority.lastIndexOf(':');
    if (i >= 0) {
      host = authority.slice(0, i);
      port = authority.slice(i + 1);
    }
  }
  if (host === '' || host === '[]') return false;
  if (port !== '' && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return false;
  return true;
}
