/* ==========================================================================
   ECHO ECHO — DELIVERY ALERTS for Campus Control's fleet map

   Plain distance-and-time rules; no model, no learning.

   silent    no position for longer than the map's freshness window
   stopped   the partner has stayed within a small circle for STOP_AFTER_S,
             away from the café and the drop point (waiting there is normal)
   off_route further than DEVIATION_M from the walking route (routing.js)
   late      the leg is taking longer than expected

   Privacy: stop detection needs to know where the partner was when they
   last moved. That is ONE point per active delivery, held in this process's
   memory, replaced as they move and dropped when the delivery ends
   (forgetMovement). It is never written to the database and is not a trail,
   so the existing promise - no location history - still holds. A restart
   simply forgets it, and stop alerts start again from the next fix.
   ========================================================================== */

export const FRESH_SECONDS = 60;          // same as packages/ui/map.js
export const STOP_RADIUS_M = 25;
export const STOP_AFTER_S = 6 * 60;
export const NEAR_STOP_POINT_M = 40;      // café / drop point: waiting is expected
/* A leg with no route estimate is late after these. */
export const LATE_PICKUP_S = 20 * 60;
export const LATE_DROP_S = 20 * 60;
/* Added to Google's walking estimate before a leg counts as late. */
export const LATE_GRACE_S = 5 * 60;

const anchors = new Map();   // partnerId -> { orderId, lat, lng, at }

export function metres(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Called for every accepted position report. */
export function noteMovement(partnerId, orderId, fix, now = Date.now()) {
  const a = anchors.get(partnerId);
  const radius = Math.max(STOP_RADIUS_M, 2 * (Number(fix.accuracy) || 0));
  if (!a || a.orderId !== orderId || metres(a, fix) > radius) {
    anchors.set(partnerId, { orderId, lat: Number(fix.lat), lng: Number(fix.lng), at: now });
  }
}
export function forgetMovement(partnerId) { anchors.delete(partnerId); }
export function forgetMovementForOrder(orderId) {
  for (const [k, v] of anchors) if (v.orderId === orderId) anchors.delete(k);
}
export function stillSince(partnerId, orderId) {
  const a = anchors.get(partnerId);
  return a && a.orderId === orderId ? a.at : null;
}

/**
 * Pure: the alerts for one delivery.
 *
 * @param d { state, partner: {lat,lng,ageSeconds}|null, pickup, destination,
 *            stateSince: Date|ms, stillSinceMs, route: routeForOrder() | null }
 */
export function alertsFor(d, now = Date.now()) {
  const out = [];
  const p = d.partner;
  if (!p) out.push({ code: 'silent', level: 'warn', text: 'No position shared yet' });
  else if (p.ageSeconds > FRESH_SECONDS) {
    out.push({ code: 'silent', level: p.ageSeconds > 300 ? 'bad' : 'warn',
               text: `No position for ${Math.round(p.ageSeconds / 60) || 1} min` });
  }

  if (p && p.ageSeconds <= FRESH_SECONDS * 5 && d.stillSinceMs) {
    const stillS = (now - d.stillSinceMs) / 1000;
    const near = [d.pickup, d.destination].some((x) => x && metres(p, x) <= NEAR_STOP_POINT_M);
    if (!near && stillS >= STOP_AFTER_S) {
      out.push({ code: 'stopped', level: 'warn', text: `Stopped for ${Math.round(stillS / 60)} min away from the café and drop point` });
    }
  }

  if (d.route?.offRoute) {
    out.push({ code: 'off_route', level: 'warn', text: `${d.route.offRouteM} m off the walking route` });
  }

  if (d.stateSince) {
    const since = (now - new Date(d.stateSince).getTime()) / 1000;
    const expected = d.route?.durationS ? d.route.durationS + LATE_GRACE_S
      : d.state === 'assigned' ? LATE_PICKUP_S : LATE_DROP_S;
    if (since > expected) {
      out.push({ code: 'late', level: since > expected * 1.5 ? 'bad' : 'warn',
                 text: `${d.state === 'assigned' ? 'Pickup' : 'Drop-off'} taking ${Math.round(since / 60)} min (expected about ${Math.round(expected / 60)})` });
    }
  }
  return out;
}

/* Tests only. */
export function _reset() { anchors.clear(); }
