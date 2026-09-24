/* ==========================================================================
   CONFIRMING THE BIDHOLI BOUNDARY — and what that does and does not open.

   Uses the outline exactly as migration 013 ships it (OpenStreetMap way
   321638232, parsed out of the migration file, not retyped) and the field
   readings exactly as committed in docs/campus. Nothing here invents a
   coordinate: every point tested is either a vertex of that outline or a
   photograph's recorded position.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, truncateAll, makeUser, campusId } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

const OWNER = 'owner.1@stu.upes.ac.in';
const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

/* The shipped proposal, read from the migration that ships it. */
const OSM = JSON.parse(fs.readFileSync(root('src/db/013_campus_geography.sql'), 'utf8')
  .match(/'(\[\[30\.4156492[^']+)'::jsonb/)[1]);
const READINGS = fs.readFileSync(root('../docs/campus/bidholi-field-2026-09-readings.csv'), 'utf8')
  .trim().split(/\r?\n/).slice(1).map((r) => r.split(','))
  .map((c) => ({ n: c[0], lat: Number(c[4]), lng: Number(c[5]) }));

let app, pool, campus, cid, proposalId;

before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = OWNER;
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  campus = await import('../src/services/campus.js');
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });

beforeEach(async () => {
  await truncateAll(pool);
  cid = await campusId(pool);
  proposalId = (await pool.query(
    `INSERT INTO campus_boundary (name, polygon, active, status, source, campus_site_id, source_note)
     VALUES ('UPES Bidholi (proposed from OpenStreetMap)', $1, false, 'proposed',
             'openstreetmap:way/321638232', $2, 'as shipped by migration 013') RETURNING id`,
    [JSON.stringify(OSM), cid])).rows[0].id;
});

const owner = async () => {
  const u = await makeUser(pool, { phone: '+919700000070', name: 'Owner Person', roles: ['student', 'platform_owner'] });
  await pool.query(`UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`, [u.id, OWNER]);
  return u;
};
const script = (...args) => spawnSync(process.execPath, ['scripts/boundary-confirm.mjs', ...args],
  { cwd: root(''), env: process.env, encoding: 'utf8' });
const status = async () => (await pool.query(`SELECT status, verified_by, source_note FROM campus_boundary WHERE id = $1`, [proposalId])).rows[0];
let nth = 0;
const student = async () => client(app, await sessionFor(pool,
  (await makeUser(pool, { phone: `+91970000008${nth++}`, name: 'Test Student' })).id, { onCampus: false }));

/* The deepest committed reading: well inside, so a 10 m fix cannot straddle the edge. */
const deepest = () => READINGS
  .filter((p) => campus.pointInPolygon(p.lat, p.lng, OSM))
  .map((p) => ({ ...p, edge: campus.metresToEdge(p.lat, p.lng, OSM) }))
  .sort((a, b) => b.edge - a.edge)[0];

test('the committed evidence is what the report says it is: 113 of 114 inside', () => {
  const inside = READINGS.filter((p) => campus.pointInPolygon(p.lat, p.lng, OSM));
  assert.equal(READINGS.length, 114);
  assert.equal(inside.length, 113);
  assert.deepEqual(READINGS.filter((p) => !inside.includes(p)).map((p) => p.n), ['98']);
});

test('a proposed outline leaves every student refused, with this screen\'s own words', async () => {
  const c = await student();
  const p = deepest();
  const r = await c.post('/campus/presence', { lat: p.lat, lng: p.lng, accuracy: 10 });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /not switched on yet/);
  assert.doesNotMatch(r.body.detail, /from the list/, 'the presence screen has no list to choose from');
});

test('the report is read-only and shows the evidence', async () => {
  await owner();
  const out = script();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /PROPOSED/);
  assert.match(out.stdout, /field readings inside\s+113 of 114/);
  assert.match(out.stdout, /#98 30\.414623, 77\.970043 — 58 m beyond the edge/);
  assert.match(out.stdout, /No boundary is active/);
  assert.equal((await status()).status, 'proposed');
});

test('activation refuses without a written confirmation, and without an owner account', async () => {
  let out = script('--activate', proposalId);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /no platform_owner account/);
  await owner();
  out = script('--activate', proposalId, '--confirmation', 'ok');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /Record how you confirmed/);
  out = script('--activate', '00000000-0000-0000-0000-000000000000', '--confirmation', 'walked it end to end');
  assert.equal(out.status, 1);
  assert.equal((await status()).status, 'proposed', 'nothing was written');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_log`)).rows[0].n, 0);
});

test('the owner confirms it; the gate then decides by position, and delivery stays off', async () => {
  const o = await owner();
  const out = script('--activate', proposalId, '--confirmation', 'Checked the OSM outline against campus on foot, 24 Sep');
  assert.equal(out.status, 0, out.stderr);

  const row = await status();
  assert.equal(row.status, 'active');
  assert.equal(row.verified_by, o.id);
  assert.match(row.source_note, /Confirmed: Checked the OSM outline/);
  const a = (await pool.query(`SELECT * FROM audit_log WHERE action = 'campus.boundary.activate'`)).rows;
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_id, o.id);
  assert.equal(a[0].detail.via, 'ops:boundary-confirm');

  /* A second confirmation of the same outline is refused. */
  assert.equal(script('--activate', proposalId, '--confirmation', 'again, just to be sure').status, 1);

  const c = await student();
  const p = deepest();
  /* The server's verdict, from a committed field reading. */
  const ok = await c.post('/campus/presence', { lat: p.lat, lng: p.lng, accuracy: 10 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.confirmed, true);

  const s = await student();
  const r98 = READINGS.find((x) => x.n === '98');
  const outside = await s.post('/campus/presence', { lat: r98.lat, lng: r98.lng, accuracy: 5 });
  assert.equal(outside.status, 403);
  assert.match(outside.body.error, /not on campus/);
  const vague = await s.post('/campus/presence', { lat: p.lat, lng: p.lng, accuracy: 101 });
  assert.equal(vague.status, 403);
  assert.match(vague.body.detail, /accurate to about 101 m/);
  /* A committed reading inside the outline but under 15 m from its edge: a
     20 m fix there cannot say which side the student is on. */
  const rim = READINGS.find((x) => campus.pointInPolygon(x.lat, x.lng, OSM) && campus.metresToEdge(x.lat, x.lng, OSM) < 15);
  const edge = await s.post('/campus/presence', { lat: rim.lat, lng: rim.lng, accuracy: 20 });
  assert.equal(edge.status, 403);
  assert.match(edge.body.error, /edge of campus/);

  /* An outline delivers nowhere by itself: every delivery point is pending. */
  await pool.query(
    `INSERT INTO campus_node (campus_site_id, kind, name, deliverable, delivery_enabled, lat, lng, verification)
     VALUES ($1, 'spot', 'Unconfirmed candidate', false, false, $2, $3, 'pending')`, [cid, p.lat, p.lng]);
  const d = await c.get('/campus/destinations');
  assert.equal(d.body.deliveryAvailable, false);
  assert.match(d.body.note, /no delivery point has been confirmed/);
});

test('delivery is reported available only once a confirmed point lies inside', async () => {
  await owner();
  assert.equal(script('--activate', proposalId, '--confirmation', 'Checked on foot for this test').status, 0);
  assert.equal(await campus.deliveryAvailable(cid), false);
  const p = deepest();
  await pool.query(
    `INSERT INTO campus_node (campus_site_id, kind, name, deliverable, delivery_enabled, lat, lng, verification, source)
     VALUES ($1, 'spot', 'Confirmed test point', true, true, $2, $3, 'confirmed', 'admin')`, [cid, p.lat, p.lng]);
  assert.equal(await campus.deliveryAvailable(cid), true);
});
