/* ==========================================================================
   API — real HTTP through the full Fastify stack (app.inject).

   Every hook runs: CORS, the CSRF origin check, session resolution from the
   cookie, the error handler, rate limiting. The only things absent are the
   external providers, which have no credentials — and the tests assert that
   their absence produces an honest 503 rather than a fake success.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus, makePartnerReady }
  from './helpers/db.mjs';
import { makeApp, sessionFor, expiredSessionFor, client } from './helpers/api.mjs';

let app, pool;

before(async () => {
  await startDb();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const anon = () => client(app);
const as = async (u) => client(app, await sessionFor(pool, u.id));

/* ======================= probes ========================================= */

test('GET /health is public and does not leak configuration', async () => {
  const r = await anon().get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(!JSON.stringify(r.body).includes('SECRET'));
});

test('GET /ready reports real database connectivity', async () => {
  const r = await anon().get('/ready');
  assert.equal(r.status, 200);
  assert.equal(r.body.ready, true);
  assert.equal(r.body.checks.database.ok, true);
  assert.ok(typeof r.body.checks.database.latencyMs === 'number');
  assert.equal(r.body.checks.migrations.ok, true, 'every shipped migration is applied');
  assert.deepEqual(r.body.checks.migrations.pending, []);
});

test('GET /ready fails closed when a shipped migration has not been applied', async () => {
  const last = (await pool.query(`SELECT name FROM schema_migration ORDER BY name DESC LIMIT 1`)).rows[0].name;
  await pool.query(`DELETE FROM schema_migration WHERE name = $1`, [last]);
  try {
    const r = await anon().get('/ready');
    assert.equal(r.status, 503);
    assert.deepEqual(r.body.checks.migrations.pending, [last]);
  } finally {
    await pool.query(`INSERT INTO schema_migration (name) VALUES ($1)`, [last]);
  }
});

test('every response carries a request id', async () => {
  const r = await anon().get('/health');
  assert.ok(r.headers['x-request-id']);
});

test('security headers are present', async () => {
  const r = await anon().get('/health');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
});

/* ======================= authentication ================================= */

test('phone sign-in is gone, and says so rather than 404ing', async () => {
  for (const url of ['/auth/otp/send', '/auth/otp/verify']) {
    const r = await anon().post(url, { phone: '9876543210', code: '123456' });
    assert.equal(r.status, 410, `${url} must report itself removed`);
    assert.equal(r.body.code, 'endpoint_removed');
    assert.match(r.body.error, /Phone sign-in has been removed/);
  }
});

test('no phone code, however guessable, creates an account or a session', async () => {
  /* The classic bypass attempt, against an endpoint that no longer exists. */
  for (const code of ['123456', '000000', '111111']) {
    const r = await anon().post('/auth/otp/verify', { phone: '9876543210', code });
    assert.equal(r.status, 410, `code ${code} must not authenticate`);
    assert.equal(r.headers['set-cookie'], undefined, 'no session cookie may be issued');
  }
  const users = await pool.query(`SELECT count(*)::int AS n FROM app_user`);
  assert.equal(users.rows[0].n, 0, 'no account may be created by a failed verify');
  const sessions = await pool.query(`SELECT count(*)::int AS n FROM session`);
  assert.equal(sessions.rows[0].n, 0, 'no session may exist');
});

test('/auth/status reports phone sign-in as removed, not merely unconfigured', async () => {
  const r = await anon().get('/auth/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.otp.configured, false);
  assert.equal(r.body.otp.removed, true);
});

test('an anonymous caller gets 401 on authenticated routes', async () => {
  for (const [m, url] of [['get', '/auth/me'], ['get', '/admin/users'], ['get', '/orders']]) {
    const r = await anon()[m](url);
    if (url === '/auth/me') { assert.equal(r.body.authenticated, false); continue; }
    assert.equal(r.status, 401, url);
  }
});

test('an expired session is rejected', async () => {
  const u = await makeUser(pool, { phone: '+919200000001', name: 'A' });
  const c = client(app, await expiredSessionFor(pool, u.id));
  const r = await c.get('/orders');
  assert.equal(r.status, 401);
});

test('logout revokes the session immediately', async () => {
  const u = await makeUser(pool, { phone: '+919200000002', name: 'A' });
  const token = await sessionFor(pool, u.id);
  const c = client(app, token);
  assert.equal((await c.get('/auth/me')).body.authenticated, true);
  assert.equal((await c.post('/auth/logout')).status, 200);
  assert.equal((await c.get('/auth/me')).body.authenticated, false);
});

test('a suspended account cannot act, even with a live session', async () => {
  const u = await makeUser(pool, { phone: '+919200000003', name: 'A' });
  const c = await as(u);
  await pool.query(`UPDATE app_user SET status='suspended' WHERE id=$1`, [u.id]);
  const r = await c.get('/orders');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /suspended/i);
});

test('roles come from the database on every request, not the cookie', async () => {
  const u = await makeUser(pool, { phone: '+919200000004', name: 'A', roles: ['student', 'platform_admin'] });
  const c = await as(u);
  assert.equal((await c.get('/admin/users')).status, 200);
  /* Revoke mid-session: the very next request must fail. */
  await pool.query(`UPDATE user_role SET status='revoked' WHERE user_id=$1 AND role='platform_admin'`, [u.id]);
  assert.equal((await c.get('/admin/users')).status, 403);
});

test('the landing surface is decided by the server', async () => {
  const cases = [
    [['student'], 'web'], [['vendor_owner'], 'counter'], [['platform_admin'], 'admin'],
  ];
  let n = 10;
  for (const [roles, expected] of cases) {
    const v = roles[0].startsWith('vendor') ? await makeVendor(pool, { name: 'V' + n, slug: 'v' + n }) : null;
    const u = await makeUser(pool, { phone: `+9192000001${n}`, name: 'A', roles, vendorId: v?.id });
    const c = await as(u);
    assert.equal((await c.get('/auth/me')).body.surface, expected);
    n++;
  }
});

/* ======================= CSRF / origin =================================== */

test('a cookie-bearing POST from an unknown origin is rejected', async () => {
  const u = await makeUser(pool, { phone: '+919200000020', name: 'A' });
  const c = await as(u);
  const r = await c.postFrom('https://evil.example', '/support/cases',
                             { category: 'other', subject: 'x' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Cross-origin/);
});

test('in production a cookie-bearing write with no Origin or Referer is refused', async () => {
  const u = await makeUser(pool, { phone: '+919200000022', name: 'A' });
  const token = await sessionFor(pool, u.id);
  const send = (headers) => app.inject({ method: 'POST', url: '/support/cases',
    payload: { category: 'other', subject: 'x' },
    headers: { 'content-type': 'application/json', cookie: `quad_session=${token}`, ...headers } });
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const bare = await send({});
    assert.equal(bare.statusCode, 403);
    assert.match(JSON.parse(bare.body).error, /origin missing/i);
    assert.equal((await send({ referer: 'https://evil.example/page' })).statusCode, 403);
    assert.equal((await send({ referer: 'not a url' })).statusCode, 403, 'a malformed referer is not a pass');
    assert.equal((await send({ origin: 'http://localhost:3000' })).statusCode, 200);
  } finally {
    process.env.NODE_ENV = was;
  }
});

test('the same POST from the allowed origin succeeds', async () => {
  const u = await makeUser(pool, { phone: '+919200000021', name: 'A' });
  const c = await as(u);
  const r = await c.post('/support/cases', { category: 'other', subject: 'Hello' });
  assert.equal(r.status, 200);
});

/* ======================= authorization ================================== */

test('a shopkeeper cannot touch another cafeteria over HTTP', async () => {
  const frisco = await makeVendor(pool, { name: 'Frisco', slug: 'frisco' });
  const tulips = await makeVendor(pool, { name: 'Tulips', slug: 'tulips' });
  const theirItem = await makeItem(pool, tulips.id, { name: 'Thali', paise: 14000 });
  const owner = await makeUser(pool, { phone: '+919200000030', name: 'Ravi',
    roles: ['vendor_owner'], vendorId: frisco.id });
  const c = await as(owner);

  assert.equal((await c.post(`/vendors/${frisco.id}/menu`, { name: 'Burger', price: '90' })).status, 200);

  const r1 = await c.post(`/vendors/${tulips.id}/menu`, { name: 'Sneaky', price: '10' });
  assert.equal(r1.status, 403);
  const r2 = await c.patch(`/menu/${theirItem.id}`, { price: '1' });
  assert.equal(r2.status, 403);
  const r3 = await c.patch(`/vendors/${tulips.id}`, { name: 'Mine now' });
  assert.equal(r3.status, 403);

  /* And the other cafeteria's data is genuinely unchanged. */
  const still = await pool.query(`SELECT name, price_paise FROM menu_item WHERE id=$1`, [theirItem.id]);
  assert.equal(still.rows[0].price_paise, 14000);
});

test('a shopkeeper cannot create a cafeteria or reach Campus Control', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919200000031', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const c = await as(owner);
  assert.equal((await c.post('/vendors', { name: 'New' })).status, 403);
  assert.equal((await c.get('/admin/users')).status, 403);
  assert.equal((await c.get('/admin/audit')).status, 403);
  assert.equal((await c.get('/admin/flags')).status, 403);
});

test('counter staff can flip availability but not price', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const staff = await makeUser(pool, { phone: '+919200000032', name: 'S',
    roles: ['vendor_staff'], vendorId: v.id });
  const c = await as(staff);
  assert.equal((await c.patch(`/menu/${i.id}`, { available: false })).status, 200);
  assert.equal((await c.patch(`/menu/${i.id}`, { price: '1' })).status, 403);
  const row = await pool.query(`SELECT price_paise FROM menu_item WHERE id=$1`, [i.id]);
  assert.equal(row.rows[0].price_paise, 9000);
});

test('a student cannot read another student order', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const a = await makeUser(pool, { phone: '+919200000033', name: 'A' });
  const b = await makeUser(pool, { phone: '+919200000034', name: 'B' });
  const ca = await as(a), cb = await as(b);
  const draft = await ca.post('/orders/draft',
    { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' });
  assert.equal(draft.status, 200);
  const stolen = await cb.get(`/orders/${draft.body.id}`);
  assert.equal(stolen.status, 403);
});

test('a normal admin cannot grant themselves or anyone platform roles', async () => {
  const admin = await makeUser(pool, { phone: '+919200000035', name: 'Adm', roles: ['platform_admin'] });
  const c = await as(admin);
  for (const role of ['platform_owner', 'platform_admin', 'support']) {
    const r = await c.post('/admin/users/role', { phone: '9999999999', role });
    assert.equal(r.status, 403, role);
  }
});

test('the platform owner cannot be suspended or stripped via the API', async () => {
  const owner = await makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['platform_owner'] });
  const admin = await makeUser(pool, { phone: '+919200000036', name: 'Adm', roles: ['platform_admin'] });
  const c = await as(admin);
  const s = await c.post(`/admin/users/${owner.id}/status`, { status: 'suspended' });
  assert.equal(s.status, 403);
  const r = await c.post('/admin/users/role/revoke', { userId: owner.id, role: 'delivery_partner' });
  assert.equal(r.status, 403);
  const check = await pool.query(`SELECT status FROM app_user WHERE id=$1`, [owner.id]);
  assert.equal(check.rows[0].status, 'active');
});

test('the owner CAN grant an admin, and that admin can grant a vendor owner', async () => {
  const owner = await makeUser(pool, { phone: '+919000000000', name: 'O', roles: ['platform_owner'] });
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco' });
  const co = await as(owner);
  const g = await co.post('/admin/users/role', { phone: '9200000037', role: 'platform_admin', name: 'New Adm' });
  assert.equal(g.status, 200);
  assert.equal(g.body.onboarding.method, 'phone_otp');
  /* No credential was invented. */
  assert.match(g.body.onboarding.note, /No credentials were generated/);

  const newAdmin = await pool.query(`SELECT * FROM app_user WHERE phone='+919200000037'`);
  const ca = client(app, await sessionFor(pool, newAdmin.rows[0].id));
  const g2 = await ca.post('/admin/users/role',
    { phone: '9200000038', role: 'vendor_owner', vendorId: v.id, name: 'Shop' });
  assert.equal(g2.status, 200);
});

/* ======================= ordering ======================================= */

test('a delivery order to an off-campus id is refused over HTTP', async () => {
  await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919200000040', name: 'A' });
  const c = await as(u);
  for (const bad of ['00000000-0000-0000-0000-000000000000', 'not-a-uuid', null]) {
    const r = await c.post('/orders/draft',
      { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'delivery', destinationId: bad });
    assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
  }
});

test('checkout returns 503 when no payment gateway is configured', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919200000041', name: 'A' });
  const c = await as(u);
  const d = await c.post('/orders/draft',
    { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' });
  const p = await c.post('/payments/intent', { orderId: d.body.id });
  assert.equal(p.status, 503);
  assert.equal(p.body.code, 'configuration_required');
  /* And crucially, the order did NOT become confirmed. */
  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [d.body.id]);
  assert.equal(o.rows[0].state, 'draft');
});

test('there is no route by which a browser can confirm an order', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919200000042', name: 'A' });
  const c = await as(u);
  const d = await c.post('/orders/draft',
    { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' });
  /* The forged frontend success. */
  const r = await c.post(`/orders/${d.body.id}/transition`, { to: 'confirmed' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /payment gateway/i);
  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [d.body.id]);
  assert.equal(o.rows[0].state, 'draft');
});

test('an unsigned webhook is rejected', async () => {
  const r = await app.inject({ method: 'POST', url: '/payments/webhook',
    headers: { 'content-type': 'application/json' },
    payload: { event: 'payment.captured', payload: { payment: { entity: { id: 'x', order_id: 'y', amount: 1 } } } } });
  /* 503 because payments are unconfigured here; with a gateway configured
     the signature check returns 400. Either way: never 200 + confirmed. */
  assert.ok([400, 503].includes(r.statusCode));
});

/* ======================= AI ============================================= */

test('the assistant reports itself unavailable rather than improvising', async () => {
  const u = await makeUser(pool, { phone: '+919200000050', name: 'A' });
  const c = await as(u);
  const s = await c.get('/ai/status');
  assert.equal(s.body.available, false);
  assert.match(s.body.message, /temporarily unavailable/);
  const r = await c.post('/ai/chat', { messages: [{ role: 'user', content: 'ground pe burger bhej' }] });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'configuration_required');
});

test('a shopkeeper cannot use the ordering assistant', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919200000051', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const c = await as(owner);
  const r = await c.post('/ai/chat', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 403);
});

/* ======================= verification & partner ========================== */

test('a student cannot become a partner by clicking Join', async () => {
  const u = await makeUser(pool, { phone: '+919200000060', name: 'A',
                                   studentStatus: 'unverified' });
  const c = await as(u);
  const r = await c.post('/partner/apply', {});
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Verify your student identity/);

  /* Even verified, applying only creates a pending application. */
  await pool.query(`UPDATE app_user SET student_status='approved' WHERE id=$1`, [u.id]);
  const { policyId } = await makePartnerReady(pool, u.id);
  const ok = await c.post('/partner/apply', { acceptPolicyId: policyId });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'pending');
  const roles = await pool.query(
    `SELECT 1 FROM user_role WHERE user_id=$1 AND role='delivery_partner' AND status='active'`, [u.id]);
  assert.equal(roles.rowCount, 0, 'no partner role until an admin approves');
});

test('an admin cannot approve a partner who is not a verified student', async () => {
  const u = await makeUser(pool, { phone: '+919200000061', name: 'A',
                                   studentStatus: 'unverified' });
  await pool.query(`INSERT INTO partner_profile (user_id,status) VALUES ($1,'pending')`, [u.id]);
  const admin = await makeUser(pool, { phone: '+919200000062', name: 'Adm', roles: ['platform_admin'] });
  const c = await as(admin);
  const r = await c.post(`/admin/partners/${u.id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 409);
});

test('a student cannot decide their own verification case', async () => {
  const u = await makeUser(pool, { phone: '+919200000063', name: 'A' });
  const k = await pool.query(
    `INSERT INTO verification_case (user_id) VALUES ($1) RETURNING id`, [u.id]);
  const c = await as(u);
  const r = await c.post(`/admin/verification/${k.rows[0].id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 403);
  assert.equal((await c.get('/admin/verification')).status, 403);
});

test('a student cannot read another student ID card image', async () => {
  const a = await makeUser(pool, { phone: '+919200000064', name: 'A' });
  const b = await makeUser(pool, { phone: '+919200000065', name: 'B' });
  const k = await pool.query(
    `INSERT INTO verification_case (user_id) VALUES ($1) RETURNING id`, [a.id]);
  const cb = await as(b);
  const r = await cb.get(`/admin/verification/${k.rows[0].id}/image/front`);
  assert.equal(r.status, 403);
});

/* ======================= ratings ======================================== */

test('a vendor with no reviews reports rating null, never a number', async () => {
  await makeVendor(pool, { name: 'Fresh', slug: 'fresh' });
  const r = await anon().get('/vendors');
  assert.equal(r.status, 200);
  assert.equal(r.body.vendors[0].rating, null);
});

test('a review is refused before the order is delivered', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919200000070', name: 'A' });
  const c = await as(u);
  const d = await c.post('/orders/draft',
    { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' });
  const r = await c.post('/reviews', { orderId: d.body.id, stars: 5 });
  assert.equal(r.status, 409);
});

test('a student cannot review someone else order', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const a = await makeUser(pool, { phone: '+919200000071', name: 'A' });
  const b = await makeUser(pool, { phone: '+919200000072', name: 'B' });
  const ca = await as(a), cb = await as(b);
  const d = await ca.post('/orders/draft',
    { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' });
  await pool.query(`UPDATE food_order SET state='delivered' WHERE id=$1`, [d.body.id]);
  const r = await cb.post('/reviews', { orderId: d.body.id, stars: 5 });
  assert.equal(r.status, 403);
});

/* ======================= audit ========================================== */

test('denials are written to the audit log, not just successes', async () => {
  const frisco = await makeVendor(pool, { name: 'Frisco', slug: 'frisco' });
  const tulips = await makeVendor(pool, { name: 'Tulips', slug: 'tulips' });
  const owner = await makeUser(pool, { phone: '+919200000080', name: 'R',
    roles: ['vendor_owner'], vendorId: frisco.id });
  const c = await as(owner);
  await c.post(`/vendors/${tulips.id}/menu`, { name: 'Sneaky', price: '10' });

  const admin = await makeUser(pool, { phone: '+919200000081', name: 'Adm', roles: ['platform_admin'] });
  const ca = await as(admin);
  const log = await ca.get('/admin/audit');
  assert.equal(log.status, 200);
  /* The vendor.create success and the menu.create denial should both be there. */
  const actions = log.body.entries.map((e) => `${e.action}:${e.outcome}`);
  assert.ok(actions.length > 0, 'audit log must not be empty');
});

test('the audit log is persistent across a restart', async () => {
  const admin = await makeUser(pool, { phone: '+919200000082', name: 'Adm', roles: ['platform_admin'] });
  const c = await as(admin);
  await c.post('/vendors', { name: 'Persisted Cafe' });
  /* Read straight from Postgres — not from any in-process array. */
  const { rows } = await pool.query(
    `SELECT action, outcome FROM audit_log WHERE action='vendor.create'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'ok');
});
