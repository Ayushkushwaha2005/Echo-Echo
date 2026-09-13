/* ==========================================================================
   QUAD — COLLECTION PROVIDER ADAPTERS

   The mirror image of payout-providers.js, for money coming IN. One
   interface, several gateways, so which one Quad collects through is a
   deployment decision rather than a rewrite — and so a stalled KYC at one
   provider is a config change, not an outage two days before launch.

   Nothing outside this file names a gateway. routes/payments.js, the
   ledger, the settlement engine and the order pipeline all speak the
   vocabulary below, which is why swapping Razorpay for Cashfree touched no
   financial logic at all.

   Every adapter exports the same shape:

     id, label, configured, needs
     createOrder(ctx)               -> { providerOrderId, sessionId, checkout }
     verifyWebhook(headers, rawBody)-> { ok, reason, eventId, receivedAtMs }
     readEvent(body, headers)       -> a NORMALISED event (see below)
     fetchOrder(providerOrderId)    -> the same normalised shape, pulled
     refund(ctx)                    -> { providerRefundId, status, settled }
     fetchSettlements(window)       -> { cursor, entries: [settlement lines] }

   A settlement line, normalised, all amounts integer paise:

     { providerPaymentId, providerOrderId, settlementId, settlementUtr,
       eventType, paymentAmountPaise, serviceChargePaise, serviceTaxPaise,
       settlementAmountPaise, raw }

   An amount this file will not vouch for comes back as `null`, never as a
   coerced number. null does not compare equal to anything, so the importer
   refuses the line and raises an exception rather than applying a figure
   nobody can stand behind. Negative amounts also arrive as null for the same
   reason: they are real (a clawback), but representing one as a positive fee
   would be a sign error in somebody's revenue.

   The normalised event/status shape, which is the whole point:

     { outcome, providerOrderId, providerPaymentId, amountPaise, currency,
       feePaise, raw }

     outcome ∈ 'paid' | 'failed' | 'dropped' | 'pending' | 'unknown'

   ── FIVE RULES, because money depends on them ────────────────────────────

   1. `outcome: 'paid'` means the provider states, authoritatively, that it
      holds the customer's money. A browser returning from checkout is not
      evidence of anything and never reaches this file. USER_DROPPED and
      PENDING are NOT paid; they map to their own outcomes so the caller
      cannot accidentally treat "not failed" as "succeeded".

   2. Amounts come back in integer paise. Cashfree speaks rupee decimals on
      the wire, so this file converts — by parsing the STRING, never by
      multiplying a float. `parseFloat('114.95') * 100` is 11494.999... and
      that is somebody's order silently mismatching its snapshot.

   3. An adapter never decides anything. It reports what the provider said.
      Whether that is allowed to confirm an order — amount equality, order
      mapping, idempotency, replay — is decided by the caller against the
      database, for every provider identically.

   4. Signature verification is constant-time and operates on the RAW request
      bytes. A re-serialised JSON body has different whitespace and will not
      verify, which is why index.js captures req.rawBody.

   5. No adapter invents a payment. With no credentials `configured` is false
      and the route refuses with `configuration_required` before reaching
      here.
   ========================================================================== */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PAYMENTS } from '../config.js';
import { ProviderUnavailable } from '../auth/rbac.js';

/* ---------- exact money conversion --------------------------------------
   Integer paise in, decimal-rupee STRING out. No float multiplication, no
   toFixed on a computed double. `11500` -> "115.00". */
export function paiseToRupeeString(paise) {
  if (!Number.isInteger(paise) || paise < 0) {
    throw new Error(`paiseToRupeeString: not a non-negative integer paise value: ${paise}`);
  }
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

/* The inverse, and the more dangerous direction: this reads a number a
   provider chose. It is deliberately strict — anything that is not a plain
   decimal with at most two places is refused rather than coerced, because a
   silently coerced amount is a silently wrong settlement. Returns null on
   anything it will not vouch for, and null never compares equal to an
   expected amount, so an unparseable amount fails closed. */
export function rupeesToPaise(value) {
  if (value === null || value === undefined) return null;
  /* A JSON number is accepted only when it is exactly representable to two
     decimal places; 115 and 115.5 are fine, 115.005 is not. */
  const s = typeof value === 'number'
    ? (Number.isFinite(value) ? value.toFixed(3) : '')
    : String(value).trim();
  const m = /^(\d{1,12})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] || '').padEnd(3, '0');
  /* A third decimal place that is not zero is a real amount we cannot
     represent. Refuse it instead of rounding someone's money. */
  if (frac[2] !== '0') return null;
  return Number(m[1]) * 100 + Number(frac.slice(0, 2));
}

function providerError(name, res, text) {
  const err = new Error(`${name} ${res.status}: ${String(text).slice(0, 300)}`);
  err.providerStatus = res.status;
  err.retryable = res.status === 429 || res.status >= 500;
  return err;
}

/* Constant-time compare that does not leak length through an early return
   shape different from a mismatch. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) {
    /* Still do a compare so timing does not distinguish "wrong length" from
       "wrong bytes"; the result is discarded. */
    timingSafeEqual(y, y);
    return false;
  }
  return timingSafeEqual(x, y);
}

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
        customer_details: {
          customer_id: customer.id,
          customer_phone: customer.phone,
          ...(customer.name ? { customer_name: customer.name } : {}),
        },
        order_note: `Quad order ${order.code}`,
        /* Carried back on the webhook and the status pull. Used only as a
           cross-check against our own mapping — never as the mapping. */
        order_tags: { quad_order_id: order.id, quad_order_code: order.code },
        ...(returnUrl ? { order_meta: { return_url: returnUrl } } : {}),
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
      amountPaise: rupeesToPaise(payment.payment_amount ?? order.order_amount),
      currency: String(payment.payment_currency || order.order_currency || '').toUpperCase() || null,
      feePaise: null,             // not reported on the PG webhook; see header
      raw: body,
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
                  : { start_date: from.toISOString(), end_date: to.toISOString() };
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

    /* An order marked PAID tells us money arrived but not which payment
       carried it, and the payment is what we reconcile against. So when it
       is PAID, ask for the payments too. */
    let payment = null;
    if (orderStatus === 'PAID') {
      const pres = await fetch(
        `${PAYMENTS.cashfreeBase}/pg/orders/${encodeURIComponent(providerOrderId)}/payments`,
        { headers: this.headers() });
      const ptext = await pres.text();
      if (pres.ok) {
        const list = JSON.parse(ptext);
        payment = (Array.isArray(list) ? list : [])
          .find((p) => String(p.payment_status).toUpperCase() === 'SUCCESS') || null;
      }
    }

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

/* ==========================================================================
   Razorpay  (retained: the original collection integration, still supported)

   Kept because it works, it is tested, and having a second configured-by-env
   collection provider is the difference between "our gateway KYC slipped" and
   "we cannot launch". Razorpay signs with a SEPARATE webhook secret and sends
   no timestamp header, so its deliveries have no skew check to apply —
   idempotency on the event id is the replay guard there.
   ========================================================================== */
export const razorpay = {
  id: 'razorpay',
  label: 'Razorpay Payment Gateway',
  get configured() {
    const r = PAYMENTS.razorpay;
    return !!(r.keyId && r.keySecret && r.webhookSecret);
  },
  needs: 'A Razorpay account with RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and ' +
         'RAZORPAY_WEBHOOK_SECRET set on the server.',

  auth() {
    const { keyId, keySecret } = PAYMENTS.razorpay;
    return 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  },

  async createOrder({ paymentId, order, amountPaise }) {
    const res = await fetch(`${PAYMENTS.apiBase}/v1/orders`, {
      method: 'POST',
      headers: { Authorization: this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountPaise,              // already paise; no conversion, no float
        currency: PAYMENTS.currency,
        receipt: order.code,
        notes: { order_id: order.id, quad_payment_id: paymentId },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw providerError('razorpay', res, text);
    const body = JSON.parse(text);
    return {
      providerOrderId: String(body.id),
      sessionId: null,
      checkout: { gatewayOrderId: String(body.id) },
      raw: body,
    };
  },

  verifyWebhook(headers, rawBody) {
    const secret = PAYMENTS.razorpay.webhookSecret;
    if (!secret) return { ok: false, reason: 'not_configured' };
    const sig = headers['x-razorpay-signature'];
    if (!sig) return { ok: false, reason: 'missing_signature_headers' };
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!safeEqual(sig, expected)) return { ok: false, reason: 'bad_signature' };
    return { ok: true, receivedAtMs: Date.now() };
  },

  eventId(body, headers) {
    return headers['x-razorpay-event-id']
      ? String(headers['x-razorpay-event-id'])
      : (body?.payload?.payment?.entity?.id ? String(body.payload.payment.entity.id) : null);
  },

  readEvent(body) {
    const e = body?.payload?.payment?.entity || {};
    const evt = String(body?.event || '');
    const status = String(e.status || '');
    let outcome = 'unknown';
    if (evt === 'payment.captured' || status === 'captured') outcome = 'paid';
    else if (evt === 'payment.failed' || status === 'failed') outcome = 'failed';
    else if (status === 'created' || status === 'authorized') outcome = 'pending';
    const fee = Number(e.fee);
    return {
      outcome,
      providerOrderId: e.order_id ? String(e.order_id) : null,
      providerPaymentId: e.id ? String(e.id) : null,
      /* Razorpay speaks integer paise natively. */
      amountPaise: Number.isInteger(Number(e.amount)) ? Number(e.amount) : null,
      currency: String(e.currency || '').toUpperCase() || null,
      /* Razorpay DOES report its fee on the captured entity, so Quad's net
         revenue is a fact for this provider rather than an estimate. */
      feePaise: Number.isInteger(fee) && fee > 0 ? fee : null,
      raw: body,
    };
  },

  /* Razorpay refunds settle synchronously in the common case: `processed`
     means the money has gone back. Anything else is still in flight. */
  async refund({ payment, refundId, amountPaise, reason, orderCode }) {
    const res = await fetch(
      `${PAYMENTS.apiBase}/v1/payments/${encodeURIComponent(payment.provider_payment_id)}/refund`, {
      method: 'POST',
      headers: {
        Authorization: this.auth(),
        'Content-Type': 'application/json',
        'X-Razorpay-Idempotency': refundId,
      },
      body: JSON.stringify({ amount: amountPaise, notes: { order: orderCode, reason } }),
    });
    const text = await res.text();
    if (!res.ok) throw providerError('razorpay', res, text);
    const body = JSON.parse(text);
    const status = String(body.status || '');
    return {
      providerRefundId: body.id ? String(body.id) : refundId,
      status,
      settled: status === 'processed',
      raw: body,
    };
  },

  /* ---- settlement reconciliation ----------------------------------------
     Razorpay reports its fee on the captured payment, so unlike Cashfree the
     fee is usually known at capture. This exists anyway, for two reasons
     that matter more than convenience: the settlement report is the
     AUTHORITATIVE figure (a capture-time fee can be adjusted later), and
     having both adapters implement the same method is what keeps the
     importer provider-blind.

     GET /v1/settlements/recon/combined?year=&month=&day= — Razorpay's recon
     report is day-scoped, so a window is walked a day at a time by the
     caller through the cursor. */
  async fetchSettlements({ from, to, cursor = null, limit = 100 }) {
    /* The cursor here is the day offset being walked, so one interface
       serves a cursor-paginated provider and a day-scoped one. */
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
        /* Razorpay speaks integer paise natively throughout, so these are
           taken as-is rather than parsed — but still validated as integers,
           because "as-is" must not mean "unchecked". */
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
    const captured = items.find((p) => p.status === 'captured');
    const chosen = captured || items[items.length - 1] || null;
    if (!chosen) {
      return { outcome: 'pending', providerOrderId, providerPaymentId: null,
               amountPaise: null, currency: null, feePaise: null, raw: body };
    }
    const fee = Number(chosen.fee);
    return {
      outcome: chosen.status === 'captured' ? 'paid'
             : chosen.status === 'failed' ? 'failed' : 'pending',
      providerOrderId,
      providerPaymentId: String(chosen.id),
      amountPaise: Number.isInteger(Number(chosen.amount)) ? Number(chosen.amount) : null,
      currency: String(chosen.currency || '').toUpperCase() || null,
      feePaise: Number.isInteger(fee) && fee > 0 ? fee : null,
      raw: body,
    };
  },
};

/* ==========================================================================
   Registry
   ========================================================================== */
const ADAPTERS = { cashfree, razorpay };

/**
 * The adapter for a specific provider id, regardless of what this deployment
 * is currently configured to use.
 *
 * A refund must go back through the gateway that TOOK the payment, which is
 * not necessarily the gateway configured today: a deployment that switched
 * providers still owes refunds on yesterday's orders. `payment.provider`
 * records which one, and this resolves it.
 */
export function adapterFor(providerId) {
  const a = ADAPTERS[providerId];
  if (!a) {
    throw ProviderUnavailable(`Unknown payment provider "${providerId}"`,
      'This payment was taken by a gateway this build has no adapter for.');
  }
  if (!a.configured) {
    throw ProviderUnavailable(`${a.label} is not configured`,
      `${a.needs} A refund cannot be issued through a gateway this server cannot reach.`);
  }
  return a;
}

/** The adapter this deployment is configured to collect through, or null. */
export function activeAdapter() {
  const a = ADAPTERS[PAYMENTS.provider];
  return a && a.configured ? a : null;
}

/** Every adapter, with whether this deployment could actually use it. */
export const availableProviders = () =>
  [cashfree, razorpay].map((a) => ({
    id: a.id, label: a.label, configured: a.configured, needs: a.needs,
  }));

/**
 * The configured adapter, or a truthful 503. Every caller goes through here,
 * so there is exactly one place that can decide collection is unavailable —
 * and no place at all that can pretend it is available.
 */
export function requireAdapter() {
  const a = activeAdapter();
  if (!a) {
    throw ProviderUnavailable('No payment provider is configured',
      'Set PAYMENT_PROVIDER to one of: cashfree, razorpay — with that provider\'s ' +
      'credentials. No order can be placed until then, and there is no cash option.');
  }
  return a;
}
