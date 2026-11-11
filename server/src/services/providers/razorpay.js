/* ==========================================================================
   QUAD — Razorpay Payment Gateway adapter

   Independent of the Cashfree adapter in every provider-specific respect:
   its own credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET), its own
   webhook secret (RAZORPAY_WEBHOOK_SECRET — Razorpay signs deliveries with a
   secret that is NOT the API secret), its own event vocabulary, its own
   refund semantics. What it shares with every other adapter is only the
   normalised shape documented in ./index.js, so routes/payments.js, the
   ledger and reconciliation never learn which gateway they are talking to.

   Wire facts this file depends on (Razorpay API v1):

     Orders:   POST /v1/orders                 amount in integer paise
     Status:   GET  /v1/orders/{id}/payments   every attempt on an order
     Refunds:  POST /v1/payments/{id}/refund   X-Razorpay-Idempotency header
               GET  /v1/refunds/{id}
               GET  /v1/payments/{id}/refunds
     Recon:    GET  /v1/settlements/recon/combined?year=&month=&day=
     Webhooks: header x-razorpay-signature = hex(HMAC-SHA256(rawBody, secret))
               header x-razorpay-event-id   = unique per event (idempotency)
               body.event ∈ payment.authorized | payment.captured |
                 payment.failed | order.paid | refund.created |
                 refund.processed | refund.failed | refund.speed_changed

   Razorpay does not timestamp its signature, so there is no freshness window
   to apply; the (provider, event_id) primary key on payment_webhook is the
   replay guard, and the event id falls back to a deterministic
   "<event>:<entity id>" when the header is absent, so two DIFFERENT events
   about one payment (authorized, then captured) never collide.

   Capture: the order is created with payment_capture = 1 so an authorised
   payment is captured by Razorpay at once rather than waiting on the
   dashboard's auto-capture timer. An `authorized` payment is still reported
   as `pending`, never `paid`: only `captured` means Razorpay holds the money.

   Money: Razorpay speaks integer paise natively. Amounts are validated as
   integers and otherwise returned as null, which fails closed in
   applyOutcome exactly as an unparseable Cashfree decimal does.
   ========================================================================== */
import { createHmac } from 'node:crypto';
import { PAYMENTS } from '../../config.js';
import { providerError, safeEqual } from './common.js';

const intPaise = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);

/* Payment entity status -> normalised outcome. `refunded` is a payment that
   WAS captured (and later refunded); the capture is still the fact that
   confirms the order, and the refund is tracked on its own row. */
function rzpPaymentOutcome(status) {
  if (status === 'captured' || status === 'refunded') return 'paid';
  if (status === 'failed') return 'failed';
  if (status === 'created' || status === 'authorized') return 'pending';
  return 'unknown';
}

/* Refund entity status -> the outcome vocabulary applyRefundOutcome expects. */
function rzpRefundOutcome(status) {
  if (status === 'processed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'pending';
}

function paymentEntityToEvent(e, body) {
  const fee = Number(e.fee);
  return {
    outcome: rzpPaymentOutcome(String(e.status || '')),
    providerOrderId: e.order_id ? String(e.order_id) : null,
    providerPaymentId: e.id ? String(e.id) : null,
    amountPaise: intPaise(e.amount),
    currency: String(e.currency || '').toUpperCase() || null,
    /* Razorpay reports its fee (inclusive of tax) on the captured entity, so
       Quad's net revenue is a fact for this provider rather than an estimate.
       The settlement report remains the authoritative figure and may adjust
       it later through reconciliation. */
    feePaise: Number.isInteger(fee) && fee > 0 ? fee : null,
    raw: body,
  };
}

export const razorpay = {
  id: 'razorpay',
  label: 'Razorpay Payment Gateway',
  get configured() {
    const r = PAYMENTS.razorpay;
    return !!(r.keyId && r.keySecret && r.webhookSecret);
  },
  needs: 'A Razorpay account with RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and ' +
         'RAZORPAY_WEBHOOK_SECRET set on the server. The webhook secret is the one entered ' +
         'when the webhook was created in the Razorpay dashboard; it is not the API secret.',

  /* What the adapter itself asks of the shared route. Cashfree insists on a
     customer phone on every order and offers Easy Split; Razorpay does
     neither. The route reads these flags instead of naming a provider. */
  requiresCustomerPhone: false,
  supportsSplits: false,

  /* What the browser may know: the public key id, nothing else. */
  get publicConfig() {
    return { keyId: PAYMENTS.razorpay.keyId };
  },

  auth() {
    const { keyId, keySecret } = PAYMENTS.razorpay;
    return 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  },

  /* ctx: { paymentId, order, amountPaise, customer }
     One Razorpay order per Quad payment ATTEMPT. The attempt id travels in
     `notes` and the order code in `receipt`, both only as cross-checks; the
     authoritative mapping is payment.provider_order_id in our database. */
  async createOrder({ paymentId, order, amountPaise }) {
    const res = await fetch(`${PAYMENTS.apiBase}/v1/orders`, {
      method: 'POST',
      headers: { Authorization: this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountPaise,              // already paise; no conversion, no float
        currency: PAYMENTS.currency,
        receipt: String(order.code).slice(0, 40),
        /* Capture immediately on authorisation. Without this the dashboard's
           auto-capture timer decides, and a payment can sit `authorized` for
           minutes while the customer waits on a spinner. */
        payment_capture: 1,
        notes: { order_id: order.id, quad_payment_id: paymentId, quad_order_code: order.code },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw providerError('razorpay', res, text);
    const body = JSON.parse(text);
    if (!body.id) throw new Error('razorpay: order created without an id');
    return {
      providerOrderId: String(body.id),
      sessionId: null,
      /* What the browser needs to open Checkout.js: the order id and the
         public key id. No secret is in this object. */
      checkout: { gatewayOrderId: String(body.id), keyId: PAYMENTS.razorpay.keyId },
      raw: body,
    };
  },

  /* hex(HMAC-SHA256(rawBody, webhookSecret)), verified against the raw
     request bytes in constant time. No timestamp is signed, so no skew check
     exists; replay is absorbed by the event-id idempotency key. */
  verifyWebhook(headers, rawBody) {
    const secret = PAYMENTS.razorpay.webhookSecret;
    if (!secret) return { ok: false, reason: 'not_configured' };
    const sig = headers['x-razorpay-signature'];
    if (!sig) return { ok: false, reason: 'missing_signature_headers' };
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!safeEqual(sig, expected)) return { ok: false, reason: 'bad_signature' };
    return { ok: true, receivedAtMs: Date.now() };
  },

  /* The (provider, event_id) idempotency key. Razorpay sends
     x-razorpay-event-id on every delivery; the fallback is deterministic
     for the same logical event and DIFFERENT for different events about the
     same entity, so a missing header can never make "captured" look like a
     duplicate of "authorized". */
  eventId(body, headers) {
    const h = headers['x-razorpay-event-id'];
    if (h) return String(h);
    const type = String(body?.event || 'event');
    const rf = body?.payload?.refund?.entity;
    if (rf?.id) return `${type}:${rf.id}:${rf.status || ''}`;
    const pay = body?.payload?.payment?.entity;
    if (pay?.id) return `${type}:${pay.id}`;
    const ord = body?.payload?.order?.entity;
    return ord?.id ? `${type}:${ord.id}` : null;
  },

  /* Payment events. `order.paid` carries both the order and the payment that
     paid it; the payment entity is what is read, because the amount that
     must match the snapshot is the amount actually paid. */
  readEvent(body) {
    const e = body?.payload?.payment?.entity || {};
    const evt = String(body?.event || '');
    const ev = paymentEntityToEvent(e, body);
    /* The event name is authoritative over a stale entity status on the
       few events that state the outcome in their name. */
    if (evt === 'payment.captured' || evt === 'order.paid') ev.outcome = 'paid';
    else if (evt === 'payment.failed') ev.outcome = 'failed';
    else if (evt === 'payment.authorized') ev.outcome = 'pending';
    if (!ev.providerOrderId && body?.payload?.order?.entity?.id) {
      ev.providerOrderId = String(body.payload.order.entity.id);
    }
    return ev;
  },

  /* refund.* events carry payload.refund.entity. Anything else is not a
     refund event and returns null so the payment path handles it. The Quad
     refund id travels in `notes.quad_refund_id` (set by refund() below); a
     refund issued from the Razorpay dashboard has no such note, so the
     provider's own refund id is returned too and the caller resolves it. */
  readRefundEvent(body) {
    const evt = String(body?.event || '');
    const r = body?.payload?.refund?.entity;
    if (!r || !evt.startsWith('refund.')) return null;
    const status = String(r.status || '').toLowerCase();
    return {
      refundId: r.notes?.quad_refund_id ? String(r.notes.quad_refund_id)
              : (r.receipt ? String(r.receipt) : null),
      providerRefundId: r.id ? String(r.id) : null,
      providerPaymentId: r.payment_id ? String(r.payment_id) : null,
      amountPaise: intPaise(r.amount),
      status: status.toUpperCase(),
      outcome: rzpRefundOutcome(status),
    };
  },

  /* Refunds. Razorpay usually returns `processed` for a normal-speed refund
     of a settled payment, but `pending` is a real answer (the money leaves
     later), so `settled` is true only on `processed` and the caller records
     a `processing` refund otherwise. Our refund id is the idempotency key:
     a retried call returns the ORIGINAL refund instead of refunding twice. */
  async refund({ payment, refundId, amountPaise, reason, orderCode }) {
    const res = await fetch(
      `${PAYMENTS.apiBase}/v1/payments/${encodeURIComponent(payment.provider_payment_id)}/refund`, {
      method: 'POST',
      headers: {
        Authorization: this.auth(),
        'Content-Type': 'application/json',
        'X-Razorpay-Idempotency': refundId,
      },
      body: JSON.stringify({
        amount: amountPaise,
        speed: 'normal',
        receipt: String(refundId).slice(0, 40),
        notes: { order: orderCode, reason: String(reason || '').slice(0, 200), quad_refund_id: refundId },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw providerError('razorpay', res, text);
    const body = JSON.parse(text);
    const status = String(body.status || '').toLowerCase();
    return {
      providerRefundId: body.id ? String(body.id) : refundId,
      status: status.toUpperCase(),
      settled: status === 'processed',
      raw: body,
    };
  },

  /* The authoritative status of one refund, for the processing-refund sweep.
     Called as fetchRefund(providerOrderId, quadRefundId, refundRow). With
     the provider's refund id on the row it is a direct lookup; without it
     (an older row) the payment's refunds are listed and matched on the note
     or receipt this adapter wrote. Returns the normalised `outcome` the
     sweep applies, plus the provider's own status word for the record. */
  async fetchRefund(providerOrderId, refundId, row = {}) {
    let body;
    if (row?.provider_refund_id && /^rfnd_/.test(row.provider_refund_id)) {
      const res = await fetch(
        `${PAYMENTS.apiBase}/v1/refunds/${encodeURIComponent(row.provider_refund_id)}`,
        { headers: { Authorization: this.auth() } });
      const text = await res.text();
      if (res.status === 404) return { status: 'NOT_FOUND', outcome: 'pending' };
      if (!res.ok) throw providerError('razorpay', res, text);
      body = JSON.parse(text);
    } else if (row?.provider_payment_id) {
      const res = await fetch(
        `${PAYMENTS.apiBase}/v1/payments/${encodeURIComponent(row.provider_payment_id)}/refunds`,
        { headers: { Authorization: this.auth() } });
      const text = await res.text();
      if (res.status === 404) return { status: 'NOT_FOUND', outcome: 'pending' };
      if (!res.ok) throw providerError('razorpay', res, text);
      const list = JSON.parse(text);
      const items = Array.isArray(list?.items) ? list.items : [];
      body = items.find((r) => r?.notes?.quad_refund_id === refundId || r?.receipt === refundId) || null;
      if (!body) return { status: 'NOT_FOUND', outcome: 'pending' };
    } else {
      return { status: 'NOT_FOUND', outcome: 'pending' };
    }
    const status = String(body.status || '').toLowerCase();
    return {
      status: status.toUpperCase(),
      outcome: rzpRefundOutcome(status),
      providerRefundId: body.id ? String(body.id) : null,
      amountPaise: intPaise(body.amount),
    };
  },

  /* ---- settlement reconciliation ----------------------------------------
     GET /v1/settlements/recon/combined?year=&month=&day= — day-scoped, so a
     window is walked a day at a time through the cursor, which here is the
     day offset. One interface serves a cursor-paginated provider and a
     day-scoped one. */
  async fetchSettlements({ from, to, cursor = null, limit = 100 }) {
    const dayOffset = cursor ? Number(cursor) : 0;
    const day = new Date(from.getTime() + dayOffset * 86_400_000);
    if (day >= to) return { cursor: null, entries: [] };
    const res = await fetch(
      `${PAYMENTS.apiBase}/v1/settlements/recon/combined` +
        `?year=${encodeURIComponent(day.getUTCFullYear())}` +
        `&month=${encodeURIComponent(day.getUTCMonth() + 1)}` +
        `&day=${encodeURIComponent(day.getUTCDate())}` +
        `&count=${encodeURIComponent(limit)}`,
      { headers: { Authorization: this.auth() } });
    const text = await res.text();
    if (!res.ok) throw providerError('razorpay', res, text);
    const body = JSON.parse(text);
    const rows = Array.isArray(body.items) ? body.items : [];
    return {
      /* Always advance, so a day with no settlements does not stall the walk. */
      cursor: String(dayOffset + 1),
      entries: rows.map((r) => ({
        providerPaymentId: r.entity_id ? String(r.entity_id) : null,
        providerOrderId: r.order_id ? String(r.order_id) : null,
        settlementId: r.settlement_id ? String(r.settlement_id) : null,
        settlementUtr: r.settlement_utr ? String(r.settlement_utr) : null,
        eventType: String(r.type || 'payment').toUpperCase(),
        /* Integer paise natively — still validated, because "as-is" must
           not mean "unchecked". */
        paymentAmountPaise: Number.isInteger(Number(r.amount)) ? Number(r.amount) : null,
        serviceChargePaise: Number.isInteger(Number(r.fee)) ? Number(r.fee) : 0,
        serviceTaxPaise: Number.isInteger(Number(r.tax)) ? Number(r.tax) : 0,
        settlementAmountPaise: Number.isInteger(Number(r.credit))
          ? Number(r.credit)
          : (Number.isInteger(Number(r.amount)) && Number.isInteger(Number(r.fee))
              ? Number(r.amount) - Number(r.fee) : null),
        raw: r,
      })),
    };
  },

  /* The authoritative pull. Every attempt on the order is read:

       any captured (or later refunded) attempt -> paid (that attempt)
       otherwise the latest attempt failed      -> failed
       otherwise an attempt exists              -> pending
       no attempts                              -> pending (order still payable)

     A failed attempt never produces 'paid', and an `authorized` attempt is
     pending: Razorpay has not taken the money until it is captured. */
  async fetchOrder(providerOrderId) {
    const res = await fetch(
      `${PAYMENTS.apiBase}/v1/orders/${encodeURIComponent(providerOrderId)}/payments`,
      { headers: { Authorization: this.auth() } });
    const text = await res.text();
    if (res.status === 404) {
      return { outcome: 'unknown', providerOrderId, providerPaymentId: null,
               amountPaise: null, currency: null, feePaise: null, raw: null };
    }
    if (!res.ok) throw providerError('razorpay', res, text);
    const body = JSON.parse(text);
    const items = Array.isArray(body.items) ? body.items : [];
    const paid = items.find((p) => p.status === 'captured' || p.status === 'refunded');
    const latest = items[items.length - 1] || null;
    const chosen = paid || latest;
    if (!chosen) {
      return { outcome: 'pending', providerOrderId, providerPaymentId: null,
               amountPaise: null, currency: null, feePaise: null, raw: body };
    }
    const ev = paymentEntityToEvent(chosen, body);
    ev.providerOrderId = providerOrderId;
    return ev;
  },
};
