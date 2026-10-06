# Changelog

All notable changes to `honk-me` (npm) are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `actions`: up to 3 buttons on a message, `{ title, url }` with an `https://`, `mailto:`,
  `tel:` or `sms:` URL (the `Action` type). Validated locally like the server does, with
  errors named `actions[1].url`; empty `actions` are omitted, so messages without buttons are
  sent exactly as before.

## [0.1.1] - 2026-10-06

### Fixed
- Near the deadline, a retry no longer starts with only a few milliseconds left. Such an
  attempt could only time out, and its `HonkTimeoutError` hid the server's real answer (for
  example `503`). A retry now needs at least 250 ms (or `timeoutMs`, when shorter) before
  `deadlineMs`; otherwise the last error is thrown at once.

### Changed
- Package author: Honk <accounts@honk-me.app>. The README links the Rust SDK, the n8n node
  and the WordPress plugin.

## [0.1.0] - 2026-10-04

### Added
- `Honk` client for `POST /v1/messages` with every field of the v1 ingestion API
  (including `imageUrl`), camelCase in, snake_case on the wire.
- Automatic UUIDv7 `Idempotency-Key` (or your own), reused on every retry.
- Retries for network errors, timeouts, 429 and 5xx with exponential backoff, full jitter,
  `Retry-After` and a total deadline.
- Typed errors: `HonkValidationError`, `HonkAuthError`, `HonkQuotaError`,
  `HonkConflictError`, `HonkNetworkError`, `HonkTimeoutError`, `HonkServerError`.
- Local validation of limits, enums and https-only URLs, with every invalid field reported.
- Helpers `problem`, `recovery`, `info`, `success`, `warning`, `error`, `critical`;
  `Honk.fromEnv()`.
- ESM + CommonJS builds with TypeScript types, zero runtime dependencies; Node 18+, Bun, Deno.
- The Honk scale: severity horn aliases `light` (info), `beep` (success), `loud` (warning),
  `long` (error), `blast` (critical), case-insensitive and always sent canonical; `Severity`
  constants (`Severity.Loud === 'warning'`), `normalizeSeverity()` and the `light`, `beep`,
  `loud`, `long`, `blast` helpers.
