/* ==========================================================================
   BUILD THE OWNED UPES BIDHOLI CAMPUS DATA LAYER

   Reads only files that are committed to this repository and writes a GeoJSON
   FeatureCollection. No network call, no Google service, no map provider, and
   no coordinate that is not already in the evidence.

     node tools/campus-build-layer.mjs

   Inputs   docs/campus/bidholi-candidate-points.csv      named candidates
            docs/campus/bidholi-observed-room-codes.csv   room plates
            the OSM outline, inlined below from migration 013
   Output   docs/campus/bidholi-campus-layer.draft.geojson

   EVERY feature this produces is DRAFT. The boundary has not been walked and
   no candidate has been confirmed by an administrator, so `deliverable` is
   false on all of them and `status` says so. This file is a review artifact
   and a starting point for the admin importer. It is NOT loaded by the server
   and it is NOT a source of truth for the geofence: the geofence reads the
   confirmed boundary out of PostgreSQL and fails closed when there isn't one.
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRoomCode } from '../server/src/services/room-code.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAMPUS = join(HERE, '..', 'docs', 'campus');

/* OpenStreetMap way 321638232, retrieved 2026-09-13, ODbL. Exactly the ring
   stored by migration 013 as a PROPOSAL. Stored there as [lat, lng]; GeoJSON
   wants [lng, lat], and that flip is the whole reason this constant is here
   rather than being re-typed by hand somewhere else. */
const OSM_OUTLINE_LATLNG = [
  [30.4156492, 77.9660971], [30.4156873, 77.9664503], [30.415408, 77.9671567],
  [30.4157126, 77.9673628], [30.4152811, 77.9687903], [30.4155223, 77.9689375],
  [30.4151415, 77.9701149], [30.4160046, 77.9704828], [30.4163472, 77.970262],
  [30.4166772, 77.9698647], [30.4185428, 77.9696292], [30.4192028, 77.9676718],
  [30.4159919, 77.9658911], [30.415852, 77.9659752],
];

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

function readCsv(file) {
  const lines = readFileSync(join(CAMPUS, file), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

const features = [];

/* ---------- the boundary, as a draft ---------------------------------------- */
const ring = OSM_OUTLINE_LATLNG.map(([lat, lng]) => [lng, lat]);
ring.push(ring[0]);                                   // GeoJSON rings must close

features.push({
  type: 'Feature',
  id: 'bidholi-boundary-osm-draft',
  geometry: { type: 'Polygon', coordinates: [ring] },
  properties: {
    type: 'CAMPUS',
    name: 'UPES Bidholi campus (proposed outline)',
    status: 'DRAFT',
    deliverable: false,
    confidence: 'medium',
    source: 'public_map',
    source_reference: 'OpenStreetMap way 321638232, retrieved 2026-09-13, ODbL',
    gps_accuracy_m: null,
    evidence: 'inferred',
    note: 'NOT VERIFIED ON THE GROUND. Nobody has walked this perimeter. '
        + '113 of 114 field readings fall inside it and the official UPES pin is 9 m from the '
        + 'nearest reading, which is corroboration, not confirmation — every reading is an '
        + 'interior point. Reading #098 (30.414623, 77.970043) falls OUTSIDE and is unresolved. '
        + 'The campus geofence stays fail-closed until an administrator confirms a walked perimeter.',
  },
});

/* ---------- named candidates ------------------------------------------------ */
for (const row of readCsv('bidholi-candidate-points.csv')) {
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`candidate "${row.name}" has an unusable coordinate`);
  }
  features.push({
    type: 'Feature',
    id: `candidate-${row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {
      type: typeForPlace(row.type),
      place_type: row.type,
      name: row.name,
      status: 'CANDIDATE',
      deliverable: false,
      confidence: 'medium',
      source: row.method || 'gps_on_site',
      source_reference: row.note,
      /* GPS Map Camera stamps no horizontal accuracy. Unknown stays unknown. */
      gps_accuracy_m: null,
      gps_accuracy: 'unknown',
      evidence: 'signage_photograph',
      note: 'Position is where the photographer stood, not the hand-over point. '
          + 'Re-record at the counter or door before this is made deliverable.',
    },
  });
}

/* Map the importer's place_type onto the coarse type vocabulary. */
function typeForPlace(placeType) {
  switch (placeType) {
    case 'cafeteria_pickup': return 'CAFETERIA';
    case 'hostel': case 'residence': return 'HOSTEL';
    case 'administrative': return 'OFFICE';
    case 'academic_block': return 'BLOCK';
    case 'library': case 'student_facility': return 'LANDMARK';
    default: return 'OTHER';
  }
}

/* ---------- room plates ----------------------------------------------------- */
/* Rooms are NOT given a geometry. The reading is the corridor position of the
   photographer, which is not the room, and a point that says "this is where
   room 1104 is" would be a claim the evidence does not support. They are
   carried as geometry-less features so the hierarchy is visible and reviewable
   without asserting a position. */
let roomsIncluded = 0;
let roomsWithheld = 0;
for (const row of readCsv('bidholi-observed-room-codes.csv')) {
  const parsed = parseRoomCode(row.source_code);
  if (!parsed.ok || row.confidence !== 'confirmed') {
    roomsWithheld++;
    continue;
  }
  roomsIncluded++;
  features.push({
    type: 'Feature',
    id: `room-${parsed.code}`,
    geometry: null,
    properties: {
      type: 'ROOM',
      name: parsed.label,
      source_code: parsed.code,
      block_number: parsed.block,
      floor_number: parsed.floor,
      room_number: parsed.room,
      status: 'CANDIDATE',
      deliverable: false,
      confidence: 'medium',
      source: 'gps_on_site',
      source_reference: `door plate photographed in ${row.source_photo}`,
      gps_accuracy_m: null,
      gps_accuracy: 'unknown',
      evidence: 'plate_photograph',
      note: 'No geometry: the reading is the photographer\'s corridor position, not the room. '
          + `Which named block is block ${parsed.block} is NOT established.`,
    },
  });
}

const collection = {
  type: 'FeatureCollection',
  name: 'UPES Bidholi campus layer (DRAFT)',
  generated_by: 'tools/campus-build-layer.mjs',
  generated_from: [
    'docs/campus/bidholi-candidate-points.csv',
    'docs/campus/bidholi-observed-room-codes.csv',
    'server/src/db/013_campus_geography.sql (OpenStreetMap way 321638232)',
  ],
  licence_note: 'The outline is OpenStreetMap data under ODbL and must keep its attribution. '
              + 'Everything else is ECHO ECHO\'s own field evidence.',
  status: 'DRAFT — nothing here is confirmed, nothing here is deliverable, and the '
        + 'server does not read this file. The geofence uses the confirmed boundary in '
        + 'PostgreSQL and refuses delivery when there is none.',
  features,
};

const out = join(CAMPUS, 'bidholi-campus-layer.draft.geojson');
writeFileSync(out, `${JSON.stringify(collection, null, 2)}\n`);

const counts = features.reduce((a, f) => {
  a[f.properties.type] = (a[f.properties.type] || 0) + 1;
  return a;
}, {});
console.log(`wrote ${out}`);
console.log(`features: ${features.length} ${JSON.stringify(counts)}`);
console.log(`rooms included: ${roomsIncluded}   withheld as unconfirmed/unparseable: ${roomsWithheld}`);
console.log('every feature is DRAFT and deliverable=false.');
