/* ==========================================================================
   GOOGLE MAPS FOR DELIVERIES: walking routes, alerts, the fleet map, and who
   gets which map. Google's Routes endpoint is MOCKED here (globalThis.fetch
   for routes.googleapis.com only); no request leaves this machine. The real
   API is exercised separately, by hand, and reported as such.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, campusId } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

process.env.ADMIN_PASSKEY_REQUIRED = 'true';

let app, pool, routing, alerts, nth = 0;
const PICKUP = { lat: 30.4165, lng: 77.9670 };
const NEAR = { lat: 30.4172, lng: 77.9681 };
const phone = () => `+9196400${String(10000 + nth++).slice(-5)}`;

/* A fake Routes API: records every call, answers with a two-point route. */
const calls = [];
let routesStatus = 200;
const realFetch = globalThis.fetch;
const encode = (pts) => {   // Google's polyline encoding, for building answers
  let out = '', pl = 0, pg = 0;
  const one = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const p of pts) { const a = Math.round(p.lat * 1e5), b = Math.round(p.lng * 1e5); out += one(a - pl) + one(b - pg); pl = a; pg = b; }
  return out;
};
function fakeFetch(url, init) {
  if (!String(url).startsWith('https://routes.googleapis.com/')) return realFetch(url, init);
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), headers: init.headers, body });
  if (routesStatus !== 200) return Promise.resolve(new Response('{"error":{}}', { status: routesStatus }));
  const o = body.origin.location.latLng, d = body.destination.location.latLng;
  return Promise.resolve(new Response(JSON.stringify({ routes: [{
    distanceMeters: 240, duration: '210s',
    polyline: { encodedPolyline: encode([{ lat: o.latitude, lng: o.longitude }, { lat: d.latitude, lng: d.longitude }]) } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } }));
}

before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.9@stu.upes.ac.in';
  globalThis.fetch = fakeFetch;
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  routing = await import('../src/services/routing.js');
  alerts = await import('../src/services/delivery-alerts.js');
  app = await makeApp();
});
after(async () => { globalThis.fetch = realFetch; await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(() => {
  calls.length = 0; routesStatus = 200;
  routing._reset(); alerts._reset();
  delete process.env.GOOGLE_MAPS_BROWSER_KEY; delete process.env.GOOGLE_ROUTES_API_KEY;
  delete process.env.GOOGLE_MAPS_MAP_ID; delete process.env.ROUTES_DAILY_LIMIT;
});

/* ---------------- routing.js (unit, mocked Google) ---------------- */

test('polyline decoding matches Google\'s published example', () => {
  const p = routing.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(p, [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }]);
});

test('distance from a path: on the line is ~0, 100 m to the side is ~100', () => {
  const path = [{ lat: 30.4160, lng: 77.9670 }, { lat: 30.4180, lng: 77.9670 }];
  assert.ok(routing.metresFromPath({ lat: 30.4170, lng: 77.9670 }, path) < 1);
  const side = routing.metresFromPath({ lat: 30.4170, lng: 77.9670 + 100 / (111_320 * Math.cos(30.417 * Math.PI / 180)) }, path);
  assert.ok(Math.abs(side - 100) < 2, String(side));
});

test('no server key: no request, no route', async () => {
  assert.equal(await routing.fetchWalkingRoute(PICKUP, NEAR), null);
  assert.equal(calls.length, 0);
});

test('a request is WALK, Essentials fields only, key in a header, never in the URL', async () => {
  process.env.GOOGLE_ROUTES_API_KEY = 'test-routes-key';
  const r = await routing.fetchWalkingRoute(PICKUP, NEAR);
  assert.equal(r.distanceM, 240); assert.equal(r.durationS, 210); assert.equal(r.mode, 'walk');
  const c = calls[0];
  assert.equal(c.body.travelMode, 'WALK');
  for (const banned of ['routingPreference', 'intermediates', 'extraComputations', 'routeModifiers', 'requestedReferenceRoutes']) {
    assert.equal(c.body[banned], undefined, `${banned} would raise the billing tier`);
  }
  assert.equal(c.body.computeAlternativeRoutes, false);
  assert.equal(c.headers['X-Goog-FieldMask'], 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline');
  assert.equal(c.headers['X-Goog-Api-Key'], 'test-routes-key');
  assert.doesNotMatch(c.url, /key=/);
});

test('one route per leg: forty GPS updates on the route cost one request', async () => {
  process.env.GOOGLE_ROUTES_API_KEY = 'k';
  for (let i = 0; i < 40; i++) {
    const t = i / 40;
    const partner = { lat: PICKUP.lat + (NEAR.lat - PICKUP.lat) * t, lng: PICKUP.lng + (NEAR.lng - PICKUP.lng) * t, accuracyM: 10 };
    const r = await routing.routeForOrder({ orderId: 'o1', state: 'picked_up', partner, pickup: PICKUP, destination: NEAR });
    assert.equal(r.offRoute, false);
  }
  assert.equal(calls.length, 1);
});

test('a new leg asks again; leaving the route reroutes, at most twice', async () => {
  process.env.GOOGLE_ROUTES_API_KEY = 'k';
  const base = { orderId: 'o2', pickup: PICKUP, destination: NEAR };
  await routing.routeForOrder({ ...base, state: 'assigned', partner: { ...NEAR, accuracyM: 10 } });
  await routing.routeForOrder({ ...base, state: 'picked_up', partner: { ...PICKUP, accuracyM: 10 } });
  assert.equal(calls.length, 2, 'assigned and picked_up are two legs');
  const far = (k) => ({ lat: PICKUP.lat - 0.002 * k, lng: PICKUP.lng - 0.002 * k, accuracyM: 10 });
  const r1 = await routing.routeForOrder({ ...base, state: 'picked_up', partner: far(1) });
  const r2 = await routing.routeForOrder({ ...base, state: 'picked_up', partner: far(2) });
  const r3 = await routing.routeForOrder({ ...base, state: 'picked_up', partner: far(3) });
  assert.equal(calls.length, 4, 'two reroutes, then no more');
  assert.equal(r1.rerouted, 1); assert.equal(r2.rerouted, 2);
  assert.equal(r3.offRoute, true, 'third deviation is reported, not rerouted');
});

test('an imprecise fix far from the route is not called a deviation', async () => {
  process.env.GOOGLE_ROUTES_API_KEY = 'k';
  const base = { orderId: 'o3', state: 'picked_up', pickup: PICKUP, destination: NEAR };
  await routing.routeForOrder({ ...base, partner: { ...PICKUP, accuracyM: 10 } });
  const r = await routing.routeForOrder({ ...base, partner: { lat: PICKUP.lat - 0.003, lng: PICKUP.lng, accuracyM: 400 } });
  assert.equal(r.offRoute, false);
  assert.equal(calls.length, 1);
});

test('the daily limit stops requests before Google\'s quota does', async () => {
  process.env.GOOGLE_ROUTES_API_KEY = 'k'; process.env.ROUTES_DAILY_LIMIT = '3';
  for (let i = 0; i < 6; i++) await routing.fetchWalkingRoute(PICKUP, { lat: NEAR.lat + i * 1e-4, lng: NEAR.lng });
  assert.equal(calls.length, 3);
  assert.equal(routing.usage().used, 3);
});

test('a refused request (quota, bad key) backs off instead of retrying each update', async () => {
  process.env.GOOGLE_ROUTES_API_KEY = 'k'; routesStatus = 429;
  assert.equal(await routing.fetchWalkingRoute(PICKUP, NEAR), null);
  assert.equal(await routing.fetchWalkingRoute(PICKUP, NEAR), null);
  assert.equal(calls.length, 1);
  routesStatus = 200;
  assert.ok(await routing.fetchWalkingRoute(PICKUP, NEAR, { now: Date.now() + routing.FAILURE_BACKOFF_MS + 1 }), 'tries again after the back-off');
  assert.equal(calls.length, 2);
});

test('the route is forgotten with the delivery', async () => {
  process.env.GOOGLE_ROUTES_API_KEY = 'k';
  await routing.routeForOrder({ orderId: 'o4', state: 'picked_up', partner: null, pickup: PICKUP, destination: NEAR });
  assert.equal(routing.usage().cachedLegs, 1);
  routing.forgetOrderRoute('o4');
  assert.equal(routing.usage().cachedLegs, 0);
});

/* ---------------- delivery-alerts.js (unit) ---------------- */

test('alerts: silent, stopped away from stops (not at the café), off route, late', () => {
  const now = Date.now();
  const away = { lat: 30.4200, lng: 77.9700 };
  const base = { state: 'picked_up', pickup: PICKUP, destination: NEAR };
  const codes = (d) => alerts.alertsFor(d, now).map((a) => a.code).sort();
  assert.deepEqual(codes({ ...base, partner: null }), ['silent']);
  assert.deepEqual(codes({ ...base, partner: { ...away, ageSeconds: 200 } }), ['silent']);
  assert.deepEqual(codes({ ...base, partner: { ...away, ageSeconds: 5 }, stillSinceMs: now - 7 * 60_000 }), ['stopped']);
  assert.deepEqual(codes({ ...base, partner: { ...PICKUP, ageSeconds: 5 }, stillSinceMs: now - 20 * 60_000 }), [], 'waiting at the café is normal');
  assert.deepEqual(codes({ ...base, partner: { ...away, ageSeconds: 5 }, route: { offRoute: true, offRouteM: 90 } }), ['off_route']);
  assert.deepEqual(codes({ ...base, partner: { ...away, ageSeconds: 5 }, route: { durationS: 300 }, stateSince: now - 11 * 60_000 }), ['late']);
  assert.deepEqual(codes({ ...base, partner: { ...away, ageSeconds: 5 }, route: { durationS: 300 }, stateSince: now - 9 * 60_000 }), []);
});

test('stop detection keeps one point per delivery, moves it when the partner moves, and drops it', () => {
  alerts.noteMovement('p1', 'o1', { ...PICKUP, accuracy: 5 }, 1000);
  alerts.noteMovement('p1', 'o1', { lat: PICKUP.lat + 0.00005, lng: PICKUP.lng, accuracy: 5 }, 5000);
  assert.equal(alerts.stillSince('p1', 'o1'), 1000, '5 m is standing still');
  alerts.noteMovement('p1', 'o1', NEAR, 9000);
  assert.equal(alerts.stillSince('p1', 'o1'), 9000, 'moving resets it');
  alerts.forgetMovementForOrder('o1');
  assert.equal(alerts.stillSince('p1', 'o1'), null);
});

/* ---------------- who gets which map, and the fleet endpoint ---------------- */

let V, cust, partner, trackAdmin, viewAdmin, namedAdmin;
const as = async (u, method = 'code') => client(app, await sessionFor(pool, u.id, { method }));
async function seed() {
  await truncateAll(pool);
  const cid = await campusId(pool);
  V = await makeVendor(pool, { name: 'Map Cafe', slug: 'map-cafe' });
  const node = (await pool.query(
    `INSERT INTO campus_node (campus_site_id, kind, name, deliverable, delivery_enabled, lat, lng, verification)
     VALUES ($1,'spot','Map Cafe counter', false, false, $2, $3, 'pending') RETURNING id`, [cid, PICKUP.lat, PICKUP.lng])).rows[0];
  await pool.query(`UPDATE vendor SET campus_node_id = $2 WHERE id = $1`, [V.id, node.id]);
  cust = await makeUser(pool, { phone: phone(), name: 'Map Customer' });
  partner = await makeUser(pool, { phone: phone(), name: 'Asha Walker', roles: ['student', 'delivery_partner'] });
  trackAdmin = await makeUser(pool, { phone: phone(), name: 'Tracker', roles: ['platform_admin'] });
  viewAdmin = await makeUser(pool, { phone: phone(), name: 'Viewer', roles: ['platform_admin'] });
  namedAdmin = await makeUser(pool, { phone: phone(), name: 'Named', roles: ['platform_admin'] });
  await pool.query(`INSERT INTO admin_account (user_id, status, permissions) VALUES ($1,'active',$2),($3,'active',$4),($5,'active',$6)`,
    [trackAdmin.id, ['orders.view', 'delivery.track'], viewAdmin.id, ['orders.view'], namedAdmin.id, ['orders.view', 'delivery.track', 'partners.view']]);
}
const mkOrder = async (state) => (await pool.query(
  `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id,
                           destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
   VALUES ($1,$2,$3,'delivery',$4,9000,10000,$5,'{"name":"Block 4"}','+919999900002','manual_map_spot',$6,$7)
   RETURNING *`, [`MAP${nth++}`, cust.id, V.id, state, partner.id, NEAR.lat, NEAR.lng])).rows[0];
async function share(orderId, at = PICKUP) {
  const p = await as(partner);
  assert.equal((await p.post('/partner/location/start', { orderId })).status, 200);
  const r = await p.post('/partner/location', { orderId, lat: at.lat, lng: at.lng, accuracy: 10, takenAt: Date.now() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test('without Google keys everyone keeps OpenStreetMap and no route is asked for', async () => {
  await seed();
  const o = await mkOrder('picked_up');
  await share(o.id);
  for (const [u, m] of [[partner], [trackAdmin, 'admin_totp'], [cust]]) {
    const t = await (await as(u, m)).get(`/orders/${o.id}/tracking`);
    assert.equal(t.status, 200);
    assert.deepEqual(t.body.maps, { provider: 'osm' });
    assert.equal(t.body.route, null);
  }
  assert.equal(calls.length, 0);
});

test('with keys: the partner and delivery.track get Google and a walking route; the customer never does', async () => {
  await seed();
  process.env.GOOGLE_MAPS_BROWSER_KEY = 'browser-key'; process.env.GOOGLE_ROUTES_API_KEY = 'server-key';
  const o = await mkOrder('picked_up');
  await share(o.id);
  const mine = (await (await as(partner)).get(`/orders/${o.id}/tracking`)).body;
  assert.equal(mine.maps.provider, 'google');
  assert.equal(mine.maps.browserKey, 'browser-key');
  assert.equal(mine.route.mode, 'walk');
  const theirs = (await (await as(cust)).get(`/orders/${o.id}/tracking`)).body;
  assert.deepEqual(theirs.maps, { provider: 'osm' }, 'no Google map load for a customer');
  assert.equal(theirs.route, null);
  assert.deepEqual(theirs.alerts, []);
  const raw = JSON.stringify([mine, theirs]);
  assert.doesNotMatch(raw, /server-key/, 'the Routes key never leaves the server');
  assert.equal(calls.length, 1, 'the partner\'s view asked once; the customer\'s did not');
});

test('the fleet map needs delivery.track; names need partners.view; the server key is never in it', async () => {
  await seed();
  process.env.GOOGLE_MAPS_BROWSER_KEY = 'browser-key'; process.env.GOOGLE_ROUTES_API_KEY = 'server-key';
  const a = await mkOrder('assigned');
  const b = await mkOrder('picked_up');
  await mkOrder('delivered');
  await share(b.id, NEAR);
  assert.equal((await (await as(viewAdmin, 'admin_totp')).get('/admin/deliveries/fleet')).status, 403);
  assert.equal((await (await as(cust)).get('/admin/deliveries/fleet')).status, 403);
  assert.equal((await (await as(partner)).get('/admin/deliveries/fleet')).status, 403);

  const f = await (await as(trackAdmin, 'admin_totp')).get('/admin/deliveries/fleet');
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.deepEqual(f.body.deliveries.map((d) => d.orderId).sort(), [a.id, b.id].sort(), 'only orders being carried');
  assert.equal(f.body.maps.provider, 'google');
  const db = f.body.deliveries.find((d) => d.orderId === b.id);
  assert.equal(db.partner.lat, NEAR.lat);
  assert.equal(db.partnerName, null, 'no partner name without partners.view');
  assert.deepEqual(f.body.deliveries.find((d) => d.orderId === a.id).alerts.map((x) => x.code), ['silent']);
  assert.doesNotMatch(JSON.stringify(f.body), /server-key/);

  const named = await (await as(namedAdmin, 'admin_totp')).get('/admin/deliveries/fleet');
  assert.equal(named.body.deliveries.find((d) => d.orderId === b.id).partnerName, 'Asha Walker');

  const n = calls.length;
  for (let i = 0; i < 5; i++) await (await as(trackAdmin, 'admin_totp')).get('/admin/deliveries/fleet');
  assert.equal(calls.length, n, 'polling the fleet map reuses the routes');

  const audited = (await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'delivery.track.view' AND resource_id = $1`, [b.id])).rows[0].n;
  assert.ok(audited >= 1 && audited <= 2, `position views audited, not flooded (${audited})`);
});

test('the checkout picker gets Google only when the browser key is set, and never the Routes key', async () => {
  await seed();
  const s = await as(cust);
  assert.deepEqual((await s.get('/campus/map')).body.maps, { provider: 'osm' });
  process.env.GOOGLE_MAPS_BROWSER_KEY = 'browser-key'; process.env.GOOGLE_ROUTES_API_KEY = 'server-key';
  process.env.GOOGLE_MAPS_MAP_ID = 'map-id-1';
  const r = await s.get('/campus/map');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.maps, { provider: 'google', browserKey: 'browser-key', mapId: 'map-id-1' });
  assert.doesNotMatch(JSON.stringify(r.body), /server-key/);
  assert.equal(calls.length, 0, 'opening the picker asks Google for no route');
});
