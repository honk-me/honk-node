# honk-me

[![CI](https://github.com/honk-me/honk-node/actions/workflows/ci.yml/badge.svg)](https://github.com/honk-me/honk-node/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/honk-me)](https://www.npmjs.com/package/honk-me)

Official Node.js / TypeScript client for [Honk](https://honk-me.app), the inbox that turns
events from your apps, scripts, cron jobs and CI into calm, grouped push notifications on your
phone.

- Zero runtime dependencies. ESM, CommonJS and TypeScript types.
- Node 18+ (global `fetch`). Also works on Bun and Deno (`npm:honk-me`).
- Retries with backoff, `Retry-After`, a total deadline and an idempotency key on every send,
  so a retry never creates a duplicate.

> **Keep the key on the server.** A Honk ingestion key (`honk_…`) lets anyone post into your
> project. Use this package in back-end code, functions and scripts only. Never bundle it
> into a browser, mobile or desktop front end, and never commit it. Read it from the
> environment.

## Install

```sh
npm install honk-me
```

Create a project and an ingestion key at [honk-me.app](https://honk-me.app). Its
*Integrations* page generates ready-to-paste code for this package.

## Quick start

```js
import { Honk } from 'honk-me';

const honk = new Honk({ url: process.env.HONK_URL, key: process.env.HONK_KEY });
await honk.beep('Backup finished', 'nightly pg_dump took 42 s');
```

`Honk.fromEnv()` reads `HONK_URL`, `HONK_KEY` and the optional `HONK_SOURCE`,
`HONK_ENVIRONMENT` and `HONK_CHANNEL` defaults. CommonJS:
`const { Honk } = require('honk-me')`.

## The Honk scale

Every severity has a horn name. Use either; the SDK always sends the canonical value.

| Horn | Severity | Helper | Constant |
|---|---|---|---|
| light honk | `light` (info) | `honk.light(title, message, opts)` | `Severity.Light` |
| beep-beep | `beep` (success) | `honk.beep(…)` | `Severity.Beep` |
| loud honk | `loud` (warning) | `honk.loud(…)` | `Severity.Loud` |
| long honk | `long` (error) | `honk.long(…)` | `Severity.Long` |
| blast | `blast` (critical) | `honk.blast(…)` | `Severity.Blast` |

`severity: 'loud'`, `'LOUD'` and `'warning'` are the same event (also for idempotency).
`long` and `blast` push at least as `high` priority. `info()`, `success()`, `warning()`,
`error()` and `critical()` remain as synonyms; `normalizeSeverity('Blast') === 'critical'`.

## Recipe: notify me when a customer asks for something

Give each request its own group (`requests/<id>`) and its own idempotency key. Two different
customers never fold into one notification, and a retried webhook or job never buzzes twice.

```js
import { Honk } from 'honk-me';

const honk = Honk.fromEnv(); // create once, reuse (keep-alive)

export async function onCustomerRequest(req) {
  // ...save the request first, then notify without blocking the response:
  honk
    .send(
      {
        title: `New request: ${req.subject}`.slice(0, 160),
        message: `${req.name} (${req.company}) asked: ${req.body}`.slice(0, 2000),
        priority: 'high', // push right away
        category: 'customers',
        channel: 'requests',
        groupKey: `requests/${req.id}`, // one group per request
        url: `https://shop.example.com/admin/requests/${req.id}`, // https only, shown as "Open link"
        metadata: { request_id: String(req.id) },
      },
      { idempotencyKey: `request-${req.id}` }, // same request, same key: never a duplicate
    )
    .catch((err) => console.warn('honk:', err.message)); // never fail the customer's request
}
```

In a queue worker (BullMQ, SQS, …) `await` the call and let the job retry on
`err.retryable`, keeping the same `idempotencyKey`.

## Grouping in three lines

Messages with the same `groupKey` (per project, environment, source and channel) form one
group: the first one pushes, repeats update it calmly instead of buzzing again. Use one key
per customer request (`requests/<id>`), and a shared key only for repeats of the same problem
(`queue/failed-jobs`). `problem`/`recovery` pairs need a `groupKey`.

## Sending

```ts
honk.send(message, { idempotencyKey?, signal? }) // → Promise<{ id, duplicate, receivedAt }>
```

| Field | Type | Notes |
|---|---|---|
| `message` | string | **required**, 1–8192 bytes UTF-8, line breaks allowed |
| `title` | string | ≤ 160 chars, one line; default: first line of `message` |
| `severity` | `light` `beep` `loud` `long` `blast` (or the canonical names, any case) | default `light`; `long`/`blast` push at least as `high` |
| `priority` | `low` `normal` `high` `urgent` | default `normal`; `urgent` needs a key with *allow urgent* |
| `category` | `infrastructure` `security` `backups` `deployments` `payments` `customers` `sales` `automation` `personal` `other` | |
| `source` / `environment` / `channel` | string | ≤ 64 / 32 / 64 chars; default `api` / `default` / `general` or the client `defaults` |
| `groupKey` | string | ≤ 128 chars |
| `eventType` | `event` `problem` `recovery` | `recovery` needs `groupKey` |
| `occurredAt` | `Date` or RFC 3339 string | informational |
| `url` | string | `https://` only, no credentials |
| `imageUrl` | string | `https://` only, no credentials or `#fragment`; fetched by the server afterwards |
| `metadata` | `Record<string, string \| number \| boolean>` | ≤ 16 keys `[A-Za-z0-9_.-]{1,64}`, strings ≤ 512 chars |
| `ttlSeconds` | integer | push lifetime 60–86400, default 3600 |
| `sourceSequence` | integer | 0 … 2^53-1, needs `groupKey`; a delayed recovery never closes a newer problem |

Fields are camelCase in this SDK and sent with the API's snake_case names. `null`, `undefined`
and empty optional strings are omitted. A resolved promise means Honk **durably stored** the
message (`202`); it does not mean a push was delivered or read.

Helpers (the last argument takes any message field plus `idempotencyKey` and `signal`):

```js
await honk.loud('Disk 91%', '/var on app-01', { groupKey: 'disk/app-01/var' });
await honk.light('Deploy started', 'v4.2.0 to production', { channel: 'deploys' });
await honk.beep(title, message, opts); await honk.long(title, message, opts); await honk.blast(title, message, opts);
await honk.problem('db/backup', 'Backup failed', 'pg_dump exited with 1');      // a long honk by default
await honk.recovery('db/backup', 'Backup OK', 'pg_dump finished in 41 s');      // a beep by default
```

### Options

```js
new Honk({
  url: 'https://honk.example.com', // base URL of your server
  key: 'honk_…',                  // project ingestion key
  timeoutMs: 5000,                // per attempt
  retries: 4,                     // after the first attempt
  deadlineMs: 30000,              // total, waits included
  defaults: { source: 'billing-api', environment: 'production', channel: 'payments' },
  validate: true,                 // local checks before sending (the server always validates)
  backoff: { baseMs: 500, maxMs: 8000 },
  fetch: customFetch,             // e.g. undici with a proxy agent
});
```

## Retries and idempotency, guaranteed

- Every `send()` carries an `Idempotency-Key`: yours, or a fresh UUIDv7. **The same key is
  reused on every retry.** Within 24 h Honk answers a replay with the original id and
  `duplicate: true`, so a lost response never creates a second message.
- Only network errors, timeouts, `429` and `5xx` are retried, with exponential backoff and
  full jitter (`random(0, min(8 s, 0.5 s·2ⁿ))`), never sooner than the server's `Retry-After`.
- Everything stops at `deadlineMs`: if the next wait would cross it (for example a daily quota
  that resets at midnight), the error is thrown at once with `retryAfter`.
- `4xx` other than `429` are never retried: fix the request instead.
- Short per-attempt timeouts; Node's `fetch` keeps connections alive, so create one `Honk`
  per process and reuse it.
- Pass your own stable key (`request-4812`, `deploy-${sha}`) to stay duplicate-free across
  process restarts and job retries. Reusing a key with a *different* payload is a conflict.

## Errors

Every error is a `HonkError` with `kind`, `status`, `code`, `requestId`, `idempotencyKey`,
`attempts`, `retryAfter` and `retryable`.

| Class | `kind` | When | What to do |
|---|---|---|---|
| `HonkValidationError` | `validation` | rejected locally (`local: true`) or `400`/`413`/`415`/`422`; `fields` lists every problem | fix the message |
| `HonkAuthError` | `auth` | `401 invalid_key`, `403 priority_not_allowed`, `project_suspended`, `workspace_suspended` | fix the key or the priority |
| `HonkQuotaError` | `quota` | `429 quota_exceeded` (daily, resets at UTC midnight) or `rate_limited`, after retries | retry after `retryAfter` seconds |
| `HonkConflictError` | `conflict` | `409 idempotency_conflict`: same key, different payload | use a new key, or send the original payload |
| `HonkNetworkError` | `network` | unreachable on every attempt | retry later, same key |
| `HonkTimeoutError` | `timeout` | attempts timed out; the message may or may not be stored | retry later, same key |
| `HonkServerError` | `server` | `5xx` on every attempt | retry later, same key |

```js
import { HonkError, HonkValidationError } from 'honk-me';

try {
  await honk.send(msg, { idempotencyKey: `order-${order.id}-failed` });
} catch (err) {
  if (err instanceof HonkValidationError) logger.error(err.fields);   // a bug: don't retry
  else if (err instanceof HonkError && err.retryable) queue.retryLater(err.idempotencyKey, err.retryAfter);
  else throw err;
}
```

`kind` is also handy when two copies of the package are loaded and `instanceof` can fail.

## Bun and Deno

```ts
import { Honk } from 'npm:honk-me'; // Deno
const honk = new Honk({ url: Deno.env.get('HONK_URL')!, key: Deno.env.get('HONK_KEY')! });
```

Bun: `bun add honk-me`, then use it as in Node.

## Development

```sh
npm install
npm test                 # build + unit tests (mock server) + CommonJS smoke test
npm run typecheck        # also checks the published .d.ts from ESM and CJS consumers
HONK_URL=… HONK_KEY=… npm run test:integration   # against a real server (use a test project's key)
```

The version lives in `package.json`; the build regenerates `src/version.ts` (`VERSION`, the
User-Agent) from it. Releases: push a tag `vX.Y.Z` matching `package.json` and the release
workflow publishes to npm with provenance (see `CHANGELOG.md`).

## Links

- [honk-me.app](https://honk-me.app): the Honk inbox (web, iPhone).
- Other SDKs: [PHP / Laravel](https://github.com/honk-me/honk-php),
  [Go + CLI](https://github.com/honk-me/honk-go), [Swift](https://github.com/honk-me/honk-swift),
  [Kotlin / Java](https://github.com/honk-me/honk-kotlin).

MIT License.
