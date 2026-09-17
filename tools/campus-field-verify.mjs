/* ==========================================================================
   VERIFY THE BIDHOLI FIELD READINGS AGAINST THEIR SOURCE PHOTOS

   The readings in docs/campus/bidholi-field-2026-09-readings.csv were
   transcribed by eye from the caption bar GPS Map Camera burns into each
   photo — there is no EXIF GPS in that archive to read instead. This script
   cannot re-read the captions, so it does NOT re-derive the coordinates.

   What it does check, which is what can actually be checked mechanically:

     - every reading names a photo that exists in the archive
     - every photo's SHA-256 still matches the one recorded with the reading
       (so a reading can never silently drift onto a different image)
     - every coordinate parses, and is plausible for Bidholi
     - which readings fall inside the PROPOSED OpenStreetMap outline
     - duplicate coordinate pairs, which are stale receiver fixes

   It writes nothing and touches no database. Point it at the archive:

     node tools/campus-field-verify.mjs "<path to the 'Google map' folder>"

   The archive is git-ignored and is not required to be present; without it
   the script reports the coordinate checks and skips the file checks.
   ========================================================================== */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const READINGS = join(HERE, '..', 'docs', 'campus', 'bidholi-field-2026-09-readings.csv');

/* The proposed outline from migration 013 — OpenStreetMap way 321638232,
   retrieved 2026-09-13, ODbL. [lat, lng] pairs, in order. It is a PROPOSAL:
   nobody has walked this perimeter, so it confirms nothing on its own. */
const OSM_OUTLINE = [
  [30.4156492, 77.9660971], [30.4156873, 77.9664503], [30.415408, 77.9671567],
  [30.4157126, 77.9673628], [30.4152811, 77.9687903], [30.4155223, 77.9689375],
  [30.4151415, 77.9701149], [30.4160046, 77.9704828], [30.4163472, 77.970262],
  [30.4166772, 77.9698647], [30.4185428, 77.9696292], [30.4192028, 77.9676718],
  [30.4159919, 77.9658911], [30.415852, 77.9659752],
];

/* The official UPES map pin for Bidholi (source S2 in CAMPUS-UPES-BIDHOLI.md). */
const UPES_PIN = [30.415937, 77.9668366];

/* Generous sanity box around Bidholi. A reading outside this is a
   transcription error, not a campus feature. */
const PLAUSIBLE = { latMin: 30.40, latMax: 30.43, lngMin: 77.95, lngMax: 77.99 };

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function readReadings() {
  const lines = readFileSync(READINGS, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines[0]);
  const at = (n) => header.indexOf(n);
  return lines.slice(1).map((l) => {
    const c = splitCsvLine(l);
    return {
      n: Number(c[at('n')]),
      file: c[at('source_photo')],
      sha256: c[at('sha256')],
      lat: Number(c[at('lat')]),
      lng: Number(c[at('lng')]),
      place: c[at('reverse_geocoded_place')],
      bytes: Number(c[at('bytes')]),
    };
  });
}

/* Ray casting. Longitude is the x axis, latitude the y axis — getting that
   pair the wrong way round is the classic way to silently invert a geofence,
   so the outline above is [lat, lng] and this is the only place it is split. */
function pointInPolygon(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat)) {
      const xCross = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lng < xCross) inside = !inside;
    }
  }
  return inside;
}

const metresBetween = (aLat, aLng, bLat, bLng) => {
  const R = 6371000;
  const p = Math.PI / 180;
  const dLat = (bLat - aLat) * p;
  const dLng = (bLng - aLng) * p;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const archiveDir = process.argv[2] ? resolve(process.argv[2]) : null;
const rows = readReadings();
const problems = [];
const notes = [];

console.log(`readings: ${rows.length}`);

/* ---------- coordinates ---------------------------------------------------- */
for (const r of rows) {
  if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) {
    problems.push(`#${r.n} ${r.file}: coordinate does not parse`);
    continue;
  }
  if (r.lat < PLAUSIBLE.latMin || r.lat > PLAUSIBLE.latMax
      || r.lng < PLAUSIBLE.lngMin || r.lng > PLAUSIBLE.lngMax) {
    problems.push(`#${r.n} ${r.file}: ${r.lat},${r.lng} is not plausible for Bidholi`);
  }
}

const inside = rows.filter((r) => pointInPolygon(r.lat, r.lng, OSM_OUTLINE));
const outside = rows.filter((r) => !pointInPolygon(r.lat, r.lng, OSM_OUTLINE));
console.log(`inside the proposed OSM outline: ${inside.length}   outside: ${outside.length}`);
for (const r of outside) {
  notes.push(`#${r.n} ${r.file} (${r.lat}, ${r.lng}) "${r.place}" is OUTSIDE the proposed outline`);
}

const nearest = rows.reduce((best, r) => {
  const d = metresBetween(r.lat, r.lng, UPES_PIN[0], UPES_PIN[1]);
  return d < best.d ? { d, r } : best;
}, { d: Infinity, r: null });
console.log(`closest reading to the official UPES pin: ${nearest.d.toFixed(0)} m (#${nearest.r.n})`);

const byCoord = new Map();
for (const r of rows) {
  const k = `${r.lat},${r.lng}`;
  byCoord.set(k, [...(byCoord.get(k) || []), r.n]);
}
for (const [k, ns] of byCoord) {
  if (ns.length > 1) notes.push(`identical fix ${k} shared by readings ${ns.join(', ')} — not independent`);
}

/* ---------- the photos themselves ------------------------------------------ */
if (!archiveDir) {
  notes.push('no archive path given — file existence and SHA-256 were NOT checked');
} else if (!existsSync(archiveDir)) {
  problems.push(`archive folder not found: ${archiveDir}`);
} else {
  let checked = 0;
  for (const r of rows) {
    const p = join(archiveDir, r.file);
    if (!existsSync(p)) { problems.push(`#${r.n}: ${r.file} is missing from the archive`); continue; }
    const bytes = readFileSync(p);
    if (statSync(p).size !== r.bytes) {
      problems.push(`#${r.n}: ${r.file} size ${statSync(p).size} != recorded ${r.bytes}`);
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== r.sha256) {
      problems.push(`#${r.n}: ${r.file} SHA-256 does not match the recorded evidence`);
    }
    checked++;
  }
  console.log(`photos checked against their recorded SHA-256: ${checked}`);
}

/* ---------- report --------------------------------------------------------- */
if (notes.length) {
  console.log('\nnotes:');
  for (const n of notes) console.log(`  - ${n}`);
}
if (problems.length) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log(`  ! ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nno problems found.');
}

console.log('\nReminder: these readings were transcribed by eye and are not machine-verified.');
console.log('The outline above is a PROPOSAL. No perimeter has been walked, so the campus');
console.log('geofence stays fail-closed and no location here is deliverable.');
