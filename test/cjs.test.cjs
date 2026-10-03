// The CommonJS build exposes the same API as the ES module build.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const honk = require('../dist/cjs/index.js');

test('require("honk-me") works', async () => {
  assert.equal(typeof honk.Honk, 'function');
  assert.equal(typeof honk.HonkValidationError, 'function');
  assert.equal(honk.VERSION, require('../package.json').version);
  const err = (() => {
    try {
      honk.buildBody({});
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof honk.HonkValidationError);
  assert.ok(err instanceof honk.HonkError);
  assert.equal(err.kind, 'validation');
  assert.match(await honk.uuidv7(), /^[0-9a-f-]{36}$/);
});
