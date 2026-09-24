/* ==========================================================================
   OPENING BIDHOLI DESTINATIONS FROM THE REVIEWED PLAN

   The committed plan (docs/campus/bidholi-destinations-2026-09-25.json) is
   applied by the real ops script to rows shaped exactly like production's:
   the same ids, names and positions, all pending, inside the OSM outline
   from migration 013. Nothing here is invented: every coordinate is read
   from the plan or the migration.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, campusId } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

const OWNER = 'owner.2@stu.upes.ac.in';
const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const PLAN = JSON.parse(fs.readFileSync(root('../docs/campus/bidholi-destinations-2026-09-25.json'), 'utf8'));
const OSM = JSON.parse(fs.readFileSync(root('src/db/013_campus_geography.sql'), 'utf8')
  .match(/'(\[\[30\.4156492[^']+)'::jsonb/)[1]);
const byName = (n) => PLAN.locations.find((l) => l.name === n);

let app, pool, cid, owner;

before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = OWNER;
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
  for (const l of PLAN.locations) {
    await pool.query(
      `INSERT INTO campus_node (id, campus_site_id, kind, name, deliverable, delivery_enabled, lat, lng, source, verification)
       VALUES ($1, $2, $3, $4, false, false, $5, $6, 'survey', 'pending')`,
      [l.id, cid, /Room/.test(l.name) || /Caf/.test(l.name) ? 'spot' : 'building', l.name, l.lat, l.lng]);
  }
  owner = await makeUser(pool, { phone: '+919700000090', name: 'Owner Person', roles: ['student', 'platform_owner'] });
  await pool.query(`UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`, [owner.id, OWNER]);
});

const script = (...args) => spawnSync(process.execPath, ['scripts/location-confirm.mjs', ...args],
  { cwd: root(''), env: process.env, encoding: 'utf8' });
const states = async () => Object.fromEntries((await pool.query(
  `SELECT name, verification, deliverable, delivery_enabled, verified_by, verification_method, place_type FROM campus_node`)).rows
  .map((r) => [r.name, r]));
const openCount = async () => (await pool.query(
  `SELECT count(*)::int n FROM campus_node WHERE deliverable AND delivery_enabled AND verification = 'confirmed'`)).rows[0].n;

test('the plan decides every production location, and opens only building-level evidence', () => {
  assert.equal(PLAN.locations.length, 17);
  const open = PLAN.locations.filter((l) => l.decision === 'deliver').map((l) => l.name).sort();
  assert.deepEqual(open, ['Career Services / Placement Block', 'Energy Block', 'Enrollment Office',
                          'Management Development Centre', 'The Huddle']);
  for (const l of PLAN.locations) {
    if (l.decision === 'deliver') { assert.ok(l.lat != null && l.evidence && l.confirmation.length >= 10, l.name); }
    else assert.ok(l.reason, l.name);
  }
  for (const r of PLAN.locations.filter((l) => /Room/.test(l.name))) assert.equal(r.decision, 'pending');
  for (const n of ['Girls Hostel gate', 'Infirmary', 'Café Frisco', 'Tulips Cafe']) assert.equal(byName(n).decision, 'pending');
  assert.ok(!PLAN.locations.some((l) => /Chai Garam/i.test(l.name)), 'Chai Garam is not created');
});

test('the default run is read-only', async () => {
  const out = script();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Enrollment Office\s+pending\s+CONFIRM \+ OPEN TO DELIVERY/);
  assert.match(out.stdout, /Read-only/);
  assert.equal(await openCount(), 0);
});

test('applying it opens exactly five destinations, and delivery with them', async () => {
  const stu = client(app, await sessionFor(pool, (await makeUser(pool, { phone: '+919700000091', name: 'Test Student' })).id));
  assert.equal((await stu.get('/campus/destinations')).body.deliveryAvailable, false);

  const out = script('--apply');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /5 location\(s\) confirmed and opened/);

  const s = await states();
  for (const n of ['Enrollment Office', 'The Huddle', 'Career Services / Placement Block', 'Management Development Centre', 'Energy Block']) {
    assert.equal(s[n].verification, 'confirmed', n);
    assert.equal(s[n].deliverable && s[n].delivery_enabled, true, n);
    assert.equal(s[n].verified_by, owner.id, n);
    assert.equal(s[n].verification_method, byName(n).method, n);
  }
  for (const l of PLAN.locations.filter((x) => x.decision === 'pending')) {
    assert.equal(s[l.name].verification, 'pending', l.name);
    assert.equal(s[l.name].deliverable, false, l.name);
  }
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'campus.location.confirm'`)).rows[0].n, 5);

  const d = await stu.get('/campus/destinations');
  assert.equal(d.body.deliveryAvailable, true);
  assert.equal(d.body.note, null);

  /* Through the real ordering gate: an opened destination is accepted, the
     rest are still refused, and self pickup is unchanged. */
  const v = await makeVendor(pool, { name: 'Test Outlet', slug: 'test-outlet' });
  const item = await makeItem(pool, v.id, { name: 'Tea', paise: 2000 });
  const draft = (destinationId, fulfilment = 'delivery') =>
    stu.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment, destinationId });
  assert.equal((await draft(byName('Enrollment Office').id)).status, 200);
  const gate = await draft(byName('Girls Hostel gate').id);
  assert.ok(gate.status === 400 || gate.status === 403, JSON.stringify(gate.body));
  assert.match(gate.body.error, /has not been confirmed|is an area|unavailable/);
  assert.equal((await draft(byName('Block 11, Floor 2, Room 17').id)).status >= 400, true);
  assert.equal((await draft(undefined, 'pickup')).status, 200);

  /* Running it again changes nothing. */
  const again = script('--apply');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /0 location\(s\) confirmed/);
});

test('a plan that disagrees with the database is refused whole', async () => {
  await pool.query(`UPDATE campus_node SET lat = lat + 0.0001 WHERE id = $1`, [byName('The Huddle').id]);
  const out = script('--apply');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /The Huddle: stored position .* differs/);
  assert.equal(await openCount(), 0, 'nothing was written, not even the entries that matched');
});

test('with no active boundary nothing is opened', async () => {
  await pool.query(`UPDATE campus_boundary SET status = 'proposed', active = false, verified_at = NULL`);
  const out = script('--apply');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /no active boundary/);
  assert.equal(await openCount(), 0);
});

test('Campus Control still confirms through the same function', async () => {
  const { tx } = await import('../src/db/index.js');
  const campus = await import('../src/services/campus.js');
  await assert.rejects(tx((c) => campus.confirmLocation(c, { id: byName('Infirmary').id, verifiedBy: owner.id, confirmation: 'short' })),
    /Record how you confirmed/);
  await assert.rejects(tx((c) => campus.enableDelivery(c, byName('Infirmary').id)), /Confirm Infirmary before/);
  await assert.rejects(tx((c) => campus.enableDelivery(c, byName('Block 1, Room 01').id)), /Confirm/);
});
