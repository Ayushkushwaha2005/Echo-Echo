/* ==========================================================================
   FIELD GEODATA - import, confirmation, distances, perimeter comparison.

   Every coordinate in this file is TEST GEOMETRY around an arbitrary square.
   None of it describes UPES or any real place, and none of it is shipped.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, campusId } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool, geo;
before(async () => {
  await startDb();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  ({ pool } = await import('../src/db/index.js'));
  geo = await import('../src/services/geo-import.js');
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const as = async (u) => client(app, await sessionFor(pool, u.id));
const admin = async () => as(await makeUser(pool, { phone: '+919900000301', name: 'Geo Admin', roles: ['platform_admin'] }));

/* TEST square, ~300 m across. */
const SQUARE = [[30.4160, 77.9680], [30.4160, 77.9711], [30.4187, 77.9711], [30.4187, 77.9680]];

async function confirmBoundary(c, polygon = SQUARE) {
  const p = await c.put('/campus/boundary', { name: 'Test square', polygon, sourceNote: 'test geometry, not a real campus' });
  return (await c.post(`/admin/boundaries/${p.body.id}/activate`, { confirmation: 'confirmed for the test suite' })).body;
}

const CSV = `name,type,lat,lng,accuracy_m,method,deliverable,note
Test Pickup A,cafeteria_pickup,30.4165,77.9685,4,gps_on_site,no,test counter
Test Block One,academic_block,30.4178,77.9700,5,gps_on_site,yes,
Test Hostel Gate,entrance,30.4183,77.9705,38,gps_on_site,no,
`;

/* ======================= parsing ========================================= */

test('CSV, GPX and GeoJSON exports parse into the same points; bad rows are refused with reasons', () => {
  const csv = geo.parsePoints({ format: 'csv', text: CSV });
  assert.equal(csv.ok, true);
  assert.deepEqual(csv.points.map((p) => [p.name, p.type, p.kind]),
    [['Test Pickup A', 'cafeteria_pickup', 'spot'], ['Test Block One', 'academic_block', 'building'], ['Test Hostel Gate', 'entrance', 'spot']]);
  assert.match(csv.points[2].warnings.join(), /38 m is worse than 25 m/);

  const gpx = geo.parsePoints({ text: `<?xml version="1.0"?><gpx><wpt lat="30.4165" lon="77.9685"><name>Test Pickup A</name><type>cafeteria_pickup</type></wpt></gpx>` });
  assert.equal(gpx.format, 'gpx');
  assert.deepEqual([gpx.points[0].lat, gpx.points[0].lng], [30.4165, 77.9685]);

  const gj = geo.parsePoints({ text: JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [77.9685, 30.4165] }, properties: { name: 'Test Pickup A', type: 'cafeteria_pickup' } }] }) });
  assert.deepEqual([gj.points[0].lat, gj.points[0].lng], [30.4165, 77.9685], 'GeoJSON [lng, lat] order is respected');

  const bad = geo.parsePoints({ format: 'csv', text: 'name,type,lat,lng\n,academic_block,30.4,77.9\nX,spaceship,30.4,77.9\nY,library,91,77.9\nZ,library,abc,77.9\nZ,library,30.4,77.9\nZ,library,30.4,77.9' });
  assert.equal(bad.points.length, 1);
  assert.equal(bad.rejected.length, 5);
  assert.ok(bad.rejected.some((r) => /duplicate name/.test(r.problems.join())));
  assert.equal(geo.parsePoints({ format: 'csv', text: 'name,type\nA,library' }).ok, false, 'no lat/lng columns');
  assert.equal(geo.parsePoints({ text: '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><gpx/>' }).ok, false, 'no XML entities');
});

test('a walked track becomes a closed, simplified outline; gaps and junk are reported, not guessed', () => {
  /* A dense TEST walk around the square: 1 point per ~3 m. */
  const walk = [];
  const edge = (a, b, n) => { for (let i = 0; i < n; i++) walk.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]); };
  for (let k = 0; k < 4; k++) edge(SQUARE[k], SQUARE[(k + 1) % 4], 100);
  walk.push(SQUARE[0]);
  const gpx = `<gpx><trk><trkseg>${walk.map(([a, b]) => `<trkpt lat="${a}" lon="${b}"></trkpt>`).join('')}</trkseg></trk></gpx>`;
  const t = geo.parseTrack({ text: gpx });
  assert.equal(t.ok, true, JSON.stringify(t.problems));
  assert.equal(t.stats.trackPoints, 401);
  assert.ok(t.polygon.length >= 4 && t.polygon.length <= 8, `simplified to ${t.polygon.length} vertices`);
  assert.deepEqual(t.warnings, []);

  const open = geo.parseTrack({ format: 'csv', text: 'lat,lng\n30.4160,77.9680\n30.4160,77.9711\n30.4187,77.9711' });
  assert.equal(open.ok, true);
  assert.match(open.warnings.join(), /ends \d+ m from where it started/);
  assert.equal(geo.parseTrack({ format: 'csv', text: 'lat,lng\n30.4160,77.9680\nnope,77.97\n30.4187,77.9711' }).ok, false,
    'one bad coordinate refuses the whole track');
});

test('comparing two outlines reports area overlap, deviation and the vertices that differ', () => {
  const same = geo.comparePolygons(SQUARE, SQUARE);
  assert.ok(same.overlapPct > 99);
  assert.equal(same.maxDeviationM, 0);
  /* The same square pushed ~55 m east. */
  /* +3 m north as well, so no vertex lies exactly on the other outline's edge. */
  const shifted = SQUARE.map(([a, b]) => [a + 0.00003, b + 0.00057]);
  const d = geo.comparePolygons(SQUARE, shifted);
  /* ~298 m wide, shifted ~55 m: intersection 243 / union 353 ≈ 69 %. */
  assert.ok(d.overlapPct > 66 && d.overlapPct < 72, `overlap ${d.overlapPct}%`);
  assert.ok(d.maxDeviationM >= 50 && d.maxDeviationM <= 60, `deviation ${d.maxDeviationM} m`);
  /* Shifted east and slightly north: A's two west corners and its south-east
     corner fall outside B; B's two east corners and its north-west corner
     fall outside A. */
  assert.equal(d.verticesOfAOutsideB.length, 3);
  assert.equal(d.verticesOfBOutsideA.length, 3);
});

/* ======================= points over HTTP ================================ */

test('preview stores nothing and reports boundary placement, duplicates and weak accuracy', async () => {
  const c = await admin();
  const cid = await campusId(pool);
  const noBoundary = await c.post(`/admin/campuses/${cid}/points/preview`, { format: 'csv', text: CSV });
  assert.equal(noBoundary.status, 200);
  assert.equal(noBoundary.body.points[0].insideActiveBoundary, null);
  assert.match(noBoundary.body.points[0].warnings.join(), /no confirmed boundary/);

  await confirmBoundary(c);
  const r = await c.post(`/admin/campuses/${cid}/points/preview`, { format: 'csv',
    text: CSV + 'Test Outside,delivery_point,30.4300,77.9800,5,gps_on_site,yes,\n' });
  assert.equal(r.body.stored, false);
  const byName = Object.fromEntries(r.body.points.map((p) => [p.name, p]));
  assert.equal(byName['Test Block One'].insideActiveBoundary, true);
  assert.equal(byName['Test Outside'].insideActiveBoundary, false);
  assert.match(byName['Test Outside'].warnings.join(), /outside the confirmed boundary/);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM campus_node`)).rows[0].n, 0);
});

test('import as pending, then confirm the batch: evidence, confirming admin and timestamp are stored', async () => {
  const c = await admin();
  const cid = await campusId(pool);
  await confirmBoundary(c);
  const imp = await c.post(`/admin/campuses/${cid}/points/import`, { format: 'csv', text: CSV });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.created.length, 3);
  assert.ok(imp.body.created.every((x) => x.verification === 'pending'));
  const pending = (await pool.query(`SELECT * FROM campus_node WHERE import_batch = $1 ORDER BY name`, [imp.body.batch])).rows;
  assert.ok(pending.every((n) => n.deliverable === false), 'pending points are never deliverable');

  /* Same names again: refused whole, nothing half-imported. */
  const again = await c.post(`/admin/campuses/${cid}/points/import`, { format: 'csv', text: CSV });
  assert.equal(again.status, 409);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM campus_node`)).rows[0].n, 3);

  assert.equal((await c.post(`/admin/campuses/${cid}/points/confirm`, { batch: imp.body.batch })).status, 400, 'note required');
  const conf = await c.post(`/admin/campuses/${cid}/points/confirm`, { batch: imp.body.batch, confirmation: 'walked the test square with a phone' });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  const me = (await pool.query(`SELECT id FROM app_user WHERE phone = '+919900000301'`)).rows[0].id;
  const rows = (await pool.query(`SELECT * FROM campus_node WHERE import_batch = $1`, [imp.body.batch])).rows;
  for (const n of rows) {
    assert.equal(n.verification, 'confirmed');
    assert.equal(n.verified_by, me);
    assert.ok(n.verified_at);
    assert.equal(n.verification_method, 'gps_on_site');
    assert.ok(n.place_type);
    assert.equal(n.active, true);
    assert.match(n.source_note, /Imported .* from CSV/);
  }
  assert.equal(Number(rows.find((n) => n.name === 'Test Pickup A').gps_accuracy_m), 4);
  assert.ok((await pool.query(`SELECT 1 FROM audit_log WHERE action = 'campus.points.confirm'`)).rowCount);
});

test('confirm-on-import refuses public-map points and deliverable points outside the confirmed boundary', async () => {
  const c = await admin();
  const cid = await campusId(pool);
  await confirmBoundary(c);
  const pub = await c.post(`/admin/campuses/${cid}/points/import`, { format: 'csv', confirm: true, confirmation: 'collected on site today',
    text: 'name,type,lat,lng,method\nTest Map Point,library,30.4170,77.9695,public_map' });
  assert.equal(pub.status, 400);
  const outside = await c.post(`/admin/campuses/${cid}/points/import`, { format: 'csv', confirm: true, confirmation: 'collected on site today',
    text: 'name,type,lat,lng,method,deliverable\nTest Far Point,delivery_point,30.4300,77.9800,gps_on_site,yes' });
  assert.equal(outside.status, 409);
  const ok = await c.post(`/admin/campuses/${cid}/points/import`, { format: 'csv', confirm: true, confirmation: 'collected on site today',
    text: 'name,type,lat,lng,method,deliverable,accuracy_m\nTest Door,delivery_point,30.4170,77.9695,gps_on_site,yes,5' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const campus = await import('../src/services/campus.js');
  await assert.doesNotReject(() => campus.assertDeliverable(ok.body.created[0].id), 'a confirmed, positioned, inside point is deliverable');
});

test('a student or a shopkeeper cannot import, confirm or read the distance matrix', async () => {
  const cid = await campusId(pool);
  const stu = await as(await makeUser(pool, { phone: '+919900000302', name: 'Stu' }));
  for (const [m, u, body] of [['post', `/admin/campuses/${cid}/points/preview`, { format: 'csv', text: CSV }],
                              ['post', `/admin/campuses/${cid}/points/import`, { format: 'csv', text: CSV }],
                              ['post', `/admin/campuses/${cid}/points/confirm`, { batch: 'x', confirmation: 'xxxxxxxxxxxx' }],
                              ['get', `/admin/campuses/${cid}/distances`],
                              ['post', `/admin/campuses/${cid}/boundaries/import`, { format: 'csv', text: 'lat,lng', sourceNote: 'xxxxxxxxxxxx' }]]) {
    assert.equal((await stu[m](u, body)).status, 403, `${m} ${u}`);
  }
  assert.equal((await pool.query(`SELECT count(*)::int n FROM campus_node`)).rows[0].n, 0);
});

test('distance matrix: ranges only between confirmed points, with the reason when unavailable', async () => {
  const c = await admin();
  const cid = await campusId(pool);
  await confirmBoundary(c);
  const imp = await c.post(`/admin/campuses/${cid}/points/import`, { format: 'csv', confirm: true, confirmation: 'collected on site today', text: CSV });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const pickup = imp.body.created.find((x) => x.name === 'Test Pickup A');
  const v = await makeVendor(pool, { name: 'Test Cafe', slug: 'test-cafe' });
  const w = await makeVendor(pool, { name: 'Test Cafe Two', slug: 'test-cafe-2' });
  assert.equal((await c.patch(`/vendors/${v.id}`, { campusNodeId: pickup.id })).status, 200);

  const r = await c.get(`/admin/campuses/${cid}/distances`);
  assert.equal(r.status, 200);
  const row = r.body.rows.find((x) => x.vendor === 'Test Cafe' && x.point === 'Test Block One');
  assert.match(row.estimate, /^Approx\. \d+–\d+ min$/);
  assert.ok(row.metres > 150 && row.metres < 250, `${row.metres} m`);
  assert.equal(row.insideActiveBoundary, true);
  assert.equal(r.body.rows.find((x) => x.vendor === 'Test Cafe Two').unavailableBecause, 'cafeteria has no pickup point');
  assert.ok(!r.body.rows.some((x) => x.point === 'Test Pickup A'), 'pickup points are not delivery destinations');
  assert.equal(w.name, 'Test Cafe Two');
});

test('moving a confirmed location requires the method of the new position', async () => {
  const c = await admin();
  const cid = await campusId(pool);
  await confirmBoundary(c);
  const imp = await c.post(`/admin/campuses/${cid}/points/import`, { format: 'csv', confirm: true, confirmation: 'collected on site today', text: CSV });
  const id = imp.body.created[1].id;
  assert.equal((await c.patch(`/campus/nodes/${id}`, { lat: 30.4179, lng: 77.9701 })).status, 400);
  assert.equal((await c.patch(`/campus/nodes/${id}`, { lat: 30.4179, lng: 77.9701, verificationMethod: 'gps_on_site', gpsAccuracyM: 3 })).status, 200);
  const a = (await pool.query(`SELECT detail FROM audit_log WHERE action = 'campus.update' ORDER BY at DESC LIMIT 1`)).rows[0].detail;
  assert.equal(a.before.lat, 30.4178);
  assert.equal(a.after.lat, 30.4179);
});

/* ======================= perimeter over HTTP ============================= */

test('a walked perimeter becomes a PROPOSAL, compared with the existing outline; delivery stays off until confirmed', async () => {
  const c = await admin();
  const cid = await campusId(pool);
  /* An existing proposal (standing in for the OSM one) and nothing active. */
  const osmLike = await c.put('/campus/boundary', { name: 'Map proposal (test)', polygon: SQUARE, sourceNote: 'test geometry, not a real campus' });
  const shifted = SQUARE.map(([a, b]) => [a, b + 0.00057]);
  const csv = 'lat,lng\n' + shifted.map(([a, b]) => `${a},${b}`).join('\n');

  const dry = await c.post(`/admin/campuses/${cid}/boundaries/import`, { format: 'csv', text: csv, sourceNote: 'walked the test fence', dryRun: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.stored, false);
  assert.equal(dry.body.comparisons[0].withId, osmLike.body.id);
  assert.ok(dry.body.comparisons[0].maxDeviationM >= 50);

  const imp = await c.post(`/admin/campuses/${cid}/boundaries/import`, { format: 'csv', text: csv, name: 'Walked (test)', sourceNote: 'walked the test fence' });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.status, 'proposed');
  const states = (await pool.query(`SELECT name, status FROM campus_boundary ORDER BY created_at`)).rows;
  assert.deepEqual(states.map((s) => s.status), ['proposed', 'proposed'], 'nothing replaced, nothing activated');
  assert.equal((await c.get('/campus/boundary')).body.boundary, null, 'delivery area still unconfirmed');

  /* A location near the east edge changes sides between the two outlines. */
  await pool.query(`INSERT INTO campus_node (campus_site_id, kind, name, lat, lng, source, verification, verification_method)
                    VALUES ($1,'spot','Test East Spot',30.4170,77.9714,'survey','confirmed','gps_on_site')`, [cid]);
  const cmp = await c.get(`/admin/boundaries/${imp.body.id}/compare?with=${osmLike.body.id}`);
  assert.equal(cmp.status, 200, JSON.stringify(cmp.body));
  assert.ok(cmp.body.areaM2.onlyInA > 0 && cmp.body.areaM2.onlyInB > 0);
  assert.deepEqual(cmp.body.locationsThatChangeSides.map((x) => [x.name, x.inA, x.inB]), [['Test East Spot', true, false]]);
  assert.equal((await c.get(`/admin/boundaries/${imp.body.id}/compare?with=active`)).status, 404, 'nothing active to compare with yet');
});
