/* ==========================================================================
   DELIVER TO ANY VALID CAMPUS SPOT (Oct 2026)

   Against the REAL active outline (the OpenStreetMap way that production
   runs on, migration 013) and committed field readings. Points near the
   edge are derived from that outline's own vertices - a few metres either
   side of one of its edges - never invented.

     · an outdoor pin (ground, lawn, sitting area) with no floor is a valid
       delivery destination, with its name, landmark and instructions kept
       all the way to the partner
     · saved places: save, edit, move, reuse, delete - with their pins
     · the edge follows the configured boundary exactly; outside is refused
     · no boundary, or an unusable one, fails closed
     · a poor GPS reading is never certified; payment re-checks the spot
     · self pickup and the pre-October saved address keep working
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, campusId, setTerms } from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const OSM = JSON.parse(fs.readFileSync(root('src/db/013_campus_geography.sql'), 'utf8')
  .match(/'(\[\[30\.4156492[^']+)'::jsonb/)[1]);
const READINGS = Object.fromEntries(fs.readFileSync(root('../docs/campus/bidholi-field-2026-09-readings.csv'), 'utf8')
  .trim().split(/\r?\n/).slice(1).map((r) => r.split(',')).map((c) => [c[0], { lat: Number(c[4]), lng: Number(c[5]) }]));

let app, pool, cid, stub, nth = 0;
const phone = () => `+91961000${String(1000 + nth++).slice(-4)}`;

before(async () => {
  await startDb();
  /* A local stand-in speaking Razorpay's order shape, so /payments/intent
     runs its real checks; no real gateway, no real money. */
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const p = body ? JSON.parse(body) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `order_stub_${Date.now()}`, entity: 'order', amount: p.amount, currency: p.currency, status: 'created' }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    PLATFORM_OWNER_EMAIL: 'owner.9@stu.upes.ac.in', COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    WEB_ORIGIN: 'http://localhost:3000', SWEEPER: 'off', NODE_ENV: 'test',
    PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_localstub', RAZORPAY_KEY_SECRET: 'stub_secret_not_real',
    RAZORPAY_WEBHOOK_SECRET: `whsec_test_${'b'.repeat(24)}`, RAZORPAY_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
  });
  ({ pool } = await import('../src/db/index.js'));
  const { build } = await import('../src/index.js');
  app = await build();
});
after(async () => {
  await app?.close(); await pool?.end();
  await new Promise((r) => stub.close(r));
  for (const k of ['PAYMENT_PROVIDER', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_BASE_URL']) {
    delete process.env[k];
  }
  await stopDb();
});

const activate = (polygon = OSM) => pool.query(
  `INSERT INTO campus_boundary (name, polygon, active, status, source, campus_site_id, verified_at)
   VALUES ('UPES Bidholi (proposed from OpenStreetMap)', $1, true, 'active', 'openstreetmap:way/321638232', $2, now())`,
  [JSON.stringify(polygon), cid]);

beforeEach(async () => {
  await truncateAll(pool);
  cid = await campusId(pool);
  await activate();
  /* Production's terms: ₹10 platform fee per order, ₹15 campus delivery. */
  await setTerms(pool, { platform_fee_flat_paise: 1000, delivery_fee_paise: 1500 });
});

const student = async (opts) => client(app, await sessionFor(pool,
  (await makeUser(pool, { phone: phone(), name: 'Test Student' })).id, opts));
const outlet = async () => {
  const v = await makeVendor(pool, { name: 'Open Test Outlet', slug: `open-${nth++}` });
  return { v, item: await makeItem(pool, v.id, { name: 'Maggi', paise: 6000 }) };
};
const draft = (s, o, extra) => s.post('/orders/draft', { vendorId: o.v.id, lines: [{ itemId: o.item.id, qty: 1 }],
  fulfilment: 'delivery', contactPhone: '+919876543210', ...extra });

/* Field readings inside the outline (verified below, never assumed). */
const OPEN_SPOT = READINGS['2'];       // an open stretch between blocks, no building of its own
const SITTING = READINGS['3'];
const OUTSIDE = READINGS['98'];        // 58 m outside the outline

/* A point `m` metres from the midpoint of the outline's edge i, inward
   (positive) or outward (negative), on a local flat projection. */
async function nearEdge(i, m) {
  const { pointInPolygon } = await import('../src/services/campus.js');
  const [a, b] = [OSM[i], OSM[(i + 1) % OSM.length]];
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const k = Math.cos((mid[0] * Math.PI) / 180);
  const dx = (b[1] - a[1]) * k, dy = b[0] - a[0];
  const len = Math.hypot(dx, dy);
  let n = [-dy / len, dx / len];                     // unit normal in (east, north)
  const probe = (s) => [mid[0] + (n[1] * s) / 111_320, mid[1] + (n[0] * s) / (111_320 * k)];
  if (!pointInPolygon(...probe(1), OSM)) n = [-n[0], -n[1]];
  const [lat, lng] = probe(m);
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

test('the field readings used here are where this file says they are', async () => {
  const { pointInPolygon } = await import('../src/services/campus.js');
  assert.equal(pointInPolygon(OPEN_SPOT.lat, OPEN_SPOT.lng, OSM), true);
  assert.equal(pointInPolygon(SITTING.lat, SITTING.lng, OSM), true);
  assert.equal(pointInPolygon(OUTSIDE.lat, OUTSIDE.lng, OSM), false);
});

/* ================= outdoor spots, no floor ================================ */

test('a ground pin with a name, landmark and instructions and NO floor or room is a valid delivery', async () => {
  const s = await student({ onCampus: false });
  const o = await outlet();
  const pin = await s.post('/campus/pin', OPEN_SPOT);
  assert.equal(pin.status, 200);
  assert.equal(pin.body.inside, true);

  const r = await draft(s, o, {
    spot: { ...OPEN_SPOT, source: 'map' },
    address: { label: 'Ground', landmark: 'main pathway', instructions: 'Ground ke centre mein, main pathway ke paas' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (await pool.query(
    `SELECT destination_kind, spot_lat, spot_lng, destination_snapshot s, delivery_address a,
            delivery_landmark, delivery_instructions, delivery_paise FROM food_order WHERE id = $1`, [r.body.id])).rows[0];
  assert.equal(row.destination_kind, 'manual_map_spot');
  assert.deepEqual([Number(row.spot_lat), Number(row.spot_lng)], [OPEN_SPOT.lat, OPEN_SPOT.lng], 'the exact pin');
  assert.equal(row.s.name, 'Ground');
  assert.equal(row.s.label, 'Ground · near main pathway');
  assert.deepEqual(row.s.locationBasis, { destination: 'map_pin', studentPresence: 'not_confirmed' });
  assert.equal(row.a.label, 'Ground');
  assert.equal(row.a.floor, null);
  assert.equal(row.a.room, null);
  assert.equal(row.delivery_landmark, 'main pathway');
  assert.equal(row.delivery_instructions, 'Ground ke centre mein, main pathway ke paas');
  assert.equal(row.delivery_paise, 1500, 'the configured ₹15 delivery fee');
  const fin = (await pool.query(`SELECT platform_fee_paise, customer_total_paise FROM order_financials WHERE order_id = $1`, [r.body.id])).rows[0];
  assert.deepEqual([fin.platform_fee_paise, fin.customer_total_paise], [1000, 6000 + 1000 + 1500], 'server-priced: food + ₹10 + ₹15');
});

test('the exact spot and its words reach tracking and the partner\'s offer', async () => {
  const s = await student();
  const o = await outlet();
  const r = await draft(s, o, { spot: { ...SITTING, source: 'map' },
    address: { label: 'Sitting area', landmark: 'the big tree', instructions: 'Blue bench' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = (await s.get(`/orders/${r.body.id}/tracking`)).body;
  assert.deepEqual([t.destination.lat, t.destination.lng], [SITTING.lat, SITTING.lng]);
  assert.equal(t.address.name, 'Sitting area');
  assert.equal(t.address.label, 'Sitting area · near the big tree');
  const detail = (await s.get(`/orders/${r.body.id}`)).body.order;
  assert.equal(detail.delivery_instructions, 'Blue bench');
  /* What a partner's offer list reads for the destination. */
  const offer = (await pool.query(
    `SELECT COALESCE(d.name, f.destination_snapshot->>'label') AS destination
       FROM food_order f LEFT JOIN campus_node d ON d.id = f.destination_id WHERE f.id = $1`, [r.body.id])).rows[0];
  assert.equal(offer.destination, 'Sitting area · near the big tree');
});

test('words cannot move an order: an outside pin is refused whatever its description says', async () => {
  const s = await student();
  const o = await outlet();
  const r = await draft(s, o, { spot: { ...OUTSIDE, source: 'map' },
    address: { label: 'Inside campus', landmark: 'Main gate, inside UPES', instructions: 'This is on campus' } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /outside the campus delivery area/);
  assert.equal((await s.post('/campus/pin', OUTSIDE)).status, 403);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM food_order`)).rows[0].n, 0);
});

/* ================= the edge follows the configured outline ================= */

test('at the edge the configured outline decides: 3 m inside is deliverable, 3 m outside is not', async () => {
  const s = await student();
  const o = await outlet();
  for (const i of [0, 4, 9]) {
    const inside = await nearEdge(i, 3), outside = await nearEdge(i, -3);
    assert.equal((await s.post('/campus/pin', inside)).status, 200, `edge ${i} inside`);
    assert.equal((await s.post('/campus/pin', outside)).status, 403, `edge ${i} outside`);
    assert.equal((await draft(s, o, { spot: { ...inside, source: 'map' } })).status, 200, `edge ${i} order inside`);
    assert.equal((await draft(s, o, { spot: { ...outside, source: 'map' } })).status, 403, `edge ${i} order outside`);
  }
});

test('a GPS reading near the edge is not certified, but the pin it gave can be confirmed as a map spot', async () => {
  const s = await student({ onCampus: false });
  const o = await outlet();
  const p = await nearEdge(4, 6);
  /* ±25 m, 6 m from the edge: the reading cannot say which side. */
  const loc = await s.post('/campus/locate', { ...p, accuracy: 25 });
  assert.equal(loc.body.inside, false);
  assert.equal(loc.body.reason, 'near_boundary');
  assert.equal((await s.post('/campus/presence', { ...p, accuracy: 25 })).status, 403, 'presence is not certified');
  assert.equal((await draft(s, o, { spot: { ...p, source: 'gps', accuracy: 25 } })).status, 403, 'nor as a live-location spot');
  /* The student checks the pin and confirms it: it is inside the outline. */
  const r = await draft(s, o, { spot: { ...p, source: 'map' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const snap = (await pool.query(`SELECT destination_snapshot s FROM food_order WHERE id = $1`, [r.body.id])).rows[0].s;
  assert.deepEqual(snap.locationBasis, { destination: 'map_pin', studentPresence: 'not_confirmed' });
});

test('low-accuracy GPS never becomes a certified spot; a confident reading inside does', async () => {
  const s = await student();
  const o = await outlet();
  const poor = await s.post('/campus/locate', { ...OPEN_SPOT, accuracy: 180 });
  assert.equal(poor.body.inside, false);
  assert.equal(poor.body.reason, 'low_accuracy');
  assert.equal((await draft(s, o, { spot: { ...OPEN_SPOT, source: 'gps', accuracy: 180 } })).status, 403);
  assert.equal((await draft(s, o, { spot: { ...OPEN_SPOT, source: 'gps' } })).status, 400, 'no accuracy, no gps spot');
  const good = await draft(s, o, { spot: { ...OPEN_SPOT, source: 'gps', accuracy: 8 } });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal((await pool.query(`SELECT destination_kind k FROM food_order WHERE id = $1`, [good.body.id])).rows[0].k,
    'live_gps_spot');
});

/* ================= fail closed ============================================ */

test('no active boundary: pins, places and spot orders are all refused', async () => {
  await pool.query(`UPDATE campus_boundary SET status = 'retired', active = false`);
  const s = await student();
  const o = await outlet();
  assert.equal((await s.post('/campus/pin', OPEN_SPOT)).status, 403);
  assert.equal((await s.post('/me/places', { ...OPEN_SPOT, label: 'Ground' })).status, 403);
  const r = await draft(s, o, { spot: { ...OPEN_SPOT, source: 'map' } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /unavailable/);
});

test('an active boundary with unusable geometry is treated as no boundary at all', async () => {
  for (const broken of [[OSM[0], OSM[1]], OSM.map(([a, b]) => [String(a), String(b)]), [[0, 0], [0, 0.0000001], [0.0000001, 0]]]) {
    await pool.query(`DELETE FROM campus_boundary`);
    await activate(broken);
    const s = await student();
    const o = await outlet();
    const pin = await s.post('/campus/pin', OPEN_SPOT);
    assert.equal(pin.status, 403, JSON.stringify(broken).slice(0, 60));
    assert.match(pin.body.error, /not switched on|not been confirmed|unavailable/i);
    assert.equal((await draft(s, o, { spot: { ...OPEN_SPOT, source: 'map' } })).status, 403);
    assert.equal((await s.post('/campus/locate', { ...OPEN_SPOT, accuracy: 5 })).body.reason, 'no_boundary_configured');
  }
});

/* ================= payment re-checks the spot ============================ */

test('payment re-checks the stored spot against the boundary in force now; nothing is charged otherwise', async () => {
  const s = await student();
  const o = await outlet();
  const d = await draft(s, o, { spot: { ...OPEN_SPOT, source: 'map' }, address: { label: 'Ground' } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const ok = await s.post('/payments/intent', { orderId: d.body.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const d2 = await draft(s, o, { spot: { ...OPEN_SPOT, source: 'map' } });
  /* The active outline is replaced by one that no longer contains the spot
     (the same shape, 1.1 km north - a fixture, not a place). */
  const { pointInPolygon } = await import('../src/services/campus.js');
  const moved = OSM.map(([a, b]) => [a + 0.01, b]);
  assert.equal(pointInPolygon(OPEN_SPOT.lat, OPEN_SPOT.lng, moved), false, 'fixture: the spot is outside the new outline');
  await pool.query(`UPDATE campus_boundary SET polygon = $1`, [JSON.stringify(moved)]);
  const refused = await s.post('/payments/intent', { orderId: d2.body.id });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /no longer inside/);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM payment WHERE order_id = $1`, [d2.body.id])).rows[0].n, 0);
});

test('cash on delivery is refused for a spot order too', async () => {
  const s = await student();
  const o = await outlet();
  const r = await draft(s, o, { spot: { ...OPEN_SPOT, source: 'map' }, paymentMethod: 'cod' });
  assert.ok(r.status >= 400 && r.status < 500, String(r.status));
  assert.equal((await pool.query(`SELECT count(*)::int n FROM food_order`)).rows[0].n, 0);
});

/* ================= saved places ========================================== */

test('a sitting-area place is saved, listed, edited, moved, reused on an order and deleted', async () => {
  const s = await student();
  const o = await outlet();
  const made = await s.post('/me/places', { ...SITTING, label: 'Sitting area', landmark: 'near the big tree' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const p = made.body.place;
  assert.deepEqual([p.lat, p.lng, p.label, p.floor, p.room], [SITTING.lat, SITTING.lng, 'Sitting area', null, null]);
  assert.equal((await s.get('/me/places')).body.places.length, 1);

  /* Edit: new words and a moved pin; still no floor. */
  const moved = await s.put(`/me/places/${p.id}`, { ...OPEN_SPOT, label: 'Lawn', instructions: 'By the stage' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual([moved.body.place.lat, moved.body.place.lng, moved.body.place.label], [OPEN_SPOT.lat, OPEN_SPOT.lng, 'Lawn']);
  assert.equal(moved.body.place.landmark, null, 'an edit replaces the words');

  /* Reused: the order carries exactly the saved pin. */
  const r = await draft(s, o, { spot: { lat: moved.body.place.lat, lng: moved.body.place.lng, source: 'map' },
    address: { label: 'Lawn', instructions: 'By the stage' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (await pool.query(`SELECT spot_lat, spot_lng FROM food_order WHERE id = $1`, [r.body.id])).rows[0];
  assert.deepEqual([Number(row.spot_lat), Number(row.spot_lng)], [OPEN_SPOT.lat, OPEN_SPOT.lng]);
  assert.equal((await s.post(`/me/places/${p.id}/used`)).status, 200);
  assert.ok((await s.get('/me/places')).body.places[0].lastUsedAt);

  assert.equal((await s.del(`/me/places/${p.id}`)).status, 200);
  assert.deepEqual((await s.get('/me/places')).body.places, []);
});

test('a place must be a real pin inside the outline, with a name; it is the owner\'s alone', async () => {
  const s = await student();
  assert.equal((await s.post('/me/places', { ...OUTSIDE, label: 'Home' })).status, 403, 'outside the outline');
  assert.equal((await s.post('/me/places', { lat: String(SITTING.lat), lng: String(SITTING.lng), label: 'x' })).status, 400, 'strings');
  assert.equal((await s.post('/me/places', { label: 'No pin' })).status, 400, 'no pin');
  assert.equal((await s.post('/me/places', { ...SITTING })).status, 400, 'no name');
  assert.equal((await s.post('/me/places', { ...SITTING, label: '<b>x</b>' })).status, 400, 'plain text only');
  const mine = (await s.post('/me/places', { ...SITTING, label: 'Sitting area' })).body.place;
  const other = await student();
  assert.equal((await other.put(`/me/places/${mine.id}`, { ...SITTING, label: 'Taken' })).status, 404);
  assert.equal((await other.del(`/me/places/${mine.id}`)).status, 404);
  assert.deepEqual((await other.get('/me/places')).body.places, []);
  assert.equal((await client(app).get('/me/places')).status >= 400, true, 'signed in only');
  for (let i = 1; i < 8; i++) await s.post('/me/places', { ...SITTING, label: `Spot ${i}` });
  assert.equal((await s.post('/me/places', { ...SITTING, label: 'Ninth' })).status, 409);
});

test('before migration 031 is applied, saved places say so (503) and a spot order still works', async () => {
  const s = await student();
  const o = await outlet();
  await pool.query(`ALTER TABLE saved_place RENAME TO saved_place_hidden`);
  try {
    const r = await s.get('/me/places');
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'Saved places are not available yet');
    assert.equal((await s.post('/me/places', { ...SITTING, label: 'x' })).status, 503);
    assert.equal((await draft(s, o, { spot: { ...SITTING, source: 'map' }, address: { label: 'Ground' } })).status, 200);
  } finally {
    await pool.query(`ALTER TABLE saved_place_hidden RENAME TO saved_place`);
  }
});

/* ================= what must keep working ================================ */

test('the pre-October saved address and a block/floor/room delivery still work', async () => {
  const s = await student();
  const o = await outlet();
  const saved = await s.put('/me/address', { blockText: 'Block 6', floor: '2', room: '17', landmark: 'Near the lift' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await s.get('/me/address')).body.address.room, '17');
  const r = await draft(s, o, { spot: { ...SITTING, source: 'map' }, address: { blockText: 'Block 6', floor: '2', room: '17' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = (await pool.query(`SELECT delivery_address a FROM food_order WHERE id = $1`, [r.body.id])).rows[0].a;
  assert.deepEqual([a.block, a.floor, a.room, a.label], ['Block 6', '2', '17', null]);
});

test('self pickup: no destination, no delivery fee, and the live on-campus check where the campus requires it', async () => {
  const o = await outlet();
  const away = await student({ onCampus: false });
  const r1 = await away.post('/orders/draft', { vendorId: o.v.id, lines: [{ itemId: o.item.id, qty: 1 }], fulfilment: 'pickup', contactPhone: '+919876543210' });
  assert.equal(r1.status, 403);
  assert.equal(r1.body.code, 'location_required');
  const here = await student();
  const r2 = await here.post('/orders/draft', { vendorId: o.v.id, lines: [{ itemId: o.item.id, qty: 1 }], fulfilment: 'pickup', contactPhone: '+919876543210' });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const row = (await pool.query(`SELECT delivery_paise, destination_kind, spot_lat, destination_snapshot FROM food_order WHERE id = $1`, [r2.body.id])).rows[0];
  assert.deepEqual([row.delivery_paise, row.destination_kind, row.spot_lat, row.destination_snapshot], [0, null, null, null]);
  const fin = (await pool.query(`SELECT customer_total_paise FROM order_financials WHERE order_id = $1`, [r2.body.id])).rows[0];
  assert.equal(fin.customer_total_paise, 6000 + 1000, 'pickup: food + ₹10 platform fee, no delivery fee');
});
