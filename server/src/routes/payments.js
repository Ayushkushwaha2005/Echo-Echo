/* ==========================================================================
   QUAD — PAYMENTS

   There is no cash on delivery in this product, and there is no route by
   which a browser can report a successful payment. The sequence is:

     draft → POST /payments/intent → gateway order created, state
     awaiting_payment → user pays in the gateway's checkout → the gateway
     POSTs /payments/webhook → signature verified against the shared secret
     → payment marked paid → order transitions to confirmed.

   ── Two authoritative paths, one decision function ───────────────────────

   The webhook is the primary path. It is not the only one, because a
   webhook can be delayed, dropped, or blocked by a network nobody controls,
   and an order stuck in `awaiting_payment` while the customer's money is
   gone is a real failure even though it is a safe one.

   So GET /payments/status, which the browser calls on its return from
   checkout, also PULLS the status from the provider's API. That is a second
   authoritative source — the provider's own answer to "do you hold this
   money" — and it is emphatically NOT the browser's claim. The browser
   supplies one thing: an order id it already owns. Everything else is
   fetched server-side over an authenticated connection to the gateway.

   Both paths funnel into `applyOutcome()` below, which is the single place
   that can move a payment to `paid`. Every check — amount equality against
   the frozen snapshot, currency, order mapping, idempotency, order state —
   is applied identically no matter which path arrived first, because a
   check that only one path performs is a check an attacker gets to choose
   to avoid.

   ── What the browser cannot do ───────────────────────────────────────────

   Press back, close the checkout, edit JavaScript, forge a callback, replay
   a success, change the amount, change the order id, or call a
   "payment succeeded" endpoint: there isn't one. The only inputs a client
   contributes anywhere in this file are an orderId it must already own and
   a signed request body it cannot forge.

   Duplicate webhook deliveries are absorbed by the primary key on
   payment_webhook (provider, event_id). Duplicate CONFIRMATIONS are
   absorbed by the payment's own status check under a row lock, so the two
   paths racing each other produce one confirmation, not two.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { PAYMENTS } from '../config.js';
import { authorize, assertMayOrder, NotFound, Forbidden, Conflict, ProviderUnavailable } from '../auth/rbac.js';
import { transition } from './orders.js';
import { assignDelivery } from '../services/delivery.js';
import { flag } from '../services/flags.js';
import { audit } from '../audit.js';
import { notifyAsync } from '../services/notify.js';
import { snapshotFor } from '../services/pricing.js';
import { postOrderCapture } from '../services/ledger.js';
import { requireAdapter } from '../services/payment-providers.js';

const rupees = (paise) => (paise / 100).toFixed(2);

/* ==========================================================================
   applyOutcome — the ONLY function that can mark a payment paid.

   `ev` is a normalised provider outcome (services/payment-providers.js).
   `source` is 'webhook' or 'status_pull', recorded so an auditor can tell
   which authoritative source confirmed an order.

   Returns a small result object rather than throwing, because both callers
   must answer the provider or the browser politely even when refusing:
   a webhook that 500s gets retried forever, and a status poll that throws
   tells a customer their paid order is broken when it is merely flagged.
   ========================================================================== */
async function applyOutcome(req, pay, ev, source) {
  /* ---- 1. order mapping ------------------------------------------------
     The event must be about the payment we looked up. The caller found
     `pay` BY the provider order id, so this is belt-and-braces against a
     future caller finding it some other way — the check costs nothing and
     the failure it prevents is confirming order A with order B's money. */
  if (ev.providerOrderId && pay.provider_order_id &&
      ev.providerOrderId !== pay.provider_order_id) {
    return { ok: true, ignored: 'order mismatch' };
  }

  /* ---- 2. already decided ---------------------------------------------- */
  if (pay.status === 'paid' || pay.status === 'refunded') {
    return { ok: true, duplicate: true, alreadyPaid: true };
  }
  if (pay.flagged_reason) {
    return { ok: true, rejected: 'payment is flagged for investigation' };
  }

  if (ev.outcome !== 'paid') {
    /* Not paid. `dropped` (the customer closed the checkout) and `pending`
       are NOT failures to record as such: a dropped attempt may be retried
       and a pending one may still succeed, so neither may destroy a payment
       row that a later success needs. Only an actual failure is recorded. */
    if (ev.outcome === 'failed') {
      await q(`UPDATE payment SET status='failed' WHERE id=$1 AND status='pending'`, [pay.id]);
      await audit(req, { action: 'payment.failed', resource: 'order', resourceId: pay.order_id,
                         outcome: 'ok', detail: { source } });
      const bad = await one(`SELECT customer_id, code FROM food_order WHERE id=$1`, [pay.order_id]);
      if (bad) {
        notifyAsync(bad.customer_id, 'payment_failed',
          { body: `Payment for order ${bad.code} did not go through. The order was not placed.` });
      }
      return { ok: true, outcome: 'failed' };
    }
    return { ok: true, outcome: ev.outcome };
  }

  /* ---- 3. the money must be the money ----------------------------------
     `pay.amount_paise` was pinned from the order's immutable financial
     snapshot when the intent was created. The provider's figure must equal
     it exactly. Not "at least" — exactly: an overpayment is as much a
     reconciliation failure as an underpayment, and neither is something to
     resolve by guessing.

     A null amount (unparseable, missing, or more precision than paise) also
     lands here, because null !== an integer. That is the fail-closed
     direction on purpose. */
  const amountOk = Number.isInteger(ev.amountPaise) && ev.amountPaise === pay.amount_paise;
  const currencyOk = !ev.currency || ev.currency === PAYMENTS.currency;

  if (!amountOk || !currencyOk) {
    const reason = !amountOk
      ? `amount_mismatch expected=${pay.amount_paise} got=${ev.amountPaise}`
      : `currency_mismatch expected=${PAYMENTS.currency} got=${ev.currency}`;
    /* Flagged, not merely refused. The payment is frozen out of every
       settlement path by the CHECK constraint in migration 008, and the
       discrepancy becomes a durable fact somebody can investigate rather
       than a line in yesterday's logs. */
    await q(`UPDATE payment SET status='failed', flagged_reason=$2, flagged_at=now(),
                    provider_payment_id = COALESCE(provider_payment_id, $3)
              WHERE id=$1`,
            [pay.id, reason.slice(0, 300), ev.providerPaymentId]);
    await audit(req, { action: 'payment.flagged', resource: 'payment', resourceId: pay.id,
                       outcome: 'denied',
                       detail: { reason, source, order_id: pay.order_id,
                                 expected_paise: pay.amount_paise, got_paise: ev.amountPaise } });
    return { ok: true, rejected: amountOk ? 'currency mismatch' : 'amount mismatch' };
  }

  /* ---- 4. confirm, transactionally -------------------------------------
     The state change, the payment row and the ledger allocation are one
     transaction. A confirmed order without ledger entries is not a state
     this database can be in. */
  let confirmed = false;
  await tx(async (c) => {
    /* Re-read under a row lock. This is what makes the webhook and the
       status pull safe to race: whichever gets the lock first confirms, and
       the other finds a row that is no longer `pending` and does nothing. */
    const locked = (await c.query(
      `SELECT * FROM payment WHERE id=$1 FOR UPDATE`, [pay.id])).rows[0];
    if (!locked || locked.status === 'paid' || locked.status === 'refunded') return;
    if (locked.flagged_reason) return;

    const order = (await c.query(
      `SELECT state FROM food_order WHERE id=$1`, [locked.order_id])).rows[0];
    /* A cancelled or already-confirmed order is not advanced by a late
       success. The money is real, so the payment row records it and the
       discrepancy is flagged for a human — silently confirming an order the
       customer cancelled is worse than an alert. */
    if (!order || order.state !== 'awaiting_payment') {
      await c.query(
        `UPDATE payment SET status='failed', flagged_reason=$2, flagged_at=now(),
                provider_payment_id=$3 WHERE id=$1`,
        [locked.id, `paid_but_order_state=${order?.state ?? 'missing'}`, ev.providerPaymentId]);
      return;
    }

    await c.query(
      `UPDATE payment SET status='paid', provider_payment_id=$2, settled_at=now()
        WHERE id=$1`, [locked.id, ev.providerPaymentId]);
    const moved = await transition(c, locked.order_id, 'confirmed', null,
                                   `payment captured (${source})`);

    /* ---- allocation ----------------------------------------------------
       This is the moment the customer's money becomes four other people's
       money, and it happens inside the SAME transaction as the state
       change.

       The gateway's own fee is recorded against the snapshot — the one
       field of an otherwise immutable row that may be written late — when
       the provider reports it. Razorpay does, on the captured entity.
       Cashfree does NOT report it on the payment webhook; it arrives in
       settlement reconciliation. So for Cashfree this stays 0 and the
       finance surfaces say gateway charges are not yet known, rather than
       estimating a percentage and presenting the estimate as a fact. */
    const snapshot = await snapshotFor(c, moved.id);
    if (!snapshot) throw new Error(`order ${moved.id} was captured with no financial snapshot`);
    if (Number.isInteger(ev.feePaise) && ev.feePaise > 0 && snapshot.gateway_fee_paise === 0) {
      await c.query(`UPDATE order_financials SET gateway_fee_paise=$2 WHERE order_id=$1`,
                    [moved.id, ev.feePaise]);
      snapshot.gateway_fee_paise = ev.feePaise;
    }
    /* Idempotent on the payment id: a replayed capture allocates nothing a
       second time. */
    await postOrderCapture(c, { order: moved, snapshot, payment: locked });
    confirmed = true;
  });

  if (!confirmed) return { ok: true, duplicate: true };

  await audit(req, { action: 'payment.captured', resource: 'order', resourceId: pay.order_id,
                     outcome: 'ok', detail: { source, amount_paise: pay.amount_paise } });
  const okOrder = await one(`SELECT customer_id, code FROM food_order WHERE id=$1`, [pay.order_id]);
  if (okOrder) {
    notifyAsync(okOrder.customer_id, 'order_confirmed',
                { body: `Order ${okOrder.code} is confirmed and going to the kitchen.`,
                  data: { orderId: pay.order_id } });
  }
  /* Kick off partner search for delivery orders. Failure here must not
     un-confirm a paid order, so it is deliberately not in the tx. */
  assignDelivery(pay.order_id).catch((e) => req.log?.error({ e }, 'assignment failed'));
  return { ok: true, confirmed: true };
}

export default async function paymentRoutes(app) {
  /* The raw request bytes needed for the signature check are captured by the
     global JSON parser in index.js and exposed as req.rawBody. A re-encoded
     body would not verify, which is the point. */

  app.post('/payments/intent', async (req) => {
    authorize(req.actor, 'order.create');
    /* Re-checked here, not only at draft creation: verification can be
       revoked between drafting an order and paying for it, and a draft is
       not a licence to complete a purchase. */
    assertMayOrder(req.actor);
    if (!(await flag('online_payment'))) {
      throw ProviderUnavailable('Online payment is currently disabled',
        'Ordering is unavailable until payment is re-enabled. There is no cash option.');
    }
    const adapter = requireAdapter();          // 503 with `needs` if unconfigured

    const order = await one(`SELECT * FROM food_order WHERE id = $1`, [req.body?.orderId]);
    if (!order) throw NotFound('No such order');
    if (order.customer_id !== req.actor.id) throw Forbidden('That order is not yours');
    if (!['draft', 'awaiting_payment'].includes(order.state)) {
      throw Conflict(`This order is already ${order.state}`);
    }

    /* The amount charged is the frozen snapshot's total, not a number
       recomputed now and not anything in the request body. If the two ever
       disagreed, the snapshot wins and the order is refused rather than
       charged an amount nobody can account for. */
    const snap = await one(`SELECT * FROM order_financials WHERE order_id = $1`, [order.id]);
    if (!snap) throw Conflict('This order has no financial snapshot and cannot be charged');
    if (snap.customer_total_paise !== order.total_paise) {
      throw Conflict('This order total does not match its financial snapshot',
        `order.total_paise=${order.total_paise}, snapshot=${snap.customer_total_paise}.`);
    }
    const amountPaise = snap.customer_total_paise;

    /* Resume rather than duplicate. A customer who reloads the checkout page
       — or double-taps Pay — gets the SAME provider order back instead of a
       second one competing for the same money. Only an attempt that still
       matches the pinned amount qualifies. */
    const open = await one(
      `SELECT * FROM payment
        WHERE order_id=$1 AND provider=$2 AND status='pending'
          AND amount_paise=$3 AND provider_order_id IS NOT NULL
          AND flagged_reason IS NULL
        ORDER BY created_at DESC LIMIT 1`, [order.id, adapter.id, amountPaise]);

    let pay = open;
    /* A student who signed in with their institutional email has no verified
       phone. Cashfree requires a customer phone on every order, so the
       self-declared contact number is used — and asked for BEFORE a payment
       row exists, so a missing number never leaves a failed attempt behind.
       The number is contact data only; it never identifies or signs anyone in. */
    const customer = await one(
      `SELECT id, name, coalesce(phone, contact_phone) AS phone FROM app_user WHERE id=$1`,
      [order.customer_id]);
    if (!pay && adapter.id === 'cashfree' && !customer.phone) {
      throw Conflict('Add a contact mobile number before paying',
        'The payment gateway requires a phone number on the order. Add one under You → Contact number.');
    }
    if (!pay) {
      /* Insert FIRST, so the row that owns the attempt exists before the
         provider is asked for anything. Its id is the idempotency key for
         the outbound call, and for Cashfree it is the provider's order id
         too, which is what keeps the mapping one-to-one. */
      pay = await one(
        `INSERT INTO payment (order_id, provider, amount_paise, status)
         VALUES ($1,$2,$3,'created') RETURNING *`,
        [order.id, adapter.id, amountPaise]);

      let gw;
      try {
        /* No return URL is derived from the request. A checkout return URL
           that a client can influence is an open redirect, and here it would
           be one attached to a payment. It comes from server configuration
           (CASHFREE_PG_RETURN_URL) or not at all. */
        gw = await adapter.createOrder({ paymentId: pay.id, order, amountPaise, customer });
      } catch (e) {
        /* The gateway refused. The attempt is recorded as failed so it is
           visible, and the order stays exactly where it was — unpaid. */
        await q(`UPDATE payment SET status='failed' WHERE id=$1`, [pay.id]);
        await audit(req, { action: 'payment.intent', resource: 'order', resourceId: order.id,
                           outcome: 'error', detail: { error: String(e.message).slice(0, 300) } });
        throw e;
      }
      pay = await one(
        `UPDATE payment SET provider_order_id=$2, provider_session_id=$3, status='pending'
          WHERE id=$1 RETURNING *`, [pay.id, gw.providerOrderId, gw.sessionId]);
      pay.checkout = gw.checkout;
    } else {
      pay.checkout = pay.provider_session_id
        ? { paymentSessionId: pay.provider_session_id }
        : { gatewayOrderId: pay.provider_order_id };
    }

    if (order.state === 'draft') {
      await tx((c) => transition(c, order.id, 'awaiting_payment', req.actor, 'payment intent created'));
    }
    await audit(req, { action: 'payment.intent', resource: 'order', resourceId: order.id,
                       outcome: 'ok', detail: { amount_paise: amountPaise, provider: adapter.id,
                                                resumed: !!open } });

    /* Only public configuration leaves the server. PAYMENTS.publicConfig is
       the one getter allowed to produce client-bound values, and no secret
       key or webhook secret appears in it for any provider. */
    return {
      paymentId: pay.id,
      provider: adapter.id,
      /* Retained under its original name for the Razorpay checkout, which
         opens on the gateway order id. */
      gatewayOrderId: pay.provider_order_id,
      /* Cashfree's checkout opens on this instead. Exactly one of the two
         is meaningful per provider; the client reads `provider` to know. */
      paymentSessionId: pay.provider_session_id || null,
      checkout: pay.checkout,
      amountPaise,
      amountDisplay: `₹${rupees(amountPaise)}`,
      /* The customer-facing breakdown only. What Quad, the cafeteria and the
         partner each receive is not the customer's business and is not sent. */
      breakdown: {
        foodPaise: snap.food_subtotal_paise,
        discountPaise: snap.discount_paise,
        taxPaise: snap.tax_paise,
        deliveryPaise: snap.delivery_fee_paise,
        platformFeePaise: snap.platform_fee_paise,
        ...(snap.commission_mode === 'charge_to_customer'
              ? { serviceChargePaise: snap.commission_paise } : {}),
      },
      currency: PAYMENTS.currency,
      ...PAYMENTS.publicConfig,
    };
  });

  /* ---------- the webhook: the primary path to a confirmed order --------- */
  app.post('/payments/webhook', { config: { rateLimit: false } }, async (req, reply) => {
    if (!PAYMENTS.configured) return reply.code(503).send({ error: 'payments not configured' });
    const adapter = requireAdapter();

    /* Signature over the RAW bytes, and — where the provider timestamps its
       signature — a freshness window. Cashfree signs the timestamp into the
       HMAC, so a captured delivery cannot be re-dated into the window
       without breaking the signature: the two checks together are a real
       replay guard rather than a decoration. */
    const v = adapter.verifyWebhook(req.headers, req.rawBody);
    if (!v.ok) {
      await audit(req, { action: 'payment.webhook', outcome: 'denied',
                         detail: { reason: v.reason, provider: adapter.id,
                                   ...(v.skewSeconds ? { skew_seconds: v.skewSeconds } : {}) } });
      return reply.code(400).send({ error: 'invalid signature' });
    }

    const evt = req.body;
    const eventId = adapter.eventId(evt, req.headers);
    if (!eventId) return reply.code(400).send({ error: 'no event id' });

    /* Idempotency. A replayed delivery inserts nothing and does no work. */
    const fresh = await one(
      `INSERT INTO payment_webhook (provider, event_id, payload, provider_ts, event_type)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id`,
      [adapter.id, String(eventId), JSON.stringify(evt),
       v.receivedAtMs ? new Date(v.receivedAtMs) : null,
       String(evt?.type || evt?.event || '').slice(0, 80) || null]);
    if (!fresh) return { ok: true, duplicate: true };

    const ev = adapter.readEvent(evt, req.headers);
    if (!ev.providerOrderId) return { ok: true, ignored: true };

    const pay = await one(
      `SELECT * FROM payment WHERE provider = $1 AND provider_order_id = $2`,
      [adapter.id, ev.providerOrderId]);
    /* An event for an order this deployment never created. Not guessed at,
       not matched on amount, not matched on anything else: ignored. */
    if (!pay) return { ok: true, ignored: 'unknown payment' };

    return applyOutcome(req, pay, ev, 'webhook');
  });

  /* ---------- the browser's return from checkout -------------------------
     Called when the customer comes back — including when they came back by
     pressing Back, by closing the checkout, or by editing the URL.

     Nothing the browser says is believed. It supplies an order id, which it
     must already own; the server then asks the PROVIDER what actually
     happened, over an authenticated connection, and runs the answer through
     the same applyOutcome() the webhook uses. This is what makes a delayed
     webhook a slow confirmation rather than a lost order — and what makes a
     forged return URL do precisely nothing.                                */
  app.get('/payments/status', async (req) => {
    const order = await one(`SELECT * FROM food_order WHERE id = $1`, [req.query?.orderId]);
    if (!order) throw NotFound('No such order');
    if (order.customer_id !== req.actor?.id) throw Forbidden('That order is not yours');

    let pay = await one(
      `SELECT * FROM payment WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [order.id]);

    /* Reconcile only while the outcome is still open. A confirmed order is
       not re-fetched on every poll, and an unconfigured provider degrades to
       reporting what the database knows rather than erroring. */
    if (pay && pay.status === 'pending' && pay.provider_order_id &&
        order.state === 'awaiting_payment' && PAYMENTS.configured) {
      try {
        const adapter = requireAdapter();
        if (adapter.id === pay.provider) {
          const ev = await adapter.fetchOrder(pay.provider_order_id);
          await applyOutcome(req, pay, ev, 'status_pull');
          pay = await one(`SELECT * FROM payment WHERE id=$1`, [pay.id]);
        }
      } catch (e) {
        /* The gateway is unreachable. That is not the customer's problem to
           see as an error, and it must never be reported as either success
           or failure — the order simply stays pending and the webhook or a
           later poll resolves it. */
        req.log?.warn({ err: String(e.message) }, 'payment status reconcile failed');
      }
    }

    const current = await one(`SELECT state FROM food_order WHERE id=$1`, [order.id]);
    const state = current?.state || order.state;
    return {
      orderState: state,
      payment: pay?.status || 'none',
      confirmed: state !== 'draft' && state !== 'awaiting_payment' && state !== 'cancelled',
      /* Surfaced so a customer whose money left but whose order could not be
         confirmed sees the truth instead of a spinner. */
      underReview: !!pay?.flagged_reason,
      message: state === 'awaiting_payment'
        ? 'Waiting for confirmation from the payment gateway.'
        : (pay?.flagged_reason
            ? 'This payment needs review before the order can be confirmed. Support has been alerted.'
            : null),
    };
  });

  app.post('/payments/cancel', async (req) => {
    const order = await one(`SELECT * FROM food_order WHERE id = $1`, [req.body?.orderId]);
    if (!order) throw NotFound('No such order');
    if (order.customer_id !== req.actor?.id) throw Forbidden('That order is not yours');
    if (order.state !== 'awaiting_payment') throw Conflict(`Cannot cancel a ${order.state} order here`);
    await q(`UPDATE payment SET status = 'cancelled'
              WHERE order_id = $1 AND status = 'pending'`, [order.id]);
    await tx((c) => transition(c, order.id, 'cancelled', req.actor, 'payment cancelled by customer'));
    await audit(req, { action: 'payment.cancelled', resource: 'order', resourceId: order.id, outcome: 'ok' });
    return { ok: true, state: 'cancelled' };
  });
}
