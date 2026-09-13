/* ==========================================================================
   ENROLMENT CODES — the provider-free way into the platform.

   The interesting tests here are the refusals: an enrolment code is a way to
   obtain a session without an SMS gateway, so if it can be pointed at the
   wrong account it is a privilege-escalation primitive rather than a
   convenience.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool, issueCode, normaliseCode;

before(async () => {
  await startDb();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  ({ pool } = await import('../src/db/index.js'));
  ({ issueCode, normaliseCode } = await import('../src/services/enrolment.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const as = async (u) => client(app, await sessionFor(pool, u.id));
const anon = () => client(app);

async function adminAnd(roleUser) {
  const admin = await makeUser(pool, { phone: '+919600000001', name: 'Adm', roles: ['platform_admin'] });
  return { admin, ca: await as(admin), target: roleUser };
}

/* ---------- the happy path, end to end ---------------------------------- */
test('an admin issues a code and the recipient signs in with it — no SMS anywhere', async () => {
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco' });
  const owner = await makeUser(pool, { phone: '+919600000010', name: 'Ravi',
    roles: ['vendor_owner'], vendorId: v.id });
  const { ca } = await adminAnd(owner);

  const issued = await ca.post(`/admin/users/${owner.id}/enrolment`);
  assert.equal(issued.status, 200);
  assert.match(issued.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(issued.body.phone, '+919600000010');

  /* The recipient redeems it and lands on Counter, decided by the server. */
  const login = await anon().post('/auth/enrol',
    { phone: '9600000010', code: issued.body.code });
  assert.equal(login.status, 200);
  assert.equal(login.body.surface, 'counter');
  assert.deepEqual(login.body.roles, ['vendor_owner']);
  assert.equal(login.body.via, 'enrolment_code');

  /* And the cookie is a real, working session. */
  const cookie = login.headers?.['set-cookie'];
  assert.ok(cookie, 'a session cookie must be set');
});

test('the code is single-use', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919600000011', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const { ca } = await adminAnd(owner);
  const code = (await ca.post(`/admin/users/${owner.id}/enrolment`)).body.code;

  assert.equal((await anon().post('/auth/enrol', { phone: '9600000011', code })).status, 200);
  const second = await anon().post('/auth/enrol', { phone: '9600000011', code });
  assert.equal(second.status, 400, 'a used code must not work twice');
});

test('re-issuing invalidates the previous code', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919600000012', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const { ca } = await adminAnd(owner);

  const first = (await ca.post(`/admin/users/${owner.id}/enrolment`)).body.code;
  const second = (await ca.post(`/admin/users/${owner.id}/enrolment`)).body.code;
  assert.notEqual(first, second);

  assert.equal((await anon().post('/auth/enrol', { phone: '9600000012', code: first })).status, 400);
  assert.equal((await anon().post('/auth/enrol', { phone: '9600000012', code: second })).status, 200);
});

test('a code read aloud is accepted however it is typed back', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919600000013', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const { ca } = await adminAnd(owner);
  const code = (await ca.post(`/admin/users/${owner.id}/enrolment`)).body.code;

  const messy = ' ' + code.toLowerCase().replace(/-/g, ' ') + ' ';
  const r = await anon().post('/auth/enrol', { phone: '9600000013', code: messy });
  assert.equal(r.status, 200, 'case, spacing and dashes must not matter');
});

/* ---------- the refusals that make it safe ------------------------------ */
test('an admin CANNOT mint their way into the platform owner account', async () => {
  const ownerAcct = await makeUser(pool, { phone: '+919000000000', name: 'Owner',
    roles: ['platform_owner'] });
  const admin = await makeUser(pool, { phone: '+919600000020', name: 'Adm', roles: ['platform_admin'] });
  const ca = await as(admin);

  const r = await ca.post(`/admin/users/${ownerAcct.id}/enrolment`);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /platform owner cannot be enrolled/i);

  const codes = await pool.query(`SELECT count(*)::int AS n FROM enrolment_code WHERE user_id=$1`,
                                 [ownerAcct.id]);
  assert.equal(codes.rows[0].n, 0, 'no code may exist for the owner');
});

test('a plain student cannot be enrolled — students use the OTP path', async () => {
  const stu = await makeUser(pool, { phone: '+919600000021', name: 'Asha' });
  const { ca } = await adminAnd(stu);
  const r = await ca.post(`/admin/users/${stu.id}/enrolment`);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /no staff or admin role/i);
});

test('a code is bound to one account and cannot be redeemed by another number', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919600000022', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const other = await makeUser(pool, { phone: '+919600000023', name: 'Other',
    roles: ['vendor_staff'], vendorId: v.id });
  const { ca } = await adminAnd(owner);
  const code = (await ca.post(`/admin/users/${owner.id}/enrolment`)).body.code;

  const stolen = await anon().post('/auth/enrol', { phone: '9600000023', code });
  assert.equal(stolen.status, 400, "another user's number must not redeem this code");
  /* And the real owner's code still works afterwards. */
  assert.equal((await anon().post('/auth/enrol', { phone: '9600000022', code })).status, 200);
});

test('a non-admin cannot issue enrolment codes', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919600000024', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const staff = await makeUser(pool, { phone: '+919600000025', name: 'S',
    roles: ['vendor_staff'], vendorId: v.id });
  const stu = await makeUser(pool, { phone: '+919600000026', name: 'A' });

  for (const u of [owner, staff, stu]) {
    const c = await as(u);
    const r = await c.post(`/admin/users/${owner.id}/enrolment`);
    assert.equal(r.status, 403, `${u.name} must not be able to issue codes`);
  }
});

test('attempts are capped and the code dies when they run out', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919600000027', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const { ca } = await adminAnd(owner);
  const real = (await ca.post(`/admin/users/${owner.id}/enrolment`)).body.code;

  for (let i = 0; i < 5; i++) {
    await anon().post('/auth/enrol', { phone: '9600000027', code: 'AAAA-BBBB-CCCC' });
  }
  /* Even the CORRECT code is now dead. */
  const r = await anon().post('/auth/enrol', { phone: '9600000027', code: real });
  assert.ok([400, 429].includes(r.status), 'the code must be dead after the attempt ceiling');
});

test('an expired code does not work', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919600000028', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const { ca } = await adminAnd(owner);
  const code = (await ca.post(`/admin/users/${owner.id}/enrolment`)).body.code;

  await pool.query(`UPDATE enrolment_code SET expires_at = now() - interval '1 minute'
                     WHERE user_id = $1`, [owner.id]);
  assert.equal((await anon().post('/auth/enrol', { phone: '9600000028', code })).status, 400);
});

test('a suspended account can neither be issued a code nor redeem one', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919600000029', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const { ca } = await adminAnd(owner);
  const code = (await ca.post(`/admin/users/${owner.id}/enrolment`)).body.code;

  await pool.query(`UPDATE app_user SET status='suspended' WHERE id=$1`, [owner.id]);
  assert.equal((await anon().post('/auth/enrol', { phone: '9600000029', code })).status, 403);
  assert.equal((await ca.post(`/admin/users/${owner.id}/enrolment`)).status, 403);
});

/* ---------- storage and disclosure -------------------------------------- */
test('only a hash is stored — the plaintext exists once, in the issuing response', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919600000030', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const { ca } = await adminAnd(owner);
  const code = (await ca.post(`/admin/users/${owner.id}/enrolment`)).body.code;

  const row = (await pool.query(
    `SELECT code_hash, salt FROM enrolment_code WHERE user_id=$1`, [owner.id])).rows[0];
  assert.notEqual(row.code_hash, code);
  assert.notEqual(row.code_hash, normaliseCode(code));
  assert.ok(!JSON.stringify(row).includes(normaliseCode(code)), 'the code must not be recoverable');

  /* The status endpoint reports existence, never the secret. */
  const status = await ca.get(`/admin/users/${owner.id}/enrolment`);
  assert.equal(status.body.live, true);
  assert.ok(!JSON.stringify(status.body).includes(normaliseCode(code)));

  /* Nor does the audit log record it. */
  const audit = await pool.query(
    `SELECT detail FROM audit_log WHERE action='user.enrolment.issue'`);
  assert.ok(!JSON.stringify(audit.rows).includes(normaliseCode(code)),
    'the audit trail must not contain the code');
});

test('an admin can revoke a live code', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919600000031', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const { ca } = await adminAnd(owner);
  const code = (await ca.post(`/admin/users/${owner.id}/enrolment`)).body.code;

  assert.equal((await ca.post(`/admin/users/${owner.id}/enrolment/revoke`)).body.revoked, 1);
  assert.equal((await anon().post('/auth/enrol', { phone: '9600000031', code })).status, 400);
  assert.equal((await ca.get(`/admin/users/${owner.id}/enrolment`)).body.live, false);
});

/* ---------- the point of the whole exercise ------------------------------ */
test('this path needs no external provider at all', async () => {
  const { OTP, PAYMENTS, AI } = await import('../src/config.js');
  assert.equal(OTP.configured, false, 'no SMS gateway in this environment');
  assert.equal(PAYMENTS.configured, false);
  assert.equal(AI.configured, false);

  /* And yet a real administrator can be brought online end to end. */
  const admin2 = await makeUser(pool, { phone: '+919600000040', name: 'New Admin',
    roles: ['platform_admin'] });
  const { ca } = await adminAnd(admin2);
  /* An ordinary administrator cannot mint a sign-in code into a colleague's
     account; the platform owner can. */
  assert.equal((await ca.post(`/admin/users/${admin2.id}/enrolment`)).status, 403);
  const platformOwner = await makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['platform_owner'] });
  const co = await as(platformOwner);
  const code = (await co.post(`/admin/users/${admin2.id}/enrolment`)).body.code;
  const login = await anon().post('/auth/enrol', { phone: '9600000040', code });
  assert.equal(login.status, 200);
  assert.equal(login.body.surface, 'admin');

  /* The OTP route still refuses honestly rather than falling back to this. */
  const otp = await anon().post('/auth/otp/send', { phone: '9600000040' });
  assert.equal(otp.status, 503, 'the OTP path must not silently use enrolment codes');
  assert.equal(otp.body.code, 'configuration_required');
});
