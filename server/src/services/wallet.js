/* ==========================================================================
   ECHO ECHO — PARTNER WALLET, WITHDRAWALS, PAYOUT DISPATCH

   A delivery partner's money, from the partner's side:

     earned     a delivery_earned ledger posting, made when the customer's
                handoff code was verified. Nothing before that is earned.
     pending    earned, but younger than the hold window, or on an order with
                an open delivery incident. Visible, not withdrawable.
     available  ledger balance − pending − anything already in flight.
     requested  a payout row (origin 'withdrawal', state 'pending').
     processing sent to the payout provider, not yet confirmed.
     paid       the provider confirmed the transfer (or an administrator
                recorded their own bank transfer with its UTR). Only now is
                the payable discharged in the ledger.
     failed     the provider refused or reversed it. The ledger was never
                touched, so the money is simply available again.

   Every number here is READ from the ledger. Nothing in this file adds up
   deliveries by multiplying today's rate by a count.

   Idempotency, from the outside in:
     1. the partner's Idempotency-Key, unique per partner (payout table)
     2. one live payout per payee (partial unique index)
     3. our payout id is Cashfree's transfer_id, which it refuses to reuse
     4. the ledger posting is unique on (kind='payout', ref=payout id)
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { PAYOUTS } from '../config.js';
import { BadRequest, Conflict } from '../auth/rbac.js';
import { settle } from './payouts.js';
import { activeAdapter } from './payout-providers.js';
import { isoWeekKey, localParts } from './settlement.js';

export const PAYOUT_DEFAULTS = {
  frequency: 'weekly',
  min_withdrawal_paise: 10000,
  min_balance_paise: 10000,
  method: 'bank_or_upi',
  earning_hold_hours: 24,
};
const FREQUENCIES = ['weekly', 'daily', 'on_request'];
const METHODS = ['bank', 'upi', 'bank_or_upi'];

export async function payoutConfig(c = { query: q }) {
  const r = (await c.query(`SELECT value FROM platform_config WHERE key='partner_payout_config'`)).rows[0];
  return { ...PAYOUT_DEFAULTS, ...(r?.value || {}) };
}

/** Validate an admin's change. Returns the full new config. */
export function validatePayoutConfig(current, patch) {
  const next = { ...current };
  for (const k of ['min_withdrawal_paise', 'min_balance_paise']) {
    if (patch[k] !== undefined) {
      const n = Number(patch[k]);
      if (!Number.isInteger(n) || n < 100 || n > 10_000_000) {
        throw BadRequest(`${k} must be whole paise between 100 and 10000000`);
      }
      next[k] = n;
    }
  }
  if (patch.earning_hold_hours !== undefined) {
    const n = Number(patch.earning_hold_hours);
    if (!Number.isInteger(n) || n < 0 || n > 720) throw BadRequest('earning_hold_hours must be 0–720');
    next.earning_hold_hours = n;
  }
  if (patch.frequency !== undefined) {
    if (!FREQUENCIES.includes(patch.frequency)) throw BadRequest(`frequency must be one of ${FREQUENCIES.join(', ')}`);
    next.frequency = patch.frequency;
  }
  if (patch.method !== undefined) {
    if (!METHODS.includes(patch.method)) throw BadRequest(`method must be one of ${METHODS.join(', ')}`);
    next.method = patch.method;
  }
  return next;
}

/* ---------- reading the wallet ------------------------------------------- */

/**
 * Pending earnings: delivery_earned credits still inside the hold window, or
 * on an order with an unresolved incident. Returned in paise.
 */
async function pendingEarnings(c, partnerId, holdHours) {
  const r = (await c.query(
    `SELECT COALESCE(sum(-e.amount_paise),0)::bigint AS n
       FROM ledger_entry e
       JOIN ledger_txn t ON t.id = e.txn_id AND t.kind = 'delivery_earned'
       JOIN ledger_account a ON a.id = e.account_id
                            AND a.kind = 'delivery_payable' AND a.partner_id = $1
      WHERE t.created_at > now() - ($2 || ' hours')::interval
         OR EXISTS (SELECT 1 FROM delivery_incident i
                     WHERE i.order_id = t.order_id AND i.state <> 'resolved')`,
    [partnerId, String(holdHours)])).rows[0];
  return Number(r.n);
}

export async function walletNumbers(c, partnerId, cfg) {
  const bal = Number((await c.query(
    `SELECT COALESCE(sum(balance_paise),0)::bigint AS n FROM v_account_balance
      WHERE kind = 'delivery_payable' AND partner_id = $1`, [partnerId])).rows[0].n);
  const earned = Number((await c.query(
    `SELECT COALESCE(sum(-e.amount_paise),0)::bigint AS n
       FROM ledger_entry e JOIN ledger_txn t ON t.id = e.txn_id AND t.kind = 'delivery_earned'
       JOIN ledger_account a ON a.id = e.account_id AND a.kind='delivery_payable' AND a.partner_id=$1`,
    [partnerId])).rows[0].n);
  const inflight = Number((await c.query(
    `SELECT COALESCE(sum(amount_paise),0)::bigint AS n FROM payout
      WHERE partner_id = $1 AND state IN ('pending','processing')`, [partnerId])).rows[0].n);
  const pending = Math.min(await pendingEarnings(c, partnerId, cfg.earning_hold_hours), Math.max(bal, 0));
  const available = Math.max(0, bal - pending - inflight);
  return { balancePaise: bal, totalEarnedPaise: earned, pendingPaise: pending,
           inFlightPaise: inflight, availablePaise: available };
}

/* The window a withdrawal counts against, so 'weekly' means once a week. */
function periodKey(freq, now = new Date()) {
  if (freq === 'weekly') return isoWeekKey(now, 'Asia/Kolkata');
  if (freq === 'daily') return localParts(now, 'Asia/Kolkata').date;
  return null;
}

async function withdrawnThisPeriod(c, partnerId, freq) {
  const key = periodKey(freq);
  if (!key) return null;
  const rows = (await c.query(
    `SELECT id, created_at FROM payout
      WHERE partner_id = $1 AND origin = 'withdrawal' AND state IN ('pending','processing','paid')
        AND created_at > now() - interval '8 days'`, [partnerId])).rows;
  return rows.find((r) => periodKey(freq, new Date(r.created_at)) === key) || null;
}

export async function destinationFor(c, { vendorId = null, partnerId = null }) {
  return (await c.query(
    `SELECT * FROM payout_destination
      WHERE active AND vendor_id IS NOT DISTINCT FROM $1 AND partner_id IS NOT DISTINCT FROM $2
      ORDER BY (verification_status = 'verified') DESC, (provider = $3) DESC, created_at DESC LIMIT 1`,
    [vendorId, partnerId, String(PAYOUTS.provider || '').replace('_payouts', '')])).rows[0] || null;
}

const shapeDestination = (d) => d && ({
  id: d.id, instrument: d.instrument, masked: d.masked, ifsc: d.ifsc,
  holderName: d.holder_name, status: d.verification_status, verifiedAt: d.verified_at,
});

const PARTNER_STATE = {
  pending: 'Withdrawal requested', processing: 'Processing',
  paid: 'Paid', failed: 'Failed', cancelled: 'Cancelled',
};

/** Everything the partner's wallet screen shows. Their own numbers only. */
export async function partnerWallet(partnerId) {
  const c = { query: q };
  const cfg = await payoutConfig(c);
  const n = await walletNumbers(c, partnerId, cfg);
  const dest = await destinationFor(c, { partnerId });
  const history = (await q(
    `SELECT id, amount_paise, state, origin, method, external_reference, provider_status,
            failure_reason, created_at, paid_at, failed_at, retry_of
       FROM payout WHERE partner_id = $1 ORDER BY created_at DESC LIMIT 50`, [partnerId])).rows
    .map((p) => ({ ...p, label: PARTNER_STATE[p.state] || p.state }));
  const last = history.find((p) => p.state === 'paid') || null;
  const already = await withdrawnThisPeriod(c, partnerId, cfg.frequency);

  const blockers = [];
  if (!dest) blockers.push('Add a bank account or UPI ID to receive payouts.');
  else if (dest.verification_status !== 'verified') {
    blockers.push(dest.verification_status === 'failed'
      ? 'Your payout details could not be verified. Add them again.'
      : 'Your payout details are being verified.');
  }
  if (n.inFlightPaise > 0) blockers.push('A withdrawal is already in progress.');
  if (n.availablePaise < cfg.min_withdrawal_paise) {
    blockers.push(`You can withdraw once your available balance reaches ₹${(cfg.min_withdrawal_paise / 100).toFixed(2)}. ` +
      `₹${((cfg.min_withdrawal_paise - n.availablePaise) / 100).toFixed(2)} to go.`);
  }
  if (already) blockers.push(`You have already withdrawn this ${cfg.frequency === 'daily' ? 'day' : 'week'}.`);

  return {
    ...n,
    minWithdrawalPaise: cfg.min_withdrawal_paise,
    frequency: cfg.frequency,
    holdHours: cfg.earning_hold_hours,
    canWithdraw: blockers.length === 0,
    blockers,
    nextEligibility: already ? nextPeriodStart(cfg.frequency) : null,
    destination: shapeDestination(dest),
    lastPayout: last,
    history,
  };
}

function nextPeriodStart(freq, now = new Date()) {
  const t = localParts(now, 'Asia/Kolkata');
  const d = new Date(Date.UTC(t.year, t.month - 1, t.day));
  if (freq === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else d.setUTCDate(d.getUTCDate() + ((8 - (t.weekday || 7)) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

/* ---------- requesting a withdrawal -------------------------------------- */

export async function requestWithdrawal(partnerId, { idempotencyKey, actorId }) {
  const key = String(idempotencyKey || '').trim().slice(0, 120);
  if (key.length < 8) {
    throw BadRequest('An idempotency key is required',
      'Send a unique Idempotency-Key per withdrawal so a double tap cannot pay twice.');
  }
  const created = await tx(async (c) => {
    /* One partner, one withdrawal decision at a time. */
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('withdraw:' || $1))`, [partnerId]);
    const seen = (await c.query(
      `SELECT * FROM payout WHERE partner_id = $1 AND idempotency_key = $2`, [partnerId, key])).rows[0];
    if (seen) return { payout: seen, duplicate: true };

    const cfg = await payoutConfig(c);
    const dest = await destinationFor(c, { partnerId });
    if (!dest || dest.verification_status !== 'verified') {
      throw Conflict('Your payout details are not verified yet',
        'Add a bank account or UPI ID; withdrawals open once it is verified.');
    }
    if (cfg.method === 'bank' && dest.instrument === 'upi') throw Conflict('Payouts are currently made to bank accounts only');
    if (cfg.method === 'upi' && dest.instrument === 'bank') throw Conflict('Payouts are currently made to UPI only');
    const n = await walletNumbers(c, partnerId, cfg);
    if (n.inFlightPaise > 0) throw Conflict('A withdrawal is already in progress');
    if (n.availablePaise < cfg.min_withdrawal_paise) {
      throw Conflict(`The minimum withdrawal is ₹${(cfg.min_withdrawal_paise / 100).toFixed(2)}`,
        `Available now: ₹${(n.availablePaise / 100).toFixed(2)}` +
        (n.pendingPaise ? `; ₹${(n.pendingPaise / 100).toFixed(2)} is still pending.` : '.'));
    }
    if (await withdrawnThisPeriod(c, partnerId, cfg.frequency)) {
      throw Conflict(`Withdrawals are ${cfg.frequency}; you have already withdrawn in this period`);
    }
    const p = (await c.query(
      `INSERT INTO payout (partner_id, amount_paise, destination_id, initiated_by, origin, idempotency_key)
       VALUES ($1,$2,$3,$4,'withdrawal',$5) RETURNING *`,
      [partnerId, n.availablePaise, dest.id, actorId, key])).rows[0];
    return { payout: p, duplicate: false };
  });
  if (created.duplicate) return { ...created, dispatched: null };
  const dispatched = PAYOUTS.configured ? await dispatchPayout(created.payout.id, { actorId }) : null;
  const fresh = await one(`SELECT * FROM payout WHERE id = $1`, [created.payout.id]);
  return { payout: fresh, duplicate: false, dispatched };
}

/* ---------- sending one payout ------------------------------------------- */

/**
 * Send one pending payout through the configured provider and record what
 * the provider said. Shared by withdrawals, batch release and the admin
 * execute route.
 *
 * The rule that matters: only a DEFINITE refusal marks a payout failed. A
 * timeout, a 5xx or a dropped connection means we do not know whether the
 * transfer exists, so the payout stays 'processing' and is resolved by a
 * status sync against the same transfer_id — never by sending a second one.
 */
export async function dispatchPayout(payoutId, { actorId = null } = {}) {
  const adapter = activeAdapter();
  if (!adapter) return { state: 'pending', note: 'no payout provider configured' };

  const claimed = await one(
    `UPDATE payout p SET state='processing', method=$2
       FROM payout_destination d
      WHERE p.id=$1 AND p.state='pending' AND d.id = p.destination_id
        AND d.verification_status = 'verified'
      RETURNING p.*, d.provider_fund_account_id`, [payoutId, PAYOUTS.method]);
  if (!claimed) return { state: 'skipped', note: 'not pending, or no verified destination' };

  let r;
  try {
    r = await adapter.send(claimed, { provider_fund_account_id: claimed.provider_fund_account_id });
  } catch (e) {
    const definite = e.providerStatus && !e.retryable;
    if (definite) {
      await q(`UPDATE payout SET state='failed', failed_at=now(), failure_reason=$2 WHERE id=$1`,
              [claimed.id, String(e.message).slice(0, 300)]);
      return { state: 'failed', error: String(e.message).slice(0, 200) };
    }
    await q(`UPDATE payout SET provider_status='UNKNOWN', failure_reason=$2 WHERE id=$1`,
            [claimed.id, `awaiting status check: ${String(e.message).slice(0, 200)}`]);
    return { state: 'processing', unknown: true };
  }
  return applyTransferOutcome(claimed.id, {
    outcome: r.settled ? 'paid' : (['FAILED', 'REJECTED', 'REVERSED'].includes(String(r.status).toUpperCase()) ? 'failed' : 'processing'),
    status: r.status, providerPayoutId: r.providerPayoutId, utr: r.utr, method: r.method,
  }, { actorId });
}

/**
 * Apply a provider's verdict on a transfer. The one place a provider status
 * becomes a payout state; used by dispatch, the status sync and the payouts
 * webhook, so all three apply identical rules.
 */
export async function applyTransferOutcome(payoutId, t, { actorId = null } = {}) {
  const p = await one(`SELECT * FROM payout WHERE id=$1`, [payoutId]);
  if (!p) return { state: 'missing' };
  if (p.state === 'paid') {
    if (t.outcome === 'failed') {
      /* Paid here, reversed there. Never silently un-paid: a human decides. */
      await raisePayoutMismatch(p, t);
      return { state: 'paid', mismatch: true };
    }
    return { state: 'paid', duplicate: true };
  }
  await q(`UPDATE payout SET provider_status=$2, provider_synced_at=now(),
                  provider_payout_id=COALESCE(provider_payout_id,$3) WHERE id=$1`,
          [p.id, t.status || null, t.providerPayoutId || null]);
  if (t.outcome === 'paid') {
    if (p.state === 'failed' || p.state === 'cancelled') {
      await raisePayoutMismatch(p, t);
      return { state: p.state, mismatch: true };
    }
    await tx((c) => settle(c, p.id, {
      method: t.method || p.method || PAYOUTS.method,
      providerPayoutId: t.providerPayoutId || p.provider_payout_id || p.id,
      externalReference: t.utr || null, actorId }));
    return { state: 'paid' };
  }
  if (t.outcome === 'failed' && ['pending', 'processing'].includes(p.state)) {
    await q(`UPDATE payout SET state='failed', failed_at=now(), failure_reason=$2 WHERE id=$1`,
            [p.id, String(t.reason || t.status || 'failed at provider').slice(0, 300)]);
    return { state: 'failed' };
  }
  return { state: p.state };
}

async function raisePayoutMismatch(p, t) {
  await q(
    `INSERT INTO reconciliation_exception (kind, severity, detail)
     SELECT 'payout_mismatch', 'blocking', $1::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM reconciliation_exception
                         WHERE kind='payout_mismatch' AND state='open' AND detail->>'payoutId' = $2)`,
    [JSON.stringify({ payoutId: p.id, quadState: p.state, providerStatus: t.status,
                      amountPaise: p.amount_paise }), p.id]);
}

/** Ask the provider about every payout still in flight. Safe to run often. */
export async function syncInFlightPayouts({ limit = 50 } = {}) {
  const adapter = activeAdapter();
  if (!adapter?.fetchTransfer) return { ran: false };
  const rows = (await q(
    `SELECT id FROM payout WHERE state='processing'
        AND (provider_synced_at IS NULL OR provider_synced_at < now() - interval '2 minutes')
      ORDER BY created_at LIMIT $1`, [limit])).rows;
  const out = { ran: true, checked: 0, paid: 0, failed: 0 };
  for (const { id } of rows) {
    try {
      const t = await adapter.fetchTransfer(id);
      out.checked++;
      if (t.outcome === 'not_found') {
        /* Cashfree never received it: the send failed before arriving.
           Definite, so it is safe to call it failed and let it be retried. */
        await applyTransferOutcome(id, { outcome: 'failed', status: 'NOT_FOUND',
                                         reason: 'the provider has no record of this transfer' });
        out.failed++;
        continue;
      }
      const r = await applyTransferOutcome(id, { ...t, method: adapter.id });
      if (r.state === 'paid') out.paid++;
      if (r.state === 'failed') out.failed++;
    } catch { /* provider unreachable: try again next tick */ }
  }
  return out;
}

/**
 * Retry a failed payout. Always a NEW payout row with a new transfer id: a
 * failed transfer id is spent at the provider, and reusing it would be
 * refused. The old row stays as history. Safe against double payment because
 * the old one is definitively failed and the one-live-payout index admits
 * only one attempt at a time.
 */
export async function retryPayout(payoutId, { actorId }) {
  const fresh = await tx(async (c) => {
    const p = (await c.query(`SELECT * FROM payout WHERE id=$1 FOR UPDATE`, [payoutId])).rows[0];
    if (!p) throw Conflict('No such payout');
    if (p.state === 'paid') throw Conflict('That payout is already paid',
      'A paid payout is never retried. Post an adjustment if it needs reversing.');
    if (p.state !== 'failed') throw Conflict(`Only a failed payout can be retried (this one is ${p.state})`);
    const already = (await c.query(`SELECT id FROM payout WHERE retry_of=$1`, [p.id])).rows[0];
    if (already) throw Conflict('That payout has already been retried');
    const dest = await destinationFor(c, { vendorId: p.vendor_id, partnerId: p.partner_id });
    try {
      return (await c.query(
        `INSERT INTO payout (batch_id, vendor_id, partner_id, amount_paise, destination_id,
                             initiated_by, origin, retry_of)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [p.batch_id, p.vendor_id, p.partner_id, p.amount_paise,
         dest?.id || p.destination_id, actorId, p.origin, p.id])).rows[0];
    } catch (e) {
      if (e.code === '23505') throw Conflict('Another payout to this payee is already in flight');
      throw e;
    }
  });
  const dispatched = PAYOUTS.configured ? await dispatchPayout(fresh.id, { actorId }) : null;
  return { payout: await one(`SELECT * FROM payout WHERE id=$1`, [fresh.id]), dispatched };
}
