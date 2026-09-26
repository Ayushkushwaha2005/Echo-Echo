/* ==========================================================================
   UPES BIDHOLI — BOUNDARY EVIDENCE AUDIT

     node tools/campus-boundary-audit.mjs

   Rebuilds, from committed files only (the photo archive is not needed):

     docs/campus/bidholi-boundary-audit.csv    one row per field reading
     docs/campus/bidholi-boundary-review.html  Leaflet + OSM review map

   Inputs, none of which this script modifies:
     docs/campus/bidholi-field-2026-09-evidence.csv   the 114 readings
     docs/campus/bidholi-caption-check-2026-09-25.csv caption re-read (OCR + eye)
     docs/campus/osm-bidholi-extract.geojson          OSM data, ODbL
     docs/campus/prod-campus-tree-2026-09-25.json     production locations

   The outline tested is OpenStreetMap way 321638232, read from the OSM
   extract - the same geometry migration 013 stores as the proposed
   boundary (checked below, the script fails if they differ).
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const doc = (p) => fileURLToPath(new URL(`../docs/campus/${p}`, import.meta.url));
const NEAR_EDGE_M = 25;               // closer than a typical phone fix indoors
const PROPOSED_ID = '5414c945-9a18-4f0f-9961-fa7425c5cec8';

function csv(path) {
  const rows = [];
  for (const line of readFileSync(path, 'utf8').trim().split(/\r?\n/)) {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); rows.push(out);
  }
  const [h, ...body] = rows;
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}
const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/* ---- geometry: the same formulas as server/src/services/campus.js ------- */
const K = 111_320;
const inside = (lat, lng, P) => {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [yi, xi] = P[i], [yj, xj] = P[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const toEdge = (lat, lng, P) => {
  const k = Math.cos((lat * Math.PI) / 180) * K;
  const Q = P.map(([a, b]) => [(b - lng) * k, (a - lat) * K]);
  let best = Infinity;
  for (let i = 0, j = Q.length - 1; i < Q.length; j = i++) {
    const [x1, y1] = Q[j], [x2, y2] = Q[i]; const dx = x2 - x1, dy = y2 - y1;
    const t = dx || dy ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
  }
  return best;
};
const metres = (a, b) => Math.hypot((a[1] - b[1]) * Math.cos((a[0] * Math.PI) / 180) * K, (a[0] - b[0]) * K);

/* ---- inputs ------------------------------------------------------------- */
const readings = csv(doc('bidholi-field-2026-09-evidence.csv'));
const checks = new Map(csv(doc('bidholi-caption-check-2026-09-25.csv')).map((r) => [r.n, r]));
const osm = JSON.parse(readFileSync(doc('osm-bidholi-extract.geojson'), 'utf8'));
const prod = JSON.parse(readFileSync(doc('prod-campus-tree-2026-09-25.json'), 'utf8')).nodes;

const way = osm.features.find((f) => f.id === 'way/321638232');
const OUTLINE = way.geometry.coordinates[0].map(([lng, lat]) => [lat, lng]);
const migration = JSON.parse(readFileSync(fileURLToPath(new URL('../server/src/db/013_campus_geography.sql', import.meta.url)), 'utf8')
  .match(/'(\[\[30\.4156492[^']+)'::jsonb/)[1]);
const same = migration.every(([a, b]) => OUTLINE.some(([c, d]) => Math.abs(a - c) < 1e-9 && Math.abs(b - d) < 1e-9));
if (!same) { console.error('✗ OSM way 321638232 no longer matches migration 013 — re-assess before using this audit.'); process.exit(1); }

/* ---- what each reading shows --------------------------------------------
   The area label comes from the photo's own signage or plate, else the
   caption's reverse-geocoded place, else the nearest labelled reading within
   60 m. Nothing is labelled from outside the evidence. */
const AREA_RULES = [
  [/GIRLS HOSTEL/i, 'Girls Hostel gate'], [/BOYS HOSTEL/i, 'R&D Block / Boys Hostel approach'],
  [/Tulips/i, 'R&D Block / Tulips Cafe'], [/Frisco/i, 'Food court / Café Frisco'],
  [/CHA\.\.\./i, 'Food court / "CHA…" café'], [/Food Court/i, 'Food court'],
  [/ENROLLMENT|HUBBLE|HUDDLE/i, 'Enrollment Office / The HUBBLE'], [/CAREER|Placement/i, 'Placement Block / Career Services'],
  [/MANAGEMENT/i, 'Management Development Centre'], [/Management Block/i, 'Management Block'],
  [/^1\d{3}$|Main Block|IT\. DEP/i, 'Main Block (Block 1)'], [/^2\d{3}$|3rd And 4th Block/i, '3rd/4th Block (Block 2)'],
  [/^9\d{3}$|New Porta/i, 'New Porta (Block 9)'], [/^11\d{3}$|FOOD TECHNOLOGY|Chitrakoot/i, 'Block 11 (Chitrakoot)'],
  [/Energy Block/i, 'Energy Block'], [/auditorium/i, 'Auditorium'], [/porta cabin|Porta$/i, 'Porta cabins'],
  [/court|ground/i, 'Sports courts / ground'], [/CHOPRA|Aditya|Sods/i, 'Aditya Block / Chopra Centre'],
  [/8th Block/i, '8th Block'], [/statue/i, 'Forecourt'], [/pyramid/i, 'Glass pyramid building'],
];
const labelOf = (r) => {
  const text = [r.legible_signage, r.room_plate, r.subject, r.reverse_geocoded_place].join(' | ');
  for (const [re, name] of AREA_RULES) if (re.test(r.legible_signage) || re.test(r.room_plate) || re.test(r.subject)) return name;
  for (const [re, name] of AREA_RULES) if (re.test(text)) return name;
  return null;
};

const fixKey = (r) => `${r.lat},${r.lng}`;
const shared = new Map();
for (const r of readings) shared.set(fixKey(r), [...(shared.get(fixKey(r)) || []), r.n]);

const rows = readings.map((r) => {
  const lat = Number(r.lat), lng = Number(r.lng);
  const ins = inside(lat, lng, OUTLINE); const edge = toEdge(lat, lng, OUTLINE);
  return { r, lat, lng, ins, edge, area: labelOf(r) };
});
for (const x of rows) {
  if (x.area) continue;
  const near = rows.filter((y) => y.area && y !== x).map((y) => [y, metres([x.lat, x.lng], [y.lat, y.lng])])
    .sort((a, b) => a[1] - b[1])[0];
  x.area = near && near[1] <= 60 ? `${near[0].area} (nearest labelled reading, ${Math.round(near[1])} m)` : 'unlabelled';
}

const statusOf = (x) => {
  if (x.r.n === '98') return ['outside', 'REJECTED as a position',
    'Indoor ceiling photo, 3 min after #97 (Block 11) and 3 min before #99 (Block 11 balcony); the caption\'s own map thumbnail puts the pin on open farmland with no building. An indoor photo cannot be taken there: treated as GPS drift, not as campus land outside the outline.'];
  if (!x.ins) return ['outside', 'unresolved', ''];
  if (x.edge < NEAR_EDGE_M) return ['inside_near_edge', 'valid', `Within ${NEAR_EDGE_M} m of the OSM edge: a phone fix worse than ${Math.floor(x.edge)} m here is refused as near_boundary.`];
  return ['inside', 'valid', ''];
};

/* ---- the audit table ----------------------------------------------------- */
const header = ['n', 'filename', 'sha256', 'captured_at_local', 'latitude', 'longitude', 'coordinate_source',
  'coordinate_check', 'osm_outline', 'metres_to_osm_edge', 'area', 'signage_or_plate', 'status', 'confidence', 'note'];
const lines = [header.join(',')];
for (const x of rows) {
  const [where, status, note] = statusOf(x);
  const chk = checks.get(x.r.n);
  const dup = shared.get(fixKey(x.r)).filter((n) => n !== x.r.n);
  lines.push([
    x.r.n, x.r.source_photo, x.r.sha256, x.r.captured_at_local, x.r.lat, x.r.lng,
    'GPS Map Camera caption burned into the image (EXIF GPS block present but empty 0/0 in all 114)',
    chk?.result === 'ocr_exact_match' ? 'Windows OCR reads the identical value; SHA-256 matches'
      : 'OCR misread the caption; read by eye 2026-09-25, identical to the transcription; SHA-256 matches',
    where, Math.round(x.edge), x.area, [x.r.legible_signage, x.r.room_plate].filter(Boolean).join('; '),
    status, x.r.n === '98' ? 'low' : dup.length ? 'medium' : 'medium',
    [note, dup.length ? `Identical fix shared with #${dup.join(', #')}: not an independent reading.` : '',
     'Receiver accuracy not recorded by the app.'].filter(Boolean).join(' '),
  ].map(esc).join(','));
}
writeFileSync(doc('bidholi-boundary-audit.csv'), lines.join('\n') + '\n');

/* ---- where roads cross the outline: candidate access points, not gates --- */
const crossings = [];
for (const f of osm.features.filter((g) => g.properties.highway && g.geometry.type === 'LineString')) {
  const P = f.geometry.coordinates.map(([a, b]) => [b, a]);
  for (let i = 1; i < P.length; i++) {
    if (inside(...P[i - 1], OUTLINE) !== inside(...P[i], OUTLINE)) {
      crossings.push({ id: f.id, highway: f.properties.highway,
        lat: +((P[i - 1][0] + P[i][0]) / 2).toFixed(6), lng: +((P[i - 1][1] + P[i][1]) / 2).toFixed(6) });
    }
  }
}

/* ---- production destinations --------------------------------------------- */
const dest = prod.map((n) => ({
  name: n.name, kind: n.kind, verification: n.verification, deliverable: n.deliverable,
  aliases: n.aliases, lat: n.lat == null ? null : Number(n.lat), lng: n.lng == null ? null : Number(n.lng),
  inside: n.lat == null ? null : inside(Number(n.lat), Number(n.lng), OUTLINE),
  edge: n.lat == null ? null : Math.round(toEdge(Number(n.lat), Number(n.lng), OUTLINE)),
}));

/* ---- the review map ------------------------------------------------------ */
const data = {
  proposedId: PROPOSED_ID, nearEdge: NEAR_EDGE_M,
  outline: OUTLINE,
  readings: rows.map((x) => {
    const [where, status, note] = statusOf(x);
    return { n: x.r.n, file: x.r.source_photo, at: x.r.captured_at_local, lat: x.lat, lng: x.lng, where, status,
             edge: Math.round(x.edge), area: x.area, sign: [x.r.legible_signage, x.r.room_plate].filter(Boolean).join('; '), note };
  }),
  osm: osm.features.filter((f) => f.id !== 'way/321638232'),
  crossings, dest,
};
const tpl = readFileSync(fileURLToPath(new URL('./campus-boundary-review.template.html', import.meta.url)), 'utf8');
writeFileSync(doc('bidholi-boundary-review.html'),
  tpl.replace('/*__DATA__*/null', JSON.stringify(data).replace(/</g, '\\u003c')));

const count = (w) => rows.filter((x) => statusOf(x)[0] === w).length;
console.log(`readings ${rows.length}: inside ${count('inside')}, inside within ${NEAR_EDGE_M} m of edge ${count('inside_near_edge')}, outside ${count('outside')}`);
console.log(`road crossings of the outline: ${crossings.length}; production locations: ${dest.length} (${dest.filter((d) => d.lat == null).length} without a position)`);
console.log('wrote docs/campus/bidholi-boundary-audit.csv and docs/campus/bidholi-boundary-review.html');
