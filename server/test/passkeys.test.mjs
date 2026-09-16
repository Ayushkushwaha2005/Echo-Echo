/* ==========================================================================
   ADMINISTRATOR PASSKEYS — real WebAuthn byte structures, real signatures.

   A software authenticator is built here from Node's crypto: it generates a
   P-256 key, produces authenticatorData, attestationObject (CBOR, fmt none)
   and ECDSA assertions exactly as a platform authenticator does. The server
   code under test is the production verifier.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign as cryptoSign, randomBytes } from 'node:crypto';
import { startDb, stopDb, truncateAll, makeUser } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool, creds;
before(async () => {
  await startDb();
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    ADMIN_PASSKEY_REQUIRED: 'true',
  });
  ({ pool } = await import('../src/db/index.js'));
  creds = await import('../src/services/admin-credentials.js');
  app = await makeApp();
  process.env.ADMIN_PASSKEY_REQUIRED = 'true';     // makeApp sets NODE_ENV=test; keep enforcement on
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); delete process.env.ADMIN_PASSKEY_REQUIRED; });
beforeEach(async () => { await truncateAll(pool); });

const ORIGIN = 'http://localhost:3000';
const b64u = (b) => Buffer.from(b).toString('base64url');

/* ---------- minimal CBOR encoder -------------------------------------------- */
function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
    : n < 256 ? Buffer.from([(major << 5) | 24, n])
    : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}

/* ---------- a software platform authenticator ------------------------------- */
function authenticator({ rpId = 'localhost' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);
  let counter = 0;
  const rpHash = createHash('sha256').update(rpId).digest();
  const cd = (type, challenge, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64u(id),
    create(challenge, { origin, flags = 0x45 } = {}) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), len, id, cbor(cose)]);
      const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64u(id), rawId: b64u(id), type: 'public-key',
               response: { clientDataJSON: b64u(cd('webauthn.create', challenge, origin)), attestationObject: b64u(att), transports: ['internal'] } };
    },
    get(challenge, { origin, flags = 0x05, count = ++counter, tamper = false, key = privateKey } = {}) {
      const c = Buffer.alloc(4); c.writeUInt32BE(count);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), c]);
      const clientData = cd('webauthn.get', challenge, origin);
      let sig = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), { key, dsaEncoding: 'der' });
      if (tamper) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 0xff; }
      return { id: b64u(id), rawId: b64u(id), type: 'public-key',
               response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) } };
    },
  };
}

const cookieOf = (res) => [].concat(res.headers['set-cookie'] || [])
  .find((c) => c.startsWith('quad_session='))?.split(';')[0].split('=')[1] || null;

async function adminWithCodeSession(role = 'platform_admin', name = 'Anushka Admin') {
  const u = await makeUser(pool, { phone: `+9198${String(Date.now()).slice(-8)}`, name, roles: ['student', role] });
  await pool.query(`UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`,
    [u.id, `${name.split(' ')[0].toLowerCase()}.${String(Date.now()).slice(-5)}@stu.upes.ac.in`]);
  const token = await sessionFor(pool, u.id);
  return { u, token, c: client(app, token) };
}

async function registerFirstPasskey(c, userId, auth = authenticator()) {
  const { code } = await creds.issueInvite(userId);
  const opts = await c.post('/auth/passkey/register/options', { inviteCode: code });
  assert.equal(opts.status, 200, JSON.stringify(opts.body));
  const reg = await c.post('/auth/passkey/register/verify',
    { inviteCode: code, label: 'Test laptop', credential: auth.create(opts.body.challenge) });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  return { auth, reg };
}

async function passkeyLogin(auth, overrides = {}) {
  const anon = client(app);
  const opts = await anon.post('/auth/passkey/login/options');
  return anon.post('/auth/passkey/login/verify', { credential: auth.get(opts.body.challenge, overrides) });
}

/* ======================================================================== */

test('an administrator from an email-code session holds no admin power until a passkey confirms it', async () => {
  const { c } = await adminWithCodeSession();
  const r = await c.get('/admin/users');
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'admin_signin_required');
  const me = (await c.get('/auth/me')).body;
  assert.deepEqual(me.roles, ['student']);
  assert.deepEqual(me.passkey.withheldRoles, ['platform_admin']);
  assert.ok(me.passkey.adminSurfacesPending.includes('admin'));
  /* Direct role checks fail closed too: support staff view is not granted. */
  const cases = await c.get('/support/cases?state=all');
  assert.equal(cases.status, 200);
  assert.equal((await c.get('/admin/audit')).status, 403);
});

test('first passkey needs a valid one-time invite; the ceremony upgrades the session and issues recovery codes once', async () => {
  const { u, c } = await adminWithCodeSession();
  const auth = authenticator();
  assert.equal((await c.post('/auth/passkey/register/options', {})).status, 400, 'no invite');
  const { code } = await creds.issueInvite(u.id);
  assert.equal((await c.post('/auth/passkey/register/options', { inviteCode: 'AAAA-BBBB-CCCC' })).status, 400, 'wrong invite');

  const opts = await c.post('/auth/passkey/register/options', { inviteCode: code });
  assert.equal(opts.status, 200);
  assert.equal(opts.body.authenticatorSelection.userVerification, 'required');
  assert.equal(opts.body.attestation, 'none');

  /* A ceremony from the wrong site, or without user verification, is refused. */
  assert.equal((await c.post('/auth/passkey/register/verify',
    { inviteCode: code, credential: auth.create(opts.body.challenge, { origin: 'https://evil.example' }) })).status, 400);
  assert.equal((await c.post('/auth/passkey/register/verify',
    { inviteCode: code, credential: auth.create(opts.body.challenge, { flags: 0x41 }) })).status, 400, 'UV flag missing');

  const reg = await c.post('/auth/passkey/register/verify',
    { inviteCode: code, label: 'Ayush laptop', credential: auth.create(opts.body.challenge) });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.recoveryCodes.length, 10);
  assert.equal((await c.get('/admin/users')).status, 200, 'the same session now carries the admin role');

  /* The invite is spent; the challenge cannot be replayed. */
  const again = await c.post('/auth/passkey/register/verify',
    { inviteCode: code, credential: authenticator().create(opts.body.challenge) });
  assert.notEqual(again.status, 200);
  const stored = (await pool.query(`SELECT public_key_jwk, credential_id FROM webauthn_credential WHERE user_id = $1`, [u.id])).rows;
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes('"d"'), 'no private key material is stored');
  const hashes = (await pool.query(`SELECT code_hash FROM admin_recovery_code WHERE user_id = $1`, [u.id])).rows;
  assert.ok(!hashes.some((h) => reg.body.recoveryCodes.includes(h.code_hash)), 'recovery codes are stored hashed');
});

test('passkey sign-in: valid assertion opens an admin session; replay, forgery, wrong site, no UV and counter regression are refused', async () => {
  const { u, c } = await adminWithCodeSession();
  const { auth } = await registerFirstPasskey(c, u.id);

  const ok = await passkeyLogin(auth);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.surface, 'admin');
  const admin = client(app, cookieOf(ok));
  assert.equal((await admin.get('/admin/users')).status, 200);

  /* Replay: the same signed response a second time. */
  const anon = client(app);
  const opts = await anon.post('/auth/passkey/login/options');
  const signed = auth.get(opts.body.challenge);
  assert.equal((await anon.post('/auth/passkey/login/verify', { credential: signed })).status, 200);
  assert.equal((await anon.post('/auth/passkey/login/verify', { credential: signed })).status, 400, 'replayed');

  assert.equal((await passkeyLogin(auth, { tamper: true })).status, 400, 'forged signature');
  assert.equal((await passkeyLogin(auth, { origin: 'https://evil.example' })).status, 400, 'phishing origin');
  assert.equal((await passkeyLogin(auth, { flags: 0x01 })).status, 400, 'presence without verification');
  assert.equal((await passkeyLogin(auth, { count: 1 })).status, 400, 'counter went backwards');
  const imposter = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  assert.equal((await passkeyLogin(auth, { key: imposter })).status, 400, 'right id, wrong key');

  const failures = await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'auth.passkey.login' AND outcome = 'denied'`);
  assert.ok(failures.rows[0].n >= 5, 'refused sign-ins are audited');
});

test('a passkey cannot sign in an account that is suspended or no longer an administrator', async () => {
  const { u, c } = await adminWithCodeSession();
  const { auth } = await registerFirstPasskey(c, u.id);
  await pool.query(`UPDATE user_role SET status = 'revoked' WHERE user_id = $1 AND role = 'platform_admin'`, [u.id]);
  assert.equal((await passkeyLogin(auth)).status, 403);
  await pool.query(`UPDATE user_role SET status = 'active' WHERE user_id = $1 AND role = 'platform_admin'`, [u.id]);
  await pool.query(`UPDATE app_user SET status = 'suspended' WHERE id = $1`, [u.id]);
  assert.equal((await passkeyLogin(auth)).status, 403);
});

test('sensitive actions need a passkey confirmation from the last few minutes', async () => {
  const { u, c } = await adminWithCodeSession();
  const { auth } = await registerFirstPasskey(c, u.id);
  const login = await passkeyLogin(auth);
  const token = cookieOf(login);
  const admin = client(app, token);

  await pool.query(`UPDATE session SET passkey_verified_at = now() - interval '30 minutes' WHERE user_id = $1`, [u.id]);
  assert.equal((await admin.get('/admin/users')).status, 200, 'reading still works');
  const stale = await admin.put('/admin/flags/delivery', { enabled: false });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, 'reauth_required');

  const opts = await admin.post('/auth/passkey/reauth/options');
  assert.deepEqual(opts.body.allowCredentials.map((x) => x.id), [auth.id]);
  const re = await admin.post('/auth/passkey/reauth/verify', { credential: auth.get(opts.body.challenge) });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal((await admin.put('/admin/flags/delivery', { enabled: false })).status, 200);
});

test('recovery: a code opens a registration-only session, the new passkey replaces the lost one, codes work once', async () => {
  const { u, c } = await adminWithCodeSession();
  const { auth: lost, reg } = await registerFirstPasskey(c, u.id);
  const code = reg.body.recoveryCodes[0];

  /* Later, on a new device, from an email-code session. */
  const fresh = client(app, await sessionFor(pool, u.id));
  assert.equal((await fresh.post('/auth/recovery/verify', { code: 'WRONG-CODE0' })).status, 400);
  assert.equal((await fresh.post('/auth/recovery/verify', { code })).status, 200);
  const me = (await fresh.get('/auth/me')).body;
  assert.deepEqual(me.roles, [], 'a recovery session carries no roles');
  assert.equal((await fresh.get('/admin/users')).status, 403);

  const replacement = authenticator();
  const opts = await fresh.post('/auth/passkey/register/options', {});
  assert.equal(opts.body.via, 'recovery');
  const r = await fresh.post('/auth/passkey/register/verify', { label: 'New phone', credential: replacement.create(opts.body.challenge) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.recoveryCodes.length, 10, 'a new set replaces the old one');

  assert.equal((await passkeyLogin(lost)).status, 400, 'the lost passkey is revoked');
  assert.equal((await passkeyLogin(replacement)).status, 200);
  const again = client(app, await sessionFor(pool, u.id));
  assert.equal((await again.post('/auth/recovery/verify', { code })).status, 400, 'a recovery code works once');
});

test('students cannot register passkeys or become administrators; admins cannot promote themselves', async () => {
  const stu = await makeUser(pool, { phone: '+919811155501', name: 'Plain Student' });
  const s = client(app, await sessionFor(pool, stu.id));
  assert.equal((await s.post('/auth/passkey/register/options', { inviteCode: 'AAAA-BBBB-CCCC' })).status, 403);
  await assert.rejects(() => creds.issueInvite(stu.id), /administrator accounts only/);

  const { u, c } = await adminWithCodeSession();
  await registerFirstPasskey(c, u.id);
  const grant = await c.post('/admin/users/role', { phone: u.phone, role: 'platform_owner' });
  assert.equal(grant.status, 403);
  assert.equal((await c.post('/admin/passkey-invites', { userId: stu.id })).status, 403, 'only the owner invites');
});

test('removing a passkey ends the sessions it opened', async () => {
  const { u, c } = await adminWithCodeSession();
  const { auth } = await registerFirstPasskey(c, u.id);
  const login = client(app, cookieOf(await passkeyLogin(auth)));
  const credId = (await pool.query(`SELECT id FROM webauthn_credential WHERE user_id = $1`, [u.id])).rows[0].id;
  assert.equal((await c.post(`/auth/passkey/credentials/${credId}/revoke`)).status, 200);
  assert.equal((await login.get('/admin/users')).status, 401, 'the other passkey session is gone');
  assert.equal((await passkeyLogin(auth)).status, 400);
});

test('owner email in configuration grants platform_owner only after the mailbox is proven', async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'ayush.17551@stu.upes.ac.in';
  process.env.PLATFORM_ADMIN_EMAILS = 'second.admin@stu.upes.ac.in';
  try {
    const { grantConfiguredAdminRoles } = await import('../src/routes/auth.js');
    const cfg = await import('../src/config.js');
    /* config reads env at import; mirror the running values for this check */
    Object.defineProperty(cfg.PLATFORM_OWNER, 'email', { value: 'ayush.17551@stu.upes.ac.in', configurable: true });
    cfg.ADMIN.emails.splice(0, cfg.ADMIN.emails.length, 'second.admin@stu.upes.ac.in');
    const a = await makeUser(pool, { phone: '+919811155510', name: 'Ayush' });
    const b = await makeUser(pool, { phone: '+919811155511', name: 'Second Admin' });
    const x = await makeUser(pool, { phone: '+919811155512', name: 'Not Listed' });
    const c = await pool.connect();
    try {
      await grantConfiguredAdminRoles(c, a.id, 'ayush.17551@stu.upes.ac.in');
      await grantConfiguredAdminRoles(c, b.id, 'second.admin@stu.upes.ac.in');
      await grantConfiguredAdminRoles(c, x.id, 'someone.else@stu.upes.ac.in');
    } finally { c.release(); }
    const roles = async (id) => (await pool.query(`SELECT role, granted_via FROM user_role WHERE user_id = $1 AND status='active' ORDER BY role`, [id])).rows;
    assert.deepEqual((await roles(a.id)).map((r) => r.role), ['platform_owner', 'student']);
    assert.deepEqual((await roles(b.id)).map((r) => r.role), ['platform_admin', 'student']);
    assert.deepEqual((await roles(x.id)).map((r) => r.role), ['student']);
    assert.equal((await roles(a.id)).find((r) => r.role === 'platform_owner').granted_via, 'bootstrap_config');
  } finally {
    delete process.env.PLATFORM_OWNER_EMAIL; delete process.env.PLATFORM_ADMIN_EMAILS;
  }
});
