/* ==========================================================================
   QUAD — CAMPUS RESOLUTION AND BOUNDARY

   Two rules this module exists to enforce:

   1. A delivery destination is a row in campus_node that is active,
      deliverable and delivery_enabled. Everything else — an archived node,
      a container like "Academic Area", a disabled restricted lab, a made-up
      uuid — is refused. There is no code path that accepts coordinates or
      text as a destination, so a hand-edited API request cannot smuggle an
      off-campus delivery through.

   2. A browser's GPS reading is a claim. It is tested against the campus
      polygon here, on the server, and it can only ever produce *candidate*
      locations that the student must then confirm.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { BadRequest, Forbidden, NotFound } from '../auth/rbac.js';

/* Worst GPS uncertainty (metres) a live-location fix may have and still be
   used to suggest delivery spots. Phones outdoors report ~5-20 m. */
const GPS_MAX_ACCURACY_M = Number(process.env.CAMPUS_GPS_MAX_ACCURACY_M || 100);

export async function tree(campusId = null) {
  const { rows } = await q(
    `SELECT id, parent_id, kind, name, detail, aliases, deliverable,
            delivery_enabled, lat, lng, radius_m, source, source_note, sort, campus_site_id, instructions,
            verification, confidence, verified_at, place_type, verification_method, gps_accuracy_m
       FROM campus_node WHERE active AND ($1::uuid IS NULL OR campus_site_id = $1)
      ORDER BY sort, name`, [campusId]);
  return rows;
}

export async function pathOf(id) {
  const { rows } = await q(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, name, 0 AS depth FROM campus_node WHERE id = $1
       UNION ALL
       SELECT n.id, n.parent_id, n.name, up.depth + 1
         FROM campus_node n JOIN up ON n.id = up.parent_id)
     SELECT id, name FROM up ORDER BY depth DESC`, [id]);
  return rows;
}
export const pathLabel = async (id, sep = ' — ') =>
  (await pathOf(id)).map((n) => n.name).join(sep);

/* ---------- the gate -----------------------------------------------------
   Called by order creation, by the AI draft builder, and by nothing else.
   Returns the node or throws; there is no "warn and continue" branch.     */
export async function assertDeliverable(id, { campusId = null } = {}) {
  if (!id) throw BadRequest('Choose a delivery location');
  let n;
  try {
    n = await one(`SELECT * FROM campus_node WHERE id = $1`, [id]);
  } catch {
    throw BadRequest('Unknown delivery location', 'Not a valid campus location id.');
  }
  if (!n) throw NotFound('Unknown delivery location', 'No such campus location.');
  if (campusId && n.campus_site_id !== campusId) {
    throw Forbidden('That location is not on this campus', 'Choose a delivery spot on the cafeteria\'s campus.');
  }
  /* No confirmed boundary for this campus means no delivery at all. An
     unverified outline is worse than none: it would quietly accept places
     that are not campus. Pickup orders never reach this function. */
  const b = await boundary(n.campus_site_id);
  if (!b) {
    throw Forbidden('Campus delivery is not available yet',
      'The campus delivery area has not been confirmed by an administrator. Choose self pickup for now.');
  }
  if (n.lat != null && !pointInPolygon(Number(n.lat), Number(n.lng), b.polygon)) {
    throw Forbidden(`${n.name} is outside the campus delivery area`,
      'This location\'s recorded position lies outside the confirmed campus boundary.');
  }
  if (!n.active) throw Forbidden('That location has been archived', `${n.name} is no longer in service.`);
  if (!n.deliverable) {
    throw BadRequest(`${n.name} is an area, not a delivery point`,
      'Choose a specific building, floor or room inside it.');
  }
  if (!n.delivery_enabled) {
    throw Forbidden(`Delivery is currently unavailable to ${n.name}`,
      'An administrator has disabled delivery to this location.');
  }
  if (n.verification === 'pending') {
    throw Forbidden(`${n.name} has not been confirmed as a delivery point`,
      'An administrator has to confirm this location on the ground first.');
  }
  /* Without a recorded position there is no way to show the place is inside
     the confirmed boundary, so it is refused rather than assumed. */
  if (n.lat == null || n.lng == null) {
    throw Forbidden(`${n.name} has no recorded position`,
      'An administrator must record where this location is before food can be delivered there.');
  }
  return n;
}

/* Deliverable destinations underneath a node (for the customer picker). */
export async function destinationOptions(id) {
  const { rows } = await q(
    `WITH RECURSIVE down AS (
       SELECT * FROM campus_node WHERE id = $1
       UNION ALL
       SELECT c.* FROM campus_node c JOIN down ON c.parent_id = down.id)
     SELECT id, name, kind, parent_id, deliverable, delivery_enabled
       FROM down WHERE active AND deliverable ORDER BY kind, name`, [id]);
  return rows;
}

/* ---------- geometry ------------------------------------------------------ */
export function metresBetween(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i], [yj, xj] = polygon[j];
    if ((yi > lat) !== (yj > lat) &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* The confirmed boundary of one campus, or of any campus when none is named
   (used only where the caller has no campus context). */
export async function boundary(campusId = null) {
  return one(
    `SELECT * FROM campus_boundary WHERE status = 'active' AND ($1::uuid IS NULL OR campus_site_id = $1)
      ORDER BY updated_at DESC LIMIT 1`, [campusId]);
}

/* Shortest distance in metres from a point to a polygon's edge, on a local
   flat projection - accurate to well under a metre at campus scale. */
export function metresToEdge(lat, lng, polygon) {
  const k = Math.cos((lat * Math.PI) / 180) * EARTH_M_PER_DEG;
  const P = polygon.map(([a, b]) => [(b - lng) * k, (a - lat) * EARTH_M_PER_DEG]);
  let best = Infinity;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [x1, y1] = P[j], [x2, y2] = P[i];
    const dx = x2 - x1, dy = y2 - y1;
    const t = dx || dy ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
  }
  return best;
}

/* ---------- distance and time estimates ----------------------------------
   Straight-line distance between two surveyed points, inflated for paths
   that do not run straight, walked at a conservative pace, plus a margin for
   handing over. Shown as a range in whole minutes. Never computed when
   either end has no recorded position, and never presented as navigation. */
export const WALK = { detourMin: 1.25, detourMax: 1.6, fastMpm: 80, slowMpm: 65, handoverMin: 2, handoverMax: 4 };

export function walkEstimate(from, to) {
  if (!from || !to || from.lat == null || to.lat == null) return null;
  const metres = metresBetween([Number(from.lat), Number(from.lng)], [Number(to.lat), Number(to.lng)]);
  const low = Math.max(1, Math.round((metres * WALK.detourMin) / WALK.fastMpm) + WALK.handoverMin);
  const high = Math.max(low + 1, Math.ceil((metres * WALK.detourMax) / WALK.slowMpm) + WALK.handoverMax);
  return { metres: Math.round(metres / 10) * 10, minMinutes: low, maxMinutes: high,
           label: `Approx. ${low}–${high} min`, basis: 'straight-line distance between recorded points' };
}

/* ---------- boundary validation -----------------------------------------
   An administrator types these coordinates in by hand, so the failure modes
   are transposed lat/lng, a stray digit, and a polygon that is really a
   line. A campus geofence that is subtly wrong is worse than none: it
   silently accepts students in the wrong place, or rejects them outside a
   building they are standing in. None of this invents a polygon — it only
   refuses one that cannot be a campus. */
const EARTH_M_PER_DEG = 111_320;

export function validatePolygon(polygon) {
  const problems = [];
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return { ok: false, problems: ['A boundary needs at least three [lat, lng] points.'] };
  }
  if (polygon.length > 500) problems.push('More than 500 points; simplify the outline.');

  for (const [i, p] of polygon.entries()) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => Number.isFinite(n))) {
      problems.push(`Point ${i + 1} is not a [lat, lng] pair of numbers.`);
      continue;
    }
    const [lat, lng] = p;
    if (lat < -90 || lat > 90) problems.push(`Point ${i + 1}: latitude ${lat} is out of range.`);
    if (lng < -180 || lng > 180) problems.push(`Point ${i + 1}: longitude ${lng} is out of range.`);
  }
  if (problems.length) return { ok: false, problems };

  /* Degenerate shapes: a "polygon" that is a point or a line has no inside,
     so every location check would fail forever. */
  const lats = polygon.map((p) => p[0]);
  const lngs = polygon.map((p) => p[1]);
  const spanLat = (Math.max(...lats) - Math.min(...lats)) * EARTH_M_PER_DEG;
  const midLat = (Math.max(...lats) + Math.min(...lats)) / 2;
  const spanLng = (Math.max(...lngs) - Math.min(...lngs)) *
                  EARTH_M_PER_DEG * Math.cos((midLat * Math.PI) / 180);

  if (spanLat < 20 || spanLng < 20) {
    problems.push('The outline is under 20 m across — it is a point or a line, not an area.');
  }
  /* A university campus is not a country. 50 km across almost certainly
     means a decimal point in the wrong place. */
  if (spanLat > 50_000 || spanLng > 50_000) {
    problems.push('The outline spans more than 50 km; check for a misplaced decimal point.');
  }

  /* Shoelace area, as a sanity check on self-intersecting input. */
  let area2 = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area2 += (polygon[j][1] * polygon[i][0]) - (polygon[i][1] * polygon[j][0]);
  }
  const areaM2 = Math.abs(area2 / 2) * EARTH_M_PER_DEG * EARTH_M_PER_DEG *
                 Math.cos((midLat * Math.PI) / 180);
  if (areaM2 < 400) {
    problems.push('The enclosed area is under 400 m² — the points may be out of order, ' +
                  'which makes the outline cross itself.');
  }

  if (problems.length) return { ok: false, problems };

  /* Swapped latitude and longitude is the most common data-entry error, and
     it usually produces a geometrically VALID polygon somewhere absurd. It
     cannot be detected with certainty — a campus really can be at 69°N — so
     this is a warning that surfaces the consequence rather than a rejection
     that pretends to know the admin's intent. The centroid is returned so a
     person can sanity-check where they have actually drawn. */
  const centroid = [
    (Math.max(...lats) + Math.min(...lats)) / 2,
    (Math.max(...lngs) + Math.min(...lngs)) / 2,
  ];
  const warnings = [];
  if (Math.abs(centroid[0]) > 60) {
    warnings.push(
      `The centre of this outline is at latitude ${centroid[0].toFixed(4)}, which is inside ` +
      'the polar regions. If that is not where your campus is, latitude and longitude are ' +
      'probably swapped.');
  }

  return {
    ok: true,
    warnings,
    metrics: {
      points: polygon.length,
      widthM: Math.round(spanLng), heightM: Math.round(spanLat),
      areaM2: Math.round(areaM2),
      centroid: { lat: Number(centroid[0].toFixed(6)), lng: Number(centroid[1].toFixed(6)) },
    },
  };
}

/* Live location → candidates. Never a verdict: the student confirms. */
export async function resolveFix(lat, lng, { accuracy, campusId = null } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw BadRequest('Invalid coordinates');
  const b = await boundary(campusId);
  if (!b) {
    return { inside: false, reason: 'no_boundary_configured', candidates: [],
             note: 'The campus delivery area has not been confirmed yet. Choose your spot from the list.' };
  }
  /* A fix whose uncertainty is unknown or wider than a building cannot say
     which side of the boundary - or which block - the student is on. Refuse
     it rather than suggest places. The order itself still only ever targets a
     configured campus_node; this keeps the suggestions honest. */
  const acc = accuracy === null || accuracy === undefined || accuracy === '' ? NaN : Number(accuracy);
  if (!Number.isFinite(acc) || acc < 0) {
    return { inside: false, reason: 'accuracy_unknown', candidates: [],
             note: 'Your device did not report how accurate its location is. Choose your spot from the list instead.' };
  }
  if (acc > GPS_MAX_ACCURACY_M) {
    return { inside: false, reason: 'low_accuracy', accuracy: acc, candidates: [],
             note: `Your location is only accurate to about ${Math.round(acc)} m. ` +
                   'Move outdoors or choose your spot from the list instead.' };
  }
  if (!pointInPolygon(lat, lng, b.polygon)) {
    return { inside: false, reason: 'outside_campus', boundaryName: b.name, candidates: [] };
  }
  /* Inside, but closer to the edge than the fix's own uncertainty: the true
     position could be outside. Not a rejection of the student - just no
     suggestion from a reading that cannot tell. */
  if (metresToEdge(lat, lng, b.polygon) < acc) {
    return { inside: false, reason: 'near_boundary', accuracy: acc, candidates: [],
             note: 'You are close to the edge of campus and your location is not precise enough to be sure. Choose your spot from the list.' };
  }
  const { rows } = await q(
    `SELECT id, name, kind, parent_id, lat, lng, radius_m, deliverable, delivery_enabled
       FROM campus_node
      WHERE active AND lat IS NOT NULL AND lng IS NOT NULL AND campus_site_id = $1`, [b.campus_site_id]);

  const ranked = rows
    .map((n) => ({ node: n, metres: Math.round(metresBetween([lat, lng], [n.lat, n.lng])) }))
    .filter((c) => c.metres <= (c.node.radius_m || 60) * 4)
    .sort((a, b2) => a.metres - b2.metres)
    .slice(0, 5);

  /* A geo-tagged container resolves to its deliverable children. */
  const candidates = [];
  for (const c of ranked) {
    if (c.node.deliverable && c.node.delivery_enabled) {
      candidates.push({ id: c.node.id, name: c.node.name, metres: c.metres,
                        path: await pathLabel(c.node.id) });
    } else {
      for (const d of (await destinationOptions(c.node.id)).slice(0, 4)) {
        if (!d.delivery_enabled) continue;
        candidates.push({ id: d.id, name: d.name, metres: c.metres, path: await pathLabel(d.id) });
      }
    }
  }
  return {
    inside: true, boundaryName: b.name, accuracy: accuracy ?? null,
    candidates: candidates.slice(0, 6),
    note: candidates.length ? null : 'You are inside campus but not near a configured delivery point.',
  };
}

/* ---------- natural-language resolution (shared with the AI agent) --------
   Matches only against rows that exist. Returns every match plus the
   ambiguity, because deciding between two "Block B"s is a question for the
   student, not a guess for the model. */
const FLOOR_WORDS = [
  [/\bground\s*(floor|fl)\b|\bg\s*floor\b/, 0],
  [/\b(1st|first|pehl[ae])\s*(floor|fl|manzil)\b/, 1],
  [/\b(2nd|second|doosr[ae]|dusr[ae])\s*(floor|fl|manzil)\b/, 2],
  [/\b(3rd|third|teesr[ae])\s*(floor|fl|manzil)\b/, 3],
  [/\b(4th|fourth|chauth[ae])\s*(floor|fl|manzil)\b/, 4],
];
const floorMatches = (name, n) => {
  const s = name.toLowerCase();
  return (n === 0 && /ground/.test(s)) || (n === 1 && /1st|first/.test(s)) ||
         (n === 2 && /2nd|second/.test(s)) || (n === 3 && /3rd|third/.test(s)) ||
         (n === 4 && /4th|fourth/.test(s));
};

export async function resolvePhrase(text, { campusId = null } = {}) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[,.!?]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const nodes = await tree(campusId);

  /* Longest alias wins, so "hostel a" beats "hostel". Node names count as
     aliases too, so an admin adding a location makes it addressable
     immediately without a code change. */
  const hits = [];
  for (const n of nodes) {
    const terms = [n.name.toLowerCase(), ...(n.aliases || []).map((a) => a.toLowerCase())];
    let best = null;
    for (const term of terms) {
      if (term.length < 2) continue;
      if (t.includes(' ' + term + ' ') || t.includes(' ' + term)) {
        if (!best || term.length > best.length) best = term;
      }
    }
    if (best) hits.push({ node: n, term: best, len: best.length });
  }
  if (!hits.length) return { matches: [], ambiguous: false };

  let floor = null;
  for (const [re, n] of FLOOR_WORDS) if (re.test(t)) { floor = n; break; }

  /* Refine a building hit down to a named floor when one was spoken. */
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const refined = hits.map((h) => {
    if (floor === null) return h.node;
    const kids = nodes.filter((n) => n.parent_id === h.node.id && n.kind === 'floor');
    const want = kids.find((k) => floorMatches(k.name, floor));
    return want || h.node;
  });

  /* "hostel a block 2" matches Hostel Area, Hostel A and Block 2. Only the
     deepest is meant — drop any hit that is an ancestor of another hit. */
  const ids = [...new Set(refined.map((n) => n.id))];
  const ancestors = (id) => {
    const out = []; let n = byId.get(id);
    while (n?.parent_id) { out.push(n.parent_id); n = byId.get(n.parent_id); }
    return out;
  };
  const deepest = ids.filter((id) => !ids.some((o) => o !== id && ancestors(o).includes(id)));

  const matches = [];
  for (const id of deepest) {
    const n = byId.get(id);
    matches.push({
      id: n.id, name: n.name, kind: n.kind, deliverable: n.deliverable,
      deliveryEnabled: n.delivery_enabled, path: await pathLabel(n.id),
      options: n.deliverable ? [] : (await destinationOptions(n.id)).map((d) => ({ id: d.id, name: d.name })),
    });
  }
  return { matches, ambiguous: matches.length > 1 };
}
