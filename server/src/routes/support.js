/* ==========================================================================
   QUAD — SUPPORT, REFUNDS, NOTIFICATIONS

   Refunds are the sensitive part. Only platform roles hold `order.refund`;
   a shopkeeper cannot refund and the AI has no tool that reaches it. The
   refund is executed against the payment provider and the local row only
   reaches 'completed' when the provider confirms — the same rule as
   payment capture, in the opposite direction.
   ========================================================================== */
import { randomBytes } from 'node:crypto';
import { q, one, tx } from '../db/index.js';
import { authorize, can, BadRequest, NotFound, Forbidden, Conflict, ProviderUnavailable } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { PAYMENTS } from '../config.js';
import { transition, TRANSITIONS } from './orders.js';
import { notifyAsync, inbox, markRead, channelStatus } from '../services/notify.js';
import { audit } from '../audit.js';
import { snapshotFor, allocateRefund } from '../services/pricing.js';
import { postRefund } from '../services/ledger.js';
import { adapterFor } from '../services/payment-providers.js';

const code = (p) => p + randomBytes(3).toString('hex').toUpperCase();

export default async function supportRoutes(app) {
  /* ---------- notifications inbox ---------------------------------------- */
  app.get('/notifications', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    return { notifications: await inbox(req.actor.id, { unreadOnly: req.query?.unread === 'true' }),
             channels: channelStatus() };
  });

  app.post('/notifications/read', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    await markRead(req.actor.id, req.body?.id);
    return { ok: true };
  });

  /* ---------- support cases ---------------------------------------------- */
  app.post('/support/cases', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const b = req.body || {};
    if (!b.subject || !b.category) throw BadRequest('A category and a short subject are required');

    /* If an order is named, it must be the caller's own. */
    if (b.orderId) {
      const o = await one(`SELECT customer_id FROM food_order WHERE id = $1`, [b.orderId]);
      if (!o) throw NotFound('No such order');
      if (o.customer_id !== req.actor.id) throw Forbidden('That order is not yours');
    }

    const kase = await tx(async (c) => {
      const k = (await c.query(
        `INSERT INTO support_case (code, user_id, order_id, category, subject)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [code('S'), req.actor.id, b.orderId || null, b.category, String(b.subject).slice(0, 200)])).rows[0];
      if (b.body) {
        await c.query(
          `INSERT INTO support_message (case_id, author_id, author_role, body)
           VALUES ($1,$2,$3,$4)`, [k.id, req.actor.id, req.actor.roles[0], String(b.body).slice(0, 4000)]);
      }
      return k;
    });
    await audit(req, { action: 'support.create', resource: 'support_case', resourceId: kase.id, outcome: 'ok' });
    return kase;
  });

  app.get('/support/cases', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    /* Support staff see the queue; everyone else sees only their own. */
    const staff = can(req.actor, 'support.read');
    const { rows } = await q(
      `SELECT k.*, u.name AS user_name, u.phone AS user_phone, o.code AS order_code
         FROM support_case k
         JOIN app_user u ON u.id = k.user_id
         LEFT JOIN food_order o ON o.id = k.order_id
        WHERE ($1::boolean OR k.user_id = $2)
          AND ($3 = 'all' OR k.state = $3)
        ORDER BY k.updated_at DESC LIMIT 100`,
      [staff, req.actor.id, req.query?.state || 'all']);
    return { cases: rows };
  });

  /* Full context for a support agent: order, payment, delivery, timeline. */
  app.get('/support/cases/:id', async (req) => {
    const k = await one(`SELECT * FROM support_case WHERE id = $1`, [req.params.id]);
    if (!k) throw NotFound('No such case');
    const staff = can(req.actor, 'support.read');
    if (!staff && k.user_id !== req.actor?.id) throw Forbidden('That case is not yours');

    const messages = (await q(
      `SELECT m.*, u.name AS author_name FROM support_message m
         JOIN app_user u ON u.id = m.author_id
        WHERE m.case_id = $1 ORDER BY m.at`, [k.id])).rows;

    let context = null;
    if (k.order_id && staff) {
      const order = await one(
        `SELECT o.*, v.name AS vendor_name, v.contact_phone, d.name AS destination,
                p.name AS partner_name, p.phone AS partner_phone
           FROM food_order o JOIN vendor v ON v.id = o.vendor_id
           LEFT JOIN campus_node d ON d.id = o.destination_id
           LEFT JOIN app_user p ON p.id = o.partner_id
          WHERE o.id = $1`, [k.order_id]);
      const payment = await one(
        `SELECT provider, status, amount_paise, provider_payment_id, created_at, settled_at
           FROM payment WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [k.order_id]);
      const events = (await q(
        `SELECT from_state, to_state, actor_role, note, at FROM order_event
          WHERE order_id = $1 ORDER BY at`, [k.order_id])).rows;
      const items = (await q(`SELECT * FROM order_item WHERE order_id = $1`, [k.order_id])).rows;
      const refunds = (await q(`SELECT * FROM refund WHERE order_id = $1`, [k.order_id])).rows;
      context = { order, payment, events, items, refunds };
    }
    return { case: k, messages, context };
  });

  app.post('/support/cases/:id/messages', async (req) => {
    const k = await one(`SELECT * FROM support_case WHERE id = $1`, [req.params.id]);
    if (!k) throw NotFound('No such case');
    const staff = can(req.actor, 'support.manage');
    if (!staff && k.user_id !== req.actor?.id) throw Forbidden('That case is not yours');
    if (['resolved', 'closed'].includes(k.state) && !staff) throw Conflict('This case is closed');
    if (!req.body?.body) throw BadRequest('Write a message');

    const m = await one(
      `INSERT INTO support_message (case_id, author_id, author_role, body)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [k.id, req.actor.id, req.actor.roles[0], String(req.body.body).slice(0, 4000)]);
    await q(`UPDATE support_case SET updated_at = now(),
                    state = CASE WHEN $2 THEN 'awaiting_customer' ELSE 'open' END
              WHERE id = $1`, [k.id, !!staff]);
    if (staff) notifyAsync(k.user_id, 'support_reply', { body: `Case ${k.code}: ${k.subject}`, data: { caseId: k.id } });
    return m;
  });

  app.post('/support/cases/:id/state', async (req) => {
    authorize(req.actor, 'support.manage');
    const state = req.body?.state;
    if (!['open', 'awaiting_customer', 'resolved', 'closed'].includes(state)) throw BadRequest('Invalid state');
    const k = await one(
      `UPDATE support_case SET state=$2, updated_at=now(), assigned_to=$3,
              resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN now() ELSE NULL END
        WHERE id=$1 RETURNING *`, [req.params.id, state, req.actor.id]);
    if (!k) throw NotFound('No such case');
    await audit(req, { action: 'support.state', resource: 'support_case', resourceId: k.id,
                       outcome: 'ok', detail: { state } });
    return k;
  });

  /* Cafeteria contact — only what an admin has explicitly made public. */
  app.get('/vendors/:id/contact', async (req) => {
    const v = await one(
      `SELECT name, contact_phone, contact_email, contact_public FROM vendor WHERE id = $1`,
      [req.params.id]);
    if (!v) throw NotFound('No such cafeteria');
    if (!v.contact_public) {
      return { name: v.name, available: false,
               message: 'This cafeteria has not published a contact number. Raise a support case instead.' };
    }
    return { name: v.name, available: true, phone: v.contact_phone, email: v.contact_email };
  });

  /* ---------- refunds -----------------------------------------------------
     A refund is three things that must all be true together: money leaves
     the gateway, the ledger gives each party's share back, and the order
     records what happened. None of the three is allowed to happen without
     the other two.

     The guards, in the order they fire:
       - `order.refund` is a platform capability. A shopkeeper cannot refund.
       - an idempotency key makes a retried request return the FIRST refund
         rather than issue a second one.
       - one in-flight refund per payment (partial unique index).
       - the running total of completed refunds may never exceed what was
         captured, checked under a row lock on the payment.
       - the ledger posting is idempotent on the refund id.
     Together, these are why a duplicate refund request cannot double-credit
     anyone, whichever of the two it duplicates.                            */
  app.post('/refunds', async (req) => {
    authorize(req.actor, 'order.refund');          // platform roles only
    assertRecentPasskey(req.actor, 'a refund');
    if (!PAYMENTS.configured) {
      throw ProviderUnavailable('Payment provider not configured',
        'A refund cannot be issued without the gateway that took the payment.');
    }
    const { orderId, reason } = req.body || {};
    if (!reason) throw BadRequest('A refund reason is required');
    const idemKey = req.body?.idempotencyKey ? String(req.body.idempotencyKey).slice(0, 120) : null;

    const order = await one(`SELECT * FROM food_order WHERE id = $1`, [orderId]);
    if (!order) throw NotFound('No such order');

    /* An unpaid cancellation has nothing to refund, and saying so is not an
       error to paper over: no money was ever taken. */
    const pay = await one(
      `SELECT * FROM payment WHERE order_id = $1 AND status IN ('paid','refunded')
        ORDER BY created_at DESC LIMIT 1`, [order.id]);
    if (!pay) throw Conflict('This order has no captured payment to refund',
      'Nothing was collected, so there is nothing to return.');

    const snap = await snapshotFor({ query: q }, order.id);
    if (!snap) throw Conflict('This order has no financial snapshot');

    /* Reserve the refund under a lock, before touching the gateway. The
       reservation is what makes the amount check race-free: a second request
       arriving at the same moment either finds the in-flight row or finds
       the amount already committed against the payment. */
    const reserved = await tx(async (c) => {
      const locked = (await c.query(
        `SELECT * FROM payment WHERE id = $1 FOR UPDATE`, [pay.id])).rows[0];

      if (idemKey) {
        const seen = (await c.query(
          `SELECT * FROM refund WHERE payment_id = $1 AND idempotency_key = $2`,
          [locked.id, idemKey])).rows[0];
        if (seen) return { existing: seen };
      }

      const already = Number((await c.query(
        `SELECT COALESCE(sum(amount_paise),0)::int AS n FROM refund
          WHERE payment_id = $1 AND state IN ('processing','completed')`,
        [locked.id])).rows[0].n);
      const remaining = locked.amount_paise - already;
      if (remaining <= 0) {
        throw Conflict('This payment has already been refunded in full',
          `${(locked.amount_paise / 100).toFixed(2)} was captured and the same has been returned.`);
      }

      const amount = req.body.amountPaise === undefined || req.body.amountPaise === null
        ? remaining : Number(req.body.amountPaise);
      if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
        throw BadRequest(`Refund must be between 1 and ${remaining} paise`,
          already ? `${(already / 100).toFixed(2)} has already been refunded on this payment.`
                  : undefined);
      }

      try {
        const row = (await c.query(
          `INSERT INTO refund (order_id, payment_id, amount_paise, reason, requested_by,
                               state, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,'processing',$6) RETURNING *`,
          [order.id, locked.id, amount, String(reason).slice(0, 400), req.actor.id, idemKey]))
          .rows[0];
        return { refund: row, amount };
      } catch (e) {
        if (e.code === '23505') {
          throw Conflict('A refund on this payment is already being processed',
            'Wait for it to settle before issuing another.');
        }
        throw e;
      }
    });

    /* A retried request carrying the same key: report the original, do
       nothing else. No second gateway call, no second ledger posting. */
    if (reserved.existing) {
      return { id: reserved.existing.id, state: reserved.existing.state,
               amountPaise: reserved.existing.amount_paise, duplicate: true };
    }
    const refund = reserved.refund;
    const amount = reserved.amount;

    /* Through the adapter, so the refund path is as provider-agnostic as
       the capture path. Our refund id is the provider's idempotency key
       either way: a retried HTTP call returns the ORIGINAL refund rather
       than sending the money back twice.

       `settled` distinguishes "the provider has returned the money" from
       "the provider has accepted the instruction". Razorpay's `processed`
       is the former; Cashfree's refunds are asynchronous and usually come
       back PENDING, which is the latter. The refund row records which, and
       does not call an accepted refund a completed one. */
    let out;
    try {
      out = await adapterFor(pay.provider).refund({
        payment: pay, refundId: refund.id, amountPaise: amount,
        reason, orderCode: order.code,
      });
    } catch (e) {
      const err = String(e.message).slice(0, 300);
      await q(`UPDATE refund SET state='failed', error=$2 WHERE id=$1`, [refund.id, err]);
      await audit(req, { action: 'refund.failed', resource: 'order', resourceId: order.id,
                         outcome: 'error', detail: { error: err } });
      throw e;
    }
    const refundState = out.settled ? 'completed' : 'processing';

    /* The gateway has actually returned the money. Now, and only now, the
       ledger gives each party their share of it back. */
    const allocation = await tx(async (c) => {
      const earned = (await c.query(
        `SELECT 1 FROM ledger_txn WHERE kind='delivery_earned' AND order_id=$1`,
        [order.id])).rowCount > 0;
      const cfg = (await c.query(
        `SELECT value #>> '{}' AS v FROM platform_config WHERE key='refund_delivery_policy'`))
        .rows[0];
      const alloc = allocateRefund(snap, amount, {
        deliveryCompleted: earned,
        deliveryPolicy: cfg?.v || 'platform_absorbs',
      });

      await c.query(
        `UPDATE refund SET state=$3, provider_refund_id=$2,
                settled_at = CASE WHEN $3 = 'completed' THEN now() ELSE NULL END
          WHERE id=$1`,
        [refund.id, out.providerRefundId, refundState]);
      await c.query(
        `INSERT INTO refund_allocation (refund_id, order_id, from_cafeteria_paise,
           from_platform_paise, from_delivery_paise, from_tax_paise, total_paise, delivery_policy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [refund.id, order.id, alloc.from_cafeteria_paise, alloc.from_platform_paise,
         alloc.from_delivery_paise, alloc.from_tax_paise, alloc.total_paise, alloc.delivery_policy]);
      await postRefund(c, { order, refund, allocation: alloc, deliveryEarned: earned });

      /* A payment is only 'refunded' once the whole of it has come back; a
         partial refund leaves it 'paid' so the rest can still be returned. */
      const returned = Number((await c.query(
        `SELECT COALESCE(sum(amount_paise),0)::int AS n FROM refund
          WHERE payment_id = $1 AND state = 'completed'`, [pay.id])).rows[0].n);
      if (returned >= pay.amount_paise) {
        await c.query(`UPDATE payment SET status='refunded' WHERE id=$1`, [pay.id]);
        /* The money is already back with the customer, so the order's state
           label must never be able to fail this transaction. If the state
           machine does not allow the move from wherever the order got to,
           the refund is still recorded and the ledger is still correct — the
           order simply keeps its current state, and the event log says why. */
        if (order.state !== 'refunded' && TRANSITIONS.refunded.from.includes(order.state)) {
          await transition(c, order.id, 'refunded', req.actor, `refund: ${reason}`);
        } else if (order.state !== 'refunded') {
          await c.query(
            `INSERT INTO order_event (order_id, from_state, to_state, actor_id, actor_role, note)
             VALUES ($1,$2,$2,$3,'admin',$4)`,
            [order.id, order.state, req.actor.id,
             `fully refunded (order left in ${order.state}): ${reason}`]);
        }
      }
      return alloc;
    });

    notifyAsync(order.customer_id, 'refund_completed',
                { body: `₹${(amount / 100).toFixed(2)} for order ${order.code}.` });
    await audit(req, { action: out.settled ? 'refund.completed' : 'refund.accepted',
                       resource: 'order', resourceId: order.id, outcome: 'ok',
                       detail: { amount_paise: amount, reason, allocation,
                                 provider_status: out.status } });
    return { id: refund.id, state: refundState, amountPaise: amount, allocation,
             providerStatus: out.status };
  });

  app.get('/admin/refunds', async (req) => {
    authorize(req.actor, 'order.refund');
    const { rows } = await q(
      `SELECT r.*, o.code AS order_code, u.name AS requested_by_name
         FROM refund r JOIN food_order o ON o.id = r.order_id
         LEFT JOIN app_user u ON u.id = r.requested_by
        ORDER BY r.created_at DESC LIMIT 100`);
    return { refunds: rows };
  });

  /* ---------- review moderation ------------------------------------------ */
  app.post('/admin/reviews/:id/hide', async (req) => {
    authorize(req.actor, 'review.moderate');
    const r = await one(
      `UPDATE review SET hidden=$2, hidden_by=$3, hidden_reason=$4,
              hidden_at = CASE WHEN $2 THEN now() ELSE NULL END
        WHERE id=$1 RETURNING *`,
      [req.params.id, req.body?.hidden !== false, req.actor.id, req.body?.reason || null]);
    if (!r) throw NotFound('No such review');
    await audit(req, { action: 'review.moderate', resource: 'review', resourceId: r.id,
                       outcome: 'ok', detail: { hidden: r.hidden, reason: r.hidden_reason } });
    return r;
  });
}
