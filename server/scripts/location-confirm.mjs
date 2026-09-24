/* ==========================================================================
   ECHO ECHO — CONFIRM CAMPUS DELIVERY DESTINATIONS FROM A REVIEWED PLAN
   (owner, ops)

     npm run locations:confirm:local                       # read-only check
     npm run locations:confirm:local -- --apply            # write it
     npm run locations:confirm:local -- --plan <file.json> [--apply]

   The plan (default docs/campus/bidholi-destinations-2026-09-25.json) is the
   reviewed decision for every location: `deliver` or `pending`, with the
   evidence. This script does not decide anything and cannot move a point.
   Before writing it checks EVERY entry against the database and refuses the
   whole plan if any disagrees:

     - the id exists, on this campus, with exactly this name;
     - its recorded position is exactly the plan's (a plan cannot smuggle in
       a coordinate: it can only confirm the one already stored);
     - a `deliver` entry lies inside the campus's ACTIVE boundary.

   Then, in one transaction, each `deliver` entry is confirmed (the same
   function Campus Control uses) and opened to delivery, with the platform
   owner as the verifier and an audit_log row each. `pending` entries are not
   touched. Re-running is harmless: a location already open is skipped.
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool } from '../src/db/index.js';
import { PLATFORM_OWNER, DB } from '../src/config.js';
import { confirmLocation, enableDelivery, pointInPolygon } from '../src/services/campus.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const apply = process.argv.includes('--apply');
const planPath = arg('--plan') ? resolve(arg('--plan'))
  : fileURLToPath(new URL('../../docs/campus/bidholi-destinations-2026-09-25.json', import.meta.url));

if (!DB.configured) { console.error('✗ DATABASE_URL is not set.'); process.exit(1); }
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-7);

const c = await pool.connect();
let code = 0;
try {
  await c.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  const site = (await c.query(`SELECT id, name FROM campus_site WHERE slug = $1`, [plan.campus])).rows[0];
  if (!site) throw new Error(`No campus ${plan.campus}.`);
  const boundary = (await c.query(
    `SELECT id, polygon FROM campus_boundary WHERE campus_site_id = $1 AND status = 'active'`, [site.id])).rows[0];
  console.log(`\n${site.name} on ${new URL(DB.url).hostname} — plan ${planPath.split(/[\\/]/).pop()}`);
  console.log(`  active boundary: ${boundary ? boundary.id : 'NONE'}\n`);

  const problems = [];
  const rows = [];
  for (const e of plan.locations) {
    /* A pending place created later (by a migration) has no id in the plan:
       it is listed for the record and never touched. */
    if (!e.id) {
      if (e.decision === 'deliver') problems.push(`${e.name}: a destination to open needs its id`);
      rows.push({ e, n: null });
      continue;
    }
    const n = (await c.query(`SELECT * FROM campus_node WHERE id = $1`, [e.id]).catch(() => ({ rows: [] }))).rows[0];
    if (!n) { problems.push(`${e.name}: no location with id ${e.id}`); continue; }
    if (n.campus_site_id !== site.id) problems.push(`${e.name}: belongs to another campus`);
    if (n.name !== e.name) problems.push(`${e.id}: is "${n.name}" in the database, "${e.name}" in the plan`);
    if (!same(n.lat, e.lat) || !same(n.lng, e.lng)) {
      problems.push(`${e.name}: stored position ${n.lat}, ${n.lng} differs from the plan's ${e.lat}, ${e.lng}`);
    }
    if (e.decision === 'deliver') {
      if (!boundary) problems.push(`${e.name}: the campus has no active boundary`);
      else if (n.lat == null || !pointInPolygon(Number(n.lat), Number(n.lng), boundary.polygon)) {
        problems.push(`${e.name}: not inside the active boundary`);
      }
      if (!n.active) problems.push(`${e.name}: archived`);
    }
    rows.push({ e, n });
  }
  for (const { e, n } of rows) {
    const now = !n ? 'no id yet' : n.deliverable && n.delivery_enabled && n.verification === 'confirmed' ? 'deliverable' : n.verification;
    const action = e.decision === 'deliver' ? (now === 'deliverable' ? 'already deliverable' : 'CONFIRM + OPEN TO DELIVERY')
                                            : 'stays as it is';
    console.log(`  ${e.decision === 'deliver' ? '→' : '·'} ${e.name.padEnd(36)} ${now.padEnd(12)} ${action}`);
    if (e.decision !== 'deliver') console.log(`      ${e.reason}`);
  }
  for (const x of plan.notInProduction || []) console.log(`  · ${x.name.padEnd(36)} not in production      ${x.reason}`);

  if (problems.length) {
    console.error(`\n✗ The plan does not match this database; nothing ${apply ? 'was' : 'would be'} written:`);
    for (const p of problems) console.error(`    - ${p}`);
    throw Object.assign(new Error('plan refused'), { quiet: true });
  }

  if (!apply) {
    console.log('\nRead-only. Run again with --apply to write it.');
    await c.query('ROLLBACK');
  } else {
    if (!PLATFORM_OWNER.email) throw new Error('Set PLATFORM_OWNER_EMAIL: the owner is recorded as the verifier.');
    const owner = (await c.query(
      `SELECT u.id FROM app_user u JOIN user_role r ON r.user_id = u.id AND r.role = 'platform_owner'
        WHERE u.student_email = $1`, [PLATFORM_OWNER.email])).rows[0];
    if (!owner) throw new Error(`${PLATFORM_OWNER.email} has no platform_owner account in this database.`);
    let opened = 0;
    for (const { e, n } of rows) {
      if (e.decision !== 'deliver') continue;
      if (n.deliverable && n.delivery_enabled && n.verification === 'confirmed') continue;
      if (n.verification === 'pending') {
        await confirmLocation(c, { id: n.id, verifiedBy: owner.id, confirmation: e.confirmation, method: e.method });
      }
      if (e.placeType) await c.query(`UPDATE campus_node SET place_type = $2 WHERE id = $1`, [n.id, e.placeType]);
      await enableDelivery(c, n.id);
      await c.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, resource, resource_id, outcome, detail)
         VALUES ($1, 'platform_owner', 'campus.location.confirm', 'campus_node', $2, 'ok', $3)`,
        [owner.id, n.id, JSON.stringify({ name: n.name, deliverable: true, confirmation: e.confirmation,
                                           plan: planPath.split(/[\\/]/).pop(), via: 'ops:location-confirm' })]);
      opened++;
    }
    await c.query('COMMIT');
    console.log(`\n✓ ${opened} location(s) confirmed and opened to delivery. Everything else is unchanged.`);
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  if (!e.quiet) console.error(`✗ ${e.detail ? `${e.message} — ${e.detail}` : e.message}`);
  code = 1;
} finally {
  c.release();
  await pool.end();
}
process.exit(code);
