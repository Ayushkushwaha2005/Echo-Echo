/* ==========================================================================
   OWNER-ATTESTED OFFLINE RECORDS (src/routes/offline-records.js, migration 047)

   Figures from the offline books are the owner's attestation: only the owner
   records or withdraws them, every change is audited, a figure is never
   edited or deleted, and none of it reaches the ledger, orders, payouts or
   the finance summary.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool, parseRecord, perms;
before(async () => {
  await startDb();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  ({ pool } = await import('../src/db/index.js'));
  ({ parseRecord } = await import('../src/routes/offline-records.js'));
  perms = await import('../src/auth/permissions.js');
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); await pool.query('TRUNCATE admin_account'); });

let seq = 0;
const phone = () => '+9197' + String(10000000 + (++seq) * 7717 % 89999999).padStart(8, '0');
const owner = async () => {
  const u = await makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['platform_owner'] });
  return { u, c: client(app, await sessionFor(pool, u.id, { method: 'passkey' })) };
};
async function admin(permissions) {
  const u = await makeUser(pool, { phone: phone(), name: 'Admin ' + seq, roles: ['platform_admin'] });
  await pool.query(`INSERT INTO admin_account (user_id, status, permissions, activated_at) VALUES ($1,'active',$2, now())`, [u.id, permissions]);
  return { u, c: client(app, await sessionFor(pool, u.id, { method: 'passkey' })) };
}
const ORDERS = { metric: 'orders', value: 126, periodEnd: '2026-11-15', sourceReference: 'Order book 1, pages 1-9' };
const count = async (table) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

test('the owner records a figure: it is listed with its source, period and attester, and audited', async () => {
  const o = await owner();
  const r = await o.c.post('/admin/offline-records', ORDERS);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.metric, 'orders');
  assert.equal(r.body.value, 126);
  assert.equal(r.body.periodEnd, '2026-11-15');
  assert.equal(r.body.source, 'Offline pen-and-paper business records');
  assert.equal(r.body.sourceReference, 'Order book 1, pages 1-9');
  assert.equal(r.body.attestedBy, 'Owner');
  assert.equal(r.body.withdrawn, null);

  const list = await o.c.get('/admin/offline-records');
  assert.equal(list.status, 200);
  assert.equal(list.body.records.length, 1);
  assert.match(list.body.basis, /Not part of the ledger, settlements or payouts/);

  const audit = (await pool.query(`SELECT actor_id, action, resource_id, outcome FROM audit_log WHERE action = 'offline_record.attest'`)).rows;
  assert.deepEqual(audit, [{ actor_id: o.u.id, action: 'offline_record.attest', resource_id: r.body.id, outcome: 'ok' }]);
});

test('recording figures touches nothing in the books: no orders, payments, ledger entries or payouts, and the finance summary is unchanged', async () => {
  const o = await owner();
  const before = (await o.c.get('/admin/finance/summary')).body;
  const tables = ['food_order', 'payment', 'ledger_txn', 'ledger_entry', 'payout', 'order_financials'];
  const counts = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)])));
  for (const body of [ORDERS,
    { metric: 'gmv', value: 486000, periodStart: '2026-11-15', periodEnd: '2026-11-15' },
    { metric: 'cafe_payable', value: 891500, periodEnd: '2026-11-15', counterparty: 'Chai Garam' },
    { metric: 'partner_payable', value: 124000, periodEnd: '2026-11-15' }]) {
    assert.equal((await o.c.post('/admin/offline-records', body)).status, 200);
  }
  for (const t of tables) assert.equal(await count(t), counts[t], `${t} must not change`);
  assert.deepEqual((await o.c.get('/admin/finance/summary')).body, before);
});

test('only the owner records or withdraws; an administrator with finance.view can read; one without cannot', async () => {
  const o = await owner();
  const id = (await o.c.post('/admin/offline-records', ORDERS)).body.id;
  const reader = await admin(['finance.view', 'finance.manage']);
  assert.equal((await reader.c.get('/admin/offline-records')).status, 200);
  assert.equal((await reader.c.post('/admin/offline-records', ORDERS)).status, 403);
  assert.equal((await reader.c.post(`/admin/offline-records/${id}/withdraw`, { reason: 'x' })).status, 403);
  const other = await admin(['orders.view']);
  assert.equal((await other.c.get('/admin/offline-records')).status, 403);
  const student = await makeUser(pool, { phone: phone(), name: 'Student' });
  assert.equal((await client(app, await sessionFor(pool, student.id)).get('/admin/offline-records')).status, 403);
  assert.equal(await count('offline_record'), 1);
});

test('records.attest is owner-only and can never be granted to an administrator', () => {
  assert.equal(perms.PERMISSIONS['records.attest'].ownerOnly, true);
  assert.ok(!perms.GRANTABLE_KEYS.includes('records.attest'));
});

test('a figure is validated: known metric, whole non-negative value, real dates, no future, payables only for a counterparty', () => {
  const ok = parseRecord({ ...ORDERS });
  assert.equal(ok.source, 'Offline pen-and-paper business records');
  for (const bad of [
    { ...ORDERS, metric: 'live_orders' }, { ...ORDERS, value: -1 }, { ...ORDERS, value: 1.5 }, { ...ORDERS, value: '126' },
    { ...ORDERS, periodEnd: '15/11/2026' }, { ...ORDERS, periodEnd: '2026-02-30' }, { ...ORDERS, periodEnd: '2999-01-01' },
    { ...ORDERS, periodStart: '2026-11-16', periodEnd: '2026-11-15' }, { ...ORDERS, counterparty: 'Chai Garam' },
  ]) assert.throws(() => parseRecord(bad), (e) => e.status === 400, JSON.stringify(bad));
});

test('a mistake is withdrawn with a reason, never edited or deleted: the database refuses both', async () => {
  const o = await owner();
  const id = (await o.c.post('/admin/offline-records', ORDERS)).body.id;
  assert.equal((await o.c.post(`/admin/offline-records/${id}/withdraw`, {})).status, 400);
  const w = await o.c.post(`/admin/offline-records/${id}/withdraw`, { reason: 'Page 9 was counted twice' });
  assert.equal(w.status, 200);
  assert.equal(w.body.withdrawn.reason, 'Page 9 was counted twice');
  assert.equal(w.body.withdrawn.by, 'Owner');
  assert.equal((await o.c.post(`/admin/offline-records/${id}/withdraw`, { reason: 'again' })).status, 409);
  assert.equal((await o.c.post('/admin/offline-records/00000000-0000-0000-0000-000000000000/withdraw', { reason: 'x' })).status, 404);
  assert.equal(Number((await pool.query(`SELECT count(*) FROM audit_log WHERE action = 'offline_record.withdraw'`)).rows[0].count), 1);

  const fresh = (await o.c.post('/admin/offline-records', { ...ORDERS, value: 120 })).body.id;
  await assert.rejects(pool.query(`UPDATE offline_record SET value = 999 WHERE id = $1`, [fresh]), /cannot be edited/);
  await assert.rejects(pool.query(`DELETE FROM offline_record WHERE id = $1`, [fresh]), /append-only/);
  await assert.rejects(pool.query(`UPDATE offline_record SET note = 'x' WHERE id = $1`, [id]), /withdrawn offline record cannot change/);
  const list = (await o.c.get('/admin/offline-records')).body.records;
  assert.deepEqual(list.map((r) => [r.value, !!r.withdrawn]), [[120, false], [126, true]]);
});
