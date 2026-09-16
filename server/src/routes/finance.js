/* ==========================================================================
   QUAD — FINANCE, SETTLEMENT AND PAYOUTS

   Every number served from here is read out of the ledger or out of an
   order's frozen snapshot. Nothing on this route multiplies an old order's
   total by today's commission rate, because that answer would change every
   time the terms change, and a settlement statement that changes retroactively
   is not a settlement statement.

   Three audiences, three scopes, enforced by rbac rather than by which
   surface asked:

     platform  finance.read_all   the whole platform's books
     cafeteria finance.read       own_vendor — its own statement only
     partner   finance.read       own — their own earnings only

   The scope check reads the owning vendor or partner from the database, so
   changing an id in a URL produces a 403 rather than another party's money.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { authorize, BadRequest, NotFound, Conflict, ProviderUnavailable } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { PAYOUTS } from '../config.js';
import { audit } from '../audit.js';
import { balance, postAdjustment } from '../services/ledger.js';
import { buildBatch, sendToProvider, settle, releaseBatch } from '../services/payouts.js';
import { schedule, runSettlementSchedules } from '../services/settlement.js';
import { importSettlements, openExceptions, resolveException }
  from '../services/reconciliation.js';

/* A day window, defaulting to today, in the server's timezone. Both bounds
   are explicit so a report can be reproduced exactly. */
function window(qs) {
  const from = qs?.from ? new Date(qs.from) : null;
  const to = qs?.to ? new Date(qs.to) : null;
  if ((qs?.from && Number.isNaN(+from)) || (qs?.to && Number.isNaN(+to))) {
    throw BadRequest('from and to must be ISO timestamps');
  }
  return { from, to };
}

/* ==========================================================================
   The settlement-batch status vocabulary the finance dashboard reports.

   DERIVED, never stored. The source of truth stays what it was — the batch's
   own review state (`open → approved → completed | cancelled`) plus the
   rollup of its payouts' real states — and this expression names the
   combination. That is the right way round: a status column would be a
   second, denormalised copy of facts that already exist, and the failure mode
   of a denormalised financial status is a batch that says PAID while a
   transfer sits failed underneath it.

   Two honest notes about the vocabulary:

   · PARTIALLY_FAILED is emphatically its own status rather than rounded to
     FAILED or PAID. A batch where four cafeterias were paid and one transfer
     bounced needs a human to look at the fifth, and both roundings hide that.

   · RECONCILING is not produced, because it does not exist here as a window
     of time: reconciliation happens synchronously inside the lock that builds
     the batch, reading balances from the ledger, so a batch is never observed
     mid-reconciliation. Reporting a state the system cannot be in would be
     decoration.
   ========================================================================== */
const BATCH_STATUS_SQL = `
  CASE
    WHEN b.state = 'cancelled' THEN 'CANCELLED'
    WHEN count(p.id) = 0       THEN 'CREATED'
    WHEN count(*) FILTER (WHERE p.state = 'paid') = count(p.id)   THEN 'PAID'
    WHEN count(*) FILTER (WHERE p.state = 'failed') = count(p.id) THEN 'FAILED'
    WHEN count(*) FILTER (WHERE p.state = 'failed') > 0
     AND count(*) FILTER (WHERE p.state = 'paid') > 0             THEN 'PARTIALLY_FAILED'
    WHEN count(*) FILTER (WHERE p.state = 'processing') > 0       THEN 'PROCESSING'
    WHEN b.state = 'approved'  THEN 'APPROVED'
    ELSE 'READY_FOR_APPROVAL'
  END AS status`;

export default async function financeRoutes(app) {
  /* ======================================================================
     PLATFORM — Campus Control's finance section
     ====================================================================== */

  /* The one screen that answers "where is all the money". Every figure is a
     ledger or snapshot aggregate; none is a running total kept in a column
     that could drift. */
  app.get('/admin/finance/summary', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const { from, to } = window(req.query);

    /* Captured orders in the window, from the snapshots of orders that
       actually produced a capture posting. An unpaid draft contributes
       nothing to GMV, which is the point. */
    const sold = await one(
      `SELECT count(*)::int                              AS orders,
              COALESCE(sum(f.customer_total_paise),0)::bigint AS gmv_paise,
              COALESCE(sum(f.food_subtotal_paise),0)::bigint  AS food_paise,
              COALESCE(sum(f.platform_fee_paise),0)::bigint   AS platform_fees_paise,
              COALESCE(sum(f.commission_paise),0)::bigint     AS commissions_paise,
              COALESCE(sum(f.delivery_earning_paise),0)::bigint AS delivery_earnings_paise,
              COALESCE(sum(f.tax_payable_paise),0)::bigint    AS tax_paise,
              COALESCE(sum(f.gateway_fee_paise),0)::bigint    AS gateway_fees_paise,
              COALESCE(sum(f.platform_gross_paise),0)::bigint AS platform_gross_paise
         FROM order_financials f
         JOIN ledger_txn t ON t.order_id = f.order_id AND t.kind = 'order_capture'
        WHERE ($1::timestamptz IS NULL OR t.created_at >= $1)
          AND ($2::timestamptz IS NULL OR t.created_at <  $2)`, [from, to]);

    const refunded = await one(
      `SELECT count(*)::int AS refunds,
              COALESCE(sum(ra.total_paise),0)::bigint            AS refunds_paise,
              COALESCE(sum(ra.from_cafeteria_paise),0)::bigint   AS from_cafeteria_paise,
              COALESCE(sum(ra.from_platform_paise),0)::bigint    AS from_platform_paise,
              COALESCE(sum(ra.from_delivery_paise),0)::bigint    AS from_delivery_paise
         FROM refund_allocation ra
        WHERE ($1::timestamptz IS NULL OR ra.created_at >= $1)
          AND ($2::timestamptz IS NULL OR ra.created_at <  $2)`, [from, to]);

    const adjustments = await one(
      `SELECT COALESCE(sum(e.amount_paise),0)::bigint AS paise
         FROM ledger_entry e JOIN ledger_txn t ON t.id = e.txn_id
         JOIN ledger_account a ON a.id = e.account_id
        WHERE t.kind = 'adjustment' AND a.kind = 'platform_revenue'
          AND ($1::timestamptz IS NULL OR e.created_at >= $1)
          AND ($2::timestamptz IS NULL OR e.created_at <  $2)`, [from, to]);

    /* Live balances are as-of-now by definition: what is owed is owed
       regardless of which window is being reported on. */
    const [cafeteriaPayable, deliveryPayable, deliveryClearing, clearing, taxPayable] =
      await Promise.all([
        balance(q, 'cafeteria_payable'), balance(q, 'delivery_payable'),
        balance(q, 'delivery_clearing'), balance(q, 'gateway_clearing'),
        balance(q, 'tax_payable'),
      ]);
    const settled = await one(
      `SELECT COALESCE(sum(amount_paise) FILTER (WHERE vendor_id IS NOT NULL),0)::bigint
                AS cafeteria_paise,
              COALESCE(sum(amount_paise) FILTER (WHERE partner_id IS NOT NULL),0)::bigint
                AS partner_paise
         FROM payout WHERE state = 'paid'`);
    const inFlight = await one(
      `SELECT count(*)::int AS n, COALESCE(sum(amount_paise),0)::bigint AS paise
         FROM payout WHERE state IN ('pending','processing')`);

    const n = (v) => Number(v);
    const platformGross = n(sold.platform_gross_paise) + n(adjustments.paise);
    const platformNet = platformGross - n(refunded.from_platform_paise)
                                      - n(sold.gateway_fees_paise);

    return {
      window: { from, to },
      orders: sold.orders,
      gmvPaise: n(sold.gmv_paise),
      foodSalesPaise: n(sold.food_paise),
      platformFeesPaise: n(sold.platform_fees_paise),
      commissionsPaise: n(sold.commissions_paise),
      deliveryEarningsPaise: n(sold.delivery_earnings_paise),
      taxCollectedPaise: n(sold.tax_paise),
      gatewayFeesPaise: n(sold.gateway_fees_paise),
      refunds: refunded.refunds,
      refundsPaise: n(refunded.refunds_paise),
      adjustmentsPaise: n(adjustments.paise),
      quadGrossRevenuePaise: platformGross,
      quadNetRevenuePaise: platformNet,
      /* Owed right now, and already paid, for each side. */
      cafeteriaPayablePaise: cafeteriaPayable,
      deliveryPayablePaise: deliveryPayable,
      deliveryUnearnedPaise: deliveryClearing,
      taxPayablePaise: taxPayable,
      unsettledPaise: cafeteriaPayable + deliveryPayable,
      settledCafeteriaPaise: n(settled.cafeteria_paise),
      settledPartnerPaise: n(settled.partner_paise),
      payoutsInFlight: { count: inFlight.n, amountPaise: n(inFlight.paise) },
      /* Cash Quad is holding that it has not yet disbursed. Should equal
         everything owed plus its own retained revenue; a divergence here is
         the first sign of a bookkeeping bug, so it is shown rather than
         hidden. */
      clearingBalancePaise: clearing,
      /* Truthful about how settlement actually happens on this deployment. */
      payoutProvider: {
        provider: PAYOUTS.provider,
        configured: PAYOUTS.configured,
        note: PAYOUTS.configured
          ? null
          : 'No payout provider is connected. Settlements must be transferred by an ' +
            'administrator and recorded here with the bank reference. Amounts owed are ' +
            'tracked either way.',
      },
    };
  });

  /* Per-cafeteria settlement statement. */
  app.get('/admin/finance/cafeterias', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const { rows } = await q(
      `SELECT s.*, v.active FROM v_cafeteria_statement s
         JOIN vendor v ON v.id = s.vendor_id
        ORDER BY s.outstanding_paise DESC, s.name`);
    return { cafeterias: rows.map(numeric) };
  });

  /* Per-partner earnings and payout position. */
  app.get('/admin/finance/partners', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const { rows } = await q(
      `SELECT s.*, p.status FROM v_partner_statement s
         JOIN partner_profile p ON p.user_id = s.partner_id
        ORDER BY s.pending_payout_paise DESC, s.name`);
    return { partners: rows.map(numeric) };
  });

  /* The audit trail for one order: its frozen snapshot and every ledger
     entry it produced, in posting order. This is the answer to "show me
     exactly what happened to this customer's 115 rupees". */
  app.get('/admin/finance/orders/:id', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const order = await one(
      `SELECT o.*, v.name AS vendor_name FROM food_order o
         JOIN vendor v ON v.id = o.vendor_id WHERE o.id = $1`, [req.params.id]);
    if (!order) throw NotFound('No such order');
    const financials = await one(
      `SELECT f.*, p.commission_bps, p.platform_fee_flat_paise, p.platform_fee_bps,
              p.tax_bps, p.effective_from AS policy_effective_from, p.note AS policy_note
         FROM order_financials f
         JOIN pricing_policy p ON p.id = f.pricing_policy_id
        WHERE f.order_id = $1`, [order.id]);
    const entries = (await q(
      `SELECT e.id, e.amount_paise, e.memo, e.created_at, t.kind AS txn_kind, t.ref,
              a.kind AS account_kind, a.normal, a.vendor_id, a.partner_id
         FROM ledger_entry e
         JOIN ledger_txn t ON t.id = e.txn_id
         JOIN ledger_account a ON a.id = e.account_id
        WHERE e.order_id = $1 ORDER BY e.id`, [order.id])).rows;
    const refunds = (await q(
      `SELECT r.id, r.amount_paise, r.state, r.reason, r.created_at, ra.*
         FROM refund r LEFT JOIN refund_allocation ra ON ra.refund_id = r.id
        WHERE r.order_id = $1 ORDER BY r.created_at`, [order.id])).rows;
    return {
      order, financials, refunds,
      ledger: entries.map((e) => ({
        ...e, amount_paise: Number(e.amount_paise),
        /* Natural sign: positive means this party gained. */
        effect_paise: e.normal === 'credit' ? -Number(e.amount_paise) : Number(e.amount_paise),
      })),
    };
  });

  /* Raw ledger, newest first, for reconciliation. */
  app.get('/admin/finance/ledger', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const { rows } = await q(
      `SELECT t.id, t.kind, t.ref, t.memo, t.created_at, t.order_id, o.code AS order_code,
              json_agg(json_build_object(
                'account', a.kind, 'vendorId', a.vendor_id, 'partnerId', a.partner_id,
                'amountPaise', e.amount_paise, 'memo', e.memo) ORDER BY e.id) AS legs
         FROM ledger_txn t
         JOIN ledger_entry e ON e.txn_id = t.id
         JOIN ledger_account a ON a.id = e.account_id
         LEFT JOIN food_order o ON o.id = t.order_id
        WHERE ($1::text IS NULL OR t.kind = $1)
        GROUP BY t.id, o.code
        ORDER BY t.created_at DESC LIMIT 200`, [req.query?.kind || null]);
    return { transactions: rows };
  });

  /* ======================================================================
     PRICING POLICY — the commercial terms
     ====================================================================== */

  /* ---------- what an order costs, before there is an order --------------
     The fees ECHO ECHO charges a customer, read from the live platform
     policy so the checkout screen cannot quote a number the server would
     not charge. Deliberately only the customer's side: commission and the
     partner's earning are not a customer's business, and are not here. */
  app.get('/pricing/current', async () => {
    const p = await one(
      `SELECT platform_fee_flat_paise, platform_fee_bps, delivery_fee_paise, tax_bps
         FROM pricing_policy WHERE effective_to IS NULL AND vendor_id IS NULL
         ORDER BY effective_from DESC LIMIT 1`);
    return {
      currency: 'INR',
      platformFeeFlatPaise: p?.platform_fee_flat_paise ?? 0,
      platformFeeBps: p?.platform_fee_bps ?? 0,
      deliveryFeePaise: p?.delivery_fee_paise ?? 0,
      taxBps: p?.tax_bps ?? 0,
      note: 'Indicative. The order is priced again from the live menu when it is placed.',
    };
  });

  /* What a delivery partner earns, and where the step is. Shown on the
     partner screens so the rule is visible rather than folded into a number
     that appears after the fact. */
  app.get('/partner/earning-rule', async (req) => {
    authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
    const p = await one(
      `SELECT delivery_earning_paise, delivery_earning_high_paise, delivery_earning_threshold_paise
         FROM pricing_policy WHERE effective_to IS NULL AND vendor_id IS NULL
         ORDER BY effective_from DESC LIMIT 1`);
    return {
      basePaise: p?.delivery_earning_paise ?? 0,
      higherPaise: p?.delivery_earning_high_paise ?? null,
      thresholdPaise: p?.delivery_earning_threshold_paise ?? null,
    };
  });

  app.get('/admin/pricing', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const { rows } = await q(
      `SELECT p.*, v.name AS vendor_name FROM pricing_policy p
         LEFT JOIN vendor v ON v.id = p.vendor_id
        ORDER BY p.vendor_id NULLS FIRST, p.effective_from DESC`);
    return {
      live: rows.filter((r) => !r.effective_to),
      history: rows.filter((r) => r.effective_to),
    };
  });

  /* Changing the terms NEVER edits a row. The live version is closed and a
     new one inserted, in one transaction, so orders already priced keep
     pointing at what they were priced under. */
  app.put('/admin/pricing', async (req) => {
    authorize(req.actor, 'pricing.manage');
    assertRecentPasskey(req.actor, 'changing commercial terms');
    const b = req.body || {};
    const vendorId = b.vendorId || null;
    if (vendorId && !(await one(`SELECT 1 FROM vendor WHERE id = $1`, [vendorId]))) {
      throw NotFound('No such cafeteria');
    }
    const int = (name, v, max) => {
      const n = Number(v ?? 0);
      if (!Number.isInteger(n) || n < 0 || (max !== undefined && n > max)) {
        throw BadRequest(`${name} must be a whole number between 0 and ${max ?? 'above'}`);
      }
      return n;
    };
    const terms = {
      commission_bps: int('commissionBps', b.commissionBps, 10000),
      commission_mode: b.commissionMode || 'deduct_from_cafeteria',
      platform_fee_flat_paise: int('platformFeeFlatPaise', b.platformFeeFlatPaise),
      platform_fee_bps: int('platformFeeBps', b.platformFeeBps, 10000),
      delivery_fee_paise: int('deliveryFeePaise', b.deliveryFeePaise),
      delivery_earning_paise: int('deliveryEarningPaise', b.deliveryEarningPaise),
      tax_bps: int('taxBps', b.taxBps, 10000),
      discount_funded_by: b.discountFundedBy || 'platform',
    };
    if (!['deduct_from_cafeteria', 'charge_to_customer'].includes(terms.commission_mode)) {
      throw BadRequest('commissionMode must be deduct_from_cafeteria or charge_to_customer');
    }
    if (!['platform', 'cafeteria'].includes(terms.discount_funded_by)) {
      throw BadRequest('discountFundedBy must be platform or cafeteria');
    }

    /* ---- the two-tier delivery earning --------------------------------
       Both or neither. A threshold with no higher amount (or the reverse)
       is a rule that would look configured and do nothing, so it is
       refused here as well as by the table's CHECK constraint. */
    const blank = (v) => v === null || v === undefined || v === '';
    const hasTier = !blank(b.deliveryEarningHighPaise) || !blank(b.deliveryEarningThresholdPaise);
    if (hasTier && (blank(b.deliveryEarningHighPaise) || blank(b.deliveryEarningThresholdPaise))) {
      throw BadRequest('A higher delivery earning needs both an amount and an order value to start at',
        'Set deliveryEarningHighPaise and deliveryEarningThresholdPaise together, or leave both empty.');
    }
    terms.delivery_earning_high_paise = hasTier ? int('deliveryEarningHighPaise', b.deliveryEarningHighPaise) : null;
    terms.delivery_earning_threshold_paise = hasTier ? int('deliveryEarningThresholdPaise', b.deliveryEarningThresholdPaise) : null;
    if (hasTier && terms.delivery_earning_high_paise < terms.delivery_earning_paise) {
      throw BadRequest('The higher delivery earning is lower than the base one',
        'The amount paid above the threshold must be at least the base earning.');
    }

    const created = await tx(async (c) => {
      await c.query(
        `UPDATE pricing_policy SET effective_to = now()
          WHERE effective_to IS NULL AND vendor_id IS NOT DISTINCT FROM $1`, [vendorId]);
      const { rows } = await c.query(
        `INSERT INTO pricing_policy (vendor_id, commission_bps, commission_mode,
           platform_fee_flat_paise, platform_fee_bps, delivery_fee_paise,
           delivery_earning_paise, delivery_earning_high_paise, delivery_earning_threshold_paise,
           tax_bps, discount_funded_by, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [vendorId, terms.commission_bps, terms.commission_mode,
         terms.platform_fee_flat_paise, terms.platform_fee_bps, terms.delivery_fee_paise,
         terms.delivery_earning_paise, terms.delivery_earning_high_paise,
         terms.delivery_earning_threshold_paise, terms.tax_bps, terms.discount_funded_by,
         b.note ? String(b.note).slice(0, 300) : null, req.actor.id]);
      return rows[0];
    });
    await audit(req, { action: 'pricing.update', resource: 'pricing_policy',
                       resourceId: created.id, outcome: 'ok', detail: terms });
    return {
      policy: created,
      appliesTo: 'orders created from now on',
      note: 'Orders already placed keep the terms they were priced under.',
    };
  });

  /* ======================================================================
     PAYOUTS
     ====================================================================== */

  app.get('/admin/payouts', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const { rows } = await q(
      `SELECT p.*, v.name AS vendor_name, u.name AS partner_name, b.kind AS batch_kind,
              b.period_start, b.period_end
         FROM payout p
         LEFT JOIN vendor v ON v.id = p.vendor_id
         LEFT JOIN app_user u ON u.id = p.partner_id
         LEFT JOIN payout_batch b ON b.id = p.batch_id
        WHERE ($1::text IS NULL OR p.state = $1)
        ORDER BY p.created_at DESC LIMIT 200`, [req.query?.state || null]);
    const batches = (await q(
      `SELECT b.*, count(p.id)::int AS payouts,
              COALESCE(sum(p.amount_paise),0)::bigint AS total_paise,
              count(*) FILTER (WHERE p.state = 'paid')::int       AS paid_count,
              count(*) FILTER (WHERE p.state = 'failed')::int     AS failed_count,
              count(*) FILTER (WHERE p.state = 'processing')::int AS processing_count,
              ${BATCH_STATUS_SQL}
         FROM payout_batch b LEFT JOIN payout p ON p.batch_id = b.id
        GROUP BY b.id ORDER BY b.created_at DESC LIMIT 50`)).rows;
    return { payouts: rows, batches: batches.map(numeric), provider: providerNote() };
  });

  /* Build a settlement batch: one pending payout per payee with an
     outstanding balance. Amounts come from the ledger under a lock, so two
     administrators clicking at once cannot queue the same money twice. */

  /* ======================================================================
     SETTLEMENT RECONCILIATION

     Importing the provider's own settlement report is the ONLY way a gateway
     fee enters this system. See services/reconciliation.js for why the
     payment webhook is not treated as authoritative for it.

     `payout.manage` rather than `finance.read_all`: this writes money
     figures, so reading the books is not enough to run it.
     ====================================================================== */

  /* Run the importer. Safe to call repeatedly — every layer of the
     idempotency is on the individual settlement line, so a re-run over the
     same window reads the same lines, applies nothing, and changes no
     number. That property is what makes this cron-able. */
  app.post('/admin/finance/reconciliation/import', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const b = req.body || {};
    let run;
    try {
      run = await importSettlements({
        from: b.from, to: b.to,
        settlementId: b.settlementId, utr: b.utr,
        graceHours: b.graceHours,
        actorId: req.actor.id,
      });
    } catch (e) {
      /* A failed run is already recorded as failed by the importer, with its
         partial counts intact. Surfacing the error truthfully matters more
         than a tidy response: "the import failed" and "the import found
         nothing" must never look the same to an operator. */
      await audit(req, { action: 'reconciliation.import', outcome: 'error',
                         detail: { error: String(e.message).slice(0, 300) } });
      throw e;
    }
    await audit(req, { action: 'reconciliation.import', resource: 'settlement_import',
                       resourceId: run.id, outcome: 'ok',
                       detail: { state: run.state, seen: run.entries_seen,
                                 applied: run.entries_new, duplicates: run.entries_duplicate,
                                 exceptions: run.exceptions_raised,
                                 fees_paise: Number(run.fees_recorded_paise) } });
    return {
      import: numeric(run),
      /* Said explicitly, because "the provider's API answered" is not the
         same fact as "the money is reconciled", and an operator reading a
         green tick deserves to know which one they are looking at. */
      reconciled: run.state === 'completed',
      needsAttention: run.exceptions_raised > 0,
    };
  });

  /* Import history, and every open difference. */
  app.get('/admin/finance/reconciliation', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const imports = (await q(
      `SELECT i.*, u.name AS started_by_name
         FROM provider_settlement_import i
         LEFT JOIN app_user u ON u.id = i.started_by
        ORDER BY i.started_at DESC LIMIT 50`)).rows.map(numeric);
    const exceptions = (await openExceptions({ kind: req.query?.kind || null }))
      .map(numeric);

    /* How much of the book is actually reconciled. This is the number that
       says whether the net-revenue line can be trusted yet. */
    const coverage = await one(
      `SELECT count(*)::int AS paid,
              count(*) FILTER (WHERE reconciled_at IS NOT NULL)::int AS reconciled
         FROM payment WHERE status IN ('paid','refunded')`);

    return {
      imports, exceptions,
      openExceptionCount: exceptions.length,
      blockingCount: exceptions.filter((x) => x.severity === 'blocking').length,
      coverage: {
        paidPayments: coverage.paid,
        reconciledPayments: coverage.reconciled,
        unreconciledPayments: coverage.paid - coverage.reconciled,
      },
    };
  });

  /* Close a difference. Records that a person looked and decided; it moves
     no money. A difference that needs money moved needs an explicit
     adjustment posting, which is its own audited action. */
  app.post('/admin/finance/reconciliation/exceptions/:id/resolve', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    let out;
    try {
      out = await resolveException(req.params.id,
        { actorId: req.actor.id, note: req.body?.note });
    } catch (e) {
      if (e.expected) throw BadRequest(e.message,
        'Say what you found and what you did about it. It is written to the audit log.');
      throw e;
    }
    if (!out) throw NotFound('No such open reconciliation exception');
    await audit(req, { action: 'reconciliation.exception.resolved',
                       resource: 'reconciliation_exception', resourceId: out.id,
                       outcome: 'ok', detail: { kind: out.kind, note: out.resolution_note } });
    return numeric(out);
  });

  app.post('/admin/payouts/batches', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const b = req.body || {};
    const out = await tx((c) => buildBatch(c, {
      kind: b.kind, periodStart: b.periodStart, periodEnd: b.periodEnd,
      minPaise: b.minPaise === undefined ? undefined : Number(b.minPaise),
      actorId: req.actor.id, note: b.note,
    }));
    await audit(req, { action: 'payout.batch', resource: 'payout_batch',
                       resourceId: out.batch.id, outcome: 'ok',
                       detail: { kind: b.kind, payouts: out.payouts.length } });
    return {
      batch: out.batch,
      payouts: out.payouts,
      skipped: out.skipped,
      totalPaise: out.payouts.reduce((s, p) => s + p.amount_paise, 0),
      provider: providerNote(),
    };
  });

  /* ---------- the settlement review workflow ------------------------------
     A batch is built (by the schedule, or by hand), then REVIEWED, then
     APPROVED, then RELEASED. Only the release moves money, and even then
     only through a configured provider or an administrator's own recorded
     bank transfer. Nothing here can pay anyone by accident.               */

  app.get('/admin/payouts/batches/:id', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const batch = await one(
      `SELECT b.*, u.name AS created_by_name, a.name AS approved_by_name
         FROM payout_batch b
         LEFT JOIN app_user u ON u.id = b.created_by
         LEFT JOIN app_user a ON a.id = b.approved_by
        WHERE b.id = $1`, [req.params.id]);
    if (!batch) throw NotFound('No such batch');

    /* Each line shows what is being paid AND why, so an administrator can
       review the arithmetic rather than take the total on trust. */
    const lines = (await q(
      `SELECT p.*, v.name AS vendor_name, u.name AS partner_name,
              d.provider_fund_account_id IS NOT NULL AS has_destination,
              cs.gross_food_sales_paise, cs.commission_paise AS statement_commission_paise,
              cs.refunds_paise, cs.adjustments_paise
         FROM payout p
         LEFT JOIN vendor v ON v.id = p.vendor_id
         LEFT JOIN app_user u ON u.id = p.partner_id
         LEFT JOIN payout_destination d ON d.id = p.destination_id
         LEFT JOIN v_cafeteria_statement cs ON cs.vendor_id = p.vendor_id
        WHERE p.batch_id = $1
        ORDER BY p.amount_paise DESC`, [batch.id])).rows;

    return {
      batch,
      payouts: lines.map(numeric),
      totalPaise: lines.reduce((t, p) => t + p.amount_paise, 0),
      counts: {
        pending: lines.filter((p) => p.state === 'pending').length,
        paid: lines.filter((p) => p.state === 'paid').length,
        failed: lines.filter((p) => p.state === 'failed').length,
        withoutDestination: lines.filter((p) => !p.has_destination).length,
      },
      provider: providerNote(),
    };
  });

  /* Approval is a person taking responsibility for the numbers. It moves no
     money; it records that the batch was reviewed and by whom. */
  app.post('/admin/payouts/batches/:id/approve', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const b = await one(`SELECT * FROM payout_batch WHERE id = $1`, [req.params.id]);
    if (!b) throw NotFound('No such batch');
    if (b.state !== 'open') throw Conflict(`That batch is already ${b.state}`);

    const updated = await one(
      `UPDATE payout_batch SET state='approved', approved_by=$2, approved_at=now()
        WHERE id=$1 AND state='open' RETURNING *`, [b.id, req.actor.id]);
    if (!updated) throw Conflict('That batch was approved by someone else a moment ago');

    await audit(req, { action: 'payout.batch.approved', resource: 'payout_batch',
                       resourceId: b.id, outcome: 'ok' });
    return { batch: updated, note: 'Approved. No money has moved yet — release it to pay.' };
  });

  /* Release. With a provider connected this actually sends each payout; with
     none, it returns the list of transfers to make by hand and marks nothing
     paid. It is idempotent per payout: an already-paid line is skipped, so a
     retry after a partial failure pays only what is still owed. */
  app.post('/admin/payouts/batches/:id/release', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const b = await one(`SELECT * FROM payout_batch WHERE id = $1`, [req.params.id]);
    if (!b) throw NotFound('No such batch');
    if (b.state === 'cancelled') throw Conflict('That batch was cancelled');
    if (b.state === 'open') {
      throw Conflict('That batch has not been approved',
        'A settlement is reviewed and approved before it is released.');
    }

    const out = await releaseBatch({ q, tx }, { batch: b, actorId: req.actor.id });
    if (PAYOUTS.configured) await closeIfDone(b.id);

    await audit(req, { action: 'payout.batch.release', resource: 'payout_batch',
                       resourceId: b.id, outcome: out.failed.length ? 'error' : 'ok',
                       detail: { mode: out.mode, paid: out.paid.length,
                                 failed: out.failed.length } });
    return {
      ...out,
      provider: providerNote(),
      note: out.note || (out.failed.length
        ? 'Some payouts failed. Retrying the release is safe: paid lines are skipped and only ' +
          'the outstanding ones are attempted again.'
        : null),
    };
  });

  /* A failed payout goes back to pending so the release can be retried. The
     ledger was never touched by the failure, so nothing needs unwinding. */
  app.post('/admin/payouts/:id/retry', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const p = await one(`SELECT * FROM payout WHERE id = $1`, [req.params.id]);
    if (!p) throw NotFound('No such payout');
    if (p.state === 'paid') throw Conflict('That payout is already paid',
      'A paid payout is never retried. Post an adjustment if it needs reversing.');
    if (p.state !== 'failed') throw Conflict(`Only a failed payout can be retried (this one is ${p.state})`);

    const back = await one(
      `UPDATE payout SET state='pending', failure_reason=NULL WHERE id=$1 AND state='failed'
       RETURNING *`, [p.id]);
    if (!back) throw Conflict('That payout changed state a moment ago');
    await audit(req, { action: 'payout.retry', resource: 'payout', resourceId: p.id,
                       outcome: 'ok' });
    return { id: p.id, state: 'pending', amountPaise: p.amount_paise };
  });

  /* ---------- the schedule itself ---------------------------------------- */

  app.get('/admin/settlement/schedule', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const cfg = await schedule();
    const recent = (await q(
      `SELECT id, kind, period_key, origin, state, created_at, approved_at, completed_at
         FROM payout_batch WHERE origin = 'scheduled'
        ORDER BY created_at DESC LIMIT 20`)).rows;
    return {
      ...cfg,
      /* Truthful about what the schedule can and cannot do here. */
      autoReleasePossible: PAYOUTS.configured,
      note: PAYOUTS.configured
        ? 'Batches are built automatically. Release is a manual step unless auto-release is on.'
        : 'Batches are built automatically and always await an administrator, because no payout ' +
          'provider is connected to release them through.',
      recentRuns: recent,
    };
  });

  app.put('/admin/settlement/schedule', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const b = req.body || {};
    const writes = [];

    if (b.timezone) {
      try { new Intl.DateTimeFormat('en-GB', { timeZone: String(b.timezone) }); }
      catch { throw BadRequest(`"${b.timezone}" is not a timezone this server recognises`); }
      writes.push(['settlement_timezone', JSON.stringify(String(b.timezone))]);
    }
    for (const kind of ['cafeteria', 'partner']) {
      const v = b[kind];
      if (!v) continue;
      const hour = Number(v.hour), minute = Number(v.minute ?? 0);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw BadRequest(`${kind}.hour must be 0-23`);
      }
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw BadRequest(`${kind}.minute must be 0-59`);
      }
      const cfg = { enabled: v.enabled !== false, hour, minute,
                    min_paise: Number.isInteger(Number(v.minPaise)) ? Number(v.minPaise) : 100 };
      if (kind === 'partner') {
        const weekday = Number(v.weekday ?? 1);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
          throw BadRequest('partner.weekday must be 0 (Sunday) to 6 (Saturday)');
        }
        cfg.weekday = weekday;
      }
      writes.push([`settlement_${kind}_schedule`, JSON.stringify(cfg)]);
    }
    if (b.autoRelease !== undefined) {
      if (b.autoRelease === true && !PAYOUTS.configured) {
        throw ProviderUnavailable('Auto-release needs a connected payout provider',
          'With no provider there is nothing to release through, and Quad will not mark a ' +
          'settlement paid on a schedule when no money moved.');
      }
      writes.push(['settlement_auto_release', JSON.stringify(b.autoRelease === true)]);
    }
    if (!writes.length) throw BadRequest('Nothing to change');

    await tx(async (c) => {
      for (const [key, value] of writes) {
        await c.query(
          `INSERT INTO platform_config (key, value) VALUES ($1,$2)
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [key, value]);
      }
    });
    await audit(req, { action: 'settlement.schedule', outcome: 'ok',
                       detail: Object.fromEntries(writes) });
    return await schedule();
  });

  /* Run the schedule now, rather than waiting for the hour. Idempotent: if
     this period's batch already exists it says so and builds nothing. */
  app.post('/admin/settlement/run', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const out = await runSettlementSchedules({ now: new Date(), log: req.log });
    await audit(req, { action: 'settlement.run', outcome: 'ok', detail: out });
    return out;
  });

  /* Send one payout through the configured provider. This makes a real
     outbound transfer request; with no provider it refuses rather than
     pretending, and points at the manual path. */
  app.post('/admin/payouts/:id/execute', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    if (!PAYOUTS.configured) {
      throw ProviderUnavailable('No payout provider is connected',
        'Opening a payout account (RazorpayX or Cashfree Payouts) and provisioning each ' +
        'payee there is external ' +
        'provisioning work that has not been done on this deployment. Until it is, ' +
        'make the transfer from your bank and record it with POST /admin/payouts/:id/record, ' +
        'supplying the UTR. Nothing here will claim a transfer that did not happen.');
    }
    const p = await one(`SELECT * FROM payout WHERE id = $1`, [req.params.id]);
    if (!p) throw NotFound('No such payout');
    if (p.state !== 'pending') throw Conflict(`That payout is ${p.state}`);
    const dest = p.destination_id
      ? await one(`SELECT * FROM payout_destination WHERE id = $1`, [p.destination_id])
      : null;

    await q(`UPDATE payout SET state='processing', method=$2 WHERE id=$1`, [p.id, PAYOUTS.method]);
    let result;
    try {
      result = await sendToProvider(p, dest);
    } catch (e) {
      await q(`UPDATE payout SET state='failed', failure_reason=$2 WHERE id=$1`,
              [p.id, String(e.message).slice(0, 300)]);
      await audit(req, { action: 'payout.failed', resource: 'payout', resourceId: p.id,
                         outcome: 'error', detail: { error: String(e.message).slice(0, 300) } });
      throw e;
    }

    if (!result.settled) {
      /* Queued or still processing at the provider. It is NOT paid, the
         payable is NOT discharged, and the ledger stays untouched until a
         later status check says the money moved. */
      await q(`UPDATE payout SET provider_payout_id=$2 WHERE id=$1`, [p.id, result.providerPayoutId]);
      await audit(req, { action: 'payout.submitted', resource: 'payout', resourceId: p.id,
                         outcome: 'ok', detail: { status: result.status } });
      return { id: p.id, state: 'processing', providerStatus: result.status,
               note: 'Submitted to the provider. It is not settled until the transfer completes.' };
    }

    const done = await tx((c) => settle(c, p.id, {
      method: result.method, providerPayoutId: result.providerPayoutId,
      externalReference: result.utr, actorId: req.actor.id,
    }));
    if (p.batch_id) await closeIfDone(p.batch_id);
    await audit(req, { action: 'payout.paid', resource: 'payout', resourceId: p.id,
                       outcome: 'ok', detail: { amount_paise: p.amount_paise,
                                                provider_payout_id: result.providerPayoutId } });
    return { id: p.id, state: 'paid', amountPaise: p.amount_paise,
             providerPayoutId: result.providerPayoutId, posting: done.posting };
  });

  /* Record a transfer an administrator actually made from their own bank.
     This is not a simulated payout: it demands the bank's reference, and
     the database CHECK refuses a paid row without one. */
  app.post('/admin/payouts/:id/record', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const reference = String(req.body?.reference || '').trim();
    if (reference.length < 4) {
      throw BadRequest('The bank reference for the transfer is required',
        'Enter the UTR / transaction reference from your bank. A payout is only marked ' +
        'settled against evidence that the money moved.');
    }
    const p = await one(`SELECT * FROM payout WHERE id = $1`, [req.params.id]);
    if (!p) throw NotFound('No such payout');

    const done = await tx((c) => settle(c, p.id, {
      method: 'manual_bank_transfer', externalReference: reference.slice(0, 120),
      actorId: req.actor.id,
    }));
    if (p.batch_id) await closeIfDone(p.batch_id);
    await audit(req, { action: 'payout.recorded', resource: 'payout', resourceId: p.id,
                       outcome: 'ok', detail: { amount_paise: p.amount_paise, reference } });
    return { id: p.id, state: 'paid', amountPaise: p.amount_paise,
             reference, duplicate: done.posting.duplicate };
  });

  app.post('/admin/payouts/:id/cancel', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const p = await one(`SELECT * FROM payout WHERE id = $1`, [req.params.id]);
    if (!p) throw NotFound('No such payout');
    if (p.state === 'paid') throw Conflict('A paid payout cannot be cancelled',
      'Post an adjustment if the money needs to come back.');
    await q(`UPDATE payout SET state='cancelled', failure_reason=$2 WHERE id=$1`,
            [p.id, String(req.body?.reason || 'cancelled by admin').slice(0, 200)]);
    await audit(req, { action: 'payout.cancelled', resource: 'payout', resourceId: p.id,
                       outcome: 'ok' });
    return { id: p.id, state: 'cancelled' };
  });

  /* Where a payee's money goes. Quad stores the provider's opaque ids only —
     no bank account numbers, no IFSC codes — because the beneficiary is
     provisioned in the provider's console, not here. */
  app.put('/admin/payouts/destination', async (req) => {
    authorize(req.actor, 'payout.manage');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const b = req.body || {};
    if ((!b.vendorId) === (!b.partnerId)) {
      throw BadRequest('Specify exactly one of vendorId or partnerId');
    }
    if (!b.fundAccountId) {
      throw BadRequest('A provider fund account id is required',
        'Create the payee as a contact and fund account in the payout provider, then paste ' +
        'the fund account id here. Quad does not accept or store bank account numbers.');
    }
    const provider = PAYOUTS.provider || 'razorpayx';
    const row = await tx(async (c) => {
      await c.query(
        `UPDATE payout_destination SET active = false
          WHERE active AND provider = $3
            AND vendor_id IS NOT DISTINCT FROM $1 AND partner_id IS NOT DISTINCT FROM $2`,
        [b.vendorId || null, b.partnerId || null, provider]);
      return (await c.query(
        `INSERT INTO payout_destination (vendor_id, partner_id, provider,
           provider_contact_id, provider_fund_account_id, label, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [b.vendorId || null, b.partnerId || null, provider,
         b.contactId || null, String(b.fundAccountId).slice(0, 120),
         b.label ? String(b.label).slice(0, 120) : null, req.actor.id])).rows[0];
    });
    await audit(req, { action: 'payout.destination', resource: 'payout_destination',
                       resourceId: row.id, outcome: 'ok' });
    return row;
  });

  /* A manual correction, as a first-class ledger transaction with a reason.
     Positive credits the payee, negative deducts from them. */
  app.post('/admin/finance/adjustments', async (req) => {
    authorize(req.actor, 'finance.adjust');
    assertRecentPasskey(req.actor, 'a financial adjustment or deposit deduction');
    const b = req.body || {};
    const amount = Number(b.amountPaise);
    if (!Number.isInteger(amount) || amount === 0) {
      throw BadRequest('amountPaise must be a non-zero whole number of paise');
    }
    const reason = String(b.reason || '').trim();
    if (reason.length < 4) throw BadRequest('An adjustment needs a reason');
    if ((!b.vendorId) === (!b.partnerId)) {
      throw BadRequest('Specify exactly one of vendorId or partnerId');
    }
    /* The idempotency ref is supplied by the caller so a retried request is
       one adjustment, not two. */
    const ref = String(b.idempotencyKey || `${req.actor.id}:${Date.now()}`).slice(0, 120);
    const out = await tx((c) => postAdjustment(c, {
      vendorId: b.vendorId || null, partnerId: b.partnerId || null,
      amountPaise: amount, reason: reason.slice(0, 300), actorId: req.actor.id, ref,
    }));
    await audit(req, { action: 'finance.adjustment', outcome: 'ok',
                       detail: { amount_paise: amount, reason, vendorId: b.vendorId,
                                 partnerId: b.partnerId } });
    return { ...out, amountPaise: amount, reason };
  });

  /* ======================================================================
     CAFETERIA — the Counter's own money, and nobody else's
     ====================================================================== */
  app.get('/vendors/:id/finance', async (req) => {
    const vendorId = req.params.id;
    const v = await one(`SELECT id, name FROM vendor WHERE id = $1`, [vendorId]);
    if (!v) throw NotFound('No such cafeteria');
    /* The vendor is read from the database and THEN checked, so the id in
       the URL cannot select someone else's books. A platform role passes on
       finance.read_all instead. */
    try {
      authorize(req.actor, 'finance.read', { vendorId });
    } catch (e) {
      authorize(req.actor, 'finance.read_all');
    }

    const stmt = await one(`SELECT * FROM v_cafeteria_statement WHERE vendor_id = $1`, [vendorId]);
    const today = await one(
      `SELECT count(*)::int AS orders,
              COALESCE(sum(f.food_subtotal_paise),0)::bigint AS food_paise,
              COALESCE(sum(f.commission_paise),0)::bigint    AS commission_paise
         FROM order_financials f
         JOIN food_order o ON o.id = f.order_id
         JOIN ledger_txn t ON t.order_id = o.id AND t.kind = 'order_capture'
        WHERE o.vendor_id = $1 AND t.created_at >= date_trunc('day', now())`, [vendorId]);
    const payouts = (await q(
      `SELECT id, amount_paise, state, method, external_reference, provider_payout_id,
              created_at, paid_at
         FROM payout WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 50`, [vendorId])).rows;
    const recent = (await q(
      `SELECT o.code, t.created_at, f.food_subtotal_paise, f.commission_paise,
              f.cafeteria_payable_paise
         FROM order_financials f
         JOIN food_order o ON o.id = f.order_id
         JOIN ledger_txn t ON t.order_id = o.id AND t.kind = 'order_capture'
        WHERE o.vendor_id = $1 ORDER BY t.created_at DESC LIMIT 25`, [vendorId])).rows;

    return {
      vendor: v,
      todayOrders: today.orders,
      todayFoodPaise: Number(today.food_paise),
      todayCommissionPaise: Number(today.commission_paise),
      ...numeric(stmt || {}),
      orders: recent,
      settlements: payouts,
      /* The terms currently in force, so a shopkeeper can see what the
         commission actually is rather than inferring it. */
      terms: await one(
        `SELECT commission_bps, commission_mode, effective_from FROM pricing_policy
          WHERE effective_to IS NULL AND (vendor_id = $1 OR vendor_id IS NULL)
          ORDER BY vendor_id NULLS LAST LIMIT 1`, [vendorId]),
    };
  });

  /* ======================================================================
     PARTNER — see routes/partner.js GET /partner/earnings, which is
     ledger-backed and scoped to the caller's own id.
     ====================================================================== */
}

/* pg returns bigint as a JS number here (see db/index.js) but sum() of int
   comes back as a string on some builds; normalise once so no surface has to
   guess which. */
function numeric(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = /_paise$/.test(k) && v !== null ? Number(v) : v;
  }
  return out;
}

/* A batch is complete when no line is still waiting to be paid. Called after
   a release and after each individual settlement, so the state reflects the
   payouts rather than being set optimistically. */
async function closeIfDone(batchId) {
  await q(
    `UPDATE payout_batch SET state = 'completed', completed_at = now()
      WHERE id = $1 AND state = 'approved'
        AND NOT EXISTS (SELECT 1 FROM payout
                         WHERE batch_id = $1 AND state IN ('pending','processing'))`,
    [batchId]);
}

function providerNote() {
  return {
    provider: PAYOUTS.provider,
    configured: PAYOUTS.configured,
    methods: PAYOUTS.configured ? [PAYOUTS.method, 'manual_bank_transfer'] : ['manual_bank_transfer'],
    blocker: PAYOUTS.configured ? null
      : 'RazorpayX (or an equivalent payout provider) has not been provisioned for this ' +
        'deployment. That is an external account-opening step, not a code change. Until it ' +
        'is done, settlements are transfers an administrator makes and records here.',
  };
}
