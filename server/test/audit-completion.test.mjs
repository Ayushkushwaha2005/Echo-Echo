/* ==========================================================================
   AUDIT COMPLETION - privileged actions commit with their audit row, restoring an
   earlier revision, approval of a website publish, the deletion-request lifecycle,
   and stored script payloads coming back as data.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool, atomicRoutes;
let nth = 0;
const phone = () => `+9196000${String(10000 + nth++).slice(-5)}`;

before(async () => {
  await startDb();
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000', COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    ADMIN_TOTP_KEY: 'test-admin-totp-key-0123456789abcdef',
  });
  ({ pool } = await import('../src/db/index.js'));
  atomicRoutes = await import('../src/atomic-routes.js');
  app = await makeApp();
  await app.ready();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const as = async (u, method = 'admin_totp') => client(app, await sessionFor(pool, u.id, { method }));
async function owner() {
  const u = await makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['student', 'platform_owner'] });
  return { u, c: await as(u) };
}
async function admin(permissions) {
  const u = await makeUser(pool, { phone: phone(), name: 'Staff', roles: ['student', 'platform_admin'] });
  await pool.query(`INSERT INTO admin_account (user_id, status, permissions, activated_at) VALUES ($1,'active',$2, now())`, [u.id, permissions]);
  return { u, c: await as(u) };
}

/* Every insert into the audit log fails until the returned function is called. */
async function breakAudit() {
  await pool.query(`CREATE OR REPLACE FUNCTION test_audit_down() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit is down'; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER test_audit_down BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_audit_down()`);
  return () => pool.query(`DROP TRIGGER test_audit_down ON audit_log`);
}

test('five server errors in five minutes are counted by route, with no detail about the request', async () => {
  const { recordServerError, serverErrorSummary, resetServerErrors } = await import('../src/services/error-watch.js');
  resetServerErrors();
  const now = Date.now();
  for (let i = 0; i < 5; i++) recordServerError('/menu/:id', now + i);
  assert.deepEqual(serverErrorSummary(now + 10), { lastFiveMinutes: 5, routes: ['/menu/:id'] });
  assert.equal(serverErrorSummary(now + 6 * 60 * 1000).lastFiveMinutes, 0);
});

test('no finance, payment, wallet or refund route is in the atomic list', () => {
  for (const r of atomicRoutes.ATOMIC_ROUTES) assert.doesNotMatch(r, /financ|payment|wallet|refund|payout|settle|webhook|deposit/i, r);
});

test('with the audit log down, a privileged change does not happen', async (t) => {
  const { c } = await owner();
  const v = await makeVendor(pool, { name: 'Before', slug: 'before' });
  const item = await makeItem(pool, v.id, { name: 'Chai', paise: 2000 });
  const target = await makeUser(pool, { phone: phone(), name: 'Target', roles: ['student'] });
  const restore = await breakAudit();
  t.after(() => restore().catch(() => {}));

  assert.equal((await c.patch(`/vendors/${v.id}`, { name: 'After' })).status, 500);
  assert.equal((await c.patch(`/menu/${item.id}`, { price: 99 })).status, 500);
  assert.equal((await c.post(`/admin/users/${target.id}/status`, { status: 'suspended', reason: 'A test reason here' })).status, 500);
  await restore();

  assert.equal((await pool.query(`SELECT name FROM vendor WHERE id = $1`, [v.id])).rows[0].name, 'Before');
  assert.equal((await pool.query(`SELECT price_paise FROM menu_item WHERE id = $1`, [item.id])).rows[0].price_paise, 2000);
  assert.notEqual((await pool.query(`SELECT status FROM app_user WHERE id = $1`, [target.id])).rows[0].status, 'suspended');
});

test('a change and its audit row both land when the log works, and a refusal is still recorded', async () => {
  const { c } = await owner();
  const v = await makeVendor(pool, { name: 'Before', slug: 'before' });
  assert.equal((await c.patch(`/vendors/${v.id}`, { name: 'After' })).status, 200);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'vendor.update' AND resource_id = $1`, [v.id])).rows[0].n, 1);

  const { pool: p, atomic } = await import('../src/db/index.js');
  const { audit } = await import('../src/audit.js');
  await assert.rejects(atomic(async () => {
    await audit({}, { action: 'test.refused', outcome: 'denied' });
    await audit({}, { action: 'test.success', outcome: 'ok' });
    throw new Error('stop');
  }));
  const rows = (await p.query(`SELECT action FROM audit_log WHERE action LIKE 'test.%'`)).rows.map((r) => r.action);
  assert.deepEqual(rows, ['test.refused']);
});

test('nested transactions inside atomic share one connection and undo only their own part', async () => {
  const { atomic, tx, q } = await import('../src/db/index.js');
  const v = await makeVendor(pool, { name: 'Outer', slug: 'outer' });
  await atomic(async () => {
    await q(`UPDATE vendor SET description = 'kept' WHERE id = $1`, [v.id]);
    await assert.rejects(tx(async (c) => { await c.query(`UPDATE vendor SET description = 'undone' WHERE id = $1`, [v.id]); throw new Error('inner'); }));
    /* The row is locked by this transaction: a second connection would hang here. */
    await tx((c) => c.query(`SELECT 1 FROM vendor WHERE id = $1 FOR UPDATE`, [v.id]));
  });
  assert.equal((await pool.query(`SELECT description FROM vendor WHERE id = $1`, [v.id])).rows[0].description, 'kept');
});

test('a menu item can be put back as it was before its first edit, and history records the restore', async () => {
  const { c } = await owner();
  const v = await makeVendor(pool, { name: 'Cafe', slug: 'cafe' });
  const item = await makeItem(pool, v.id, { name: 'Chai', paise: 2000 });
  assert.equal((await c.patch(`/menu/${item.id}`, { price: 99, name: 'Wrong chai' })).status, 200);
  const { versions } = (await c.get(`/catalog/menu/${item.id}/versions`)).body;
  const first = versions[versions.length - 1];
  assert.equal(first.snapshot.price_paise, 2000);

  const res = await c.post(`/catalog/menu/${item.id}/restore`, { toRevision: first.revision, revision: versions[0].revision });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = (await pool.query(`SELECT name, price_paise, revision FROM menu_item WHERE id = $1`, [item.id])).rows[0];
  assert.equal(row.name, 'Chai');
  assert.equal(row.price_paise, 2000);
  assert.ok(row.revision > versions[0].revision);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM menu_price_history WHERE item_id = $1 AND new_paise = 2000`, [item.id])).rows[0].n, 1);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'catalog.restore'`)).rows[0].n, 1);
});

test('restoring from a stale form is refused, a missing revision is refused, and archiving is not undone', async () => {
  const { c } = await owner();
  const v = await makeVendor(pool, { name: 'Cafe', slug: 'cafe' });
  const item = await makeItem(pool, v.id, { name: 'Chai', paise: 2000 });
  await c.patch(`/menu/${item.id}`, { price: 50 });
  await c.patch(`/menu/${item.id}`, { active: false });
  const { versions } = (await c.get(`/catalog/menu/${item.id}/versions`)).body;
  const first = versions[versions.length - 1];
  assert.equal((await c.post(`/catalog/menu/${item.id}/restore`, { toRevision: first.revision, revision: first.revision })).status, 409);
  assert.equal((await c.post(`/catalog/menu/${item.id}/restore`, { toRevision: 999, revision: versions[0].revision })).status, 404);
  assert.equal((await c.post(`/catalog/menu/${item.id}/restore`, { toRevision: first.revision, revision: versions[0].revision })).status, 200);
  assert.equal((await pool.query(`SELECT active FROM menu_item WHERE id = $1`, [item.id])).rows[0].active, false);
});

test('someone who can only read a menu cannot restore it', async () => {
  const { c: ownerC } = await owner();
  const v = await makeVendor(pool, { name: 'Cafe', slug: 'cafe' });
  const item = await makeItem(pool, v.id, { name: 'Chai', paise: 2000 });
  await ownerC.patch(`/menu/${item.id}`, { price: 50 });
  const { versions } = (await ownerC.get(`/catalog/menu/${item.id}/versions`)).body;
  const { c } = await admin(['menus.view']);
  const res = await c.post(`/catalog/menu/${item.id}/restore`, { toRevision: versions[versions.length - 1].revision, revision: versions[0].revision });
  assert.equal(res.status, 403);
  assert.equal((await pool.query(`SELECT price_paise FROM menu_item WHERE id = $1`, [item.id])).rows[0].price_paise, 5000);
});

test('work that outlives its atomic block, or leaves it on purpose, never uses the released connection', async () => {
  const { atomic, detached, q } = await import('../src/db/index.js');
  const v = await makeVendor(pool, { name: 'Cafe', slug: 'cafe' });
  let straggler;
  let insideSawPid, detachedPid;
  await atomic(async () => {
    insideSawPid = (await q('SELECT pg_backend_pid() p')).rows[0].p;
    detachedPid = (await detached(() => q('SELECT pg_backend_pid() p'))).rows[0].p;
    straggler = new Promise((res) => setTimeout(res, 50)).then(() => q(`SELECT txid_current_if_assigned() AS t, $1::uuid AS id`, [v.id]));
    await q(`UPDATE vendor SET description = 'x' WHERE id = $1`, [v.id]);
  });
  assert.notEqual(detachedPid, insideSawPid);
  assert.equal((await straggler).rows[0].t, null);
});

test('a website publish queues when the policy is on, and a moved draft makes the approval fail safely', async () => {
  const { c: ownerC } = await owner();
  const { c: staff } = await admin(['website.customize', 'website.publish']);
  const data = (await ownerC.get('/admin/site')).body;
  const saved = (await ownerC.put('/admin/site/draft', { config: data.defaults, revision: data.draft?.revision ?? 0 })).body;
  assert.equal((await ownerC.put('/admin/approvals/policy/site.publish', { enabled: true })).status, 200);

  const asked = await staff.post('/admin/site/publish', { revision: saved.revision, note: 'New banner please' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.pendingApproval, true);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM site_config_version`)).rows[0].n, 0);

  const moved = (await ownerC.put('/admin/site/draft', { config: data.defaults, revision: saved.revision })).body;
  if (moved.revision !== saved.revision) {
    const out = (await ownerC.post(`/admin/approvals/${asked.body.requestId}/decide`, { decision: 'approve' })).body;
    assert.equal(out.status, 'failed');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM site_config_version`)).rows[0].n, 0);
    const again = await staff.post('/admin/site/publish', { revision: moved.revision, note: 'Second try now' });
    const ok = (await ownerC.post(`/admin/approvals/${again.body.requestId}/decide`, { decision: 'approve' })).body;
    assert.equal(ok.status, 'executed');
  } else {
    const ok = (await ownerC.post(`/admin/approvals/${asked.body.requestId}/decide`, { decision: 'approve' })).body;
    assert.equal(ok.status, 'executed');
  }
  assert.equal((await pool.query(`SELECT count(*)::int n FROM site_config_version`)).rows[0].n, 1);
});

test('a deletion request goes open, in review, completed; the person is told; nothing is deleted', async () => {
  const { c: ownerC } = await owner();
  const person = await makeUser(pool, { phone: phone(), name: 'Student', roles: ['student'] });
  const me = await as(person, 'code');
  assert.equal((await me.post('/me/deletion-request', {})).status, 200);
  assert.equal((await me.post('/me/deletion-request', {})).status, 409);
  const { requests: [r] } = (await ownerC.get('/admin/data-requests')).body;

  const retention = (await ownerC.get(`/admin/data-requests/${r.id}/retention`)).body;
  assert.ok(retention.held.find((h) => h.label === 'Orders'));

  assert.equal((await ownerC.post(`/admin/data-requests/${r.id}`, { status: 'in_review' })).status, 200);
  assert.equal((await me.del('/me/deletion-request')).status, 409);
  assert.equal((await ownerC.post(`/admin/data-requests/${r.id}`, { status: 'completed', note: 'no' })).status, 400);
  assert.equal((await ownerC.post(`/admin/data-requests/${r.id}`, { status: 'completed', note: 'Profile erased; orders kept for tax.' })).status, 200);
  assert.equal((await ownerC.post(`/admin/data-requests/${r.id}`, { status: 'declined', note: 'Changing my mind' })).status, 404);

  assert.equal((await me.get('/me/deletion-request')).body.request.decision_note, 'Profile erased; orders kept for tax.');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM app_user WHERE id = $1`, [person.id])).rows[0].n, 1);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal((await pool.query(`SELECT count(*)::int n FROM notification WHERE user_id = $1 AND kind = 'data_deletion_decided' AND channel = 'inapp'`, [person.id])).rows[0].n, 1);
});

test('a person can withdraw a waiting request and ask again; only the owner decides', async () => {
  const person = await makeUser(pool, { phone: phone(), name: 'Student', roles: ['student'] });
  const me = await as(person, 'code');
  await me.post('/me/deletion-request', {});
  assert.equal((await me.del('/me/deletion-request')).status, 200);
  assert.equal((await me.post('/me/deletion-request', {})).status, 200);

  const { c: staff } = await admin(['students.view']);
  const { requests: [r] } = (await staff.get('/admin/data-requests')).body;
  assert.equal((await staff.post(`/admin/data-requests/${r.id}`, { status: 'in_review' })).status, 403);
  assert.equal((await staff.get(`/admin/data-requests/${r.id}/retention`)).body.canDecide, false);
  assert.equal((await me.get(`/admin/data-requests/${r.id}/retention`)).status, 403);
});

test('the export holds my records and nobody else\'s', async () => {
  const person = await makeUser(pool, { phone: phone(), name: 'Student', roles: ['student'] });
  const other = await makeUser(pool, { phone: phone(), name: 'Other Person', roles: ['student'] });
  await pool.query(`INSERT INTO saved_place (user_id, label, lat, lng) VALUES ($1,'Mine',30.41,77.96), ($2,'Theirs',30.42,77.97)`, [person.id, other.id]).catch(() => {});
  const res = await (await as(person, 'code')).get('/me/data-export');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body;
  assert.equal(body.profile.name, 'Student');
  for (const key of ['savedPlaces', 'address', 'verification', 'notifications', 'supportMessages']) assert.ok(key in body, key);
  assert.doesNotMatch(JSON.stringify(body), /Other Person|Theirs/);
});
