/* ==========================================================================
   THE CAFÉ IS CALLED "TULIPS" (migration 032)
   The one existing record is renamed in place: same id, same slug, its orders
   and payments untouched and now shown under the new name. Chai Garam and
   other places keep their names; re-running changes nothing.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, truncateAll, makeUser, campusId } from './helpers/db.mjs';
import { makeApp, client } from './helpers/api.mjs';

const M032 = fs.readFileSync(fileURLToPath(new URL('../src/db/032_tulips_name.sql', import.meta.url)), 'utf8');

let app, pool, orderNote, cid, tulips, chai, node, order;
before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.3@stu.upes.ac.in';
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  ({ orderNote } = await import('../src/services/payment-providers.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });

const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
/* Everything that carries money or history, keyed by id, as it stands. */
const history = async () => (await pool.query(
  `SELECT o.id, o.code, o.vendor_id, o.state, o.total_paise, o.destination_snapshot,
          p.id AS payment_id, p.provider_order_id, p.amount_paise, p.status
     FROM food_order o LEFT JOIN payment p ON p.order_id = o.id ORDER BY o.code`)).rows;

beforeEach(async () => {
  await truncateAll(pool);
  cid = await campusId(pool);
  /* The records exactly as migration 022 left them. */
  node = await one(`INSERT INTO campus_node (campus_site_id, kind, name, lat, lng, source, verification)
                    VALUES ($1, 'spot', 'Tulips Cafe', 30.416383, 77.969702, 'survey', 'pending') RETURNING *`, [cid]);
  tulips = await one(`INSERT INTO vendor (slug, name, campus_site_id, campus_node_id, is_open, accepting, active)
                      VALUES ('tulips', 'Tulips Cafe', $1, $2, false, true, true) RETURNING *`, [cid, node.id]);
  chai = await one(`INSERT INTO vendor (slug, name, campus_site_id, is_open, accepting, active)
                    VALUES ('chai-garam', 'Chai Garam', $1, false, true, true) RETURNING *`, [cid]);
  const cu = await makeUser(pool, { phone: '+919612000001', name: 'Old Order' });
  order = await one(`INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise,
                                             destination_snapshot)
                     VALUES ('EE-7001', $1, $2, 'pickup', 'delivered', 15000, 16000, $3) RETURNING *`,
                    [cu.id, tulips.id, JSON.stringify({ label: 'Tulips Cafe' })]);
  await pool.query(`INSERT INTO payment (order_id, provider, provider_order_id, provider_payment_id, amount_paise, status)
                    VALUES ($1, 'cashfree', 'cf_EE-7001', '5114001', 16000, 'paid')`, [order.id]);
});

test('Tulips is renamed in place: same id and slug, orders and payments untouched', async () => {
  const before = await history();
  await pool.query(M032);

  const v = await one(`SELECT * FROM vendor WHERE slug = 'tulips'`);
  assert.equal(v.id, tulips.id, 'the canonical record, not a duplicate');
  assert.equal(v.name, 'Tulips');
  assert.equal((await one(`SELECT count(*)::int AS n FROM vendor WHERE slug = 'tulips' OR name ILIKE 'tulips%'`)).n, 1);
  assert.deepEqual(await history(), before, 'orders, payments and their references are exactly as they were');
  assert.deepEqual(order.destination_snapshot, { label: 'Tulips Cafe' }, 'a snapshot is history');
  assert.equal((await one(`SELECT name FROM campus_node WHERE id = $1`, [node.id])).name, 'Tulips');

  const c = await one(`SELECT * FROM vendor WHERE slug = 'chai-garam'`);
  assert.deepEqual([c.id, c.name, c.active, c.accepting], [chai.id, 'Chai Garam', true, true], 'Chai Garam is not touched');

  const a = (await pool.query(`SELECT * FROM audit_log WHERE action = 'vendor.rename'`)).rows;
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].resource_id, a[0].detail.from, a[0].detail.to], [tulips.id, 'Tulips Cafe', 'Tulips']);
});

test('the old order now reads "Tulips" wherever the name is joined', async () => {
  await pool.query(M032);
  const r = await one(`SELECT v.name FROM food_order o JOIN vendor v ON v.id = o.vendor_id WHERE o.id = $1`, [order.id]);
  assert.equal(r.name, 'Tulips');
  const names = (await client(app).get('/vendors')).body.vendors.map((x) => x.name).sort();
  assert.deepEqual(names, ['Chai Garam', 'Tulips']);
  assert.equal(orderNote(order.code, r.name), 'ECHO ECHO order EE-7001 from Tulips');
});

test('running it again, or on a database without Tulips, changes nothing', async () => {
  await pool.query(M032);
  await pool.query(M032);
  assert.equal((await one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'vendor.rename'`)).n, 1);

  /* A place someone already renamed by hand is left as they named it. */
  await pool.query(`UPDATE vendor SET name = 'Tulips Cafe' WHERE id = $1`, [tulips.id]);
  await pool.query(`UPDATE campus_node SET name = 'Tulips counter' WHERE id = $1`, [node.id]);
  await pool.query(M032);
  assert.equal((await one(`SELECT name FROM campus_node WHERE id = $1`, [node.id])).name, 'Tulips counter');

  await pool.query(`DELETE FROM payment`); await pool.query(`DELETE FROM food_order`);
  await pool.query(`DELETE FROM vendor WHERE slug = 'tulips'`);
  await pool.query(M032);
  assert.equal((await one(`SELECT count(*)::int AS n FROM vendor`)).n, 1, 'nothing is created');
});

test('the Cashfree order note names the café, safely', () => {
  assert.equal(orderNote('EE-1', 'Tulips'), 'ECHO ECHO order EE-1 from Tulips');
  assert.equal(orderNote('EE-2', 'Café Frisco'), 'ECHO ECHO order EE-2 from Cafe Frisco');
  assert.equal(orderNote('EE-3', '<script>"x"</script>'), 'ECHO ECHO order EE-3 from scriptxscript');
  assert.equal(orderNote('EE-4', ''), 'ECHO ECHO order EE-4');
  assert.ok(orderNote('EE-5', 'x'.repeat(500)).length <= 200);
});
