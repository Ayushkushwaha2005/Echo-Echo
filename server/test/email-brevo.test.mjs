/* ==========================================================================
   STUDENT SIGN-IN OVER BREVO — end to end.

   Brevo is the domain-free email provider: it delivers to any recipient from
   one verified sender address. The only thing replaced here is its HTTP
   endpoint (BREVO_BASE_URL → a stub in this process that records what would
   have been mailed). The routes, the code, the budget ledger and the session
   are production code, and the code is read out of the stubbed mailbox
   exactly as a student would read it.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll } from './helpers/db.mjs';
import { makeApp, client } from './helpers/api.mjs';

let app, pool, stub, stubStatus = 201;
const mailbox = [];

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      mailbox.push({ path: req.url, key: req.headers['api-key'], body: JSON.parse(raw || '{}') });
      res.setHeader('content-type', 'application/json');
      res.statusCode = stubStatus;
      res.end(stubStatus === 201
        ? JSON.stringify({ messageId: `<msg-${mailbox.length}@smtp-relay.mailin.fr>` })
        : JSON.stringify({ code: 'unauthorized', message: `rejected; body was ${raw}` }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await startDb();
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    OTP_PROVIDER: '',
    EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'xkeysib-test', RESEND_API_KEY: '',
    EMAIL_FROM: 'ECHO ECHO <echo.sender@example.org>',
    BREVO_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
  });
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); stub?.close(); });
beforeEach(async () => { await truncateAll(pool); await pool.query('TRUNCATE email_send_log'); mailbox.length = 0; stubStatus = 201; });

const anon = () => client(app);

test('a student code goes out through Brevo to the institutional address, and signs them in', async () => {
  const email = 'ayush.17551@stu.upes.ac.in';
  const sent = await anon().post('/auth/email/send', { email });
  assert.equal(sent.status, 200);
  assert.ok(!JSON.stringify(sent.body).match(/\b\d{6}\b/), 'the code is never returned to the browser');

  assert.equal(mailbox.length, 1);
  const m = mailbox[0];
  assert.equal(m.path, '/v3/smtp/email');
  assert.equal(m.key, 'xkeysib-test', 'authenticated with the Brevo key, not a bearer token');
  assert.deepEqual(m.body.sender, { name: 'ECHO ECHO', email: 'echo.sender@example.org' });
  assert.deepEqual(m.body.to, [{ email }]);
  const code = m.body.textContent.match(/code is: (\d{6})/)?.[1];
  assert.ok(code, 'the mailed text carries the code');

  const ok = await anon().post('/auth/email/verify', { email, code });
  assert.equal(ok.status, 200);
  const cookie = [].concat(ok.headers['set-cookie'] || []).find((c) => c.startsWith('quad_session='));
  assert.ok(cookie, 'a session cookie is issued');
  assert.match(cookie, /HttpOnly/i);

  const log = await pool.query(`SELECT outcome, provider_ref FROM email_send_log`);
  assert.equal(log.rows[0].outcome, 'sent');
  assert.match(log.rows[0].provider_ref, /^<msg-1@/);
});

test('a Brevo refusal is a generic 503 and leaks neither the code nor the provider message', async () => {
  stubStatus = 401;
  const r = await anon().post('/auth/email/send', { email: 'someone@stu.upes.ac.in' });
  assert.equal(r.status, 503);
  assert.ok(!/brevo|unauthorized|rejected/i.test(JSON.stringify(r.body)));
  assert.ok(!JSON.stringify(r.body).match(/\b\d{6}\b/));
  const log = await pool.query(`SELECT outcome FROM email_send_log`);
  assert.equal(log.rows[0].outcome, 'provider_error');
});

test('a non-institutional address is refused before anything is sent', async () => {
  const r = await anon().post('/auth/email/send', { email: 'someone@gmail.com' });
  assert.ok(r.status >= 400 && r.status < 500);
  assert.equal(mailbox.length, 0);
});
