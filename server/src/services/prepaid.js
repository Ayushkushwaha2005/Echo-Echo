/* ==========================================================================
   ECHO ECHO — ONLINE PAYMENT ONLY

   Every order, pickup or delivery, is paid online before it reaches the
   counter, and confirmed only by the payment provider (signed webhook or
   the server's own status pull). There is no cash on delivery anywhere:
   not in the UI, the API, the database or Campus Control.

   The ordering routes take no payment-method field at all, so an old or
   forged client that sends one (`paymentMethod: 'cod'`, `cod: true`) is
   refused outright rather than silently ignored: a request asking to pay
   in cash gets a plain "no", never an order that looks like it accepted.
   ========================================================================== */
import { BadRequest } from '../auth/rbac.js';

const METHOD_FIELDS = ['paymentMethod', 'payment_method', 'paymentMode', 'payment_mode', 'payWith', 'pay_with'];
const ONLINE = new Set(['online', 'upi', 'card', 'netbanking', 'cashfree']);
const CASH_FLAGS = ['cod', 'cashOnDelivery', 'cash_on_delivery', 'payOnDelivery', 'pay_on_delivery', 'payAtCounter', 'pay_at_counter'];

export const OnlineOnly = () => BadRequest('Online payment only',
  'ECHO ECHO takes UPI and card payments online before the order goes to the counter. There is no cash on delivery or pay-at-counter, for pickup or delivery.');

export function assertOnlinePayment(body) {
  if (!body || typeof body !== 'object') return;
  for (const f of METHOD_FIELDS) {
    if (body[f] === undefined || body[f] === null || body[f] === '') continue;
    if (!ONLINE.has(String(body[f]).trim().toLowerCase())) throw OnlineOnly();
  }
  for (const f of CASH_FLAGS) {
    if (body[f] !== undefined && body[f] !== null && body[f] !== false) throw OnlineOnly();
  }
}
