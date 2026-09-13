/* ==========================================================================
   CAMPUS CONFIGURATION — boundary and hostel structure.

   Nothing here seeds a real-world coordinate. The point of these tests is
   the opposite: that Quad refuses to guess. Live location is unusable until
   an administrator configures a boundary, hostels stay undeliverable until
   an administrator enters the real blocks, and a customer can never create
   a location of their own.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool, campus;

before(async () => {
  await startDb();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  ({ pool } = await import('../src/db/index.js'));
  campus = await import('../src/services/campus.js');
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const as = async (u) => client(app, await sessionFor(pool, u.id));
const admin = async (phone = '+919900000001') =>
  as(await makeUser(pool, { phone, name: 'Adm', roles: ['platform_admin'] }));

/* A small square roughly 300 m across. Deliberately NOT presented as UPES:
   it is test geometry, and the suite never claims otherwise. */
const SQUARE = [[30.4160, 77.9680], [30.4160, 77.9711],
                [30.4187, 77.9711], [30.4187, 77.9680]];

/* A boundary is proposed, then confirmed by an administrator. Only the
   confirmed one is ever used. */
async function confirmBoundary(c, name = 'Test Campus', polygon = SQUARE) {
  const p = await c.put('/campus/boundary', { name, polygon, source: 'test', sourceNote: 'test geometry, not UPES' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const a = await c.post(`/admin/boundaries/${p.body.id}/activate`, { confirmation: 'confirmed for the test suite' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return a.body;
}

/* ======================= boundary: refuses to guess ====================== */

test('live location is unusable until an administrator configures a boundary', async () => {
  const out = await campus.resolveFix(30.4170, 77.9695);
  assert.equal(out.inside, false);
  assert.equal(out.reason, 'no_boundary_configured');
  assert.deepEqual(out.candidates, []);
  assert.match(out.note, /has not been confirmed/);
});

test('the boundary endpoint reports honestly that none is set', async () => {
  const c = await admin();
  const r = await c.get('/campus/boundary');
  assert.equal(r.status, 200);
  assert.equal(r.body.boundary, null, 'null, not an invented default');
});

/* ======================= boundary: validation =========================== */

test('a nonsense boundary is refused with a reason a person can act on', async () => {
  const c = await admin();
  const cases = [
    ['too few points', [[30.41, 77.96], [30.42, 77.97]]],
    ['not pairs', [[30.41], [30.42, 77.97], [30.43, 77.98]]],
    ['non-numeric', [['a', 'b'], [30.42, 77.97], [30.43, 77.98]]],
    ['latitude out of range', [[91, 77.96], [30.42, 77.97], [30.43, 77.98]]],
    ['longitude out of range', [[30.41, 181], [30.42, 77.97], [30.43, 77.98]]],
    ['a line, not an area', [[30.4160, 77.9680], [30.4160, 77.96801], [30.4160, 77.96802]]],
    ['spans a continent', [[10, 70], [10, 90], [40, 90], [40, 70]]],
  ];
  for (const [why, polygon] of cases) {
    const r = await c.put('/campus/boundary', { name: 'X', polygon, sourceNote: 'test geometry' });
    assert.equal(r.status, 400, `${why} must be refused`);
    assert.ok(r.body.detail && r.body.detail.length > 0, `${why} must explain itself`);
  }
  const stored = await pool.query(`SELECT count(*)::int AS n FROM campus_boundary`);
  assert.equal(stored.rows[0].n, 0, 'nothing invalid was stored');
});

test('swapped latitude and longitude is surfaced as a warning, with the centroid', async () => {
  const c = await admin();
  /* Swapping puts this campus at 77.9°N — geometrically valid, so it cannot
     honestly be rejected outright (Tromsø is at 69°N). What the system owes
     the admin is the consequence, stated plainly. */
  const swapped = SQUARE.map(([lat, lng]) => [lng, lat]);
  const check = await c.post('/campus/boundary/validate', { polygon: swapped });
  assert.equal(check.body.ok, true, 'it is a valid polygon, just probably not the one intended');
  assert.equal(check.body.warnings.length, 1);
  assert.match(check.body.warnings[0], /swapped/i);
  assert.ok(check.body.metrics.centroid.lat > 60, 'the centroid shows where it really is');

  /* The correct orientation produces no warning. */
  const right = await c.post('/campus/boundary/validate', { polygon: SQUARE });
  assert.deepEqual(right.body.warnings, []);
  assert.ok(Math.abs(right.body.metrics.centroid.lat - 30.417) < 0.01);
});

test('a valid boundary is proposed, measured and audited - and does nothing until confirmed', async () => {
  const c = await admin();
  assert.equal((await c.put('/campus/boundary', { name: 'No source', polygon: SQUARE })).status, 400,
    'an outline without a stated source is refused');
  const r = await c.put('/campus/boundary',
    { name: 'Test Campus', polygon: SQUARE, source: 'survey', sourceNote: 'traced from a survey walk' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'proposed');
  assert.ok(r.body.metrics.widthM > 100 && r.body.metrics.widthM < 1000);
  assert.ok(r.body.metrics.areaM2 > 10_000);
  assert.equal((await campus.resolveFix(30.4170, 77.9695, { accuracy: 10 })).reason, 'no_boundary_configured',
    'a proposal is not used');
  assert.equal((await c.get('/campus/boundary')).body.boundary, null);

  assert.equal((await c.post(`/admin/boundaries/${r.body.id}/activate`, {})).status, 400, 'confirmation must be recorded');
  const on = await c.post(`/admin/boundaries/${r.body.id}/activate`, { confirmation: 'walked the perimeter' });
  assert.equal(on.status, 200);
  assert.ok(on.body.verified_at);
  const a = await pool.query(`SELECT action FROM audit_log WHERE action LIKE 'campus.boundary.%' ORDER BY at`);
  assert.deepEqual(a.rows.map((x) => x.action), ['campus.boundary.propose', 'campus.boundary.activate']);

  /* A second confirmed outline retires the first; one is ever active. */
  const r2 = await c.put('/campus/boundary', { name: 'Revised', polygon: SQUARE, sourceNote: 'resurveyed perimeter' });
  await c.post(`/admin/boundaries/${r2.body.id}/activate`, { confirmation: 'checked gates again' });
  const states = (await pool.query(`SELECT status FROM campus_boundary ORDER BY created_at`)).rows.map((x) => x.status);
  assert.deepEqual(states, ['retired', 'active']);
});

test('an admin can dry-run an outline before committing to it', async () => {
  const c = await admin();
  const bad = await c.post('/campus/boundary/validate', { polygon: [[0, 0], [0, 0], [0, 0]] });
  assert.equal(bad.body.ok, false);
  const good = await c.post('/campus/boundary/validate', { polygon: SQUARE });
  assert.equal(good.body.ok, true);
  /* Validating stores nothing. */
  const stored = await pool.query(`SELECT count(*)::int AS n FROM campus_boundary`);
  assert.equal(stored.rows[0].n, 0);
});

test('only an administrator can set the boundary', async () => {
  const stu = await as(await makeUser(pool, { phone: '+919900000010', name: 'A' }));
  assert.equal((await stu.put('/campus/boundary', { name: 'Mine', polygon: SQUARE })).status, 403);
});

/* ======================= boundary: enforcement ========================== */

test('once configured, inside is accepted and outside is refused — server-side', async () => {
  const c = await admin();
  await confirmBoundary(c);

  const inside = await campus.resolveFix(30.4170, 77.9695, { accuracy: 10 });
  assert.equal(inside.inside, true);
  assert.equal(inside.boundaryName, 'Test Campus');

  for (const [lat, lng, where] of [[28.6139, 77.2090, 'Delhi'],
                                   [30.3165, 78.0322, 'Dehradun city'],
                                   [30.4300, 77.9695, 'just north of campus']]) {
    const out = await campus.resolveFix(lat, lng, { accuracy: 10 });
    assert.equal(out.inside, false, `${where} must be outside`);
    assert.equal(out.reason, 'outside_campus');
    assert.deepEqual(out.candidates, [], 'no candidates are offered off campus');
  }
});

test('an imprecise GPS fix suggests nothing, even inside the boundary', async () => {
  const c = await admin();
  await confirmBoundary(c);

  const vague = await campus.resolveFix(30.4170, 77.9695, { accuracy: 1500 });
  assert.equal(vague.inside, false);
  assert.equal(vague.reason, 'low_accuracy');
  assert.deepEqual(vague.candidates, []);

  const good = await campus.resolveFix(30.4170, 77.9695, { accuracy: 12 });
  assert.equal(good.inside, true, 'a normal outdoor fix is still used');

  /* Unknown accuracy is not a precise fix. */
  for (const accuracy of [undefined, null, '', 'x', -5]) {
    const unknown = await campus.resolveFix(30.4170, 77.9695, { accuracy });
    assert.equal(unknown.inside, false, `accuracy ${accuracy} must not be trusted`);
    assert.equal(unknown.reason, 'accuracy_unknown');
  }

  /* Inside, but nearer the edge than the fix's uncertainty: no suggestion. */
  const edge = await campus.resolveFix(30.41605, 77.9695, { accuracy: 40 });
  assert.equal(edge.inside, false);
  assert.equal(edge.reason, 'near_boundary');
  assert.equal((await campus.resolveFix(30.41605, 77.9695, { accuracy: 3 })).inside, true, 'a precise fix at the edge is fine');
});

test('a GPS fix is a claim: the client cannot assert it is on campus', async () => {
  const c = await admin();
  await confirmBoundary(c);
  const stu = await as(await makeUser(pool, { phone: '+919900000011', name: 'A' }));

  /* The client sends coordinates; the SERVER decides. Extra fields it might
     hope are trusted are simply not read. */
  const r = await stu.post('/campus/locate',
    { lat: 28.6139, lng: 77.2090, accuracy: 10, inside: true, onCampus: true, verified: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.inside, false, 'the claim is ignored; the polygon decides');
});

test('malformed coordinates are rejected, not coerced', async () => {
  const c = await admin();
  await confirmBoundary(c, 'T');
  const stu = await as(await makeUser(pool, { phone: '+919900000012', name: 'A' }));
  for (const body of [{}, { lat: 'x', lng: 'y' }, { lat: null, lng: null },
                      { lat: Infinity, lng: 0 }]) {
    const r = await stu.post('/campus/locate', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} must be refused`);
  }
});

/* ======================= hostels: admin-configured ====================== */

test('an administrator builds the full Campus → Zone → Block → Floor → Room hierarchy', async () => {
  const c = await admin();

  const zone = (await c.post('/campus/nodes',
    { kind: 'zone', name: 'Hostel Area', aliases: ['hostel'] })).body;
  /* A zone is a container: not deliverable itself. */
  assert.equal(zone.deliverable, false);

  const block = (await c.post('/campus/nodes',
    { kind: 'building', name: 'Boys Hostel Block 1', parentId: zone.id,
      aliases: ['boys hostel 1'], deliverable: false })).body;
  const floor = (await c.post('/campus/nodes',
    { kind: 'floor', name: '2nd Floor', parentId: block.id, deliverable: false })).body;
  const room = (await c.post('/campus/nodes',
    { kind: 'spot', name: 'Room 204', parentId: floor.id, deliverable: true })).body;

  assert.equal(room.deliverable, true);

  /* The tree really is a tree, and resolves to a full path. */
  const path = await campus.pathLabel(room.id);
  assert.equal(path, 'Hostel Area — Boys Hostel Block 1 — 2nd Floor — Room 204');

  /* And the deliverable leaf is reachable from the zone. */
  const options = await campus.destinationOptions(zone.id);
  assert.deepEqual(options.map((o) => o.id), [room.id]);
});

test('a container node is never accepted as a delivery destination', async () => {
  const c = await admin();
  await confirmBoundary(c);
  const zone = (await c.post('/campus/nodes', { kind: 'zone', name: 'Hostel Area' })).body;
  const block = (await c.post('/campus/nodes',
    { kind: 'building', name: 'Block 1', parentId: zone.id })).body;

  for (const node of [zone, block]) {
    await assert.rejects(() => campus.assertDeliverable(node.id), /area, not a delivery point/);
  }
});

test('delivery availability is controlled per node by the admin', async () => {
  const c = await admin();
  await confirmBoundary(c);
  const zone = (await c.post('/campus/nodes', { kind: 'zone', name: 'Hostel Area' })).body;
  const room = (await c.post('/campus/nodes',
    { kind: 'spot', name: 'Room 101', parentId: zone.id, deliverable: true, lat: 30.4170, lng: 77.9695 })).body;

  /* Deliverable by default once created that way. */
  await assert.doesNotReject(() => campus.assertDeliverable(room.id));

  /* Admin switches it off — no deploy, no code change. */
  await c.patch(`/campus/nodes/${room.id}`, { deliveryEnabled: false });
  await assert.rejects(() => campus.assertDeliverable(room.id), /unavailable/);

  /* And back on. */
  await c.patch(`/campus/nodes/${room.id}`, { deliveryEnabled: true });
  await assert.doesNotReject(() => campus.assertDeliverable(room.id));

  /* Archiving is different from disabling, and also refuses. */
  await c.post(`/campus/nodes/${room.id}/archive`);
  await assert.rejects(() => campus.assertDeliverable(room.id), /archived/);
});

test('a customer cannot create, edit, archive or enable any location', async () => {
  const c = await admin();
  const zone = (await c.post('/campus/nodes', { kind: 'zone', name: 'Hostel Area' })).body;
  const room = (await c.post('/campus/nodes',
    { kind: 'spot', name: 'Room 1', parentId: zone.id, deliverable: true,
      deliveryEnabled: false })).body;

  const stu = await as(await makeUser(pool, { phone: '+919900000020', name: 'A' }));
  const attempts = [
    ['post', '/campus/nodes', { kind: 'spot', name: 'My room', deliverable: true }],
    ['patch', `/campus/nodes/${room.id}`, { deliveryEnabled: true }],
    ['patch', `/campus/nodes/${room.id}`, { name: 'Renamed' }],
    ['post', `/campus/nodes/${room.id}/archive`, {}],
  ];
  for (const [m, url, body] of attempts) {
    const r = await stu[m](url, body);
    assert.equal(r.status, 403, `${m.toUpperCase()} ${url} must be refused`);
  }

  const after = (await pool.query(
    `SELECT name, delivery_enabled, active FROM campus_node WHERE id=$1`, [room.id])).rows[0];
  assert.equal(after.name, 'Room 1', 'nothing was changed');
  assert.equal(after.delivery_enabled, false);
  assert.equal(after.active, true);
  const invented = await pool.query(`SELECT count(*)::int AS n FROM campus_node WHERE name='My room'`);
  assert.equal(invented.rows[0].n, 0, 'no customer-created location exists');
});

test('an order cannot be delivered to a hostel node the admin has not enabled', async () => {
  const c = await admin();
  await confirmBoundary(c);
  const zone = (await c.post('/campus/nodes', { kind: 'zone', name: 'Hostel Area' })).body;
  const room = (await c.post('/campus/nodes',
    { kind: 'spot', name: 'Room 204', parentId: zone.id, deliverable: true,
      deliveryEnabled: false, lat: 30.4170, lng: 77.9695 })).body;

  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  await pool.query(`UPDATE vendor SET is_open=true, accepting=true WHERE id=$1`, [v.id]);
  const item = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const stu = await as(await makeUser(pool, { phone: '+919900000021', name: 'A' }));

  const blocked = await stu.post('/orders/draft', {
    vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }],
    fulfilment: 'delivery', destinationId: room.id });
  assert.equal(blocked.status, 403);

  /* The admin enables it, and the same request now works. */
  await c.patch(`/campus/nodes/${room.id}`, { deliveryEnabled: true });
  const ok = await stu.post('/orders/draft', {
    vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }],
    fulfilment: 'delivery', destinationId: room.id });
  assert.equal(ok.status, 200);
});

test('the zones view reports real counts for the admin', async () => {
  const c = await admin();
  const zone = (await c.post('/campus/nodes', { kind: 'zone', name: 'Hostel Area' })).body;
  await c.post('/campus/nodes', { kind: 'spot', name: 'Room 1', parentId: zone.id, deliverable: true });
  await c.post('/campus/nodes', { kind: 'spot', name: 'Room 2', parentId: zone.id, deliverable: true });

  const z = (await c.get('/campus/zones')).body.zones.find((x) => x.id === zone.id);
  assert.equal(z.locations, 2, 'counted from the database, not guessed');
  assert.equal(z.active_deliveries, 0);
});

/* ======================= fail-closed delivery ============================ */

test('no confirmed boundary: every delivery destination is refused, pickup still works', async () => {
  const c = await admin();
  const zone = (await c.post('/campus/nodes', { kind: 'zone', name: 'Library' })).body;
  const spot = (await c.post('/campus/nodes', { kind: 'spot', name: 'Reading Hall', parentId: zone.id, deliverable: true })).body;
  const v = await makeVendor(pool, { name: 'F', slug: 'fc' });
  const item = await makeItem(pool, v.id, { name: 'Tea', paise: 2000 });
  const stu = await as(await makeUser(pool, { phone: '+919900000030', name: 'Asha Rao' }));

  const d = await stu.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'delivery', destinationId: spot.id });
  assert.equal(d.status, 403);
  assert.match(d.body.error, /Campus delivery is not available yet/);
  const p = await stu.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'pickup' });
  assert.equal(p.status, 200, 'self pickup is unaffected');

  const dest = await stu.get('/campus/destinations');
  assert.equal(dest.body.deliveryAvailable, false);

  /* A proposed outline changes nothing. */
  await c.put('/campus/boundary', { name: 'P', polygon: SQUARE, sourceNote: 'proposal only' });
  assert.equal((await stu.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'delivery', destinationId: spot.id })).status, 403);
});

test('a destination whose recorded position is outside the confirmed boundary is refused', async () => {
  const c = await admin();
  await confirmBoundary(c);
  const zone = (await c.post('/campus/nodes', { kind: 'zone', name: 'Zone' })).body;
  const outside = (await c.post('/campus/nodes', { kind: 'spot', name: 'Gate Tea Stall', parentId: zone.id, deliverable: true, lat: 30.4300, lng: 77.9695 })).body;
  const inside = (await c.post('/campus/nodes', { kind: 'spot', name: 'Quad Lawn', parentId: zone.id, deliverable: true, lat: 30.4170, lng: 77.9695 })).body;
  await assert.rejects(() => campus.assertDeliverable(outside.id), /outside the campus delivery area/);
  await assert.doesNotReject(() => campus.assertDeliverable(inside.id));
  assert.equal((await c.post('/campus/nodes', { kind: 'spot', name: 'Half', lat: 30.41 })).status, 400, 'coordinates come in pairs');
});

test('a destination on another campus cannot be used, and Kandholi has no destinations', async () => {
  const c = await admin();
  await confirmBoundary(c);
  const kan = (await pool.query(`SELECT id FROM campus_site WHERE slug='upes-kandholi'`)).rows[0].id;
  const kanSpot = (await c.post('/campus/nodes', { kind: 'spot', name: 'K Spot', deliverable: true, campusSiteId: kan })).body;
  const bid = (await pool.query(`SELECT id FROM campus_site WHERE slug='upes-bidholi'`)).rows[0].id;
  await assert.rejects(() => campus.assertDeliverable(kanSpot.id, { campusId: bid }), /not on this campus/);
  await assert.rejects(() => campus.assertDeliverable(kanSpot.id), /not available yet/, 'Kandholi has no confirmed boundary');

  /* A Bidholi student does not see Kandholi's tree even if they ask for it. */
  const stu = await as(await makeUser(pool, { phone: '+919900000031', name: 'Ira Sen' }));
  const r = await stu.get(`/campus/destinations?campusId=${kan}`);
  assert.ok(!r.body.nodes.some((n) => n.id === kanSpot.id));
});

test('distance and time are an honest range from recorded points only', async () => {
  const c = await admin();
  await confirmBoundary(c);
  const zone = (await c.post('/campus/nodes', { kind: 'zone', name: 'Zone' })).body;
  const counter = (await c.post('/campus/nodes', { kind: 'spot', name: 'Frisco counter', parentId: zone.id, lat: 30.4165, lng: 77.9685 })).body;
  const far = (await c.post('/campus/nodes', { kind: 'spot', name: 'North Lawn', parentId: zone.id, deliverable: true, lat: 30.4183, lng: 77.9705 })).body;
  const unsurveyed = (await c.post('/campus/nodes', { kind: 'spot', name: 'Room 12', parentId: zone.id, deliverable: true })).body;
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco-eta' });
  await pool.query(`UPDATE vendor SET campus_node_id = $1 WHERE id = $2`, [counter.id, v.id]);

  const stu = await as(await makeUser(pool, { phone: '+919900000032', name: 'Om Das' }));
  const r = await stu.get(`/campus/destinations?parent=${zone.id}&vendorId=${v.id}`);
  const e = r.body.nodes.find((n) => n.id === far.id).estimate;
  assert.ok(e.metres >= 250 && e.metres <= 300, `about 270 m straight line, got ${e.metres}`);
  assert.match(e.label, /^Approx\. \d+–\d+ min$/);
  assert.ok(e.maxMinutes > e.minMinutes);
  assert.equal(r.body.nodes.find((n) => n.id === unsurveyed.id).estimate, null, 'no position, no estimate');
  assert.ok(!('lat' in r.body.nodes[0]), 'coordinates are not sent to students');
});

/* ======================= location verification ========================== */

test('a location with no recorded position, or still pending confirmation, is never a delivery point', async () => {
  const c = await admin();
  await confirmBoundary(c);
  const noPos = (await c.post('/campus/nodes', { kind: 'spot', name: 'Unmeasured Spot', deliverable: true })).body;
  await assert.rejects(() => campus.assertDeliverable(noPos.id), /no recorded position/);

  const cid = (await pool.query(`SELECT id FROM campus_site WHERE slug = 'upes-bidholi'`)).rows[0].id;
  const pending = (await pool.query(
    `INSERT INTO campus_node (campus_site_id, kind, name, deliverable, lat, lng, source, verification)
     VALUES ($1,'building','Map Candidate', false, 30.4170, 77.9695, 'public_source', 'pending') RETURNING *`, [cid])).rows[0];
  await assert.rejects(() => pool.query(`UPDATE campus_node SET deliverable = true WHERE id = $1`, [pending.id]),
    /campus_node_pending_not_deliverable/, 'the database refuses a deliverable pending location');
  const early = await c.patch(`/campus/nodes/${pending.id}`, { deliverable: true });
  assert.equal(early.status, 409);

  assert.equal((await c.post(`/campus/nodes/${pending.id}/confirm`, {})).status, 400, 'confirmation note required');
  const ok = await c.post(`/campus/nodes/${pending.id}/confirm`, { confirmation: 'visited on foot, hand-over at main door' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.verification, 'confirmed');
  assert.equal((await c.patch(`/campus/nodes/${pending.id}`, { deliverable: true })).status, 200);
  await assert.doesNotReject(() => campus.assertDeliverable(pending.id));
  const logged = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'campus.location.confirm'`);
  assert.equal(logged.rowCount, 1);
});

test('the shipped UPES Bidholi candidates are pending, sourced and not deliverable', async () => {
  /* truncateAll clears campus_node, so re-apply exactly what migration 016 inserts. */
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../src/db/016_location_verification.sql', import.meta.url), 'utf8');
  await pool.query(sql.slice(sql.indexOf('INSERT INTO campus_node')));
  const rows = (await pool.query(`SELECT name, verification, deliverable, source, source_note, lat, lng FROM campus_node ORDER BY name`)).rows;
  assert.deepEqual(rows.map((r) => r.name), ['Energy Block', 'Infirmary']);
  for (const r of rows) {
    assert.equal(r.verification, 'pending');
    assert.equal(r.deliverable, false);
    assert.equal(r.source, 'public_source');
    assert.match(r.source_note, /OpenStreetMap (way|node) \d+/);
  }
});
