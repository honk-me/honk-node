// Runtime smoke test for Bun and Deno (CI): `bun test/runtime-smoke.mjs`,
// `deno run --allow-net --allow-read test/runtime-smoke.mjs`. Exercises construction,
// validation, UUIDv7 (Web Crypto) and the fetch/error path without a server.
import { Honk, HonkNetworkError, HonkValidationError, buildBody, uuidv7 } from '../dist/esm/index.js';

const fail = (msg) => {
  console.error(`runtime smoke: ${msg}`);
  throw new Error(msg);
};

const key = await uuidv7();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(key)) fail(`bad uuidv7 ${key}`);

const body = buildBody({ message: 'x', groupKey: 'g', occurredAt: new Date(0) });
if (body.group_key !== 'g' || body.occurred_at !== '1970-01-01T00:00:00.000Z') fail(JSON.stringify(body));

const honk = new Honk({ url: 'http://127.0.0.1:9', key: 'honk_smoke', retries: 1, backoff: { baseMs: 1 } });
try {
  await honk.send({ message: 'x', severity: 'fatal' });
  fail('validation did not throw');
} catch (e) {
  if (!(e instanceof HonkValidationError)) fail(`expected HonkValidationError, got ${e}`);
}
try {
  await honk.send({ message: 'x' });
  fail('send to a closed port did not throw');
} catch (e) {
  if (!(e instanceof HonkNetworkError) || e.attempts !== 2) fail(`expected HonkNetworkError after 2 attempts, got ${e}`);
}
console.log('runtime smoke: ok');
