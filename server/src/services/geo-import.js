/* ==========================================================================
   ECHO ECHO - IMPORTING FIELD-COLLECTED GEODATA

   Parses what a phone GPS app exports (CSV, GPX, GeoJSON) into points and
   perimeter tracks, and compares two boundary outlines. Pure functions: no
   database, no network. Nothing here invents a coordinate - every value comes
   out of the uploaded text or the import is refused with a reason.
   ========================================================================== */
import { metresBetween, pointInPolygon, metresToEdge } from './campus.js';

export const PLACE_TYPES = [
  'academic_block', 'administrative', 'library', 'hostel', 'residence',
  'student_facility', 'cafeteria_pickup', 'entrance', 'delivery_point', 'other',
];
export const VERIFICATION_METHODS = ['gps_on_site', 'survey_track', 'official_map', 'public_map', 'admin_entry'];

/* Place type → campus_node.kind, the hierarchy level the tree uses. */
export const KIND_FOR_TYPE = {
  academic_block: 'building', administrative: 'building', library: 'building', hostel: 'building',
  residence: 'building', student_facility: 'building', cafeteria_pickup: 'spot', entrance: 'spot',
  delivery_point: 'spot', other: 'spot',
};

const MAX_POINTS = 2000;
const MAX_TRACK = 20000;

const num = (v) => {
  const s = String(v ?? '').trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
};

/* ---------- CSV ------------------------------------------------------------ */
function splitCsvLine(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const HEADER_ALIASES = {
  name: ['name', 'title', 'label', 'place'],
  type: ['type', 'place_type', 'category'],
  lat: ['lat', 'latitude', 'y'],
  lng: ['lng', 'lon', 'long', 'longitude', 'x'],
  accuracy: ['accuracy', 'accuracy_m', 'acc', 'hdop_m', 'horizontal_accuracy'],
  method: ['method', 'verification_method', 'source_method'],
  note: ['note', 'notes', 'description', 'source', 'comment'],
  deliverable: ['deliverable', 'delivery', 'orders'],
  time: ['time', 'timestamp', 'recorded_at', 'date'],
};

function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) return { rows: [], problems: ['The CSV needs a header row and at least one data row.'] };
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const col = {};
  for (const [k, names] of Object.entries(HEADER_ALIASES)) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) col[k] = i;
  }
  if (col.lat === undefined || col.lng === undefined) {
    return { rows: [], problems: ['The header must include latitude and longitude columns (lat, lng).'] };
  }
  return {
    rows: lines.slice(1).map((l, i) => {
      const c = splitCsvLine(l);
      const get = (k) => (col[k] === undefined ? undefined : c[col[k]]);
      return { line: i + 2, name: get('name'), type: get('type'), lat: get('lat'), lng: get('lng'),
               accuracy: get('accuracy'), method: get('method'), note: get('note'),
               deliverable: get('deliverable'), time: get('time') };
    }),
    problems: [],
  };
}

/* ---------- GPX -------------------------------------------------------------
   Deliberately a narrow reader: <wpt>/<trkpt>/<rtept> elements with lat/lon
   attributes, and the name/desc/time children. No entity expansion, no DTDs,
   no external references - an XML parser is not needed to read this. */
const attr = (tag, a) => tag.match(new RegExp(`\\b${a}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
const child = (body, t) => body.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i'))?.[1]
  ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();

function parseGpx(text) {
  const s = String(text);
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) return { points: [], track: [], problems: ['GPX files with DOCTYPE or ENTITY declarations are refused.'] };
  /* A linear scan with indexOf. A single regex with a lazy body was
     quadratic on unclosed elements (seconds per megabyte), which an upload
     could use to stall the server. */
  const lower = s.toLowerCase();
  const read = (el) => {
    const out = [];
    const open = `<${el}`, close = `</${el}>`;
    let at = lower.indexOf(open);
    while (at !== -1) {
      const after = lower[at + open.length];
      const next = lower.indexOf(open, at + open.length);
      if (after && !/[\s/>]/.test(after)) { at = next; continue; }     // e.g. <wptx
      const tagEnd = s.indexOf('>', at);
      if (tagEnd === -1) break;
      const head = s.slice(at + open.length, tagEnd);
      let body = '';
      if (!head.endsWith('/')) {
        /* The body ends at its closing tag, and is searched for only up to
           the next element - never to the end of the file, which would make
           a run of unclosed elements quadratic. */
        const region = lower.slice(tagEnd, next === -1 ? lower.length : next);
        const end = region.indexOf(close);
        if (end !== -1) body = s.slice(tagEnd + 1, tagEnd + end);
      }
      out.push({ line: out.length + 1, lat: attr(head, 'lat'), lng: attr(head, 'lon'),
                 name: body ? child(body, 'name') : undefined, note: body ? child(body, 'desc') : undefined,
                 time: body ? child(body, 'time') : undefined, type: body ? child(body, 'type') : undefined });
      at = next;
    }
    return out;
  };
  return { points: read('wpt'), track: [...read('trkpt'), ...read('rtept')], problems: [] };
}

/* ---------- GeoJSON ---------------------------------------------------------- */
function parseGeoJson(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { points: [], track: [], problems: ['That is not valid JSON.'] }; }
  const features = j.type === 'FeatureCollection' ? j.features || [] : j.type === 'Feature' ? [j] : [{ geometry: j, properties: {} }];
  const points = [], track = [];
  features.forEach((f, i) => {
    const g = f?.geometry; const p = f?.properties || {};
    if (!g) return;
    /* GeoJSON order is [longitude, latitude]. */
    if (g.type === 'Point') {
      points.push({ line: i + 1, lng: g.coordinates?.[0], lat: g.coordinates?.[1], name: p.name, type: p.type || p.place_type,
                    accuracy: p.accuracy ?? p.accuracy_m, method: p.method, note: p.note || p.description,
                    deliverable: p.deliverable, time: p.time || p.timestamp });
    } else if (g.type === 'LineString') {
      g.coordinates.forEach(([lng, lat], k) => track.push({ line: k + 1, lat, lng }));
    } else if (g.type === 'Polygon') {
      (g.coordinates?.[0] || []).forEach(([lng, lat], k) => track.push({ line: k + 1, lat, lng }));
    }
  });
  return { points, track, problems: [] };
}

function detect(format, text) {
  const f = String(format || '').toLowerCase();
  if (f) return f;
  const t = String(text || '').trimStart();
  if (t.startsWith('<')) return 'gpx';
  if (t.startsWith('{') || t.startsWith('[')) return 'geojson';
  return 'csv';
}

const yes = (v) => v === true || /^(y|yes|true|1)$/i.test(String(v ?? '').trim());

/* ---------- points ------------------------------------------------------------ */
export function parsePoints({ format, text, defaultMethod = 'gps_on_site', maxAccuracyM = 25 }) {
  if (!text || String(text).length > 2_000_000) return { ok: false, problems: ['Paste the exported file contents (up to 2 MB).'] };
  const kind = detect(format, text);
  const parsed = kind === 'gpx' ? parseGpx(text) : kind === 'geojson' ? parseGeoJson(text) : kind === 'csv' ? parseCsv(text) : null;
  if (!parsed) return { ok: false, problems: [`Unknown format "${format}". Use csv, gpx or geojson.`] };
  const raw = parsed.rows || parsed.points;
  const problems = [...parsed.problems];
  if (!raw.length && !problems.length) problems.push('No points found. GPX needs <wpt> waypoints; GeoJSON needs Point features.');
  if (raw.length > MAX_POINTS) problems.push(`At most ${MAX_POINTS} points per import.`);
  if (problems.length) return { ok: false, format: kind, problems };

  const points = [], rejected = [], seen = new Map();
  for (const r of raw) {
    const why = [];
    const lat = num(r.lat), lng = num(r.lng);
    const name = String(r.name || '').trim().slice(0, 120);
    const type = String(r.type || 'delivery_point').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const method = String(r.method || defaultMethod).trim().toLowerCase();
    const accuracy = r.accuracy === undefined || r.accuracy === '' ? null : num(r.accuracy);
    if (!name) why.push('no name');
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) why.push('latitude missing or out of range');
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) why.push('longitude missing or out of range');
    if (!PLACE_TYPES.includes(type)) why.push(`unknown type "${type}" (use ${PLACE_TYPES.join(', ')})`);
    if (!VERIFICATION_METHODS.includes(method)) why.push(`unknown method "${method}"`);
    if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0)) why.push('accuracy is not a number of metres');
    const key = name.toLowerCase();
    if (name && seen.has(key)) why.push(`duplicate name (also line ${seen.get(key)})`);
    if (why.length) { rejected.push({ line: r.line, name: name || null, problems: why }); continue; }
    seen.set(key, r.line);
    const warnings = [];
    if (accuracy === null) warnings.push('no GPS accuracy recorded');
    else if (accuracy > maxAccuracyM) warnings.push(`GPS accuracy ${accuracy} m is worse than ${maxAccuracyM} m`);
    points.push({ line: r.line, name, type, kind: KIND_FOR_TYPE[type], lat, lng, accuracyM: accuracy, method,
                  note: r.note ? String(r.note).trim().slice(0, 300) : null, deliverable: yes(r.deliverable),
                  recordedAt: r.time ? String(r.time).slice(0, 40) : null, warnings });
  }
  return { ok: true, format: kind, points, rejected };
}

/* ---------- perimeter tracks -------------------------------------------------- */
/* Douglas-Peucker on a local flat projection (metres). */
function simplify(pts, toleranceM) {
  if (pts.length < 3) return pts;
  const k = Math.cos((pts[0][0] * Math.PI) / 180) * 111_320;
  const xy = pts.map(([a, b]) => [b * k, a * 111_320]);
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let best = -1, bestD = toleranceM;
    const [x1, y1] = xy[s], [x2, y2] = xy[e];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [x, y] = xy[i];
      const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function parseTrack({ format, text, toleranceM = 2, maxVertices = 500 }) {
  if (!text || String(text).length > 5_000_000) return { ok: false, problems: ['Paste the exported track (up to 5 MB).'] };
  const kind = detect(format, text);
  let raw;
  if (kind === 'gpx') raw = parseGpx(text);
  else if (kind === 'geojson') raw = parseGeoJson(text);
  else if (kind === 'csv') { const c = parseCsv(text); raw = { track: c.rows, problems: c.problems }; }
  else return { ok: false, problems: [`Unknown format "${format}".`] };
  if (raw.problems.length) return { ok: false, format: kind, problems: raw.problems };
  const src = raw.track.length ? raw.track : (raw.points || []);
  if (src.length > MAX_TRACK) return { ok: false, format: kind, problems: [`At most ${MAX_TRACK} track points.`] };
  const bad = [];
  let pts = [];
  for (const p of src) {
    const lat = num(p.lat), lng = num(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) { bad.push(p.line); continue; }
    const last = pts[pts.length - 1];
    if (last && last[0] === lat && last[1] === lng) continue;
    pts.push([lat, lng]);
  }
  if (bad.length) return { ok: false, format: kind, problems: [`${bad.length} track point(s) have invalid coordinates (first at entry ${bad[0]}). Nothing was imported.`] };
  if (pts.length < 3) return { ok: false, format: kind, problems: ['A perimeter needs at least three distinct points.'] };
  /* A walked loop ends near where it started; the closing edge is implied. */
  const gapM = Math.round(metresBetween(pts[0], pts[pts.length - 1]));
  if (gapM < 1 && pts.length > 3) pts.pop();
  const originalCount = pts.length;
  let tol = toleranceM;
  let simplified = simplify(pts, tol);
  while (simplified.length > maxVertices) { tol *= 1.5; simplified = simplify(pts, tol); }
  const warnings = [];
  if (gapM > 50) warnings.push(`The track ends ${gapM} m from where it started. The outline is closed with a straight line across that gap - check it.`);
  const polygon = simplified.map(([a, b]) => [Number(a.toFixed(7)), Number(b.toFixed(7))]);
  return { ok: true, format: kind, polygon, stats: { trackPoints: src.length, distinct: originalCount, vertices: polygon.length,
           simplifyToleranceM: Number(tol.toFixed(2)), closingGapM: gapM }, warnings };
}

/* ---------- comparing two outlines --------------------------------------------
   Area overlap estimated by sampling a grid over both outlines (about 1 m² per
   cell at campus scale, capped for large shapes). Deviation is the largest
   distance from any vertex of one outline to the other outline's edge. */
export function comparePolygons(a, b, { cells = 250 } = {}) {
  const lats = [...a, ...b].map((p) => p[0]), lngs = [...a, ...b].map((p) => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const cellH = ((maxLat - minLat) * 111_320) / cells;
  const cellW = ((maxLng - minLng) * 111_320 * Math.cos((midLat * Math.PI) / 180)) / cells;
  const cellArea = cellH * cellW;
  let both = 0, onlyA = 0, onlyB = 0;
  for (let i = 0; i < cells; i++) {
    const lat = minLat + ((i + 0.5) / cells) * (maxLat - minLat);
    for (let j = 0; j < cells; j++) {
      const lng = minLng + ((j + 0.5) / cells) * (maxLng - minLng);
      const inA = pointInPolygon(lat, lng, a), inB = pointInPolygon(lat, lng, b);
      if (inA && inB) both++; else if (inA) onlyA++; else if (inB) onlyB++;
    }
  }
  const vertexReport = (from, to) => from.map(([lat, lng], i) => ({
    index: i, lat, lng, inside: pointInPolygon(lat, lng, to), metresToOtherEdge: Math.round(metresToEdge(lat, lng, to)),
  }));
  const va = vertexReport(a, b), vb = vertexReport(b, a);
  const areaA = (both + onlyA) * cellArea, areaB = (both + onlyB) * cellArea;
  const union = (both + onlyA + onlyB) * cellArea;
  return {
    areaM2: { a: Math.round(areaA), b: Math.round(areaB), overlap: Math.round(both * cellArea),
              onlyInA: Math.round(onlyA * cellArea), onlyInB: Math.round(onlyB * cellArea) },
    overlapPct: union ? Number(((both * cellArea * 100) / union).toFixed(1)) : 0,
    maxDeviationM: Math.max(0, ...va.map((v) => v.metresToOtherEdge), ...vb.map((v) => v.metresToOtherEdge)),
    verticesOfAOutsideB: va.filter((v) => !v.inside),
    verticesOfBOutsideA: vb.filter((v) => !v.inside),
    method: `grid sampling, ${cells}×${cells} cells (~${Math.round(cellArea)} m² each)`,
  };
}
