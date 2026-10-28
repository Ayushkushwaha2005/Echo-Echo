/* ==========================================================================
   MY PROFILE, AUTHENTICATOR REPLACEMENT, AND WHAT STAFF CAN NEVER DO
   (routes/admin-profile.js, admin-signin.js, admin-access.js, admin.js)

   * My Profile acts on the caller only: display name, photo, own sessions,
     own security activity. It never changes the login email, the owner role
     or a permission, and the student session of the same person cannot use it.
   * Replacing a working authenticator keeps the old one signing in until a
     code from the new one is confirmed; then the old one stops, the other
     sessions end, and the change is audited without the secret.
   * A staff administrator holding every grantable permission still cannot
     change the owner, their own access, the owner's credentials or sessions,
     or grant a platform role.
   * A platform role granted with an explicit permission list holds exactly
     that list.
   Synthetic accounts only.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { startDb, stopDb, truncateAll, makeUser } from './helpers/db.mjs';
import { makeApp, client, sessionFor } from './helpers/api.mjs';

let app, pool, auth, perms;
const OWNER_EMAIL = 'owner.profile@stu.upes.ac.in';
const PASSWORD = 'correct horse battery staple';
let nth = 0;
const phone = () => `+9196600${String(10000 + nth++).slice(-5)}`;

before(async () => {
  await startDb();
  Object.assign(process.env, {
    ADMIN_TOTP_KEY: 'test-admin-totp-key-0123456789abcdef',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    ADMIN_PASSKEY_REQUIRED: 'true', PLATFORM_OWNER_EMAIL: OWNER_EMAIL, RL_ADMIN_LOGIN: '100000',
  });
  ({ pool } = await import('../src/db/index.js'));
  auth = await import('../src/services/admin-auth.js');
  perms = await import('../src/auth/permissions.js');
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE admin_credential, admin_account, admin_profile CASCADE');
});

async function person({ email, name, roles, permissions }) {
  const u = await makeUser(pool, { phone: phone(), name, roles });
  await pool.query(`UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`, [u.id, email]);
  if (permissions) {
    await pool.query(`INSERT INTO admin_account (user_id, status, permissions, activated_at) VALUES ($1,'active',$2,now())`, [u.id, permissions]);
  }
  await auth.setPassword(u.id, PASSWORD, { email });
  const { secret } = await auth.beginAuthenticator(u.id, email);
  await auth.confirmAuthenticator(u.id, auth.totpAt(secret, auth.stepNow() - 1));
  return { ...u, email, secret };
}
const owner = () => person({ email: OWNER_EMAIL, name: 'ayu Kushwahaa', roles: ['student', 'platform_owner'] });
const staff = () => person({ email: 'staff.full@stu.upes.ac.in', name: 'Staff Full', roles: ['platform_admin'],
                              permissions: perms.GRANTABLE_KEYS });
const as = async (u, method = 'admin_totp') => client(app, await sessionFor(pool, u.id, { method }));

/* A real PNG of any size, so the photo rules are tested on real bytes. */
function png(w, h) {
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x7f); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function upload(token, buf, url = '/admin/me/photo', kind = null) {
  const b = '----profile' + Date.now() + Math.random();
  const parts = [kind ? Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`) : Buffer.alloc(0),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`),
    buf, Buffer.from(`\r\n--${b}--\r\n`)];
  return app.inject({ method: 'POST', url, payload: Buffer.concat(parts),
    headers: { origin: 'http://localhost:3000', cookie: `quad_session=${token}`, 'content-type': `multipart/form-data; boundary=${b}` } });
}

/* ---------- display name ----------------------------------------------------- */

test('the display name is mine to set, appears everywhere admins see me, and changes nothing else', async () => {
  const o = await owner();
  const c = await as(o);
  assert.equal((await c.get('/admin/me')).body.profile.displayName, 'ayu Kushwahaa', 'starts from the account name');
  for (const bad of ['A', 'x'.repeat(41), '<script>', 'Ayussh 1']) {
    assert.equal((await c.patch('/admin/me', { displayName: bad })).status, 400, bad);
  }
  assert.equal((await c.patch('/admin/me', { displayName: '  Ayussh ' })).status, 200);
  const me = (await c.get('/admin/me')).body.profile;
  assert.equal(me.displayName, 'Ayussh');
  assert.equal(me.email, OWNER_EMAIL);
  assert.ok(me.isOwner);
  assert.equal((await c.get('/auth/me')).body.adminProfile.displayName, 'Ayussh', 'the one source the admin screens read');
  const list = (await c.get('/admin/access/admins')).body.administrators;
  assert.equal(list.find((a) => a.id === o.id).name, 'Ayussh');
  const row = (await pool.query(`SELECT name, student_email FROM app_user WHERE id = $1`, [o.id])).rows[0];
  assert.deepEqual(row, { name: 'ayu Kushwahaa', student_email: OWNER_EMAIL }, 'the student account and login email are untouched');
  const roles = (await pool.query(`SELECT role FROM user_role WHERE user_id = $1 AND status = 'active' ORDER BY role`, [o.id])).rows.map((r) => r.role);
  assert.deepEqual(roles, ['platform_owner', 'student']);
});

test('the student session of the same person cannot open My Profile', async () => {
  const o = await owner();
  const s = await as(o, 'code');
  assert.equal((await s.get('/admin/me')).status, 403);
  assert.equal((await s.patch('/admin/me', { displayName: 'Someone' })).status, 403);
  assert.equal((await client(app, null).get('/admin/me')).status, 401);
});

/* ---------- photo ----------------------------------------------------------- */

test('a profile photo is validated, stored, replaced, removed, and shown only to administrators', async () => {
  const o = await owner();
  const st = await staff();
  const ownerToken = await sessionFor(pool, o.id, { method: 'admin_totp' });
  assert.equal((await upload(ownerToken, png(40, 40))).statusCode, 400, 'too small');
  assert.equal((await upload(ownerToken, Buffer.from('not an image at all'))).statusCode, 400, 'not an image');
  const r = await upload(ownerToken, png(128, 128));
  assert.equal(r.statusCode, 200, r.body);
  const first = (await pool.query(`SELECT photo_asset FROM admin_profile WHERE user_id = $1`, [o.id])).rows[0].photo_asset;
  assert.equal((await pool.query(`SELECT kind FROM asset WHERE id = $1`, [first])).rows[0].kind, 'admin_photo');
  assert.equal((await (await as(st)).get(`/admin/photos/${o.id}`)).status, 200, 'another administrator sees it');
  assert.equal((await (await as(o, 'code')).get(`/admin/photos/${o.id}`)).status, 403, 'a student session does not');
  assert.equal((await client(app, null).get(`/admin/photos/${o.id}`)).status, 401);
  assert.equal((await client(app, null).get(`/assets/${first}`)).status, 403, 'never a public asset');
  /* It cannot be uploaded through the public asset route either. */
  assert.equal((await upload(ownerToken, png(128, 128), '/assets', 'admin_photo')).statusCode, 400);

  assert.equal((await upload(ownerToken, png(160, 160))).statusCode, 200);
  const second = (await pool.query(`SELECT photo_asset FROM admin_profile WHERE user_id = $1`, [o.id])).rows[0].photo_asset;
  assert.notEqual(second, first);
  assert.equal((await pool.query(`SELECT 1 FROM asset WHERE id = $1`, [first])).rowCount, 0, 'the replaced photo is deleted');
  assert.deepEqual((await client(app, ownerToken).del('/admin/me/photo')).body, { hasPhoto: false });
  assert.equal((await pool.query(`SELECT 1 FROM asset WHERE id = $1`, [second])).rowCount, 0);
});

/* ---------- sessions and activity --------------------------------------------- */

test('my sessions: listed by handle (never a token), another ended by handle, all others ended at once', async () => {
  const o = await owner();
  const here = await sessionFor(pool, o.id, { method: 'admin_totp' });
  const laptop = await sessionFor(pool, o.id, { method: 'admin_totp' });
  const phoneS = await sessionFor(pool, o.id, { method: 'code' });
  const c = client(app, here);
  const list = (await c.get('/admin/me')).body.sessions;
  assert.equal(list.length, 3);
  assert.equal(list.filter((s) => s.current).length, 1);
  const hashes = (await pool.query(`SELECT token_hash FROM session WHERE user_id = $1`, [o.id])).rows.map((r) => r.token_hash);
  for (const s of list) {
    assert.match(s.handle, /^[0-9a-f]{20}$/);
    assert.ok(!hashes.some((h) => h.startsWith(s.handle)) && ![here, laptop, phoneS].includes(s.handle), 'a handle is not a token or its hash');
  }
  const current = list.find((s) => s.current);
  assert.equal((await c.post('/admin/me/sessions/revoke', { handle: current.handle })).status, 400, 'this session ends with Sign out');
  const other = list.find((s) => !s.current && s.method === 'Password + authenticator');
  assert.equal((await c.post('/admin/me/sessions/revoke', { handle: other.handle })).status, 200);
  assert.equal((await client(app, laptop).get('/auth/me')).body.authenticated, false);
  assert.equal((await client(app, phoneS).get('/auth/me')).body.authenticated, true);
  assert.equal((await c.post('/admin/me/sessions/revoke', { others: true })).status, 200);
  assert.equal((await client(app, phoneS).get('/auth/me')).body.authenticated, false);
  assert.equal((await c.get('/auth/me')).body.authenticated, true, 'this session stays');
});

test('ending sessions needs a recent confirmation, and someone else\'s session cannot be named', async () => {
  const o = await owner();
  const st = await staff();
  const stale = await sessionFor(pool, o.id, { method: 'admin_totp' });
  await pool.query(`UPDATE session SET passkey_verified_at = now() - interval '2 hours' WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [stale]);
  const r = await client(app, stale).post('/admin/me/sessions/revoke', { others: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'reauth_required');
  const staffSessions = (await (await as(st)).get('/admin/me')).body.sessions;
  const r2 = await (await as(o)).post('/admin/me/sessions/revoke', { handle: staffSessions[0].handle });
  assert.equal(r2.status, 404, 'only my own sessions are found');
});

test('my security activity is mine only', async () => {
  const o = await owner();
  const st = await staff();
  await (await as(o)).patch('/admin/me', { displayName: 'Ayussh' });
  await (await as(st)).patch('/admin/me', { displayName: 'Staff Person' });
  const mine = (await (await as(o)).get('/admin/me')).body.activity;
  assert.ok(mine.some((e) => e.action === 'admin.profile.update'));
  const staffRows = (await pool.query(`SELECT count(*)::int n FROM audit_log WHERE actor_id = $1`, [st.id])).rows[0].n;
  assert.ok(staffRows > 0);
  assert.equal(mine.length, (await pool.query(
    `SELECT count(*)::int n FROM audit_log WHERE actor_id = $1 OR resource_id = $2 OR resource_id = $3`, [o.id, String(o.id), OWNER_EMAIL])).rows[0].n);
});

/* ---------- replacing the authenticator ---------------------------------------- */

test('a replacement keeps the old authenticator working until the new one is confirmed', async () => {
  const o = await owner();
  const here = await sessionFor(pool, o.id, { method: 'admin_totp' });
  const other = await sessionFor(pool, o.id, { method: 'admin_totp' });
  const c = client(app, here);
  const begin = await c.post('/auth/admin/credential/authenticator/begin');
  assert.equal(begin.status, 200);
  assert.equal(begin.body.pending, true);
  assert.ok(begin.body.secret !== o.secret);
  assert.equal((await c.get('/auth/admin/credential')).body.replacementPending, true);

  /* Old one still signs in. */
  const s1 = await client(app, null).post('/auth/admin/login/password', { email: OWNER_EMAIL, password: PASSWORD });
  const old = await client(app, null).post('/auth/admin/login', { challenge: s1.body.challenge, code: auth.totpAt(o.secret, auth.stepNow()) });
  assert.equal(old.status, 200, 'the current authenticator works during a replacement');

  assert.equal((await c.post('/auth/admin/credential/authenticator/confirm', { code: auth.totpAt(o.secret, auth.stepNow() + 1) })).status, 400,
    'a code from the OLD app does not confirm the new one');
  const ok = await c.post('/auth/admin/credential/authenticator/confirm', { code: auth.totpAt(begin.body.secret, auth.stepNow()) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.authenticatorReady, true);
  assert.equal(ok.body.replacementPending, false);
  assert.equal((await client(app, other).get('/auth/me')).body.authenticated, false, 'other sessions end');
  assert.equal((await c.get('/auth/me')).body.authenticated, true, 'this one stays');

  const s2 = await client(app, null).post('/auth/admin/login/password', { email: OWNER_EMAIL, password: PASSWORD });
  assert.equal((await client(app, null).post('/auth/admin/login', { challenge: s2.body.challenge, code: auth.totpAt(o.secret, auth.stepNow() + 1) })).status, 403,
    'the old authenticator stops');
  const log = (await pool.query(`SELECT action, detail::text d FROM audit_log WHERE action LIKE 'admin.authenticator%' ORDER BY at`)).rows;
  assert.ok(log.some((l) => l.action === 'admin.authenticator.replace'));
  assert.ok(!JSON.stringify(log).includes(begin.body.secret), 'no secret in the audit log');
});

test('an abandoned replacement expires and leaves the current authenticator in place', async () => {
  const o = await owner();
  const c = await as(o);
  const begin = await c.post('/auth/admin/credential/authenticator/begin');
  await pool.query(`UPDATE admin_credential SET totp_pending_at = now() - interval '20 minutes' WHERE user_id = $1`, [o.id]);
  const r = await c.post('/auth/admin/credential/authenticator/confirm', { code: auth.totpAt(begin.body.secret, auth.stepNow()) });
  assert.equal(r.status, 400);
  const cred = (await pool.query(`SELECT totp_pending_enc FROM admin_credential WHERE user_id = $1`, [o.id])).rows[0];
  assert.equal(cred.totp_pending_enc, null);
  assert.equal((await auth.credentialStatus(o.id)).authenticatorReady, true);
});

/* ---------- staff can never ------------------------------------------------------ */

test('staff with every grantable permission cannot touch the owner, their own access, or platform roles', async () => {
  const o = await owner();
  const st = await staff();
  const s = await as(st);
  const ownerHash = (await pool.query(`SELECT password_hash FROM admin_credential WHERE user_id = $1`, [o.id])).rows[0].password_hash;
  const reason = { reason: 'testing the boundary', permissions: perms.PERMISSION_KEYS };
  assert.equal((await s.put(`/admin/access/admins/${o.id}/permissions`, reason)).status, 403, 'cannot edit the owner');
  assert.equal((await s.put(`/admin/access/admins/${st.id}/permissions`, reason)).status, 403, 'cannot grant themselves');
  assert.equal((await s.post(`/admin/access/admins/${o.id}/suspend`, { reason: 'try it' })).status, 403, 'cannot suspend the owner');
  assert.equal((await s.post(`/admin/access/admins/${o.id}/sessions/revoke`, { reason: 'try it' })).status, 403, 'cannot sign the owner out');
  assert.equal((await s.post(`/admin/access/admins/${o.id}/revoke`, { reason: 'try it' })).status, 403, 'cannot revoke the owner');
  assert.equal((await s.post('/admin/users/role', { phone: '9811100077', role: 'platform_admin', permissions: ['orders.view'] })).status, 403);
  assert.equal((await s.post('/admin/users/role/revoke', { userId: o.id, role: 'platform_owner' })).status, 403);
  /* Credential routes act on the caller only: no way to name the owner. */
  await s.post('/auth/admin/credential/password', { password: 'staff attempts a change 42', currentPassword: PASSWORD,
    code: auth.totpAt(st.secret, auth.stepNow()), userId: o.id });
  assert.equal((await pool.query(`SELECT password_hash FROM admin_credential WHERE user_id = $1`, [o.id])).rows[0].password_hash, ownerHash);
  assert.equal((await s.patch('/admin/me', { displayName: 'Owner Now', userId: o.id })).status, 200);
  assert.equal((await pool.query(`SELECT display_name FROM admin_profile WHERE user_id = $1`, [o.id])).rowCount, 0, 'the owner\'s profile is untouched');
  assert.ok(perms.validatePermissionList(['security.manage']).ok === false, 'owner-only permissions are never grantable');
});

test('a platform role granted with an explicit list holds exactly that list', async () => {
  const o = await owner();
  const c = await as(o);
  const g = await c.post('/admin/users/role', { phone: '9811100088', role: 'platform_admin', name: 'Cafe Ops', permissions: ['orders.view', 'cafeterias.manage'] });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const acct = (await pool.query(`SELECT a.permissions FROM admin_account a JOIN app_user u ON u.id = a.user_id WHERE u.phone = '+919811100088'`)).rows[0];
  assert.deepEqual(acct.permissions, ['cafeterias.manage', 'orders.view']);
  assert.equal((await c.post('/admin/users/role', { phone: '9811100089', role: 'platform_admin', permissions: ['security.manage'] })).status, 400);
  assert.equal((await c.post('/admin/users/role', { phone: '9811100090', role: 'vendor_staff', permissions: ['orders.view'] })).status, 400);
  const log = (await pool.query(`SELECT detail FROM audit_log WHERE action = 'user.role.grant' ORDER BY at DESC LIMIT 1`)).rows[0].detail;
  assert.deepEqual(log.permissions, ['cafeterias.manage', 'orders.view']);
});

test('the catalogue groups permissions by area and still lists every one', () => {
  const c = perms.catalogue();
  const names = c.groups.map((g) => g.name);
  for (const g of ['Orders', 'Cafés', 'Menu', 'Users', 'Verification', 'Partners', 'Delivery tracking', 'Payments', 'Settlements',
    'Website customization', 'Website publishing', 'Access management', 'Sessions', 'Audit logs', 'System health', 'Authentication & security']) {
    assert.ok(names.includes(g), g);
  }
  assert.equal(c.groups.flatMap((g) => g.permissions).length, perms.PERMISSION_KEYS.length);
  assert.deepEqual(c.alwaysAvailable.map((a) => a.group), ['Dashboard', 'Profile', 'Reports']);
  /* Refunds are separate from seeing payments, and publishing from editing. */
  const where = (k) => c.groups.find((g) => g.permissions.some((p) => p.key === k)).name;
  assert.notEqual(where('orders.override'), where('orders.view'));
  assert.notEqual(where('website.publish'), where('website.customize'));
});
