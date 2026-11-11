/* ==========================================================================
   Refund status — what the provider says happened to a refund we issued.

   The ledger was allocated when the provider ACCEPTED the refund (the
   customer's money is committed to them from that moment). This file only
   records whether it actually reached them, from one of two authoritative
   sources: the signed refund webhook, or a server-side status pull. A
   provider saying a refund failed after allocation is raised for a human;
   money is never silently re-allocated.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { audit } from '../audit.js';
import { adapterFor } from './payment-providers.js';

/* A provider's verdict on a refund we issued. The ledger was already
   allocated when the provider accepted the refund; this only records that
   the money actually reached the customer, or raises a mismatch if the
   provider says it did not. Nothing here re-allocates money. */
export async function applyRefundOutcome(req, rf) {
  /* Resolved by OUR refund id when the provider echoed it back (every
     refund this server issued carries it), else by the provider's own
     refund id (a refund issued from the provider's dashboard). Never by
     amount. */
  let r = rf.refundId ? await one(`SELECT * FROM refund WHERE id::text = $1`, [rf.refundId]) : null;
  if (!r && rf.providerRefundId) {
    r = await one(`SELECT * FROM refund WHERE provider_refund_id = $1`, [rf.providerRefundId]);
  }
  if (!r) return { ok: true, ignored: 'unknown refund' };
  if (rf.outcome === 'completed' && r.state === 'processing') {
    await tx(async (c) => {
      await c.query(`UPDATE refund SET state='completed', settled_at=now() WHERE id=$1 AND state='processing'`, [r.id]);
      const pay = (await c.query(`SELECT * FROM payment WHERE id=$1 FOR UPDATE`, [r.payment_id])).rows[0];
      const back = Number((await c.query(
        `SELECT COALESCE(sum(amount_paise),0)::int AS n FROM refund WHERE payment_id=$1 AND state='completed'`,
        [pay.id])).rows[0].n);
      if (back >= pay.amount_paise) await c.query(`UPDATE payment SET status='refunded' WHERE id=$1`, [pay.id]);
    });
    await audit(req, { action: 'refund.completed', resource: 'refund', resourceId: r.id, outcome: 'ok',
                       detail: { source: 'webhook' } });
    return { ok: true, refund: 'completed' };
  }
  if (rf.outcome === 'failed' && r.state !== 'failed') {
    await q(`INSERT INTO reconciliation_exception (kind, payment_id, order_id, severity, detail)
             VALUES ('refund_mismatch', $1, $2, 'blocking', $3)
             ON CONFLICT DO NOTHING`,
            [r.payment_id, r.order_id, JSON.stringify({ refundId: r.id, quadState: r.state,
              providerStatus: rf.status, note: 'The provider reports this refund failed after it was allocated.' })]);
    return { ok: true, refund: 'mismatch_raised' };
  }
  return { ok: true, refund: r.state };
}


/** Ask the provider about every refund still processing. Safe to run often. */
export async function syncProcessingRefunds({ limit = 50 } = {}) {
  const rows = (await q(
    `SELECT r.id, r.provider_refund_id, p.provider, p.provider_order_id, p.provider_payment_id
       FROM refund r JOIN payment p ON p.id = r.payment_id
      WHERE r.state = 'processing' ORDER BY r.created_at LIMIT $1`, [limit])).rows;
  const out = { checked: 0, completed: 0, failed: 0 };
  for (const r of rows) {
    let adapter;
    try { adapter = adapterFor(r.provider); } catch { continue; }
    if (typeof adapter.fetchRefund !== 'function') continue;
    try {
      /* The row is passed as a third argument for adapters that need the
         provider's own refund or payment id to look a refund up; an adapter
         that keys on (order id, our refund id) simply ignores it. */
      const st = await adapter.fetchRefund(r.provider_order_id, r.id, r);
      out.checked++;
      /* An adapter that normalises its own outcome wins; otherwise the
         status word is read in the vocabulary the first adapter used. */
      const outcome = st.outcome
        || (st.status === 'SUCCESS' ? 'completed'
          : ['CANCELLED', 'FAILED'].includes(st.status) ? 'failed' : 'pending');
      const res = await applyRefundOutcome(null, { refundId: r.id, status: st.status, outcome });
      if (res.refund === 'completed') out.completed++;
      if (res.refund === 'mismatch_raised') out.failed++;
    } catch { /* provider unreachable: next tick */ }
  }
  return out;
}
