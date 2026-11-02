/* ==========================================================================
   CASHFREE SANDBOX CHECKOUT SCENARIOS — no tunnel needed.

     node --env-file=<path to .env.sandbox> scripts/sandbox-checkout.mjs

   Real: every Cashfree call, including Order Pay with Cashfree's official
   sandbox UPI instruments, status reads and session termination.
   Local: this branch's server and the throwaway test database. Without a public
   URL Cashfree cannot reach the webhook here, so paid orders confirm through the
   server's status pull, and webhook scenarios are signed locally with the sandbox
   secret using Cashfree's algorithm. scripts/sandbox-e2e.mjs covers real delivery.

   Refuses anything but the sandbox and a local database. Prints statuses only.
   ========================================================================== */
import { createHmac } from 'node:crypto';

if (!/sandbox\.cashfree\.com/.test(process.env.CASHFREE_PG_BASE_URL || '')) {
  console.error('Refusing: CASHFREE_PG_BASE_URL must be the Cashfree sandbox.'); process.exit(2);
}
const results = [];
const record = (name, ok, note = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = await import('../test/helpers/db.mjs');
await db.startDb();
if (!/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL || '')) {
  console.error('Refusing: the database is not the local test cluster.'); process.exit(2);
}
Object.assign(process.env, {
  NODE_ENV: 'test', SWEEPER: 'off', LOG_LEVEL: 'warn', WEB_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'sandbox-checkout-cookie-secret-at-least-32-chars', PLATFORM_OWNER_PHONE: '+919000000000',
});
const { pool } = await import('../src/db/index.js');
const { build } = await import('../src/index.js');
const { sessionFor, client } = await import('../test/helpers/api.mjs');
const app = await build();
const { PAYMENTS } = await import('../src/config.js');
const { cashfree } = await import('../src/services/payment-providers.js');
const { abandonUnpaidOrders } = await import('../src/services/sweeper.js');

const cfHeaders = { 'x-api-version': PAYMENTS.cashfree.apiVersion, 'Content-Type': 'application/json',
                    'x-client-device': 'desktop', 'x-client-os': 'windows', 'x-client-browser': 'chrome' };
const orderPay = async (sessionId, upiId) => {
  const r = await fetch(`${PAYMENTS.cashfreeBase}/pg/orders/sessions`, { method: 'POST', headers: cfHeaders,
    body: JSON.stringify({ payment_session_id: sessionId,
      payment_method: { upi: { channel: 'collect', upi_id: upiId, upi_expiry_minutes: 10 } } }) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const cfOrder = async (id) => (await cashfree.fetchOrder(id)).raw?.order || {};
const stateOf = async (id) => (await pool.query(`SELECT state FROM food_order WHERE id=$1`, [id])).rows[0].state;
const payOf = async (id) => (await pool.query(`SELECT * FROM payment WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
const ledgerCount = async (id) => (await pool.query(`SELECT count(*)::int n FROM ledger_entry WHERE order_id=$1`, [id])).rows[0].n;
const signed = (payload, { ts = Date.now(), key, secret = PAYMENTS.cashfree.secretKey } = {}) => {
  const raw = JSON.stringify(payload);
  return { method: 'POST', url: '/payments/webhook', payload: raw, headers: {
    'content-type': 'application/json', 'x-webhook-timestamp': String(ts),
    'x-idempotency-key': key || 'k' + Math.random(),
    'x-webhook-signature': createHmac('sha256', secret).update(String(ts) + raw).digest('base64') } };
};
const success = (id, amount, currency = 'INR') => ({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: {
  order: { order_id: id, order_amount: amount, order_currency: currency },
  payment: { cf_payment_id: 880000 + Math.floor(Math.random() * 1000), payment_status: 'SUCCESS',
             payment_amount: amount, payment_currency: currency } } });
async function until(fn, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(2500); }
  return null;
}

let exit = 0;
try {
  await db.truncateAll(pool);
  const campus = await db.makeCampus(pool);
  await db.setTerms(pool, { platform_fee_flat_paise: 1000, delivery_fee_paise: 500, delivery_earning_paise: 1000 });
  const vendor = await db.makeVendor(pool, { name: 'Sandbox Café', slug: 'sandbox-cafe' });
  const item = await db.makeItem(pool, vendor.id, { name: 'Thali', paise: 10000 });
  let n = 0;
  const newCustomer = async () => {
    const u = await db.makeUser(pool, { phone: '+91960000' + String(2000 + (++n)), name: 'Sandbox Student' });
    return client(app, await sessionFor(pool, u.id));
  };
  const order = async (c) => {
    const d = await c.post('/orders/draft', { vendorId: vendor.id, lines: [{ itemId: item.id, qty: 1 }],
                                              fulfilment: 'delivery', destinationId: campus.blockB.id });
    if (d.status !== 200) throw new Error('draft failed: ' + JSON.stringify(d.body));
    const i = await c.post('/payments/intent', { orderId: d.body.id });
    return { c, orderId: d.body.id, intent: i.body, intentStatus: i.status };
  };
  const status = async (o) => (await o.c.get(`/payments/status?orderId=${o.orderId}`)).body;

  /* ---- successful payment ---- */
  const A = await order(await newCustomer());
  record('Cashfree accepts the order with a 20-minute expiry', !!A.intent.paymentSessionId && A.intentStatus === 200);
  const made = await cfOrder(A.intent.paymentId);
  const left = new Date(made.order_expiry_time).getTime() - Date.now();
  record('Cashfree holds that expiry, not its 30-day default', left > 15 * 60e3 && left < 25 * 60e3,
         `${Math.round(left / 60e3)} min left`);
  record('Cashfree holds the server amount and currency', Number(made.order_amount) === 115 && made.order_currency === 'INR');

  /* ---- pending, and a forged return ---- */
  let st = await status(A);
  record('Pending: an unpaid order is not confirmed', st.confirmed === false && st.orderState === 'awaiting_payment');
  const forged = await A.c.get(`/payments/status?orderId=${A.orderId}&order_status=PAID&payment_status=SUCCESS&txStatus=SUCCESS`);
  record('Forged success redirect confirms nothing', forged.body.confirmed === false && await stateOf(A.orderId) === 'awaiting_payment');

  /* ---- invalid signature, against a live order ---- */
  const bad = await app.inject(signed(success(A.intent.paymentId, '115.00'), { secret: 'not-the-secret' }));
  record('Invalid webhook signature is refused', bad.statusCode === 400 && await stateOf(A.orderId) === 'awaiting_payment', `HTTP ${bad.statusCode}`);
  const stale = await app.inject(signed(success(A.intent.paymentId, '115.00'), { ts: Date.now() - 3600e3 }));
  record('Expired webhook timestamp is refused', stale.statusCode === 400 && await stateOf(A.orderId) === 'awaiting_payment', `HTTP ${stale.statusCode}`);

  /* ---- duplicate submission ---- */
  const again = await A.c.post('/payments/intent', { orderId: A.orderId });
  record('Double-tap resumes the same Cashfree session', again.body.paymentSessionId === A.intent.paymentSessionId);

  const pay = await orderPay(A.intent.paymentSessionId, 'testsuccess@gocash');
  record('Cashfree accepts the sandbox success instrument', pay.status === 200, `HTTP ${pay.status}`);
  const done = await until(async () => (await status(A)).confirmed);
  record('Successful payment confirms the order, verified with Cashfree', !!done && await stateOf(A.orderId) === 'confirmed');
  record('Payment row is paid with the Cashfree payment id', (await payOf(A.orderId)).status === 'paid' && !!(await payOf(A.orderId)).provider_payment_id);

  /* ---- refresh / back ---- */
  const entries = await ledgerCount(A.orderId);
  for (let i = 0; i < 3; i++) st = await status(A);
  record('Refresh and back after payment change nothing', st.confirmed === true && entries > 0 && await ledgerCount(A.orderId) === entries);
  const reIntent = await A.c.post('/payments/intent', { orderId: A.orderId });
  record('A paid order cannot be paid again', reIntent.status === 409, `HTTP ${reIntent.status}`);

  /* ---- duplicate webhook ---- */
  const dupe = success(A.intent.paymentId, '115.00');
  const d1 = await app.inject(signed(dupe, { key: 'same-delivery' }));
  const d2 = await app.inject(signed(dupe, { key: 'same-delivery' }));
  record('Duplicate webhook allocates nothing twice', d1.statusCode === 200 && d2.statusCode === 200 && await ledgerCount(A.orderId) === entries);

  /* ---- failed payment ---- */
  const B = await order(await newCustomer());
  const payB = await orderPay(B.intent.paymentSessionId, 'testfailure@gocash');
  record('Cashfree accepts the sandbox failure instrument', payB.status === 200, `HTTP ${payB.status}`);
  const failed = await until(async () => (await status(B)).payment === 'failed');
  record('Failed payment is recorded and not confirmed', !!failed && await stateOf(B.orderId) === 'awaiting_payment');

  /* ---- amount and currency mismatch ---- */
  const C = await order(await newCustomer());
  await app.inject(signed(success(C.intent.paymentId, '1.00')));
  record('Amount mismatch is flagged, not confirmed', await stateOf(C.orderId) === 'awaiting_payment' && /amount_mismatch/.test((await payOf(C.orderId)).flagged_reason || ''));
  const D = await order(await newCustomer());
  await app.inject(signed(success(D.intent.paymentId, '115.00', 'USD')));
  record('Currency mismatch is flagged, not confirmed', await stateOf(D.orderId) === 'awaiting_payment' && /currency_mismatch/.test((await payOf(D.orderId)).flagged_reason || ''));

  /* ---- retry with a new order closes the old session at Cashfree ---- */
  const cust = await newCustomer();
  const E1 = await order(cust);
  const E2 = await order(cust);
  const old = await cfOrder(E1.intent.paymentId);
  record('A new order closes the earlier attempt', E2.intentStatus === 200 && await stateOf(E1.orderId) === 'cancelled');
  record('Cashfree reports that earlier session closed', /TERMINATED|TERMINATION_REQUESTED/.test(old.order_status), old.order_status);
  const late = await orderPay(E1.intent.paymentSessionId, 'testsuccess@gocash');
  record('The closed session cannot be paid', late.status !== 200, `HTTP ${late.status}`);

  /* ---- abandoned checkout / expired session ---- */
  const F = await order(await newCustomer());
  await pool.query(`UPDATE food_order SET created_at = now() - interval '30 minutes' WHERE id=$1`, [F.orderId]);
  await abandonUnpaidOrders();
  const closed = await cfOrder(F.intent.paymentId);
  record('Abandoned checkout is cancelled', await stateOf(F.orderId) === 'cancelled' && (await payOf(F.orderId)).status === 'cancelled');
  record('Cashfree reports the abandoned session closed', /TERMINATED|TERMINATION_REQUESTED/.test(closed.order_status), closed.order_status);
  const expired = await orderPay(F.intent.paymentSessionId, 'testsuccess@gocash');
  record('An expired session cannot be paid', expired.status !== 200, `HTTP ${expired.status}`);
  st = await status(F);
  record('The customer sees it as not confirmed', st.confirmed === false && st.orderState === 'cancelled');
} catch (e) {
  record('script completed', false, String(e.message).slice(0, 200));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  exit = failed ? 1 : 0;
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
  await db.stopDb().catch(() => {});
}
process.exit(exit);
