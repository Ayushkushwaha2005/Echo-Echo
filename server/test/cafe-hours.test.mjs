/* ==========================================================================
   CAFÉ HOURS AND THE CHAI GARAM MENU (migration 026)
   Mon-Sat 08:00-18:00 campus time, Sunday closed; the schedule never opens a
   switched-off café; delivery has no hours of its own. The menu is exactly
   the legible rows of the owner's photo at source + Rs 10.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, campusId } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';
import { hoursOf, orderableNow, campusClock } from '../src/services/hours.js';

const M026 = fs.readFileSync(fileURLToPath(new URL('../src/db/026_cafe_hours_chai_garam_menu.sql', import.meta.url)), 'utf8');
const DATA = M026.slice(M026.indexOf('UPDATE vendor SET open_days'));
const SCHED = { open_days: [1, 2, 3, 4, 5, 6], opens_at: '08:00:00', closes_at: '18:00:00', is_open: true, accepting: true };
const at = (iso) => new Date(iso);   // UTC; campus time is +05:30

let app, pool, cid, nth = 0;
before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.3@stu.upes.ac.in';
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => {
  await truncateAll(pool);
  cid = await campusId(pool);
  for (const [slug, name] of [['chai-garam', 'Chai Garam'], ['tulips', 'Tulips Cafe']]) {
    await pool.query(`INSERT INTO vendor (slug, name, campus_site_id, is_open, accepting, active)
                      VALUES ($1, $2, $3, false, false, true)`, [slug, name, cid]);
  }
  await pool.query(DATA);
});
const student = async () => client(app, await sessionFor(pool,
  (await makeUser(pool, { phone: `+91961000${String(1000 + nth++).slice(-4)}`, name: 'Test Student' })).id));

test('Mon-Sat 8 AM-6 PM in campus time; Sunday closed; the edges are exact', () => {
  assert.equal(hoursOf(SCHED).label, 'Mon–Sat 8 AM–6 PM · Sun closed');
  assert.deepEqual(hoursOf(SCHED).week.map((d) => d.hours).slice(5), ['8 AM–6 PM', 'Closed']);
  assert.equal(orderableNow(SCHED, at('2026-09-28T02:29:00Z')), false, 'Mon 07:59 IST');
  assert.equal(orderableNow(SCHED, at('2026-09-28T02:30:00Z')), true, 'Mon 08:00 IST');
  assert.equal(orderableNow(SCHED, at('2026-09-28T12:29:00Z')), true, 'Mon 17:59 IST');
  assert.equal(orderableNow(SCHED, at('2026-09-28T12:30:00Z')), false, 'Mon 18:00 IST');
  assert.equal(orderableNow(SCHED, at('2026-09-26T06:00:00Z')), true, 'Sat 11:30 IST');
  const sun = at('2026-09-27T06:00:00Z');
  assert.equal(orderableNow(SCHED, sun), false, 'Sun 11:30 IST');
  assert.match(hoursOf(SCHED, sun).closedReason, /Closed today \(Sun\)/);
});

test('a schedule never opens a switched-off café, and no schedule changes nothing', () => {
  assert.equal(orderableNow({ ...SCHED, accepting: false }, at('2026-09-28T06:00:00Z')), false);
  assert.equal(orderableNow({ is_open: true, accepting: true, open_days: null }, at('2026-09-27T06:00:00Z')), true);
});

test('both cafés carry the owner\'s hours; Frisco is not brought back; the switches are untouched', async () => {
  const { rows } = await pool.query(`SELECT slug, open_days, opens_at::text, closes_at::text, is_open, accepting FROM vendor ORDER BY slug`);
  assert.deepEqual(rows.map((r) => r.slug), ['chai-garam', 'tulips']);
  for (const r of rows) {
    assert.deepEqual([r.open_days, r.opens_at, r.closes_at, r.is_open, r.accepting], [[1, 2, 3, 4, 5, 6], '08:00:00', '18:00:00', false, false]);
  }
  const list = (await (await student()).get('/vendors')).body.vendors;
  assert.ok(!list.some((v) => /frisco/i.test(v.name)));
  for (const v of list) {
    assert.equal(v.hours.label, 'Mon–Sat 8 AM–6 PM · Sun closed');
    assert.equal(v.hours.week[6].hours, 'Closed');
    assert.equal(v.open_now, false, 'switched off, so closed whatever the hour');
  }
});

test('the Chai Garam menu: 67 legible items at source + Rs 10, nothing unresolved added', async () => {
  const v = (await pool.query(`SELECT id FROM vendor WHERE slug = 'chai-garam'`)).rows[0];
  const menu = (await (await student()).get(`/vendors/${v.id}/menu`)).body.items;
  assert.equal(menu.length, 67);
  const price = (n) => menu.find((i) => i.name === n)?.price_paise;
  assert.equal(price('Adrak Chai'), 3500);
  assert.equal(price('Chai Garam Special'), 7000);
  assert.equal(price('Chamomile'), 9000);
  assert.equal(price('Tandoori Chicken Wrap'), 13000);
  assert.equal(price('Chicken Nuggets (5 pcs)'), 12000);
  /* Every price in the migration is its source column + 10. */
  for (const m of DATA.matchAll(/\('[^']+', \d+, '([^']+)', (\d+), (?:true|false|NULL)\)/g)) {
    assert.equal(price(m[1]), (Number(m[2]) + 10) * 100, m[1]);
  }
  for (const unresolved of ['Oreo', 'Nimbu Pani', 'Hot Chocolate', 'Black Coffee', 'Cheese Maggi', 'Vada Pav', 'Poha']) {
    assert.ok(!menu.some((i) => i.name.toLowerCase().includes(unresolved.toLowerCase())), unresolved);
  }
  assert.ok(menu.every((i) => i.available));
  /* Running the data section again adds nothing. */
  await pool.query(DATA);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM menu_item WHERE vendor_id = $1`, [v.id])).rows[0].n, 67);
});

test('an order outside the café\'s hours is refused with the reason; delivery adds no hours', async () => {
  const v = await makeVendor(pool, { name: 'Hours Outlet', slug: `hours-${nth++}` });
  const item = await makeItem(pool, v.id, { name: 'Tea', paise: 2000 });
  const { weekday } = campusClock();
  const others = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== weekday);
  await pool.query(`UPDATE vendor SET open_days = $2, opens_at = '00:00', closes_at = '23:59' WHERE id = $1`, [v.id, others]);
  const s = await student();
  const shut = await s.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'pickup' });
  assert.equal(shut.status, 409);
  assert.match(shut.body.error, /closed right now/);
  assert.match(shut.body.detail, /Closed today/);
  await pool.query(`UPDATE vendor SET open_days = '{1,2,3,4,5,6,7}' WHERE id = $1`, [v.id]);
  assert.equal((await s.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'pickup' })).status, 200);
});
