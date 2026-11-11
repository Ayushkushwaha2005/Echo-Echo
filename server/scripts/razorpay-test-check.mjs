/* ==========================================================================
   Razorpay TEST-MODE acceptance check — proves Razorpay accepts our requests.

     node --env-file=.env.razorpay-test scripts/razorpay-test-check.mjs

   Uses the real adapter. Refuses LIVE keys. Prints no secret. What it does:
     1. creates a ₹115.00 order through the adapter and reads it back
     2. prints the order id and the public key id so the owner can pay it
        in Razorpay's test checkout (test UPI / test cards)
     3. with --order <order_id>: pulls that order's payments and prints the
        normalised outcome (paid / failed / pending), exactly as
        /payments/status would see it
     4. with --refund <payment_id> [--amount <paise>]: issues a test refund
        through the adapter and reads it back by its provider id
   A test payment can only be completed in Razorpay's checkout; this script
   never fakes a success.
   ========================================================================== */
import { randomUUID } from 'node:crypto';
import { PAYMENTS } from '../src/config.js';
import { razorpay } from '../src/services/providers/razorpay.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

if (!razorpay.configured) {
  console.error('Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET (test mode).');
  process.exit(2);
}
if (!/^rzp_test_/.test(PAYMENTS.razorpay.keyId || '')) {
  console.error('Refusing: RAZORPAY_KEY_ID is not a test-mode key (rzp_test_...). This script never touches live money.');
  process.exit(2);
}
console.log('key id:', PAYMENTS.razorpay.keyId, '(test mode)');
console.log('api base:', PAYMENTS.apiBase);

const orderId = opt('--order');
const refundOf = opt('--refund');

if (orderId) {
  const ev = await razorpay.fetchOrder(orderId);
  console.log('order', orderId, '->', ev.outcome, 'payment:', ev.providerPaymentId,
              'amount paise:', ev.amountPaise, 'fee paise:', ev.feePaise);
  process.exit(0);
}

if (refundOf) {
  const amountPaise = Number(opt('--amount') || 11500);
  const refundId = randomUUID();
  const out = await razorpay.refund({ payment: { provider_payment_id: refundOf }, refundId,
                                      amountPaise, reason: 'test-mode check', orderCode: 'TEST' });
  console.log('refund accepted:', out.providerRefundId, 'status:', out.status, 'settled:', out.settled);
  const back = await razorpay.fetchRefund(null, refundId, { provider_refund_id: out.providerRefundId });
  console.log('refund read back:', back.status, '->', back.outcome, 'amount paise:', back.amountPaise);
  process.exit(0);
}

const paymentId = randomUUID();
const created = await razorpay.createOrder({
  paymentId, amountPaise: 11500,
  order: { id: randomUUID(), code: 'TST' + paymentId.slice(0, 5) },
  customer: { id: 'test_customer', phone: '9999999999', name: 'Test Payer' },
});
console.log('order created:', created.providerOrderId);
console.log('checkout opens with key', created.checkout.keyId, 'and order', created.checkout.gatewayOrderId);
const read = await razorpay.fetchOrder(created.providerOrderId);
console.log('order status before payment:', read.outcome, '(expected: pending)');
if (read.outcome !== 'pending') { console.error('Unexpected outcome before any payment'); process.exit(1); }
console.log('\nNext: pay this order in Razorpay test checkout, then run again with --order', created.providerOrderId);
