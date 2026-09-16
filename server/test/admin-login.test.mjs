/* ==========================================================================
   ECHO ECHO — CAMPUS CONTROL SIGN-IN

   Email + password + a code from an authenticator app. These tests are the
   reason to believe the three factors are actually three: that a right
   password with a wrong code fails, that a right code with a wrong password
   fails, that a correct code cannot be used twice, and that none of it opens
   Campus Control for an account that is not an administrator.

   The TOTP codes here are computed with the same RFC 6238 routine the server
   uses, from the secret in the database. That is what an authenticator app
   on a phone does; there is no test-only code path being exercised.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser } from './helpers/db.mjs';
import { makeApp, client, sessionFor } from './helpers/api.mjs';

let pool, app, auth;
const anon = () => client(app, null);
/* Bound in before(), after the environment the services read is in place. */
let setPassword, beginAuthenticator, totpAt, stepNow, verifyTotp,
    credentialStatus, validatePassword, hashPassword;

test.before(async () => {
  await startDb();
  Object.assign(process.env, {
    ADMIN_TOTP_KEY: 'test-admin-totp-key-0123456789abcdef',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    ADMIN_PASSKEY_REQUIRED: 'true',
    /* Every test here signs in from 127.0.0.1, so the per-IP limit would be
       the thing that refused them rather than the credentials under test.
       The limit that actually protects an account - the per-account lock-out
       in services/admin-auth.js - is left at its real value and is exercised
       below. */
    RL_ADMIN_LOGIN: '100000',
    /* Pinned so the sign-in status test asserts against a known value
       rather than whatever the developer's .env happens to hold. */
    PLATFORM_OWNER_EMAIL: 'owner@stu.upes.ac.in',
  });
  ({ pool } = await import('../src/db/index.js'));
  auth = await import('../src/services/admin-auth.js');
  ({ setPassword, beginAuthenticator, totpAt, stepNow, verifyTotp,
     credentialStatus, validatePassword, hashPassword } = auth);
  app = await makeApp();
});
test.after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
test.beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE admin_credential, admin_account CASCADE');
});

const PASSWORD = 'correct horse battery staple';

/* An administrator with a password and an enrolled authenticator, exactly as
   `npm run admin:setup` leaves one. Returns the live six-digit code too. */
async function anAdministrator({ role = 'platform_admin', email = 'admin.1@stu.upes.ac.in' } = {}) {
  const u = await makeUser(pool, { phone: '+919000000001', name: 'Admin One', roles: [role] });
  await pool.query(`UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`, [u.id, email]);
  if (role !== 'platform_owner') {
    await pool.query(`INSERT INTO admin_account (user_id, status) VALUES ($1,'active')`, [u.id]);
  }
  await setPassword(u.id, PASSWORD, { email });
  const { secret } = await beginAuthenticator(u.id, email);
  return { user: u, email, secret, code: () => totpAt(secret, stepNow()) };
}

/* Sign in the way the screens do: password first, then the code.
   Stage one's response is returned unchanged when it refuses, so a test about
   a wrong password still reads the status it expects. A caller can drive
   either stage on its own with passwordStage()/codeStage() below. */
const passwordStage = (body) => anon().post('/auth/admin/login/password', body);
const codeStage = (body) => anon().post('/auth/admin/login', body);

async function login({ email, password, code } = {}) {
  const first = await passwordStage({ email, password });
  if (first.status !== 200) return first;
  return codeStage({ challenge: first.body.challenge, code });
}

/* ---------- the happy path ------------------------------------------------ */

test('an administrator signs in with email, password and a live authenticator code', async () => {
  const a = await anAdministrator();
  const r = await login({ email: a.email, password: PASSWORD, code: a.code() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.surface, 'admin', 'the server decides where they land');
  assert.ok(r.body.roles.includes('platform_admin'));
  assert.ok([].concat(r.headers['set-cookie'] || []).join(';').includes('quad_session='),
    'a session cookie must be set');
});

test('the session it opens can actually use administrator powers', async () => {
  const a = await anAdministrator();
  const r = await login({ email: a.email, password: PASSWORD, code: a.code() });
  const cookie = [].concat(r.headers['set-cookie'])[0].split(';')[0].split('=')[1];
  const me = await client(app, cookie).get('/auth/me');
  assert.equal(me.status, 200);
  assert.ok(me.body.roles.includes('platform_admin'),
    'the platform role must be usable, not withheld, from this session');
  assert.ok(me.body.permissions.length > 0);
});

test('a session opened with an email code cannot use administrator powers', async () => {
  const a = await anAdministrator();
  /* The same human, signed in the way they order lunch. */
  const token = await sessionFor(pool, a.user.id, { method: 'code' });
  const me = await client(app, token).get('/auth/me');
  assert.equal(me.status, 200);
  assert.ok(!me.body.roles.includes('platform_admin'),
    'the administrator role must be withheld from an ordinary session');
  assert.ok(me.body.passkey.withheldRoles.includes('platform_admin'));
});

/* ---------- each factor is really required -------------------------------- */

test('the right password with the wrong code does not sign in', async () => {
  const a = await anAdministrator();
  const r = await login({ email: a.email, password: PASSWORD, code: '000000' });
  assert.equal(r.status, 403);
  assert.equal(r.headers['set-cookie'], undefined);
});

test('the right code with the wrong password does not sign in', async () => {
  const a = await anAdministrator();
  const r = await login({ email: a.email, password: 'not the password at all', code: a.code() });
  assert.equal(r.status, 403);
  assert.equal(r.headers['set-cookie'], undefined);
});

test('no password and no code does not sign in', async () => {
  const a = await anAdministrator();
  for (const body of [{ email: a.email }, { email: a.email, password: PASSWORD },
                      { email: a.email, code: a.code() }, {}]) {
    const r = await login(body);
    assert.equal(r.status, 403, JSON.stringify(body));
  }
});

/* Two screens mean stage one necessarily reveals that a password was right:
   the code screen only appears when it was. That is the intended product
   behaviour. What must NOT leak is which ACCOUNTS exist, so every way of
   failing stage one has to answer identically. */
test('stage one never says whether the account exists, only that it was refused', async () => {
  const a = await anAdministrator();
  const student = await makeUser(pool, { phone: '+919000000077', name: 'Not An Admin' });
  await pool.query(
    `UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`,
    [student.id, 'student.only@stu.upes.ac.in']);

  const bad = [
    { email: a.email, password: 'wrong wrong wrong' },       // real admin, wrong password
    { email: 'nobody@stu.upes.ac.in', password: PASSWORD },  // no such account
    { email: 'student.only@stu.upes.ac.in', password: PASSWORD }, // exists, not an administrator
  ];
  const answers = new Set();
  for (const b of bad) {
    const r = await passwordStage(b);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.headers['set-cookie'], undefined, 'stage one never sets a cookie');
    assert.ok(!r.body.challenge, 'a refused password must not hand back a challenge');
    answers.add(`${r.status}:${r.body.error}:${r.body.message}`);
  }
  assert.equal(answers.size, 1,
    `every stage-one refusal must read identically, got: ${[...answers].join(' | ')}`);
});

/* ---------- replay and drift ---------------------------------------------- */

test('a correct code cannot be used a second time', async () => {
  const a = await anAdministrator();
  const code = a.code();
  assert.equal((await login({ email: a.email, password: PASSWORD, code })).status, 200);
  const again = await login({ email: a.email, password: PASSWORD, code });
  assert.equal(again.status, 403, 'the same six digits must not open a second session');
});

test('a code from five steps ago is far too old', async () => {
  const a = await anAdministrator();
  const stale = totpAt(a.secret, stepNow() - 5);
  assert.equal((await login({ email: a.email, password: PASSWORD, code: stale })).status, 403);
});

test('one step of clock drift either way is tolerated', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const now = stepNow();
  assert.equal(verifyTotp(secret, totpAt(secret, now - 1)), now - 1);
  assert.equal(verifyTotp(secret, totpAt(secret, now + 1)), now + 1);
  assert.equal(verifyTotp(secret, totpAt(secret, now - 3)), null);
});

test('the RFC 6238 reference vectors produce the published codes', () => {
  /* If this fails, Microsoft Authenticator will not agree with us either. */
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';   // ASCII "12345678901234567890"
  for (const [unix, expected] of [[59, '287082'], [1111111109, '081804'],
                                  [1111111111, '050471'], [1234567890, '005924'],
                                  [2000000000, '279037']]) {
    assert.equal(totpAt(secret, Math.floor(unix / 30)), expected, `at t=${unix}`);
  }
});

/* ---------- who may sign in here ------------------------------------------ */

test('a student cannot open Campus Control, whatever they type', async () => {
  const u = await makeUser(pool, { phone: '+919000000009', name: 'Student', roles: ['student'] });
  const email = 'student.9@stu.upes.ac.in';
  await pool.query(`UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`, [u.id, email]);
  /* Even if a password and authenticator somehow existed on the account. */
  await setPassword(u.id, PASSWORD, { email });
  const { secret } = await beginAuthenticator(u.id, email);
  const r = await login({ email, password: PASSWORD, code: totpAt(secret, stepNow()) });
  assert.equal(r.status, 403, 'holding no platform role means no administrator session');
  assert.equal(r.headers['set-cookie'], undefined);
});

test('a suspended administrator cannot sign in', async () => {
  const a = await anAdministrator();
  await pool.query(`UPDATE app_user SET status = 'suspended' WHERE id = $1`, [a.user.id]);
  assert.equal((await login({ email: a.email, password: PASSWORD, code: a.code() })).status, 403);
});

test('an administrator whose access was revoked cannot sign in', async () => {
  const a = await anAdministrator();
  await pool.query(`UPDATE admin_account SET status = 'revoked' WHERE user_id = $1`, [a.user.id]);
  assert.equal((await login({ email: a.email, password: PASSWORD, code: a.code() })).status, 403);
});

test('an account with no credentials set up cannot sign in', async () => {
  const u = await makeUser(pool, { phone: '+919000000021', name: 'Bare Admin', roles: ['platform_admin'] });
  await pool.query(`UPDATE app_user SET student_email = 'bare@stu.upes.ac.in',
                           student_email_verified_at = now() WHERE id = $1`, [u.id]);
  await pool.query(`INSERT INTO admin_account (user_id, status) VALUES ($1,'active')`, [u.id]);
  const r = await login({ email: 'bare@stu.upes.ac.in', password: PASSWORD, code: '123456' });
  assert.equal(r.status, 403);
});

/* ---------- throttling ----------------------------------------------------- */

test('repeated wrong attempts lock the account, and the lock survives a right answer', async () => {
  const a = await anAdministrator();
  for (let i = 0; i < 5; i++) {
    await login({ email: a.email, password: 'wrong password here', code: '000000' });
  }
  const r = await login({ email: a.email, password: PASSWORD, code: a.code() });
  assert.equal(r.status, 429, 'the correct credentials must not clear a lock-out');
  assert.match(r.body.error, /Too many failed sign-in attempts/);
  const row = await pool.query(`SELECT locked_until FROM admin_credential WHERE user_id = $1`, [a.user.id]);
  assert.ok(row.rows[0].locked_until, 'the lock is recorded against the account, not an IP');
});

/* ---------- what is stored ------------------------------------------------- */

test('the password is never stored in a recoverable form', async () => {
  const a = await anAdministrator();
  const { rows } = await pool.query(`SELECT * FROM admin_credential WHERE user_id = $1`, [a.user.id]);
  const row = rows[0];
  const blob = JSON.stringify(row);
  assert.ok(!blob.includes(PASSWORD), 'the password must not appear anywhere in the row');
  assert.equal(row.password_algo, 'scrypt');
  assert.ok(row.password_salt && row.password_salt.length >= 16);
});

test('the authenticator secret is encrypted at rest', async () => {
  const a = await anAdministrator();
  const { rows } = await pool.query(`SELECT totp_secret_enc FROM admin_credential WHERE user_id = $1`, [a.user.id]);
  assert.ok(!rows[0].totp_secret_enc.includes(a.secret),
    'the base32 secret must not be readable in the column');
  assert.match(rows[0].totp_secret_enc, /^v1\./);
});

test('no API hands back a password hash or an authenticator secret', async () => {
  const a = await anAdministrator();
  const r = await login({ email: a.email, password: PASSWORD, code: a.code() });
  const cookie = [].concat(r.headers['set-cookie'])[0].split(';')[0].split('=')[1];
  const c = client(app, cookie);
  for (const url of ['/auth/me', '/auth/admin/credential', '/admin/access/me']) {
    const res = await c.get(url);
    const body = JSON.stringify(res.body || {});
    for (const forbidden of ['password_hash', 'password_salt', 'totp_secret', a.secret, PASSWORD]) {
      assert.ok(!body.includes(forbidden), `${url} leaked ${forbidden}`);
    }
  }
});

test('the credential status says what is set up without saying what it is', async () => {
  const a = await anAdministrator();
  const s = await credentialStatus(a.user.id);
  assert.equal(s.passwordSet, true);
  assert.equal(s.authenticatorReady, false, 'not confirmed until a code is produced from it');
  await login({ email: a.email, password: PASSWORD, code: a.code() });
  assert.equal((await credentialStatus(a.user.id)).authenticatorReady, true,
    'the first correct code confirms the enrolment');
});

/* ---------- password rules -------------------------------------------------- */

test('a short, repeated or email-derived password is refused', () => {
  for (const bad of ['short', 'aaaaaaaaaaaaaaa', 'password1234', 'ayush.17551 is me']) {
    assert.throws(() => validatePassword(bad, { email: 'ayush.17551@stu.upes.ac.in' }),
      (e) => e.status === 400, `"${bad}" should be refused`);
  }
  assert.equal(validatePassword('a reasonable passphrase', { email: 'x@y.z' }), 'a reasonable passphrase');
});

test('the same password hashes differently every time', async () => {
  const a = await hashPassword(PASSWORD);
  const b = await hashPassword(PASSWORD);
  assert.notEqual(a.hash, b.hash, 'a per-password salt must be used');
  assert.notEqual(a.salt, b.salt);
});

/* ---------- the owner ------------------------------------------------------- */

test('the owner signs in the same way and lands on Campus Control', async () => {
  const a = await anAdministrator({ role: 'platform_owner', email: 'owner@stu.upes.ac.in' });
  const r = await login({ email: a.email, password: PASSWORD, code: a.code() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.roles.includes('platform_owner'));
  assert.equal(r.body.surface, 'admin');
});

test('the sign-in screen names the configured owner and nothing secret', async () => {
  const r = await anon().get('/auth/admin/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.method, 'password_totp');
  /* It names the method and the configured owner, and carries no material
     that could help anyone sign in. */
  assert.equal(r.body.ownerEmail, 'owner@stu.upes.ac.in',
    'the configured owner is named so an administrator can tell which deployment this is');
  const body = JSON.stringify(r.body);
  for (const forbidden of ['secret', 'hash', 'totp_secret', 'password_hash']) {
    assert.ok(!body.toLowerCase().includes(forbidden), `the status leaked "${forbidden}"`);
  }
});

/* ==========================================================================
   TWO-STAGE SIGN-IN

   The screens are email+password, then the authenticator code. The thing
   worth testing is not that there are two of them, but that having two does
   not make either factor optional.
   ========================================================================== */

test('the password stage opens no session and hands back only a challenge', async () => {
  const a = await anAdministrator();
  const r = await passwordStage({ email: a.email, password: PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.next, 'authenticator');
  assert.ok(r.body.challenge, 'stage two needs something to redeem');
  assert.equal(r.headers['set-cookie'], undefined,
    'a proven password alone must never open a session');

  /* The challenge is not a session: it cannot be used as one. */
  const me = await client(app, r.body.challenge).get('/auth/me');
  assert.notEqual(me.body.authenticated, true,
    'the challenge must not authenticate anything by itself');
});

test('a correct code with no challenge does not sign in', async () => {
  const a = await anAdministrator();
  const r = await codeStage({ code: a.code() });
  assert.equal(r.status, 403);
  assert.equal(r.headers['set-cookie'], undefined,
    'the authenticator alone must never open a session');
});

test('a correct code with a made-up challenge does not sign in', async () => {
  const a = await anAdministrator();
  const r = await codeStage({ challenge: 'not-a-real-challenge', code: a.code() });
  assert.equal(r.status, 403);
  assert.equal(r.headers['set-cookie'], undefined);
});

test('a challenge is single-use', async () => {
  const a = await anAdministrator();
  const first = await passwordStage({ email: a.email, password: PASSWORD });
  const ok = await codeStage({ challenge: first.body.challenge, code: a.code() });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  /* Replaying the whole exchange, code and all. */
  const again = await codeStage({ challenge: first.body.challenge, code: a.code() });
  assert.equal(again.status, 403, 'a spent challenge must not open a second session');
  assert.equal(again.headers['set-cookie'], undefined);
});

test('starting a new sign-in abandons the previous half-finished one', async () => {
  const a = await anAdministrator();
  const first = await passwordStage({ email: a.email, password: PASSWORD });
  const second = await passwordStage({ email: a.email, password: PASSWORD });
  assert.ok(second.body.challenge && second.body.challenge !== first.body.challenge);

  const stale = await codeStage({ challenge: first.body.challenge, code: a.code() });
  assert.equal(stale.status, 403, 'the older challenge must be dead');
});

test('a challenge cannot be ground for the authenticator code', async () => {
  const a = await anAdministrator();
  const { body } = await passwordStage({ email: a.email, password: PASSWORD });

  let refusedAtLast = false;
  for (let i = 0; i < 12; i += 1) {
    const r = await codeStage({ challenge: body.challenge, code: '000000' });
    assert.notEqual(r.status, 200);
    refusedAtLast = r.status === 403 || r.status === 429;
  }
  assert.ok(refusedAtLast);

  /* And the challenge is spent, so even the right code is now no good. */
  const real = await codeStage({ challenge: body.challenge, code: a.code() });
  assert.equal(real.status, 403, 'a challenge that ran out of attempts must be dead');
});

test('an account suspended between the two screens cannot complete sign-in', async () => {
  const a = await anAdministrator();
  const { body } = await passwordStage({ email: a.email, password: PASSWORD });
  await pool.query(`UPDATE app_user SET status = 'suspended' WHERE id = $1`, [a.user.id]);

  const r = await codeStage({ challenge: body.challenge, code: a.code() });
  assert.equal(r.status, 403, 'the account is re-checked at stage two, not trusted from stage one');
  assert.equal(r.headers['set-cookie'], undefined);
});

/* ==========================================================================
   PASSWORD RESET

   An emailed code proves the mailbox and buys a new password. It must never
   buy a session, and it must never stand in for the authenticator.
   ========================================================================== */

/* The reset routes are reachable without any session. */
const resetRequest = (email) => anon().post('/auth/admin/password-reset/request', { email });
const resetVerify = (email, code) => anon().post('/auth/admin/password-reset/verify', { email, code });
const resetComplete = (token, password) =>
  anon().post('/auth/admin/password-reset/complete', { token, password });

test('a reset request answers the same for an administrator, a student and a stranger', async () => {
  const a = await anAdministrator();
  const student = await makeUser(pool, { phone: '+919000000078', name: 'Student' });
  await pool.query(
    `UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`,
    [student.id, 'a.student@stu.upes.ac.in']);

  const answers = new Set();
  for (const email of [a.email, 'a.student@stu.upes.ac.in', 'nobody.at.all@stu.upes.ac.in']) {
    const r = await resetRequest(email);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    answers.add(`${r.status}:${r.body.message}`);
  }
  assert.equal(answers.size, 1,
    `a reset request must not reveal who has an account, got: ${[...answers].join(' | ')}`);
});

test('the reset never touches the authenticator, so both factors survive it', async () => {
  const a = await anAdministrator();
  const before = await auth.credentialStatus(a.user.id);
  assert.ok(before.passwordSet);

  /* Drive the reset the way the route does, past the email provider: the
     code itself is issued and checked by student-email.js, which is tested
     on its own. What matters here is what the token can and cannot buy. */
  const { token } = await auth.issuePasswordReset(a.user.id, { ip: '127.0.0.1' });
  const NEW = 'a-completely-different-passphrase-99';
  const done = await resetComplete(token, NEW);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.headers['set-cookie'], undefined,
    'a password reset must never open a session');
  assert.equal(done.body.next, 'sign_in');

  const after = await auth.credentialStatus(a.user.id);
  assert.ok(after.authenticatorReady === before.authenticatorReady,
    'the authenticator must be exactly as it was');

  /* The old password is dead, the new one works - and still only with a code. */
  assert.equal((await passwordStage({ email: a.email, password: PASSWORD })).status, 403);
  const stage1 = await passwordStage({ email: a.email, password: NEW });
  assert.equal(stage1.status, 200, JSON.stringify(stage1.body));
  assert.equal(stage1.headers['set-cookie'], undefined);

  const noCode = await codeStage({ challenge: stage1.body.challenge, code: '000000' });
  assert.equal(noCode.status, 403, 'TOTP is still required after a password reset');

  const withCode = await codeStage({ challenge: stage1.body.challenge, code: a.code() });
  assert.equal(withCode.status, 200, JSON.stringify(withCode.body));
});

test('a reset token is single-use and cannot be replayed', async () => {
  const a = await anAdministrator();
  const { token } = await auth.issuePasswordReset(a.user.id, {});
  assert.equal((await resetComplete(token, 'first-new-passphrase-123')).status, 200);
  const again = await resetComplete(token, 'second-new-passphrase-456');
  assert.notEqual(again.status, 200, 'a spent reset token must not set a second password');
});

test('asking for a new reset invalidates the previous one', async () => {
  const a = await anAdministrator();
  const first = await auth.issuePasswordReset(a.user.id, {});
  await auth.issuePasswordReset(a.user.id, {});
  const r = await resetComplete(first.token, 'another-new-passphrase-123');
  assert.notEqual(r.status, 200, 'only the most recent reset may be spent');
});

test('a made-up reset token sets nobody\'s password', async () => {
  await anAdministrator();
  const r = await resetComplete('not-a-real-token', 'some-new-passphrase-1234');
  assert.notEqual(r.status, 200);
});

test('a reset refuses a password too weak to be an administrator password', async () => {
  const a = await anAdministrator();
  const { token } = await auth.issuePasswordReset(a.user.id, {});
  const r = await resetComplete(token, 'short');
  assert.notEqual(r.status, 200);

  /* The token survives a rejected password: a weak first try must not force
     the whole email round trip again. */
  assert.equal((await resetComplete(token, 'a-properly-long-passphrase-77')).status, 200);
});

test('a completed reset signs out every existing session for that account', async () => {
  const a = await anAdministrator();
  const live = await sessionFor(pool, a.user.id, { method: 'admin_totp' });
  /* /auth/me is public and answers 200 either way, so the thing to read is
     whether it still recognises anyone. */
  assert.equal((await client(app, live).get('/auth/me')).body.authenticated, true);

  const { token } = await auth.issuePasswordReset(a.user.id, {});
  assert.equal((await resetComplete(token, 'yet-another-passphrase-4242')).status, 200);

  const after = await client(app, live).get('/auth/me');
  assert.notEqual(after.body.authenticated, true, 'sessions opened with the old password must end');
});
