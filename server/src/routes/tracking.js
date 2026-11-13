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
import { authorize, can, BadRequest, NotFound, Forbidden, Conflict, HttpError } from '../auth/rbac.js';
import { audit, auditTx } from '../audit.js';
import {
  CARRYING, VISIBLE_TO_CUSTOMER, REPORTS_PER_MINUTE, MAX_KM_FROM_PICKUP, SHARE_NOTICE_VERSION,
  checkReport, kmBetween, stopSharing,
} from '../services/partner-location.js';
import { publishPosition } from '../services/live.js';
import { mapsConfig } from '../services/maps.js';
import { recordPoint } from '../services/delivery-trace.js';
import { RETENTION } from '../config.js';
import { routeForOrder, pairRoute, pairPath, metresAlong } from '../services/routing.js';
/* A person's name as Campus Control shows it: their chosen display name, else the account name. */
const PERSON = (u) => `COALESCE((SELECT ap.display_name FROM admin_profile ap WHERE ap.user_id = ${u}.id), ${u}.name)`;
import { alertsFor, noteMovement, stillSince, forgetMovement } from '../services/delivery-alerts.js';
import { tx } from '../db/index.js';

/* One audit row per administrator, per order, per few minutes: a map that
   refreshes every few seconds should not write hundreds of identical rows, and
   the fact that this person looked is what the log needs. */
const AUDIT_EVERY_MS = 5 * 60_000;
const lastAudit = new Map();
function auditPositionView(req, orderId) {
  const key = `${req.actor.id}|${orderId}`;
  const now = Date.now();
  if (now - (lastAudit.get(key) || 0) < AUDIT_EVERY_MS) return null;
  if (lastAudit.size > 5000) lastAudit.clear();
  lastAudit.set(key, now);
  return audit(req, { action: 'delivery.track.view', resource: 'food_order', resourceId: orderId, outcome: 'ok' });
}

/* When the order entered its current state, from the order's own event log. */
async function stateSince(orderId, state) {
  const r = await one(`SELECT max(at) AS at FROM order_event WHERE order_id = $1 AND to_state = $2`, [orderId, state]);
  return r?.at || null;
}

const point = (row, label) => (row && row.lat != null && row.lng != null
  ? { label, name: row.name, lat: Number(row.lat), lng: Number(row.lng) }
  : null);

const perActor = (req) => (req.actor?.id ? `actor:${req.actor.id}` : req.ip);

export default async function trackingRoutes(app) {
  /* ---------- starting to share ------------------------------------------
     The partner's explicit choice, once per delivery. Without this row no
     position is accepted for the order. */
  app.post('/partner/location/start', async (req) => {
    authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
    const orderId = String(req.body?.orderId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw BadRequest('Which delivery?');
    return tx(async (c) => {
      const o = (await c.query(`SELECT partner_id, state FROM food_order WHERE id = $1`, [orderId])).rows[0];
      if (!o) throw NotFound('No such order');
      if (o.partner_id !== req.actor.id) throw Forbidden('That delivery is not yours');
      if (!CARRYING.includes(o.state)) throw Forbidden('That delivery is not in progress');
      const row = (await c.query(
        `INSERT INTO location_share_consent (order_id, partner_id, notice_version) VALUES ($1,$2,$3)
         ON CONFLICT (order_id, partner_id) DO UPDATE SET consented_at = now(), notice_version = $3, stopped_at = NULL, stop_reason = NULL
         RETURNING consented_at`, [orderId, req.actor.id, SHARE_NOTICE_VERSION])).rows[0];
      await auditTx(c, req, { action: 'delivery.location.start', resource: 'food_order', resourceId: orderId, detail: { notice: SHARE_NOTICE_VERSION } });
      return { sharing: true, consentedAt: row.consented_at, notice: SHARE_NOTICE_VERSION };
    });
  });

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
      forgetMovement(req.actor.id);
      throw Forbidden('That delivery is not in progress',
        `An order in "${o.state}" is not being carried anywhere.`);
    }
    const consent = await one(
      `SELECT 1 FROM location_share_consent WHERE order_id = $1 AND partner_id = $2 AND stopped_at IS NULL`, [o.id, req.actor.id]);
    if (!consent) throw new HttpError(403, 'sharing_not_started', 'Tap Start sharing first', 'Your position is only sent after you choose to share it for this delivery.');
    if (o.pickup_lat != null && o.pickup_lng != null &&
        kmBetween({ lat: Number(o.pickup_lat), lng: Number(o.pickup_lng) }, r) > MAX_KM_FROM_PICKUP) {
      throw BadRequest('That position is too far from the café to be this delivery',
        `More than ${MAX_KM_FROM_PICKUP} km from the pickup point.`);
    }

    /* The WHERE is the integrity rule: a replayed or delayed fix cannot move the
       marker backwards. A row for a different order is simply replaced. */
    const stored = await q(
      `INSERT INTO partner_location (partner_id, order_id, lat, lng, accuracy_m, at)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now()))
       ON CONFLICT (partner_id) DO UPDATE SET order_id = $2, lat = $3, lng = $4,
             accuracy_m = $5, at = EXCLUDED.at
       WHERE partner_location.order_id IS DISTINCT FROM EXCLUDED.order_id OR partner_location.at < EXCLUDED.at`,
      [req.actor.id, o.id, r.lat, r.lng, r.accuracy, r.takenAt]);
    if (!stored.rowCount) throw Conflict('That fix is older than the last one', 'It was ignored.');
    noteMovement(req.actor.id, o.id, r);
    await recordPoint(o.id, req.actor.id, r, { log: req.log });
    publishPosition(o.id);
    return { recorded: true };
  });

  /* Leaving a delivery, or going offline, takes the position with it. */
  app.post('/partner/location/clear', async (req) => {
    authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
    const reason = ['partner', 'permission_revoked'].includes(req.body?.reason) ? req.body.reason : 'partner';
    await stopSharing(req.actor.id, reason);
    return { cleared: true };
  });

  /* ---------- what a café may know --------------------------------------
     Status and a first name, for the counter. No position, ever. */
  app.get('/orders/:id/delivery-status', async (req) => {
    const o = await one(
      `SELECT o.id, o.code, o.state, o.fulfilment, o.vendor_id, o.partner_id, COALESCE((SELECT ap.display_name FROM admin_profile ap WHERE ap.user_id = u.id), u.name) AS partner_name
         FROM food_order o LEFT JOIN app_user u ON u.id = o.partner_id WHERE o.id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');
    if (!can(req.actor, 'order.read_all') && !(req.actor?.vendorIds?.includes(o.vendor_id) && can(req.actor, 'order.read', { vendorId: o.vendor_id }))) {
      throw Forbidden('That order is not yours');
    }
    return {
      orderId: o.id, code: o.code, state: o.state, fulfilment: o.fulfilment,
      partnerAssigned: !!o.partner_id,
      partnerFirstName: o.partner_name ? o.partner_name.trim().split(/\s+/)[0] : null,
      deliveryStatus: !o.partner_id ? 'no_partner_yet' : o.state === 'picked_up' ? 'on_the_way' : o.state === 'assigned' ? 'heading_to_cafe' : 'finished',
    };
  });

  /* ---------- what a map may draw ----------------------------------------- */
  app.get('/orders/:id/tracking', async (req) => {
    const o = await one(
      `SELECT o.id, o.state, o.customer_id, o.partner_id, o.fulfilment, o.destination_id,
              o.destination_snapshot, o.spot_lat, o.spot_lng, o.vendor_id, v.name AS vendor_name, v.campus_node_id
         FROM food_order o JOIN vendor v ON v.id = o.vendor_id
        WHERE o.id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');

    const isCustomer = o.customer_id === req.actor?.id;
    const isPartner = o.partner_id === req.actor?.id;
    /* Café staff and order-reading administrators get a coordinate-free answer;
       an exact position needs delivery.track, and looking at one is audited. */
    const isStaff = !!req.actor?.vendorIds?.length && can(req.actor, 'order.read', { vendorId: o.vendor_id });
    const mayTrack = can(req.actor, 'delivery.track');
    if (!isCustomer && !isPartner && !isStaff && !mayTrack && !can(req.actor, 'order.read_all')) {
      throw Forbidden('That order is not yours');
    }
    const seesExact = isCustomer || isPartner || mayTrack;

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
      const show = isPartner || mayTrack ||
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
          if (mayTrack && !isPartner && !isCustomer) await auditPositionView(req, o.id);
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

    /* Google Maps, the walking route and the alerts are for the partner
       carrying the order and for delivery.track staff. Customers keep the
       OpenStreetMap map: no Google map load per order. */
    const working = (isPartner || mayTrack) && carrying;
    const route = working && seesExact
      ? await routeForOrder({ orderId: o.id, state: o.state, partner, pickup, destination }, { log: req.log })
      : null;
    const since = working ? await stateSince(o.id, o.state) : null;

    return {
      orderId: o.id,
      state: o.state,
      fulfilment: o.fulfilment,
      maps: isPartner || mayTrack ? mapsConfig() : { provider: 'osm' },
      route,
      alerts: working && mayTrack
        ? alertsFor({ state: o.state, partner, pickup, destination, stateSince: since,
                      stillSinceMs: stillSince(o.partner_id, o.id), route })
        : [],
      vendorName: o.vendor_name,
      pickup,
      destination: seesExact ? destination : (destination ? { label: destination.label, name: destination.name } : null),
      /* The frozen address, so the partner reads the same words the student
         chose rather than whatever the campus tree says today. */
      address: o.destination_snapshot || null,
      partner,
      /* Why there is no partner marker, when there is not one. Said plainly
         so the screen can explain rather than look broken. */
      partnerVisibility: !o.partner_id ? 'no_partner_yet'
        : !carrying ? 'delivery_over'
        : (isPartner || mayTrack) ? (partner ? 'visible' : 'not_reported_yet')
        : !isCustomer ? 'restricted'
        : VISIBLE_TO_CUSTOMER.includes(o.state) ? (partner ? 'visible' : 'not_reported_yet')
        : 'hidden_until_pickup',
      boundary: boundary ? { name: boundary.name, polygon: boundary.polygon } : null,
      /* A map needs to say when it cannot draw something. */
      note: !pickup && !destination
        ? 'No positions have been recorded for this cafeteria or delivery point yet.'
        : null,
    };
  });

  /* ---------- Campus Control's fleet map ------------------------------------
     One answer for the whole map, delivery.track only (like a single order's
     exact position), every partner position view audited at most once per
     AUDIT_EVERY_MS per order. Partner names need partners.view.

       active    assigned / picked_up: live partner position (if shared and
                 fresh enough), the partner's walking leg, the cafe->drop
                 route, progress along it, alerts
       waiting   confirmed / preparing / ready, no partner yet: pickup, drop,
                 the cafe->drop route
       completed ended in the last COMPLETED_HOURS: pickup, drop and the
                 saved record (last position, trail), never a live marker

     Routes come from routing.js caches: polling this costs no Routes request
     unless a leg changes or a partner leaves the route. */
  const COMPLETED_HOURS = 24;
  const WAITING = ['confirmed', 'preparing', 'ready'];
  const ENDED = ['delivered', 'cancelled', 'refunded'];
  const STAGE = {
    confirmed: 'Waiting for a partner', preparing: 'Waiting for a partner', ready: 'Ready, waiting for a partner',
    assigned: 'Partner heading to the cafe', picked_up: 'Picked up, on the way to the student',
    delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded',
  };
  const ends = (r) => ({
    pickup: point({ name: r.pickup_name || r.vendor_name, lat: r.pickup_lat, lng: r.pickup_lng }, 'pickup'),
    destination: r.dest_lat != null ? point({ name: r.dest_name, lat: r.dest_lat, lng: r.dest_lng }, 'destination')
      : r.spot_lat != null ? point({ name: 'Delivery spot', lat: r.spot_lat, lng: r.spot_lng }, 'destination') : null,
  });
  const FLEET_SQL = (where) => `
    SELECT o.id, o.code, o.state, o.partner_id, o.destination_snapshot, o.spot_lat, o.spot_lng, o.created_at, o.delivered_at,
           v.name AS vendor_name, ${PERSON('u')} AS partner_name,
           pn.name AS pickup_name, pn.lat AS pickup_lat, pn.lng AS pickup_lng,
           dn.name AS dest_name, dn.lat AS dest_lat, dn.lng AS dest_lng,
           pl.lat, pl.lng, pl.accuracy_m, pl.at,
           GREATEST(0, EXTRACT(EPOCH FROM now() - pl.at))::int AS age_seconds,
           (SELECT max(e.at) FROM order_event e WHERE e.order_id = o.id AND e.to_state = o.state) AS state_since,
           (SELECT min(e.at) FROM order_event e WHERE e.order_id = o.id AND e.to_state = 'assigned') AS assigned_at,
           (SELECT min(e.at) FROM order_event e WHERE e.order_id = o.id AND e.to_state = 'picked_up') AS picked_up_at
      FROM food_order o
      JOIN vendor v ON v.id = o.vendor_id
      LEFT JOIN app_user u ON u.id = o.partner_id
      LEFT JOIN campus_node pn ON pn.id = v.campus_node_id
      LEFT JOIN campus_node dn ON dn.id = o.destination_id
      LEFT JOIN partner_location pl ON pl.partner_id = o.partner_id AND pl.order_id = o.id
     WHERE o.fulfilment = 'delivery' AND ${where}
     ORDER BY o.created_at
     LIMIT 100`;

  app.get('/admin/deliveries/fleet', async (req) => {
    authorize(req.actor, 'delivery.track');
    const showNames = can(req.actor, 'partner.read');
    const opts = { log: req.log };
    const [live, waiting, done] = await Promise.all([
      q(FLEET_SQL(`o.state::text = ANY($1::text[]) AND o.partner_id IS NOT NULL`), [CARRYING]),
      q(FLEET_SQL(`o.state::text = ANY($1::text[]) AND o.partner_id IS NULL`), [WAITING]),
      q(FLEET_SQL(`o.state::text = ANY($1::text[]) AND o.partner_id IS NOT NULL
                   AND COALESCE(o.delivered_at, (SELECT max(e.at) FROM order_event e WHERE e.order_id = o.id)) > now() - ($2 || ' hours')::interval`), [ENDED, String(COMPLETED_HOURS)]),
    ]);
    const base = (r, kind) => ({
      kind, orderId: r.id, code: r.code, state: r.state, stage: STAGE[r.state] || r.state, vendorName: r.vendor_name,
      partnerId: r.partner_id, partnerName: showNames ? r.partner_name : null,
      address: r.destination_snapshot || null, ...ends(r),
      createdAt: r.created_at, assignedAt: r.assigned_at, pickedUpAt: r.picked_up_at, stateSince: r.state_since,
    });
    const deliveries = [];
    for (const r of live.rows) {
      const d = base(r, 'active');
      const partner = r.lat == null ? null : { lat: Number(r.lat), lng: Number(r.lng),
        accuracyM: r.accuracy_m == null ? null : Number(r.accuracy_m), at: r.at, ageSeconds: Number(r.age_seconds) };
      if (partner) await auditPositionView(req, r.id);
      d.partner = partner;
      d.route = await routeForOrder({ orderId: r.id, state: r.state, partner, pickup: d.pickup, destination: d.destination }, opts);
      d.cafeRoute = await pairRoute(d.pickup, d.destination, opts);
      /* How far along the cafe->drop route the partner is, once carrying it. */
      if (r.state === 'picked_up' && partner && d.cafeRoute) {
        const m = metresAlong(partner, pairPath(d.pickup, d.destination));
        if (m && m.total > 0) d.progress = { percent: Math.round((100 * m.along) / m.total), metresLeft: Math.round(m.total - m.along) };
      }
      d.alerts = alertsFor({ state: r.state, partner, pickup: d.pickup, destination: d.destination,
        stateSince: r.state_since, stillSinceMs: stillSince(r.partner_id, r.id), route: d.route });
      deliveries.push(d);
    }
    for (const r of waiting.rows) {
      const d = base(r, 'waiting');
      d.cafeRoute = await pairRoute(d.pickup, d.destination, opts);
      d.alerts = [];
      deliveries.push(d);
    }
    const traces = done.rows.length ? (await q(
      `SELECT order_id, final_lat, final_lng, final_at, jsonb_array_length(points) AS points
         FROM delivery_trace WHERE order_id = ANY($1::uuid[])`, [done.rows.map((r) => r.id)])).rows : [];
    for (const r of done.rows) {
      const d = base(r, 'completed');
      const t = traces.find((x) => x.order_id === r.id);
      d.endedAt = r.delivered_at || r.state_since;
      d.record = t ? { finalPosition: t.final_lat == null ? null : { lat: Number(t.final_lat), lng: Number(t.final_lng), at: t.final_at },
                       trailPoints: Number(t.points) } : null;
      d.alerts = [];
      deliveries.push(d);
    }
    return { deliveries, maps: mapsConfig(), completedHours: COMPLETED_HOURS,
             retentionDays: RETENTION.deliveryTraceDays, at: new Date().toISOString() };
  });

  /* A delivery's saved record, for opening a finished one on the map. The
     trail is ECHO ECHO's own recorded data; viewing it is audited. */
  app.get('/admin/deliveries/:id/record', async (req) => {
    authorize(req.actor, 'delivery.track');
    const r = (await q(FLEET_SQL('o.id = $1'), [req.params.id])).rows[0];
    if (!r) throw NotFound('No such delivery');
    const t = await one(`SELECT * FROM delivery_trace WHERE order_id = $1`, [r.id]);
    await audit(req, { action: 'delivery.record.view', resource: 'food_order', resourceId: r.id, outcome: 'ok' });
    return {
      orderId: r.id, code: r.code, state: r.state, stage: STAGE[r.state] || r.state, vendorName: r.vendor_name,
      partnerName: can(req.actor, 'partner.read') ? r.partner_name : null,
      ...ends(r),
      assignedAt: r.assigned_at, pickedUpAt: r.picked_up_at, endedAt: r.delivered_at || (ENDED.includes(r.state) ? r.state_since : null),
      record: t ? {
        trail: (t.points || []).map(([lat, lng, s, acc]) => ({ lat, lng, at: new Date(s * 1000).toISOString(), accuracyM: acc })),
        finalPosition: t.final_lat == null ? null : { lat: t.final_lat, lng: t.final_lng, accuracyM: t.final_accuracy_m, at: t.final_at },
        startedAt: t.started_at, endedAt: t.ended_at, deleteAfter: t.purge_after,
      } : null,
      /* Live position only while it is being carried, never for a finished one. */
      live: CARRYING.includes(r.state) && r.lat != null,
    };
  });
}
