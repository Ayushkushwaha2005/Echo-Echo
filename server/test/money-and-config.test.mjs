/* Money parsing, provider honesty, and the flag rules. */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused';
const { toPaise } = await import('../src/routes/catalog.js').catch(() => ({}))
  .then(() => import('../src/routes/catalog.js'));

test('prices parse to integer paise with no float rounding', () => {
  assert.equal(toPaise('90'), 9000);
  assert.equal(toPaise('95.50'), 9550);
  assert.equal(toPaise('0.05'), 5);
  assert.equal(toPaise(120), 12000);
  assert.equal(toPaise(' 90 '), 9000);   // form input is trimmed
  /* 0.1 + 0.2 problems cannot occur because no float is ever involved. */
  assert.equal(toPaise('19.99') * 3, 5997);
});

test('malformed prices are refused rather than coerced', () => {
  for (const bad of ['', 'abc', '-5', '1.234', '1e3', ' ₹90', null, undefined, {}]) {
    assert.throws(() => toPaise(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test('providerStatus reports unconfigured providers honestly', async () => {
  const { providerStatus } = await import('../src/config.js');
  const s = providerStatus();
  /* With no env set, nothing may claim to be configured. */
  assert.equal(s.otp.configured, false);
  assert.equal(s.payments.configured, false);
  assert.equal(s.ai.configured, false);
  assert.equal(s.ocr.configured, false);
  assert.equal(s.roster.configured, false);
  assert.equal(s.storage.productionReady, false);
});

test('boot refuses without a platform owner', async () => {
  const { assertBootable } = await import('../src/config.js');
  const out = assertBootable();
  assert.equal(out.ok, false);
  assert.ok(out.fatal.some((f) => /PLATFORM_OWNER_PHONE/.test(f)));
});

test('feature flags derive from provider configuration', async () => {
  const { FLAG_DEFAULTS, FLAG_REQUIRES } = await import('../src/config.js');
  /* Nothing that needs an absent provider may default to on. */
  assert.equal(FLAG_DEFAULTS.ai_ordering, false);
  assert.equal(FLAG_DEFAULTS.online_payment, false);
  assert.equal(FLAG_REQUIRES.online_payment(), false);
  assert.equal(FLAG_REQUIRES.ai_ordering(), false);
});
