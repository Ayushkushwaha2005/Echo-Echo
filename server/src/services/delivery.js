/* ==========================================================================
   QUAD — DELIVERY ASSIGNMENT

   An order is offered to eligible partners; the first to accept wins, and
   the partial unique index `one_accepted_offer_per_order` makes that a
   database guarantee rather than an application hope. If nobody accepts,
   the order stays unassigned and the customer is told exactly that — there
   is no placeholder partner and no invented name.

   Eligibility, all checked server-side:
     * partner_profile.status = 'approved'  (admin decision)
     * partner_profile.online = true        (their own toggle)
     * app_user.student_status = 'approved' (verified student)
     * not the customer of this order
     * not already on an active delivery
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { Conflict, NotFound, Forbidden } from '../auth/rbac.js';
import { notifyAsync } from './notify.js';

const OFFER_TTL_SECONDS = 45;

export async function eligiblePartners(orderId) {
  const { rows } = await q(
    `SELECT u.id, u.name
       FROM app_user u
       JOIN partner_profile p ON p.user_id = u.id
       JOIN user_role r ON r.user_id = u.id AND r.role = 'delivery_partner' AND r.status = 'active'
      WHERE p.status = 'approved' AND p.online
        AND u.status = 'active' AND u.student_status = 'approved'
        AND u.id <> (SELECT customer_id FROM food_order WHERE id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM food_order o WHERE o.partner_id = u.id
             AND o.state IN ('assigned','picked_up'))
      ORDER BY random() LIMIT 10`, [orderId]);
  return rows;
}

/* Called after payment capture and after a vendor marks an order ready. */
export async function assignDelivery(orderId, { round = 1 } = {}) {
  const o = await one(`SELECT * FROM food_order WHERE id = $1`, [orderId]);
  if (!o || o.fulfilment !== 'delivery') return { offered: 0 };
  if (o.partner_id) return { offered: 0, note: 'already assigned' };

  const partners = await eligiblePartners(orderId);
  if (!partners.length) return { offered: 0, note: 'no_partner_available' };

  for (const p of partners) {
    await q(
      `INSERT INTO delivery_offer (order_id, partner_id, expires_at, round)
       VALUES ($1,$2, now() + ($3 || ' seconds')::interval, $4)`,
      [orderId, p.id, String(OFFER_TTL_SECONDS), round]);
    notifyAsync(p.id, 'delivery_offer', { body: 'A delivery is available to accept.',
                                          data: { orderId, round } });
  }
  return { offered: partners.length, round };
}

/* First accept wins. The unique index converts a race into a clean 409. */
export async function acceptOffer(offerId, partnerId) {
  return tx(async (c) => {
    const offer = (await c.query(
      `SELECT * FROM delivery_offer WHERE id = $1 FOR UPDATE`, [offerId])).rows[0];
    if (!offer) throw NotFound('No such delivery offer');
    if (offer.partner_id !== partnerId) throw Forbidden('That offer is not yours');
    if (offer.state !== 'offered') throw Conflict(`This offer is already ${offer.state}`);
    if (new Date(offer.expires_at) < new Date()) {
      await c.query(`UPDATE delivery_offer SET state='expired' WHERE id=$1`, [offerId]);
      throw Conflict('That offer has expired');
    }
    /* Eligibility is re-checked at the moment of acceptance, not only when
       the offer was made: a partner suspended, un-verified or already
       carrying another order in the last 45 seconds cannot take this one.
       One order in a partner's care at a time keeps responsibility for it
       unambiguous. */
    const fit = (await c.query(
      `SELECT p.status, u.status AS account, u.student_status,
              EXISTS (SELECT 1 FROM food_order o WHERE o.partner_id = u.id
                        AND o.state IN ('assigned','picked_up')) AS busy
         FROM app_user u JOIN partner_profile p ON p.user_id = u.id WHERE u.id = $1`, [partnerId])).rows[0];
    if (!fit || fit.status !== 'approved' || fit.account !== 'active' || fit.student_status !== 'approved') {
      throw Forbidden('You are not currently eligible to take deliveries');
    }
    if (fit.busy) throw Conflict('Finish your current delivery first', 'A partner carries one order at a time.');
    const order = (await c.query(`SELECT state, partner_id FROM food_order WHERE id = $1 FOR UPDATE`, [offer.order_id])).rows[0];
    if (order.partner_id || !['confirmed', 'preparing', 'ready'].includes(order.state)) {
      await c.query(`UPDATE delivery_offer SET state='expired' WHERE id=$1`, [offerId]);
      throw Conflict('This order is no longer available');
    }
    try {
      await c.query(
        `UPDATE delivery_offer SET state='accepted', responded_at=now() WHERE id=$1`, [offerId]);
    } catch (e) {
      if (e.code === '23505') throw Conflict('Another partner took this order first');
      throw e;
    }
    await c.query(
      `UPDATE delivery_offer SET state='expired'
        WHERE order_id = $1 AND id <> $2 AND state = 'offered'`, [offer.order_id, offerId]);
    await c.query(`UPDATE food_order SET partner_id = $2 WHERE id = $1`, [offer.order_id, partnerId]);
    await c.query(
      `INSERT INTO order_event (order_id, from_state, to_state, actor_id, actor_role, note)
       SELECT id, state, 'assigned', $2, 'delivery_partner', 'offer accepted'
         FROM food_order WHERE id = $1`, [offer.order_id, partnerId]);
    await c.query(`UPDATE food_order SET state='assigned' WHERE id=$1 AND state='ready'`, [offer.order_id]);
    const cust = (await c.query(`SELECT customer_id FROM food_order WHERE id=$1`, [offer.order_id])).rows[0];
    notifyAsync(cust.customer_id, 'partner_assigned',
                { body: 'A delivery partner has accepted your order.', data: { orderId: offer.order_id } });
    return { orderId: offer.order_id };
  });
}
