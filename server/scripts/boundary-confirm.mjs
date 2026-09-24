/* ==========================================================================
   ECHO ECHO — CONFIRM A PROPOSED CAMPUS BOUNDARY  (owner, ops)

     npm run boundary:confirm:local                          # read-only report
     npm run boundary:confirm:local -- --activate <id> \
       --confirmation "how you checked it, in your own words"

   The live-location gate refuses every student until a campus has an ACTIVE
   boundary, and only a proposed outline that already exists can become one.
   Campus Control does that behind a fresh administrator passkey. This is the
   same step for the platform owner, authenticated instead by the production
   DATABASE_URL, for when Campus Control sign-in is not set up yet.

   It cannot draw, move or import geometry: it takes the id of an outline
   already in the database, and activates it through the same function
   Campus Control uses (services/campus.js activateBoundary). The written
   confirmation is stored on the row and in audit_log with the owner's
   account as the verifier. Without --activate nothing is written: the report
   runs inside a READ ONLY transaction.

   Activating an outline only opens the on-campus check. Delivery still needs
   a confirmed, positioned delivery point inside it, and none is confirmed by
   this script.
   ========================================================================== */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/index.js';
import { PLATFORM_OWNER, DB } from '../src/config.js';
import { activateBoundary, validatePolygon, pointInPolygon, metresToEdge } from '../src/services/campus.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const slug = arg('--campus') || 'upes-bidholi';
const activateId = arg('--activate');
const confirmation = arg('--confirmation');
const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);

if (!DB.configured) { console.error('✗ DATABASE_URL is not set.'); process.exit(1); }

/* The committed field readings (docs/campus), when this runs from a checkout.
   Interior points: they can show an outline is not absurd, never that its
   edge is right. */
const readingsPath = fileURLToPath(new URL('../../docs/campus/bidholi-field-2026-09-readings.csv', import.meta.url));
function readings() {
  if (slug !== 'upes-bidholi' || !fs.existsSync(readingsPath)) return null;
  const [head, ...rows] = fs.readFileSync(readingsPath, 'utf8').trim().split(/\r?\n/);
  const h = head.split(',');
  const li = h.indexOf('lat'), gi = h.indexOf('lng'), ni = h.indexOf('n');
  return rows.map((r) => r.split(',')).map((c) => ({ n: c[ni], lat: Number(c[li]), lng: Number(c[gi]) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

const c = await pool.connect();
let code = 0;
try {
  const site = (await c.query(`SELECT id, name FROM campus_site WHERE slug = $1`, [slug])).rows[0];
  if (!site) throw new Error(`No campus with slug ${slug}.`);

  if (!activateId) {
    await c.query('BEGIN READ ONLY');
    console.log(`\n${site.name} (${slug}) on ${new URL(DB.url).hostname}\n`);
    const { rows } = await c.query(
      `SELECT id, name, status, polygon, source, source_note, created_at, verified_at
         FROM campus_boundary WHERE campus_site_id = $1
        ORDER BY (status = 'active') DESC, created_at DESC`, [site.id]);
    if (!rows.length) console.log('  No boundary exists for this campus, proposed or active.');
    const pts = readings();
    for (const b of rows) {
      const m = validatePolygon(b.polygon);
      console.log(`${b.status.toUpperCase()}  ${b.id}`);
      line('name', b.name);
      line('source', b.source);
      line('shape', m.ok ? `${m.metrics.points} points, ${m.metrics.widthM} × ${m.metrics.heightM} m, ${(m.metrics.areaM2 / 4046.86).toFixed(1)} acres`
                         : `NOT USABLE: ${m.problems.join(' ')}`);
      if (pts && m.ok) {
        const outside = pts.filter((p) => !pointInPolygon(p.lat, p.lng, b.polygon));
        line('field readings inside', `${pts.length - outside.length} of ${pts.length}`);
        for (const p of outside) {
          line('  outside', `#${p.n} ${p.lat}, ${p.lng} — ${Math.round(metresToEdge(p.lat, p.lng, b.polygon))} m beyond the edge`);
        }
      }
      console.log(`  ${String(b.source_note || '').split('\n').join('\n  ')}\n`);
    }
    const active = rows.find((b) => b.status === 'active');
    console.log(active
      ? 'The live-location check is ON for this campus.'
      : 'No boundary is active: every student\'s location check is refused ("not switched on yet").\n' +
        'To activate a proposed outline after checking it on the ground:\n' +
        '  npm run boundary:confirm:local -- --activate <id> --confirmation "how you checked it"');
    await c.query('ROLLBACK');
  } else {
    if (!PLATFORM_OWNER.email) throw new Error('Set PLATFORM_OWNER_EMAIL: the owner is recorded as the verifier.');
    await c.query('BEGIN');
    const owner = (await c.query(
      `SELECT u.id FROM app_user u JOIN user_role r ON r.user_id = u.id AND r.role = 'platform_owner'
        WHERE u.student_email = $1`, [PLATFORM_OWNER.email])).rows[0];
    if (!owner) throw new Error(`${PLATFORM_OWNER.email} has no platform_owner account in this database. Sign in once with the email code first.`);
    const own = (await c.query(`SELECT campus_site_id FROM campus_boundary WHERE id = $1`, [activateId]).catch(() => ({ rows: [] }))).rows[0];
    if (!own) throw new Error(`No boundary with id ${activateId}.`);
    if (own.campus_site_id !== site.id) throw new Error(`That boundary does not belong to ${slug}.`);
    const b = await activateBoundary(c, { boundaryId: activateId, verifiedBy: owner.id, confirmation });
    await c.query(
      `INSERT INTO audit_log (actor_id, actor_role, action, resource, resource_id, outcome, detail)
       VALUES ($1, 'platform_owner', 'campus.boundary.activate', 'campus_boundary', $2, 'ok', $3)`,
      [owner.id, b.id, JSON.stringify({ campus: site.id, confirmation: String(confirmation).trim(), via: 'ops:boundary-confirm' })]);
    await c.query('COMMIT');
    console.log(`\n✓ ${b.name} is now the ACTIVE boundary for ${site.name}.`);
    console.log('  The live-location check now tests students against it.');
    console.log('  Delivery stays off until a delivery point inside it is confirmed.');
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`✗ ${e.detail ? `${e.message} — ${e.detail}` : e.message}`);
  code = 1;
} finally {
  c.release();
  await pool.end();
}
process.exit(code);
