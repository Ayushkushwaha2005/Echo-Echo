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
     · the position disappears when the delivery ends: transition() in
       routes/orders.js deletes it with the state change, and nobody — not
       the customer, the partner or an administrator — is shown a position
       for an order that is no longer being carried
     · nobody else ever sees it: not another customer, not the cafeteria

   Coordinates come from surveyed campus_node rows. Nothing here invents one:
   a location with no recorded position is reported as having none, and the
   map simply has less to draw.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { authorize, can, BadRequest, NotFound, Forbidden } from '../auth/rbac.js';
import { audit } from '../audit.js';
import {
  CARRYING, VISIBLE_TO_CUSTOMER, REPORTS_PER_MINUTE, MAX_KM_FROM_PICKUP, checkReport, kmBetween,
} from '../services/partner-location.js';

const point = (row, label) => (row && row.lat != null && row.lng != null
  ? { label, name: row.name, lat: Number(row.lat), lng: Number(row.lng) }
  : null);

const perActor = (req) => (req.actor?.id ? `actor:${req.actor.id}` : req.ip);

export default async function trackingRoutes(app) {
  /* ---------- the partner reports where they are ------------------------- */
  app.post('/partner/location', {
    config: { rateLimit: { max: REPORTS_PER_MINUTE, timeWindow: '1 minute', keyGenerator: perActor, hook: 'preHandler' } },
  }, async (req) => {
    authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
    const r = checkReport(req.body);
    const o = await one(
      `SELECT o.id, o.partner_id, o.state, n.lat AS pickup_lat, n.lng AS pickup_lng
         FROM food_order o JOIN vendor v ON v.id = o.vendor_id
         LEFT JOIN campus_node n ON n.id = v.campus_node_id
        WHERE o.id = $1`, [r.orderId]);
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
    if (o.pickup_lat != null && o.pickup_lng != null &&
        kmBetween({ lat: Number(o.pickup_lat), lng: Number(o.pickup_lng) }, r) > MAX_KM_FROM_PICKUP) {
      throw BadRequest('That position is too far from the café to be this delivery',
        `More than ${MAX_KM_FROM_PICKUP} km from the pickup point.`);
    }

    await q(
      `INSERT INTO partner_location (partner_id, order_id, lat, lng, accuracy_m, at)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now()))
       ON CONFLICT (partner_id) DO UPDATE SET order_id = $2, lat = $3, lng = $4,
             accuracy_m = $5, at = COALESCE($6::timestamptz, now())`,
      [req.actor.id, o.id, r.lat, r.lng, r.accuracy, r.takenAt]);
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
              o.destination_snapshot, o.spot_lat, o.spot_lng, v.name AS vendor_name, v.campus_node_id
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
      `SELECT name, lat, lng FROM campus_node WHERE id = $1`, [o.destination_id]), 'destination')
      /* An exact spot (migration 027), validated when the order was made. */
      : o.spot_lat !== null ? point({ name: 'Delivery spot', lat: o.spot_lat, lng: o.spot_lng }, 'destination') : null;

    /* The partner's position, under the disclosure rule above. Only while
       the order is being carried, for every viewer: once it is delivered or
       refunded there is no position to show, even if one were still stored. */
    const carrying = CARRYING.includes(o.state);
    let partner = null;
    if (o.partner_id && carrying) {
      const show = isPartner || can(req.actor, 'order.read_all') ||
        (isCustomer && VISIBLE_TO_CUSTOMER.includes(o.state));
      if (show) {
        /* ageSeconds is measured on the server's clock, so the map can say
           how old the position is without trusting the viewer's clock. */
        const row = await one(
          `SELECT lat, lng, accuracy_m, at,
                  GREATEST(0, EXTRACT(EPOCH FROM now() - at))::int AS age_seconds
             FROM partner_location
            WHERE partner_id = $1 AND order_id = $2`, [o.partner_id, o.id]);
        if (row) {
          partner = { lat: Number(row.lat), lng: Number(row.lng),
                      accuracyM: row.accuracy_m == null ? null : Number(row.accuracy_m),
                      at: row.at, ageSeconds: Number(row.age_seconds) };
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
        : !carrying ? 'delivery_over'
        : (isPartner || can(req.actor, 'order.read_all')) ? (partner ? 'visible' : 'not_reported_yet')
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
