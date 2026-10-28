/* ==========================================================================
   CAMPUS CONTROL: ENROLMENT FROM THE MAILBOX, AND "FORGOT PASSWORD?" BY EMAIL

   End to end through the real routes. The only thing replaced is the email
   provider: RESEND_BASE_URL points at a stub in this process that records
   what would have been mailed, and the test reads the code out of that
   "mailbox" as the administrator would.

   * An administrator signed in with their student email code can set a
     first password and add an authenticator (otpauth:// URI, confirmed only
     by a correct six-digit code), but that session still cannot use
     administrator powers, and cannot replace a working authenticator or
     change a password without the current password and a code.
   * A student without a platform role cannot enrol at all.
   * The reset email carries a code and never a password; the code is
     short-lived, single-use, attempt-limited and rate-limited; strangers
     get the same answer and no email; a completed reset ends every session
     and leaves the authenticator in place; nothing secret is audited.
   Synthetic accounts only.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser } from './helpers/db.mjs';
import { makeApp, client, sessionFor } from './helpers/api.mjs';

let app, pool, stub, auth;
const mailbox = [];
const EMAIL = 'owner.reset@stu.upes.ac.in';
const PASSWORD = 'correct horse battery staple';

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      mailbox.push(JSON.parse(raw || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: `msg-${mailbox.length}` }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await startDb();
  Object.assign(process.env, {
    ADMIN_TOTP_KEY: 'test-admin-totp-key-0123456789abcdef',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    ADMIN_PASSKEY_REQUIRED: 'true',
    PLATFORM_OWNER_EMAIL: EMAIL,
    EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'ECHO ECHO <verify@echo.test>',
    RESEND_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
  });
  ({ pool } = await import('../src/db/index.js'));
  auth = await import('../src/services/admin-auth.js');
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); stub?.close(); });
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE admin_credential, admin_account CASCADE');
  mailbox.length = 0;
});

const anon = () => client(app, null);
const codeMailedTo = (email) => [...mailbox].reverse().find((m) => m.to?.[0] === email)?.text?.match(/code is: (\d{6})/)?.[1];
/* The owner: one account that orders as a student and administers as the owner. */
async function theOwner() {
  const u = await makeUser(pool, { phone: '+919000000301', name: 'Owner Reset', roles: ['student', 'platform_owner'] });
  await pool.query(`UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`, [u.id, EMAIL]);
  return u;
}
const totpNow = async (userId) => {
  const c = (await pool.query(`SELECT totp_secret_enc FROM admin_credential WHERE user_id = $1`, [userId])).rows[0];
  return auth.totpAt(auth.decryptSecret(c.totp_secret_enc), auth.stepNow());
};
async function signInAdmin(password, code) {
  const s1 = await anon().post('/auth/admin/login/password', { email: EMAIL, password });
  if (s1.status !== 200) return s1;
  return anon().post('/auth/admin/login', { challenge: s1.body.challenge, code });
}

/* ---------- enrolment from the student (email-code) session ---------------- */

test('the owner enrols from their student session: password, QR URI, a confirmed code, then signs in with both', async () => {
  const u = await theOwner();
  const c = client(app, await sessionFor(pool, u.id, { method: 'code' }));
  const me = (await c.get('/auth/me')).body;
  assert.ok(me.surfaces.includes('web'), 'the student account still orders');
  assert.ok(!me.surfaces.includes('admin'), 'an email-code session never opens Campus Control');
  assert.ok(me.passkey.adminSurfacesPending.includes('admin'), 'the screen knows to offer enrolment');

  assert.deepEqual((await c.get('/auth/admin/credential')).body.passwordSet, false);
  assert.equal((await c.post('/auth/admin/credential/password', { password: 'short' })).status, 400, 'weak password refused');
  assert.equal((await c.post('/auth/admin/credential/password', { password: PASSWORD })).status, 200);

  const begin = await c.post('/auth/admin/credential/authenticator/begin');
  assert.equal(begin.status, 200);
  assert.match(begin.body.uri, /^otpauth:\/\/totp\/[^?]+\?secret=[A-Z2-7]+&issuer=[^&]+&algorithm=SHA1&digits=6&period=30$/);
  assert.match(begin.body.secret, /^[A-Z2-7]{32}$/);
  assert.ok(begin.body.uri.includes(encodeURIComponent(EMAIL)));

  assert.equal((await c.post('/auth/admin/credential/authenticator/confirm', { code: '000000' })).status, 400, 'a wrong code does not confirm');
  assert.equal((await c.get('/auth/admin/credential')).body.authenticatorReady, false);
  const right = auth.totpAt(begin.body.secret, auth.stepNow());
  assert.equal((await c.post('/auth/admin/credential/authenticator/confirm', { code: right })).status, 200);
  assert.equal((await c.get('/auth/admin/credential')).body.authenticatorReady, true);

  /* The enrolling session is still a student session. */
  assert.equal((await c.get('/admin/access/admins')).status, 403);
  /* The secret is stored encrypted, and the same code cannot be spent twice. */
  const row = (await pool.query(`SELECT totp_secret_enc FROM admin_credential WHERE user_id = $1`, [u.id])).rows[0];
  assert.ok(!JSON.stringify(row).includes(begin.body.secret));
  assert.equal((await signInAdmin(PASSWORD, right)).status, 403, 'the confirming code is already spent');

  /* Sign-in needs both factors. */
  assert.equal((await signInAdmin(PASSWORD, '123456')).status, 403);
  assert.equal((await signInAdmin('wrong passphrase entirely', await totpNow(u.id))).status, 403);
  const step = auth.stepNow() + 1;
  const ok = await signInAdmin(PASSWORD, auth.totpAt(begin.body.secret, step));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('from a student session, a working authenticator cannot be replaced and a set password cannot be changed', async () => {
  const u = await theOwner();
  await auth.setPassword(u.id, PASSWORD, { email: EMAIL });
  const { secret } = await auth.beginAuthenticator(u.id, EMAIL);
  await auth.confirmAuthenticator(u.id, auth.totpAt(secret, auth.stepNow()));
  const c = client(app, await sessionFor(pool, u.id, { method: 'code' }));
  const again = await c.post('/auth/admin/credential/authenticator/begin');
  assert.equal(again.status, 403);
  assert.match(again.body.code, /admin_signin_required|reauth_required/);
  const pw = await c.post('/auth/admin/credential/password', { password: 'a brand new passphrase 42' });
  assert.notEqual(pw.status, 200, 'changing a password needs the current one and a code');
  assert.equal((await c.get('/auth/admin/credential')).body.authenticatorReady, true, 'MFA is untouched');
});

test('a student with no platform role cannot set administrator credentials', async () => {
  const s = await makeUser(pool, { phone: '+919000000302', name: 'Just Student' });
  await pool.query(`UPDATE app_user SET student_email = 'just.student@stu.upes.ac.in', student_email_verified_at = now() WHERE id = $1`, [s.id]);
  const c = client(app, await sessionFor(pool, s.id, { method: 'code' }));
  assert.equal((await c.post('/auth/admin/credential/password', { password: PASSWORD })).status, 403);
  assert.equal((await c.post('/auth/admin/credential/authenticator/begin')).status, 403);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM admin_credential`)).rows[0].n, 0);
});

/* ---------- "Forgot password?" by email code --------------------------------- */

async function enrolledOwner() {
  const u = await theOwner();
  await auth.setPassword(u.id, PASSWORD, { email: EMAIL });
  const { secret } = await auth.beginAuthenticator(u.id, EMAIL);
  await auth.confirmAuthenticator(u.id, auth.totpAt(secret, auth.stepNow() - 1));
  return { u, secret };
}

test('the full reset by email: one code mailed, never a password; sessions end; the authenticator stays', async () => {
  const { u, secret } = await enrolledOwner();
  const live = await sessionFor(pool, u.id, { method: 'admin_totp' });
  const r = await anon().post('/auth/admin/password-reset/request', { email: EMAIL.toUpperCase() });
  assert.equal(r.status, 200);
  assert.equal(mailbox.length, 1);
  const mail = mailbox[0];
  assert.deepEqual(mail.to, [EMAIL]);
  assert.ok(!mail.text.includes(PASSWORD) && !mail.html?.includes?.(PASSWORD), 'the password is never emailed');
  const code = codeMailedTo(EMAIL);
  assert.match(code, /^\d{6}$/);

  const v = await anon().post('/auth/admin/password-reset/verify', { email: EMAIL, code });
  assert.equal(v.status, 200);
  assert.equal(v.headers['set-cookie'], undefined, 'verifying the code opens no session');
  /* The same code cannot be used again. */
  assert.notEqual((await anon().post('/auth/admin/password-reset/verify', { email: EMAIL, code })).status, 200);

  const NEW = 'an entirely new passphrase 2026';
  const done = await anon().post('/auth/admin/password-reset/complete', { token: v.body.token, password: NEW });
  assert.equal(done.status, 200);
  assert.equal(done.headers['set-cookie'], undefined, 'a reset never signs anyone in');
  assert.equal((await client(app, live).get('/auth/me')).body.authenticated, false, 'every existing session ended');
  assert.equal((await auth.credentialStatus(u.id)).authenticatorReady, true, 'MFA is still on');
  assert.equal((await signInAdmin(NEW, '000000')).status, 403, 'the new password alone is not enough');
  assert.equal((await signInAdmin(NEW, auth.totpAt(secret, auth.stepNow() + 1))).status, 200);

  const log = (await pool.query(`SELECT action, detail::text AS d FROM audit_log WHERE action LIKE 'admin.password.reset%' ORDER BY at`)).rows;
  assert.deepEqual(log.map((l) => l.action), ['admin.password.reset.request', 'admin.password.reset.verify', 'admin.password.reset.complete']);
  const everything = JSON.stringify(log);
  for (const secretish of [code, NEW, PASSWORD, v.body.token]) assert.ok(!everything.includes(secretish), 'nothing secret in the audit log');
});

test('an expired reset code is refused', async () => {
  await enrolledOwner();
  await anon().post('/auth/admin/password-reset/request', { email: EMAIL });
  await pool.query(`UPDATE email_challenge SET expires_at = now() - interval '1 second' WHERE email = $1`, [EMAIL]);
  const v = await anon().post('/auth/admin/password-reset/verify', { email: EMAIL, code: codeMailedTo(EMAIL) });
  assert.equal(v.status, 400);
  assert.equal(v.body.token, undefined);
});

test('wrong guesses kill the code, and the right one is dead afterwards', async () => {
  await enrolledOwner();
  await anon().post('/auth/admin/password-reset/request', { email: EMAIL });
  const code = codeMailedTo(EMAIL);
  for (let k = 1; k <= 6; k++) {
    const wrong = String((Number(code) + k) % 1e6).padStart(6, '0');
    assert.notEqual((await anon().post('/auth/admin/password-reset/verify', { email: EMAIL, code: wrong })).status, 200);
  }
  assert.notEqual((await anon().post('/auth/admin/password-reset/verify', { email: EMAIL, code })).status, 200);
});

test('reset requests are rate-limited without revealing anything: one email, the same answer', async () => {
  await enrolledOwner();
  const answers = new Set();
  for (let k = 0; k < 4; k++) {
    const r = await anon().post('/auth/admin/password-reset/request', { email: EMAIL });
    answers.add(`${r.status}:${r.body.message}`);
  }
  assert.equal(answers.size, 1, 'every request gets the same answer');
  assert.equal(mailbox.length, 1, 'the resend cooldown sent exactly one email');
  /* A stranger and a plain student get the same answer, and no email. */
  const student = await makeUser(pool, { phone: '+919000000303', name: 'Plain Student' });
  await pool.query(`UPDATE app_user SET student_email = 'plain.student@stu.upes.ac.in', student_email_verified_at = now() WHERE id = $1`, [student.id]);
  for (const email of ['plain.student@stu.upes.ac.in', 'nobody.here@stu.upes.ac.in']) {
    const r = await anon().post('/auth/admin/password-reset/request', { email });
    answers.add(`${r.status}:${r.body.message}`);
  }
  assert.equal(answers.size, 1);
  assert.equal(mailbox.length, 1, 'no email to anybody who is not an administrator');
});
