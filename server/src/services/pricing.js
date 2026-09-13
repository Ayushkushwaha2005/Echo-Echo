/* ==========================================================================
   QUAD — PRICING AND ALLOCATION

   One function decides what a customer pays and where every paisa of it
   belongs. It runs on the server, inside the ordering transaction, from a
   pricing_policy row read out of the database. Nothing a client sends
   reaches it: `quote()` takes a subtotal that was itself computed from
   menu_item rows, and a policy id, and that is all.

   The worked example from the product brief:

     food subtotal          10000   (100.00)
     commission @ 200bps      200   (2.00, deducted from the cafeteria)
     platform fee flat        500   (5.00, charged to the customer)
     delivery fee             1000   (10.00, charged to the customer)
     delivery earning         1000   (10.00, paid to the partner)
     ------------------------------------------------------------------
     customer total         11500   (115.00)
       cafeteria payable     9800   (98.00)
       delivery payable      1000   (10.00)
       Quad gross             700   (7.00 = 500 platform fee + 200 commission)

   The three allocations always sum to the customer total. That is asserted
   here and then asserted again by a CHECK constraint on order_financials,
   so an arithmetic mistake cannot reach the database.
   ========================================================================== */
import { BadRequest } from '../auth/rbac.js';

/* Basis points of an integer amount, rounded half-up to whole paise. */
const bps = (amount, points) => Math.round((amount * points) / 10000);

/**
 * The commercial terms in force for a vendor, right now.
 *
 * A vendor-specific live policy wins over the platform default. The row is
 * returned whole so the caller can pin its id onto the order: from that
 * moment the order is priced by THAT version for ever, whatever is
 * configured later.
 *
 * @param c        a pg client inside the ordering transaction
 * @param vendorId the cafeteria being ordered from
 */
export async function livePolicy(c, vendorId) {
  const { rows } = await c.query(
    `SELECT * FROM pricing_policy
      WHERE effective_to IS NULL AND (vendor_id = $1 OR vendor_id IS NULL)
      ORDER BY vendor_id NULLS LAST
      LIMIT 1`, [vendorId]);
  if (!rows[0]) {
    /* Cannot happen after migration 004, which inserts the default in the
       same transaction as the table. If it ever does, refusing to price is
       the only safe answer. */
    throw new Error('No live pricing policy: the platform default is missing.');
  }
  return rows[0];
}

/** The policy a specific historical order was priced under. */
export async function policyById(c, id) {
  const { rows } = await c.query(`SELECT * FROM pricing_policy WHERE id = $1`, [id]);
  return rows[0] || null;
}

/**
 * Turn a food subtotal and a policy into the full financial picture.
 *
 * @param policy       a pricing_policy row
 * @param subtotalPaise  computed from menu_item rows by the caller
 * @param fulfilment   'pickup' | 'delivery'
 * @param discountPaise  a platform- or cafeteria-funded reduction, 0 by default
 * @returns every field of order_financials except the order and policy ids
 */
export function quote(policy, { subtotalPaise, fulfilment, discountPaise = 0 }) {
  if (!Number.isInteger(subtotalPaise) || subtotalPaise < 0) {
    throw new Error(`subtotalPaise must be a non-negative integer (got ${subtotalPaise})`);
  }
  if (!Number.isInteger(discountPaise) || discountPaise < 0) {
    throw BadRequest('A discount must be a whole number of paise');
  }
  /* A discount can reduce an order to zero but never below it, and never
     into a negative payable for whoever funds it. */
  const discount = Math.min(discountPaise, subtotalPaise);

  const delivering = fulfilment === 'delivery';
  const deliveryFee     = delivering ? policy.delivery_fee_paise : 0;
  const deliveryEarning = delivering ? policy.delivery_earning_paise : 0;

  /* Commission and tax are proportions of the food actually sold, i.e. after
     a discount, so a discounted meal is not commissioned at its list price. */
  const netFood    = subtotalPaise - discount;
  const commission = bps(netFood, policy.commission_bps);
  const tax        = bps(netFood, policy.tax_bps);
  const platformFee = policy.platform_fee_flat_paise + bps(netFood, policy.platform_fee_bps);

  const chargeCommission = policy.commission_mode === 'charge_to_customer';
  const customerTotal = netFood + tax + deliveryFee + platformFee
                      + (chargeCommission ? commission : 0);

  const vendorFunded   = policy.discount_funded_by === 'cafeteria' ? discount : 0;
  const platformFunded = policy.discount_funded_by === 'platform' ? discount : 0;

  /* The cafeteria is paid for the food it sold, less whatever it funds. */
  const cafeteriaPayable = subtotalPaise - vendorFunded - (chargeCommission ? 0 : commission);
  if (cafeteriaPayable < 0) {
    throw BadRequest('That discount is larger than the cafeteria share of this order',
      'A cafeteria-funded discount cannot exceed the food subtotal less commission.');
  }

  /* Quad keeps its fee and its commission, plus any margin between what the
     customer is charged for delivery and what the partner is paid for it,
     less any discount Quad itself is funding. It can legitimately be
     negative: that is a subsidised order, and it is recorded as one. */
  const platformGross = platformFee + commission + (deliveryFee - deliveryEarning) - platformFunded;

  const allocated = cafeteriaPayable + deliveryEarning + tax + platformGross;
  if (allocated !== customerTotal) {
    /* Belt and braces before the database says the same thing. */
    throw new Error(
      `allocation does not balance: customer pays ${customerTotal} but ` +
      `${allocated} was allocated (cafeteria ${cafeteriaPayable}, delivery ` +
      `${deliveryEarning}, tax ${tax}, platform ${platformGross})`);
  }

  return {
    food_subtotal_paise: subtotalPaise,
    discount_paise: discount,
    tax_paise: tax,
    delivery_fee_paise: deliveryFee,
    platform_fee_paise: platformFee,
    commission_paise: commission,
    customer_total_paise: customerTotal,
    cafeteria_payable_paise: cafeteriaPayable,
    delivery_earning_paise: deliveryEarning,
    tax_payable_paise: tax,
    platform_gross_paise: platformGross,
    commission_mode: policy.commission_mode,
    discount_funded_by: policy.discount_funded_by,
  };
}

/**
 * Write the snapshot. Called once, inside the transaction that creates the
 * order; the table's trigger makes it immutable from here on.
 */
export async function writeSnapshot(c, orderId, policyId, q) {
  const { rows } = await c.query(
    `INSERT INTO order_financials (
       order_id, pricing_policy_id,
       food_subtotal_paise, discount_paise, tax_paise, delivery_fee_paise,
       platform_fee_paise, commission_paise, customer_total_paise,
       cafeteria_payable_paise, delivery_earning_paise, tax_payable_paise,
       platform_gross_paise, commission_mode, discount_funded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [orderId, policyId,
     q.food_subtotal_paise, q.discount_paise, q.tax_paise, q.delivery_fee_paise,
     q.platform_fee_paise, q.commission_paise, q.customer_total_paise,
     q.cafeteria_payable_paise, q.delivery_earning_paise, q.tax_payable_paise,
     q.platform_gross_paise, q.commission_mode, q.discount_funded_by]);
  return rows[0];
}

/** The snapshot for an order, or null. Never recomputed. */
export async function snapshotFor(c, orderId) {
  const { rows } = await c.query(`SELECT * FROM order_financials WHERE order_id = $1`, [orderId]);
  return rows[0] || null;
}

/**
 * Split a refund across the parties in proportion to what each received.
 *
 * Proportional rather than a waterfall, because a full refund must reverse
 * every party exactly and a partial one should not arbitrarily punish one of
 * them. Largest-remainder rounding makes the parts sum to the refund exactly
 * — no rounding dust is created or destroyed.
 *
 * The one asymmetry is deliberate and configured: if the delivery was
 * actually completed, the partner has done the work, and
 * `refund_delivery_policy` decides whether they keep the earning (Quad
 * absorbs it) or it is clawed back.
 *
 * @param snap            the order_financials row
 * @param amountPaise     the refund being issued
 * @param deliveryCompleted  whether a partner has already earned on this order
 * @param deliveryPolicy  'platform_absorbs' | 'clawback_partner'
 */
export function allocateRefund(snap, amountPaise, { deliveryCompleted, deliveryPolicy }) {
  const total = snap.customer_total_paise;
  if (!Number.isInteger(amountPaise) || amountPaise <= 0 || amountPaise > total) {
    throw BadRequest(`A refund must be between 1 and ${total} paise`);
  }
  const buckets = [
    ['cafeteria', snap.cafeteria_payable_paise],
    ['platform',  snap.platform_gross_paise],
    ['delivery',  snap.delivery_earning_paise],
    ['tax',       snap.tax_payable_paise],
  ];

  /* Largest remainder: floor everything, then hand the leftover paise to
     whichever buckets were cut hardest. */
  const raw = buckets.map(([name, share]) => {
    const exact = (share * amountPaise) / total;
    const floor = Math.floor(exact);
    return { name, floor, rem: exact - floor };
  });
  let left = amountPaise - raw.reduce((s, r) => s + r.floor, 0);
  for (const r of [...raw].sort((a, b) => b.rem - a.rem)) {
    if (left <= 0) break;
    r.floor += 1; left -= 1;
  }
  const part = Object.fromEntries(raw.map((r) => [r.name, r.floor]));

  /* A negative platform share (a subsidised order) floors differently; the
     arithmetic above still sums correctly, but assert it rather than trust
     it, because this number becomes real money. */
  let fromDelivery = part.delivery;
  let fromPlatform = part.platform;
  if (deliveryCompleted && deliveryPolicy !== 'clawback_partner') {
    /* The partner keeps it, so Quad funds that part of the refund. */
    fromPlatform += fromDelivery;
    fromDelivery = 0;
  }

  const alloc = {
    from_cafeteria_paise: part.cafeteria,
    from_platform_paise: fromPlatform,
    from_delivery_paise: fromDelivery,
    from_tax_paise: part.tax,
    total_paise: amountPaise,
    delivery_policy: deliveryCompleted ? deliveryPolicy : 'not_yet_earned',
  };
  const sum = alloc.from_cafeteria_paise + alloc.from_platform_paise
            + alloc.from_delivery_paise + alloc.from_tax_paise;
  if (sum !== amountPaise) {
    throw new Error(`refund allocation does not sum: ${sum} vs ${amountPaise}`);
  }
  return alloc;
}
