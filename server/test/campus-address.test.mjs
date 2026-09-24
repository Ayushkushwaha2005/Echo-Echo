/* ==========================================================================
   CAMPUS ADDRESS, MAP PICKING AND THE OWNER'S CORRECTIONS (migration 023)

   Production-shaped data: the OSM outline from migration 013 active, the 17
   Bidholi places with their production ids and positions, the five opened
   destinations, Frisco and Tulips as migration 022 created them - then the
   corrections section of migration 023 executed exactly as written.
   Points tested are committed field readings, never invented ones.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, campusId } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const PLAN = JSON.parse(fs.readFileSync(root('../docs/campus/bidholi-destinations-2026-09-25.json'), 'utf8'));
const OSM = JSON.parse(fs.readFileSync(root('src/db/013_campus_geography.sql'), 'utf8')
  .match(/'(\[\[30\.4156492[^']+)'::jsonb/)[1]);
const M023 = fs.readFileSync(root('src/db/023_saved_address_and_outlets.sql'), 'utf8');
const CORRECTIONS = M023.slice(M023.indexOf("-- 4. The owner's corrections"));
const READINGS = Object.fromEntries(fs.readFileSync(root('../docs/campus/bidholi-field-2026-09-readings.csv'), 'utf8')
  .trim().split(/\r?\n/).slice(1).map((r) => r.split(',')).map((c) => [c[0], { lat: Number(c[4]), lng: Number(c[5]) }]));
const place = (n) => PLAN.locations.find((l) => l.name === n);
const OPEN = PLAN.locations.filter((l) => l.decision === 'deliver').map((l) => l.name);

let app, pool, cid, nth = 0;
const phone = () => `+91960000${String(1000 + nth++).slice(-4)}`;

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
  await pool.query(
    `INSERT INTO campus_boundary (id, name, polygon, active, status, source, campus_site_id, verified_at)
     VALUES ($1, 'UPES Bidholi (proposed from OpenStreetMap)', $2, true, 'active', 'openstreetmap:way/321638232', $3, now())`,
    [PLAN.boundaryId, JSON.stringify(OSM), cid]);
  for (const l of PLAN.locations.filter((x) => x.id)) {   // MAC comes from the migration itself
    /* Production before migration 023: Energy Block was confirmed and open too. */
    const open = l.decision === 'deliver' || l.name === 'Energy Block';
    await pool.query(
      `INSERT INTO campus_node (id, campus_site_id, kind, name, aliases, deliverable, delivery_enabled, lat, lng, source, verification,
                                verification_method)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11)`,
      [l.id, cid, /Room|Caf/.test(l.name) ? 'spot' : 'building', l.name,
       /Room/.test(l.name) ? [{ 'Block 11, Floor 2, Room 17': '11217', 'Block 1, Room 01': '1001' }[l.name] || 'plate'] : [],
       open, l.lat, l.lng, ['Energy Block', 'Infirmary'].includes(l.name) ? 'public_source' : 'survey',
       open ? 'confirmed' : 'pending', open ? (l.method || 'public_map') : null]);
  }
  /* The two outlets exactly as migration 022 created them. */
  for (const [slug, name] of [['frisco', 'Café Frisco'], ['tulips', 'Tulips Cafe']]) {
    await pool.query(
      `INSERT INTO vendor (slug, name, campus_site_id, campus_node_id, is_open, accepting, active)
       VALUES ($1, $2, $3, $4, false, false, true)`, [slug, name, cid, place(name).id]);
  }
  await pool.query(CORRECTIONS);
});

const student = async (opts) => client(app, await sessionFor(pool,
  (await makeUser(pool, { phone: phone(), name: 'Test Student' })).id, opts));
const staff = async () => client(app, await sessionFor(pool,
  (await makeUser(pool, { phone: phone(), name: 'Campus Admin', roles: ['platform_admin'] })).id));
const openOutlet = async () => {
  const v = await makeVendor(pool, { name: 'Open Test Outlet', slug: `open-${nth++}` });
  return { v, item: await makeItem(pool, v.id, { name: 'Tea', paise: 2000 }) };
};

/* ======================= 1-2, 16: live GPS, fail-closed =================== */

test('live GPS inside the boundary is accepted, outside is refused', async () => {
  const s = await student({ onCampus: false });
  const inside = READINGS['8'];                       // food court, 74 m inside
  assert.equal((await s.post('/campus/presence', { ...inside, accuracy: 10 })).status, 200);
  const out = await (await student({ onCampus: false })).post('/campus/presence', { ...READINGS['98'], accuracy: 5 });
  assert.equal(out.status, 403);
  assert.match(out.body.error, /not on campus/);
});

/* ======================= 3-5: manual map pin ============================== */

test('a map pin inside the boundary is accepted and answered with nearby confirmed destinations', async () => {
  const s = await student();
  const r = await s.post('/campus/pin', READINGS['22']);   // Enrollment Office signboard
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.inside, true);
  assert.equal(r.body.candidates[0].name, 'Enrollment Office');
  assert.equal(r.body.candidates[0].metres, 0);
  for (const c of r.body.candidates) assert.ok(OPEN.includes(c.name) && c.name !== 'Energy Block', c.name);
});

test('a map pin outside the boundary is refused', async () => {
  const r = await (await student()).post('/campus/pin', READINGS['98']);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /not on campus/);
});

test('a client that claims its pin is inside is not believed', async () => {
  const s = await student();
  const r = await s.post('/campus/pin', { ...READINGS['98'], inside: true, insideCampus: true,
    candidates: [{ id: place('Enrollment Office').id }], metres: 0, building: 'Enrollment Office' });
  assert.equal(r.status, 403);
  /* Nor on the order itself. */
  const { v, item } = await openOutlet();
  const d = await s.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'delivery',
    destinationId: place('Enrollment Office').id, pin: { ...READINGS['98'], inside: true } });
  assert.equal(d.status, 403);
  assert.equal((await s.post('/campus/pin', { lat: '30.4165', lng: '77.968' })).status, 400, 'strings are not coordinates');
  assert.equal((await client(app).post('/campus/pin', READINGS['22'])).status, 401, 'signed-in only');
});

/* ======================= 6-8: the saved address =========================== */

test('a saved address holds block, floor and room, on the student\'s own campus', async () => {
  const s = await student();
  const blocks = (await s.get('/campus/blocks')).body.blocks;
  assert.deepEqual(blocks.map((b) => b.number), [1, 2, 3, 4, 8, 9, 11]);
  assert.ok(blocks.every((b) => b.located === false), 'no block has a known building yet');
  const b11 = blocks.find((b) => b.number === 11);

  const put = await s.put('/me/address', { blockId: b11.id, floor: '2', room: '17', landmark: 'Near the lift',
                                           instructions: 'Call when you reach the building', campusId: 'someone-else' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const a = (await s.get('/me/address')).body.address;
  assert.equal(a.campus, 'Bidholi Campus');
  assert.deepEqual([a.block, a.floor, a.room, a.landmark], ['Block 11', '2', '17', 'Near the lift']);

  /* A block that is not listed can be typed; a made-up block id cannot be used. */
  assert.equal((await s.put('/me/address', { blockText: 'Block 6', room: '4' })).body.address.block, 'Block 6');
  assert.equal((await s.put('/me/address', { blockId: '00000000-0000-0000-0000-000000000000' })).status, 400);
  assert.equal((await s.put('/me/address', { room: '<script>' })).status, 400);
  assert.equal((await s.put('/me/address', {})).status, 400);
  assert.equal((await s.del('/me/address')).status, 200);
  assert.equal((await s.get('/me/address')).body.address, null);
});

test('a room number is never geographic proof', async () => {
  const s = await student({ onCampus: false });
  const b11 = (await s.get('/campus/blocks')).body.blocks.find((b) => b.number === 11);
  await s.put('/me/address', { blockId: b11.id, floor: '2', room: '17' });
  const { v, item } = await openOutlet();
  const body = { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'delivery',
                 address: { blockId: b11.id, floor: '2', room: '17' } };
  /* No on-campus check: refused, whatever the address says. */
  const r1 = await s.post('/orders/draft', body);
  assert.equal(r1.status, 403);
  assert.equal(r1.body.code, 'location_required');
  /* On campus, but no delivery point: refused - an address is not a destination. */
  const r2 = await (await student()).post('/orders/draft', body);
  assert.equal(r2.status, 400);
  assert.match(r2.body.error, /Choose a delivery location/);
  /* And no Block 11 / room appears among the places a student can pick. */
  const names = (await s.get('/campus/destinations')).body.nodes.map((n) => n.name);
  assert.ok(!names.some((n) => /^Block \d|Room|11217/.test(n)), names.join(', '));
});

test('an order keeps the address it was placed with when the saved one changes', async () => {
  const s = await student();
  const b11 = (await s.get('/campus/blocks')).body.blocks.find((b) => b.number === 11);
  const { v, item } = await openOutlet();
  const d = await s.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'delivery',
    destinationId: place('Enrollment Office').id, pin: READINGS['22'],
    address: { blockId: b11.id, floor: '2', room: '17', landmark: 'Near the lift', instructions: 'Call me' } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  await s.put('/me/address', { blockText: 'Block 6', floor: '1', room: '3' });
  const o = (await pool.query(`SELECT * FROM food_order WHERE id = $1`, [d.body.id])).rows[0];
  assert.deepEqual([o.delivery_address.block, o.delivery_address.floor, o.delivery_address.room], ['Block 11', '2', '17']);
  assert.equal(o.delivery_landmark, 'Near the lift');
  assert.equal(o.destination_snapshot.name, 'Enrollment Office');
  assert.deepEqual(o.destination_snapshot.pin, { ...READINGS['22'], source: 'map' });
});

/* ======================= 9-13: what a student sees ======================== */

test('Café Frisco is retired, Chai Garam is listed without a position, Tulips stays', async () => {
  const names = (await client(app).get('/vendors')).body.vendors.map((v) => v.name).sort();
  assert.deepEqual(names, ['Chai Garam', 'Tulips Cafe']);
  const chai = (await pool.query(`SELECT * FROM vendor WHERE slug = 'chai-garam'`)).rows[0];
  assert.equal(chai.campus_node_id, null, 'no coordinate invented for Chai Garam');
  assert.equal(chai.is_open, false);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM menu_item WHERE vendor_id = $1`, [chai.id])).rows[0].n, 0);
  const frisco = (await pool.query(`SELECT active, campus_node_id FROM vendor WHERE slug = 'frisco'`)).rows[0];
  assert.equal(frisco.active, false, 'retired, not deleted');
  assert.equal(frisco.campus_node_id, place('Café Frisco').id, 'its evidence link is kept');
});

test('Energy Block, MAC, rooms and pending places are not offered; the four confirmed ones are', async () => {
  const s = await student();
  const d = (await s.get('/campus/destinations')).body;
  assert.equal(d.deliveryAvailable, true);
  assert.deepEqual(d.nodes.map((n) => n.name).sort(),
    ['Career Services / Placement Block', 'Enrollment Office', 'Management Development Centre', 'The Huddle']);
  const map = (await s.get('/campus/map')).body;
  assert.deepEqual(map.destinations.map((n) => n.name).sort(), d.nodes.map((n) => n.name).sort());
  assert.equal(map.boundary.polygon.length, OSM.length);

  /* MAC exists, pending, with no position - so it is nowhere a student looks. */
  const mac = (await pool.query(`SELECT * FROM campus_node WHERE name = 'MAC'`)).rows[0];
  assert.equal(mac.verification, 'pending');
  assert.equal(mac.lat, null);
  /* Energy Block keeps its evidence; only delivery is off. */
  const eb = (await pool.query(`SELECT * FROM campus_node WHERE name = 'Energy Block'`)).rows[0];
  assert.equal(eb.deliverable, false);
  assert.equal(eb.verification, 'confirmed');

  /* Search: a student cannot reach a room plate or Energy Block by typing it. */
  for (const q of ['11217', 'Room', 'Energy', 'MAC', 'Frisco', 'Infirmary', 'Hostel']) {
    assert.deepEqual((await s.get(`/campus/search?q=${q}`)).body.results, [], q);
  }
  /* Campus Control still sees the evidence records. */
  assert.equal((await (await staff()).get('/campus/search?q=11217')).body.results.length, 1);
  /* A room cannot be ordered to either. */
  const { v, item } = await openOutlet();
  const r = await s.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'delivery',
    destinationId: place('Block 11, Floor 2, Room 17').id });
  assert.ok(r.status >= 400);
  const eOrder = await s.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'delivery',
    destinationId: place('Energy Block').id });
  assert.ok(eOrder.status >= 400);
});

/* ======================= 14-16: ordering still works ====================== */

test('self pickup and the confirmed destinations still work; a pin must match its destination', async () => {
  const s = await student();
  const { v, item } = await openOutlet();
  const base = { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }] };
  assert.equal((await s.post('/orders/draft', { ...base, fulfilment: 'pickup' })).status, 200);
  for (const n of ['Enrollment Office', 'The Huddle', 'Career Services / Placement Block', 'Management Development Centre']) {
    assert.equal((await s.post('/orders/draft', { ...base, fulfilment: 'delivery', destinationId: place(n).id })).status, 200, n);
  }
  /* A pin at the Management Development Centre cannot ride on an Enrollment Office order. */
  const far = await s.post('/orders/draft', { ...base, fulfilment: 'delivery',
    destinationId: place('Enrollment Office').id, pin: READINGS['72'] });
  assert.equal(far.status, 400);
  assert.match(far.body.error, /not near Enrollment Office/);
});

test('with the boundary switched off, map, pin and delivery all fail closed; pickup does not', async () => {
  await pool.query(`UPDATE campus_boundary SET status = 'proposed', active = false, verified_at = NULL`);
  const s = await student();
  assert.equal((await s.post('/campus/pin', READINGS['22'])).status, 403);
  assert.equal((await s.get('/campus/map')).body.boundary, null);
  assert.deepEqual((await s.get('/campus/map')).body.destinations, []);
  const d = (await s.get('/campus/destinations')).body;
  assert.equal(d.deliveryAvailable, false);
  assert.deepEqual(d.nodes, []);
  const { v, item } = await openOutlet();
  const base = { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }] };
  assert.equal((await s.post('/orders/draft', { ...base, fulfilment: 'delivery', destinationId: place('Enrollment Office').id })).status, 403);
  assert.equal((await s.post('/orders/draft', { ...base, fulfilment: 'pickup' })).status, 200);
});
