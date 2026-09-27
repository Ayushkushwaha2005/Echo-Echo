/* ==========================================================================
   QUAD — PAYOUT PROVIDER ADAPTERS

   One interface, several providers, so which one Quad uses is a deployment
   decision rather than a rewrite. This matters more than it looks: the
   provider recommendation for the pilot (Cashfree) is not the provider the
   original implementation assumed (RazorpayX), and the eligibility rules
   that decide it are outside Quad's control and can change.

   Every adapter exports the same shape:

     id          the value written to payout.method
     label       for an operator reading a dashboard
     configured  whether THIS deployment can actually call it
     send(payout, destination) -> { providerPayoutId, status, settled, utr }

   Three rules every adapter obeys, because money depends on them:

   1. `settled: true` means the money has LEFT. Not accepted, not queued, not
      "processing" — left. Everything else comes back settled:false and the
      payable stays outstanding until a later status check or webhook says
      otherwise. A payout marked paid too early is a payable discharged for a
      transfer that may still fail.

   2. Amounts are passed through untouched, in integer paise, exactly as the
      ledger computed them. No adapter reformats, rounds, or converts to
      rupees — a float in this file would be a rounding error in someone's
      settlement.

   3. Every request carries an idempotency key derived from the payout id, so
      a retried HTTP call returns the ORIGINAL transfer instead of making a
      second one. This is the outermost duplicate-payout guard; the partial
      unique index on `payout` and the ledger's (kind, ref) uniqueness are
      the inner two.

   No adapter invents a transfer. With no credentials, `configured` is false
   and the route refuses with `configuration_required` before reaching here.
   ========================================================================== */
import { PAYOUTS } from '../config.js';
import { createHmac, timingSafeEqual, publicEncrypt, constants as cryptoConstants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ProviderUnavailable, Conflict } from '../auth/rbac.js';

/* A provider error carries its HTTP status so the caller can tell a
   permanent rejection from something worth retrying. */
function providerError(name, res, text) {
  const err = new Error(`${name} ${res.status}: ${String(text).slice(0, 300)}`);
  err.providerStatus = res.status;
  /* 4xx other than 429 means the request itself is wrong: retrying it
     unchanged will fail identically, so a retry loop must not. */
  err.retryable = res.status === 429 || res.status >= 500;
  return err;
}

/* ==========================================================================
   RazorpayX Payouts
   ========================================================================== */
export const razorpayx = {
  id: 'razorpayx',
  label: 'RazorpayX Payouts',
  get configured() {
    const x = PAYOUTS.razorpayx;
    return !!(x.accountNumber && x.keyId && x.keySecret);
  },
  needs: 'A RazorpayX current account, plus each payee provisioned there as a contact and a fund account.',

  async send(payout, destination) {
    if (!destination?.provider_fund_account_id) {
      throw Conflict('This payee has no RazorpayX fund account',
        'Provision the payee as a contact and fund account in the RazorpayX dashboard, then ' +
        'record the fund account id against them. Quad does not store bank account numbers.');
    }
    const { accountNumber, keyId, keySecret, mode } = PAYOUTS.razorpayx;
    const res = await fetch(`${PAYOUTS.apiBase}/v1/payouts`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
        'Content-Type': 'application/json',
        /* RazorpayX's own replay guard: the same key returns the original
           payout rather than making a second transfer. */
        'X-Payout-Idempotency': payout.id,
      },
      body: JSON.stringify({
        account_number: accountNumber,
        fund_account_id: destination.provider_fund_account_id,
        amount: payout.amount_paise,          // already paise; no float anywhere
        currency: 'INR',
        mode,
        purpose: 'payout',
        queue_if_low_balance: true,
        reference_id: payout.id,
        narration: 'Quad settlement',
      }),
    });
    const text = await res.text();
    if (!res.ok) throw providerError('razorpayx', res, text);
    const body = JSON.parse(text);
    return {
      providerPayoutId: body.id,
      status: body.status,
      /* queued -> processing -> processed. Only `processed` has left. */
      settled: body.status === 'processed',
      utr: body.utr || null,
    };
  },
};

/* ==========================================================================
   Cashfree Payouts

   Cashfree authenticates payouts with a client id / client secret pair sent
   as headers, and identifies a payee by a beneficiary id that Quad stores in
   payout_destination exactly as it stores a RazorpayX fund account id — the
   bank details themselves live at the provider, never here.

   `transfer_id` is both our reference and the idempotency key: Cashfree
   rejects a duplicate transfer_id rather than paying twice, which is the
   behaviour we want from a retry.
   ========================================================================== */
export const cashfree = {
  id: 'cashfree_payouts',
  label: 'Cashfree Payouts',
  get configured() {
    const c = PAYOUTS.cashfree;
    return !!(c.clientId && c.clientSecret);
  },
  needs: 'A Cashfree Payouts account, plus each payee added there as a beneficiary.',

  async send(payout, destination) {
    if (!destination?.provider_fund_account_id) {
      throw Conflict('This payee has no Cashfree beneficiary',
        'Add the payee as a beneficiary in the Cashfree dashboard, then record the ' +
        'beneficiary id against them. Quad does not store bank account numbers.');
    }
    const { mode } = PAYOUTS.cashfree;
    const res = await fetch(`${PAYOUTS.cashfreeBase}/payout/transfers`, {
      method: 'POST',
      /* Cashfree's request-level replay guard, on top of transfer_id. */
      headers: cashfreePayoutHeaders({ 'x-request-id': payout.id }),
      /* A transfer call that hangs is an UNKNOWN outcome, not a failure:
         the abort surfaces as a non-provider error, which dispatch treats as
         "processing, check status later" — never as a reason to resend. */
      signal: AbortSignal.timeout(PAYOUTS.cashfree.timeoutMs || 15000),
      body: JSON.stringify({
        /* Cashfree takes rupees as a decimal string. This is the ONE place a
           conversion happens, and it is exact: integer paise divided by 100
           and rendered to exactly two places, never a float multiplication. */
        transfer_amount: `${Math.floor(payout.amount_paise / 100)}.` +
                         String(payout.amount_paise % 100).padStart(2, '0'),
        transfer_id: payout.id,
        /* A UPI beneficiary is paid over UPI; a bank one over the
           configured bank rail (IMPS by default). */
        transfer_mode: destination.instrument === 'upi' ? 'upi' : mode,
        beneficiary_details: { beneficiary_id: destination.provider_fund_account_id },
        remarks: 'Quad settlement',
      }),
    });
    const text = await res.text();
    if (!res.ok) throw providerError('cashfree', res, text);
    const body = JSON.parse(text);
    return {
      providerPayoutId: body.cf_transfer_id ? String(body.cf_transfer_id) : payout.id,
      status: body.status,
      /* RECEIVED / APPROVED / PENDING mean accepted, not paid. Only SUCCESS
         is money that has left the account. */
      settled: body.status === 'SUCCESS',
      utr: body.transfer_utr || null,
    };
  },

  /* ---- beneficiaries ------------------------------------------------------
     The ONLY place a full bank account number or UPI id travels: from the
     request that carried it, straight to Cashfree, and never into the
     database or a log line. What comes back is an opaque beneficiary id and
     Cashfree's own verdict on the details.

     `verified` is true only when Cashfree says VERIFIED. INITIATED/PENDING
     leave the destination pending; INVALID/FAILED mark it failed. */
  async createBeneficiary({ beneficiaryId, name, instrument, accountNumber, ifsc, vpa, phone, email }) {
    const res = await fetch(`${PAYOUTS.cashfreeBase}/payout/beneficiary`, {
      method: 'POST',
      headers: cashfreePayoutHeaders({ 'x-request-id': beneficiaryId }),
      signal: AbortSignal.timeout(PAYOUTS.cashfree.timeoutMs || 15000),
      body: JSON.stringify({
        beneficiary_id: beneficiaryId,
        beneficiary_name: name,
        beneficiary_instrument_details: instrument === 'upi'
          ? { vpa }
          : { bank_account_number: accountNumber, bank_ifsc: ifsc },
        ...(phone || email ? { beneficiary_contact_details: {
          ...(phone ? { beneficiary_phone: String(phone).replace(/^\+91/, '') } : {}),
          ...(email ? { beneficiary_email: email } : {}) } } : {}),
      }),
    });
    const text = await res.text();
    /* Never echo the provider's body back: it may contain the account
       number we just sent. Only the status and a short code survive. */
    if (!res.ok) {
      let code = null;
      try { code = JSON.parse(text).code || null; } catch { /* not json */ }
      const err = new Error(`cashfree beneficiary ${res.status}${code ? ` ${code}` : ''}`);
      err.providerStatus = res.status;
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }
    const body = JSON.parse(text);
    const status = String(body.beneficiary_status || '').toUpperCase();
    return {
      beneficiaryId: String(body.beneficiary_id || beneficiaryId),
      status,
      verification: status === 'VERIFIED' ? 'verified'
        : ['INVALID', 'FAILED', 'CANCELLED', 'DELETED'].includes(status) ? 'failed' : 'pending',
    };
  },

  /* The authoritative answer for a transfer that was accepted but not yet
     settled. Looked up by OUR id, which is Cashfree's transfer_id. */
  async fetchTransfer(transferId) {
    const res = await fetch(
      `${PAYOUTS.cashfreeBase}/payout/transfers?transfer_id=${encodeURIComponent(transferId)}`,
      { headers: cashfreePayoutHeaders(), signal: AbortSignal.timeout(PAYOUTS.cashfree.timeoutMs || 15000) });
    const text = await res.text();
    if (res.status === 404) return { status: 'NOT_FOUND', outcome: 'not_found' };
    if (!res.ok) throw providerError('cashfree', res, text);
    const body = JSON.parse(text);
    return normaliseTransfer(body);
  },

  /* Payouts webhooks are signed like PG webhooks, with the payouts client
     secret: Base64(HMAC-SHA256(timestamp + rawBody)). */
  verifyWebhook(headers, rawBody) {
    const secret = PAYOUTS.cashfree.clientSecret;
    if (!secret) return { ok: false, reason: 'not_configured' };
    const ts = headers['x-webhook-timestamp'];
    const sig = headers['x-webhook-signature'];
    if (!ts || !sig) return { ok: false, reason: 'missing_signature_headers' };
    const expected = createHmac('sha256', secret)
      .update(String(ts) + rawBody.toString('utf8')).digest('base64');
    const a = Buffer.from(String(sig)); const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
    const n = Number(ts);
    const sentMs = n > 1e11 ? n : n * 1000;
    if (!Number.isFinite(n) || Math.abs(Date.now() - sentMs) > 300_000) {
      return { ok: false, reason: 'stale_timestamp' };
    }
    return { ok: true };
  },

  readWebhook(body) {
    const d = body?.data?.transfer || body?.data || {};
    return { eventType: String(body?.type || body?.event || '').toUpperCase(),
             ...normaliseTransfer({ ...d, status: d.status || body?.type }) };
  },
};

/* Cashfree transfer status -> the three outcomes Quad acts on. Anything not
   named here is 'processing': an unknown status is never paid and never
   failed, it is re-checked. */
function normaliseTransfer(t) {
  const raw = String(t.status || '').toUpperCase().replace(/^TRANSFER_/, '');
  const outcome = raw === 'SUCCESS' ? 'paid'
    : ['FAILED', 'REJECTED', 'REVERSED'].includes(raw) ? 'failed'
    : 'processing';
  return {
    transferId: t.transfer_id ? String(t.transfer_id) : null,
    providerPayoutId: t.cf_transfer_id != null ? String(t.cf_transfer_id) : null,
    status: raw, outcome,
    utr: t.transfer_utr || null,
    reason: t.status_description ? String(t.status_description).slice(0, 200) : null,
  };
}


/* Cashfree Payouts request headers. With a public key configured, each
   request is signed: RSA-OAEP (SHA-1, per Cashfree's reference
   implementation) over "<clientId>.<unix seconds>", base64, in
   X-Cf-Signature. A fresh timestamp per request, so a captured signature
   expires with Cashfree's window. */
let cfPublicKey;
function cashfreePayoutPublicKey() {
  if (cfPublicKey !== undefined) return cfPublicKey;
  const c = PAYOUTS.cashfree;
  cfPublicKey = c.publicKey ? c.publicKey.replace(/\\n/g, '\n')
    : c.publicKeyPath ? readFileSync(c.publicKeyPath, 'utf8') : null;
  return cfPublicKey;
}
export function cashfreePayoutHeaders(extra = {}) {
  const { clientId, clientSecret, apiVersion } = PAYOUTS.cashfree;
  const h = { 'x-client-id': clientId, 'x-client-secret': clientSecret,
              'x-api-version': apiVersion, 'Content-Type': 'application/json', ...extra };
  const key = cashfreePayoutPublicKey();
  if (key) {
    h['X-Cf-Signature'] = publicEncrypt(
      { key, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      Buffer.from(`${clientId}.${Math.floor(Date.now() / 1000)}`)).toString('base64');
  }
  return h;
}

/* ==========================================================================
   Registry
   ========================================================================== */
const ADAPTERS = { razorpayx, cashfree, cashfree_payouts: cashfree };

/** The adapter this deployment is configured to use, or null. */
export function activeAdapter() {
  const a = ADAPTERS[PAYOUTS.provider];
  return a && a.configured ? a : null;
}

/** Every adapter, with whether this deployment could actually use it. */
export const availableProviders = () =>
  [razorpayx, cashfree].map((a) => ({
    id: a.id, label: a.label, configured: a.configured, needs: a.needs,
  }));

/**
 * Send one payout through whichever provider is configured.
 *
 * Provider-agnostic by construction: nothing above this function names a
 * provider, so adding a third one is a new adapter and a config block, not a
 * change to the payout, settlement or ledger code.
 */
export async function sendPayout(payout, destination) {
  const adapter = activeAdapter();
  if (!adapter) {
    throw ProviderUnavailable('No payout provider is configured',
      'Set PAYOUT_PROVIDER to one of: razorpayx, cashfree — with that provider\'s ' +
      'credentials — or record the transfer manually with its bank reference. ' +
      'Nothing here will claim a transfer that did not happen.');
  }
  const out = await adapter.send(payout, destination);
  return { ...out, method: adapter.id };
}
