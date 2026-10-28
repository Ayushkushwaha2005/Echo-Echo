/* ==========================================================================
   CAMPUS CONTROL ORDER HISTORY (routes/admin-ops.js, packages/ui/order-view.js)

   * The Summary tab's figures and Graph View come from food_order, over an
     India-time date range, and count only orders whose payment was
     confirmed; sales leave out cancelled and refunded orders.
   * The Cancelled tab asks for several states at once; unknown states are
     refused.
   * The order page names the partner only to someone who may see partners.
   * The row menu offers only actions this administrator may take on this
     order; the avatar falls back to initials; the chart never overshoots.
   Synthetic users and orders only.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';
import { ORDER_TABS, TAB_STATE, orderActions, avatarFor, chartGeometry, niceMax } from '../../packages/ui/order-view.js';

process.env.ADMIN_PASSKEY_REQUIRED = 'true';

let app, pool, owner, ordersOnly, student, V, cust, rider, nth = 0;
const phone = () => `+9196500${String(10000 + nth++).slice(-5)}`;
const as = async (u, method = 'admin_totp') => client(app, await sessionFor(pool, u.id, { method }));
/* An order placed at a given India-time moment. */
const mk = (state, total, istAt, { fulfilment = 'pickup', partnerId = null } = {}) => pool.query(
  `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id,
                           destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng, created_at)
   VALUES ($1,$2,$3,$4,$5,$6,$6,$7,
           CASE WHEN $4='delivery' THEN '{"name":"Block 4"}'::jsonb END, CASE WHEN $4='delivery' THEN '+919999900002' END,
           CASE WHEN $4='delivery' THEN 'manual_map_spot' END, CASE WHEN $4='delivery' THEN 30.417 END,
           CASE WHEN $4='delivery' THEN 77.968 END, ($8 || '+05:30')::timestamptz) RETURNING id`,
  [`OH${nth++}`, cust.id, V.id, fulfilment, state, total, partnerId, istAt]).then((r) => r.rows[0].id);

before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.9@stu.upes.ac.in';
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE admin_account');
  owner = await makeUser(pool, { phone: phone(), name: 'Owner Nine', roles: ['platform_owner'] });
  ordersOnly = await makeUser(pool, { phone: phone(), name: 'Orders Only', roles: ['platform_admin'] });
  await pool.query(`INSERT INTO admin_account (user_id, status, permissions, activated_at) VALUES ($1,'active',$2,now())`,
    [ordersOnly.id, ['orders.view']]);
  student = await makeUser(pool, { phone: phone(), name: 'Student Nine' });
  cust = await makeUser(pool, { phone: phone(), name: 'Asha Verma' });
  rider = await makeUser(pool, { phone: phone(), name: 'Ravi Rider', roles: ['student', 'delivery_partner'] });
  V = await makeVendor(pool, { name: 'Summary Cafe', slug: 'summary-cafe' });
});

test('the summary counts confirmed orders only, and sales leave out cancelled and refunded ones', async () => {
  await mk('delivered', 20000, '2026-10-01 12:00', { fulfilment: 'delivery', partnerId: rider.id });
  await mk('delivered', 10000, '2026-10-01 19:00');
  await mk('preparing', 5000, '2026-10-02 09:00');
  await mk('cancelled', 7000, '2026-10-02 10:00');
  await mk('refunded', 9000, '2026-10-03 10:00', { fulfilment: 'delivery' });
  await mk('awaiting_payment', 99900, '2026-10-03 11:00');   // never paid: not an order
  await mk('draft', 88800, '2026-10-03 11:30');
  await mk('delivered', 30000, '2026-09-30 23:59');          // the day before the range
  await mk('delivered', 40000, '2026-10-04 00:00');          // the day after
  const r = await (await as(owner)).get('/admin/orders/summary?from=2026-10-01&to=2026-10-03');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bucket, 'day');
  assert.deepEqual(r.body.totals, { orders: 5, delivery: 2, pickup: 3, completed: 2, cancelled: 2,
                                    sales_paise: 35000, average_paise: Math.round(35000 / 3) });
  assert.deepEqual(r.body.series.map((p) => [p.at, p.orders, p.salesPaise]),
    [['2026-10-01', 2, 30000], ['2026-10-02', 2, 5000], ['2026-10-03', 1, 0]]);
});

test('a long range is drawn by month, and a bad range is refused', async () => {
  await mk('delivered', 12300, '2026-03-15 12:00');
  const c = await as(owner);
  const r = await c.get('/admin/orders/summary?from=2026-01-01&to=2026-06-30');
  assert.equal(r.body.bucket, 'month');
  assert.equal(r.body.series.length, 6);
  assert.deepEqual(r.body.series[2], { at: '2026-03-01', orders: 1, salesPaise: 12300 });
  assert.equal((await c.get('/admin/orders/summary?from=2026-05-01&to=2026-04-01')).status, 400);
  assert.equal((await c.get('/admin/orders/summary?from=2020-01-01&to=2026-04-01')).status, 400);
});

test('the summary needs orders.view: a student and an anonymous caller are refused', async () => {
  assert.equal((await (await as(student, 'code')).get('/admin/orders/summary')).status, 403);
  assert.equal((await client(app, null).get('/admin/orders/summary')).status, 401);
  assert.equal((await (await as(ordersOnly)).get('/admin/orders/summary')).status, 200);
});

test('the Cancelled tab asks for cancelled and refunded together; an unknown state is refused', async () => {
  await mk('cancelled', 100, '2026-10-02 10:00');
  await mk('refunded', 200, '2026-10-02 11:00');
  await mk('delivered', 300, '2026-10-02 12:00');
  const c = await as(owner);
  const r = await c.get(`/admin/orders?state=${encodeURIComponent(TAB_STATE.cancelled)}`);
  assert.deepEqual(r.body.orders.map((o) => o.state).sort(), ['cancelled', 'refunded']);
  assert.equal((await c.get(`/admin/orders?state=${TAB_STATE.completed}`)).body.orders.length, 1);
  assert.equal((await c.get('/admin/orders?state=cancelled,hacked')).status, 400);
});

test('the order page names the customer, and the partner only for partners.view', async () => {
  const id = await mk('picked_up', 15000, '2026-10-02 10:00', { fulfilment: 'delivery', partnerId: rider.id });
  const a = (await (await as(owner)).get(`/admin/orders/${id}/timeline`)).body.order;
  assert.equal(a.customer_name, 'Asha Verma');
  assert.equal(a.partner_name, 'Ravi Rider');
  const b = (await (await as(ordersOnly)).get(`/admin/orders/${id}/timeline`)).body.order;
  assert.equal(b.customer_name, 'Asha Verma');
  assert.equal(b.partner_name, null);
});

/* ---------- the browser helpers ------------------------------------------- */

test('the four tabs are the reference tabs, in order', () => {
  assert.deepEqual(ORDER_TABS.map(([, l]) => l), ['All Order', 'Summary', 'Completed', 'Cancelled']);
});

test('the row menu offers refund only to orders.override, only for a paid order that is not refunded', () => {
  const can = (...held) => (p) => held.includes(p);
  const acts = (o, c) => orderActions(o, c).map((a) => a.act);
  const paid = { state: 'delivered', fulfilment: 'pickup', payment_status: 'paid' };
  assert.deepEqual(acts(paid, can('orders.view')), ['openOrder', 'orderTimeline', 'copyCode']);
  assert.ok(acts(paid, can('orders.view', 'orders.override')).includes('refund'));
  assert.ok(!acts({ ...paid, state: 'refunded' }, can('orders.view', 'orders.override')).includes('refund'));
  assert.ok(!acts({ ...paid, payment_status: 'pending' }, can('orders.view', 'orders.override')).includes('refund'));
  assert.ok(!acts({ ...paid, state: 'awaiting_payment' }, can('orders.view', 'orders.override')).includes('refund'));
  assert.ok(acts({ state: 'picked_up', fulfilment: 'delivery' }, can('orders.view')).includes('goDeliveries'));
  assert.ok(!acts({ state: 'picked_up', fulfilment: 'pickup' }, can('orders.view')).includes('goDeliveries'));
  assert.deepEqual(acts(paid, can()), ['copyCode'], 'no permission: nothing but copying the code');
});

test('avatars fall back to initials on a stable palette tint', () => {
  assert.equal(avatarFor('Asha Verma').initials, 'AV');
  assert.equal(avatarFor('Ravi').initials, 'RA');
  assert.equal(avatarFor('').initials, '?');
  assert.equal(avatarFor('Asha Verma').tint, avatarFor('Asha Verma').tint);
  assert.match(avatarFor('Someone Else').tint, /^#[0-9A-F]{6}$/);
});

test('the Graph View line stays inside the plot and peaks at the real maximum', () => {
  const series = [0, 50, 150, 30, 0, 120].map((v, i) => ({ at: `2026-10-0${i + 1}`, v }));
  const g = chartGeometry(series, (p) => p.v, { w: 640, h: 300 });
  assert.equal(g.max, 200);
  assert.equal(g.peak.v, 150);
  const ys = [...g.d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0])).filter((_, i) => i % 2 === 1);
  const bottom = 300 - g.box.bottom, top = g.box.top;
  assert.ok(ys.every((y) => y <= bottom + 0.01 && y >= top - 0.01), 'no overshoot below zero or above the axis');
  assert.equal(g.grid.length, 5);
  assert.deepEqual(g.grid.map((l) => l.v), [0, 50, 100, 150, 200], 'quarters of a round maximum, as in the reference');
  assert.ok(g.labels.length <= 7 && g.labels.at(-1).at === '2026-10-06');
  assert.equal(niceMax(0), 4);
  assert.equal(niceMax(151), 200);
  assert.equal(niceMax(2400), 2500);
  const flat = chartGeometry([{ at: 'x', v: 0 }], (p) => p.v);
  assert.match(flat.d, /^M/);
});
