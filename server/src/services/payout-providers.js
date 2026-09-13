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
    const { clientId, clientSecret, mode, apiVersion } = PAYOUTS.cashfree;
    const res = await fetch(`${PAYOUTS.cashfreeBase}/payout/transfers`, {
      method: 'POST',
      headers: {
        'x-client-id': clientId,
        'x-client-secret': clientSecret,
        'x-api-version': apiVersion,
        'Content-Type': 'application/json',
        /* Cashfree's request-level replay guard, on top of transfer_id. */
        'x-request-id': payout.id,
      },
      body: JSON.stringify({
        /* Cashfree takes rupees as a decimal string. This is the ONE place a
           conversion happens, and it is exact: integer paise divided by 100
           and rendered to exactly two places, never a float multiplication. */
        transfer_amount: `${Math.floor(payout.amount_paise / 100)}.` +
                         String(payout.amount_paise % 100).padStart(2, '0'),
        transfer_id: payout.id,
        transfer_mode: mode,
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
};

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
