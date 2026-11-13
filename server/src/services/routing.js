/* ==========================================================================
   ECHO ECHO — WALKING ROUTES (Google Routes API, Essentials tier)

   Delivery partners walk. One route is asked for per delivery leg (partner
   to café while assigned, partner to the student once picked up), and that
   route is REUSED for every GPS update that follows. A new one is requested
   only when the leg changes, or when the partner has clearly left the route
   (MAX_REROUTES at most per order). A GPS update never, by itself, costs a
   Routes request.

   Only basic fields are asked for, with travelMode WALK and no routing
   preference, so every request is billed as Compute Routes Essentials:
   no traffic, no two-wheeler, no alternatives, no waypoints.

   Google's terms allow temporary caching of a result to serve the request it
   was made for. A route lives in memory with its delivery and is dropped
   when the delivery ends (forgetOrderRoute) or after ROUTE_TTL_MS, never
   written to the database.

   With no GOOGLE_ROUTES_API_KEY every function returns null and the maps
   fall back to the straight line they drew before.
   ========================================================================== */

export const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
export const FIELD_MASK = 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline';
export const ROUTE_TTL_MS = 30 * 60 * 1000;
/* A failed request is not retried for this long, so an outage or an
   exhausted quota is not hammered once per GPS update. */
export const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/* Further than this from the route, on a fix at least this accurate, and the
   partner is off route. */
export const DEVIATION_M = 60;
export const MAX_REROUTES = 2;
/* ECHO ECHO's own ceiling, below the 2,000/day quota set in Google Cloud, so
   the platform stops asking before Google starts refusing. */
export const DEFAULT_DAILY_LIMIT = 1500;

const legs = new Map();        // orderId -> { leg, target, route, reroutes, at }
let failedAt = 0;
let counter = { day: '', used: 0 };

export const routesConfigured = (env = process.env) => !!String(env.GOOGLE_ROUTES_API_KEY || '').trim();

export function usage() {
  return { day: counter.day, used: counter.used, limit: dailyLimit(), cachedLegs: legs.size };
}
const dailyLimit = (env = process.env) => {
  const n = Number(env.ROUTES_DAILY_LIMIT);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_LIMIT;
};

/* Google's encoded polyline format, decoded to [{lat, lng}]. */
export function decodePolyline(encoded) {
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += d; else lng += d;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

/* Metres from a point to the nearest point of a path, on a local flat
   projection: exact enough for a campus. */
export function metresFromPath(p, path) {
  if (!path?.length) return null;
  const k = 111_320, c = Math.cos((p.lat * Math.PI) / 180);
  const xy = (q) => [(q.lng - p.lng) * k * c, (q.lat - p.lat) * k];
  let best = Infinity;
  for (let i = 0; i < path.length; i++) {
    const [ax, ay] = xy(path[i]);
    if (path.length === 1) { best = Math.hypot(ax, ay); break; }
    if (i === path.length - 1) break;
    const [bx, by] = xy(path[i + 1]);
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

const sameTarget = (a, b) => a && b && Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;

/** One walking route from Google, or null. Counts against the daily limit. */
export async function fetchWalkingRoute(from, to, { env = process.env, fetchImpl = globalThis.fetch, now = Date.now(), log } = {}) {
  const apiKey = String(env.GOOGLE_ROUTES_API_KEY || '').trim();
  if (!apiKey || !from || !to) return null;
  if (now - failedAt < FAILURE_BACKOFF_MS) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  if (counter.day !== day) counter = { day, used: 0 };
  if (counter.used >= dailyLimit(env)) return null;
  counter.used += 1;
  const at = (p) => ({ location: { latLng: { latitude: Number(p.lat), longitude: Number(p.lng) } } });
  try {
    const r = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({ origin: at(from), destination: at(to), travelMode: 'WALK',
                             computeAlternativeRoutes: false, units: 'METRIC', languageCode: 'en-IN' }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) {
      failedAt = now;
      /* The status only: Google's error body can echo request details. */
      log?.warn?.({ status: r.status }, 'routes api request refused');
      return null;
    }
    const best = (await r.json())?.routes?.[0];
    if (!best?.polyline?.encodedPolyline) return null;
    return {
      distanceM: Number(best.distanceMeters) || 0,
      durationS: parseInt(String(best.duration || '0'), 10) || 0,
      polyline: best.polyline.encodedPolyline,
      mode: 'walk',
      source: 'google-routes',
    };
  } catch (e) {
    failedAt = now;
    log?.warn?.({ code: e?.name }, 'routes api request failed');
    return null;
  }
}

/**
 * The walking route for the leg an order is on, reusing what was already
 * fetched. Returns { route, offRouteM, offRoute } or null.
 *
 *   state 'assigned'  : partner -> pickup
 *   state 'picked_up' : partner (or the café, before a fix) -> destination
 */
export async function routeForOrder({ orderId, state, partner, pickup, destination }, opts = {}) {
  const now = opts.now ?? Date.now();
  const leg = state === 'assigned' ? 'to_pickup' : state === 'picked_up' ? 'to_destination' : null;
  const target = leg === 'to_pickup' ? pickup : leg === 'to_destination' ? destination : null;
  if (!leg || !target) { legs.delete(orderId); return null; }
  const origin = partner || (leg === 'to_destination' ? pickup : null);
  if (!origin) return null;

  let entry = legs.get(orderId);
  if (entry && (entry.leg !== leg || !sameTarget(entry.target, target) || now - entry.at > ROUTE_TTL_MS)) entry = null;

  let offRouteM = null;
  if (entry?.route && partner) {
    offRouteM = metresFromPath(partner, entry.path);
    const trusted = partner.accuracyM == null || partner.accuracyM <= DEVIATION_M;
    if (trusted && offRouteM > DEVIATION_M && entry.reroutes < MAX_REROUTES) {
      const fresh = await fetchWalkingRoute(partner, target, { ...opts, now });
      if (fresh) {
        entry = { ...entry, route: fresh, path: decodePolyline(fresh.polyline), reroutes: entry.reroutes + 1, at: now };
        legs.set(orderId, entry);
        offRouteM = metresFromPath(partner, entry.path);
      }
    }
  }
  if (!entry) {
    const route = await fetchWalkingRoute(origin, target, { ...opts, now });
    if (!route) return null;
    entry = { leg, target, route, path: decodePolyline(route.polyline), reroutes: 0, at: now };
    legs.set(orderId, entry);
    offRouteM = partner ? metresFromPath(partner, entry.path) : null;
  }
  if (legs.size > 500) legs.delete(legs.keys().next().value);
  return {
    leg,
    ...entry.route,
    rerouted: entry.reroutes,
    offRouteM: offRouteM == null ? null : Math.round(offRouteM),
    offRoute: offRouteM != null && offRouteM > DEVIATION_M
      && (partner?.accuracyM == null || partner.accuracyM <= DEVIATION_M),
  };
}

export function forgetOrderRoute(orderId) { legs.delete(orderId); }

/* ---------- the café -> drop route of a delivery --------------------------
   The same for every order between the same two points, so it is fetched
   once per pair and reused for PAIR_TTL_MS by every order and every viewer
   (memory only, never stored). Used for deliveries waiting for a partner and
   to measure a carried order's progress. */
export const PAIR_TTL_MS = 6 * 60 * 60 * 1000;
const pairs = new Map();   // key -> { at, route, path } | { at, failed: true }
const pairKey = (a, b) => [a.lat, a.lng, b.lat, b.lng].map((n) => Number(n).toFixed(5)).join(',');
export async function pairRoute(from, to, opts = {}) {
  if (!from || !to) return null;
  const now = opts.now ?? Date.now();
  const k = pairKey(from, to);
  const hit = pairs.get(k);
  if (hit && now - hit.at < (hit.failed ? FAILURE_BACKOFF_MS : PAIR_TTL_MS)) return hit.route || null;
  const route = await fetchWalkingRoute(from, to, { ...opts, now });
  pairs.set(k, route ? { at: now, route, path: decodePolyline(route.polyline) } : { at: now, failed: true });
  if (pairs.size > 300) pairs.delete(pairs.keys().next().value);
  return route;
}
export function pairPath(from, to) { return pairs.get(pairKey(from, to))?.path || null; }

/** Metres along a path to the point on it nearest p, and the path length. */
export function metresAlong(p, path) {
  if (!p || !path || path.length < 2) return null;
  const k = 111_320, c = Math.cos((p.lat * Math.PI) / 180);
  const xy = (q) => [(q.lng - p.lng) * k * c, (q.lat - p.lat) * k];
  let walked = 0, total = 0, best = Infinity, at = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = xy(path[i]), [bx, by] = xy(path[i + 1]);
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (len * len))) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) { best = d; at = walked + t * len; }
    walked += len;
  }
  total = walked;
  return { along: at, total, off: best };
}


/* Tests only. */
export function _reset() { legs.clear(); pairs.clear(); failedAt = 0; counter = { day: '', used: 0 }; }
