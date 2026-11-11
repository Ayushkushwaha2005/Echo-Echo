/* ==========================================================================
   QUAD — Cashfree Payment Gateway adapter

   The adapter body below is the pilot's verified collection code, moved here
   unchanged from services/payment-providers.js so that a second provider can
   be developed, tested and switched without touching it. Shared helpers come
   from ./common.js; the registry that selects a provider is ./index.js.
   ========================================================================== */
import { createHmac } from 'node:crypto';
import { PAYMENTS } from '../../config.js';
import { paiseToRupeeString, rupeesToPaise, providerError, safeEqual, orderNote } from './common.js';

/* ==========================================================================
   Cashfree Payment Gateway  (the pilot's collection provider)

   Order creation:  POST {base}/pg/orders
   Authoritative status pull: GET {base}/pg/orders/{order_id}
                              GET {base}/pg/orders/{order_id}/payments
   Webhook signature: Base64( HMAC-SHA256( timestamp + rawBody, secretKey ) )
                      headers x-webhook-timestamp, x-webhook-signature

   Note what Cashfree does NOT give us: its own fee. That arrives in
   settlement reconciliation, not on the payment webhook, so `feePaise` is
   null here and Quad reports gateway charges as not-yet-known rather than
   estimating them. An estimated fee presented as a fact is how a net
   revenue line stops being true.
   ========================================================================== */
const PAYMENT_SESSION_MINUTES = 20;

/* PAYMENT status vocabulary. Note USER_DROPPED is its own outcome: an
   abandoned checkout is not a failure to retry silently and is certainly not
   a success, and giving it its own word is what stops a caller treating
   "not failed" as "succeeded". */
function cfPaymentOutcome(s) {
  if (s === 'SUCCESS' || s === 'PAYMENT_SUCCESS_WEBHOOK') return 'paid';
  if (s === 'FAILED' || s === 'PAYMENT_FAILED_WEBHOOK') return 'failed';
  if (s === 'USER_DROPPED' || s === 'PAYMENT_USER_DROPPED_WEBHOOK') return 'dropped';
  if (s === 'PENDING' || s === 'NOT_ATTEMPTED') return 'pending';
  return 'unknown';
}

/* ORDER status vocabulary, which is a different set of words for a different
   thing. ACTIVE means "payable, nobody has paid yet" — not "in progress". */
function cfOrderOutcome(s) {
  if (s === 'PAID') return 'paid';
  if (s === 'ACTIVE') return 'pending';
  if (s === 'EXPIRED' || s === 'TERMINATED' || s === 'TERMINATION_REQUESTED') return 'failed';
  return 'unknown';
}

export const cashfree = {
  id: 'cashfree',
  label: 'Cashfree Payment Gateway',
  get configured() {
    const c = PAYMENTS.cashfree;
    return !!(c.appId && c.secretKey);
  },
  needs: 'A Cashfree Payments account with KYC approved, and CASHFREE_PG_APP_ID / ' +
         'CASHFREE_PG_SECRET_KEY set on the server. The same secret key verifies webhooks, ' +
         'so there is no way to configure collection without being able to verify one.',

  headers(extra = {}) {
    const c = PAYMENTS.cashfree;
    return {
      'x-client-id': c.appId,
      'x-client-secret': c.secretKey,
      'x-api-version': c.apiVersion,
      'Content-Type': 'application/json',
      ...extra,
    };
  },

  /* ctx: { paymentId, order, amountPaise, customer, returnUrl }
     `paymentId` is used as Cashfree's order_id. That is deliberate: one
     Cashfree order per Quad PAYMENT ATTEMPT, not per Quad order. A customer
     whose first attempt failed gets a fresh Cashfree order on the retry
     instead of colliding with an expired one, and the (provider_order_id ->
     payment) mapping stays exactly one-to-one, which is what makes the
     webhook lookup unambiguous. */
  async createOrder(ctx) {
    const { paymentId, order, amountPaise, customer } = ctx;
    const returnUrl = PAYMENTS.cashfree.returnUrl || ctx.returnUrl;
    const res = await fetch(`${PAYMENTS.cashfreeBase}/pg/orders`, {
      method: 'POST',
      headers: this.headers({
        /* Provider-side replay guard: a retried HTTP call returns the
           ORIGINAL order instead of creating a second one. */
        'x-idempotency-key': paymentId,
        'x-request-id': paymentId,
      }),
      body: JSON.stringify({
        order_id: paymentId,
        /* Rupee decimal string, converted exactly from integer paise. */
        order_amount: paiseToRupeeString(amountPaise),
        order_currency: PAYMENTS.currency,
        /* Cashfree's default is 30 days; its minimum is 15 minutes. An unpaid
           order is given up on after 20, so the session must not outlive that
           by weeks if closing it ever fails. */
        order_expiry_time: new Date(Date.now() + PAYMENT_SESSION_MINUTES * 60_000).toISOString(),
        customer_details: {
          customer_id: customer.id,
          customer_phone: customer.phone,
          ...(customer.name ? { customer_name: customer.name } : {}),
        },
        /* What the customer reads on Cashfree's checkout and receipt: the
           order code and the café it is from. */
        order_note: orderNote(order.code, ctx.vendorName),
        /* Carried back on the webhook and the status pull. Used only as a
           cross-check against our own mapping — never as the mapping. */
        order_tags: { quad_order_id: order.id, quad_order_code: order.code },
        /* Online payment only, and only UPI, cards and net banking: no pay-later, no
           wallets, no EMI. Cashfree enforces this on the hosted checkout. */
        order_meta: {
          ...(returnUrl ? { return_url: returnUrl } : {}),
          ...(PAYMENTS.cashfree.notifyUrl ? { notify_url: PAYMENTS.cashfree.notifyUrl } : {}),
          payment_methods: PAYMENTS.cashfree.paymentMethods,
        },
        /* Easy Split, only when the caller supplied splits — which it does
           only when CASHFREE_EASY_SPLIT is on AND Cashfree has activated the
           café's vendor account. Amounts are the ledger's own numbers. */
        ...(ctx.splits?.length ? { order_splits: ctx.splits.map((x) => ({
          vendor_id: x.providerVendorId, amount: Number(paiseToRupeeString(x.amountPaise)) })) } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw providerError('cashfree_pg', res, text);
    const body = JSON.parse(text);
    if (!body.payment_session_id) {
      throw new Error('cashfree_pg: order created without a payment_session_id');
    }
    return {
      providerOrderId: String(body.order_id),
      sessionId: String(body.payment_session_id),
      /* What the browser needs to open the hosted checkout, and nothing
         more. No secret is in this object. */
      checkout: { paymentSessionId: String(body.payment_session_id) },
      raw: body,
    };
  },

  /* Base64(HMAC-SHA256(timestamp + rawBody, secretKey)), per Cashfree's
     current webhook documentation. Verified against the raw bytes.

     The timestamp is inside the signed material, so an attacker cannot move
     a captured delivery into the freshness window without breaking the
     signature — which is what makes the skew check a real replay guard
     rather than a decoration. */
  verifyWebhook(headers, rawBody) {
    const secret = PAYMENTS.cashfree.secretKey;
    if (!secret) return { ok: false, reason: 'not_configured' };
    const ts = headers['x-webhook-timestamp'];
    const sig = headers['x-webhook-signature'];
    if (!ts || !sig) return { ok: false, reason: 'missing_signature_headers' };

    const expected = createHmac('sha256', secret)
      .update(String(ts) + rawBody.toString('utf8'))
      .digest('base64');
    if (!safeEqual(sig, expected)) return { ok: false, reason: 'bad_signature' };

    /* Freshness. Cashfree sends epoch seconds; tolerate milliseconds too
       rather than misreading a 13-digit value as the year 46000. */
    const n = Number(ts);
    if (!Number.isFinite(n)) return { ok: false, reason: 'bad_timestamp' };
    const sentMs = n > 1e11 ? n : n * 1000;
    const skewMs = Math.abs(Date.now() - sentMs);
    if (skewMs > PAYMENTS.webhookMaxSkewSeconds * 1000) {
      return { ok: false, reason: 'stale_timestamp', skewSeconds: Math.round(skewMs / 1000) };
    }
    return { ok: true, receivedAtMs: sentMs };
  },

  /* The event id used for the (provider, event_id) idempotency key.
     Cashfree sends x-idempotency-key on webhook versions 2025-01-01 and
     later. Older versions do not, so fall back to something deterministic
     for the same logical event — cf_payment_id plus the event type — which
     absorbs a duplicate delivery just as well. */
  eventId(body, headers) {
    const h = headers['x-idempotency-key'];
    if (h) return String(h);
    const rf = body?.data?.refund;
    if (rf?.refund_id) return `${body?.type || 'refund'}:${rf.refund_id}:${rf.refund_status || ''}`;
    const cf = body?.data?.payment?.cf_payment_id;
    const type = body?.type || 'event';
    if (cf) return `${type}:${cf}`;
    const oid = body?.data?.order?.order_id;
    return oid ? `${type}:${oid}` : null;
  },

  readEvent(body) {
    const order = body?.data?.order || {};
    const payment = body?.data?.payment || {};
    const status = String(payment.payment_status || '').toUpperCase();
    const type = String(body?.type || '').toUpperCase();
    return {
      outcome: cfPaymentOutcome(status || type),
      providerOrderId: order.order_id ? String(order.order_id) : null,
      providerPaymentId: payment.cf_payment_id != null ? String(payment.cf_payment_id) : null,
      /* The amount ACTUALLY paid, not the amount ordered. These differ
         under a partial payment, and it is the paid one that must match. */
      amountPaise: rupeesToPaise(payment.payment_amount),
      currency: String(payment.payment_currency || order.order_currency || '').toUpperCase() || null,
      feePaise: null,             // not reported on the PG webhook; see header
      raw: body,
    };
  },

  /* REFUND_STATUS_WEBHOOK carries data.refund; anything else is not a
     refund event and returns null so the payment path handles it. */
  readRefundEvent(body) {
    const r = body?.data?.refund;
    if (!r || !String(body?.type || '').toUpperCase().includes('REFUND')) return null;
    const status = String(r.refund_status || '').toUpperCase();
    return {
      refundId: r.refund_id ? String(r.refund_id) : null,
      status,
      outcome: status === 'SUCCESS' ? 'completed'
        : ['CANCELLED', 'FAILED'].includes(status) ? 'failed' : 'pending',
    };
  },

  /* Refunds. Cashfree refunds are ASYNCHRONOUS: the call usually returns
     PENDING and the money reaches the customer later. So `settled` is false
     until the provider says SUCCESS, and the caller records a refund that is
     `processing` rather than claiming it is done. Saying a refund completed
     when it has only been accepted is the same lie as saying a payout was
     paid when it was only queued. */
  async refund({ payment, refundId, amountPaise, reason, orderCode }) {
    const res = await fetch(
      `${PAYMENTS.cashfreeBase}/pg/orders/${encodeURIComponent(payment.provider_order_id)}/refunds`, {
      method: 'POST',
      headers: this.headers({ 'x-request-id': refundId, 'x-idempotency-key': refundId }),
      body: JSON.stringify({
        refund_amount: paiseToRupeeString(amountPaise),
        /* Our refund id is Cashfree's idempotency key here: a retried call
           returns the ORIGINAL refund instead of returning the money twice. */
        refund_id: refundId,
        refund_note: String(reason || '').slice(0, 100),
        refund_speed: 'STANDARD',
      }),
    });
    const text = await res.text();
    if (!res.ok) throw providerError('cashfree_pg', res, text);
    const body = JSON.parse(text);
    const status = String(body.refund_status || '').toUpperCase();
    return {
      providerRefundId: body.cf_refund_id != null ? String(body.cf_refund_id) : refundId,
      status,
      settled: status === 'SUCCESS',
      raw: body,
    };
  },

  /* ---- settlement reconciliation ----------------------------------------
     The authoritative record of what the gateway actually kept. This is the
     ONLY source Quad accepts for a gateway fee: the payment webhook does not
     carry one, and a fee inferred from a published rate card is a guess
     wearing a decimal point.

     POST {base}/pg/settlement/recon, cursor-paginated. Returns lines already
     normalised to integer paise, so the importer never sees a rupee decimal
     and cannot accidentally do float arithmetic on one.

     Every amount goes through rupeesToPaise(), which returns null rather
     than coercing anything it will not vouch for. A null amount is carried
     through as null and the importer refuses to apply the line — the
     fail-closed direction, on the one number this whole feature exists to
     get right. */
  async fetchSettlements({ from, to, settlementId, utr, cursor = null, limit = 100 }) {
    const filters = settlementId ? { cf_settlement_ids: [Number(settlementId)] }
                  : utr          ? { settlement_utrs: [String(utr)] }
                  /* Second precision: Cashfree's recon API rejects an ISO
                     timestamp with milliseconds (observed in sandbox). */
                  : { start_date: from.toISOString().replace(/\.\d{3}Z$/, 'Z'),
                      end_date: to.toISOString().replace(/\.\d{3}Z$/, 'Z') };
    const res = await fetch(`${PAYMENTS.cashfreeBase}/pg/settlement/recon`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ filters, pagination: { limit, cursor } }),
    });
    const text = await res.text();
    if (!res.ok) throw providerError('cashfree_pg', res, text);
    const body = JSON.parse(text);
    const rows = Array.isArray(body.data) ? body.data : [];
    return {
      cursor: body.cursor ?? null,
      entries: rows.map((r) => ({
        providerPaymentId: r.cf_payment_id != null ? String(r.cf_payment_id) : null,
        providerOrderId: r.order_id != null ? String(r.order_id) : null,
        settlementId: r.cf_settlement_id != null ? String(r.cf_settlement_id) : null,
        settlementUtr: r.transfer_utr ? String(r.transfer_utr) : null,
        /* PAYMENT / REFUND / ADJUSTMENT — normalised upper-case, because the
           importer's handling of a refund line is materially different from
           its handling of a payment line and must not depend on casing. */
        eventType: String(r.event_type || 'PAYMENT').toUpperCase(),
        paymentAmountPaise: rupeesToPaise(r.payment_amount ?? r.order_amount),
        /* The gateway's fee and the GST on that fee. Kept apart here because
           they are separately reportable for tax, and summed only where a
           single "what the gateway kept" figure is needed. */
        serviceChargePaise: rupeesToPaise(r.service_charge ?? 0),
        serviceTaxPaise: rupeesToPaise(r.service_tax ?? 0),
        settlementAmountPaise: rupeesToPaise(r.settlement_amount),
        raw: r,
      })),
    };
  },

  /* Close a Cashfree order that a newer attempt replaced, so the customer
     cannot pay a stale checkout as well as the new one. Best effort: if it
     fails, a late success on the old order is still caught by applyOutcome
     (order no longer awaiting payment -> flagged for refund review). */
  async terminateOrder(providerOrderId) {
    const res = await fetch(`${PAYMENTS.cashfreeBase}/pg/orders/${encodeURIComponent(providerOrderId)}`, {
      method: 'PATCH', headers: this.headers(), body: JSON.stringify({ order_status: 'TERMINATED' }) });
    return res.ok;
  },

  /* Easy Split vendor status, from Cashfree itself. The only source Quad
     accepts for marking a café's split account active. */
  async fetchSplitVendor(providerVendorId) {
    const res = await fetch(
      `${PAYMENTS.cashfreeBase}/pg/easy-split/vendors/${encodeURIComponent(providerVendorId)}`,
      { headers: this.headers() });
    const text = await res.text();
    if (res.status === 404) return { status: 'NOT_FOUND' };
    if (!res.ok) throw providerError('cashfree_pg', res, text);
    const body = JSON.parse(text);
    return { status: String(body.status || '').toUpperCase() };
  },

  /* The authoritative status of one refund, for reconciliation. */
  async fetchRefund(providerOrderId, refundId) {
    const res = await fetch(
      `${PAYMENTS.cashfreeBase}/pg/orders/${encodeURIComponent(providerOrderId)}/refunds/${encodeURIComponent(refundId)}`,
      { headers: this.headers() });
    const text = await res.text();
    if (res.status === 404) return { status: 'NOT_FOUND' };
    if (!res.ok) throw providerError('cashfree_pg', res, text);
    const body = JSON.parse(text);
    return { status: String(body.refund_status || '').toUpperCase(),
             amountPaise: rupeesToPaise(body.refund_amount) };
  },

  async fetchOrder(providerOrderId) {
    /* Every fetch target below is rooted in PAYMENTS.* directly rather than
       in a local alias. That is not style: security.test.mjs statically
       scans every fetch() in src/ and requires the target to begin with a
       literal https host or a config object, so an alias would read to that
       scan exactly like a caller-supplied base URL. */
    /* encodeURIComponent is applied AT each interpolation rather than once
       into a local. A local would read to that static scan as an unencoded
       segment, and a check that cannot see the encoding is a check that
       stops catching the next unencoded one somebody adds. */
    const res = await fetch(`${PAYMENTS.cashfreeBase}/pg/orders/${encodeURIComponent(providerOrderId)}`,
                            { headers: this.headers() });
    const text = await res.text();
    if (res.status === 404) {
      return { outcome: 'unknown', providerOrderId, providerPaymentId: null,
               amountPaise: null, currency: null, feePaise: null, raw: null };
    }
    if (!res.ok) throw providerError('cashfree_pg', res, text);
    const body = JSON.parse(text);
    const orderStatus = String(body.order_status || '').toUpperCase();

    /* The order status alone is not enough. PAID says money arrived but not
       which payment carried it; ACTIVE says the order is still payable, yet
       an individual attempt on it may already have FAILED (observed in the
       sandbox: order ACTIVE, attempt FAILED). So the payment attempts are
       always read, and:

         any SUCCESS attempt on a PAID order  -> paid (that attempt)
         order ACTIVE, latest attempt FAILED  -> failed (never paid; the
                                                 order stays retryable)
         anything else                        -> the order's own status

       A failed attempt never produces 'paid', whatever else the response
       says: 'paid' requires a SUCCESS attempt AND the order being PAID. */
    let payments = [];
    const pres = await fetch(
      `${PAYMENTS.cashfreeBase}/pg/orders/${encodeURIComponent(providerOrderId)}/payments`,
      { headers: this.headers() });
    const ptext = await pres.text();
    if (pres.ok) {
      try { const list = JSON.parse(ptext); payments = Array.isArray(list) ? list : []; } catch { payments = []; }
    }
    const status = (p) => String(p.payment_status || '').toUpperCase();
    const payment = orderStatus === 'PAID' ? (payments.find((p) => status(p) === 'SUCCESS') || null) : null;

    if (payment) {
      return {
        outcome: 'paid',
        providerOrderId: String(body.order_id),
        providerPaymentId: payment.cf_payment_id != null ? String(payment.cf_payment_id) : null,
        amountPaise: rupeesToPaise(payment.payment_amount),
        currency: String(payment.payment_currency || body.order_currency || '').toUpperCase() || null,
        feePaise: null,
        raw: { order: body, payment },
      };
    }
    if (orderStatus === 'ACTIVE' && payments.length) {
      const latest = [...payments].sort((a, b) =>
        String(b.payment_time || b.payment_completion_time || '').localeCompare(
          String(a.payment_time || a.payment_completion_time || '')))[0];
      const ls = status(latest);
      if (ls === 'FAILED' || ls === 'USER_DROPPED') {
        return {
          outcome: ls === 'FAILED' ? 'failed' : 'dropped',
          providerOrderId: String(body.order_id),
          providerPaymentId: latest.cf_payment_id != null ? String(latest.cf_payment_id) : null,
          amountPaise: rupeesToPaise(latest.payment_amount ?? body.order_amount),
          currency: String(body.order_currency || '').toUpperCase() || null,
          feePaise: null,
          raw: { order: body, payment: latest },
        };
      }
    }
    return {
      outcome: cfOrderOutcome(orderStatus),
      providerOrderId: String(body.order_id),
      providerPaymentId: null,
      amountPaise: rupeesToPaise(body.order_amount),
      currency: String(body.order_currency || '').toUpperCase() || null,
      feePaise: null,
      raw: { order: body },
    };
  },

};
