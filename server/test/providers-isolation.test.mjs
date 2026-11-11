/* ==========================================================================
   PROVIDER ISOLATION — two gateways configured at once.

   The deployment collects through Razorpay. Cashfree is still configured,
   because it took payments before the switch and still owes webhooks,
   status pulls, refunds and settlements on them. This file proves that:

   · each provider's endpoint verifies ONLY with that provider's secret
   · a Cashfree-signed event is accepted on /payments/webhook/cashfree and
     confirms a Cashfree payment, while Razorpay is the active provider
   · the status pull for a Cashfree attempt goes to Cashfree, not Razorpay
   · a refund of a Cashfree-taken payment goes back through Cashfree
   · scheduled reconciliation covers both providers
   · new intents go only to the active provider

   Both providers are local stubs; nothing here reaches a real gateway.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus }
  from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const RZP = { keyId: 'rzp_test_iso0001', keySecret: 'rzp_secret_iso_' + 'a'.repeat(16),
              webhookSecret: 'whsec_iso_' + 'b'.repeat(16) };
const CF = { appId: 'TEST_APPID_iso', secretKey: 'cfsk_iso_' + 'c'.repeat(16) };

let app, pool;
const stubs = {};
const calls = { razorpay: [], cashfree: [] };
let cfOrder = { status: 'ACTIVE', payments: [] };

function listen(name, handler) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : null;
        calls[name].push({ method: req.method, url: req.url, body: parsed });
        const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        handler(req, parsed, json);
      });
    });
    s.listen(0, '127.0.0.1', () => { stubs[name] = { server: s, url: `http://127.0.0.1:${s.address().port}` }; resolve(); });
  });
}

const razorpayStub = (req, body, json) => {
  if (req.method === 'POST' && req.url === '/v1/orders') {
    return json(200, { id: 'order_rzp_' + Math.floor(Math.random() * 1e9), amount: body.amount, currency: body.currency, status: 'created' });
  }
  if (/^\/v1\/orders\/[^/]+\/payments$/.test(req.url)) return json(200, { items: [] });
  if (/^\/v1\/payments\/[^/]+\/refund$/.test(req.url)) return json(200, { id: 'rfnd_rzp_1', status: 'processed' });
  if (req.url.startsWith('/v1/settlements/recon/combined')) return json(200, { items: [] });
  json(404, {});
};

const cashfreeStub = (req, body, json) => {
  let m;
  if (req.method === 'POST' && req.url === '/pg/orders') {
    return json(200, { cf_order_id: 'cf_' + body.order_id, order_id: body.order_id, order_amount: body.order_amount,
                       order_currency: 'INR', order_status: 'ACTIVE', payment_session_id: 'session_' + body.order_id });
  }
  if ((m = /^\/pg\/orders\/([^/]+)\/payments$/.exec(req.url)) && req.method === 'GET') return json(200, cfOrder.payments);
  if ((m = /^\/pg\/orders\/([^/?]+)$/.exec(req.url)) && req.method === 'GET') {
    return json(200, { order_id: decodeURIComponent(m[1]), order_amount: cfOrder.amount ?? '140.00',
                       order_currency: 'INR', order_status: cfOrder.status });
  }
  if (/^\/pg\/orders\/[^/]+\/refunds$/.test(req.url) && req.method === 'POST') {
    return json(200, { cf_refund_id: 'cfrfnd_1', refund_id: body.refund_id, refund_amount: body.refund_amount, refund_status: 'SUCCESS' });
  }
  if (req.url === '/pg/settlement/recon') return json(200, { data: [], cursor: null });
  json(404, {});
};

before(async () => {
  await startDb();
  await listen('razorpay', razorpayStub);
  await listen('cashfree', cashfreeStub);
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  process.env.SWEEPER = 'off';
  process.env.NODE_ENV = 'test';
  process.env.PAYMENT_PROVIDER = 'razorpay';
  process.env.RAZORPAY_KEY_ID = RZP.keyId;
  process.env.RAZORPAY_KEY_SECRET = RZP.keySecret;
  process.env.RAZORPAY_WEBHOOK_SECRET = RZP.webhookSecret;
  process.env.RAZORPAY_BASE_URL = stubs.razorpay.url;
  process.env.CASHFREE_PG_APP_ID = CF.appId;
  process.env.CASHFREE_PG_SECRET_KEY = CF.secretKey;
  process.env.CASHFREE_PG_BASE_URL = stubs.cashfree.url;
  ({ pool } = await import('../src/db/index.js'));
  const { build } = await import('../src/index.js');
  app = await build();
});

after(async () => {
  await app?.close();
  await pool?.end();
  for (const s of Object.values(stubs)) await new Promise((r) => s.server.close(r));
  await stopDb();
  for (const k of ['PAYMENT_PROVIDER', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
                   'RAZORPAY_BASE_URL', 'CASHFREE_PG_APP_ID', 'CASHFREE_PG_SECRET_KEY', 'CASHFREE_PG_BASE_URL']) {
    delete process.env[k];
  }
});

beforeEach(async () => {
  await truncateAll(pool);
  calls.razorpay.length = 0; calls.cashfree.length = 0;
  cfOrder = { status: 'ACTIVE', payments: [] };
});

const as = async (u) => client(app, await sessionFor(pool, u.id));

function rzpSigned(payload, url = '/payments/webhook/razorpay', secret = RZP.webhookSecret) {
  const raw = JSON.stringify(payload);
  return { method: 'POST', url, payload: raw, headers: {
    'content-type': 'application/json',
    'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
    'x-razorpay-event-id': 'evt_' + Math.random() } };
}
function cfSigned(payload, url = '/payments/webhook/cashfree', secret = CF.secretKey) {
  const raw = JSON.stringify(payload);
  const ts = String(Date.now());
  return { method: 'POST', url, payload: raw, headers: {
    'content-type': 'application/json',
    'x-webhook-timestamp': ts,
    'x-webhook-signature': createHmac('sha256', secret).update(ts + raw).digest('base64'),
    'x-idempotency-key': 'idem_' + Math.random() } };
}
const cfSuccess = (orderId, amount = '140.00') => ({
  type: 'PAYMENT_SUCCESS_WEBHOOK',
  data: { order: { order_id: orderId, order_amount: amount, order_currency: 'INR' },
          payment: { cf_payment_id: 880001, payment_status: 'SUCCESS', payment_amount: amount, payment_currency: 'INR' } },
});

/* A live Razorpay attempt, created the normal way through the active provider. */
async function razorpayOrder(phone) {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco-' + phone.slice(-4) });
  const i = await makeItem(pool, v.id, { name: 'Cold Coffee', paise: 7000 });
  const u = await makeUser(pool, { phone, name: 'Asha' });
  const c = await as(u);
  const draft = (await c.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: i.id, qty: 2 }],
    fulfilment: 'delivery', destinationId: n.blockB.id })).body;
  const intent = (await c.post('/payments/intent', { orderId: draft.id })).body;
  return { u, c, draft, intent };
}

/* A Cashfree attempt from BEFORE the switch: the order sits at
   awaiting_payment with a pending Cashfree payment row, exactly as the
   intent route would have left it when Cashfree was the active provider. */
async function cashfreeOrder(phone) {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'Tulips', slug: 'tulips-' + phone.slice(-4) });
  const i = await makeItem(pool, v.id, { name: 'Softy', paise: 7000 });
  const u = await makeUser(pool, { phone, name: 'Ravi' });
  const c = await as(u);
  const draft = (await c.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: i.id, qty: 2 }],
    fulfilment: 'delivery', destinationId: n.blockB.id })).body;
  const pay = (await pool.query(
    `INSERT INTO payment (order_id, provider, amount_paise, status) VALUES ($1,'cashfree',$2,'created') RETURNING *`,
    [draft.id, draft.total_paise])).rows[0];
  await pool.query(`UPDATE payment SET provider_order_id=$2, provider_session_id=$3, status='pending' WHERE id=$1`,
                   [pay.id, pay.id, 'session_' + pay.id]);
  await pool.query(`UPDATE food_order SET state='awaiting_payment' WHERE id=$1`, [draft.id]);
  return { u, c, draft, pay };
}
const stateOf = async (id) => (await pool.query(`SELECT state FROM food_order WHERE id=$1`, [id])).rows[0].state;

test('new intents go only to the active provider', async () => {
  const { intent } = await razorpayOrder('+919700000201');
  assert.equal(intent.provider, 'razorpay');
  assert.equal(calls.razorpay.filter((x) => x.url === '/v1/orders').length, 1);
  assert.equal(calls.cashfree.length, 0, 'Cashfree is not asked for anything');
});

test('a Cashfree-signed success on /payments/webhook/cashfree confirms a Cashfree payment while Razorpay is active', async () => {
  const { draft, pay } = await cashfreeOrder('+919700000202');
  const r = await app.inject(cfSigned(cfSuccess(pay.id)));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await stateOf(draft.id), 'confirmed');
  const wh = await pool.query(`SELECT provider FROM payment_webhook`);
  assert.deepEqual(wh.rows, [{ provider: 'cashfree' }]);
});

test("the legacy /payments/webhook verifies with the ACTIVE provider, so a Cashfree signature is refused there", async () => {
  const { draft, pay } = await cashfreeOrder('+919700000203');
  const r = await app.inject(cfSigned(cfSuccess(pay.id), '/payments/webhook'));
  assert.equal(r.statusCode, 400);
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
});

test("each endpoint refuses the OTHER provider's signature, and secrets do not cross", async () => {
  const { intent } = await razorpayOrder('+919700000204');
  const rzpEvent = { event: 'payment.captured', payload: { payment: { entity: {
    id: 'pay_x', order_id: intent.gatewayOrderId, amount: 14000, currency: 'INR', status: 'captured' } } } };
  /* Razorpay event signed with Cashfree's secret on Razorpay's endpoint. */
  assert.equal((await app.inject(rzpSigned(rzpEvent, '/payments/webhook/razorpay', CF.secretKey))).statusCode, 400);
  /* Razorpay event, Razorpay signature, Cashfree's endpoint. */
  assert.equal((await app.inject(rzpSigned(rzpEvent, '/payments/webhook/cashfree'))).statusCode, 400);
  const { pay } = await cashfreeOrder('+919700000205');
  /* Cashfree event signed with Razorpay's webhook secret on Cashfree's endpoint. */
  assert.equal((await app.inject(cfSigned(cfSuccess(pay.id), '/payments/webhook/cashfree', RZP.webhookSecret))).statusCode, 400);
  const wh = await pool.query(`SELECT count(*)::int AS n FROM payment_webhook`);
  assert.equal(wh.rows[0].n, 0, 'nothing refused is recorded');
});

test('the status pull for a Cashfree attempt asks Cashfree, not the active provider', async () => {
  const { c, draft, pay } = await cashfreeOrder('+919700000206');
  cfOrder = { status: 'PAID', amount: '140.00',
              payments: [{ cf_payment_id: 880002, payment_status: 'SUCCESS', payment_amount: '140.00', payment_currency: 'INR' }] };
  const st = await c.get(`/payments/status?orderId=${draft.id}`);
  assert.equal(st.body.confirmed, true);
  assert.equal(await stateOf(draft.id), 'confirmed');
  assert.ok(calls.cashfree.some((x) => x.url === `/pg/orders/${pay.id}`), 'Cashfree was asked');
  assert.equal(calls.razorpay.length, 0, 'Razorpay was not');
});

test('a refund of a Cashfree-taken payment goes back through Cashfree', async () => {
  const { draft, pay } = await cashfreeOrder('+919700000207');
  await app.inject(cfSigned(cfSuccess(pay.id)));
  const admin = await makeUser(pool, { phone: '+919700000299', name: 'Adm', roles: ['platform_admin'] });
  const r = await (await as(admin)).post('/refunds', { orderId: draft.id, reason: 'closed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(calls.cashfree.some((x) => x.url === `/pg/orders/${pay.id}/refunds`));
  assert.equal(calls.razorpay.filter((x) => /refund/.test(x.url)).length, 0);
});

test('scheduled reconciliation covers the active provider and every other configured one', async () => {
  const { runScheduledReconciliation } = await import('../src/services/reconciliation.js');
  const out = await runScheduledReconciliation({ now: new Date(), lookbackDays: 1 });
  assert.equal(out.ran, true);
  assert.ok(calls.razorpay.some((x) => x.url.startsWith('/v1/settlements/recon/combined')));
  assert.ok(Array.isArray(out.others) && out.others.length === 1);
  assert.equal(out.others[0].provider, 'cashfree');
  assert.equal(out.others[0].ran, true);
  assert.ok(calls.cashfree.some((x) => x.url === '/pg/settlement/recon'));
  const imports = await pool.query(`SELECT provider FROM provider_settlement_import ORDER BY provider`);
  assert.deepEqual(imports.rows.map((r) => r.provider), ['cashfree', 'razorpay']);
});
