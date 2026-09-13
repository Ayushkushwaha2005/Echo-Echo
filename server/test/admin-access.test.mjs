/* ==========================================================================
   GRANULAR ADMINISTRATOR ACCESS - end to end.

   Real routes, real sessions, real WebAuthn verification (software
   authenticator), real email-code sign-in. The only stand-in is the email
   provider's HTTP endpoint, a local stub that records what would be mailed.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';
import { authenticator, cookieOf } from './helpers/webauthn.mjs';

let app, pool, creds, cfg, stub, stubStatus = 200;
const mailbox = [];

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      mailbox.push(JSON.parse(raw || '{}'));
      res.setHeader('content-type', 'application/json');
      if (stubStatus !== 200) {
        res.statusCode = stubStatus;
        return res.end(JSON.stringify({ name: 'daily_quota_exceeded', message: `quota; body was ${raw}` }));
      }
      res.end(JSON.stringify({ id: `msg-${mailbox.length}` }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await startDb();
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    ADMIN_PASSKEY_REQUIRED: 'true',
    EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'ECHO ECHO <verify@echo.test>',
    RESEND_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
  });
  ({ pool } = await import('../src/db/index.js'));
  creds = await import('../src/services/admin-credentials.js');
  cfg = await import('../src/config.js');
  app = await makeApp();
  process.env.ADMIN_PASSKEY_REQUIRED = 'true';
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); stub?.close(); delete process.env.ADMIN_PASSKEY_REQUIRED; });
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE email_send_log, admin_account');
  mailbox.length = 0; stubStatus = 200;
  cfg.NOTIFY.email.dailyBudget = 95; cfg.NOTIFY.email.monthlyBudget = 2900; cfg.NOTIFY.email.reserveForAdmin = 5;
});

const anon = () => client(app);
let seq = 0;

async function registerWith(c, code, auth = authenticator()) {
  const opts = await c.post('/auth/passkey/register/options', { inviteCode: code });
  if (opts.status !== 200) return { opts };
  const reg = await c.post('/auth/passkey/register/verify', { inviteCode: code, label: 'Laptop', credential: auth.create(opts.body.challenge) });
  return { opts, reg, auth };
}

async function passkeyLogin(auth) {
  const a = anon();
  const opts = await a.post('/auth/passkey/login/options');
  return a.post('/auth/passkey/login/verify', { credential: auth.get(opts.body.challenge) });
}

/* The owner, signed in with a passkey. */
async function owner() {
  const u = await makeUser(pool, { phone: '+919000000000', name: 'Ayush', roles: ['student', 'platform_owner'] });
  await pool.query(`UPDATE app_user SET student_email = 'ayush.17551@stu.upes.ac.in', student_email_verified_at = now() WHERE id = $1`, [u.id]);
  const c = client(app, await sessionFor(pool, u.id));
  const { code } = await creds.issueInvite(u.id);
  const { reg, auth } = await registerWith(c, code);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  return { u, c, auth };
}

const inviteCodeIn = (email) => [...mailbox].reverse().find((m) => m.to?.[0] === email)?.text.match(/invitation code: ([A-Z0-9-]+)/)?.[1];
const loginCodeIn = (email) => [...mailbox].reverse().find((m) => m.to?.[0] === email)?.text.match(/code is: (\d{6})/)?.[1];

async function emailSignIn(email) {
  /* Step past the resend cooldown for a repeat sign-in in the same test. */
  await pool.query(`UPDATE email_challenge SET created_at = created_at - interval '5 minutes' WHERE email = $1`, [email]);
  assert.equal((await anon().post('/auth/email/send', { email })).status, 200);
  const r = await anon().post('/auth/email/verify', { email, code: loginCodeIn(email) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return client(app, cookieOf(r));
}

/* Owner invites; the invitee signs in with their mailbox and registers a passkey. */
async function invitedAdmin(o, permissions, name = 'Second Admin') {
  const email = `admin.${++seq}${Date.now() % 1000}@stu.upes.ac.in`;
  const inv = await o.c.post('/admin/access/invitations', { name, email, permissions });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const code = inviteCodeIn(email);
  const c = await emailSignIn(email);
  mailbox.length = 0;
  const { reg, auth } = await registerWith(c, code);
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const id = (await c.get('/auth/me')).body.user.id;
  return { id, email, c, auth, code };
}

/* ======================================================================== */

test('invitation: emailed one-time code, invited account holds nothing until its passkey is registered', async () => {
  const o = await owner();
  const email = 'anushka.test@stu.upes.ac.in';
  const inv = await o.c.post('/admin/access/invitations', { name: 'Anushka', email: ' Anushka.Test@STU.UPES.AC.IN ', permissions: ['students.view', 'orders.view'] });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  assert.equal(inv.body.emailed, true);
  assert.equal(inv.body.inviteCode, undefined, 'an emailed code is never also shown to the owner');
  const code = inviteCodeIn(email);
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const logged = await pool.query(`SELECT detail::text FROM audit_log WHERE action = 'admin.invite'`);
  assert.ok(!logged.rows[0].detail.includes(code), 'the invite code is not in the audit log');

  assert.equal(inv.body.administrator.id, null, 'no account is created for an unproven mailbox');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM app_user WHERE student_email = $1`, [email])).rows[0].n, 0);
  const c = await emailSignIn(email);
  const me = (await c.get('/auth/me')).body;
  inv.body.administrator.id = me.user.id;
  assert.deepEqual(me.roles, ['student']);
  assert.deepEqual(me.passkey.withheldRoles, ['platform_admin']);
  assert.equal((await c.get('/admin/users')).status, 403);

  assert.equal((await registerWith(c, 'AAAA-BBBB-CCCC')).opts.status, 400, 'wrong code');
  const { reg } = await registerWith(c, code);
  assert.equal(reg.status, 200);
  assert.equal(reg.body.recoveryCodes.length, 10);
  assert.equal((await pool.query(`SELECT status FROM admin_account WHERE user_id = $1`, [inv.body.administrator.id])).rows[0].status, 'active');

  const me2 = (await c.get('/auth/me')).body;
  assert.deepEqual(me2.permissions.sort(), ['orders.view', 'students.view']);
  assert.equal((await c.get('/admin/users')).status, 200, 'granted');
  const denied = await c.get('/admin/audit');
  assert.equal(denied.status, 403, 'not granted');
  assert.equal(denied.body.code, 'permission_required');
  assert.equal((await c.get('/admin/partners')).status, 403);
  assert.equal((await c.put('/admin/flags/delivery', { enabled: false })).status, 403);

  /* Single use: the code cannot open a second registration. */
  const other = client(app, await sessionFor(pool, inv.body.administrator.id));
  assert.notEqual((await registerWith(other, code)).opts.status, 200);
});

test('expired invitation is refused', async () => {
  const o = await owner();
  const email = 'late.admin@stu.upes.ac.in';
  await o.c.post('/admin/access/invitations', { name: 'Late', email, permissions: ['students.view'] });
  const code = inviteCodeIn(email);
  await pool.query(`UPDATE admin_invitation SET expires_at = now() - interval '1 minute'`);
  const c = await emailSignIn(email);
  const me = (await c.get('/auth/me')).body;
  assert.deepEqual(me.passkey.withheldRoles, [], 'an expired invitation grants no role at all');
  assert.notEqual((await registerWith(c, code)).opts.status, 200);

  /* Expiry after acceptance, before the passkey ceremony, is refused too. */
  const email2 = 'late.admin2@stu.upes.ac.in';
  await o.c.post('/admin/access/invitations', { name: 'Late Two', email: email2, permissions: ['students.view'] });
  const code2 = inviteCodeIn(email2);
  const c2 = await emailSignIn(email2);
  await pool.query(`UPDATE admin_passkey_invite SET expires_at = now() - interval '1 minute'`);
  assert.equal((await registerWith(c2, code2)).opts.status, 400);
});

test('when email cannot be sent the owner sees the code once; provider errors never reach the client', async () => {
  const o = await owner();
  stubStatus = 429;
  const inv = await o.c.post('/admin/access/invitations', { name: 'No Mail', email: 'nomail.1@stu.upes.ac.in', permissions: ['students.view'] });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.emailed, false);
  assert.match(inv.body.inviteCode, /^[A-Z0-9-]{14}$/);
  const r = await anon().post('/auth/email/send', { email: 'quota.student@stu.upes.ac.in' });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'email_unavailable');
  assert.ok(!JSON.stringify(r.body).includes('quota;'), 'provider body not exposed');
  assert.ok(!JSON.stringify(r.body).match(/resend/i));
});

test('free-tier budget: student codes stop below the quota, admin invitations keep reserved headroom', async () => {
  const o = await owner();
  cfg.NOTIFY.email.dailyBudget = 4; cfg.NOTIFY.email.reserveForAdmin = 2;
  assert.equal((await anon().post('/auth/email/send', { email: 'b.1@stu.upes.ac.in' })).status, 200);
  assert.equal((await anon().post('/auth/email/send', { email: 'b.2@stu.upes.ac.in' })).status, 200);
  const refused = await anon().post('/auth/email/send', { email: 'b.3@stu.upes.ac.in' });
  assert.equal(refused.status, 503);
  assert.equal(mailbox.length, 2, 'the refused code was never sent to the provider');
  const inv = await o.c.post('/admin/access/invitations', { name: 'Reserve', email: 'reserve.1@stu.upes.ac.in', permissions: ['students.view'] });
  assert.equal(inv.body.emailed, true, 'administrator invite used the reserve');
  const log = (await pool.query(`SELECT outcome, count(*)::int n FROM email_send_log GROUP BY outcome ORDER BY outcome`)).rows;
  assert.deepEqual(log, [{ outcome: 'refused_budget', n: 1 }, { outcome: 'sent', n: 3 }]);
});

test('permission changes apply to an already-open session immediately', async () => {
  const o = await owner();
  const a = await invitedAdmin(o, ['students.view']);
  assert.equal((await a.c.get('/admin/users')).status, 200);
  assert.equal((await a.c.get('/admin/audit')).status, 403);

  assert.equal((await o.c.put(`/admin/access/admins/${a.id}/permissions`, { permissions: ['audit.view'] })).status, 400, 'reason required');
  const ch = await o.c.put(`/admin/access/admins/${a.id}/permissions`, { permissions: ['audit.view'], reason: 'moved to audit duty' });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.deepEqual(ch.body.added, ['audit.view']);
  assert.deepEqual(ch.body.removed, ['students.view']);
  assert.equal((await a.c.get('/admin/users')).status, 403, 'removed permission gone on the same session');
  assert.equal((await a.c.get('/admin/audit')).status, 200);

  const bad = await o.c.put(`/admin/access/admins/${a.id}/permissions`, { permissions: ['security.manage'], reason: 'attempt owner-only' });
  assert.equal(bad.status, 400, 'owner-only permissions are never grantable');
  const unknown = await o.c.put(`/admin/access/admins/${a.id}/permissions`, { permissions: ['everything'], reason: 'unknown key' });
  assert.equal(unknown.status, 400);
  const audit = (await pool.query(`SELECT detail FROM audit_log WHERE action = 'admin.permissions.update'`)).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail.reason, 'moved to audit duty');
});

test('suspension ends sessions and blocks passkey sign-in; restore brings access back', async () => {
  const o = await owner();
  const a = await invitedAdmin(o, ['students.view']);
  const s = await o.c.post(`/admin/access/admins/${a.id}/suspend`, { reason: 'lost laptop, investigating' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((await a.c.get('/admin/users')).status, 401, 'old session is dead');
  assert.equal((await passkeyLogin(a.auth)).status, 403, 'passkey cannot open Campus Control');
  /* Even a session that somehow survived would carry no platform role. */
  const leftover = client(app, await sessionFor(pool, a.id));
  await pool.query(`UPDATE session SET auth_method = 'passkey', passkey_verified_at = now() WHERE user_id = $1`, [a.id]);
  assert.equal((await leftover.get('/admin/users')).status, 403);

  const r = await o.c.post(`/admin/access/admins/${a.id}/restore`, { reason: 'laptop recovered' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'active');
  const back = await passkeyLogin(a.auth);
  assert.equal(back.status, 200);
  assert.equal((await client(app, cookieOf(back)).get('/admin/users')).status, 200);
});

test('revocation removes roles, passkeys, recovery codes and sessions; the student account survives', async () => {
  const o = await owner();
  const a = await invitedAdmin(o, ['students.view', 'orders.view']);
  const rv = await o.c.post(`/admin/access/admins/${a.id}/revoke`, { reason: 'left the team' });
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  assert.equal(rv.body.passkeys, 1);
  assert.equal((await a.c.get('/admin/users')).status, 401);
  assert.notEqual((await passkeyLogin(a.auth)).status, 200);
  const fresh = await emailSignIn(a.email);
  const me = (await fresh.get('/auth/me')).body;
  assert.deepEqual(me.roles, ['student']);
  assert.deepEqual(me.passkey.withheldRoles, []);
  assert.equal((await registerWith(fresh, a.code)).opts.status, 403, 'old invite cannot be reused after revocation');

  const restored = await o.c.post(`/admin/access/admins/${a.id}/restore`, { reason: 'rejoined' });
  assert.equal(restored.body.status, 'invited', 'needs a new passkey invitation');
  const again = await o.c.post(`/admin/access/admins/${a.id}/invite`);
  assert.equal(again.status, 200);
  const { reg } = await registerWith(fresh, inviteCodeIn(a.email));
  assert.equal(reg.status, 200);
  assert.equal((await fresh.get('/admin/users')).status, 200);
});

test('owner-only powers: a fully-permissioned admin cannot invite, change permissions, revoke, restore or touch the owner', async () => {
  const o = await owner();
  const catalog = (await o.c.get('/admin/access/catalog')).body;
  const everything = catalog.groups.flatMap((g) => g.permissions).filter((p) => !p.ownerOnly).map((p) => p.key);
  const boss = await invitedAdmin(o, everything, 'Full Admin');
  const victim = await invitedAdmin(o, ['students.view'], 'Victim');

  assert.equal((await boss.c.post('/admin/access/invitations', { name: 'X', email: 'x.1@stu.upes.ac.in', permissions: ['students.view'] })).status, 403);
  assert.equal((await boss.c.put(`/admin/access/admins/${victim.id}/permissions`, { permissions: everything, reason: 'escalate' })).status, 403);
  assert.equal((await boss.c.put(`/admin/access/admins/${boss.id}/permissions`, { permissions: everything, reason: 'self' })).status, 403);
  assert.equal((await boss.c.post(`/admin/access/admins/${victim.id}/revoke`, { reason: 'nope nope' })).status, 403);
  assert.equal((await boss.c.post(`/admin/access/admins/${victim.id}/restore`, { reason: 'nope nope' })).status, 403);
  assert.equal((await boss.c.post(`/admin/access/admins/${o.u.id}/suspend`, { reason: 'coup attempt' })).status, 403, 'owner');
  assert.equal((await boss.c.post(`/admin/access/admins/${o.u.id}/sessions/revoke`, { reason: 'coup attempt' })).status, 403, 'owner sessions');
  assert.equal((await boss.c.post(`/admin/access/admins/${boss.id}/suspend`, { reason: 'self' })).status, 403, 'self');
  assert.equal((await boss.c.post(`/admin/users/${o.u.id}/status`, { status: 'suspended' })).status, 403);
  assert.equal((await boss.c.post('/admin/users/role', { phone: '9811100001', role: 'platform_admin' })).status, 403);
  assert.equal((await boss.c.post('/admin/passkey-invites', { userId: victim.id })).status, 403);
  const credId = (await pool.query(`SELECT id FROM webauthn_credential WHERE user_id = $1`, [o.u.id])).rows[0].id;
  assert.equal((await boss.c.post(`/auth/passkey/credentials/${credId}/revoke`)).status, 403, 'owner passkey');

  /* Student-level powers cannot be turned on a colleague. */
  assert.equal((await boss.c.post(`/admin/users/${victim.id}/enrolment`)).status, 403, 'no sign-in code into an admin account');

  /* The containment powers it does hold work on a peer. */
  assert.equal((await boss.c.post(`/admin/access/admins/${victim.id}/sessions/revoke`, { reason: 'suspicious session' })).status, 200);
  assert.equal((await victim.c.get('/admin/users')).status, 401);
  assert.equal((await boss.c.post(`/admin/access/admins/${victim.id}/suspend`, { reason: 'containment' })).status, 200);
  assert.equal((await o.c.get('/auth/me')).body.isOwner, true, 'owner untouched');
});

test('an admin holding only students.suspend cannot suspend another administrator', async () => {
  const o = await owner();
  const narrow = await invitedAdmin(o, ['students.view', 'students.suspend']);
  const peer = await invitedAdmin(o, ['orders.view'], 'Peer');
  const r = await narrow.c.post(`/admin/users/${peer.id}/status`, { status: 'suspended', reason: 'misuse attempt' });
  assert.equal(r.status, 403);
  assert.equal((await pool.query(`SELECT status FROM app_user WHERE id = $1`, [peer.id])).rows[0].status, 'active');
  assert.equal((await narrow.c.post(`/admin/users/${peer.id}/status`, { status: 'active' })).status, 403, 'reinstate is its own permission');
});

test('sensitive owner actions require a fresh passkey confirmation', async () => {
  const o = await owner();
  const a = await invitedAdmin(o, ['students.view']);
  await pool.query(`UPDATE session SET passkey_verified_at = now() - interval '30 minutes' WHERE user_id = $1`, [o.u.id]);
  const r = await o.c.post(`/admin/access/admins/${a.id}/revoke`, { reason: 'stale session test' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'reauth_required');
  assert.equal((await o.c.get('/admin/access/admins')).status, 200, 'reading does not');
});

test('administrator list shows status, permissions, last sign-in, sessions and activity - never secrets', async () => {
  const o = await owner();
  const a = await invitedAdmin(o, ['students.view']);
  await a.c.get('/admin/users');
  const list = await o.c.get('/admin/access/admins');
  assert.equal(list.status, 200);
  const row = list.body.administrators.find((x) => x.id === a.id);
  assert.equal(row.status, 'active');
  assert.deepEqual(row.effective.permissions, ['students.view']);
  assert.ok(row.passkeys === 1 && row.active_sessions >= 1);
  assert.ok(list.body.administrators.find((x) => x.isOwner));
  const detail = await o.c.get(`/admin/access/admins/${a.id}`);
  assert.equal(detail.status, 200);
  const blob = JSON.stringify(detail.body);
  for (const secret of ['token_hash', 'code_hash', 'public_key_jwk', 'salt']) assert.ok(!blob.includes(secret), secret);
  assert.ok(detail.body.history.some((h) => h.action === 'admin.invite'));
  /* An admin without admins.view sees nothing. */
  assert.equal((await a.c.get('/admin/access/admins')).status, 403);
  assert.equal((await a.c.get('/admin/administrators')).status, 403);
});

test('granular finance/deposit/boundary/incident permissions are enforced route by route', async () => {
  const o = await owner();
  const a = await invitedAdmin(o, ['deposits.view', 'deposits.propose_deduction', 'boundary.view', 'delivery.incidents']);
  assert.equal((await a.c.get('/admin/deductions')).status, 200);
  assert.equal((await a.c.post('/admin/deductions/00000000-0000-0000-0000-000000000000/apply')).body.code, 'permission_required');
  assert.equal((await a.c.post('/admin/deposit-refunds/00000000-0000-0000-0000-000000000000/pay', {})).body.code, 'permission_required');
  assert.equal((await a.c.post('/admin/boundaries/00000000-0000-0000-0000-000000000000/activate', {})).body.code, 'permission_required');
  assert.equal((await a.c.get('/admin/incidents')).status, 200);
  assert.equal((await a.c.post('/admin/incidents/00000000-0000-0000-0000-000000000000/resolve', {})).body.code, 'permission_required');
  assert.equal((await a.c.get('/admin/finance/summary')).status, 403);
  assert.equal((await a.c.get('/admin/users')).status, 403);
});

test('the audit log is append-only in the database', async () => {
  await owner();
  await assert.rejects(() => pool.query(`UPDATE audit_log SET outcome = 'ok'`), /append-only/);
  await assert.rejects(() => pool.query(`DELETE FROM audit_log`), /append-only/);
});
