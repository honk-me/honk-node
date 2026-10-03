// Runs against a real Honk server when HONK_URL and HONK_KEY are set (see ../../README.md,
// "Integration tests"); skipped otherwise.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Honk, HonkAuthError, HonkConflictError, HonkValidationError, uuidv7 } from '../dist/esm/index.js';

const { HONK_URL, HONK_KEY } = process.env;
const skip = !HONK_URL || !HONK_KEY ? 'set HONK_URL and HONK_KEY to run against a real server' : false;
const run = `node-${Date.now()}`;

describe('integration (real server)', { skip }, () => {
  const honk = new Honk({ url: HONK_URL, key: HONK_KEY, defaults: { source: 'sdk-node-it', environment: 'test' } });

  test('minimal message is accepted', async () => {
    const res = await honk.send({ message: `minimal ${run}` });
    assert.match(res.id, /^msg_/);
    assert.equal(res.duplicate, false);
    assert.ok(res.receivedAt instanceof Date && !Number.isNaN(res.receivedAt.getTime()));
  });

  test('every field is accepted, and a replay with the same key is a duplicate', async () => {
    const msg = {
      title: `Customer request ${run}`,
      message: 'Ana (Acme) asked for a quote:\nonline shop, 40 products',
      severity: 'info',
      priority: 'high',
      category: 'customers',
      source: 'sdk-node-it',
      environment: 'test',
      channel: 'requests',
      groupKey: `requests/${run}`,
      eventType: 'event',
      occurredAt: new Date(),
      url: 'https://example.com/admin/requests/4812',
      imageUrl: 'https://example.com/images/quote.png',
      metadata: { request_id: '4812', amount: 1250.5, vip: true },
      ttlSeconds: 600,
      sourceSequence: 1,
    };
    const key = `it-${await uuidv7()}`;
    const first = await honk.send(msg, { idempotencyKey: key });
    const again = await honk.send(msg, { idempotencyKey: key });
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
    assert.equal(again.receivedAt.getTime(), first.receivedAt.getTime());
  });

  test('same key with a different payload is a HonkConflictError', async () => {
    const key = `it-${await uuidv7()}`;
    await honk.info('first', `payload A ${run}`, { idempotencyKey: key });
    await assert.rejects(honk.info('first', `payload B ${run}`, { idempotencyKey: key }), (e) => {
      assert.ok(e instanceof HonkConflictError);
      assert.equal(e.code, 'idempotency_conflict');
      assert.equal(e.status, 409);
      assert.equal(e.idempotencyKey, key);
      return true;
    });
  });

  test('problem then recovery for one group', async () => {
    const group = `it/node/${run}`;
    const p = await honk.problem(group, 'Backup failed', 'pg_dump exited with 1', { sourceSequence: 1 });
    const r = await honk.recovery(group, 'Backup OK', 'pg_dump finished', { sourceSequence: 2 });
    assert.notEqual(p.id, r.id);
  });

  test('a horn alias and its canonical severity are the same event', async () => {
    const key = `it-${await uuidv7()}`;
    const first = await honk.loud('Disk 91%', `/var on app-01 ${run}`, { idempotencyKey: key });
    const again = await honk.send({ title: 'Disk 91%', message: `/var on app-01 ${run}`, severity: 'WARNING' }, { idempotencyKey: key });
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
  });

  test('a wrong key is a HonkAuthError (invalid_key)', async () => {
    const bad = new Honk({ url: HONK_URL, key: 'honk_000000000000_00000000000000000000000000000000' });
    await assert.rejects(bad.send({ message: 'x' }), (e) => e instanceof HonkAuthError && e.code === 'invalid_key' && e.status === 401);
  });

  test('urgent without allow_urgent is HonkAuthError priority_not_allowed (or accepted when the key allows it)', async () => {
    try {
      const res = await honk.send({ message: `urgent ${run}`, priority: 'urgent' });
      assert.match(res.id, /^msg_/);
    } catch (e) {
      assert.ok(e instanceof HonkAuthError, String(e));
      assert.equal(e.code, 'priority_not_allowed');
      assert.equal(e.status, 403);
    }
  });

  test('server-side validation maps to HonkValidationError with fields', async () => {
    const raw = new Honk({ url: HONK_URL, key: HONK_KEY, validate: false });
    await assert.rejects(raw.send({ message: 'x', severity: 'fatal', ttlSeconds: 5 }), (e) => {
      assert.ok(e instanceof HonkValidationError);
      assert.equal(e.local, false);
      assert.equal(e.status, 422);
      assert.equal(e.code, 'validation_failed');
      const fields = e.fields.map((f) => `${f.field}:${f.code}`).sort();
      assert.deepEqual(fields, ['severity:invalid_enum', 'ttl_seconds:out_of_range']);
      return true;
    });
  });
});
