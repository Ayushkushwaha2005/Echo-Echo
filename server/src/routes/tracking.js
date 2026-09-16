/* ==========================================================================
   ECHO ECHO — LIVE DELIVERY TRACKING

   Two endpoints, and the interesting part of both is what they refuse.

     POST /partner/location    the partner reports where they are, but only
                               while actually carrying THIS order
     GET  /orders/:id/tracking what a map may draw for whoever is asking

   The rule about a partner's position is a privacy rule, not a UI
   preference, so it is enforced here rather than by a screen choosing not to
   draw a marker:

     · a partner who is online but carrying nothing has no stored position
     · a customer sees their partner's position only once the food is in the
       bag — state `picked_up` — and never before
     · the position disappears when the delivery ends
     · nobody else ever sees it: not another customer, not the cafeteria

   Coordinates come from surveyed campus_node rows. Nothing here invents one:
   a location with no recorded position is reported as having none, and the
   map simply has less to draw.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { authorize, can, BadRequest, NotFound, Forbidden } from '../auth/rbac.js';
import { audit } from '../audit.js';

/* While the partner is between these states, their position is live. Before
   `assigned` there is no partner; after `delivered` there is nothing to
   follow. */
const CARRYING = ['assigned', 'picked_up'];
/* When the CUSTOMER may see it. Deliberately narrower than the above: an
   accepted offer is not yet a person walking towards you with your food. */
const VISIBLE_TO_CUSTOMER = ['picked_up'];

const coord = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return NaN;
};

const point = (row, label) => (row && row.lat != null && row.lng != null
  ? { label, name: row.name, lat: Number(row.lat), lng: Number(row.lng) }
  : null);

export default async function trackingRoutes(app) {
  /* ---------- the partner reports where they are ------------------------- */
  app.post('/partner/location', async (req) => {
    authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
    const b = req.body || {};
    const lat = coord(b.lat), lng = coord(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw BadRequest('A position needs both a latitude and a longitude');
    }
    const o = await one(`SELECT id, partner_id, state FROM food_order WHERE id = $1`, [b.orderId]);
    if (!o) throw NotFound('No such order');
    /* Only for an order this partner is actually carrying. A position cannot
       be recorded "in general", so there is no way to build a trail. */
    if (o.partner_id !== req.actor.id) throw Forbidden('That delivery is not yours');
    if (!CARRYING.includes(o.state)) {
      /* Finished, cancelled or not yet picked up: nothing to follow, and
         anything stored is removed rather than left behind. */
      await q(`DELETE FROM partner_location WHERE partner_id = $1`, [req.actor.id]);
      throw Forbidden('That delivery is not in progress',
        `An order in "${o.state}" is not being carried anywhere.`);
    }

    await q(
      `INSERT INTO partner_location (partner_id, order_id, lat, lng, accuracy_m, at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (partner_id) DO UPDATE SET order_id = $2, lat = $3, lng = $4,
             accuracy_m = $5, at = now()`,
      [req.actor.id, o.id, lat, lng,
       Number.isFinite(coord(b.accuracy)) ? coord(b.accuracy) : null]);
    return { recorded: true };
  });

  /* Leaving a delivery, or going offline, takes the position with it. */
  app.post('/partner/location/clear', async (req) => {
    authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
    await q(`DELETE FROM partner_location WHERE partner_id = $1`, [req.actor.id]);
    return { cleared: true };
  });

  /* ---------- what a map may draw ----------------------------------------- */
  app.get('/orders/:id/tracking', async (req) => {
    const o = await one(
      `SELECT o.id, o.state, o.customer_id, o.partner_id, o.fulfilment, o.destination_id,
              o.destination_snapshot, v.name AS vendor_name, v.campus_node_id
         FROM food_order o JOIN vendor v ON v.id = o.vendor_id
        WHERE o.id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');

    const isCustomer = o.customer_id === req.actor?.id;
    const isPartner = o.partner_id === req.actor?.id;
    const isStaff = req.actor?.vendorIds?.length && can(req.actor, 'order.read');
    if (!isCustomer && !isPartner && !isStaff && !can(req.actor, 'order.read_all')) {
      throw Forbidden('That order is not yours');
    }

    /* Both ends of the journey, read from surveyed campus rows. */
    const pickup = point(await one(
      `SELECT name, lat, lng FROM campus_node WHERE id = $1`, [o.campus_node_id]), 'pickup');
    const destination = o.destination_id ? point(await one(
      `SELECT name, lat, lng FROM campus_node WHERE id = $1`, [o.destination_id]), 'destination') : null;

    /* The partner's position, under the disclosure rule above. */
    let partner = null;
    if (o.partner_id) {
      const show = isPartner || can(req.actor, 'order.read_all') ||
        (isCustomer && VISIBLE_TO_CUSTOMER.includes(o.state));
      if (show) {
        const row = await one(
          `SELECT lat, lng, accuracy_m, at FROM partner_location
            WHERE partner_id = $1 AND order_id = $2`, [o.partner_id, o.id]);
        if (row) {
          partner = { lat: Number(row.lat), lng: Number(row.lng),
                      accuracyM: row.accuracy_m == null ? null : Number(row.accuracy_m),
                      at: row.at };
        }
      }
    }

    const boundary = await one(
      `SELECT cb.name, cb.polygon FROM campus_boundary cb
         JOIN vendor v ON v.campus_site_id = cb.campus_site_id
        WHERE v.id = (SELECT vendor_id FROM food_order WHERE id = $1)
          AND cb.status = 'active' LIMIT 1`, [o.id]);

    return {
      orderId: o.id,
      state: o.state,
      fulfilment: o.fulfilment,
      vendorName: o.vendor_name,
      pickup,
      destination,
      /* The frozen address, so the partner reads the same words the student
         chose rather than whatever the campus tree says today. */
      address: o.destination_snapshot || null,
      partner,
      /* Why there is no partner marker, when there is not one. Said plainly
         so the screen can explain rather than look broken. */
      partnerVisibility: !o.partner_id ? 'no_partner_yet'
        : (isPartner || can(req.actor, 'order.read_all')) ? 'visible'
        : VISIBLE_TO_CUSTOMER.includes(o.state) ? (partner ? 'visible' : 'not_reported_yet')
        : 'hidden_until_pickup',
      boundary: boundary ? { name: boundary.name, polygon: boundary.polygon } : null,
      /* A map needs to say when it cannot draw something. */
      note: !pickup && !destination
        ? 'No positions have been recorded for this cafeteria or delivery point yet.'
        : null,
    };
  });
}
