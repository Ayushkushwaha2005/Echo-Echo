/* ==========================================================================
   QUAD — SETTLEMENT RECONCILIATION IMPORTER

   The authoritative answer to "what did the gateway actually keep".

   ── The rule this file exists to enforce ─────────────────────────────────

   A payment webhook is authoritative about whether money arrived. It is NOT
   authoritative about what the gateway charged for it, and Quad no longer
   treats it as if it were. Cashfree does not report a fee on the webhook at
   all; Razorpay reports one that can still be adjusted afterwards. The only
   source accepted here is the provider's settlement reconciliation report.

   And the fee is never, under any circumstance, estimated. Not from a rate
   card, not from a percentage, not from what yesterday's orders averaged. A
   line whose figures cannot be read exactly raises an exception and is left
   unapplied, because a wrong fee propagates silently into net revenue, the
   settlement batch and every cafeteria reconciliation downstream — and a
   number that is quietly wrong cannot be found later, whereas one that is
   openly missing can.

   ── What is written, and what is never written ───────────────────────────

   WRITTEN:
     · provider_settlement_entry  — the provider's raw line, kept verbatim
     · order_financials.gateway_fee_paise — once, from zero, via the single
       write-once exemption the immutability trigger already allowed
     · payment.reconciled_at / settlement_id — the explicit marker
     · a ledger adjustment posting moving the fee out of clearing
     · reconciliation_exception   — every difference, durably

   NEVER WRITTEN:
     · cafeteria_payable_paise, delivery_earning_paise, platform_gross_paise,
       customer_total_paise, or any other allocation value. Those are the
       immutable snapshot and reconciliation has no business in them. The
       database trigger enforces this independently of anything here.
     · a fee that overwrites one already recorded. A disagreement is a
       `fee_mismatch` exception, not an update.
     · a ledger correction that edits an existing entry. The ledger is
       append-only; corrections are new balanced transactions.

   ── Why the fee posting is a separate ledger transaction ─────────────────

   At capture the ledger posted `gateway_clearing = total - fee` with fee 0,
   so Quad's books say it is holding the entire customer total. When the real
   fee arrives, the correcting posting is:

       debit  gateway_fee      +fee      (the expense is now known)
       credit gateway_clearing -fee      (the bank never held that part)

   It balances, it is idempotent on the payment id, and it touches nobody's
   payable. The cafeteria is owed exactly what it was owed before — the
   gateway's fee is Quad's cost of collecting, not a deduction from someone
   else's money, and a reconciliation that quietly moved it onto a cafeteria
   would be taking their money to pay Quad's bill.

   ── Idempotency, in three independent layers ─────────────────────────────

   1. provider_settlement_entry's unique index: a re-read line inserts nothing
   2. ledger_txn's UNIQUE (kind, ref): a re-posted fee posts nothing
   3. order_financials' write-once trigger: a second fee write is refused

   Any one of them would make a re-run safe. All three are present because
   this job will be run repeatedly, by a cron and by hand during incidents,
   and "we ran it twice" must never be a financial event.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';

import { PAYMENTS } from '../config.js';
import { adapterFor } from './payment-providers.js';
import { accountId, post } from './ledger.js';

/* ---------- reads INSIDE a transaction ----------------------------------
   db/index.js's `q` and `one` always take a connection from the pool, so
   calling them inside tx() would run the read on a DIFFERENT connection,
   outside the transaction — it would not see this transaction's own writes
   and would not hold its locks.

   That distinction is load-bearing here rather than academic: the duplicate-
   settlement detector works by inserting the line and then looking for other
   lines for the same payment, and it only finds the one it just inserted
   because the read is on the same connection. These two helpers are the
   difference between that check working and silently never firing. */
const rows1 = async (c, sql, params) => (await c.query(sql, params)).rows;
const row1 = async (c, sql, params) => (await c.query(sql, params)).rows[0] || null;

/* A cap on how far one run will walk, so a provider paginating badly cannot
   turn a cron job into an unbounded loop. */
const MAX_PAGES = 200;

/* ==========================================================================
   Exceptions

   Recorded, never thrown. The importer's job is to process every line and
   report everything wrong with all of them — an importer that aborts on the
   first bad line leaves the rest of the day unreconciled and tells you about
   one problem instead of twelve.

   The partial unique index in migration 009 keeps one OPEN exception per
   (kind, payment, entry), so a daily re-run over an unresolved problem does
   not breed a queue nobody can clear.
   ========================================================================== */
async function raise(c, importId, { kind, entryId = null, paymentId = null,
                                    orderId = null, severity = 'blocking', detail }) {
  const row = await c.query(
    `INSERT INTO reconciliation_exception
       (import_id, entry_id, payment_id, order_id, kind, severity, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [importId, entryId, paymentId, orderId, kind, severity, JSON.stringify(detail || {})]);
  return row.rowCount ? row.rows[0].id : null;
}

/* ==========================================================================
   Applying ONE settlement line.

   Runs in its own transaction. That is deliberate: one unreadable line must
   not roll back a day's worth of correctly reconciled ones, and an exception
   raised about a line must survive whatever happens to the rest of the run.

   Returns a small verdict object the caller tallies. It never throws for a
   data problem — only for a genuine infrastructure failure, which the caller
   turns into a failed import rather than a silent gap.
   ========================================================================== */
async function applyEntry(importId, provider, line) {
  return tx(async (c) => {
    /* ---- 0. the line must be readable at all -------------------------
       A null here means the provider sent something the exact-conversion
       gate refused: more precision than paise, a negative, a missing field.
       We store the line anyway — the raw fact is worth keeping — and refuse
       to apply it. */
    const unreadable = !line.providerPaymentId
      || !Number.isInteger(line.paymentAmountPaise)
      || !Number.isInteger(line.serviceChargePaise)
      || !Number.isInteger(line.serviceTaxPaise);

    /* ---- 1. record the provider's line, verbatim ----------------------
       ON CONFLICT DO NOTHING against the unique index. No row back means
       this exact line has been imported before: the run is a repeat, and a
       repeat does nothing at all. */
    const ins = await c.query(
      `INSERT INTO provider_settlement_entry
         (import_id, provider, provider_payment_id, provider_order_id, settlement_id,
          settlement_utr, event_type, payment_amount_paise, service_charge_paise,
          service_tax_paise, settlement_amount_paise, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT DO NOTHING RETURNING *`,
      [importId, provider, line.providerPaymentId || '(missing)', line.providerOrderId,
       line.settlementId, line.settlementUtr, line.eventType, line.paymentAmountPaise,
       line.serviceChargePaise, line.serviceTaxPaise, line.settlementAmountPaise,
       JSON.stringify(line.raw ?? {})]);
    if (!ins.rowCount) return { duplicate: true };

    const entry = ins.rows[0];
    const seen = { entryId: entry.id, new: true };

    if (unreadable) {
      await raise(c, importId, { kind: 'unexpected_deduction', entryId: entry.id,
        detail: { reason: 'the provider line could not be read exactly',
                  paymentAmountPaise: line.paymentAmountPaise,
                  serviceChargePaise: line.serviceChargePaise,
                  serviceTaxPaise: line.serviceTaxPaise,
                  note: 'No fee was applied. Amounts are never coerced or estimated.' } });
      return { ...seen, exceptions: 1 };
    }

    /* ---- 2. match on IMMUTABLE provider identifiers -------------------
       Never on amount, never on time. Two students buying the same coffee in
       the same minute is an ordinary Tuesday, and an amount match would pick
       one of them at random. */
    const pay = await row1(c,
      `SELECT * FROM payment WHERE provider = $1 AND provider_payment_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [provider, line.providerPaymentId]);

    if (!pay) {
      await c.query(`UPDATE provider_settlement_entry SET match_state='unmatched' WHERE id=$1`,
                    [entry.id]);
      /* A refund line with no Quad refund is its own category: it means the
         provider returned money Quad has no record of returning. */
      const kind = line.eventType === 'REFUND' ? 'refund_unmatched' : 'missing_payment';
      await raise(c, importId, { kind, entryId: entry.id,
        detail: { providerPaymentId: line.providerPaymentId,
                  providerOrderId: line.providerOrderId,
                  settlementId: line.settlementId, eventType: line.eventType,
                  note: 'The provider settled a transaction Quad has no payment for. ' +
                        'This is never resolved by creating one.' } });
      return { ...seen, exceptions: 1 };
    }

    /* Both identifiers must agree. If the report's order id points somewhere
       other than the payment its payment id points to, we do not get to pick
       the one we prefer. */
    if (line.providerOrderId && pay.provider_order_id &&
        line.providerOrderId !== pay.provider_order_id) {
      await c.query(`UPDATE provider_settlement_entry SET match_state='conflicted', payment_id=$2
                      WHERE id=$1`, [entry.id, pay.id]);
      await raise(c, importId, { kind: 'order_mismatch', entryId: entry.id, paymentId: pay.id,
        orderId: pay.order_id,
        detail: { providerPaymentId: line.providerPaymentId,
                  reportOrderId: line.providerOrderId,
                  quadProviderOrderId: pay.provider_order_id } });
      return { ...seen, exceptions: 1 };
    }

    await c.query(
      `UPDATE provider_settlement_entry SET match_state='matched', payment_id=$2, order_id=$3
        WHERE id=$1`, [entry.id, pay.id, pay.order_id]);
    seen.matched = true;

    /* ---- 3. a refund line is not a fee on the original payment --------
       It is recorded, linked, and left alone. Refund allocation already
       happened through the refund flow and the ledger; re-applying anything
       here would double-count it. */
    if (line.eventType === 'REFUND' || line.eventType === 'ADJUSTMENT') {
      const refunded = await row1(c,
        `SELECT COALESCE(sum(amount_paise),0)::bigint AS n FROM refund
          WHERE payment_id = $1 AND state IN ('processing','completed')`, [pay.id]);
      if (line.eventType === 'REFUND' && Number(refunded.n) === 0) {
        await raise(c, importId, { kind: 'refund_unmatched', entryId: entry.id,
          paymentId: pay.id, orderId: pay.order_id,
          detail: { note: 'The provider reports returning money Quad has no refund for.',
                    providerPaymentId: line.providerPaymentId,
                    amountPaise: line.paymentAmountPaise } });
        return { ...seen, exceptions: 1 };
      }
      /* A known refund. Nothing to apply: the ledger already moved it. */
      return seen;
    }

    /* ---- 4. duplicate provider transaction ---------------------------
       The same payment settled under a SECOND settlement id. The unique
       index let this line in precisely so it could be noticed here — the key
       includes the settlement id exactly so two different settlements of one
       payment are two rows rather than one absorbed silently. */
    const others = await rows1(c,
      `SELECT id, settlement_id, settlement_amount_paise FROM provider_settlement_entry
        WHERE provider = $1 AND provider_payment_id = $2 AND event_type = 'PAYMENT'
          AND id <> $3`,
      [provider, line.providerPaymentId, entry.id]);
    if (others.length) {
      await raise(c, importId, { kind: 'duplicate_provider_txn', entryId: entry.id,
        paymentId: pay.id, orderId: pay.order_id,
        detail: { providerPaymentId: line.providerPaymentId,
                  settlements: [line.settlementId, ...others.map((r) => r.settlement_id)],
                  note: 'One payment settled more than once. No fee applied from either ' +
                        'line until a human decides which is real.' } });
      return { ...seen, exceptions: 1 };
    }

    /* ---- 5. the amount must be the amount ----------------------------
       Against the payment Quad pinned from the immutable snapshot. Not
       against a recomputed price and not against anything in the report. */
    if (line.paymentAmountPaise !== pay.amount_paise) {
      await raise(c, importId, { kind: 'amount_mismatch', entryId: entry.id,
        paymentId: pay.id, orderId: pay.order_id,
        detail: { expectedPaise: pay.amount_paise, reportedPaise: line.paymentAmountPaise,
                  providerPaymentId: line.providerPaymentId,
                  note: 'The settlement report disagrees with what Quad charged. ' +
                        'No fee is applied against a payment whose amount is in dispute.' } });
      return { ...seen, exceptions: 1 };
    }

    /* ---- 6. the arithmetic must close --------------------------------
       settled = charged - fee - tax. Anything left over is a deduction the
       provider made and did not explain, and it is exactly the thing a
       reconciliation exists to surface. Note this catches a SHORTFALL and a
       SURPLUS alike: money appearing is as much a reconciliation failure as
       money missing. */
    const fee = line.serviceChargePaise + line.serviceTaxPaise;
    const expectedSettlement = line.paymentAmountPaise - fee;
    if (Number.isInteger(line.settlementAmountPaise) &&
        line.settlementAmountPaise !== expectedSettlement) {
      const short = expectedSettlement - line.settlementAmountPaise;
      /* A shortfall that is a clean fraction of the payment is reported as a
         partial settlement rather than a mystery deduction — the provider
         settling part of a payment is a known, ordinary thing, and calling it
         an unexpected deduction would send somebody looking for fraud. */
      const kind = short > 0 && line.settlementAmountPaise > 0
        ? 'partial_settlement' : 'unexpected_deduction';
      await raise(c, importId, { kind, entryId: entry.id, paymentId: pay.id,
        orderId: pay.order_id,
        detail: { paymentAmountPaise: line.paymentAmountPaise,
                  serviceChargePaise: line.serviceChargePaise,
                  serviceTaxPaise: line.serviceTaxPaise,
                  expectedSettlementPaise: expectedSettlement,
                  reportedSettlementPaise: line.settlementAmountPaise,
                  unexplainedPaise: short,
                  note: 'No fee applied. The unexplained amount is not absorbed into ' +
                        'the gateway fee, because that would hide it inside a number ' +
                        'that already looks like a cost.' } });
      return { ...seen, exceptions: 1 };
    }

    /* ---- 7. a fee already recorded must not be overwritten ------------
       Razorpay reports a fee at capture, so this is a real case rather than
       a defensive one. If the settlement report agrees, nothing to do. If it
       disagrees, the SETTLEMENT is the authoritative figure — but the
       correction is a decision with money attached, so it is raised for a
       human rather than applied. */
    const snap = await row1(c,
      `SELECT gateway_fee_paise FROM order_financials WHERE order_id = $1`, [pay.order_id]);
    if (!snap) {
      await raise(c, importId, { kind: 'missing_payment', entryId: entry.id, paymentId: pay.id,
        detail: { note: 'The matched payment has no financial snapshot.',
                  orderId: pay.order_id } });
      return { ...seen, exceptions: 1 };
    }
    if (snap.gateway_fee_paise !== 0 && snap.gateway_fee_paise !== fee) {
      await raise(c, importId, { kind: 'fee_mismatch', entryId: entry.id, paymentId: pay.id,
        orderId: pay.order_id,
        detail: { recordedPaise: snap.gateway_fee_paise, settlementPaise: fee,
                  note: 'A fee was already recorded for this order and the settlement ' +
                        'report disagrees. The recorded value is NOT overwritten. The ' +
                        'settlement figure is authoritative, so this needs a correcting ' +
                        'entry a person has approved.' } });
      return { ...seen, exceptions: 1 };
    }

    /* ---- 8. informational: the money already went out ------------------
       Not a blocker. The gateway fee is Quad's cost and never touched the
       cafeteria's payable, so a settlement already paid out is unaffected by
       learning it. It is worth SAYING, though, because "we reconciled after
       paying out" is the first question anyone asks when a number moves. */
    if (pay.order_id) {
      const paidOut = await row1(c,
        `SELECT p.id FROM payout p
           JOIN food_order o ON o.vendor_id = p.vendor_id
          WHERE o.id = $1 AND p.state = 'paid' LIMIT 1`, [pay.order_id]);
      if (paidOut) {
        await raise(c, importId, { kind: 'payout_already_executed', entryId: entry.id,
          paymentId: pay.id, orderId: pay.order_id, severity: 'informational',
          detail: { payoutId: paidOut.id,
                    note: 'Reconciled after this cafeteria was paid. No payout is altered: ' +
                          "the gateway fee is Quad's cost and was never part of the " +
                          'cafeteria payable.' } });
        seen.exceptions = (seen.exceptions || 0) + 1;
      }
    }

    /* ---- 9. apply -----------------------------------------------------
       Everything agrees. Record the fee, mark the payment reconciled, post
       the correcting ledger entry. All inside this one transaction, so a
       payment can never be marked reconciled without its ledger posting.

       Note the fee may legitimately be ZERO — that is the expected outcome
       under Cashfree's 0% offer — which is exactly why `reconciled_at` is an
       explicit column rather than something inferred from the amount. */
    if (snap.gateway_fee_paise === 0 && fee > 0) {
      await c.query(`UPDATE order_financials SET gateway_fee_paise = $2 WHERE order_id = $1`,
                    [pay.order_id, fee]);

      /* The correcting posting. Append-only: this does not edit the capture
         transaction, it books the newly known expense against it. */
      await post(c, {
        kind: 'adjustment', ref: `gateway_fee:${pay.id}`, orderId: pay.order_id,
        memo: `gateway fee from settlement ${line.settlementId || '(unknown)'}`,
        legs: [
          { account: await accountId(c, 'gateway_fee'), amount: fee,
            orderId: pay.order_id, paymentId: pay.id, memo: 'gateway fee, per settlement report' },
          { account: await accountId(c, 'gateway_clearing'), amount: -fee,
            orderId: pay.order_id, paymentId: pay.id, memo: 'never reached the bank' },
        ],
      });
    }

    await c.query(
      `UPDATE payment SET reconciled_at = now(), settlement_id = $2 WHERE id = $1`,
      [pay.id, line.settlementId]);
    await c.query(`UPDATE provider_settlement_entry SET applied = true WHERE id = $1`,
                  [entry.id]);

    return { ...seen, applied: true, feePaise: fee };
  });
}

/* ==========================================================================
   Missing provider transactions.

   The other direction, and the one an importer that only walks the provider's
   report will never find: payments Quad believes it captured that the
   provider has not settled. Money the gateway took from a student and has not
   passed on is invisible to a report that does not mention it.

   `graceHours` exists because settlement genuinely takes days — flagging a
   payment captured an hour ago would produce noise, not signal.
   ========================================================================== */
export async function detectUnsettledPayments(importId, provider,
                                              { from, to, graceHours = 72 } = {}) {
  const { rows } = await q(
    `SELECT p.id, p.order_id, p.provider_payment_id, p.amount_paise, p.settled_at
       FROM payment p
      WHERE p.provider = $1 AND p.status = 'paid' AND p.reconciled_at IS NULL
        AND p.settled_at < now() - ($2 || ' hours')::interval
        AND ($3::timestamptz IS NULL OR p.settled_at >= $3)
        AND ($4::timestamptz IS NULL OR p.settled_at <  $4)
      ORDER BY p.settled_at LIMIT 500`,
    [provider, String(graceHours), from ?? null, to ?? null]);

  let raised = 0;
  for (const p of rows) {
    const id = await tx((c) => raise(c, importId, {
      kind: 'unsettled_payment', paymentId: p.id, orderId: p.order_id,
      detail: { providerPaymentId: p.provider_payment_id, amountPaise: Number(p.amount_paise),
                capturedAt: p.settled_at,
                note: 'Quad holds a captured payment the provider has not settled. ' +
                      'The money was taken from a customer and has not been passed on.' } }));
    if (id) raised++;
  }
  return { candidates: rows.length, raised };
}

/* ==========================================================================
   The importer.

   @param opts.from/to      the settlement window (date_range), or
   @param opts.settlementId a single settlement, or
   @param opts.utr          a single bank reference
   @param opts.actorId      who ran it
   @param opts.detectUnsettled  also sweep for payments the provider never
                                settled (default true for a window run)

   Returns the import row. A run is `completed` only when every line was
   processed AND nothing was raised; `completed_with_exceptions` when
   differences were found; `failed` when the provider or the database made it
   impossible to finish.

   Note what "completed" does NOT mean: it does not mean the provider's API
   answered. An import that fetches a page and then cannot process it is
   `failed`, and an import that processes lines it could not explain is
   `completed_with_exceptions`. A 200 from the gateway reconciles nothing by
   itself — that is the whole point of the state being computed from what was
   actually applied.
   ========================================================================== */
export async function importSettlements(opts = {}) {
  const provider = opts.provider || PAYMENTS.provider;
  const adapter = adapterFor(provider);
  if (typeof adapter.fetchSettlements !== 'function') {
    throw new Error(`${adapter.label} has no settlement reconciliation adapter`);
  }

  const filterKind = opts.settlementId ? 'settlement_id' : opts.utr ? 'utr' : 'date_range';
  const from = opts.from ? new Date(opts.from) : null;
  const to = opts.to ? new Date(opts.to) : null;
  if (filterKind === 'date_range' && (!from || !to || !(from < to))) {
    throw new Error('a settlement import needs a valid from/to window');
  }

  const run = await one(
    `INSERT INTO provider_settlement_import
       (provider, filter_kind, window_start, window_end, settlement_ref, started_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [provider, filterKind, from, to, opts.settlementId || opts.utr || null,
     opts.actorId || null]);

  const tally = { seen: 0, fresh: 0, duplicate: 0, matched: 0, exceptions: 0, fees: 0 };
  try {
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await adapter.fetchSettlements({
        from, to, settlementId: opts.settlementId, utr: opts.utr, cursor });
      const entries = res?.entries || [];
      for (const line of entries) {
        tally.seen++;
        const out = await applyEntry(run.id, provider, line);
        if (out.duplicate) { tally.duplicate++; continue; }
        tally.fresh++;
        if (out.matched) tally.matched++;
        if (out.exceptions) tally.exceptions += out.exceptions;
        if (out.applied) tally.fees += out.feePaise || 0;
      }
      cursor = res?.cursor ?? null;
      /* Stop on an exhausted cursor, and also on an empty page — a provider
         that keeps handing back a cursor forever must not spin this job. */
      if (!cursor || !entries.length) break;
    }

    if (filterKind === 'date_range' && opts.detectUnsettled !== false) {
      const swept = await detectUnsettledPayments(run.id, provider,
        { from, to, graceHours: opts.graceHours });
      tally.exceptions += swept.raised;
    }

    const state = tally.exceptions ? 'completed_with_exceptions' : 'completed';
    return one(
      `UPDATE provider_settlement_import
          SET state=$2, finished_at=now(), entries_seen=$3, entries_new=$4,
              entries_duplicate=$5, entries_matched=$6, exceptions_raised=$7,
              fees_recorded_paise=$8
        WHERE id=$1 RETURNING *`,
      [run.id, state, tally.seen, tally.fresh, tally.duplicate, tally.matched,
       tally.exceptions, tally.fees]);
  } catch (e) {
    /* A failed run is recorded as failed, with its partial counts intact.
       Whatever it DID apply stays applied — each line was its own committed
       transaction — and re-running is safe because every layer of the
       idempotency is on the individual line, not on the run. */
    await q(
      `UPDATE provider_settlement_import
          SET state='failed', finished_at=now(), error=$2, entries_seen=$3,
              entries_new=$4, entries_matched=$5, exceptions_raised=$6
        WHERE id=$1`,
      [run.id, String(e.message).slice(0, 500), tally.seen, tally.fresh,
       tally.matched, tally.exceptions]);
    throw e;
  }
}

/* ==========================================================================
   The scheduled run.

   Settlement lands days after capture, and a provider may restate a report,
   so this walks a ROLLING window rather than yesterday alone. Re-reading days
   that are already reconciled is free by construction: every line is refused
   by the unique index, no fee is applied twice, and the run reports them as
   duplicates. That is the property that lets a schedule be dumb.

   At most one automatic run per calendar day. Not because a second would
   corrupt anything — it would not — but because each run costs provider API
   calls and writes an import row, and an operator scrolling a history of 48
   identical runs per day cannot see the one that mattered.

   Failures are swallowed and logged: reconciliation is bookkeeping that
   catches up, and a provider having a bad morning must never take down the
   ordering platform. The failed run is still recorded as failed, so the gap
   is visible on the finance surface rather than lost in a log.
   ========================================================================== */
export async function runScheduledReconciliation({ now = new Date(), log,
                                                   lookbackDays } = {}) {
  const days = Number.isFinite(lookbackDays) && lookbackDays > 0
    ? lookbackDays : PAYMENTS.reconLookbackDays;
  const provider = PAYMENTS.provider;
  if (!provider || !PAYMENTS.configured) return { ran: false, reason: 'no payment provider' };
  let adapter;
  try { adapter = adapterFor(provider); }
  catch { return { ran: false, reason: 'provider not configured' }; }
  if (typeof adapter.fetchSettlements !== 'function') {
    return { ran: false, reason: 'provider has no settlement report' };
  }

  const already = await one(
    `SELECT id FROM provider_settlement_import
      WHERE provider = $1 AND filter_kind = 'date_range'
        AND started_at >= date_trunc('day', $2::timestamptz)
        AND state <> 'failed'
      LIMIT 1`, [provider, now]);
  if (already) return { ran: false, reason: 'already reconciled today', importId: already.id };

  const to = now;
  const from = new Date(now.getTime() - days * 86_400_000);
  try {
    const run = await importSettlements({ provider, from, to });
    return { ran: true, importId: run.id, state: run.state,
             seen: run.entries_seen, applied: run.entries_new,
             exceptions: run.exceptions_raised };
  } catch (e) {
    log?.error({ e }, 'scheduled reconciliation failed');
    return { ran: true, failed: true, error: String(e.message).slice(0, 200) };
  }
}

/** Open differences, newest first, for the finance surface. */
export async function openExceptions({ limit = 200, kind = null } = {}) {
  const { rows } = await q(
    `SELECT x.*, o.code AS order_code, p.provider_payment_id
       FROM reconciliation_exception x
       LEFT JOIN food_order o ON o.id = x.order_id
       LEFT JOIN payment p ON p.id = x.payment_id
      WHERE x.state = 'open' AND ($1::text IS NULL OR x.kind = $1)
      ORDER BY x.severity = 'blocking' DESC, x.created_at DESC
      LIMIT $2`, [kind, limit]);
  return rows;
}

/**
 * Close a difference, with a name and a reason attached.
 *
 * Resolving is a bookkeeping act, not a fix: it records that a human looked
 * and decided. It deliberately does NOT apply a fee, adjust a payable, or
 * change any figure — a difference that needs money moved needs an explicit
 * adjustment posting, which is its own audited action.
 */
export async function resolveException(id, { actorId, note }) {
  const text = String(note || '').trim();
  if (text.length < 10) {
    const err = new Error('A resolution needs a reason of at least ten characters');
    err.expected = true;
    throw err;
  }
  return one(
    `UPDATE reconciliation_exception
        SET state='resolved', resolved_by=$2, resolved_at=now(), resolution_note=$3
      WHERE id=$1 AND state='open' RETURNING *`,
    [id, actorId, text.slice(0, 1000)]);
}
