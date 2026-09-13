/* ==========================================================================
   STUDENT LOGIN — the real OTP flow, end to end, with a provider configured.

   The only thing replaced is the SMS gateway itself: MSG91_BASE_URL points
   at a stub HTTP server inside this test process that records what would
   have been texted, so the test can read the code off the "phone" exactly
   as a student would. Everything else is production code — the routes, the
   OTP service, the session cookie, the database. Nothing here is reachable
   by the application outside the test run, and there is still no bypass.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeVendor, makeItem } from './helpers/db.mjs';
import { makeApp, client } from './helpers/api.mjs';

let app, pool, stub, stubMode = 'ok';
const inbox = [];                      // what the "provider" was asked to send

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      inbox.push(body);
      res.setHeader('content-type', 'application/json');
      if (stubMode === 'error200') return res.end(JSON.stringify({ type: 'error', message: 'Template not approved' }));
      if (stubMode === 'echo500') { res.statusCode = 500; return res.end(`bad request: ${raw}`); }
      res.end(JSON.stringify({ type: 'success', request_id: `req-${inbox.length}` }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));

  await startDb();
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    OTP_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'test-key', MSG91_TEMPLATE_ID: 'tmpl',
    MSG91_SENDER: 'ECHOEC', MSG91_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
  });
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); stub?.close(); });
beforeEach(async () => { await truncateAll(pool); inbox.length = 0; stubMode = 'ok'; });

const anon = () => client(app);
const codeSentTo = (phone) => {
  const m = [...inbox].reverse().find((b) => b.recipients?.[0]?.mobiles === phone.replace('+', ''));
  return m?.recipients[0].otp;
};
const cookieOf = (res) => {
  const raw = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('quad_session='));
  return raw ? raw.split(';')[0].split('=')[1] : null;
};
/* Moves the last challenge back in time, so cooldown tests do not sleep. */
const age = (phone, seconds) => pool.query(
  `UPDATE otp_challenge SET created_at = created_at - ($2 || ' seconds')::interval WHERE phone = $1`,
  [phone, String(seconds)]);

test('a student signs in with a real code: server generates, provider delivers, server verifies', async () => {
  const phone = '+919812300001';
  const sent = await anon().post('/auth/otp/send', { phone: '9812300001' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.sent, true);
  assert.ok(!JSON.stringify(sent.body).match(/\b\d{6}\b/), 'the code is never returned to the browser');

  const code = codeSentTo(phone);
  assert.match(code, /^\d{6}$/, 'the provider was asked to deliver a six-digit code');
  assert.equal(inbox[0].template_id, 'tmpl');

  const ok = await anon().post('/auth/otp/verify', { phone: '9812300001', code });
  assert.equal(ok.status, 200);
  const token = cookieOf(ok);
  assert.ok(token, 'a session cookie is issued only after verification');
  const setCookie = [].concat(ok.headers['set-cookie']).join(';');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const me = await client(app, token).get('/auth/me');
  assert.equal(me.body.authenticated, true);
  assert.deepEqual(me.body.roles, ['student'], 'a new account is a student and nothing else');
  assert.equal(me.body.user.studentStatus, 'unverified');
});

test('after login, an unverified student still cannot order — verification is a separate gate', async () => {
  const phone = '+919812300002';
  await anon().post('/auth/otp/send', { phone });
  const res = await anon().post('/auth/otp/verify', { phone, code: codeSentTo(phone) });
  const s = client(app, cookieOf(res));
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco' });
  const i = await makeItem(pool, v.id, { name: 'Tea', paise: 2000 });
  const draft = await s.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' });
  assert.equal(draft.status, 403);
  assert.match(draft.body.error, /verification/i);
});

test('the code is stored only as a salted hash', async () => {
  const phone = '+919812300003';
  await anon().post('/auth/otp/send', { phone });
  const code = codeSentTo(phone);
  const row = (await pool.query(`SELECT * FROM otp_challenge WHERE phone = $1`, [phone])).rows[0];
  assert.ok(!JSON.stringify(row).includes(`"${code}"`), 'no column holds the plaintext code');
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  assert.ok(row.salt);
});

test('a used code cannot be replayed', async () => {
  const phone = '+919812300004';
  await anon().post('/auth/otp/send', { phone });
  const code = codeSentTo(phone);
  assert.equal((await anon().post('/auth/otp/verify', { phone, code })).status, 200);
  const again = await anon().post('/auth/otp/verify', { phone, code });
  assert.notEqual(again.status, 200);
  assert.equal(cookieOf(again), null, 'no second session from the same code');
});

test('an expired code does not sign anyone in', async () => {
  const phone = '+919812300005';
  await anon().post('/auth/otp/send', { phone });
  await pool.query(`UPDATE otp_challenge SET expires_at = now() - interval '1 second' WHERE phone = $1`, [phone]);
  const r = await anon().post('/auth/otp/verify', { phone, code: codeSentTo(phone) });
  assert.equal(r.status, 400);
  assert.equal(cookieOf(r), null);
});

test('five wrong guesses kill the code — even the right code fails afterwards', async () => {
  const phone = '+919812300006';
  await anon().post('/auth/otp/send', { phone });
  const code = codeSentTo(phone);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let k = 0; k < 5; k++) assert.equal((await anon().post('/auth/otp/verify', { phone, code: wrong })).status, 400);
  const r = await anon().post('/auth/otp/verify', { phone, code });
  assert.notEqual(r.status, 200);
  assert.equal(cookieOf(r), null);
});

test('a burst of parallel guesses cannot exceed the attempt ceiling', async () => {
  const phone = '+919812300007';
  await anon().post('/auth/otp/send', { phone });
  const code = codeSentTo(phone);
  const guesses = Array.from({ length: 60 }, (_, k) => String((Number(code) + 1 + k) % 1e6).padStart(6, '0'));
  const results = await Promise.all(guesses.map((g) => anon().post('/auth/otp/verify', { phone, code: g })));
  assert.ok(results.every((r) => r.status !== 200));
  const row = (await pool.query(`SELECT attempts, max_attempts FROM otp_challenge WHERE phone = $1`, [phone])).rows[0];
  assert.ok(row.attempts <= row.max_attempts, `attempts ${row.attempts} must not exceed ${row.max_attempts}`);
  assert.notEqual((await anon().post('/auth/otp/verify', { phone, code })).status, 200,
    'after the burst the challenge is spent');
});

test('resend is cooled down, and a number gets at most six codes an hour', async () => {
  const phone = '+919812300008';
  assert.equal((await anon().post('/auth/otp/send', { phone })).status, 200);
  assert.equal((await anon().post('/auth/otp/send', { phone })).status, 429, 'cooldown');
  for (let k = 0; k < 5; k++) { await age(phone, 60); assert.equal((await anon().post('/auth/otp/send', { phone })).status, 200); }
  await age(phone, 60);
  const capped = await anon().post('/auth/otp/send', { phone });
  assert.equal(capped.status, 429, 'hourly cap');
  assert.equal(inbox.length, 6, 'exactly six messages were sent');
});

test('a burst of parallel send requests pays for exactly one SMS', async () => {
  const phone = '+919812300009';
  const results = await Promise.all(Array.from({ length: 12 }, () => anon().post('/auth/otp/send', { phone })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(inbox.length, 1, 'the provider was called once');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM otp_challenge WHERE phone = $1`, [phone])).rows[0].n, 1);
});

test('numbers outside the allowed prefixes are never texted', async () => {
  const r = await anon().post('/auth/otp/send', { phone: '+447700900123' });
  assert.equal(r.status, 400);
  assert.equal(inbox.length, 0);
});

test('a provider that answers 200 with an error body does not create a live code', async () => {
  stubMode = 'error200';
  const phone = '+919812300010';
  const r = await anon().post('/auth/otp/send', { phone });
  assert.notEqual(r.status, 200);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM otp_challenge WHERE phone = $1`, [phone])).rows[0].n, 0);
});

test('a provider error never carries the code into an error message', async () => {
  stubMode = 'echo500';
  const { sendOtp } = await import('../src/services/otp.js');
  let message = '';
  try { await sendOtp('+919812300011'); } catch (e) { message = e.message; }
  const code = inbox[0].recipients[0].otp;
  assert.ok(message.length > 0);
  assert.ok(!message.includes(code), 'the code is scrubbed from the error');
});

test('no session without a successful verify, and one number\'s code does not open another account', async () => {
  const a = '+919812300012', b = '+919812300013';
  const noChallenge = await anon().post('/auth/otp/verify', { phone: a, code: '123456' });
  assert.equal(noChallenge.status, 400);
  assert.equal(cookieOf(noChallenge), null);

  await anon().post('/auth/otp/send', { phone: a });
  await anon().post('/auth/otp/send', { phone: b });
  const aCode = codeSentTo(a);
  const cross = await anon().post('/auth/otp/verify', { phone: b, code: aCode });
  assert.notEqual(cross.status, 200, "A's code cannot sign in as B");
  assert.equal(cookieOf(cross), null);

  const forged = await client(app, 'forged-token-value').get('/auth/me');
  assert.equal(forged.body.authenticated, false);
});
