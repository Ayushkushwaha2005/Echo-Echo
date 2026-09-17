/* ==========================================================================
   DRY RUN OF THE CAMPUS POINT IMPORT — offline

   This does NOT import anything and cannot: it never opens a database.

   It calls the same parser the production importer calls (parsePoints from
   server/src/services/geo-import.js) and reproduces the checks that
   POST /admin/campuses/:id/points/preview runs around it, using the campus
   state as the committed migrations define it. No second importer is being
   built here — the real one already exists and stays the only way in.

     node tools/campus-import-dryrun.mjs

   The authoritative dry run is still the admin endpoint, because only it can
   see the live database. That endpoint needs a deployed server and an
   administrator session, neither of which exists yet. This is what can
   honestly be checked before then.
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parsePoints } from '../server/src/services/geo-import.js';
import { pointInPolygon, metresBetween, metresToEdge } from '../server/src/services/campus.js';
import { parseRoomCode } from '../server/src/services/room-code.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAMPUS = join(HERE, '..', 'docs', 'campus');

/* Mirrors server/src/routes/geodata.js */
const MAX_ACCURACY_M = 25;
const DUPLICATE_RADIUS_M = 15;
const CONFIRMABLE_METHODS = ['gps_on_site', 'survey_track', 'official_map'];

/* Campus state as the migrations leave it. 013 stores this outline as
   status='proposed'; there is NO active boundary on Bidholi. */
const PROPOSED_OUTLINE = [
  [30.4156492, 77.9660971], [30.4156873, 77.9664503], [30.415408, 77.9671567],
  [30.4157126, 77.9673628], [30.4152811, 77.9687903], [30.4155223, 77.9689375],
  [30.4151415, 77.9701149], [30.4160046, 77.9704828], [30.4163472, 77.970262],
  [30.4166772, 77.9698647], [30.4185428, 77.9696292], [30.4192028, 77.9676718],
  [30.4159919, 77.9658911], [30.415852, 77.9659752],
];
const ACTIVE_OUTLINE = null;                       // nothing confirmed. Fail closed.

/* Nodes migration 016 already put on Bidholi, both pending. */
const EXISTING = [
  { name: 'Energy Block', lat: 30.415934, lng: 77.966974, verification: 'pending' },
  { name: 'Infirmary', lat: 30.416965, lng: 77.967669, verification: 'pending' },
];

const line = (s = '') => console.log(s);
const rule = () => line('-'.repeat(78));

const text = readFileSync(join(CAMPUS, 'bidholi-candidate-points.csv'), 'utf8');
const parsed = parsePoints({ format: 'csv', text, defaultMethod: 'gps_on_site', maxAccuracyM: MAX_ACCURACY_M });

line('DRY RUN — campus point import for UPES Bidholi');
line('nothing is written; no database is opened');
rule();

if (!parsed.ok) {
  line('the file could not be read:');
  for (const p of parsed.problems) line(`  ! ${p}`);
  process.exit(1);
}

/* ---------- placement, duplicates, name clashes ----------------------------- */
for (const p of parsed.points) {
  p.insideProposed = pointInPolygon(p.lat, p.lng, PROPOSED_OUTLINE);
  p.metresFromProposedEdge = Math.round(metresToEdge(p.lat, p.lng, PROPOSED_OUTLINE));
  p.insideActiveBoundary = ACTIVE_OUTLINE ? pointInPolygon(p.lat, p.lng, ACTIVE_OUTLINE) : null;
  p.sameNameAs = EXISTING.find((e) => e.name.toLowerCase() === p.name.toLowerCase())?.name || null;
  p.nearbyExisting = EXISTING
    .map((e) => ({ name: e.name, metres: Math.round(metresBetween([p.lat, p.lng], [e.lat, e.lng])) }))
    .filter((e) => e.metres <= DUPLICATE_RADIUS_M)
    .sort((a, b) => a.metres - b.metres);
  if (p.sameNameAs) p.warnings.push('a location with this name already exists on this campus');
  if (p.nearbyExisting.length) p.warnings.push(`within ${DUPLICATE_RADIUS_M} m of "${p.nearbyExisting[0].name}"`);
  if (!ACTIVE_OUTLINE) p.warnings.push('no confirmed boundary yet - inside/outside cannot be decided');
}

/* ---------- accepted --------------------------------------------------------- */
line(`ACCEPTED CANDIDATES: ${parsed.points.length}`);
line('(accepted by the parser — NOT approved, NOT confirmed, NOT deliverable)');
line();
for (const p of parsed.points) {
  line(`  ${p.name}`);
  line(`      type ${p.type} -> node kind "${p.kind}"   method ${p.method}`);
  line(`      ${p.lat}, ${p.lng}   accuracy: ${p.accuracyM == null ? 'UNKNOWN (not stamped by the camera app)' : `${p.accuracyM} m`}`);
  line(`      deliverable on import: ${p.deliverable}   inside proposed outline: ${p.insideProposed} (${p.metresFromProposedEdge} m from its edge)`);
  for (const w of p.warnings) line(`      warning: ${w}`);
  line();
}

/* ---------- rejected --------------------------------------------------------- */
rule();
line(`REJECTED ROWS: ${parsed.rejected.length}`);
for (const r of parsed.rejected) line(`  ! line ${r.line} ${r.name || ''}: ${r.problems.join(', ')}`);
if (!parsed.rejected.length) line('  none — every row in the candidate file parses.');

/* ---------- duplicates ------------------------------------------------------- */
rule();
const dupName = parsed.points.filter((p) => p.sameNameAs);
const dupNear = parsed.points.filter((p) => p.nearbyExisting.length);
line('DUPLICATES AGAINST WHAT IS ALREADY ON THE CAMPUS');
line(`  same name as an existing location: ${dupName.length}${dupName.length ? ` (${dupName.map((p) => p.name).join(', ')})` : ' — none'}`);
line(`  within ${DUPLICATE_RADIUS_M} m of an existing location: ${dupNear.length}${dupNear.length ? ` (${dupNear.map((p) => `${p.name} -> ${p.nearbyExisting[0].name} ${p.nearbyExisting[0].metres} m`).join('; ')})` : ' — none'}`);
line('  existing Bidholi nodes considered: ' + EXISTING.map((e) => `${e.name} (${e.verification})`).join(', '));

/* ---------- boundary --------------------------------------------------------- */
rule();
line('BOUNDARY');
line(`  confirmed/active outline: NONE — the campus geofence is FAIL-CLOSED and every delivery order is refused.`);
line(`  proposed outline: OpenStreetMap way 321638232 (migration 013), not walked, not confirmed.`);
const outside = parsed.points.filter((p) => !p.insideProposed);
line(`  candidates outside the proposed outline: ${outside.length}${outside.length ? ` (${outside.map((p) => p.name).join(', ')})` : ' — none'}`);
line('  unresolved field reading #098 at 30.414623, 77.970043 lies outside the proposed outline.');
line('  It is NOT being used to widen the boundary. One reading cannot settle it.');

/* ---------- room plates ------------------------------------------------------ */
rule();
line('ROOM PLATES (not part of this point import — rooms enter the hierarchy separately)');
const roomRows = readCsv('bidholi-observed-room-codes.csv');
let ok = 0; let held = 0;
for (const r of roomRows) {
  const p = parseRoomCode(r.source_code);
  const usable = p.ok && r.confidence === 'confirmed';
  if (usable) ok++; else held++;
  const desc = p.ok ? p.label : `REFUSED (${p.reason})`;
  line(`  ${String(r.source_code).padEnd(7)} ${usable ? 'usable   ' : 'WITHHELD '} ${desc}   [${r.confidence}]`);
}
line(`  usable: ${ok}    withheld as unconfirmed or unreadable: ${held}`);
line('  Which named block each block NUMBER refers to is NOT established, so no room');
line('  can be attached to a block node yet.');

/* ---------- unresolved ------------------------------------------------------- */
rule();
line('UNRESOLVED / MISSING EVIDENCE');
line('  Chai Garam            UNCONFIRMED — sign reads "CHA..." behind an awning, illegible.');
line('                        Not present in the candidate file. Not guessed.');
line('  Campus Food Court     geocoder label only, on a blurred ground shot. Identifies no cafeteria.');
line('  Block name <-> number NOT established for any block.');
line('  GPS accuracy          UNKNOWN for all 114 readings. Recorded as unknown, never invented.');
line('  Boys Hostel gate      signage read, but the reading is the photographer\'s distant position.');
line('                        Deliberately excluded from the candidate file.');
line('  Hostel delivery       whether UPES permits hand-over at either hostel gate is unknown.');

/* ---------- what the real import would do ------------------------------------ */
rule();
line('IF THIS WERE RUN THROUGH THE ADMIN IMPORTER TODAY');
const weak = parsed.points.filter((p) => !CONFIRMABLE_METHODS.includes(p.method));
line(`  import as pending:  allowed — ${parsed.points.length} node(s), verification='pending', deliverable=false`);
line(`  import + confirm:   refused in practice — confirming needs campus.update, a fresh passkey`);
line(`                      and a written collection note; and none of these positions was taken`);
line(`                      standing at the hand-over point, so confirming would be dishonest.`);
line(`  methods that could never be confirmed on import: ${weak.length ? weak.map((p) => `${p.name} (${p.method})`).join(', ') : 'none'}`);
line('  migration 016 keeps any pending node undeliverable regardless.');

rule();
line('RESULT: 0 rows written. Nothing imported, nothing confirmed, nothing deliverable.');

function readCsv(file) {
  const lines = readFileSync(join(CAMPUS, file), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}
function splitCsvLine(s) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}
