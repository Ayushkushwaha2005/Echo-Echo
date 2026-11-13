/* ==========================================================================
   ECHO ECHO — THE RECORD OF A DELIVERY (migration 043)

   The live position (partner_location) still disappears the moment a
   delivery ends. This is the separate, time-limited record Campus Control
   can open afterwards: pickup and drop point, the partner, a thinned trail
   of the walk and the last recorded position.

   Recorded only:
     - while the order is being carried (the caller has already checked),
     - after the partner chose to share for this delivery,
     - under TRACE_NOTICE_VERSION, the notice that tells the partner a record
       is kept and for how long. A partner who agreed to an earlier notice
       ("no location history is kept") gets no trail.
   Deleted RETENTION.deliveryTraceDays after the delivery ends.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { RETENTION } from '../config.js';

export const TRACE_NOTICE_VERSION = '2026-11-location-2';
export const TRAIL_MIN_METRES = 25;
export const TRAIL_MIN_SECONDS = 120;
export const TRAIL_MAX_POINTS = 400;

const metres = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const s = Math.sin(rad(b[0] - a[0]) / 2) ** 2
    + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

/** Pure: should this fix be added to the trail after `last`? */
export function keepPoint(last, fix) {
  if (!last) return true;
  return metres(last, fix) >= TRAIL_MIN_METRES || fix[2] - last[2] >= TRAIL_MIN_SECONDS;
}

/* Where the delivery starts and ends, frozen when its record begins. */
async function ends(orderId) {
  return one(
    `SELECT pn.name AS pickup_name, pn.lat AS pickup_lat, pn.lng AS pickup_lng,
            COALESCE(dn.name, CASE WHEN o.spot_lat IS NOT NULL THEN 'Delivery spot' END) AS dest_name,
            COALESCE(dn.lat, o.spot_lat) AS dest_lat, COALESCE(dn.lng, o.spot_lng) AS dest_lng
       FROM food_order o JOIN vendor v ON v.id = o.vendor_id
       LEFT JOIN campus_node pn ON pn.id = v.campus_node_id
       LEFT JOIN campus_node dn ON dn.id = o.destination_id
      WHERE o.id = $1`, [orderId]);
}

/** After an accepted position report. Never throws into the report. */
export async function recordPoint(orderId, partnerId, fix, { log } = {}) {
  try {
    const consent = await one(
      `SELECT notice_version FROM location_share_consent
        WHERE order_id = $1 AND partner_id = $2 AND stopped_at IS NULL`, [orderId, partnerId]);
    if (consent?.notice_version !== TRACE_NOTICE_VERSION) return false;
    const t = Math.round((fix.takenAt ? new Date(fix.takenAt).getTime() : Date.now()) / 1000);
    const p = [Number(fix.lat), Number(fix.lng), t, fix.accuracy == null ? null : Math.round(Number(fix.accuracy))];
    const row = await one(`SELECT points, ended_at FROM delivery_trace WHERE order_id = $1`, [orderId]);
    if (row?.ended_at) return false;
    if (!row) {
      const e = await ends(orderId);
      await q(
        `INSERT INTO delivery_trace (order_id, partner_id, pickup_name, pickup_lat, pickup_lng, dest_name, dest_lat, dest_lng, points)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, $9::jsonb) ON CONFLICT (order_id) DO NOTHING`,
        [orderId, partnerId, e?.pickup_name, e?.pickup_lat, e?.pickup_lng, e?.dest_name, e?.dest_lat, e?.dest_lng, JSON.stringify([p])]);
      return true;
    }
    const pts = row.points || [];
    if (pts.length >= TRAIL_MAX_POINTS || !keepPoint(pts.at(-1), p)) return false;
    await q(`UPDATE delivery_trace SET points = points || $2::jsonb WHERE order_id = $1 AND ended_at IS NULL`,
      [orderId, JSON.stringify([p])]);
    return true;
  } catch (e) {
    log?.warn?.({ code: e.code }, 'delivery trace point not recorded');
    return false;
  }
}

/** In the transaction that ends the delivery, before the live row is deleted. */
export async function closeTrace(c, orderId) {
  await c.query(
    `UPDATE delivery_trace t
        SET final_lat = pl.lat, final_lng = pl.lng, final_accuracy_m = pl.accuracy_m, final_at = pl.at
       FROM partner_location pl
      WHERE t.order_id = $1 AND pl.order_id = $1 AND t.ended_at IS NULL`, [orderId]);
  await c.query(
    `UPDATE delivery_trace SET ended_at = now(), purge_after = now() + ($2 || ' days')::interval
      WHERE order_id = $1 AND ended_at IS NULL`, [orderId, String(RETENTION.deliveryTraceDays)]);
}

/** Sweeper: records past their retention go entirely. */
export async function purgeTraces() {
  const r = await q(`DELETE FROM delivery_trace WHERE purge_after IS NOT NULL AND purge_after < now()`);
  return { purged: r.rowCount };
}
