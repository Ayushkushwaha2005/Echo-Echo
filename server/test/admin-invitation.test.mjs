/* ==========================================================================
   ADMINISTRATOR INVITATION - the whole lifecycle, on the real routes.

   This is the path the 31 Oct audit proved broken: invitation sent, setup
   finished, account stuck in 'invited', refused at sign-in. These tests walk
   the replacement end to end and then sign in with what it produced, and they
   check each way of skipping a step. Only the email provider's HTTP endpoint
   is a stand-in, a local stub that records what would be mailed.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';
import { cookieOf } from './helpers/webauthn.mjs';

let app, pool, auth, stub, stubStatus = 200;
const mailbox = [];
const PASSWORD = 'Correct-Horse-Battery-77!';

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      mailbox.push(JSON.parse(raw || '{}'));
      res.setHeader('content-type', 'application/json');
      res.statusCode = stubStatus;
      res.end(JSON.stringify(stubStatus === 200 ? { id: `m${mailbox.length}` } : { message: 'no' }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await startDb();
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    ADMIN_TOTP_KEY: 'test-admin-totp-key-0123456789abcdef',
    ADMIN_PASSKEY_REQUIRED: 'true',
    EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'ECHO ECHO <verify@echo.test>',
    RESEND_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
  });
  ({ pool } = await import('../src/db/index.js'));
  auth = await import('../src/services/admin-auth.js');
  app = await makeApp();
  process.env.ADMIN_PASSKEY_REQUIRED = 'true';
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); stub?.close(); });
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE email_send_log, admin_account, admin_invitation, admin_credential, audit_log CASCADE').catch(() => {});
  mailbox.length = 0;
  stubStatus = 200;
});

const anon = () => client(app);
const linkTokenIn = (email) => [...mailbox].reverse().find((m) => m.to?.[0] === email)?.text.match(/#invite=([\w-]+)/)?.[1];
const otpIn = (email) => [...mailbox].reverse().find((m) => m.to?.[0] === email)?.text.match(/is: (\d{6})/)?.[1];

async function owner() {
  const u = await makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['student', 'platform_owner'] });
  await pool.query(`UPDATE app_user SET student_email = 'owner.t@stu.upes.ac.in', student_email_verified_at = now() WHERE id = $1`, [u.id]);
  return { u, c: client(app, await sessionFor(pool, u.id, { method: 'admin_totp' })) };
}

async function invite(o, email, body = {}) {
  const r = await o.c.post('/admin/access/invitations', { name: 'New Hire', email, permissions: ['students.view'], ...body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { r, token: linkTokenIn(email), id: r.body.administrator.invitationId };
}

async function verifyMailbox(token, email) {
  assert.equal((await anon().post('/auth/invitation/email/send', { token })).status, 200);
  const v = await anon().post('/auth/invitation/email/verify', { token, code: otpIn(email) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.body;
}

async function finish(token, email) {
  const v = await verifyMailbox(token, email);
  const a = anon();
  assert.equal((await a.post('/auth/invitation/accept', { token, setup: v.setup })).status, 200);
  assert.equal((await a.post('/auth/invitation/password', { token, setup: v.setup, password: PASSWORD })).status, 200);
  const begin = await a.post('/auth/invitation/authenticator/begin', { token, setup: v.setup });
  assert.equal(begin.status, 200, JSON.stringify(begin.body));
  const code = auth.totpAt(begin.body.secret, auth.stepNow());
  const done = await a.post('/auth/invitation/complete', { token, setup: v.setup, code });
  return { v, begin, done, code };
}

/* Stage one then stage two, exactly as the sign-in screen does it. */
async function signIn(email, secret) {
  const a = anon();
  const p = await a.post('/auth/admin/login/password', { email, password: PASSWORD });
  if (p.status !== 200) return p;
  /* The step the invitation consumed cannot be replayed, so wait for no clock:
     clear the recorded step, which is what a later 30-second window would do. */
  await pool.query(`UPDATE admin_credential SET totp_last_step = NULL`);
  return a.post('/auth/admin/login', { challenge: p.body.challenge, code: auth.totpAt(secret, auth.stepNow()) });
}

test('a non-university employee goes from invitation to a working Campus Control sign-in', async () => {
  const o = await owner();
  const email = 'New.Hire@Gmail.com'.toLowerCase();
  const { token } = await invite(o, email, { permissions: ['students.view', 'orders.view'] });
  assert.ok(token, 'the email carries a link');
  assert.match(mailbox.at(-1).text, /\/admin\/#invite=/);
  assert.doesNotMatch(mailbox.at(-1).text, /passkey/i, 'the retired passkey route is gone from the email');

  /* Inviting granted nothing. */
  assert.equal((await pool.query(`SELECT count(*)::int n FROM app_user WHERE staff_email = $1`, [email])).rows[0].n, 0);

  /* Holding the link reveals only a masked address. */
  const opened = await anon().post('/auth/invitation/open', { token });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.email, 'n***@gmail.com');
  assert.equal(opened.body.permissions, undefined);

  const { v, begin, done } = await finish(token, email);
  assert.equal(v.invitedBy, 'Owner');
  assert.equal(v.email, email);
  assert.deepEqual(v.permissions.map((p) => p.key).sort(), ['orders.view', 'students.view']);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.activated, true);
  assert.equal(done.headers['set-cookie'], undefined, 'finishing opens no session');

  const acct = (await pool.query(
    `SELECT a.status, a.activated_at, a.permissions, u.student_email, u.staff_email FROM admin_account a JOIN app_user u ON u.id = a.user_id WHERE u.staff_email = $1`, [email])).rows[0];
  assert.equal(acct.status, 'active');
  assert.ok(acct.activated_at);
  assert.equal(acct.student_email, null, 'staff address is kept apart from student_email');
  assert.deepEqual([...acct.permissions].sort(), ['orders.view', 'students.view']);

  const inv = (await pool.query(`SELECT * FROM admin_invitation WHERE email = $1`, [email])).rows[0];
  assert.ok(inv.accepted_at);
  for (const k of ['password_hash', 'password_salt', 'totp_secret_enc', 'otp_hash', 'setup_hash']) assert.equal(inv[k], null, k);

  const audited = (await pool.query(`SELECT detail FROM audit_log WHERE action = 'admin.invite.complete'`)).rows;
  assert.equal(audited.length, 1);

  const s = await signIn(email, begin.body.secret);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.user.email, email);
  const session = client(app, cookieOf(s));
  const me = await session.get('/admin/access/me');
  assert.deepEqual([...me.body.permissions].sort(), ['orders.view', 'students.view']);
  assert.equal((await session.get('/admin/access/admins')).status, 403, 'holds only what was granted');
});

test('the link is single use, and a finished link cannot restart anything', async () => {
  const o = await owner();
  const email = 'once@example.org';
  const { token } = await invite(o, email);
  const { v } = await finish(token, email);
  for (const [path, body] of [
    ['/auth/invitation/open', { token }],
    ['/auth/invitation/email/send', { token }],
    ['/auth/invitation/complete', { token, setup: v.setup, code: '000000' }],
  ]) {
    assert.equal((await anon().post(path, body)).status, 410, path);
  }
});

test('an expired link is refused at every step, identically to an unknown one', async () => {
  const o = await owner();
  const email = 'late@example.org';
  const { token } = await invite(o, email);
  await pool.query(`UPDATE admin_invitation SET expires_at = now() - interval '1 second' WHERE email = $1`, [email]);
  const late = await anon().post('/auth/invitation/open', { token });
  const unknown = await anon().post('/auth/invitation/open', { token: 'x'.repeat(43) });
  assert.equal(late.status, 410);
  assert.equal(unknown.status, 410);
  assert.deepEqual(late.body, unknown.body);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM app_user WHERE staff_email = $1`, [email])).rows[0].n, 0);
});

test('invitations default to a 72-hour life and store only a hash of the token', async () => {
  const o = await owner();
  const email = 'ttl@example.org';
  const { token } = await invite(o, email);
  const row = (await pool.query(`SELECT token_hash, extract(epoch from expires_at - created_at)/3600 AS h FROM admin_invitation WHERE email = $1`, [email])).rows[0];
  assert.ok(Math.abs(Number(row.h) - 72) < 0.1);
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash.length, 64);
  const dump = JSON.stringify((await pool.query(`SELECT * FROM admin_invitation`)).rows) + JSON.stringify((await pool.query(`SELECT * FROM audit_log`)).rows);
  assert.ok(!dump.includes(token), 'the raw token is stored nowhere');
});

test('no step can be skipped, and possession of the link alone gets nowhere', async () => {
  const o = await owner();
  const email = 'skip@example.org';
  const { token } = await invite(o, email);

  /* No mailbox proof yet: nothing past it works, with or without a guessed ticket. */
  for (const [path, extra] of [['/auth/invitation/accept', {}], ['/auth/invitation/password', { password: PASSWORD }],
    ['/auth/invitation/authenticator/begin', {}], ['/auth/invitation/complete', { code: '123456' }]]) {
    assert.equal((await anon().post(path, { token, setup: 'guess', ...extra })).status, 403, path);
  }

  const v = await verifyMailbox(token, email);
  /* Email alone activates nothing. */
  assert.equal((await pool.query(`SELECT count(*)::int n FROM app_user WHERE staff_email = $1`, [email])).rows[0].n, 0);
  assert.equal((await anon().post('/auth/invitation/password', { token, setup: v.setup, password: PASSWORD })).status, 403, 'accept comes first');
  assert.equal((await anon().post('/auth/invitation/accept', { token, setup: v.setup })).status, 200);
  assert.equal((await anon().post('/auth/invitation/authenticator/begin', { token, setup: v.setup })).status, 403, 'password comes first');
  assert.equal((await anon().post('/auth/invitation/complete', { token, setup: v.setup, code: '123456' })).status, 403);
  assert.equal((await anon().post('/auth/invitation/password', { token, setup: v.setup, password: 'short' })).status, 400, 'password rules still apply');
  assert.equal((await anon().post('/auth/invitation/password', { token, setup: v.setup, password: PASSWORD })).status, 200);
  const begin = await anon().post('/auth/invitation/authenticator/begin', { token, setup: v.setup });
  const wrong = String((Number(auth.totpAt(begin.body.secret, auth.stepNow())) + 1) % 1000000).padStart(6, '0');
  assert.equal((await anon().post('/auth/invitation/complete', { token, setup: v.setup, code: wrong })).status, 400);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM app_user WHERE staff_email = $1`, [email])).rows[0].n, 0, 'a wrong code activates nothing');
  assert.equal((await pool.query(`SELECT accepted_at FROM admin_invitation WHERE email = $1`, [email])).rows[0].accepted_at, null);
});

test('the setup ticket is bound to its invitation: another invitation\'s ticket is refused', async () => {
  const o = await owner();
  const a = await invite(o, 'a@example.org');
  const b = await invite(o, 'b@example.org');
  const va = await verifyMailbox(a.token, 'a@example.org');
  assert.equal((await anon().post('/auth/invitation/accept', { token: b.token, setup: va.setup })).status, 403);
});

test('a wrong email code costs an attempt, committed, and the fifth ends that code', async () => {
  const o = await owner();
  const email = 'guess@example.org';
  const { token } = await invite(o, email);
  assert.equal((await anon().post('/auth/invitation/email/send', { token })).status, 200);
  const real = otpIn(email);
  const wrong = real === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await anon().post('/auth/invitation/email/verify', { token, code: wrong })).status, 400);
  assert.equal((await pool.query(`SELECT otp_attempts FROM admin_invitation WHERE email = $1`, [email])).rows[0].otp_attempts, 5);
  assert.equal((await anon().post('/auth/invitation/email/verify', { token, code: real })).status, 429, 'even the right code is now refused');
  assert.equal((await anon().post('/auth/invitation/email/verify', { token, code: real })).status, 400, 'that code is gone');
});

test('an email code expires, and codes are not reissued inside the cooldown', async () => {
  const o = await owner();
  const email = 'cool@example.org';
  const { token } = await invite(o, email);
  assert.equal((await anon().post('/auth/invitation/email/send', { token })).status, 200);
  assert.equal((await anon().post('/auth/invitation/email/send', { token })).status, 429);
  await pool.query(`UPDATE admin_invitation SET otp_expires_at = now() - interval '1 second' WHERE email = $1`, [email]);
  assert.equal((await anon().post('/auth/invitation/email/verify', { token, code: otpIn(email) })).status, 400);
});

test('a duplicate invitation is refused rather than silently replacing the live one', async () => {
  const o = await owner();
  const email = 'dup@example.org';
  const { token } = await invite(o, email);
  const again = await o.c.post('/admin/access/invitations', { name: 'New Hire', email, permissions: ['students.view'] });
  assert.equal(again.status, 409);
  assert.equal((await anon().post('/auth/invitation/open', { token })).status, 200, 'the first link still works');
});

test('an expired invitation can be replaced by inviting again', async () => {
  const o = await owner();
  const email = 'again@example.org';
  await invite(o, email);
  await pool.query(`UPDATE admin_invitation SET expires_at = now() - interval '1 minute' WHERE email = $1`, [email]);
  mailbox.length = 0;
  const second = await invite(o, email);
  assert.equal((await anon().post('/auth/invitation/open', { token: second.token })).status, 200);
});

test('resend kills the old link and discards progress; cancel kills the link', async () => {
  const o = await owner();
  const email = 'resend@example.org';
  const { token, id } = await invite(o, email);
  const v = await verifyMailbox(token, email);
  assert.equal((await anon().post('/auth/invitation/accept', { token, setup: v.setup })).status, 200);

  const soon = await o.c.post(`/admin/access/invitations/${id}/resend`);
  assert.equal(soon.status, 409, 'not inside the cooldown');
  await pool.query(`UPDATE admin_invitation SET last_sent_at = now() - interval '5 minutes' WHERE id = $1`, [id]);
  mailbox.length = 0;
  const r = await o.c.post(`/admin/access/invitations/${id}/resend`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fresh = linkTokenIn(email);
  assert.ok(fresh && fresh !== token);
  assert.equal((await anon().post('/auth/invitation/open', { token })).status, 410, 'old link dead');
  assert.equal((await anon().post('/auth/invitation/accept', { token: fresh, setup: v.setup })).status, 403, 'old ticket dead');
  assert.equal((await pool.query(`SELECT terms_accepted_at FROM admin_invitation WHERE id = $1`, [id])).rows[0].terms_accepted_at, null);

  assert.equal((await o.c.post(`/admin/access/invitations/${id}/revoke`)).status, 200);
  assert.equal((await anon().post('/auth/invitation/open', { token: fresh })).status, 410);
  assert.equal((await o.c.post(`/admin/access/invitations/${id}/revoke`)).status, 409);
  assert.equal((await o.c.post(`/admin/access/invitations/${id}/resend`)).status, 409, 'a cancelled invitation cannot be resent');
});

test('cancelling mid-setup erases whatever credential material was held', async () => {
  const o = await owner();
  const email = 'mid@example.org';
  const { token, id } = await invite(o, email);
  const v = await verifyMailbox(token, email);
  await anon().post('/auth/invitation/accept', { token, setup: v.setup });
  await anon().post('/auth/invitation/password', { token, setup: v.setup, password: PASSWORD });
  await anon().post('/auth/invitation/authenticator/begin', { token, setup: v.setup });
  assert.equal((await o.c.post(`/admin/access/invitations/${id}/revoke`)).status, 200);
  const row = (await pool.query(`SELECT password_hash, totp_secret_enc, setup_hash FROM admin_invitation WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(row, { password_hash: null, totp_secret_enc: null, setup_hash: null });
});

test('when email fails the owner gets the link once, and it still works', async () => {
  const o = await owner();
  stubStatus = 500;
  const r = await o.c.post('/admin/access/invitations', { name: 'New Hire', email: 'nomail@example.org', permissions: ['students.view'] });
  assert.equal(r.status, 200);
  assert.equal(r.body.emailed, false);
  assert.match(r.body.inviteLink, /#invite=/);
  stubStatus = 200;
  const token = r.body.inviteLink.split('#invite=')[1];
  assert.equal((await anon().post('/auth/invitation/open', { token })).status, 200);
  const dump = JSON.stringify((await pool.query(`SELECT detail FROM audit_log`)).rows);
  assert.ok(!dump.includes(token), 'the link is not in the audit log');
});

test('a person who already has a student account keeps it and gains administrator access', async () => {
  const o = await owner();
  const s = await makeUser(pool, { phone: '+919111111111', name: 'Student Staff', roles: ['student'] });
  const email = 'staff.student@stu.upes.ac.in';
  await pool.query(`UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`, [s.id, email]);
  const { token } = await invite(o, email);
  const { begin, done } = await finish(token, email);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await pool.query(`SELECT count(*)::int n FROM app_user WHERE student_email = $1 OR staff_email = $1`, [email])).rows[0].n, 1, 'no duplicate account');
  const roles = (await pool.query(`SELECT role FROM user_role WHERE user_id = $1 AND status = 'active'`, [s.id])).rows.map((r) => r.role).sort();
  assert.deepEqual(roles, ['platform_admin', 'student']);
  assert.equal((await signIn(email, begin.body.secret)).status, 200);
});

test('plain email sign-in no longer accepts an invitation or grants anything', async () => {
  const o = await owner();
  const email = 'plain@stu.upes.ac.in';
  await invite(o, email);
  mailbox.length = 0;
  assert.equal((await anon().post('/auth/email/send', { email })).status, 200);
  const code = [...mailbox].reverse().find((m) => m.to?.[0] === email)?.text.match(/code is: (\d{6})/)?.[1];
  const v = await anon().post('/auth/email/verify', { email, code });
  assert.equal(v.status, 200);
  const inv = (await pool.query(`SELECT accepted_at FROM admin_invitation WHERE email = $1`, [email])).rows[0];
  assert.equal(inv.accepted_at, null, 'audit proof: this used to be set');
  const roles = (await pool.query(`SELECT role FROM user_role r JOIN app_user u ON u.id = r.user_id WHERE u.student_email = $1`, [email])).rows.map((r) => r.role);
  assert.deepEqual(roles, ['student']);
  const session = client(app, cookieOf(v));
  assert.equal((await session.post('/auth/admin/credential/password', { password: PASSWORD })).status, 403, 'and it cannot enrol itself');
});

test('an account the old flow left stuck in invited is repaired by a new invitation, not forced', async () => {
  const o = await owner();
  const s = await makeUser(pool, { phone: '+919222222222', name: 'Stuck Person', roles: ['student', 'platform_admin'] });
  const email = 'stuck@stu.upes.ac.in';
  await pool.query(`UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`, [s.id, email]);
  await pool.query(`INSERT INTO admin_account (user_id, status, permissions, invited_by, invited_at) VALUES ($1,'invited',$2,$3, now())`, [s.id, ['students.view'], o.u.id]);

  /* Stuck: refused at sign-in, and still unable to enrol around the invitation. */
  assert.equal((await anon().post('/auth/admin/login/password', { email, password: PASSWORD })).status, 403);
  const old = client(app, await sessionFor(pool, s.id));
  assert.equal((await old.post('/auth/admin/credential/password', { password: PASSWORD })).status, 403);

  const r = await o.c.post(`/admin/access/admins/${s.id}/invite`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { begin, done } = await finish(linkTokenIn(email), email);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await pool.query(`SELECT status FROM admin_account WHERE user_id = $1`, [s.id])).rows[0].status, 'active');
  assert.equal((await signIn(email, begin.body.secret)).status, 200);
});

test('the invitation rechecks its grounds: a revoked owner, or a since-active account, cannot complete', async () => {
  const o = await owner();
  const email = 'recheck@example.org';
  const { token } = await invite(o, email);
  await pool.query(`UPDATE user_role SET status = 'revoked', revoked_at = now() WHERE user_id = $1 AND role = 'platform_owner'`, [o.u.id]);
  const { done } = await finish(token, email);
  assert.equal(done.status, 409);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM app_user WHERE staff_email = $1`, [email])).rows[0].n, 0);
});

test('only the owner can invite, resend or cancel; the platform owner\'s address cannot be invited', async () => {
  const o = await owner();
  const a = await makeUser(pool, { phone: '+919333333333', name: 'Admin', roles: ['platform_admin'] });
  const ac = client(app, await sessionFor(pool, a.id, { method: 'admin_totp' }));
  const { id } = await invite(o, 'target@example.org');
  assert.equal((await ac.post('/admin/access/invitations', { name: 'X Y', email: 'x@example.org', permissions: ['students.view'] })).status, 403);
  assert.equal((await ac.post(`/admin/access/invitations/${id}/resend`)).status, 403);
  assert.equal((await ac.post(`/admin/access/invitations/${id}/revoke`)).status, 403);
  assert.equal((await anon().post(`/admin/access/invitations/${id}/resend`)).status, 401);
  assert.equal((await o.c.post('/admin/access/invitations', { name: 'Own Self', email: 'owner.t@stu.upes.ac.in', permissions: ['students.view'] })).status, 409);
});

test('an owner-only permission cannot be granted through an invitation', async () => {
  const o = await owner();
  const r = await o.c.post('/admin/access/invitations', { name: 'Grabby', email: 'grab@example.org', permissions: ['admins.manage', 'made.up'] });
  assert.equal(r.status, 400);
});

test('if the activation audit cannot be written, nothing is activated', async () => {
  const o = await owner();
  const email = 'noaudit@example.org';
  const { token } = await invite(o, email);
  const v = await verifyMailbox(token, email);
  await anon().post('/auth/invitation/accept', { token, setup: v.setup });
  await anon().post('/auth/invitation/password', { token, setup: v.setup, password: PASSWORD });
  const begin = await anon().post('/auth/invitation/authenticator/begin', { token, setup: v.setup });
  await pool.query(`CREATE OR REPLACE FUNCTION fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER fail_audit_t BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'admin.invite.complete') EXECUTE FUNCTION fail_audit()`);
  try {
    const done = await anon().post('/auth/invitation/complete', { token, setup: v.setup, code: auth.totpAt(begin.body.secret, auth.stepNow()) });
    assert.equal(done.status, 500);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM app_user WHERE staff_email = $1`, [email])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT accepted_at FROM admin_invitation WHERE email = $1`, [email])).rows[0].accepted_at, null);
  } finally {
    await pool.query(`DROP TRIGGER fail_audit_t ON audit_log; DROP FUNCTION fail_audit()`);
  }
});

test('a staff administrator can reset a forgotten password by email', async () => {
  const o = await owner();
  const email = 'reset.me@example.org';
  const { token } = await invite(o, email);
  await finish(token, email);
  mailbox.length = 0;
  assert.equal((await anon().post('/auth/admin/password-reset/request', { email })).status, 200);
  const code = mailbox.at(-1)?.text.match(/(\d{6})/)?.[1];
  assert.ok(code, 'the code reached the staff mailbox');
  const v = await anon().post('/auth/admin/password-reset/verify', { email, code });
  assert.equal(v.status, 200, JSON.stringify(v.body));
});

/* The owner's student account can carry a nickname or a misspelling (in
   production it read "ayu Kushwahaa"). Every place an invitee or a colleague
   sees the inviter must use the Campus Control display name the inviter chose,
   and must not rewrite the account's own name to do it. */
test('the inviter is named by their Campus Control display name, never the raw account name', async () => {
  const o = await owner();
  await pool.query(`UPDATE app_user SET name = 'ayu Kushwahaa' WHERE id = $1`, [o.u.id]);
  assert.equal((await o.c.patch('/admin/me', { displayName: 'AYUSH' })).status, 200);

  const email = 'named.right@gmail.com';
  const { token } = await invite(o, email);
  const mail = mailbox.at(-1);
  assert.match(mail.text, /^AYUSH has invited you to Campus Control\./m);
  assert.doesNotMatch(JSON.stringify(mail), /ayu Kushwahaa/i);

  const list = (await o.c.get('/admin/access/invitations')).body.invitations;
  assert.equal(list.find((i) => i.email === email).invited_by_name, 'AYUSH');
  assert.doesNotMatch(JSON.stringify(list), /ayu Kushwahaa/i);

  const { v, done } = await finish(token, email);
  assert.equal(v.invitedBy, 'AYUSH', 'the invitation page names the display name');
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const admins = (await o.c.get('/admin/access/admins')).body;
  assert.doesNotMatch(JSON.stringify(admins), /ayu Kushwahaa/i, 'the administrators list says AYUSH as well');

  assert.equal((await pool.query(`SELECT name FROM app_user WHERE id = $1`, [o.u.id])).rows[0].name, 'ayu Kushwahaa',
    'the student account name itself is not rewritten');
});

test('without a display name the inviter falls back to the account name, as before', async () => {
  const o = await owner();
  await invite(o, 'fallback@gmail.com');
  assert.match(mailbox.at(-1).text, /^Owner has invited you to Campus Control\./m);
});
