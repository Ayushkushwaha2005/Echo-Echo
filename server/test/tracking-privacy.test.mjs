/* ==========================================================================
   A DELIVERY PARTNER'S POSITION: WHEN IT EXISTS, WHO SEES IT, HOW OLD IT IS
   (services/partner-location.js, routes/tracking.js, transition() in
   routes/orders.js). Synthetic users, orders and coordinates only.

   * The stored position goes when the delivery ends, in the same
     transaction as the state change, and nobody (customer, partner,
     administrator) is shown a position for an order no longer carried.
   * A report is validated: coordinates, accuracy, the fix's own time,
     the order id, the distance from the café, and a per-partner rate.
   * Every position carries its age, measured on the server's clock.
   * The access rules that were already right stay right.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, campusId } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

/* Production refuses platform roles to email-code sessions (render.yaml);
   the test default is lenient, so turn the real rule on for this file. */
process.env.ADMIN_PASSKEY_REQUIRED = 'true';

let app, pool, tx, transition, checkReport, pruneFinished, MAX_FIX_AGE_SECONDS, V, W, cust, other, partner, partner2, staffW, admin, nth = 0;
const PICKUP = { lat: 30.4165, lng: 77.9670 };
const NEAR = { lat: 30.4172, lng: 77.9681 };
const phone = () => `+9196300${String(10000 + nth++).slice(-5)}`;
const as = async (u, method = 'code') => client(app, await sessionFor(pool, u.id, { method }));
const rowsFor = async (partnerId) => (await pool.query(
  `SELECT order_id FROM partner_location WHERE partner_id = $1`, [partnerId])).rows;
const mkOrder = async (state, { partnerId = partner.id, vendor = V, customer = cust } = {}) => (await pool.query(
  `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id,
                           destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
   VALUES ($1,$2,$3,'delivery',$4,9000,10000,$5,'{"name":"Block 4"}','+919999900002','manual_map_spot',$6,$7)
   RETURNING *`, [`TRK${nth++}`, customer.id, vendor.id, state, partnerId, NEAR.lat, NEAR.lng])).rows[0];
const report = async (p, orderId, extra = {}) => (await as(p)).post('/partner/location',
  { orderId, lat: NEAR.lat, lng: NEAR.lng, accuracy: 12, takenAt: Date.now(), ...extra });
const view = async (u, orderId, method) => (await (await as(u, method)).get(`/orders/${orderId}/tracking`));

before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.5@stu.upes.ac.in';
  await startDb();
  let db;
  ({ pool, ...db } = await import('../src/db/index.js'));
  tx = db.tx;
  ({ transition } = await import('../src/routes/orders.js'));
  ({ checkReport, pruneFinished, MAX_FIX_AGE_SECONDS } = await import('../src/services/partner-location.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => {
  await truncateAll(pool);
  const cid = await campusId(pool);
  V = await makeVendor(pool, { name: 'Track Cafe', slug: 'track-cafe' });
  W = await makeVendor(pool, { name: 'Other Cafe', slug: 'other-cafe' });
  const node = (await pool.query(
    `INSERT INTO campus_node (campus_site_id, kind, name, deliverable, delivery_enabled, lat, lng, verification)
     VALUES ($1,'spot','Track Cafe counter', false, false, $2, $3, 'pending') RETURNING id`,
    [cid, PICKUP.lat, PICKUP.lng])).rows[0];
  await pool.query(`UPDATE vendor SET campus_node_id = $2 WHERE id = $1`, [V.id, node.id]);
  cust = await makeUser(pool, { phone: phone(), name: 'Customer One' });
  other = await makeUser(pool, { phone: phone(), name: 'Customer Two' });
  partner = await makeUser(pool, { phone: phone(), name: 'Partner One', roles: ['student', 'delivery_partner'] });
  partner2 = await makeUser(pool, { phone: phone(), name: 'Partner Two', roles: ['student', 'delivery_partner'] });
  staffW = await makeUser(pool, { phone: phone(), name: 'Staff Other', roles: ['vendor_staff'], vendorId: W.id });
  admin = await makeUser(pool, { phone: phone(), name: 'Admin One', roles: ['platform_admin'] });
});

/* ---------- T1: the position ends with the delivery ---------------------- */

test('delivered: the position is deleted with the state change and shown to nobody', async () => {
  const o = await mkOrder('picked_up');
  assert.equal((await report(partner, o.id)).status, 200);
  assert.equal((await rowsFor(partner.id)).length, 1);
  await tx((c) => transition(c, o.id, 'delivered', partner));
  assert.equal((await rowsFor(partner.id)).length, 0, 'deleted in the same transaction');
  for (const [u, method] of [[cust], [partner], [admin, 'admin_totp']]) {
    const t = await view(u, o.id, method);
    assert.equal(t.status, 200);
    assert.equal(t.body.partner, null);
    assert.equal(t.body.partnerVisibility, 'delivery_over');
  }
});

test('refunded straight from a carrying state also deletes it', async () => {
  for (const from of ['assigned', 'picked_up']) {
    await pool.query(`DELETE FROM partner_location`);
    const o = await mkOrder(from);
    assert.equal((await report(partner, o.id)).status, 200);
    await tx((c) => transition(c, o.id, 'refunded', admin));
    assert.equal((await rowsFor(partner.id)).length, 0, `refund from ${from}`);
  }
});

test('assigned -> picked_up keeps tracking: it is still the same delivery', async () => {
  const o = await mkOrder('assigned');
  assert.equal((await report(partner, o.id)).status, 200);
  await tx((c) => transition(c, o.id, 'picked_up', partner));
  assert.equal((await rowsFor(partner.id)).length, 1);
  const t = (await view(cust, o.id)).body;
  assert.equal(t.partnerVisibility, 'visible');
  assert.ok(t.partner);
});

test('a carrying order cannot be cancelled, so its tracking is untouched by an attempt', async () => {
  const o = await mkOrder('picked_up');
  assert.equal((await report(partner, o.id)).status, 200);
  await assert.rejects(tx((c) => transition(c, o.id, 'cancelled', admin)), /cannot go from picked_up to cancelled/);
  assert.equal((await rowsFor(partner.id)).length, 1);
});

test('a position left over from before this rule (a cancelled or delivered order) is never shown, and the sweeper removes it', async () => {
  const done = await mkOrder('delivered');
  const cancelled = await mkOrder('cancelled', { partnerId: partner2.id });
  await pool.query(
    `INSERT INTO partner_location (partner_id, order_id, lat, lng, at)
     VALUES ($1,$2,$4,$5, now() - interval '3 hours'), ($3,$6,$4,$5, now() - interval '1 day')`,
    [partner.id, done.id, partner2.id, NEAR.lat, NEAR.lng, cancelled.id]);
  const a = (await view(admin, done.id, 'admin_totp')).body;
  assert.equal(a.partner, null);
  assert.equal(a.partnerVisibility, 'delivery_over');
  assert.equal((await view(cust, cancelled.id)).body.partner, null);
  const live = await mkOrder('picked_up', { partnerId: (await makeUser(pool, { phone: phone(), name: 'Partner Three', roles: ['student', 'delivery_partner'] })).id });
  await pool.query(`INSERT INTO partner_location (partner_id, order_id, lat, lng) VALUES ($1,$2,$3,$4)`,
    [live.partner_id, live.id, NEAR.lat, NEAR.lng]);
  assert.deepEqual(await pruneFinished(), { pruned: 2 });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM partner_location`)).rows[0].n, 1, 'the live one stays');
});

test('repeated requests after the end: reports are refused and store nothing; reads show nothing; a second "delivered" is refused', async () => {
  const o = await mkOrder('picked_up');
  await report(partner, o.id);
  await tx((c) => transition(c, o.id, 'delivered', partner));
  for (let i = 0; i < 3; i++) {
    assert.equal((await report(partner, o.id)).status, 403);
    assert.equal((await rowsFor(partner.id)).length, 0);
    assert.equal((await view(cust, o.id)).body.partner, null);
  }
  await assert.rejects(tx((c) => transition(c, o.id, 'delivered', partner)), /cannot go from delivered to delivered/);
});

test('if the position cannot be deleted, the delivery does not complete either (one transaction)', async () => {
  const o = await mkOrder('picked_up');
  await report(partner, o.id);
  await pool.query(`CREATE FUNCTION test_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS
                    $$ BEGIN RAISE EXCEPTION 'cleanup failed (test)'; END $$`);
  await pool.query(`CREATE TRIGGER test_refuse_delete BEFORE DELETE ON partner_location
                    FOR EACH ROW EXECUTE FUNCTION test_refuse_delete()`);
  try {
    await assert.rejects(tx((c) => transition(c, o.id, 'delivered', partner)), /cleanup failed/);
    const st = (await pool.query(`SELECT state FROM food_order WHERE id = $1`, [o.id])).rows[0].state;
    assert.equal(st, 'picked_up', 'rolled back: still being carried, still tracked');
    const ev = (await pool.query(`SELECT count(*)::int AS n FROM order_event WHERE order_id = $1 AND to_state = 'delivered'`, [o.id])).rows[0].n;
    assert.equal(ev, 0);
  } finally {
    await pool.query(`DROP TRIGGER test_refuse_delete ON partner_location; DROP FUNCTION test_refuse_delete()`);
  }
  await tx((c) => transition(c, o.id, 'delivered', partner));
  assert.equal((await rowsFor(partner.id)).length, 0, 'and once it can, it does');
});

/* ---------- T2: what a report must be ------------------------------------- */

test('impossible or implausible reports are refused with 400 and store nothing', async () => {
  const o = await mkOrder('picked_up');
  const now = Date.now();
  for (const [why, extra] of [
    ['latitude out of range', { lat: 999 }],
    ['longitude out of range', { lng: -999 }],
    ['0,0 placeholder', { lat: 0, lng: 0 }],
    ['negative accuracy', { accuracy: -5 }],
    ['accuracy beyond 2 km', { accuracy: 5000 }],
    ['not a number', { lat: 'north' }],
    ['fix dated in the future', { takenAt: now + 10 * 60_000 }],
    ['fix too old', { takenAt: now - (MAX_FIX_AGE_SECONDS + 60) * 1000 }],
    ['unparseable time', { takenAt: 'yesterday-ish' }],
    ['50 km from the café', { lat: PICKUP.lat + 0.45 }],
  ]) {
    const r = await report(partner, o.id, extra);
    assert.equal(r.status, 400, why);
  }
  /* Ten refusals above already count against this partner's 12 a minute
     (failed reports are limited too), so the id checks use another. */
  for (const orderId of ['not-a-uuid', '', 42]) {
    assert.equal((await (await as(partner2)).post('/partner/location', { orderId, lat: NEAR.lat, lng: NEAR.lng })).status, 400);
  }
  assert.equal((await rowsFor(partner.id)).length, 0);
});

test('a valid report without takenAt (older clients) is still accepted', async () => {
  const o = await mkOrder('picked_up');
  const r = await (await as(partner)).post('/partner/location', { orderId: o.id, lat: NEAR.lat, lng: NEAR.lng });
  assert.equal(r.status, 200);
});

test('the fix time is stored, not the arrival time', async () => {
  const o = await mkOrder('picked_up');
  const taken = Date.now() - 30_000;
  assert.equal((await report(partner, o.id, { takenAt: taken })).status, 200);
  const at = (await pool.query(`SELECT at FROM partner_location WHERE partner_id = $1`, [partner.id])).rows[0].at;
  assert.ok(Math.abs(new Date(at).getTime() - taken) < 1000);
});

test('checkReport rules, directly', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const now = 1_800_000_000_000;
  assert.deepEqual(checkReport({ orderId: id, lat: '30.5', lng: 78, accuracy: 0 }, now),
    { orderId: id, lat: 30.5, lng: 78, accuracy: 0, takenAt: null });
  assert.equal(checkReport({ orderId: id, lat: 1, lng: 1, takenAt: now + 30_000 }, now).takenAt.getTime(), now,
    'a slightly fast phone clock is clamped to now, never stored in the future');
  assert.throws(() => checkReport({ orderId: id, lat: 90.0001, lng: 0 }, now), /not a position on Earth/);
  assert.throws(() => checkReport({ orderId: id, lat: 1 }, now), /latitude and a longitude/);
});

test('reports are rate-limited per partner: 12 a minute', async () => {
  const o = await mkOrder('picked_up');
  const s = await as(partner);
  const codes = [];
  for (let i = 0; i < 13; i++) {
    codes.push((await s.post('/partner/location', { orderId: o.id, lat: NEAR.lat, lng: NEAR.lng })).status);
  }
  assert.deepEqual(codes.slice(0, 12), Array(12).fill(200));
  assert.equal(codes[12], 429);
  /* Another partner has their own allowance. */
  const o2 = await mkOrder('picked_up', { partnerId: partner2.id });
  assert.equal((await report(partner2, o2.id)).status, 200);
});

/* ---------- T3: how old a position is ------------------------------------- */

test('every shown position carries its age on the server clock', async () => {
  const o = await mkOrder('picked_up');
  await report(partner, o.id);
  await pool.query(`UPDATE partner_location SET at = now() - interval '95 seconds' WHERE partner_id = $1`, [partner.id]);
  const p = (await view(cust, o.id)).body.partner;
  assert.ok(p.ageSeconds >= 95 && p.ageSeconds < 105, `ageSeconds=${p.ageSeconds}`);
  assert.ok(p.at);
});

/* ---------- access rules that must not move ------------------------------- */

test('who may see and send a position is unchanged', async () => {
  const o = await mkOrder('assigned');
  assert.equal((await report(partner, o.id)).status, 200);
  assert.equal((await report(partner2, o.id)).status, 403, 'another partner');
  assert.equal((await (await as(cust)).post('/partner/location', { orderId: o.id, lat: NEAR.lat, lng: NEAR.lng })).status, 403, 'a student');
  const before = (await view(cust, o.id)).body;
  assert.equal(before.partner, null);
  assert.equal(before.partnerVisibility, 'hidden_until_pickup');
  assert.equal((await view(other, o.id)).status, 403, 'unrelated student');
  assert.equal((await view(staffW, o.id)).status, 403, 'staff of another café');
  assert.equal((await view(admin, o.id, 'code')).status, 403, 'administrator without a Campus Control session');
  assert.equal((await app.inject({ method: 'GET', url: `/orders/${o.id}/tracking` })).statusCode, 401);
  const adm = (await view(admin, o.id, 'admin_totp')).body;
  assert.ok(adm.partner, 'administrator with password + authenticator');
});
