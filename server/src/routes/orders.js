/* ==========================================================================
   QUAD — ORDERS

   The server owns the total. A draft is priced by reading menu_item inside
   the transaction and writing a frozen snapshot into order_item; the client
   never sends a price and any price it does send is ignored.

   An order reaches `confirmed` from exactly one place: the payment webhook
   handler in payments.js, after a signature check. Nothing a browser can
   POST moves an order into a paid state.
   ========================================================================== */
import { randomInt, createHash, randomBytes } from 'node:crypto';
import { q, one, tx } from '../db/index.js';
import { authorize, can, assertMayOrder, BadRequest, NotFound, Forbidden, Conflict } from '../auth/rbac.js';
import { assertDeliverable, pathOf } from '../services/campus.js';
import { validateMobile } from '../services/profile.js';
import { flag } from '../services/flags.js';
import { audit } from '../audit.js';
import { notifyAsync } from '../services/notify.js';
import { assignDelivery } from '../services/delivery.js';
import { livePolicy, quote, writeSnapshot, snapshotFor } from '../services/pricing.js';
import { entriesForOrder, postDeliveryEarned } from '../services/ledger.js';

/* Legal state transitions and who may perform them. An order cannot skip
   from `draft` to `delivered` however the request is shaped. */
export const TRANSITIONS = {
  awaiting_payment: { from: ['draft'], by: ['system'] },
  confirmed:  { from: ['awaiting_payment'], by: ['system'] },      // webhook only
  preparing:  { from: ['confirmed'], by: ['vendor'] },
  ready:      { from: ['preparing'], by: ['vendor'] },
  assigned:   { from: ['ready'], by: ['system'] },
  picked_up:  { from: ['assigned'], by: ['partner'] },
  delivered:  { from: ['picked_up', 'ready'], by: ['partner', 'vendor'] },
  cancelled:  { from: ['draft', 'awaiting_payment', 'confirmed', 'preparing'], by: ['customer', 'vendor', 'admin'] },
  /* A refund can follow an order at any point after it was paid for,
     including after it was delivered — "the food was cold" is the most
     common refund there is, and it happens once the order is complete. */
  refunded:   { from: ['cancelled', 'confirmed', 'preparing', 'ready',
                       'assigned', 'picked_up', 'delivered'], by: ['admin'] },
};

export async function transition(c, orderId, to, actor, note) {
  const o = (await c.query(`SELECT * FROM food_order WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
  if (!o) throw NotFound('No such order');
  const rule = TRANSITIONS[to];
  if (!rule) throw BadRequest(`Unknown order state "${to}"`);
  if (!rule.from.includes(o.state)) {
    throw Conflict(`An order cannot go from ${o.state} to ${to}`,
      `Allowed predecessors: ${rule.from.join(', ')}.`);
  }
  await c.query(`UPDATE food_order SET state = $2
                   ${to === 'confirmed' ? ', confirmed_at = now()' : ''}
                   ${to === 'delivered' ? ', delivered_at = now()' : ''}
                 WHERE id = $1`, [orderId, to]);
  await c.query(
    `INSERT INTO order_event (order_id, from_state, to_state, actor_id, actor_role, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [orderId, o.state, to, actor?.id || null, actor?.roles?.[0] || 'system', note || null]);
  return { ...o, state: to };
}

const code6 = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const sha = (s) => createHash('sha256').update(s).digest('hex');

/* ---------- draft pricing -------------------------------------------------
   Shared by the checkout route and the AI's create_order_draft tool, so both
   get identical, server-computed numbers.                                  */
export async function buildDraft(c, { customerId, vendorId, lines, fulfilment, destinationId,
                                      contactPhone, landmark, instructions, placedVia }) {
  if (!Array.isArray(lines) || !lines.length) throw BadRequest('Your order is empty');

  /* ---- the delivery contact number -----------------------------------
     Collected at checkout and nowhere else. It is not an identity and it
     never opens a session: it is the number the partner rings from the
     door, and the number the payment gateway wants on a receipt.

     A number given on a previous order is reused, so it is typed once
     rather than at every checkout - but an order with no number anywhere is
     refused, not stored blank. Whatever is used is validated as a real
     Indian mobile number. */
  const remembered = (await c.query(
    `SELECT contact_phone, phone FROM app_user WHERE id = $1`, [customerId])).rows[0];
  const given = contactPhone ?? remembered?.contact_phone ?? remembered?.phone ?? null;
  if (!given) {
    throw BadRequest('Add a delivery contact number',
      'Your delivery partner needs a number to reach you on when they arrive.');
  }
  const phone = validateMobile(given);

  const v = (await c.query(`SELECT * FROM vendor WHERE id = $1`, [vendorId])).rows[0];
  if (!v || !v.active) throw NotFound('No such cafeteria');
  if (!v.is_open || !v.accepting) throw Conflict(`${v.name} is not accepting orders right now`);

  /* ---- the campus gate ------------------------------------------------
     Read from the database for both sides: the customer's selected campus
     and the outlet's campus. An order can only come from an outlet on the
     customer's own campus, and only while that campus is in service. The
     AI assistant builds drafts through this same function. */
  const campus = (await c.query(
    `SELECT u.campus_site_id AS customer_campus, cs.service_status, cs.name
       FROM app_user u LEFT JOIN campus_site cs ON cs.id = u.campus_site_id
      WHERE u.id = $1`, [customerId])).rows[0];
  if (!campus?.customer_campus) {
    throw Forbidden('Select your campus first', 'Choose your campus in your profile before ordering.');
  }
  if (campus.service_status !== 'active') {
    throw Forbidden(`ECHO ECHO is not available at ${campus.name} yet`,
      'Ordering opens when service starts on your campus.');
  }
  if (v.campus_site_id !== campus.customer_campus) {
    throw Forbidden(`${v.name} is not on your campus`,
      'You can only order from cafeterias on the campus in your profile.');
  }

  /* The complete destination, frozen onto the order. destination_id stays
     the only thing the boundary gate trusts; this snapshot is what the
     delivery partner reads at the door, and it must not change when a
     building is renamed or a floor is archived next term. */
  let snapshot = null;
  if (fulfilment === 'delivery') {
    if (!(await flag('delivery'))) throw Conflict('Delivery is currently disabled');
    if (!v.delivery_enabled) throw Conflict(`${v.name} does not deliver`);
    const node = await assertDeliverable(destinationId, { campusId: v.campus_site_id });   // the campus boundary gate
    const trail = await pathOf(node.id);
    snapshot = {
      destinationId: node.id,
      campus: campus.name,
      /* campus → zone → building → floor → room, exactly as configured. */
      path: trail.map((n) => n.name),
      label: trail.map((n) => n.name).join(' — '),
      name: node.name,
      kind: node.kind,
      detail: node.detail || null,
      instructions: node.instructions || null,
      lat: node.lat, lng: node.lng,
      frozenAt: new Date().toISOString(),
    };
  } else if (fulfilment !== 'pickup') {
    throw BadRequest('Choose pickup or delivery');
  }

  /* Free text the student adds to the configured destination. It refines a
     confirmed campus location; it can never replace one, so there is still
     no way to express an off-campus address. */
  const clean = (v2, max) => {
    const t = String(v2 ?? '').trim().replace(/\s+/g, ' ');
    return t ? t.slice(0, max) : null;
  };
  const landmarkText = fulfilment === 'delivery' ? clean(landmark, 120) : null;
  const instructionsText = fulfilment === 'delivery' ? clean(instructions, 300) : null;

  let subtotal = 0;
  const priced = [];
  for (const l of lines) {
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw BadRequest('Invalid quantity');
    const item = (await c.query(
      `SELECT * FROM menu_item WHERE id = $1 AND vendor_id = $2`, [l.itemId, vendorId])).rows[0];
    if (!item || !item.active) throw NotFound(`That item is no longer on the menu`);
    if (!item.available) throw Conflict(`${item.name} is unavailable right now`);
    /* Price is read here. Anything the caller sent is discarded. */
    const line = item.price_paise * qty;
    subtotal += line;
    priced.push({ itemId: item.id, name: item.name, unit: item.price_paise, qty, line });
  }

  /* ---- the money ------------------------------------------------------
     The commercial terms in force are read here, ONCE, and pinned to the
     order. Every downstream number — what the customer pays, what the
     cafeteria is owed, what the partner earns, what Quad keeps — comes from
     this one quote, is written into an immutable snapshot below, and is
     never recomputed from configuration that may have changed since.

     Note what is NOT read: anything in the request. A client sending
     commission=0, platform_fee=0, delivery_earning=1000 changes nothing,
     because none of those words appear in the input to quote(). */
  const policy = await livePolicy(c, vendorId);
  const money = quote(policy, { subtotalPaise: subtotal, fulfilment });

  const order = (await c.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, destination_id,
                             state, subtotal_paise, delivery_paise, total_paise, placed_via,
                             delivery_contact_phone, delivery_landmark, delivery_instructions,
                             destination_snapshot)
     VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [randomBytes(4).toString('hex').toUpperCase(), customerId, vendorId, fulfilment,
     fulfilment === 'delivery' ? destinationId : null,
     subtotal, money.delivery_fee_paise, money.customer_total_paise, placedVia || 'web',
     phone, landmarkText, instructionsText,
     snapshot ? JSON.stringify(snapshot) : null])).rows[0];

  /* Remember it for next time, so the number is typed once rather than at
     every checkout. Still not an identity: nothing signs in with it. */
  await c.query(`UPDATE app_user SET contact_phone = $2, profile_updated_at = now()
                  WHERE id = $1 AND (contact_phone IS DISTINCT FROM $2)`, [customerId, phone]);

  /* Immutable from the moment it is written. The table's CHECK constraints
     re-prove the allocation identity, and its trigger refuses every later
     UPDATE, so an order's financial history cannot be rewritten. */
  const financials = await writeSnapshot(c, order.id, policy.id, money);

  for (const p of priced) {
    await c.query(
      `INSERT INTO order_item (order_id, item_id, name_snapshot, unit_paise_snapshot, qty, line_paise)
       VALUES ($1,$2,$3,$4,$5,$6)`, [order.id, p.itemId, p.name, p.unit, p.qty, p.line]);
  }
  await c.query(`INSERT INTO order_event (order_id, to_state, actor_id, note)
                 VALUES ($1,'draft',$2,'draft created')`, [order.id, customerId]);
  return { ...order, items: priced, financials };
}

export default async function orderRoutes(app) {
  app.post('/orders/draft', async (req) => {
    authorize(req.actor, 'order.create');
    /* Holding the capability is not the same as being allowed to use it.
       See assertMayOrder(): active account, approved student verification,
       both read from the session's database row on this request. */
    assertMayOrder(req.actor, { liveLocationRequired: await flag('live_location') });
    const b = req.body || {};
    const draft = await tx((c) => buildDraft(c, {
      customerId: req.actor.id, vendorId: b.vendorId, lines: b.lines,
      fulfilment: b.fulfilment, destinationId: b.destinationId,
      contactPhone: b.contactPhone, landmark: b.landmark, instructions: b.instructions,
      placedVia: 'web',
    }));
    await audit(req, { action: 'order.draft', resource: 'order', resourceId: draft.id, outcome: 'ok' });
    return draft;
  });

  app.get('/orders', async (req) => {
    const scope = req.query?.scope || 'own';
    let sql, params;
    if (scope === 'own') {
      authorize(req.actor, 'order.read', { ownerId: req.actor.id });
      sql = `WHERE o.customer_id = $1`; params = [req.actor.id];
    } else if (scope === 'vendor') {
      const vendorId = req.query.vendorId;
      authorize(req.actor, 'order.read', { vendorId });
      sql = `WHERE o.vendor_id = $1`; params = [vendorId];
    } else if (scope === 'partner') {
      authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
      sql = `WHERE o.partner_id = $1`; params = [req.actor.id];
    } else {
      authorize(req.actor, 'order.read_all');
      sql = ``; params = [];
    }
    const { rows } = await q(
      `SELECT o.*, v.name AS vendor_name,
              (SELECT json_agg(json_build_object('name', oi.name_snapshot,
                 'qty', oi.qty, 'unit_paise', oi.unit_paise_snapshot, 'id', oi.id))
                 FROM order_item oi WHERE oi.order_id = o.id) AS items,
              EXISTS (SELECT 1 FROM review r WHERE r.order_id = o.id AND r.vendor_id IS NOT NULL) AS reviewed_vendor,
              EXISTS (SELECT 1 FROM review r WHERE r.order_id = o.id AND r.partner_id IS NOT NULL) AS reviewed_delivery
         FROM food_order o JOIN vendor v ON v.id = o.vendor_id
         ${sql} ORDER BY o.created_at DESC LIMIT 100`, params);
    return { orders: rows };
  });

  app.get('/orders/:id', async (req) => {
    const o = await one(`SELECT * FROM food_order WHERE id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');
    /* Whichever relationship the caller has to this order, one of these
       must authorise them; otherwise it is not theirs to read. */
    const allowed =
      (o.customer_id === req.actor?.id) ||
      (o.partner_id === req.actor?.id) ||
      req.actor?.vendorIds.includes(o.vendor_id) ||
      can(req.actor, 'order.read_all');
    if (!allowed) throw Forbidden('That order is not yours');

    const items = (await q(`SELECT * FROM order_item WHERE order_id = $1`, [o.id])).rows;
    const events = (await q(
      `SELECT e.*, u.name AS actor_name FROM order_event e
         LEFT JOIN app_user u ON u.id = e.actor_id
        WHERE e.order_id = $1 ORDER BY e.at`, [o.id])).rows;
    const payment = await one(
      `SELECT provider, status, amount_paise, created_at, settled_at
         FROM payment WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [o.id]);
    /* The frozen snapshot, and — for anyone allowed to audit an order — the
       ledger entries it produced. A customer sees the breakdown of what they
       paid; only a platform role sees where it was allocated. */
    const financials = await snapshotFor({ query: q }, o.id);
    const canAudit = can(req.actor, 'finance.read_all') || can(req.actor, 'order.inspect');

    /* ---- who sees which numbers ---------------------------------------
       The snapshot holds the whole allocation: what the cafeteria is owed,
       what the partner earns, what ECHO ECHO keeps. Only someone auditing
       the order needs all of it.

       A customer sees what they were charged and what it was made up of.
       A delivery partner sees what THEY earn and nothing else about the
       split - not the cafeteria's share, not the platform's. Neither is a
       secret being kept from them; it is simply not their side of the
       transaction, and putting it on screen invites an argument about a
       number that is not theirs to negotiate. */
    const isPartner = o.partner_id === req.actor?.id;
    const isCustomer = o.customer_id === req.actor?.id;
    const shapeMoney = (f) => {
      if (!f) return null;
      if (canAudit) return f;
      if (isCustomer) {
        return {
          order_id: f.order_id,
          food_subtotal_paise: f.food_subtotal_paise,
          discount_paise: f.discount_paise,
          tax_paise: f.tax_paise,
          delivery_fee_paise: f.delivery_fee_paise,
          platform_fee_paise: f.platform_fee_paise,
          customer_total_paise: f.customer_total_paise,
        };
      }
      if (isPartner) {
        return { order_id: f.order_id, delivery_earning_paise: f.delivery_earning_paise };
      }
      /* Cafeteria staff: what this order is worth to the cafeteria. */
      return {
        order_id: f.order_id,
        food_subtotal_paise: f.food_subtotal_paise,
        commission_paise: f.commission_paise,
        cafeteria_payable_paise: f.cafeteria_payable_paise,
        customer_total_paise: f.customer_total_paise,
      };
    };

    /* Who is bringing it: enough to recognise them at the door - first name,
       photo, delivery rating - and nothing else. No phone, no email, no
       surname, no account id. */
    let partner = null;
    if (o.partner_id && ['assigned', 'picked_up', 'delivered'].includes(o.state)) {
      const p = await one(
        `SELECT u.name, u.partner_photo_asset IS NOT NULL AS has_photo,
                (SELECT round(avg(stars)::numeric, 1)::float FROM review r WHERE r.partner_id = u.id AND NOT r.hidden) AS avg,
                (SELECT count(*)::int FROM review r WHERE r.partner_id = u.id AND NOT r.hidden) AS n
           FROM app_user u WHERE u.id = $1`, [o.partner_id]);
      partner = {
        firstName: String(p?.name || '').trim().split(/\s+/)[0] || 'Your partner',
        photoUrl: p?.has_photo ? `/orders/${o.id}/partner-photo` : null,
        rating: p?.n ? { average: p.avg, count: p.n } : null,
        verifiedStudent: true,
      };
    }
    /* The customer's own reviews on this order, so the screen can show what
       is already rated. */
    const myReviews = o.customer_id === req.actor?.id ? (await q(
      `SELECT id, stars, body, created_at, order_item_id,
              CASE WHEN partner_id IS NOT NULL THEN 'delivery' WHEN vendor_id IS NOT NULL THEN 'vendor' ELSE 'item' END AS target
         FROM review WHERE order_id = $1 AND user_id = $2`, [o.id, req.actor.id])).rows : undefined;

    /* A customer sees the order's history, not the full names and account ids
       of the staff and partner who moved it. */
    const customerView = o.customer_id === req.actor?.id && !canAudit;
    const shaped = o;
    const shownEvents = customerView
      ? events.map(({ actor_id, actor_name, ...e }) => e) : events;
    return {
      order: shaped, items, events: shownEvents, payment,
      financials: shapeMoney(financials), partner, myReviews,
      /* What the partner is paid for bringing this order, stated plainly and
         computed by the server from the policy pinned to the order. */
      earning: isPartner && financials
        ? { paise: financials.delivery_earning_paise,
            note: 'Paid to you when the delivery is confirmed with the customer\'s code.' }
        : undefined,
      ledger: canAudit ? await entriesForOrder(q, o.id) : undefined,
    };
  });

  /* Vendor-side progression. */
  app.post('/orders/:id/transition', async (req) => {
    const o = await one(`SELECT * FROM food_order WHERE id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');
    const to = req.body?.to;
    let forcedDelivery = null;
    if (['confirmed', 'awaiting_payment'].includes(to)) {
      throw Forbidden('Payment states are set by the payment gateway',
        'An order becomes confirmed only via a verified webhook.');
    }
    /* ---- the two states this endpoint may NOT reach --------------------
       A physical handover is proven by a code held by someone other than
       the delivery partner (services/handover.js), and this generic
       endpoint has no code to check. Letting it move an order to picked_up
       or delivered would be a way around that proof — and it was: a
       cafeteria holds `order.transition` over its own orders, so before
       this guard it could mark a delivery order DELIVERED while the food
       was still in a partner's bag, posting the delivery earning with no
       customer verification at all.

       Collection orders are the deliberate exception. A pickup order has no
       partner and no delivery leg; the counter handing a bag to the student
       in front of them IS the handover, and `ready → delivered` by the
       vendor is how it is recorded. */
    if (to === 'picked_up') {
      throw Forbidden('A collection must be confirmed with the cafeteria pickup code',
        'POST /orders/:id/pickup with the code the counter reads out. There is no ' +
        'path to picked_up that skips it.');
    }
    if (to === 'delivered' && o.fulfilment === 'delivery') {
      /* Support's unresolved-delivery workflow. A customer who cannot
         produce their code — flat battery, wrong person at the door — is
         NOT a reason to let the partner self-certify; it is a reason for a
         human at the platform to look and decide. So the override exists,
         it is restricted to platform staff, it demands a written reason,
         and it is recorded as an override rather than as a delivery. */
      const isPlatform = can(req.actor, 'order.override');
      const reason = String(req.body?.note || '').trim();
      if (!isPlatform) {
        throw Forbidden("A delivery must be confirmed with the customer's code",
          'POST /orders/:id/handoff with the code the customer reads out. If the ' +
          'customer cannot produce one, the delivery stays open for support to resolve.');
      }
      if (reason.length < 10) {
        throw BadRequest('An administrative delivery override needs a reason',
          'Say what happened, in at least ten characters. It is written to the audit log ' +
          'and to the order history.');
      }
      forcedDelivery = reason;
    }
    if (to === 'cancelled' && o.customer_id === req.actor.id) {
      authorize(req.actor, 'order.cancel', { ownerId: o.customer_id });
    } else {
      authorize(req.actor, 'order.transition', { vendorId: o.vendor_id });
    }

    const out = await tx(async (c) => {
      const moved = await transition(c, o.id, to, req.actor,
        forcedDelivery ? `ADMIN OVERRIDE (no customer code): ${forcedDelivery}` : req.body?.note);
      /* A completed delivery is when the partner has actually earned the
         delivery money, so it moves from the platform's clearing account
         onto their payable balance. Same transaction as the state change:
         there is no window in which an order is delivered but unpaid for. */
      if (to === 'delivered' && moved.partner_id) {
        const snap = await snapshotFor(c, o.id);
        if (snap) await postDeliveryEarned(c, { order: moved, snapshot: snap });
      }
      return moved;
    });
    await audit(req, {
      action: forcedDelivery ? 'delivery.force_complete' : 'order.transition',
      resource: 'order', resourceId: o.id, outcome: 'ok',
      detail: { from: o.state, to, ...(forcedDelivery ? { override_reason: forcedDelivery } : {}) } });

    /* Ready is the moment a delivery order goes looking for a partner. */
    if (to === 'ready') {
      notifyAsync(o.customer_id, 'order_ready',
        { body: o.fulfilment === 'pickup'
            ? `Order ${o.code} is ready for collection.`
            : `Order ${o.code} is ready and waiting for a delivery partner.` });
      if (o.fulfilment === 'delivery') {
        assignDelivery(o.id).catch((e) => req.log.error({ e }, 'assignment failed'));
      }
    }
    if (to === 'cancelled') {
      notifyAsync(o.customer_id, 'order_cancelled', { body: `Order ${o.code} was cancelled.` });
    }
    return out;
  });

  /* ---------- reviews ----------------------------------------------------
     The FK to order_item is what makes "review food you never ordered"
     impossible; these checks give a readable error before the FK fires. */
  app.post('/reviews', async (req) => {
    authorize(req.actor, 'review.create', { ownerId: req.actor.id });
    const b = req.body || {};
    const o = await one(`SELECT * FROM food_order WHERE id = $1`, [b.orderId]);
    if (!o) throw NotFound('No such order');
    if (o.customer_id !== req.actor.id) throw Forbidden('That order is not yours');
    if (o.state !== 'delivered') throw Conflict('You can review once the order is delivered');
    const stars = Number(b.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw BadRequest('Rate between 1 and 5');
    const body = b.body == null ? null : (String(b.body).trim().slice(0, 1000) || null);
    b.body = body;

    let row;
    if (b.target === 'delivery') {
      /* The delivery experience. Only for an order that was actually brought
         by a partner, and never by that partner about themselves. */
      if (o.fulfilment !== 'delivery' || !o.partner_id) {
        throw BadRequest('This order was not delivered by a partner');
      }
      if (o.partner_id === req.actor.id) throw Forbidden('You cannot review your own delivery');
      row = await one(
        `INSERT INTO review (user_id, order_id, partner_id, stars, body)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (order_id) WHERE partner_id IS NOT NULL DO NOTHING RETURNING *`,
        [req.actor.id, o.id, o.partner_id, stars, body]);
      if (!row) throw Conflict('You have already reviewed this delivery');
    } else if (b.orderItemId) {
      const li = await one(`SELECT * FROM order_item WHERE id = $1 AND order_id = $2`,
                           [b.orderItemId, o.id]);
      if (!li) throw BadRequest('That item is not on this order');
      row = await one(
        `INSERT INTO review (user_id, order_id, order_item_id, item_id, stars, body)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (order_item_id) WHERE item_id IS NOT NULL DO NOTHING RETURNING *`,
        [req.actor.id, o.id, li.id, li.item_id, stars, b.body || null]);
      if (!row) throw Conflict('You have already reviewed this item on this order');
    } else {
      row = await one(
        `INSERT INTO review (user_id, order_id, vendor_id, stars, body)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (order_id) WHERE vendor_id IS NOT NULL DO NOTHING RETURNING *`,
        [req.actor.id, o.id, o.vendor_id, stars, b.body || null]);
      if (!row) throw Conflict('You have already reviewed this order');
    }
    await audit(req, { action: 'review.create', resource: 'review', resourceId: row.id, outcome: 'ok',
                       detail: { target: b.target || (b.orderItemId ? 'item' : 'vendor') } });
    /* The partner's identity is not returned to the customer. */
    const { partner_id, ...shown } = row;
    return shown;
  });

  /* Public cafeteria/item reviews. Hidden reviews are excluded, and the
     author is shown by first name only. Delivery reviews are never listed
     publicly - customers see a partner's aggregate rating on their order. */
  app.get('/reviews', async (req) => {
    const { itemId, vendorId } = req.query || {};
    if (!itemId && !vendorId) throw BadRequest('Specify itemId or vendorId');
    const { rows } = await q(
      `SELECT r.id, r.stars, r.body, r.created_at,
              split_part(coalesce(nullif(trim(u.name), ''), 'Student'), ' ', 1) AS author
         FROM review r JOIN app_user u ON u.id = r.user_id
        WHERE NOT r.hidden
          AND ($1::uuid IS NULL OR r.item_id = $1)
          AND ($2::uuid IS NULL OR r.vendor_id = $2)
        ORDER BY r.created_at DESC LIMIT 30`, [itemId || null, vendorId || null]);
    return { reviews: rows };
  });
}

export { code6, sha };
