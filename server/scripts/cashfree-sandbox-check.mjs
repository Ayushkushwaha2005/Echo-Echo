/* ==========================================================================
   Cashfree SANDBOX acceptance check — proves Cashfree accepts our requests.

     node --env-file=.env.sandbox scripts/cashfree-sandbox-check.mjs

   Uses the real adapters. Refuses to run against production. Prints no
   secret. What it does:
     1. creates a ₹115.00 PG order (UPI + cards) and reads it back
     2. prints the payment_session_id so the owner can pay it in the
        sandbox checkout with Cashfree's test UPI/card details
     3. if Payouts sandbox credentials are set: registers a Cashfree test
        beneficiary and sends a ₹1.00 transfer, then reads its status
   A sandbox payment can only be completed in Cashfree's hosted checkout;
   this script never fakes a success.
   ========================================================================== */
import { randomUUID } from 'node:crypto';
import { PAYMENTS, PAYOUTS } from '../src/config.js';
import { cashfree as pg } from '../src/services/payment-providers.js';
import { cashfree as po } from '../src/services/payout-providers.js';

const sandbox = (u) => /sandbox\.cashfree\.com/.test(u);
if (!sandbox(PAYMENTS.cashfreeBase)) {
  console.error('Refusing: CASHFREE_PG_BASE_URL must be https://sandbox.cashfree.com');
  process.exit(2);
}
if (!pg.configured) { console.error('Set CASHFREE_PG_APP_ID and CASHFREE_PG_SECRET_KEY (sandbox).'); process.exit(2); }

const paymentId = randomUUID();
const created = await pg.createOrder({
  paymentId, amountPaise: 11500,
  order: { id: randomUUID(), code: 'SBX' + paymentId.slice(0, 5) },
  customer: { id: 'sandbox_customer', phone: '9999999999', name: 'Sandbox Tester' },
});
console.log('PG order created:', created.providerOrderId);
console.log('payment_session_id:', created.sessionId);
const read = await pg.fetchOrder(created.providerOrderId);
console.log('PG order status:', read.outcome, 'amount paise:', read.amountPaise);
if (read.amountPaise !== 11500) { console.error('Amount mismatch'); process.exit(1); }

if (po.configured) {
  if (!sandbox(PAYOUTS.cashfreeBase)) { console.error('Refusing: CASHFREE_PAYOUT_BASE_URL must be sandbox'); process.exit(2); }
  /* Cashfree's published sandbox test account (success case). */
  const ben = await po.createBeneficiary({
    beneficiaryId: 'ee_sbx_' + paymentId.replace(/-/g, '').slice(0, 20), name: 'Sandbox Tester',
    instrument: 'bank', accountNumber: '026291800001191', ifsc: 'YESB0000262' });
  console.log('beneficiary:', ben.beneficiaryId, ben.status);
  const transferId = randomUUID();
  const sent = await po.send({ id: transferId, amount_paise: 100 }, { provider_fund_account_id: ben.beneficiaryId });
  console.log('transfer:', sent.status, 'settled:', sent.settled);
  const status = await po.fetchTransfer(transferId);
  console.log('transfer status (pull):', status.status, status.outcome);
} else {
  console.log('Payouts sandbox credentials not set; skipped payout check.');
}
