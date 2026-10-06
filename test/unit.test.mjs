import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, test } from 'node:test';
import {
  Honk,
  HonkAuthError,
  HonkConflictError,
  HonkError,
  HonkNetworkError,
  HonkQuotaError,
  HonkServerError,
  HonkTimeoutError,
  HonkValidationError,
  SEVERITY_ALIASES,
  Severity,
  VERSION,
  buildBody,
  normalizeSeverity,
  parseRetryAfter,
  uuidv7,
} from '../dist/esm/index.js';
import { KEY, apiError, mockServer, ok } from './mock-server.mjs';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fast = { backoff: { baseMs: 1, maxMs: 5 } };
const servers = [];
async function server(steps) {
  const s = await mockServer(steps);
  servers.push(s);
  return s;
}
after(() => Promise.all(servers.map((s) => s.close())));

describe('serialisation', () => {
  test('sends every field with the exact openapi names, headers and a UUIDv7 key', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    const res = await honk.send({
      title: 'Redis connection failed',
      message: 'Billing API could not connect to Redis after 3 attempts.',
      severity: 'error',
      priority: 'high',
      category: 'infrastructure',
      source: 'billing-api',
      environment: 'production',
      channel: 'infrastructure',
      groupKey: 'billing/redis/connectivity',
      eventType: 'problem',
      occurredAt: new Date('2026-10-02T00:10:00+03:00'),
      url: 'https://example.com/incidents/redis',
      imageUrl: 'https://cdn.example.com/a.jpg',
      metadata: { host: 'app-01', attempts: 3, retried: true },
      ttlSeconds: 3600,
      sourceSequence: 42,
    });
    assert.deepEqual(res, { id: 'msg_01k6h3w4z5x6y7z8a9b0c1d2e3', duplicate: false, receivedAt: new Date('2026-10-02T21:10:00.123Z') });
    const [r] = s.requests;
    assert.equal(r.method, 'POST');
    assert.equal(r.url, '/v1/messages');
    assert.equal(r.headers.authorization, `Bearer ${KEY}`);
    assert.equal(r.headers['content-type'], 'application/json');
    assert.match(r.headers['idempotency-key'], UUIDV7);
    assert.equal(r.headers['user-agent'], `honk-me-node/${VERSION}`);
    assert.deepEqual(r.json, {
      title: 'Redis connection failed',
      message: 'Billing API could not connect to Redis after 3 attempts.',
      severity: 'error',
      priority: 'high',
      category: 'infrastructure',
      source: 'billing-api',
      environment: 'production',
      channel: 'infrastructure',
      group_key: 'billing/redis/connectivity',
      event_type: 'problem',
      occurred_at: '2026-10-01T21:10:00.000Z',
      url: 'https://example.com/incidents/redis',
      image_url: 'https://cdn.example.com/a.jpg',
      metadata: { host: 'app-01', attempts: 3, retried: true },
      ttl_seconds: 3600,
      source_sequence: 42,
    });
  });

  test('minimal message sends only message; null and empty optional fields are omitted', async () => {
    const s = await server(ok());
    await new Honk({ url: s.url, key: KEY }).send({ message: 'Backup finished in 42s', title: null, channel: '', groupKey: undefined });
    assert.equal(s.requests[0].raw, '{"message":"Backup finished in 42s"}');
  });

  test('actions are sent as [{ title, url }] in order; empty actions are omitted', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    const actions = [
      { title: 'Reply', url: 'mailto:emily@example.com?subject=Your%20quote' },
      { title: 'Call Emily', url: 'tel:+15550134' },
      { title: 'Open request', url: 'https://shop.example.com/admin/requests/4812' },
    ];
    await honk.send({ message: 'Emily asked for a quote', actions });
    await honk.send({ message: 'x', actions: [] });
    await honk.send({ message: 'x', actions: null });
    await honk.loud('Disk 91%', '/var on app-01', { actions: [{ title: 'Text on-call', url: 'sms:+15550134?body=Disk%2091%25' }] });
    assert.equal(
      s.requests[0].raw,
      '{"message":"Emily asked for a quote","actions":[{"title":"Reply","url":"mailto:emily@example.com?subject=Your%20quote"},{"title":"Call Emily","url":"tel:+15550134"},{"title":"Open request","url":"https://shop.example.com/admin/requests/4812"}]}',
    );
    assert.equal(s.requests[1].raw, '{"message":"x"}');
    assert.equal(s.requests[2].raw, '{"message":"x"}');
    assert.deepEqual(s.requests[3].json.actions, [{ title: 'Text on-call', url: 'sms:+15550134?body=Disk%2091%25' }]);
  });

  test('defaults fill unset source/environment/channel; the message wins', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY, defaults: { source: 'laravel', environment: 'production', channel: '' } });
    await honk.send({ message: 'a' });
    await honk.send({ message: 'b', source: 'cron', channel: 'requests' });
    assert.deepEqual(s.requests[0].json, { message: 'a', source: 'laravel', environment: 'production' });
    assert.deepEqual(s.requests[1].json, { message: 'b', source: 'cron', environment: 'production', channel: 'requests' });
  });

  test('duplicate replies are reported', async () => {
    const s = await server(ok({ duplicate: true }));
    const res = await new Honk({ url: s.url, key: KEY }).send({ message: 'x' }, { idempotencyKey: 'deploy-4812' });
    assert.equal(res.duplicate, true);
    assert.equal(s.requests[0].headers['idempotency-key'], 'deploy-4812');
  });

  test('url is normalised (trailing slash, /v1/messages suffix)', async () => {
    const s = await server(ok());
    await new Honk({ url: `${s.url}/v1/messages/`, key: KEY }).send({ message: 'x' });
    assert.equal(s.requests[0].url, '/v1/messages');
  });

  test('helpers set event type, group key and severity', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    await honk.problem('db/backup', 'Backup failed', 'pg_dump exited with 1', { idempotencyKey: 'p-1', channel: 'backups' });
    await honk.recovery('db/backup', 'Backup OK', 'pg_dump finished');
    await honk.warning('Disk 85%', 'app-01 /var', { severity: 'info' });
    await honk.critical(null, 'Payments down');
    await honk.problem('q/failed', 'Queue', 'failing', { severity: 'critical' });
    assert.deepEqual(s.requests[0].json, { title: 'Backup failed', message: 'pg_dump exited with 1', severity: 'error', channel: 'backups', group_key: 'db/backup', event_type: 'problem' });
    assert.equal(s.requests[0].headers['idempotency-key'], 'p-1');
    assert.deepEqual(s.requests[1].json, { title: 'Backup OK', message: 'pg_dump finished', severity: 'success', group_key: 'db/backup', event_type: 'recovery' });
    assert.equal(s.requests[2].json.severity, 'warning');
    assert.deepEqual(s.requests[3].json, { message: 'Payments down', severity: 'critical' });
    assert.equal(s.requests[4].json.severity, 'critical');
  });
});

describe('the Honk scale (severity aliases)', () => {
  test('constants: horn names are aliases of the canonical values', () => {
    assert.equal(Severity.Light, 'info');
    assert.equal(Severity.Beep, 'success');
    assert.equal(Severity.Loud, 'warning');
    assert.equal(Severity.Loud, Severity.Warning);
    assert.equal(Severity.Long, 'error');
    assert.equal(Severity.Blast, 'critical');
    assert.deepEqual(SEVERITY_ALIASES, { light: 'info', beep: 'success', loud: 'warning', long: 'error', blast: 'critical' });
  });

  test('normalizeSeverity is case-insensitive and keeps canonical values', () => {
    for (const [input, want] of [['loud', 'warning'], ['LOUD', 'warning'], [' Blast ', 'critical'], ['Beep', 'success'], ['light', 'info'], ['long', 'error'], ['warning', 'warning'], ['ERROR', 'error'], ['fatal', undefined]]) {
      assert.equal(normalizeSeverity(input), want, input);
    }
  });

  test('aliases are sent canonical, so the idempotency payload is the same', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    await honk.send({ message: 'x', severity: 'loud' }, { idempotencyKey: 'k' });
    await honk.send({ message: 'x', severity: 'Warning' }, { idempotencyKey: 'k' });
    await honk.send({ message: 'x', severity: Severity.Loud }, { idempotencyKey: 'k' });
    assert.deepEqual(s.requests.map((r) => r.raw), Array(3).fill('{"message":"x","severity":"warning"}'));
  });

  test('aliases are normalized even with validate:false; unknown values pass through', () => {
    assert.equal(buildBody({ message: 'x', severity: 'BLAST' }, {}, false).severity, 'critical');
    assert.equal(buildBody({ message: 'x', severity: 'fatal' }, {}, false).severity, 'fatal');
  });

  test('unknown severities name the horn scale', () => {
    assert.throws(() => buildBody({ message: 'x', severity: 'fatal' }), /severity must be one of light \(info\), beep \(success\), loud \(warning\), long \(error\), blast \(critical\)/);
  });

  test('horn helpers', async () => {
    const s = await server(ok());
    const honk = new Honk({ url: s.url, key: KEY });
    await honk.light('a', 'm');
    await honk.beep('b', 'm');
    await honk.loud('c', 'm', { groupKey: 'disk/var' });
    await honk.long('d', 'm');
    await honk.blast('e', 'm', { severity: 'light' });
    await honk.problem('g', 'p', 'm', { severity: 'blast' });
    assert.deepEqual(s.requests.map((r) => r.json.severity), ['info', 'success', 'warning', 'error', 'critical', 'critical']);
    assert.equal(s.requests[2].json.group_key, 'disk/var');
  });
});

describe('retries and idempotency', () => {
  test('retries 503 then succeeds, reusing the same Idempotency-Key and body', async () => {
    const s = await server([apiError(503, 'unavailable', {}, { 'retry-after': '0' }), apiError(500, 'internal'), ok()]);
    const res = await new Honk({ url: s.url, key: KEY, ...fast }).send({ message: 'x' });
    assert.equal(res.id, 'msg_01k6h3w4z5x6y7z8a9b0c1d2e3');
    assert.equal(s.requests.length, 3);
    const keys = new Set(s.requests.map((r) => r.headers['idempotency-key']));
    assert.equal(keys.size, 1);
    assert.equal(new Set(s.requests.map((r) => r.raw)).size, 1);
  });

  test('retries dropped connections with the same key', async () => {
    const s = await server(['destroy', 'destroy', ok()]);
    await new Honk({ url: s.url, key: KEY, ...fast }).send({ message: 'x' }, { idempotencyKey: 'k-1' });
    assert.equal(s.requests.length, 3);
    assert.deepEqual(s.requests.map((r) => r.headers['idempotency-key']), ['k-1', 'k-1', 'k-1']);
  });

  test('retries a timed-out attempt with the same key', async () => {
    const s = await server([{ ...ok(), delayMs: 400 }, ok()]);
    const res = await new Honk({ url: s.url, key: KEY, timeoutMs: 100, ...fast }).send({ message: 'x' });
    assert.equal(res.duplicate, false);
    assert.equal(s.requests.length, 2);
    assert.equal(s.requests[0].headers['idempotency-key'], s.requests[1].headers['idempotency-key']);
  });

  test('honours Retry-After on 429 rate_limited', async () => {
    const s = await server([apiError(429, 'rate_limited', {}, { 'retry-after': '1' }), ok()]);
    const started = Date.now();
    await new Honk({ url: s.url, key: KEY, ...fast }).send({ message: 'x' });
    assert.ok(Date.now() - started >= 1000, 'waited at least Retry-After');
    assert.ok(s.requests[1].at - s.requests[0].at >= 990);
  });

  test('Retry-After beyond the deadline fails fast with HonkQuotaError', async () => {
    const s = await server(apiError(429, 'quota_exceeded', { limit: 'messages_per_day' }, { 'retry-after': '7200' }));
    const started = Date.now();
    await assert.rejects(new Honk({ url: s.url, key: KEY }).send({ message: 'x' }, { idempotencyKey: 'q-1' }), (e) => {
      assert.ok(e instanceof HonkQuotaError);
      assert.equal(e.kind, 'quota');
      assert.equal(e.code, 'quota_exceeded');
      assert.equal(e.status, 429);
      assert.equal(e.retryAfter, 7200);
      assert.equal(e.attempts, 1);
      assert.equal(e.idempotencyKey, 'q-1');
      assert.equal(e.retryable, true);
      return true;
    });
    assert.ok(Date.now() - started < 1000);
    assert.equal(s.requests.length, 1);
  });

  test('gives up after `retries` with HonkServerError', async () => {
    const s = await server(apiError(503, 'unavailable', {}, { 'retry-after': '0' }));
    await assert.rejects(new Honk({ url: s.url, key: KEY, retries: 2, ...fast }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkServerError);
      assert.equal(e.code, 'unavailable');
      assert.equal(e.attempts, 3);
      assert.equal(e.requestId, 'req_test');
      return true;
    });
    assert.equal(s.requests.length, 3);
  });

  test('stops at the deadline', async () => {
    const s = await server(apiError(503, 'unavailable', {}, { 'retry-after': '1' }));
    const started = Date.now();
    await assert.rejects(new Honk({ url: s.url, key: KEY, retries: 10, deadlineMs: 1500, ...fast }).send({ message: 'x' }), HonkServerError);
    const took = Date.now() - started;
    assert.ok(took < 1600, `took ${took} ms`);
    assert.equal(s.requests.length, 2);
  });

  test('does not start a retry that could only time out at the deadline', async () => {
    // 200 ms per answer, then a 1 s wait: a retry would have about 100 ms before the deadline.
    const s = await server({ ...apiError(503, 'unavailable', {}, { 'retry-after': '1' }), delayMs: 200 });
    await assert.rejects(new Honk({ url: s.url, key: KEY, retries: 10, deadlineMs: 1300, ...fast }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkServerError, `got ${e.name}`);
      assert.equal(e.retryAfter, 1);
      return true;
    });
    assert.equal(s.requests.length, 1);
  });

  test('times out with HonkTimeoutError once retries are exhausted', async () => {
    const s = await server({ ...ok(), delayMs: 500 });
    await assert.rejects(new Honk({ url: s.url, key: KEY, timeoutMs: 50, retries: 1, ...fast }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkTimeoutError);
      assert.ok(e instanceof HonkNetworkError);
      assert.equal(e.kind, 'timeout');
      assert.equal(e.attempts, 2);
      return true;
    });
  });

  test('connection refused becomes HonkNetworkError', async () => {
    const s = await mockServer(ok());
    await s.close();
    await assert.rejects(new Honk({ url: s.url, key: KEY, retries: 1, ...fast }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkNetworkError);
      assert.equal(e.kind, 'network');
      assert.equal(e.code, 'network_error');
      assert.match(e.idempotencyKey, UUIDV7);
      return true;
    });
  });

  test('an AbortSignal cancels the call', async () => {
    const s = await server({ ...ok(), delayMs: 1000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('stop')), 50);
    await assert.rejects(new Honk({ url: s.url, key: KEY }).send({ message: 'x' }, { signal: ac.signal }), /stop/);
  });
});

describe('error mapping (never retried)', () => {
  const cases = [
    [apiError(422, 'validation_failed', { fields: [{ field: 'severity', code: 'invalid_enum', message: 'must be one of …' }] }), HonkValidationError, 'validation_failed'],
    [apiError(422, 'unknown_field', { fields: [{ field: 'foo', code: 'not_allowed' }] }), HonkValidationError, 'unknown_field'],
    [apiError(413, 'payload_too_large'), HonkValidationError, 'payload_too_large'],
    [apiError(401, 'invalid_key'), HonkAuthError, 'invalid_key'],
    [apiError(403, 'priority_not_allowed'), HonkAuthError, 'priority_not_allowed'],
    [apiError(403, 'project_suspended'), HonkAuthError, 'project_suspended'],
    [apiError(409, 'idempotency_conflict'), HonkConflictError, 'idempotency_conflict'],
    [apiError(404, 'not_found'), HonkError, 'not_found'],
  ];
  for (const [step, Type, code] of cases) {
    test(`${step.status} ${code} → ${Type.name}`, async () => {
      const s = await server(step);
      await assert.rejects(new Honk({ url: s.url, key: KEY, ...fast }).send({ message: 'x' }), (e) => {
        assert.ok(e instanceof Type, `${e.name}`);
        assert.equal(e.code, code);
        assert.equal(e.status, step.status);
        assert.equal(e.requestId, 'req_test');
        assert.equal(e.attempts, 1);
        assert.equal(e.retryable, false);
        if (Type === HonkValidationError) assert.equal(e.local, false);
        return true;
      });
      assert.equal(s.requests.length, 1);
    });
  }

  test('422 exposes field errors', async () => {
    const s = await server(apiError(422, 'validation_failed', { fields: [{ field: 'image_url', code: 'invalid_format', message: 'must be https' }] }));
    await assert.rejects(new Honk({ url: s.url, key: KEY }).send({ message: 'x' }), (e) => {
      assert.deepEqual(e.fields, [{ field: 'image_url', code: 'invalid_format', message: 'must be https' }]);
      assert.match(e.message, /image_url must be https/);
      return true;
    });
  });

  test('redirects are not followed', async () => {
    const s = await server({ status: 301, headers: { location: 'https://honk.example.com/v1/messages' }, body: '' });
    await assert.rejects(new Honk({ url: s.url, key: KEY }).send({ message: 'x' }), /redirect to https:\/\/honk\.example\.com/);
    assert.equal(s.requests.length, 1);
  });

  test('non-JSON 502 from a proxy is retried, then reported', async () => {
    const s = await server({ status: 502, headers: { 'content-type': 'text/html' }, body: '<html>Bad Gateway</html>' });
    await assert.rejects(new Honk({ url: s.url, key: KEY, retries: 1, ...fast }).send({ message: 'x' }), (e) => {
      assert.ok(e instanceof HonkServerError);
      assert.equal(e.status, 502);
      assert.equal(e.code, undefined);
      return true;
    });
    assert.equal(s.requests.length, 2);
  });
});

describe('local validation', () => {
  const honk = new Honk({ url: 'https://honk.example.com', key: KEY });
  const bad = [
    [{}, 'message', 'required'],
    [{ message: '   ' }, 'message', 'too_short'],
    [{ message: 'x'.repeat(8193) }, 'message', 'too_long'],
    [{ message: 'é'.repeat(4097) }, 'message', 'too_long'],
    [{ message: 'bell\u0007' }, 'message', 'invalid_format'],
    [{ message: 'x', title: 't'.repeat(161) }, 'title', 'too_long'],
    [{ message: 'x', title: 'two\nlines' }, 'title', 'invalid_format'],
    [{ message: 'x', environment: 'e'.repeat(33) }, 'environment', 'too_long'],
    [{ message: 'x', groupKey: 'g'.repeat(129) }, 'group_key', 'too_long'],
    [{ message: 'x', severity: 'fatal' }, 'severity', 'invalid_enum'],
    [{ message: 'x', priority: 'asap' }, 'priority', 'invalid_enum'],
    [{ message: 'x', category: 'crm' }, 'category', 'invalid_enum'],
    [{ message: 'x', eventType: 'recovery' }, 'group_key', 'requires_group_key'],
    [{ message: 'x', sourceSequence: 3 }, 'source_sequence', 'requires_group_key'],
    [{ message: 'x', groupKey: 'g', sourceSequence: -1 }, 'source_sequence', 'out_of_range'],
    [{ message: 'x', groupKey: 'g', sourceSequence: 1.5 }, 'source_sequence', 'out_of_range'],
    [{ message: 'x', url: 'http://example.com' }, 'url', 'invalid_format'],
    [{ message: 'x', url: 'https://user:pw@example.com' }, 'url', 'invalid_format'],
    [{ message: 'x', url: `https://example.com/${'a'.repeat(2048)}` }, 'url', 'invalid_format'],
    [{ message: 'x', imageUrl: 'https://cdn.example.com/a.jpg#x' }, 'image_url', 'invalid_format'],
    [{ message: 'x', imageUrl: 'https://cdn.example.com:99999/a.jpg' }, 'image_url', 'invalid_format'],
    [{ message: 'x', occurredAt: '2026-10-02 10:00' }, 'occurred_at', 'invalid_format'],
    [{ message: 'x', occurredAt: new Date('nope') }, 'occurred_at', 'invalid_format'],
    [{ message: 'x', metadata: { nested: { a: 1 } } }, 'metadata.nested', 'invalid_format'],
    [{ message: 'x', metadata: { 'bad key': 1 } }, 'metadata.bad key', 'invalid_format'],
    [{ message: 'x', metadata: { v: 'v'.repeat(513) } }, 'metadata.v', 'invalid_format'],
    [{ message: 'x', metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])) }, 'metadata', 'too_long'],
    [{ message: 'x', ttlSeconds: 59 }, 'ttl_seconds', 'out_of_range'],
    [{ message: 'x', ttlSeconds: 86401 }, 'ttl_seconds', 'out_of_range'],
    [{ message: 'x', group_key: 'g' }, 'group_key', 'not_allowed'],
    [{ message: 'x', actions: Array(4).fill({ title: 'Call', url: 'tel:+15550134' }) }, 'actions', 'too_long'],
    [{ message: 'x', actions: 'tel:+15550134' }, 'actions', 'invalid_format'],
    [{ message: 'x', actions: ['tel:+15550134'] }, 'actions', 'invalid_format'],
    [{ message: 'x', actions: [{ url: 'tel:+15550134' }] }, 'actions[0].title', 'required'],
    [{ message: 'x', actions: [{ title: '   ', url: 'tel:+15550134' }] }, 'actions[0].title', 'required'],
    [{ message: 'x', actions: [{ title: 't'.repeat(41), url: 'tel:+15550134' }] }, 'actions[0].title', 'too_long'],
    [{ message: 'x', actions: [{ title: 'Call\nEmily', url: 'tel:+15550134' }] }, 'actions[0].title', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Call', url: '' }] }, 'actions[0].url', 'required'],
    [{ message: 'x', actions: [{ title: 'Open', url: `https://example.com/${'a'.repeat(2030)}` }] }, 'actions[0].url', 'too_long'],
    [{ message: 'x', actions: [{ title: 'Call', url: 'tel:+15550134' }, { title: 'Open', url: 'http://example.com' }] }, 'actions[1].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Open', url: 'https://user:pw@example.com' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Run', url: 'javascript:alert(1)' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Open', url: 'shop://orders/4812' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Reply', url: 'mailto:' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Reply', url: 'mailto:emily?subject=Hi' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Reply', url: 'mailto:emily@example.com?subject=Your quote' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Call', url: 'tel:call-me' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Call', url: 'tel:+1 555 0134' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Text', url: 'sms:?body=hi' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Reply', url: 'mailto:emily@localhost' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Reply', url: 'mailto:emily@example.com,ana@example.com' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Reply', url: 'mailto:emily@example.com?cc=boss@example.com' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Reply', url: 'mailto:emily@example.com?subject=%zz' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Text', url: 'sms:+15550134?subject=Hi' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Open', url: 'https://example.com/a\u00a0b' }] }, 'actions[0].url', 'invalid_format'],
    [{ message: 'x', actions: [{ title: 'Call', url: '   ' }] }, 'actions[0].url', 'required'],
    [{ message: 'x', actions: [{ title: 'Call', url: 'tel:+15550134', icon: 'phone' }] }, 'actions[0].icon', 'not_allowed'],
    [{ message: 'x'.repeat(8000), metadata: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, '"'.repeat(500)])) }, 'body', 'too_long'],
  ];
  for (const [msg, field, code] of bad) {
    test(`${field} ${code}`, async () => {
      await assert.rejects(honk.send(msg), (e) => {
        assert.ok(e instanceof HonkValidationError, e.message);
        assert.equal(e.local, true);
        assert.equal(e.attempts, 0);
        assert.ok(
          e.fields.some((f) => f.field === field && f.code === code),
          `expected ${field}/${code}, got ${JSON.stringify(e.fields)}`,
        );
        return true;
      });
    });
  }

  test('snake_case keys get a hint', () => {
    assert.throws(() => buildBody({ message: 'x', group_key: 'g' }), /group_key unknown field \(use groupKey\)/);
  });

  test('all errors are reported at once', () => {
    assert.throws(
      () => buildBody({ message: '', severity: 'x', url: 'ftp://a' }),
      (e) => e.fields.map((f) => f.field).join(',') === 'message,severity,url',
    );
  });

  test('valid edge cases pass', () => {
    const body = buildBody({
      message: 'line1\nline2\ttab\r\n',
      title: 't'.repeat(160),
      occurredAt: '2026-10-02T00:10:00.123456+03:00',
      url: 'https://[::1]:8443/path?q=1#frag',
      imageUrl: 'HTTPS://cdn.example.com/a.jpg?size=2',
      metadata: { 'a.b-c_d': 'v', n: 1.5, b: false },
      groupKey: 'g',
      sourceSequence: Number.MAX_SAFE_INTEGER,
      ttlSeconds: 60,
    });
    assert.equal(body.source_sequence, 9007199254740991);
  });

  test('valid actions pass', () => {
    for (const url of [
      'https://shop.example.com:8443/admin/requests/4812?tab=notes#reply',
      'HTTPS://shop.example.com',
      'mailto:emily@example.com',
      'MailTo:emily.carter+quotes@example.co.uk?subject=Your%20quote&body=Hi%20Emily%2C',
      'tel:+15550134',
      'TEL:+1-(555)-013.4',
      'tel://+40721000000',
      'sms:+15550134',
      'SMS:0721000000?body=On%20my%20way',
      'mailto:%65mily@example.com?body=a+b&subject=',
      '  tel:+15550134  ',
    ]) {
      assert.deepEqual(buildBody({ message: 'x', actions: [{ title: 'Open', url }] }).actions, [{ title: 'Open', url }], url);
    }
    const title = `  ${'é'.repeat(39)}🚀  `; // 40 code points once trimmed
    assert.equal(buildBody({ message: 'x', actions: [{ title, url: 'tel:+15550134' }] }).actions[0].title, title);
  });

  test('more than 3 actions is one error, like on the server', () => {
    assert.throws(
      () => buildBody({ message: 'x', actions: ['a', 'b', { title: '' }, { url: 'ftp://x' }] }),
      (e) => e.fields.map((f) => `${f.field}:${f.code}`).join(',') === 'actions:too_long',
    );
  });

  test('all action errors are reported with their index', () => {
    assert.throws(
      () => buildBody({ message: 'x', actions: [{ title: 'Reply', url: 'mailto:emily@example.com' }, { title: '', url: 'ftp://files' }, { title: 'Call' }] }),
      (e) => e.fields.map((f) => `${f.field}:${f.code}`).join(',') === 'actions[1].title:required,actions[1].url:invalid_format,actions[2].url:required',
    );
  });

  test('invalid idempotency keys are rejected locally', async () => {
    for (const key of ['', 'has space', 'x'.repeat(129), 'ünicode']) {
      await assert.rejects(honk.send({ message: 'x' }, { idempotencyKey: key }), (e) => e instanceof HonkValidationError && e.fields[0].field === 'Idempotency-Key');
    }
  });

  test('validate:false sends actions as given', () => {
    const actions = [{ title: 'Run', url: 'javascript:alert(1)' }];
    assert.deepEqual(buildBody({ message: 'x', actions }, {}, false).actions, actions);
  });

  test('validate:false leaves value checks to the server', async () => {
    const s = await server(apiError(422, 'validation_failed', { fields: [{ field: 'severity', code: 'invalid_enum' }] }));
    await assert.rejects(new Honk({ url: s.url, key: KEY, validate: false }).send({ message: 'x', severity: 'fatal' }), (e) => e.local === false);
    assert.equal(s.requests[0].json.severity, 'fatal');
  });
});

describe('construction', () => {
  test('rejects missing or malformed url/key with a clear message', () => {
    assert.throws(() => new Honk({ url: '', key: KEY }), /url is required.*HONK_URL/);
    assert.throws(() => new Honk({ url: 'honk.example.com', key: KEY }), /must start with https:\/\//);
    assert.throws(() => new Honk({ url: 'https://h', key: undefined }), /key is required.*HONK_KEY/);
    assert.throws(() => new Honk({ url: 'https://h', key: 'hka_mobiletoken' }), /starting with honk_/);
    assert.throws(() => new Honk({ url: 'https://h', key: KEY, retries: -1 }), /retries/);
    assert.throws(() => new Honk({ url: 'https://h', key: KEY, timeoutMs: 0 }), /timeoutMs/);
  });

  test('fromEnv reads HONK_* variables', async () => {
    const s = await server(ok());
    const saved = { ...process.env };
    Object.assign(process.env, { HONK_URL: s.url, HONK_KEY: KEY, HONK_SOURCE: 'cron', HONK_ENVIRONMENT: 'staging' });
    try {
      const honk = Honk.fromEnv();
      await honk.send({ message: 'x' });
      assert.deepEqual(s.requests[0].json, { message: 'x', source: 'cron', environment: 'staging' });
    } finally {
      for (const k of ['HONK_URL', 'HONK_KEY', 'HONK_SOURCE', 'HONK_ENVIRONMENT']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  test('VERSION matches package.json', () => {
    assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  });
});

describe('helpers', () => {
  test('uuidv7 is version 7, variant 10, time-ordered', async () => {
    const a = await uuidv7(1_700_000_000_000);
    const b = await uuidv7(1_700_000_000_001);
    assert.match(a, UUIDV7);
    assert.ok(a < b);
    assert.equal(a.slice(0, 13).replace('-', ''), (1_700_000_000_000).toString(16).padStart(12, '0'));
  });

  const isBun = typeof globalThis.Bun !== 'undefined';
  test('uuidv7 works without a global crypto (Node 18)', { skip: isBun && 'Bun always has Web Crypto' }, async () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto'); // Node 18: inherited, no own property
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    try {
      assert.match(await uuidv7(), UUIDV7);
    } finally {
      if (desc) Object.defineProperty(globalThis, 'crypto', desc);
      else delete globalThis.crypto;
    }
  });

  test('parseRetryAfter handles seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('3'), 3);
    assert.equal(parseRetryAfter(' 120 '), 120);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter('soon'), undefined);
    const now = Date.parse('2026-10-02T10:00:00Z');
    assert.equal(parseRetryAfter('Fri, 02 Oct 2026 10:00:30 GMT', now), 30);
    assert.equal(parseRetryAfter('Fri, 02 Oct 2026 09:00:00 GMT', now), 0);
  });
});
