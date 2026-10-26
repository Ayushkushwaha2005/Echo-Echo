/* ==========================================================================
   ECHO ECHO — A DELIVERY PARTNER'S POSITION

   What routes/tracking.js and the order lifecycle share about the one row
   partner_location keeps per partner (migration 019):

   * It exists only while the order it belongs to is being carried
     (CARRYING). Leaving that state deletes it in the same transaction as
     the state change (forgetForOrder, called by transition() in
     routes/orders.js), so a finished delivery never leaves a position
     behind, whatever the partner's phone does afterwards. The sweeper
     removes any row that predates this rule (pruneFinished).
   * A reported position is checked before it is stored (checkReport).

   Freshness is decided where it is read, from the server's own clock:
   ageSeconds goes out with every position, so a phone with a wrong clock
   cannot make an old marker look new.
   ========================================================================== */
import { q } from '../db/index.js';
import { BadRequest } from '../auth/rbac.js';

/* While the order is in these states its partner's position is live. */
export const CARRYING = ['assigned', 'picked_up'];
/* When the CUSTOMER may see it: an accepted offer is not yet a person
   walking towards you with your food. */
export const VISIBLE_TO_CUSTOMER = ['picked_up'];

/* The partner's phone sends a fix every 20 s (web/src/app.js). One a
   second is far beyond that and still leaves room for retries. */
export const REPORTS_PER_MINUTE = 12;
/* A fix the phone took longer ago than this is not "where they are". */
export const MAX_FIX_AGE_SECONDS = 120;
/* A phone clock may run a little fast; more than this is not a real fix. */
export const MAX_CLOCK_AHEAD_SECONDS = 60;
/* Coarser than this, a dot on a campus map says nothing about where the
   partner is (a cell-tower fix, typically). */
export const MAX_ACCURACY_M = 2000;
/* No campus delivery is carried this far from the café it came from. */
export const MAX_KM_FROM_PICKUP = 15;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const num = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return NaN;
};

/* Great-circle distance in km. */
export function kmBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/* The body of POST /partner/location, checked. Returns the values to store
   or throws a 400 that says what is wrong. `now` is injectable for tests. */
export function checkReport(body, now = Date.now()) {
  const b = body || {};
  if (typeof b.orderId !== 'string' || !UUID.test(b.orderId)) throw BadRequest('A position needs the id of the order being carried');
  const lat = num(b.lat), lng = num(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw BadRequest('A position needs both a latitude and a longitude');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw BadRequest('That is not a position on Earth');
  if (lat === 0 && lng === 0) throw BadRequest('That position is a placeholder, not a fix');
  let accuracy = null;
  if (b.accuracy !== undefined && b.accuracy !== null) {
    accuracy = num(b.accuracy);
    if (!Number.isFinite(accuracy) || accuracy < 0) throw BadRequest('Accuracy must be a distance in metres');
    if (accuracy > MAX_ACCURACY_M) throw BadRequest('That fix is too imprecise to show on a map');
  }
  /* When the phone took the fix. Optional (older clients do not send it);
     when sent, it must be recent and not in the future. */
  let takenAt = null;
  if (b.takenAt !== undefined && b.takenAt !== null) {
    const t = typeof b.takenAt === 'number' ? b.takenAt : Date.parse(b.takenAt);
    if (!Number.isFinite(t)) throw BadRequest('takenAt must be a time');
    if (t > now + MAX_CLOCK_AHEAD_SECONDS * 1000) throw BadRequest('That fix is dated in the future');
    if (t < now - MAX_FIX_AGE_SECONDS * 1000) throw BadRequest('That fix is too old to be where you are now');
    takenAt = new Date(Math.min(t, now));
  }
  return { orderId: b.orderId, lat, lng, accuracy, takenAt };
}

/* Called inside the transaction that moves an order out of CARRYING. */
export async function forgetForOrder(c, orderId) {
  await c.query(`DELETE FROM partner_location WHERE order_id = $1`, [orderId]);
}

/* Rows whose order is no longer being carried (left over from before the
   lifecycle deleted them, or by any path that bypassed it). */
export async function pruneFinished() {
  const r = await q(
    `DELETE FROM partner_location pl USING food_order o
      WHERE o.id = pl.order_id AND o.state::text <> ALL($1::text[])`, [CARRYING]);
  return { pruned: r.rowCount };
}
