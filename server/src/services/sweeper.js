/* ==========================================================================
   QUAD — BACKGROUND SWEEPER

   Periodic work that must happen even when nobody is clicking:

   · expire delivery offers nobody answered, and re-offer to the next round
   · abandon orders that never got paid, so they do not sit as live drafts
   · delete ID-card images past the retention window
   · prune consumed and expired OTP challenges

   All of it is idempotent and safe to run on several instances at once,
   because every statement is a conditional UPDATE rather than a read
   followed by a write.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { RETENTION } from '../config.js';
import { assignDelivery } from './delivery.js';
import { purgeExpiredIdImages } from './storage.js';
import { notifyAsync } from './notify.js';

const MAX_ROUNDS = 3;
const ABANDON_AFTER_MINUTES = 20;

export async function expireOffers() {
  const { rows } = await q(
    `UPDATE delivery_offer SET state = 'expired'
      WHERE state = 'offered' AND expires_at < now()
      RETURNING order_id, round`);
  const byOrder = new Map();
  for (const r of rows) byOrder.set(r.order_id, Math.max(byOrder.get(r.order_id) || 0, r.round));

  let reoffered = 0;
  for (const [orderId, round] of byOrder) {
    const o = await one(
      `SELECT id, state, partner_id, customer_id FROM food_order WHERE id = $1`, [orderId]);
    /* Only re-offer an order that is still waiting and still unassigned. */
    if (!o || o.partner_id || !['ready', 'confirmed', 'preparing'].includes(o.state)) continue;
    if (round >= MAX_ROUNDS) {
      /* Out of rounds. The customer is told the truth, not shown a
         placeholder partner. */
      notifyAsync(o.customer_id, 'partner_assigned', {
        title: 'Still finding a delivery partner',
        body: 'No partner has accepted yet. We are still trying.' });
      continue;
    }
    const out = await assignDelivery(orderId, { round: round + 1 });
    if (out.offered) reoffered += out.offered;
  }
  return { expired: rows.length, reoffered };
}

/* An order that reached awaiting_payment and was never captured. */
export async function abandonUnpaidOrders() {
  const { rows } = await q(
    `UPDATE food_order SET state = 'cancelled'
      WHERE state = 'awaiting_payment'
        AND created_at < now() - ($1 || ' minutes')::interval
      RETURNING id, customer_id, code`, [String(ABANDON_AFTER_MINUTES)]);
  for (const o of rows) {
    await q(`INSERT INTO order_event (order_id, from_state, to_state, actor_role, note)
             VALUES ($1,'awaiting_payment','cancelled','system','payment not completed')`, [o.id]);
    await q(`UPDATE payment SET status='cancelled'
              WHERE order_id=$1 AND status='pending'`, [o.id]);
    notifyAsync(o.customer_id, 'order_cancelled',
      { body: `Order ${o.code} was cancelled because payment was not completed.` });
  }
  return { abandoned: rows.length };
}

export async function pruneOtp() {
  const r = await q(
    `DELETE FROM otp_challenge
      WHERE created_at < now() - interval '24 hours'`);
  /* Kept for 48h, not 24h: the per-address daily send cap counts them. */
  const e = await q(
    `DELETE FROM email_challenge
      WHERE created_at < now() - interval '48 hours'`);
  return { pruned: r.rowCount, emailPruned: e.rowCount };
}

export async function sweepOnce(log) {
  const out = {};
  for (const [name, fn] of [
    ['offers', expireOffers],
    ['orders', abandonUnpaidOrders],
    ['otp', pruneOtp],
    ['idImages', () => purgeExpiredIdImages(RETENTION.idImageDays).then((n) => ({ purged: n }))],
  ]) {
    try { out[name] = await fn(); }
    catch (e) { out[name] = { error: e.message }; log?.error({ e }, `sweeper ${name} failed`); }
  }
  return out;
}

export function startSweeper(app, intervalMs = 30_000) {
  const timer = setInterval(async () => {
    const out = await sweepOnce(app.log);
    const busy = Object.values(out).some((v) => v && Object.values(v).some((n) => typeof n === 'number' && n > 0));
    if (busy) app.log.info({ sweep: out }, 'sweeper');
  }, intervalMs);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));
  return timer;
}
