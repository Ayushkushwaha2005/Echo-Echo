/* ==========================================================================
   MANUAL CAFÉ AVAILABILITY OVERRIDE (migration 045)

   With the override on, the administrator's Open/Closed is the answer on
   every surface and in the order check, whatever the weekly hours say. With
   it off, the schedule decides exactly as before. Delivery and archiving
   stay separate. Every café is independent; nothing names a real café.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';
import { statusOf, hoursOf, campusClock } from '../src/services/hours.js';

const at = (iso) => new Date(iso);   // UTC; campus time is +05:30
const SCHED = { active: true, open_days: [1, 2, 3, 4, 5, 6], opens_at: '08:00:00', closes_at: '18:00:00' };

let app, pool, nth = 0;
before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.9@stu.upes.ac.in';
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const admin = async () => {
  const u = await makeUser(pool, { phone: `+91962000${String(1000 + nth++).slice(-4)}`, name: 'Admin', roles: ['platform_admin'] });
  return client(app, await sessionFor(pool, u.id, { method: 'passkey' }));
};
const student = async () => client(app, await sessionFor(pool,
  (await makeUser(pool, { phone: `+91963000${String(1000 + nth++).slice(-4)}`, name: 'Student' })).id));

/* A café whose schedule says CLOSED right now (open only on other days),
   or OPEN right now (every day, all day). */
async function cafe(scheduleNow, name = `Café ${nth}`) {
  const v = await makeVendor(pool, { name, slug: `cafe-${nth++}` });
  const item = await makeItem(pool, v.id, { name: 'Tea', paise: 2000 });
  const { weekday } = campusClock();
  const days = scheduleNow === 'open' ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== weekday);
  await pool.query(`UPDATE vendor SET open_days = $2, opens_at = '00:00', closes_at = '23:59',
                           is_open = false, accepting = true WHERE id = $1`, [v.id, days]);
  return { v, item, order: { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'pickup' } };
}
const listed = async (c, id) => (await c.get('/vendors')).body.vendors.find((x) => x.id === id);
const menuOf = async (c, id) => (await c.get(`/vendors/${id}/menu`)).body.vendor;
const set = (a, id, body) => a.patch(`/vendors/${id}`, body);
const manualOpen = (a, id) => set(a, id, { manualAvailability: true, isOpen: true, accepting: true });
const manualClosed = (a, id) => set(a, id, { manualAvailability: true, isOpen: false, accepting: false });

/* ---------------- the rule itself, with the clock injected -------------- */

test('3/4. manual Open wins on a Sunday the schedule closes, at midnight, and overnight', () => {
  const sunNoon = at('2026-10-04T06:30:00Z');       // Sun 12:00 IST
  const midnight = at('2026-09-28T18:30:00Z');      // Tue 00:00 IST
  const justAfter = at('2026-09-28T18:31:00Z');     // Tue 00:01 IST
  const lateMon = at('2026-09-28T17:00:00Z');       // Mon 22:30 IST
  for (const now of [sunNoon, midnight, justAfter, lateMon]) {
    assert.equal(statusOf({ ...SCHED, is_open: false, accepting: true }, now).open, false, 'schedule: closed');
    const s = statusOf({ ...SCHED, manual_availability: true, is_open: true, accepting: true }, now);
    assert.deepEqual([s.open, s.state, s.line], [true, 'open', 'Open now'], String(now));
  }
  assert.equal(hoursOf({ ...SCHED, manual_availability: true }, sunNoon).closedReason, null);
});

test('2. manual Closed wins while the schedule says open', () => {
  const monNoon = at('2026-09-28T06:30:00Z');
  assert.equal(statusOf({ ...SCHED, is_open: false, accepting: true }, monNoon).open, true, 'schedule: open');
  const s = statusOf({ ...SCHED, manual_availability: true, is_open: false, accepting: true }, monNoon);
  assert.deepEqual([s.open, s.state], [false, 'closed']);
});

test('overnight schedule (18:00-02:00) stays open across midnight when the override is off', () => {
  const night = { ...SCHED, open_days: [1, 2, 3, 4, 5, 6, 7], opens_at: '18:00', closes_at: '02:00', is_open: false, accepting: true };
  assert.equal(statusOf(night, at('2026-09-28T13:00:00Z')).open, true, 'Mon 18:30');
  assert.equal(statusOf(night, at('2026-09-28T18:30:00Z')).open, true, 'Tue 00:00');
  assert.equal(statusOf(night, at('2026-09-28T20:00:00Z')).open, true, 'Tue 01:30');
  assert.equal(statusOf(night, at('2026-09-28T20:30:00Z')).open, false, 'Tue 02:00');
  assert.equal(statusOf(night, at('2026-09-28T06:30:00Z')).open, false, 'Mon 12:00');
});

/* ---------------- through the real API and database -------------------- */

test('1 & 12. Open while the schedule says closed: list, menu, search and order all agree', async () => {
  const { v, order } = await cafe('closed');
  const a = await admin(), s = await student();
  assert.equal((await listed(s, v.id)).open_now, false, 'before: schedule closed');
  assert.equal((await s.post('/orders/draft', order)).status, 409);

  const r = await manualOpen(a, v.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.open_now, true, 'the update answers with the effective status');
  const card = await listed(s, v.id), menu = await menuOf(s, v.id);
  assert.deepEqual([card.open_now, card.status.state, card.status.line], [true, 'open', 'Open now']);
  assert.deepEqual([menu.open_now, menu.status.state], [true, 'open']);
  const search = (await s.get('/menu/search?q=Tea')).body.items.find((i) => i.vendor_id === v.id);
  assert.equal(search.open_now, true);
  /* 6. cart -> checkout draft is accepted. */
  assert.equal((await s.post('/orders/draft', order)).status, 200);
});

test('2, 5 & 12. Closed while the schedule says open: every surface shows Closed and orders are blocked', async () => {
  const { v, order } = await cafe('open');
  const a = await admin(), s = await student();
  assert.equal((await listed(s, v.id)).open_now, true, 'before: schedule open');
  assert.equal((await s.post('/orders/draft', order)).status, 200);

  assert.equal((await manualClosed(a, v.id)).status, 200);
  assert.equal((await listed(s, v.id)).open_now, false);
  assert.equal((await menuOf(s, v.id)).open_now, false);
  const blocked = await s.post('/orders/draft', order);
  assert.equal(blocked.status, 409);
});

test('7 & 8. the setting survives refreshes and an API restart', async () => {
  const { v, order } = await cafe('closed');
  await manualOpen(await admin(), v.id);
  const s = await student();
  for (let i = 0; i < 3; i++) assert.equal((await listed(s, v.id)).open_now, true, `refresh ${i}`);
  await app.close();
  app = await makeApp();
  const s2 = await student();
  assert.equal((await listed(s2, v.id)).open_now, true, 'after restart');
  assert.equal((await s2.post('/orders/draft', order)).status, 200);
  const row = (await pool.query('SELECT manual_availability, is_open FROM vendor WHERE id = $1', [v.id])).rows[0];
  assert.deepEqual(row, { manual_availability: true, is_open: true });
});

test('9. delivery Offered/Unavailable is independent of Open/Closed', async () => {
  const { v } = await cafe('closed');
  const a = await admin(), s = await student();
  await manualOpen(a, v.id);
  await set(a, v.id, { deliveryEnabled: false });
  let card = await listed(s, v.id);
  assert.deepEqual([card.open_now, card.delivery_enabled], [true, false]);
  await set(a, v.id, { deliveryEnabled: true });
  await manualClosed(a, v.id);
  card = await listed(s, v.id);
  assert.deepEqual([card.open_now, card.delivery_enabled], [false, true]);
});

test('10. an archived café is unavailable whatever the override says', async () => {
  const { v, order } = await cafe('open');
  const a = await admin();
  await manualOpen(a, v.id);
  await pool.query('UPDATE vendor SET active = false WHERE id = $1', [v.id]);
  const s = await student();
  assert.equal(await listed(s, v.id), undefined, 'not listed to students');
  const menu = await menuOf(s, v.id);
  assert.deepEqual([menu.open_now, menu.status.state], [false, 'inactive']);
  assert.notEqual((await s.post('/orders/draft', order)).status, 200);
});

test('11. turning the override off hands the café back to its schedule', async () => {
  const { v, order } = await cafe('closed');
  const a = await admin(), s = await student();
  await manualOpen(a, v.id);
  assert.equal((await listed(s, v.id)).open_now, true);
  assert.equal((await set(a, v.id, { manualAvailability: false })).status, 200);
  assert.equal((await listed(s, v.id)).open_now, false, 'schedule says closed again');
  assert.equal((await s.post('/orders/draft', order)).status, 409);
});

test('multiple cafés are independent', async () => {
  const one = await cafe('closed', 'First'), two = await cafe('closed', 'Second'), three = await cafe('open', 'Third');
  const a = await admin(), s = await student();
  await manualOpen(a, one.v.id);
  await manualClosed(a, three.v.id);
  const states = await Promise.all([one, two, three].map(async (c) => (await listed(s, c.v.id)).open_now));
  assert.deepEqual(states, [true, false, false]);
  assert.equal((await s.post('/orders/draft', one.order)).status, 200);
  assert.equal((await s.post('/orders/draft', two.order)).status, 409);
});

test('the change is audited with its values; a non-boolean is refused; students cannot set it', async () => {
  const { v } = await cafe('closed');
  const a = await admin();
  await manualOpen(a, v.id);
  const row = (await pool.query(`SELECT detail FROM audit_log WHERE action = 'vendor.update' ORDER BY at DESC LIMIT 1`)).rows[0];
  assert.deepEqual(row.detail.availability, { manual: true, isOpen: true, accepting: true, effective: 'open' });
  assert.equal((await set(a, v.id, { manualAvailability: 'yes' })).status, 400);
  const s = await student();
  assert.equal((await set(s, v.id, { manualAvailability: true, isOpen: true })).status, 403);
});

test('without the override nothing changes: is_open is still not read for a scheduled café', async () => {
  const { v, order } = await cafe('open');
  const s = await student();
  assert.equal((await listed(s, v.id)).open_now, true, 'is_open=false, schedule open');
  assert.equal((await s.post('/orders/draft', order)).status, 200);
});
