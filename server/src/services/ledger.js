/* ==========================================================================
   QUAD — THE LEDGER

   Double entry, debit-positive, append-only. Every posting is a set of legs
   that sums to zero, and the database refuses a transaction that does not
   (see the deferred constraint trigger in 004_finance_ledger.sql). Nothing
   in this file can create money; it can only move it between accounts.

   Idempotency is structural rather than defensive. Each posting declares a
   (kind, ref) pair — `order_capture` + the payment id, `payout` + the payout
   id — and ledger_txn holds a UNIQUE on that pair. A webhook retry, a
   double-clicked payout or a replayed refund therefore inserts nothing and
   posts nothing, and `post()` reports it as a duplicate rather than raising.

   Sign convention, once, so no caller has to think about it:

     debit  (+)  gateway_clearing, gateway_fee
     credit (-)  platform_revenue, cafeteria_payable, delivery_clearing,
                 delivery_payable, tax_payable

   So "we owe the cafeteria 98 rupees" is a -9800 entry on that cafeteria's
   payable account, and v_account_balance reports it as +9800 owed.
   ========================================================================== */

/* ---------- accounts ------------------------------------------------------
   Platform-wide accounts are created by the migration. Per-party accounts
   are created on first use, under ON CONFLICT so two concurrent orders for
   the same cafeteria cannot create two accounts.                            */

export async function accountId(c, kind, { vendorId = null, partnerId = null } = {}) {
  const normal = ['gateway_clearing', 'gateway_fee', 'deposit_bank'].includes(kind)
    ? 'debit' : 'credit';
  const { rows } = await c.query(
    `INSERT INTO ledger_account (kind, vendor_id, partner_id, normal)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (kind,
                  COALESCE(vendor_id,  '00000000-0000-0000-0000-000000000000'::uuid),
                  COALESCE(partner_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET kind = EXCLUDED.kind
     RETURNING id`, [kind, vendorId, partnerId, normal]);
  return rows[0].id;
}

export const cafeteriaAccount = (c, vendorId) =>
  accountId(c, 'cafeteria_payable', { vendorId });
export const partnerAccount = (c, partnerId) =>
  accountId(c, 'delivery_payable', { partnerId });

/* ---------- posting -------------------------------------------------------
   `legs` is an array of { account, amount, memo?, orderId?, paymentId?,
   refundId?, payoutId? }, where `account` is an account id and `amount` is
   signed debit-positive paise. Zero-amount legs are dropped rather than
   rejected, because a legitimately zero component (no tax, no delivery on a
   pickup order) should not need a conditional at every call site.

   @returns { txnId, duplicate, legs } — `duplicate: true` means this exact
            (kind, ref) was already posted and NOTHING was written now.
*/
export async function post(c, { kind, ref, orderId = null, memo = null, createdBy = null, legs }) {
  if (!kind || !ref) throw new Error('a ledger posting needs a kind and an idempotency ref');

  const live = legs.filter((l) => l.amount !== 0);
  const sum = live.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) {
    throw new Error(`refusing to post an unbalanced ledger transaction (${kind}/${ref}): ` +
                    `legs sum to ${sum} paise, not 0`);
  }
  if (!live.length) return { txnId: null, duplicate: false, legs: 0, empty: true };

  /* The idempotency gate. ON CONFLICT DO NOTHING returns no row when this
     fact has already been recorded, and we then do nothing at all. */
  const txn = await c.query(
    `INSERT INTO ledger_txn (kind, ref, order_id, memo, created_by)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (kind, ref) DO NOTHING RETURNING id`,
    [kind, String(ref), orderId, memo, createdBy]);
  if (!txn.rowCount) return { txnId: null, duplicate: true, legs: 0 };

  const txnId = txn.rows[0].id;
  for (const l of live) {
    await c.query(
      `INSERT INTO ledger_entry (txn_id, account_id, amount_paise, order_id,
                                 payment_id, refund_id, payout_id, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [txnId, l.account, l.amount, l.orderId ?? orderId, l.paymentId ?? null,
       l.refundId ?? null, l.payoutId ?? null, l.memo ?? null]);
  }
  return { txnId, duplicate: false, legs: live.length };
}

/* ---------- the four postings this product makes -------------------------- */

/**
 * A customer paid. This is the moment the money is allocated, and it is the
 * only place an order's snapshot becomes ledger entries.
 *
 *   customer pays 115  →  gateway_clearing      +11500
 *                         cafeteria_payable      -9800
 *                         delivery_clearing      -1000
 *                         platform_revenue        -700
 *
 * The delivery money goes to a platform-held clearing account rather than to
 * a partner: at capture time nobody has earned it yet, and on a pickup order
 * nobody ever will.
 *
 * Idempotent on the payment id, so a second `payment.captured` webhook — a
 * retry, or a duplicate event with a fresh event id — allocates nothing.
 */
export async function postOrderCapture(c, { order, snapshot, payment }) {
  const legs = [
    { account: await accountId(c, 'gateway_clearing'),
      amount: snapshot.customer_total_paise - snapshot.gateway_fee_paise,
      memo: 'collected, net of gateway fee' },
    { account: await accountId(c, 'gateway_fee'),
      amount: snapshot.gateway_fee_paise, memo: 'gateway fee' },
    { account: await cafeteriaAccount(c, order.vendor_id),
      amount: -snapshot.cafeteria_payable_paise, memo: 'food, less commission' },
    { account: await accountId(c, 'delivery_clearing'),
      amount: -snapshot.delivery_earning_paise, memo: 'delivery earning, not yet earned' },
    { account: await accountId(c, 'tax_payable'),
      amount: -snapshot.tax_payable_paise, memo: 'tax collected' },
    { account: await accountId(c, 'platform_revenue'),
      amount: -snapshot.platform_gross_paise, memo: 'platform fee + commission + delivery margin' },
  ].map((l) => ({ ...l, orderId: order.id, paymentId: payment.id }));

  return post(c, {
    kind: 'order_capture', ref: payment.id, orderId: order.id,
    memo: `order ${order.code} captured`, legs,
  });
}

/**
 * A delivery was completed, so the partner has earned the delivery money.
 * It moves out of the platform's clearing account and onto that partner's
 * payable balance, where a payout can reach it.
 *
 * Idempotent on the order id: a handoff cannot be recorded twice, and even
 * if the route allowed it, the ledger would not.
 */
export async function postDeliveryEarned(c, { order, snapshot }) {
  if (!snapshot.delivery_earning_paise) return { txnId: null, duplicate: false, empty: true };
  if (!order.partner_id) throw new Error(`order ${order.id} delivered with no partner`);

  return post(c, {
    kind: 'delivery_earned', ref: order.id, orderId: order.id,
    memo: `delivery of ${order.code} completed`,
    legs: [
      { account: await accountId(c, 'delivery_clearing'),
        amount: snapshot.delivery_earning_paise, orderId: order.id, memo: 'earned' },
      { account: await partnerAccount(c, order.partner_id),
        amount: -snapshot.delivery_earning_paise, orderId: order.id, memo: 'owed to partner' },
    ],
  });
}

/**
 * Money went back to a customer. Each party's share of the refund reduces
 * what they are owed; the total leaves the clearing account.
 *
 * The delivery share is taken from the partner only when it has actually
 * been earned AND the configured policy claws it back — otherwise
 * `allocateRefund` has already moved that share onto the platform, and the
 * partner's balance is untouched here.
 *
 * Idempotent on the refund id.
 */
export async function postRefund(c, { order, refund, allocation, deliveryEarned }) {
  /* The cash leaves the clearing account; each party gives back its share of
     the allocation. Those two sides are equal by construction, because
     allocateRefund's parts sum to the refund exactly. */
  const legs = [
    { account: await accountId(c, 'gateway_clearing'),
      amount: -allocation.total_paise, memo: 'refunded to customer' },
    { account: await cafeteriaAccount(c, order.vendor_id),
      amount: allocation.from_cafeteria_paise, memo: 'cafeteria share of refund' },
    { account: await accountId(c, 'platform_revenue'),
      amount: allocation.from_platform_paise, memo: 'platform share of refund' },
    { account: await accountId(c, 'tax_payable'),
      amount: allocation.from_tax_paise, memo: 'tax share of refund' },
  ];
  if (allocation.from_delivery_paise !== 0) {
    /* Before the delivery is earned the money is still in clearing; after it
       is earned, a clawback comes off the partner. Which of the two applies
       was already decided by allocateRefund. */
    legs.push({
      account: deliveryEarned ? await partnerAccount(c, order.partner_id)
                              : await accountId(c, 'delivery_clearing'),
      amount: allocation.from_delivery_paise, memo: 'delivery share of refund',
    });
  }

  return post(c, {
    kind: 'refund', ref: refund.id, orderId: order.id,
    memo: `refund on ${order.code}`,
    legs: legs.map((l) => ({ ...l, orderId: order.id, refundId: refund.id })),
  });
}

/**
 * A payout actually left Quad's bank. Called only after the provider
 * confirms a transfer, or after an administrator records a transfer they
 * genuinely performed and supplies its bank reference — never on the
 * strength of a button press alone.
 *
 * Idempotent on the payout id, which is the duplicate-payout guard of last
 * resort behind the partial unique index on `payout`.
 */
export async function postPayout(c, { payout }) {
  const payable = payout.vendor_id
    ? await cafeteriaAccount(c, payout.vendor_id)
    : await partnerAccount(c, payout.partner_id);

  return post(c, {
    kind: 'payout', ref: payout.id,
    memo: `payout ${payout.id} via ${payout.method}`,
    legs: [
      /* The payable is discharged... */
      { account: payable, amount: payout.amount_paise, payoutId: payout.id, memo: 'settled' },
      /* ...by money leaving the account the customers paid into. */
      { account: await accountId(c, 'gateway_clearing'),
        amount: -payout.amount_paise, payoutId: payout.id, memo: 'transferred out' },
    ],
  });
}

/**
 * A manual correction by an administrator: a goodwill credit, a deduction
 * for a chargeback, a fix for something that happened off-platform. It is a
 * first-class ledger transaction with a reason attached, never an edit.
 *
 * @param amountPaise  positive credits the payee (Quad owes more),
 *                     negative deducts from them.
 */
export async function postAdjustment(c, { vendorId = null, partnerId = null,
                                          amountPaise, reason, actorId, ref }) {
  if (!Number.isInteger(amountPaise) || amountPaise === 0) {
    throw new Error('an adjustment must be a non-zero whole number of paise');
  }
  const payable = vendorId ? await cafeteriaAccount(c, vendorId)
                           : await partnerAccount(c, partnerId);
  return post(c, {
    kind: 'adjustment', ref, memo: reason, createdBy: actorId,
    legs: [
      { account: payable, amount: -amountPaise, memo: reason },
      { account: await accountId(c, 'platform_revenue'), amount: amountPaise, memo: reason },
    ],
  });
}

/* ---------- partner security deposit --------------------------------------
   Held in its own per-partner liability account, `partner_deposit`, which
   no earnings posting and no payout ever touches: deposit money cannot be
   paid out as earnings, and earnings cannot be taken as a deposit. The cash
   side is `deposit_bank`, because a deposit arrives by bank transfer rather
   than through the payment gateway. */
export const depositAccount = (c, partnerId) => accountId(c, 'partner_deposit', { partnerId });

/** A deposit arrived in the bank. Idempotent on the movement id. */
export async function postDepositReceived(c, { movement, actorId }) {
  return post(c, {
    kind: 'deposit_received', ref: movement.id, createdBy: actorId,
    memo: `security deposit received (${movement.external_reference})`,
    legs: [
      { account: await accountId(c, 'deposit_bank'), amount: movement.amount_paise, memo: 'deposit received' },
      { account: await depositAccount(c, movement.partner_id), amount: -movement.amount_paise, memo: 'held for partner' },
    ],
  });
}

/** An authorised deduction. The held amount becomes platform money, to
    offset the proven loss. Idempotent on the deduction id. */
export async function postDepositDeduction(c, { deduction, actorId }) {
  return post(c, {
    kind: 'deposit_deduction', ref: deduction.id, orderId: deduction.order_id, createdBy: actorId,
    memo: `deposit deduction: ${deduction.reason}`,
    legs: [
      { account: await depositAccount(c, deduction.partner_id), amount: deduction.amount_paise, memo: 'deducted from deposit' },
      { account: await accountId(c, 'platform_revenue'), amount: -deduction.amount_paise, memo: 'deposit deduction' },
    ],
  });
}

/** The remaining deposit went back to the partner. Idempotent on the movement id. */
export async function postDepositRefund(c, { movement, actorId }) {
  return post(c, {
    kind: 'deposit_refund', ref: movement.id, createdBy: actorId,
    memo: `security deposit returned (${movement.external_reference})`,
    legs: [
      { account: await depositAccount(c, movement.partner_id), amount: movement.amount_paise, memo: 'deposit returned' },
      { account: await accountId(c, 'deposit_bank'), amount: -movement.amount_paise, memo: 'transferred out' },
    ],
  });
}

/* ---------- reading -------------------------------------------------------
   Balances always come from the ledger. Nothing in this codebase computes a
   payable by multiplying an order total by today's commission rate.        */

export async function balance(q, kind, { vendorId = null, partnerId = null } = {}) {
  const { rows } = await q(
    `SELECT COALESCE(sum(balance_paise), 0)::bigint AS bal FROM v_account_balance
      WHERE kind = $1
        AND ($2::uuid IS NULL OR vendor_id = $2)
        AND ($3::uuid IS NULL OR partner_id = $3)`, [kind, vendorId, partnerId]);
  return Number(rows[0].bal);
}

/** Every entry touching one order, in posting order. For the audit trail. */
export async function entriesForOrder(q, orderId) {
  const { rows } = await q(
    `SELECT e.id, e.amount_paise, e.memo, e.created_at,
            t.kind AS txn_kind, t.ref AS txn_ref, t.id AS txn_id,
            a.kind AS account_kind, a.vendor_id, a.partner_id, a.normal
       FROM ledger_entry e
       JOIN ledger_txn t ON t.id = e.txn_id
       JOIN ledger_account a ON a.id = e.account_id
      WHERE e.order_id = $1
      ORDER BY e.id`, [orderId]);
  return rows.map((r) => ({
    ...r,
    amount_paise: Number(r.amount_paise),
    /* Natural sign, so a reader sees "the cafeteria was credited 9800". */
    effect_paise: r.normal === 'credit' ? -Number(r.amount_paise) : Number(r.amount_paise),
  }));
}
