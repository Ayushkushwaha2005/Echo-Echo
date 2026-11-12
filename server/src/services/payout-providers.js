/* ==========================================================================
   QUAD — PAYOUT PROVIDER ADAPTERS

   One interface, several providers, so which one Quad uses is a deployment
   decision rather than a rewrite. Cashfree Payouts was retired on 12 November
   2026 (docs/CASHFREE-RETIREMENT.md); its adapter below fails closed.

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
   Cashfree Payouts — RETIRED (12 November 2026)

   Cashfree is no longer used by ECHO ECHO. This adapter keeps its id so the
   payout and payout_destination rows written while it was live
   (`method = 'cashfree_payouts'`, `provider = 'cashfree'`) still resolve to
   a known provider, and it fails closed: `configured` is always false, no
   CASHFREE_* variable is read, and every call refuses with a 503 that names
   the retirement. Nothing here can send money, register a beneficiary or
   accept a webhook. See docs/CASHFREE-RETIREMENT.md.
   ========================================================================== */
const CASHFREE_RETIRED = 'Cashfree Payouts was retired from ECHO ECHO on 12 November 2026 and ' +
  'cannot be configured or called. Settlements are paid by bank transfer and recorded by an ' +
  'administrator with the bank reference, or through another configured payout provider. ' +
  'See docs/CASHFREE-RETIREMENT.md.';
const cashfreeRetired = () => ProviderUnavailable('Cashfree Payouts is retired', CASHFREE_RETIRED);

export const cashfree = Object.freeze({
  id: 'cashfree_payouts',
  label: 'Cashfree Payouts (retired)',
  retired: true,
  get configured() { return false; },
  needs: CASHFREE_RETIRED,
  async send() { throw cashfreeRetired(); },
  async createBeneficiary() { throw cashfreeRetired(); },
  async fetchBeneficiary() { throw cashfreeRetired(); },
  async fetchTransfer() { throw cashfreeRetired(); },
  verifyWebhook() { return { ok: false, reason: 'provider_retired' }; },
  readWebhook() { throw cashfreeRetired(); },
});

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
      'Set PAYOUT_PROVIDER to razorpayx with that provider\'s ' +
      'credentials — or record the transfer manually with its bank reference. ' +
      'Nothing here will claim a transfer that did not happen.');
  }
  const out = await adapter.send(payout, destination);
  return { ...out, method: adapter.id };
}
