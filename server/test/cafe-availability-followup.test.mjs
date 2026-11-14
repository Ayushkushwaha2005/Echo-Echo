/* ==========================================================================
   CAFÉ AVAILABILITY FOLLOW-UP (production verification, 14 Nov 2026)

   1. Manual Closed must not set the emergency pause, so turning the override
      off returns the café to its schedule at once.
   2. The cart and checkout must say a café closed while its items are in the
      cart, and stop the checkout button. The server's 409 stays the backstop.
   3. The café list must not show a closed café as Open for a minute.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';
import { campusClock } from '../src/services/hours.js';
import { availabilityUpdate, cartAvailability } from '../../packages/ui/cafe-availability.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const WEB = read('../../web/src/app.js');
const ADMIN = read('../../admin/src/app.js');
const VERCEL = JSON.parse(read('../../vercel.json'));

let app, pool, nth = 0;
before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.11@stu.upes.ac.in';
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const admin = async () => {
  const u = await makeUser(pool, { phone: `+91964000${String(1000 + nth++).slice(-4)}`, name: 'Admin', roles: ['platform_admin'] });
  return client(app, await sessionFor(pool, u.id, { method: 'passkey' }));
};
const student = async () => client(app, await sessionFor(pool,
  (await makeUser(pool, { phone: `+91965000${String(1000 + nth++).slice(-4)}`, name: 'Student' })).id));
/* A café whose schedule says OPEN right now (every day, all day), not switched on. */
async function openBySchedule() {
  const v = await makeVendor(pool, { name: `Café ${nth}`, slug: `cafe-${nth++}` });
  const item = await makeItem(pool, v.id, { name: 'Tea', paise: 2000 });
  await pool.query(`UPDATE vendor SET open_days = '{1,2,3,4,5,6,7}', opens_at = '00:00', closes_at = '23:59',
                           is_open = false, accepting = true WHERE id = $1`, [v.id]);
  return { v, order: { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'delivery' } };
}
const statusOfCafe = async (c, id) => (await c.get(`/vendors/${id}/menu`)).body.vendor;
const row = async (id) => (await pool.query('SELECT manual_availability, is_open, accepting FROM vendor WHERE id = $1', [id])).rows[0];

/* ---------------- 1. manual Closed vs the emergency pause --------------- */

test('1. the update for manual Closed never touches `accepting`', () => {
  assert.deepEqual(availabilityUpdate({ manual: true, open: false }), { manualAvailability: true, isOpen: false });
  assert.deepEqual(availabilityUpdate({ manual: true, open: true }), { manualAvailability: true, isOpen: true, accepting: true });
  assert.deepEqual(availabilityUpdate({ manual: false, open: true }), { manualAvailability: false });
  assert.deepEqual(availabilityUpdate({ manual: false, open: false }), { manualAvailability: false });
});

test('1. Closed then override off: back on the schedule at once, not paused (the production failure)', async () => {
  const { v, order } = await openBySchedule();
  const a = await admin(), s = await student();
  assert.equal((await a.patch(`/vendors/${v.id}`, availabilityUpdate({ manual: true, open: false }))).status, 200);
  assert.equal((await statusOfCafe(s, v.id)).status.state, 'closed');
  assert.equal((await row(v.id)).accepting, true, 'Closed left the emergency pause alone');
  assert.equal((await a.patch(`/vendors/${v.id}`, availabilityUpdate({ manual: false }))).status, 200);
  const back = await statusOfCafe(s, v.id);
  assert.deepEqual([back.open_now, back.status.state], [true, 'open'], 'schedule says open, so open');
  /* and orders reach the next check (the delivery spot), not a closed/paused refusal */
  const r = await s.post('/orders/draft', order);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /delivery location/i);
});

test('1. the Campus Control card and Edit café both send the shared update', () => {
  assert.match(ADMIN, /import \{ availabilityUpdate \} from '..\/..\/packages\/ui\/cafe-availability.js'/);
  assert.match(ADMIN, /toggleOpen: \(t\) => act\(t, \(\) => quad\.updateVendor\(t\.dataset\.id,\s*availabilityUpdate\(\{ manual: true, open: t\.dataset\.v === '1' \}\)\)/);
  assert.match(ADMIN, /return availabilityUpdate\(\{ manual, open \}\);/);
  assert.doesNotMatch(ADMIN, /isOpen: open, accepting: open/, 'the old Closed-pauses payload is gone');
});

test('1. the emergency pause still works on its own, with or without the override', async () => {
  const { v } = await openBySchedule();
  const a = await admin(), s = await student();
  await a.patch(`/vendors/${v.id}`, { accepting: false });
  assert.equal((await statusOfCafe(s, v.id)).status.state, 'paused', 'schedule open, paused');
  /* manual Closed and override off do not clear a pause someone set */
  await a.patch(`/vendors/${v.id}`, availabilityUpdate({ manual: true, open: false }));
  await a.patch(`/vendors/${v.id}`, availabilityUpdate({ manual: false }));
  assert.equal((await row(v.id)).accepting, false);
  assert.equal((await statusOfCafe(s, v.id)).status.state, 'paused');
  /* manual Open is an explicit instruction to trade: it resumes orders */
  await a.patch(`/vendors/${v.id}`, availabilityUpdate({ manual: true, open: true }));
  assert.equal((await statusOfCafe(s, v.id)).open_now, true);
});

/* ---------------- 2. the cart follows the café ----------------------------- */

test('2. cartAvailability: closed and paused cafés block; open, or not yet known, does not', () => {
  assert.deepEqual(cartAvailability(null), { blocked: false, checking: true, title: null, detail: null });
  assert.equal(cartAvailability({ name: 'X', open_now: true, status: { state: 'open', line: 'Open now' } }).blocked, false);
  const closed = cartAvailability({ name: 'Tulips', open_now: false, status: { state: 'closed', line: 'Closed right now' } });
  assert.equal(closed.blocked, true);
  assert.equal(closed.title, 'Tulips is closed right now');
  assert.match(closed.detail, /Ordering is unavailable until it opens again/);
  const sched = cartAvailability({ name: 'Tulips', open_now: false, status: { state: 'closed', line: 'Closed · opens 8 AM' } });
  assert.match(sched.detail, /^Closed · opens 8 AM\. Ordering is unavailable/);
  assert.equal(cartAvailability({ name: 'Y', open_now: false, status: { state: 'paused' } }).title, 'Y is not taking orders right now');
  assert.equal(cartAvailability({ name: 'Z', open_now: false, status: { state: 'inactive' } }).blocked, true);
});

test('2. the cart and checkout screens show the notice and disable their buttons', () => {
  const cart = WEB.slice(WEB.indexOf('function ScrCart()'), WEB.indexOf('const FulfilTile'));
  assert.match(cart, /const avail = cartAvailability\(cartCafe\(\)\);/);
  assert.match(cart, /\$\{CartClosedNotice\(avail\)\}/);
  assert.match(cart, /data-route="checkout"\s*\$\{avail\.blocked \|\|/);
  assert.match(cart, /avail\.blocked \? 'Ordering unavailable'/);
  const checkout = WEB.slice(WEB.indexOf('function ScrCheckout()'));
  assert.match(checkout, /const avail = cartAvailability\(cartCafe\(\)\);/);
  assert.match(checkout, /data-act="placeOrder"\s*\$\{!avail\.blocked && /);
  /* the cart asks the café's menu endpoint, which is never kept at the edge */
  assert.match(WEB, /quad\.menu\(id\)\.then\(\(m\) => m\.vendor\)/);
  assert.ok(!VERCEL.headers.some((h) => /menu/.test(h.source)), 'no edge cache on menus');
});

test('2. the menu endpoint the cart reads says Closed the moment an admin closes the café; the server still refuses', async () => {
  const { v, order } = await openBySchedule();
  const a = await admin(), s = await student();
  assert.equal(cartAvailability(await statusOfCafe(s, v.id)).blocked, false);
  await a.patch(`/vendors/${v.id}`, availabilityUpdate({ manual: true, open: false }));
  assert.equal(cartAvailability(await statusOfCafe(s, v.id)).blocked, true);
  const r = await s.post('/orders/draft', order);
  assert.equal(r.status, 409, 'the server is the final safeguard');
});

/* ---------------- 3. how stale the café list may be ---------------------- */

test('3. the edge keeps the café list fresh for 5 s, not 15', () => {
  const rule = VERCEL.headers.find((h) => h.source === '/api/vendors/');
  const value = rule.headers.find((x) => x.key === 'Vercel-CDN-Cache-Control').value;
  const n = (k) => Number((value.match(new RegExp(`${k}=(\\d+)`)) || [])[1]);
  assert.ok(n('max-age') <= 5, value);
  assert.deepEqual(rule.missing.map((m) => m.key).sort(), ['fresh', 'includeArchived'], '?fresh=1 always reaches the server');
});

test('3. the page trusts an edge copy for 10 s, and a live change is fetched past the edge', () => {
  const max = Number((WEB.match(/const VENDORS_MAX_AGE = ([\d_]+);/) || [])[1]?.replace(/_/g, ''));
  assert.ok(max > 0 && max <= 10_000, `VENDORS_MAX_AGE ${max}`);
  assert.match(WEB, /followChanges\('\/live\/stream', \(\) => \{[^}]*refreshCafes\(\{ fresh: true \}\)/);
  assert.match(WEB, /quad\.vendors\(fresh \? \{ campusId, fresh: 1 \} : \{ campusId \}\)/);
  assert.match(WEB, /const CART_CAFE_MAX_AGE = 10_000;/);
});

test('3. an admin change is visible on ?fresh=1 immediately (what the live nudge asks)', async () => {
  const { v } = await openBySchedule();
  const a = await admin(), s = await student();
  const list = async () => (await s.get(`/vendors?fresh=1`)).body.vendors.find((x) => x.id === v.id);
  assert.equal((await list()).open_now, true);
  await a.patch(`/vendors/${v.id}`, availabilityUpdate({ manual: true, open: false }));
  assert.equal((await list()).open_now, false);
  const { weekday } = campusClock();
  assert.ok(weekday >= 1 && weekday <= 7);
});
