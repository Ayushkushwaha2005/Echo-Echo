/* ==========================================================================
   QUAD — DELIVERY PARTNER

   Joining is a role added to the student's existing account, not a second
   account: user_role holds both `student` and `delivery_partner`. Leaving
   revokes only the partner role and blocks while an active delivery exists.
   Delivery history is never deleted.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { authorize, NotFound, Forbidden, Conflict } from '../auth/rbac.js';
import { acceptOffer } from '../services/delivery.js';
import { issuePickup, issueDelivery, verify } from '../services/handover.js';
import { transition } from './orders.js';
import { flag } from '../services/flags.js';
import { audit } from '../audit.js';
import { notifyAsync } from '../services/notify.js';
import { snapshotFor } from '../services/pricing.js';
import { postDeliveryEarned } from '../services/ledger.js';
import { BadRequest } from '../auth/rbac.js';
import { profileOf, MISSING_COPY } from '../services/profile.js';
import { livePolicy } from './trust.js';

export default async function partnerRoutes(app) {
  /* ---------- join ------------------------------------------------------- */
  app.post('/partner/apply', async (req) => {
    authorize(req.actor, 'partner.apply', { ownerId: req.actor.id });
    if (!(await flag('partner_onboarding'))) {
      throw Conflict('Partner applications are closed at the moment');
    }
    /* The verification ladder: a partner must first be a verified student.
       Clicking Join is an application, never an activation. */
    if (req.actor.studentStatus !== 'approved') {
      throw Forbidden('Verify your student identity first',
        'Delivery partners must hold an approved student verification.');
    }
    const existing = await one(`SELECT * FROM partner_profile WHERE user_id = $1`, [req.actor.id]);
    if (existing && existing.status === 'approved') throw Conflict('You are already a delivery partner');
    if (existing && existing.status === 'pending') throw Conflict('Your application is already under review');

    /* Identification and consent, both checked here rather than trusted from
       the screen that collected them. */
    const profile = await profileOf(req.actor.id);
    if (!profile.complete) {
      throw Forbidden('Complete your profile first',
        `Still needed: ${profile.missing.map((m) => MISSING_COPY[m]).join(', ')}.`);
    }
    const photo = await one(`SELECT partner_photo_asset FROM app_user WHERE id = $1`, [req.actor.id]);
    if (!photo?.partner_photo_asset) {
      throw Conflict('Add a photo of yourself first',
        'Customers see it so they can recognise who is delivering their order.');
    }
    const policy = await livePolicy();
    if (!policy) throw Conflict('Partner applications are closed at the moment', 'No deposit policy is published.');
    if (req.body?.acceptPolicyId !== policy.id) {
      throw BadRequest('Read and accept the delivery partner policy to apply',
        'The policy may have changed since you opened this page. Review it and accept again.');
    }

    const row = await tx(async (c) => {
      await c.query(
        `INSERT INTO partner_policy_consent (user_id, policy_id, ip, user_agent) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, policy_id) DO NOTHING`,
        [req.actor.id, policy.id, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 300)]);
      return (await c.query(
        `INSERT INTO partner_profile (user_id, status, note)
         VALUES ($1,'pending',$2)
         ON CONFLICT (user_id) DO UPDATE SET status='pending', applied_at=now(),
                decided_at=NULL, decided_by=NULL, left_at=NULL, note=$2
         RETURNING *`, [req.actor.id, req.body?.note || null])).rows[0];
    });
    await audit(req, { action: 'partner.apply', resource: 'partner', resourceId: req.actor.id, outcome: 'ok',
                       detail: { policyId: policy.id, depositPaise: policy.amount_paise } });
    return {
      ...row,
      message: policy.amount_paise > 0
        ? `Application submitted. Pay the Rs ${(policy.amount_paise / 100).toFixed(0)} security deposit to campus admin by bank transfer or UPI; you are approved once it is recorded and your application is reviewed.`
        : 'Application submitted. An administrator will review it.',
    };
  });

  /* ---------- leave ------------------------------------------------------ */
  app.post('/partner/leave', async (req) => {
    authorize(req.actor, 'partner.leave', { ownerId: req.actor.id });
    const active = await one(
      `SELECT id, code, state FROM food_order
        WHERE partner_id = $1 AND state IN ('assigned','picked_up') LIMIT 1`, [req.actor.id]);
    if (active) {
      throw Conflict('You have an active delivery',
        `Complete or hand over order ${active.code} before leaving the partner programme.`);
    }
    await tx(async (c) => {
      await c.query(
        `UPDATE partner_profile SET status='left', online=false, left_at=now() WHERE user_id=$1`,
        [req.actor.id]);
      /* Only the partner role goes. The student account is untouched, and
         every past delivery row stays exactly where it is. */
      await c.query(
        `UPDATE user_role SET status='revoked', revoked_at=now()
          WHERE user_id=$1 AND role='delivery_partner'`, [req.actor.id]);
    });
    await audit(req, { action: 'partner.leave', resource: 'partner', resourceId: req.actor.id, outcome: 'ok' });
    return { ok: true, message: 'You have left the delivery partner programme. Your student account is unchanged.' };
  });

  app.post('/partner/online', async (req) => {
    authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
    const p = await one(`SELECT * FROM partner_profile WHERE user_id = $1`, [req.actor.id]);
    if (!p || p.status !== 'approved') throw Forbidden('Your partner account is not approved');
    const row = await one(
      `UPDATE partner_profile SET online = $2 WHERE user_id = $1 RETURNING *`,
      [req.actor.id, !!req.body?.online]);
    return row;
  });

  /* ---------- work ------------------------------------------------------- */
  app.get('/partner/offers', async (req) => {
    authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
    const { rows } = await q(
      `SELECT o.id, o.expires_at, f.code, f.total_paise, f.fulfilment,
              v.name AS vendor_name, d.name AS destination
         FROM delivery_offer o
         JOIN food_order f ON f.id = o.order_id
         JOIN vendor v ON v.id = f.vendor_id
         LEFT JOIN campus_node d ON d.id = f.destination_id
        WHERE o.partner_id = $1 AND o.state='offered' AND o.expires_at > now()
        ORDER BY o.offered_at`, [req.actor.id]);
    return { offers: rows };
  });

  app.post('/partner/offers/:id/accept', async (req) => {
    authorize(req.actor, 'delivery.accept', { ownerId: req.actor.id });
    const out = await acceptOffer(req.params.id, req.actor.id);
    await audit(req, { action: 'delivery.accept', resource: 'order', resourceId: out.orderId, outcome: 'ok' });
    return out;
  });

  /* ---------- handover verification --------------------------------------
     Two codes, two holders, neither of them the delivery partner.

       pickup    the CAFETERIA is shown it. The partner types what the
                 counter reads out, and only then does the order become
                 picked_up. Without this a partner could mark a collection
                 they never made, or collect an order assigned to someone
                 else and have the system record it as theirs.

       delivery  the CUSTOMER is shown it. The partner types what the
                 customer reads out, and only then does the order become
                 delivered — which is also the moment the delivery earning
                 is posted to that partner's ledger balance.

     The issuing routes below authorise the cafeteria and the customer
     respectively. There is no route, for any role, by which a delivery
     partner can read, generate or rotate either code. Verification lives in
     services/handover.js and runs inside the same transaction as the state
     change it authorises. */

  /* The cafeteria's pickup code. Scoped to the vendor that owns the order,
     so one cafeteria cannot read another's. */
  app.get('/orders/:id/pickup-code', async (req) => {
    const o = await one(`SELECT * FROM food_order WHERE id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');
    authorize(req.actor, 'order.transition', { vendorId: o.vendor_id });
    if (o.fulfilment !== 'delivery') {
      throw Conflict('This is a collection order', 'Pickup codes exist for delivery orders only.');
    }
    if (!['ready', 'assigned'].includes(o.state)) {
      throw Conflict(`Order is ${o.state}`,
        'A pickup code appears once the order is ready for collection.');
    }
    /* Rotates rather than refuses: a counter that closed the screen must be
       able to get a working code, and the previous one dies as it does. */
    const issued = await tx((c) => issuePickup(c, o.id, { issuedTo: req.actor.id }));
    await audit(req, { action: 'handover.pickup.issued', resource: 'order', resourceId: o.id,
                       outcome: 'ok', detail: { rotated: issued.rotated } });
    return { code: issued.code, expiresAt: issued.expiresAt,
             message: 'Read this to the delivery partner. It is shown once.' };
  });

  /* The partner confirms collection. This is the ONLY route to picked_up. */
  app.post('/orders/:id/pickup', async (req) => {
    const o = await one(`SELECT * FROM food_order WHERE id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');
    /* 'own' scope against the order's partner_id: a partner cannot confirm a
       collection for an order that is not assigned to them, whatever id they
       put in the URL. */
    authorize(req.actor, 'delivery.handoff', { ownerId: o.partner_id });
    if (o.state !== 'assigned') {
      throw Conflict(`Order is ${o.state}`, 'Only an assigned order can be collected.');
    }

    try {
      await tx(async (c) => {
        await verify(c, o.id, 'pickup', req.body?.code, { verifiedBy: req.actor.id });
        await transition(c, o.id, 'picked_up', req.actor, 'pickup code verified');
      });
    } catch (e) {
      await audit(req, { action: 'handover.pickup', resource: 'order', resourceId: o.id,
                         outcome: 'denied', detail: { reason: e.code || 'error',
                                                      message: e.message } });
      throw e;
    }
    await audit(req, { action: 'handover.pickup', resource: 'order', resourceId: o.id,
                       outcome: 'ok' });
    notifyAsync(o.customer_id, 'order_picked_up',
      { body: `Order ${o.code} has been collected and is on its way.` });
    return { ok: true, state: 'picked_up' };
  });

  /* The customer's delivery code. Only the customer may read it. */
  app.get('/orders/:id/handoff-code', async (req) => {
    const o = await one(`SELECT * FROM food_order WHERE id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');
    if (o.customer_id !== req.actor?.id) throw Forbidden('That order is not yours');
    if (!['assigned', 'picked_up'].includes(o.state)) {
      throw Conflict('A delivery code appears once a partner is on the way');
    }
    const issued = await tx((c) => issueDelivery(c, o.id, { issuedTo: req.actor.id }));
    await audit(req, { action: 'handover.delivery.issued', resource: 'order', resourceId: o.id,
                       outcome: 'ok', detail: { rotated: issued.rotated } });
    return { code: issued.code, expiresAt: issued.expiresAt,
             message: 'Read this to your delivery partner when the food arrives.' };
  });

  /* The partner confirms delivery. This is the ONLY route to delivered for a
     delivery order. */
  app.post('/orders/:id/handoff', async (req) => {
    const o = await one(`SELECT * FROM food_order WHERE id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');
    authorize(req.actor, 'delivery.handoff', { ownerId: o.partner_id });
    if (o.state !== 'picked_up') throw Conflict(`Order is ${o.state}; pick it up first`);

    try {
      await tx(async (c) => {
        await verify(c, o.id, 'delivery', req.body?.code, { verifiedBy: req.actor.id });
        const moved = await transition(c, o.id, 'delivered', req.actor, 'delivery code verified');
        /* The delivery is done, so the earning is earned: it moves from the
           platform's clearing account onto this partner's payable balance,
           in the same transaction that marks the order delivered and
           consumes the code. Idempotent on the order id, so it cannot be
           credited twice. */
        const snap = await snapshotFor(c, o.id);
        if (snap) await postDeliveryEarned(c, { order: moved, snapshot: snap });
      });
    } catch (e) {
      await audit(req, { action: 'handover.delivery', resource: 'order', resourceId: o.id,
                         outcome: 'denied', detail: { reason: e.code || 'error',
                                                      message: e.message } });
      throw e;
    }
    notifyAsync(o.customer_id, 'order_delivered', { body: `Order ${o.code} was delivered.` });
    await audit(req, { action: 'handover.delivery', resource: 'order', resourceId: o.id,
                       outcome: 'ok' });
    return { ok: true, state: 'delivered' };
  });
  /* ---------- earnings ---------------------------------------------------
     Read from the ledger, not from a percentage applied to today's config.
     A delivery completed last month is worth what it was worth then, because
     what it was worth was written into the order's snapshot at the time and
     posted to this partner's account when the handoff happened. */
  app.get('/partner/earnings', async (req) => {
    authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
    const me = req.actor.id;

    const stmt = await one(
      `SELECT * FROM v_partner_statement WHERE partner_id = $1`, [me]);
    const today = await one(
      `SELECT count(*)::int AS deliveries,
              COALESCE(sum(f.delivery_earning_paise),0)::int AS earned_paise
         FROM food_order o
         JOIN order_financials f ON f.order_id = o.id
         JOIN ledger_txn t ON t.order_id = o.id AND t.kind = 'delivery_earned'
        WHERE o.partner_id = $1 AND o.delivered_at >= date_trunc('day', now())`, [me]);
    const payouts = (await q(
      `SELECT id, amount_paise, state, method, external_reference, provider_payout_id,
              created_at, paid_at
         FROM payout WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 50`, [me])).rows;
    const recent = (await q(
      `SELECT o.code, o.delivered_at, f.delivery_earning_paise
         FROM food_order o
         JOIN order_financials f ON f.order_id = o.id
         JOIN ledger_txn t ON t.order_id = o.id AND t.kind = 'delivery_earned'
        WHERE o.partner_id = $1 ORDER BY o.delivered_at DESC LIMIT 20`, [me])).rows;

    return {
      todayDeliveries: today.deliveries,
      todayEarnedPaise: today.earned_paise,
      completedDeliveries: stmt?.completed_deliveries ?? 0,
      totalEarnedPaise: Number(stmt?.total_earned_paise ?? 0),
      pendingPayoutPaise: Number(stmt?.pending_payout_paise ?? 0),
      paidOutPaise: Number(stmt?.paid_out_paise ?? 0),
      deliveries: recent,
      payouts,
    };
  });
}
