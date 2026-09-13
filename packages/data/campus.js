/* ==========================================================================
   FRISCO — CAMPUS LOCATION MODEL
   A hierarchy of arbitrary depth, stored flat so admin CRUD is trivial:
     campus → zone → building → floor → spot
   Not every branch uses every level. Students only ever see levels that are
   actually configured, so "Ground → Basketball Court" is two levels while
   "Academic Area → Block B → 3rd Floor → Room B-307" is four.

   `deliverable: true` marks a node a courier can actually be sent to. A node
   with deliverable children is a container; a deliverable leaf is a
   destination. There is no address text anywhere in this model — an order
   references a node id, or it does not exist.
   ========================================================================== */

/* Campus boundary as a simple polygon (lat/lng). The backend tests a GPS fix
   against this before it will accept a live-location delivery. */
export const CAMPUS_BOUNDARY = {
  name: 'Sunview Institute of Technology',
  polygon: [
    [28.6180, 77.2050], [28.6180, 77.2130], [28.6120, 77.2140],
    [28.6095, 77.2100], [28.6110, 77.2045],
  ],
  centre: [28.6141, 77.2094],
};

/* Flat node table. parent === null means top level (a zone).
   geo = { lat, lng, r } where r is a match radius in metres. */
export const CAMPUS_NODES = [
  /* ---- Academic Area ---------------------------------------------------- */
  { id: 'z_acad', parent: null, kind: 'zone', name: 'Academic Area', glyph: '🏫',
    detail: 'Lecture blocks and departments', deliverable: false, active: true,
    geo: { lat: 28.6155, lng: 77.2075, r: 160 } },

  { id: 'b_acad_a', parent: 'z_acad', kind: 'building', name: 'Block A', glyph: '🏛️',
    detail: 'Civil & Mechanical', deliverable: false, active: true,
    geo: { lat: 28.6150, lng: 77.2068, r: 45 } },
  { id: 'f_a_g', parent: 'b_acad_a', kind: 'floor', name: 'Ground Floor', deliverable: true, active: true },
  { id: 'f_a_1', parent: 'b_acad_a', kind: 'floor', name: '1st Floor', deliverable: false, active: true },
  { id: 's_a_101', parent: 'f_a_1', kind: 'spot', name: 'Room A-101', deliverable: true, active: true },
  { id: 's_a_105', parent: 'f_a_1', kind: 'spot', name: 'Room A-105', deliverable: true, active: true },

  { id: 'b_acad_b', parent: 'z_acad', kind: 'building', name: 'Block B', glyph: '🏛️',
    detail: 'Computer Science & IT', deliverable: false, active: true,
    geo: { lat: 28.6158, lng: 77.2079, r: 45 } },
  { id: 'f_b_g', parent: 'b_acad_b', kind: 'floor', name: 'Ground Floor', deliverable: true, active: true },
  { id: 'f_b_2', parent: 'b_acad_b', kind: 'floor', name: '2nd Floor', deliverable: false, active: true },
  { id: 's_b_204', parent: 'f_b_2', kind: 'spot', name: 'Room B-204', deliverable: true, active: true },
  { id: 'f_b_3', parent: 'b_acad_b', kind: 'floor', name: '3rd Floor', deliverable: false, active: true },
  { id: 's_b_307', parent: 'f_b_3', kind: 'spot', name: 'Room B-307', deliverable: true, active: true },
  { id: 's_b_310', parent: 'f_b_3', kind: 'spot', name: 'Room B-310', deliverable: true, active: true },
  { id: 's_b_lt3', parent: 'f_b_g', kind: 'spot', name: 'LT-3', deliverable: true, active: true },

  { id: 'b_acad_c', parent: 'z_acad', kind: 'building', name: 'Block C', glyph: '🏛️',
    detail: 'Electronics', deliverable: true, active: true,
    geo: { lat: 28.6162, lng: 77.2085, r: 45 } },

  /* ---- Labs ------------------------------------------------------------- */
  { id: 'z_labs', parent: null, kind: 'zone', name: 'Labs', glyph: '🧪',
    detail: 'Teaching and research labs', deliverable: false, active: true,
    geo: { lat: 28.6147, lng: 77.2090, r: 90 } },
  { id: 'b_lab_cs', parent: 'z_labs', kind: 'building', name: 'CS Lab Complex', deliverable: false, active: true,
    geo: { lat: 28.6146, lng: 77.2088, r: 40 } },
  { id: 's_lab_cs2', parent: 'b_lab_cs', kind: 'spot', name: 'CS Lab 2', deliverable: true, active: true },
  { id: 's_lab_cs4', parent: 'b_lab_cs', kind: 'spot', name: 'CS Lab 4', deliverable: true, active: true },
  { id: 'b_lab_ec', parent: 'z_labs', kind: 'building', name: 'Electronics Lab', deliverable: true, active: true,
    geo: { lat: 28.6149, lng: 77.2093, r: 35 } },
  { id: 'b_lab_ws', parent: 'z_labs', kind: 'building', name: 'Workshop', deliverable: true, active: true,
    geo: { lat: 28.6144, lng: 77.2095, r: 35 } },

  /* ---- Library ---------------------------------------------------------- */
  { id: 'z_lib', parent: null, kind: 'zone', name: 'Library', glyph: '📚',
    detail: 'Central library', deliverable: false, active: true,
    geo: { lat: 28.6138, lng: 77.2081, r: 70 } },
  { id: 'b_lib_main', parent: 'z_lib', kind: 'building', name: 'Main Library', deliverable: false, active: true,
    geo: { lat: 28.6138, lng: 77.2081, r: 45 } },
  { id: 'f_lib_g', parent: 'b_lib_main', kind: 'floor', name: 'Ground Floor — Issue Desk', deliverable: true, active: true },
  { id: 'f_lib_1', parent: 'b_lib_main', kind: 'floor', name: '1st Floor — Reading Hall', deliverable: true, active: true },
  { id: 'f_lib_2', parent: 'b_lib_main', kind: 'floor', name: '2nd Floor — Reference', deliverable: true, active: true },
  { id: 'b_lib_dig', parent: 'z_lib', kind: 'building', name: 'Digital Library', deliverable: true, active: true,
    geo: { lat: 28.6135, lng: 77.2084, r: 30 } },

  /* ---- Ground ----------------------------------------------------------- */
  { id: 'z_grnd', parent: null, kind: 'zone', name: 'Ground', glyph: '🏀',
    detail: 'Sports ground and courts', deliverable: false, active: true,
    geo: { lat: 28.6128, lng: 77.2068, r: 130 } },
  { id: 's_grnd_bb', parent: 'z_grnd', kind: 'spot', name: 'Basketball Court', deliverable: true, active: true,
    geo: { lat: 28.6130, lng: 77.2064, r: 45 } },
  { id: 's_grnd_main', parent: 'z_grnd', kind: 'spot', name: 'Main Field — North Side', deliverable: true, active: true,
    geo: { lat: 28.6125, lng: 77.2070, r: 60 } },
  { id: 's_grnd_pav', parent: 'z_grnd', kind: 'spot', name: 'Pavilion', deliverable: true, active: true,
    geo: { lat: 28.6122, lng: 77.2074, r: 30 } },

  /* ---- Auditorium ------------------------------------------------------- */
  { id: 'z_aud', parent: null, kind: 'zone', name: 'Auditorium', glyph: '🎤',
    detail: 'Main auditorium complex', deliverable: false, active: true,
    geo: { lat: 28.6152, lng: 77.2101, r: 70 } },
  { id: 's_aud_main', parent: 'z_aud', kind: 'spot', name: 'Main Hall — Foyer', deliverable: true, active: true },
  { id: 's_aud_semi', parent: 'z_aud', kind: 'spot', name: 'Seminar Hall', deliverable: true, active: true },

  /* ---- Hostel Area (note: also has a "Block B" — the ambiguity case) ----- */
  { id: 'z_hostel', parent: null, kind: 'zone', name: 'Hostel Area', glyph: '🏠',
    detail: 'On-campus residence', deliverable: false, active: true,
    geo: { lat: 28.6115, lng: 77.2110, r: 150 } },
  { id: 'b_h_a', parent: 'z_hostel', kind: 'building', name: 'Hostel A', deliverable: false, active: true,
    geo: { lat: 28.6112, lng: 77.2105, r: 45 } },
  { id: 'f_h_a1', parent: 'b_h_a', kind: 'floor', name: 'Block 1', deliverable: true, active: true },
  { id: 'f_h_a2', parent: 'b_h_a', kind: 'floor', name: 'Block 2', deliverable: true, active: true },
  { id: 'b_h_b', parent: 'z_hostel', kind: 'building', name: 'Block B', deliverable: true, active: true,
    detail: 'Boys hostel', geo: { lat: 28.6117, lng: 77.2113, r: 45 } },
  { id: 'b_h_d', parent: 'z_hostel', kind: 'building', name: 'Girls Block D', deliverable: true, active: true,
    geo: { lat: 28.6110, lng: 77.2118, r: 45 } },
  { id: 's_h_mess', parent: 'z_hostel', kind: 'spot', name: 'Hostel Mess Gate', deliverable: true, active: true,
    geo: { lat: 28.6114, lng: 77.2112, r: 30 } },
];

/* ---------- tree helpers ------------------------------------------------- */
export const nodeById = (id) => CAMPUS_NODES.find((n) => n.id === id);
export const childrenOf = (id) => CAMPUS_NODES.filter((n) => n.parent === id && n.active);
export const rootNodes = () => CAMPUS_NODES.filter((n) => n.parent === null && n.active);

export function pathOf(id) {
  const out = []; let n = nodeById(id);
  while (n) { out.unshift(n); n = n.parent ? nodeById(n.parent) : null; }
  return out;
}
export const pathLabel = (id, sep = ' — ') => pathOf(id).map((n) => n.name).join(sep);

/* A node is choosable if it is deliverable, or leads to something that is */
export function hasDeliverableDescendant(id) {
  const kids = childrenOf(id);
  return kids.some((k) => k.deliverable || hasDeliverableDescendant(k.id));
}

/* Flattened list of every deliverable destination — used by search and AI */
export function deliverableNodes() {
  return CAMPUS_NODES.filter((n) => n.active && n.deliverable);
}

/* Nearest geo-tagged ancestor, for distance maths on a leaf without geo */
export function geoOf(id) {
  for (const n of pathOf(id).reverse()) if (n.geo) return n.geo;
  return null;
}

/* ---------- geo ---------------------------------------------------------- */
export function metresBetween(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]), dLng = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function insideCampus(lat, lng) {
  const p = CAMPUS_BOUNDARY.polygon;
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [yi, xi] = p[i], [yj, xj] = p[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* Rank campus nodes by proximity to a fix. Returns candidates, not a verdict —
   the student always confirms which one they actually meant. */
export function nearestNodes(lat, lng, limit = 4) {
  return CAMPUS_NODES
    .filter((n) => n.active && n.geo)
    .map((n) => ({ node: n, m: Math.round(metresBetween([lat, lng], [n.geo.lat, n.geo.lng])) }))
    .filter((c) => c.m <= c.node.geo.r * 4)
    .sort((a, b) => a.m - b.m)
    .slice(0, limit);
}

/* ---------- natural-language resolution (used by the AI agent) -----------
   Returns EVERY match. Disambiguation is the agent's job; deciding whether
   the winner is deliverable is the backend's. The agent cannot invent a
   location because nothing here is generated — only looked up.            */
const ALIASES = {
  z_grnd: ['ground', 'maidan', 'field'],
  s_grnd_bb: ['basketball', 'basket ball', 'bb court', 'court'],
  s_grnd_main: ['main field', 'north side'],
  z_lib: ['library', 'lib', 'padhai'],
  f_lib_1: ['reading hall', 'reading room'],
  f_lib_2: ['reference', 'second floor library'],
  z_labs: ['lab', 'labs'],
  s_lab_cs2: ['cs lab 2', 'cs lab two'],
  b_lab_ws: ['workshop'],
  z_aud: ['auditorium', 'audi'],
  z_acad: ['academic', 'acad', 'class', 'classroom', 'college block'],
  // Reversed forms ("a block") are deliberately absent: they false-match
  // inside phrases like "hostel a block 2".
  b_acad_a: ['block a'],
  b_acad_b: ['block b'],
  b_acad_c: ['block c'],
  s_b_307: ['b-307', 'b 307', '307'],
  s_b_lt3: ['lt-3', 'lt 3', 'lt3'],
  z_hostel: ['hostel', 'hostel area'],
  b_h_a: ['hostel a', 'a hostel'],
  f_h_a1: ['block 1', 'block one'],
  f_h_a2: ['block 2', 'block two'],
  b_h_b: ['block b'],
  b_h_d: ['girls block', 'block d'],
};

const FLOORWORDS = { 'ground floor': 0, 'first floor': 1, '1st floor': 1, 'second floor': 2, '2nd floor': 2, 'third floor': 3, '3rd floor': 3, 'pehle floor': 1, 'doosre floor': 2, 'teesre floor': 3 };

export function resolveLocationPhrase(text) {
  const t = ' ' + text.toLowerCase().replace(/[,.!]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const hits = [];

  for (const [id, words] of Object.entries(ALIASES)) {
    const n = nodeById(id);
    if (!n || !n.active) continue;
    for (const w of words) {
      if (t.includes(' ' + w)) { hits.push({ id, word: w, len: w.length }); break; }
    }
  }
  if (!hits.includes.length) { /* noop, keeps shape stable */ }

  // A floor phrase refines a building hit: "block b ke third floor"
  let floorWord = null;
  for (const [w, n] of Object.entries(FLOORWORDS)) if (t.includes(w)) { floorWord = { w, n }; break; }

  // Prefer the most specific (longest) alias matches
  hits.sort((a, b) => b.len - a.len);
  const ids = [...new Set(hits.map((h) => h.id))];

  const refined = ids.map((id) => {
    if (!floorWord) return id;
    const kids = childrenOf(id).filter((k) => k.kind === 'floor');
    const want = kids.find((k) => {
      const nm = k.name.toLowerCase();
      return (floorWord.n === 0 && nm.includes('ground')) ||
             (floorWord.n === 1 && /1st|first/.test(nm)) ||
             (floorWord.n === 2 && /2nd|second/.test(nm)) ||
             (floorWord.n === 3 && /3rd|third/.test(nm));
    });
    return want ? want.id : id;
  });

  /* "hostel a block 2" matches Hostel Area, Hostel A and Block 2. Only the
     deepest is meant, so drop any hit that is an ancestor of another hit. */
  const uniq = [...new Set(refined)];
  const isAncestorOf = (a, b) => a !== b && pathOf(b).some((n) => n.id === a);
  return uniq.filter((id) => !uniq.some((other) => isAncestorOf(id, other)));
}

/* Turn a resolved node into something a courier can be dispatched to.
   If the node isn't itself deliverable, offer its deliverable children. */
export function destinationOptions(id) {
  const n = nodeById(id);
  if (!n) return [];
  if (n.deliverable) return [n];
  const out = [];
  const walk = (pid) => childrenOf(pid).forEach((k) => { if (k.deliverable) out.push(k); else walk(k.id); });
  walk(id);
  return out;
}
