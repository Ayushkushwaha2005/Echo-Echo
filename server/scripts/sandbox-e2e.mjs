/* ==========================================================================
   CASHFREE SANDBOX END-TO-END — real Cashfree, real webhooks, local ledger.

     node --env-file=.env.sandbox scripts/sandbox-e2e.mjs

   What is real: every Cashfree call (order, Order Pay with Cashfree's
   official sandbox UPI instruments, status, refund) and every webhook,
   which Cashfree itself signs and delivers over HTTPS to a temporary
   Cloudflare quick tunnel. What is local: the Echo Echo server from this
   branch and the throwaway TEST database (never production — refused below).

   Nothing here fakes an outcome. A step that cannot be driven through a
   public Cashfree mechanism is reported as not automated, not as passed.
   Output carries statuses only; no credential is printed.
   ========================================================================== */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CLOUDFLARED = process.env.CLOUDFLARED_BIN;
if (!/sandbox\.cashfree\.com/.test(process.env.CASHFREE_PG_BASE_URL || '')) {
  console.error('Refusing: CASHFREE_PG_BASE_URL must be the Cashfree sandbox.'); process.exit(2);
}
if (!CLOUDFLARED || !existsSync(CLOUDFLARED)) { console.error('Set CLOUDFLARED_BIN.'); process.exit(2); }

const results = [];
const record = (name, ok, note = '') => { results.push({ name, ok, note }); console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP'}  ${name}${note ? ' — ' + note : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 1. test database only ------------------------------------------------ */
const db = await import('../test/helpers/db.mjs');
await db.startDb();
if (!/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL || '')) {
  console.error('Refusing: the database is not the local test cluster.'); process.exit(2);
}

/* ---- 2. recording proxy + tunnel ---------------------------------------- */
const APP_PORT = 47811; const PROXY_PORT = 47812;
const deliveries = [];           // raw Cashfree webhook deliveries, kept in memory only
const proxy = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.url.startsWith('/payments/webhook')) {
      deliveries.push({ headers: { ...req.headers }, body, at: Date.now() });
    }
    const fwd = httpRequest({ host: '127.0.0.1', port: APP_PORT, path: req.url, method: req.method,
                              headers: { ...req.headers, host: `127.0.0.1:${APP_PORT}` } }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
      if (req.url.startsWith('/payments/webhook')) deliveries.at(-1).status = r.statusCode;
    });
    fwd.on('error', () => { res.writeHead(502); res.end(); });
    fwd.end(body);
  });
});
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));

const tunnel = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PROXY_PORT}`],
                     { stdio: ['ignore', 'pipe', 'pipe'] });
const publicUrl = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('tunnel did not start')), 60000);
  const scan = (d) => { const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d)); if (m) { clearTimeout(t); resolve(m[0]); } };
  tunnel.stdout.on('data', scan); tunnel.stderr.on('data', scan);
});
/* Quick tunnels take a few seconds to become routable. */
for (let i = 0; i < 30; i++) {
  try { const r = await fetch(publicUrl + '/health'); if (r.status !== 530) break; } catch { /* not yet */ }
  await sleep(2000);
}
console.log('tunnel up (temporary trycloudflare host)');

/* ---- 3. the server from this branch ------------------------------------- */
Object.assign(process.env, {
  NODE_ENV: 'test', SWEEPER: 'off', LOG_LEVEL: 'warn',
  WEB_ORIGIN: 'http://localhost:3000', COOKIE_SECRET: 'sandbox-e2e-cookie-secret-at-least-32-chars',
  PLATFORM_OWNER_PHONE: '+919000000000',
  CASHFREE_PG_NOTIFY_URL: `${publicUrl}/payments/webhook`,
});
const { pool } = await import('../src/db/index.js');
const { build } = await import('../src/index.js');
const { sessionFor, client } = await import('../test/helpers/api.mjs');
const app = await build();
await app.listen({ port: APP_PORT, host: '127.0.0.1' });
const { PAYMENTS } = await import('../src/config.js');
const { cashfree } = await import('../src/services/payment-providers.js');

const cfHeaders = { 'x-api-version': PAYMENTS.cashfree.apiVersion, 'Content-Type': 'application/json',
                    'x-client-device': 'desktop', 'x-client-os': 'windows', 'x-client-browser': 'chrome' };
async function orderPay(sessionId, upiId) {
  const r = await fetch(`${PAYMENTS.cashfreeBase}/pg/orders/sessions`, { method: 'POST', headers: cfHeaders,
    body: JSON.stringify({ payment_session_id: sessionId,
                           payment_method: { upi: { channel: 'collect', upi_id: upiId, upi_expiry_minutes: 10 } } }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
async function waitFor(fn, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(2000); }
  return null;
}

try {
  /* ---- fixtures (test database) ----------------------------------------- */
  await db.truncateAll(pool);
  const campus = await db.makeCampus(pool);
  await db.setTerms(pool, { platform_fee_flat_paise: 1000, delivery_fee_paise: 500, delivery_earning_paise: 1000 });
  const vendor = await db.makeVendor(pool, { name: 'Sandbox Café', slug: 'sandbox-cafe' });
  const item = await db.makeItem(pool, vendor.id, { name: 'Thali', paise: 10000 });
  const owner = await db.makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['platform_owner'] });
  const admin = client(app, await sessionFor(pool, owner.id, { method: 'passkey' }));
  let n = 0;
  async function newOrder() {
    const u = await db.makeUser(pool, { phone: '+91960000' + String(1000 + (++n)), name: 'Sandbox Student' });
    const c = client(app, await sessionFor(pool, u.id));
    const d = await c.post('/orders/draft', { vendorId: vendor.id, lines: [{ itemId: item.id, qty: 1 }],
                                               fulfilment: 'delivery', destinationId: campus.blockB.id });
    if (d.status !== 200) throw new Error('draft failed: ' + JSON.stringify(d.body));
    const i = await c.post('/payments/intent', { orderId: d.body.id });
    if (i.status !== 200) throw new Error('intent failed: ' + JSON.stringify(i.body));
    return { c, orderId: d.body.id, intent: i.body };
  }

  /* ---- A. success ------------------------------------------------------- */
  const A = await newOrder();
  record('order created at Cashfree with a checkout session', !!A.intent.paymentSessionId);
  record('amount is ₹115.00 (11500 paise)', A.intent.amountPaise === 11500);
  const cfOrder = await cashfree.fetchOrder(A.intent.paymentId);
  record('Cashfree holds the same amount and currency', cfOrder.amountPaise === 11500 && cfOrder.currency === 'INR');
  record('Cashfree order maps back to our order', cfOrder.raw?.order?.order_tags?.quad_order_id === A.orderId);
  const again = await A.c.post('/payments/intent', { orderId: A.orderId });
  record('checkout retry resumes the same session, no second order', again.body.paymentSessionId === A.intent.paymentSessionId);
  const pending = await A.c.get(`/payments/status?orderId=${A.orderId}`);
  record('unpaid order: server-side status pull reports pending', pending.body.orderState === 'awaiting_payment' && pending.body.confirmed === false);

  const pay = await orderPay(A.intent.paymentSessionId, 'testsuccess@gocash');
  record('Cashfree accepted a sandbox UPI payment (testsuccess@gocash)', pay.status === 200, `HTTP ${pay.status}`);
  const paid = await waitFor(() => q1(`SELECT p.status, o.state FROM payment p JOIN food_order o ON o.id=p.order_id
                                        WHERE p.order_id=$1 AND p.status='paid'`, [A.orderId]));
  const viaWebhook = await q1(`SELECT count(*)::int n FROM audit_log WHERE action='payment.captured'
                                  AND resource_id=$1 AND detail->>'source'='webhook'`, [A.orderId]);
  record('payment confirmed by Cashfree\'s signed webhook (not the browser)', !!paid && viaWebhook.n === 1,
         paid ? `order ${paid.state}` : 'no confirmation within 120s');
  const okDelivery = deliveries.find((d) => d.status === 200 && String(d.body).includes(A.intent.paymentId) && String(d.body).includes('SUCCESS'));
  record('a real Cashfree webhook delivery was received and accepted', !!okDelivery);

  const f = await q1(`SELECT * FROM order_financials WHERE order_id=$1`, [A.orderId]);
  record('ledger: café 100, fee 10, partner 10, platform net 5',
         f.cafeteria_payable_paise === 10000 && f.platform_fee_paise === 1000 && f.delivery_earning_paise === 1000 && f.platform_gross_paise === 500);
  const bal = async (kind) => Number((await q1(`SELECT COALESCE(sum(balance_paise),0)::bigint n FROM v_account_balance WHERE kind=$1`, [kind])).n);
  record('ledger balances match the snapshot', await bal('cafeteria_payable') === 10000 && await bal('delivery_clearing') === 1000 && await bal('platform_revenue') === 500);

  if (okDelivery) {
    const replay = await app.inject({ method: 'POST', url: '/payments/webhook', payload: okDelivery.body,
      headers: { 'content-type': 'application/json', 'x-webhook-signature': okDelivery.headers['x-webhook-signature'],
                 'x-webhook-timestamp': okDelivery.headers['x-webhook-timestamp'],
                 ...(okDelivery.headers['x-idempotency-key'] ? { 'x-idempotency-key': okDelivery.headers['x-idempotency-key'] } : {}),
                 'x-webhook-version': okDelivery.headers['x-webhook-version'] || '' } });
    const caps = await q1(`SELECT count(*)::int n FROM ledger_txn WHERE order_id=$1 AND kind='order_capture'`, [A.orderId]);
    record('replaying Cashfree\'s exact delivery is a no-op', replay.statusCode === 200 && caps.n === 1);
    const tampered = Buffer.from(String(okDelivery.body).replace('"SUCCESS"', '"SUCCESS" '));
    const bad = await app.inject({ method: 'POST', url: '/payments/webhook', payload: tampered,
      headers: { 'content-type': 'application/json', 'x-webhook-signature': okDelivery.headers['x-webhook-signature'],
                 'x-webhook-timestamp': okDelivery.headers['x-webhook-timestamp'] } });
    record('a tampered body with Cashfree\'s signature is rejected', bad.statusCode === 400);
    const stale = await app.inject({ method: 'POST', url: '/payments/webhook', payload: okDelivery.body,
      headers: { 'content-type': 'application/json', 'x-webhook-signature': okDelivery.headers['x-webhook-signature'],
                 'x-webhook-timestamp': String(Number(okDelivery.headers['x-webhook-timestamp']) - 3600_000) } });
    record('a re-dated (replayed) timestamp is rejected', stale.statusCode === 400);
  }
  const statusAfter = await A.c.get(`/payments/status?orderId=${A.orderId}`);
  record('status endpoint reports confirmed after payment', statusAfter.body.confirmed === true);

  /* ---- B. failure ------------------------------------------------------- */
  const B = await newOrder();
  const payB = await orderPay(B.intent.paymentSessionId, 'testfailure@gocash');
  record('Cashfree accepted a sandbox failing UPI payment (testfailure@gocash)', payB.status === 200, `HTTP ${payB.status}`);
  /* The customer's browser returns and polls status: the server pulls the
     attempt from Cashfree (a webhook, if Cashfree sends one, works too). */
  const failed = await waitFor(async () => { await B.c.get(`/payments/status?orderId=${B.orderId}`);
    return q1(`SELECT status FROM payment WHERE order_id=$1 AND status='failed'`, [B.orderId]); });
  const bState = await q1(`SELECT state FROM food_order WHERE id=$1`, [B.orderId]);
  const bLedger = await q1(`SELECT count(*)::int n FROM ledger_txn WHERE order_id=$1`, [B.orderId]);
  record('failed payment recorded; order not confirmed; no ledger entries', !!failed && bState.state === 'awaiting_payment' && bLedger.n === 0,
         failed ? '' : 'no failure webhook within 120s');

  const retryB = await B.c.post('/payments/intent', { orderId: B.orderId });
  record('after a failed attempt the order can be retried with a fresh checkout',
         retryB.status === 200 && retryB.body.paymentId !== B.intent.paymentId);
  const oldB = await cashfree.fetchOrder(B.intent.paymentId);
  record('the failed attempt\'s Cashfree order was closed', oldB.raw?.order?.order_status === 'TERMINATED' || oldB.raw?.order?.order_status === 'TERMINATION_REQUESTED',
         oldB.raw?.order?.order_status);
  const payB2 = await orderPay(retryB.body.paymentSessionId, 'testsuccess@gocash');
  const paidB = await waitFor(() => q1(`SELECT 1 FROM payment WHERE order_id=$1 AND status='paid'`, [B.orderId]));
  const bCaps = await q1(`SELECT count(*)::int n FROM ledger_txn WHERE order_id=$1 AND kind='order_capture'`, [B.orderId]);
  record('retry succeeds and allocates exactly once', payB2.status === 200 && !!paidB && bCaps.n === 1);

  /* ---- C. refund -------------------------------------------------------- */
  if (paid) {
    const rf = await admin.post('/refunds', { orderId: A.orderId, reason: 'sandbox end-to-end refund check', idempotencyKey: 'sbx-refund-1' });
    record('refund accepted by Cashfree', rf.status === 200, `state ${rf.body?.state}`);
    const dup = await admin.post('/refunds', { orderId: A.orderId, reason: 'sandbox end-to-end refund check', idempotencyKey: 'sbx-refund-1' });
    record('duplicate refund request returns the original, no second refund', dup.body?.duplicate === true);
    const count = await q1(`SELECT count(*)::int n FROM refund WHERE order_id=$1`, [A.orderId]);
    record('exactly one refund row', count.n === 1);
    /* The scheduler's refund-status pull, run here on demand. */
    const { syncProcessingRefunds } = await import('../src/services/refund-status.js');
    const done = await waitFor(async () => { await syncProcessingRefunds();
      return q1(`SELECT state FROM refund WHERE order_id=$1 AND state='completed'`, [A.orderId]); }, 180000);
    record('refund reached completed (Cashfree SUCCESS)', !!done, done ? '' : 'still processing after 180s — refund webhook not observed');
    /* Order A is fully reversed; what remains is exactly order B's allocation. */
    record('ledger reversed for the refunded order; only the other paid order remains',
           await bal('cafeteria_payable') === 10000 && await bal('platform_revenue') === 500 && await bal('delivery_clearing') === 1000);
  }

  /* ---- D. reconciliation ----------------------------------------------- */
  const { importSettlements, detectOperationalDifferences } = await import('../src/services/reconciliation.js');
  try {
    const run = await importSettlements({ provider: 'cashfree', from: new Date(Date.now() - 7 * 864e5), to: new Date() });
    record('settlement report API reachable', true, `state ${run.state}, lines ${run.entries_seen}`);
  } catch (e) { record('settlement report API reachable', false, String(e.message).slice(0, 120)); }
  const ops = await detectOperationalDifferences({ webhookGraceMinutes: 0 });
  record('reconciliation raises nothing for webhook-confirmed payments', ops.missingWebhook === 0, JSON.stringify(ops));

  record('user-dropped checkout', null, 'emitted only by the hosted checkout UI; covered by the signed-webhook unit tests');
} finally {
  await app.close().catch(() => {});
  tunnel.kill();
  proxy.close();
  await pool.end().catch(() => {});
  for (const d of deliveries) {
    let t = {}; try { t = JSON.parse(d.body); } catch { /* not json */ }
    console.log(`delivery: ${t.type} payment_status=${t.data?.payment?.payment_status} -> HTTP ${d.status}`);
  }
  const failedCount = results.filter((r) => r.ok === false).length;
  console.log(`\n${results.filter((r) => r.ok === true).length} passed, ${failedCount} failed, ${results.filter((r) => r.ok === null).length} not automatable`);
  process.exit(failedCount ? 1 : 0);
}
