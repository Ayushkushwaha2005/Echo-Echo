/* ==========================================================================
   QUAD — SETTLEMENT AND PAYOUTS

   What Razorpay actually does, stated plainly, because assuming otherwise is
   the expensive mistake here:

     A standard Razorpay account COLLECTS. The customer's 115 rupees lands in
     ONE Quad account, less Razorpay's fee. Nothing about that arrangement
     pays the cafeteria 98 or the partner 10. Razorpay Route (split
     settlements) and RazorpayX (payouts) are separate products with their
     own onboarding, and neither is implied by working checkout.

   So the split lives in Quad's ledger, and the disbursement is an outbound
   transfer made afterwards. Two mechanisms, both honest:

     razorpayx            a real API call to RazorpayX Payouts. Needs a
                          RazorpayX current account, credentials, and each
                          payee provisioned there as a fund account.
     manual_bank_transfer an administrator makes the transfer in their bank
                          and records the UTR here. Nothing is marked paid
                          without that reference.

   There is no third mechanism, and in particular there is no path that marks
   a payout paid because a button was clicked. The `paid_has_evidence` CHECK
   on the payout table enforces that in the database, not just here.

   Amounts are never guessed. A payout is the payee's CURRENT outstanding
   ledger balance at the moment the batch is built, read under a row lock,
   and paying it posts a ledger transaction that discharges exactly that
   much. Overlapping periods are therefore impossible: a second batch built a
   minute later sees a balance already reduced by the first.
   ========================================================================== */
import { PAYOUTS } from '../config.js';
import { ProviderUnavailable, Conflict, BadRequest } from '../auth/rbac.js';
import { postPayout } from './ledger.js';
import { sendPayout, activeAdapter } from './payout-providers.js';

/* ---------- building a batch ---------------------------------------------
   `daily` and `weekly` are just labels on the period; what makes a batch
   correct is the balance it reads, not the window it claims.               */

/**
 * Create a batch and one pending payout per payee with a positive balance.
 *
 * Runs entirely inside one transaction, and locks each payable account's
 * entries before reading the balance, so two administrators pressing the
 * button at the same moment cannot both create a payout for the same payee.
 * The partial unique index `one_live_payout_per_payee` is the backstop.
 */
export async function buildBatch(c, { kind, periodStart, periodEnd, minPaise, actorId, note,
                                      periodKey = null, origin = 'manual' }) {
  if (!['cafeteria', 'partner'].includes(kind)) throw BadRequest('kind must be cafeteria or partner');
  const floor = Number.isInteger(minPaise) && minPaise > 0 ? minPaise : 1;

  /* `period_key` is what makes a scheduled run repeatable: the UNIQUE index
     on (kind, period_key) rejects a second batch for the same evening, so
     the scheduler can attempt the build as often as it likes. */
  const batch = (await c.query(
    `INSERT INTO payout_batch (kind, period_start, period_end, created_by, note,
                               period_key, origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [kind, periodStart || null, periodEnd || null, actorId, note || null,
     periodKey, origin])).rows[0];

  /* Lock the accounts of this kind for the duration, so the balances read
     below cannot move underneath us. Locking the account rows (not the
     entries) is enough: every posting resolves its account through
     accountId(), which takes a row lock via INSERT ... ON CONFLICT DO
     UPDATE, and therefore blocks here. */
  const accountKind = kind === 'cafeteria' ? 'cafeteria_payable' : 'delivery_payable';
  await c.query(`SELECT id FROM ledger_account WHERE kind = $1 FOR UPDATE`, [accountKind]);

  const { rows: owed } = await c.query(
    `SELECT vendor_id, partner_id, balance_paise
       FROM v_account_balance WHERE kind = $1 AND balance_paise >= $2`,
    [accountKind, floor]);

  const created = [];
  const skipped = [];
  for (const row of owed) {
    const amount = Number(row.balance_paise);
    /* A payee already has money in flight — do not queue a second transfer
       for the same balance. This is the duplicate-payout case. */
    const live = await c.query(
      `SELECT id FROM payout
        WHERE state IN ('pending','processing')
          AND vendor_id IS NOT DISTINCT FROM $1 AND partner_id IS NOT DISTINCT FROM $2`,
      [row.vendor_id, row.partner_id]);
    if (live.rowCount) {
      skipped.push({ vendorId: row.vendor_id, partnerId: row.partner_id,
                     amountPaise: amount, reason: 'a payout is already in flight' });
      continue;
    }
    const dest = await c.query(
      `SELECT id FROM payout_destination
        WHERE active AND provider = $3
          AND vendor_id IS NOT DISTINCT FROM $1 AND partner_id IS NOT DISTINCT FROM $2`,
      [row.vendor_id, row.partner_id, PAYOUTS.provider || 'none']);

    const p = (await c.query(
      `INSERT INTO payout (batch_id, vendor_id, partner_id, amount_paise,
                           destination_id, initiated_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [batch.id, row.vendor_id, row.partner_id, amount,
       dest.rows[0]?.id || null, actorId])).rows[0];
    created.push(p);
  }
  return { batch, payouts: created, skipped };
}

/**
 * Release an approved batch: send every still-pending payout through the
 * configured provider.
 *
 * With NO provider this returns the list of transfers to make and pays
 * nobody — the honest answer, and the one the route surfaces.
 *
 * One payee's failure never stops the rest: each line is caught, marked
 * `failed` with its reason, and the release reports it. Because a failure
 * touches no ledger entry, re-releasing the batch retries exactly the lines
 * that are still outstanding and skips the ones already paid.
 *
 * @param deps  { q, tx } from db/index.js, injected so this stays testable
 *              and so the caller controls transaction boundaries.
 */
export async function releaseBatch({ q, tx }, { batch, actorId }) {
  const lines = (await q(
    `SELECT p.*, d.provider_fund_account_id
       FROM payout p LEFT JOIN payout_destination d ON d.id = p.destination_id
      WHERE p.batch_id = $1 AND p.state = 'pending'`, [batch.id])).rows;

  if (!PAYOUTS.configured) {
    return {
      released: 0,
      mode: 'manual_bank_transfer',
      toTransfer: lines.map((p) => ({ payoutId: p.id, amountPaise: p.amount_paise,
                                      vendorId: p.vendor_id, partnerId: p.partner_id })),
      totalPaise: lines.reduce((t, p) => t + p.amount_paise, 0),
      paid: [], submitted: [], failed: [], skipped: [],
      note: 'No payout provider is connected, so nothing was sent. Make each transfer from ' +
            'your bank and record it with POST /admin/payouts/:id/record and its UTR. ' +
            'Amounts owed remain tracked either way.',
    };
  }

  const out = { paid: [], submitted: [], failed: [], skipped: [] };
  for (const p of lines) {
    if (!p.provider_fund_account_id) {
      out.skipped.push({ payoutId: p.id, amountPaise: p.amount_paise,
                         reason: 'no fund account provisioned for this payee' });
      continue;
    }
    try {
      await q(`UPDATE payout SET state='processing', method=$2 WHERE id=$1`,
              [p.id, PAYOUTS.method]);
      const r = await sendPayout(p, { provider_fund_account_id: p.provider_fund_account_id });
      if (r.settled) {
        await tx((c) => settle(c, p.id, { method: r.method,
          providerPayoutId: r.providerPayoutId, externalReference: r.utr, actorId }));
        out.paid.push({ payoutId: p.id, amountPaise: p.amount_paise });
      } else {
        /* Queued or processing at the provider. NOT paid: the payable stays
           outstanding until the money actually moves. */
        await q(`UPDATE payout SET provider_payout_id=$2 WHERE id=$1`, [p.id, r.providerPayoutId]);
        out.submitted.push({ payoutId: p.id, providerStatus: r.status });
      }
    } catch (e) {
      await q(`UPDATE payout SET state='failed', failure_reason=$2 WHERE id=$1`,
              [p.id, String(e.message).slice(0, 300)]);
      out.failed.push({ payoutId: p.id, error: String(e.message).slice(0, 200) });
    }
  }
  return { released: out.paid.length, mode: PAYOUTS.method, ...out,
           totalPaise: lines.reduce((t, p) => t + p.amount_paise, 0) };
}

/* ---------- executing through a provider ---------------------------------- */

/**
 * Send one payout through the configured provider.
 *
 * The provider-specific request construction lives in
 * services/payout-providers.js; this is the seam every caller goes through,
 * so nothing in the settlement or route layer names a provider.
 *
 * This is a real outbound API call. With no credentials it never happens:
 * the route refuses with `configuration_required` first.
 */
export async function sendToProvider(payout, destination) {
  if (!PAYOUTS.configured) {
    throw ProviderUnavailable('No payout provider is configured',
      "Set PAYOUT_PROVIDER (razorpayx or cashfree) with that provider's credentials, " +
      'or record the transfer manually with its bank reference.');
  }
  return sendPayout(payout, destination);
}

/* The adapter this deployment would use, for status surfaces. */
export const payoutAdapter = () => activeAdapter();

/**
 * Mark a payout paid and post the ledger transaction that discharges the
 * payable. The two happen in one database transaction: a payout can never be
 * paid without its ledger entry, or carry a ledger entry without being paid.
 *
 * `postPayout` is idempotent on the payout id, so even a double call cannot
 * discharge the same payable twice.
 */
export async function settle(c, payoutId, { method, providerPayoutId = null,
                                            externalReference = null, actorId }) {
  const p = (await c.query(`SELECT * FROM payout WHERE id = $1 FOR UPDATE`, [payoutId])).rows[0];
  if (!p) throw Conflict('No such payout');
  if (p.state === 'paid') throw Conflict('That payout is already paid',
    `Marked paid at ${p.paid_at?.toISOString?.() || p.paid_at}` +
    (p.external_reference ? ` with reference ${p.external_reference}` : ''));
  if (['cancelled', 'failed'].includes(p.state)) {
    throw Conflict(`That payout is ${p.state} and cannot be settled`);
  }
  if (!providerPayoutId && !externalReference) {
    throw BadRequest('A settled payout needs the transfer it refers to',
      'Supply the provider payout id, or the bank reference (UTR) of the transfer you made.');
  }

  const paid = (await c.query(
    `UPDATE payout SET state='paid', method=$2, provider_payout_id=COALESCE($3, provider_payout_id),
            external_reference=COALESCE($4, external_reference), recorded_by=$5, paid_at=now()
      WHERE id=$1 RETURNING *`,
    [p.id, method, providerPayoutId, externalReference, actorId])).rows[0];

  const posting = await postPayout(c, { payout: paid });
  return { payout: paid, posting };
}
