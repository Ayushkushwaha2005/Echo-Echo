/* ==========================================================================
   PAYMENTS — the full inbound path, exercised for real.

   A webhook is INBOUND, so nothing about Razorpay's account is needed to
   test it properly: the request is constructed here, signed with the
   configured secret, and posted at the real route. Everything the server is
   responsible for — signature verification, amount checking, order mapping,
   idempotency, state transition — is genuinely exercised.

   The OUTBOUND call (creating a gateway order) is tested against a local
   stub speaking Razorpay's wire format, so request construction, auth
   header and error handling are verified without billing anyone. The stub
   is explicitly a stub: it is reachable only because RAZORPAY_BASE_URL is
   pointed at it, and production refuses a non-https base URL.

   What this canNOT prove: that Razorpay accepts our requests. Only a
   sandbox key can prove that, and it is listed as the outstanding blocker.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus }
  from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const WEBHOOK_SECRET = 'whsec_test_' + 'a'.repeat(24);
const KEY_ID = 'rzp_test_localstub';
const KEY_SECRET = 'stub_secret_not_real';

let app, pool, stub, stubUrl;
const stubCalls = [];
let stubMode = 'ok';

/* A local server speaking Razorpay's shapes. It is not a mock of our own
   code — our real adapter makes a real HTTP request to it. */
function startStub() {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        stubCalls.push({
          method: req.method, url: req.url,
          auth: req.headers.authorization || null,
          contentType: req.headers['content-type'] || null,
          body: body ? JSON.parse(body) : null,
        });
        if (stubMode === 'error') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { description: 'stub rejection' } }));
        }
        if (req.url.startsWith('/v1/orders')) {
          const parsed = body ? JSON.parse(body) : {};
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({
            id: 'order_stub_' + Date.now(), entity: 'order',
            amount: parsed.amount, currency: parsed.currency, receipt: parsed.receipt,
            status: 'created',
          }));
        }
        if (/\/v1\/payments\/.+\/refund/.test(req.url)) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ id: 'rfnd_stub_1', entity: 'refund', status: 'processed' }));
        }
        res.writeHead(404); res.end('{}');
      });
    });
    stub.listen(0, '127.0.0.1', () => {
      stubUrl = `http://127.0.0.1:${stub.address().port}`;
      resolve();
    });
  });
}

before(async () => {
  await startDb();
  await startStub();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  process.env.SWEEPER = 'off';
  process.env.NODE_ENV = 'test';
  /* Configure payments for real, pointed at the local stub. */
  process.env.PAYMENT_PROVIDER = 'razorpay';
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.RAZORPAY_BASE_URL = stubUrl;

  ({ pool } = await import('../src/db/index.js'));
  const { build } = await import('../src/index.js');
  app = await build();
});

after(async () => {
  await app?.close();
  await pool?.end();
  await new Promise((r) => stub.close(r));
  await stopDb();
  for (const k of ['PAYMENT_PROVIDER', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
                   'RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_BASE_URL']) delete process.env[k];
  await stopDb();
});

beforeEach(async () => { await truncateAll(pool); stubCalls.length = 0; stubMode = 'ok'; });

const as = async (u) => client(app, await sessionFor(pool, u.id));

/* Builds a webhook request exactly as Razorpay would: raw JSON body, HMAC
   SHA-256 over those precise bytes, signature in the header. */
function signedWebhook(payload, { secret = WEBHOOK_SECRET, eventId = 'evt_' + Math.random() } = {}) {
  const raw = JSON.stringify(payload);
  return {
    method: 'POST', url: '/payments/webhook', payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
      'x-razorpay-event-id': eventId,
    },
  };
}

const captured = (gatewayOrderId, amount, paymentId = 'pay_stub_1') => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, order_id: gatewayOrderId, amount, status: 'captured' } } },
});

/* A paid-up order, ready for a webhook. */
async function orderAwaitingPayment(phone = '+919700000001') {
  const n = await makeCampus(pool);
  /* Slug is unique in the schema, so two orders in one test need two
     outlets — which is also closer to reality than reusing one. */
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco-' + phone.slice(-4) });
  const i = await makeItem(pool, v.id, { name: 'Cold Coffee', paise: 7000 });
  const u = await makeUser(pool, { phone, name: 'Asha' });
  const c = await as(u);
  const draft = (await c.post('/orders/draft', {
    vendorId: v.id, lines: [{ itemId: i.id, qty: 2 }],
    fulfilment: 'delivery', destinationId: n.blockB.id })).body;
  const intent = await c.post('/payments/intent', { orderId: draft.id });
  return { user: u, c, draft, intent: intent.body, intentStatus: intent.status };
}

/* ======================= 1–2. intent creation ============================ */

test('the server creates a gateway order with ITS OWN amount and returns only the public key', async () => {
  const { draft, intent, intentStatus } = await orderAwaitingPayment();
  assert.equal(intentStatus, 200);
  assert.equal(draft.total_paise, 14000, '2 × ₹70, priced by the server');

  /* The outbound request really happened, against the real adapter. */
  assert.equal(stubCalls.length, 1);
  const call = stubCalls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/v1/orders');
  assert.equal(call.body.amount, 14000, 'the amount sent is the SERVER total');
  assert.equal(call.body.currency, 'INR');
  assert.equal(call.body.receipt, draft.code);
  assert.match(call.auth, /^Basic /, 'HTTP basic auth as Razorpay expects');
  const decoded = Buffer.from(call.auth.slice(6), 'base64').toString();
  assert.equal(decoded, `${KEY_ID}:${KEY_SECRET}`);

  /* The secret must never reach the client. */
  const asJson = JSON.stringify(intent);
  assert.equal(intent.keyId, KEY_ID);
  assert.ok(!asJson.includes(KEY_SECRET), 'the key secret must not be returned');
  assert.ok(!asJson.includes(WEBHOOK_SECRET), 'the webhook secret must not be returned');

  /* And the order moved to awaiting_payment, not confirmed. */
  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'awaiting_payment');
});

test('a gateway failure leaves the order unpaid and surfaces an error', async () => {
  stubMode = 'error';
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919700000002', name: 'A' });
  const c = await as(u);
  const draft = (await c.post('/orders/draft', {
    vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }],
    fulfilment: 'delivery', destinationId: n.blockB.id })).body;

  const r = await c.post('/payments/intent', { orderId: draft.id });
  assert.ok(r.status >= 400, 'a rejected gateway call must not look successful');
  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'draft', 'the order stays unpaid');
});

/* ======================= 3–7. webhook: the happy path ==================== */

test('a correctly signed capture confirms the order and persists the payment', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000010');

  const res = await app.inject(signedWebhook(captured(intent.gatewayOrderId, 14000)));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ok, true);

  const o = await pool.query(`SELECT state, confirmed_at FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'confirmed', 'ONLY a verified webhook can do this');
  assert.ok(o.rows[0].confirmed_at, 'the confirmation timestamp is persisted');

  const p = await pool.query(
    `SELECT status, provider_payment_id, amount_paise, settled_at FROM payment WHERE order_id=$1`,
    [draft.id]);
  assert.equal(p.rows[0].status, 'paid');
  assert.equal(p.rows[0].provider_payment_id, 'pay_stub_1');
  assert.equal(p.rows[0].amount_paise, 14000);
  assert.ok(p.rows[0].settled_at);

  /* The state change is in the order's event history, attributed to the system. */
  const ev = await pool.query(
    `SELECT to_state, actor_role, note FROM order_event WHERE order_id=$1 AND to_state='confirmed'`,
    [draft.id]);
  assert.equal(ev.rowCount, 1);
  assert.match(ev.rows[0].note, /payment captured/);
});

/* ======================= 8. duplicate webhook ============================ */

test('a duplicate webhook delivery is idempotent', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000011');
  const req = signedWebhook(captured(intent.gatewayOrderId, 14000), { eventId: 'evt_dupe' });

  const first = await app.inject(req);
  const second = await app.inject(req);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(second.body).duplicate, true, 'the replay is recognised');

  /* Exactly one payment row, one confirmation event, one webhook record. */
  const p = await pool.query(`SELECT count(*)::int AS n FROM payment WHERE order_id=$1`, [draft.id]);
  assert.equal(p.rows[0].n, 1);
  const ev = await pool.query(
    `SELECT count(*)::int AS n FROM order_event WHERE order_id=$1 AND to_state='confirmed'`, [draft.id]);
  assert.equal(ev.rows[0].n, 1, 'the order must not be confirmed twice');
  const wh = await pool.query(`SELECT count(*)::int AS n FROM payment_webhook`);
  assert.equal(wh.rows[0].n, 1);
});

/* ======================= 9. forged signature ============================= */

test('a forged or missing signature is rejected and changes nothing', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000012');
  const evt = captured(intent.gatewayOrderId, 14000);
  const raw = JSON.stringify(evt);

  const attempts = [
    { name: 'wrong secret', headers: { 'x-razorpay-signature':
        createHmac('sha256', 'attacker-secret').update(raw).digest('hex') } },
    { name: 'no signature', headers: {} },
    { name: 'empty signature', headers: { 'x-razorpay-signature': '' } },
    { name: 'truncated signature', headers: { 'x-razorpay-signature': 'abc123' } },
    { name: 'signature over a different body', headers: { 'x-razorpay-signature':
        createHmac('sha256', WEBHOOK_SECRET).update('{}').digest('hex') } },
  ];

  for (const a of attempts) {
    const res = await app.inject({
      method: 'POST', url: '/payments/webhook', payload: raw,
      headers: { 'content-type': 'application/json', 'x-razorpay-event-id': 'evt_' + a.name, ...a.headers },
    });
    assert.equal(res.statusCode, 400, `${a.name} must be rejected`);
  }

  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'awaiting_payment', 'no forgery may confirm an order');
  const wh = await pool.query(`SELECT count(*)::int AS n FROM payment_webhook`);
  assert.equal(wh.rows[0].n, 0, 'a rejected webhook is not even recorded');
});

test('tampering with the body invalidates the signature', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000013');
  /* Sign the honest payload, then swap in a bigger amount. */
  const honest = captured(intent.gatewayOrderId, 14000);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(honest)).digest('hex');
  const tampered = captured(intent.gatewayOrderId, 1);

  const res = await app.inject({
    method: 'POST', url: '/payments/webhook', payload: JSON.stringify(tampered),
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature,
               'x-razorpay-event-id': 'evt_tamper' },
  });
  assert.equal(res.statusCode, 400);
  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'awaiting_payment');
});

/* ======================= 10. wrong amount =============================== */

test('a correctly signed webhook for the WRONG amount does not confirm the order', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000014');

  /* The attacker controls their own gateway account and pays ₹1. The
     signature is valid; the amount is not what the server computed. */
  const res = await app.inject(signedWebhook(captured(intent.gatewayOrderId, 100)));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).rejected, 'amount mismatch');

  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'awaiting_payment', 'underpayment must never confirm');
  const p = await pool.query(`SELECT status FROM payment WHERE order_id=$1`, [draft.id]);
  assert.equal(p.rows[0].status, 'failed');
});

/* ======================= order mapping ================================== */

test('a webhook for an unknown gateway order is ignored, not guessed at', async () => {
  const { draft } = await orderAwaitingPayment('+919700000015');
  const res = await app.inject(signedWebhook(captured('order_never_seen', 14000)));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ignored, 'unknown payment');
  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'awaiting_payment');
});

test("one customer's webhook cannot confirm another customer's order", async () => {
  const a = await orderAwaitingPayment('+919700000016');
  const b = await orderAwaitingPayment('+919700000017');

  /* Confirm A's gateway order; B must be untouched. */
  await app.inject(signedWebhook(captured(a.intent.gatewayOrderId, 14000)));
  const bo = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [b.draft.id]);
  assert.equal(bo.rows[0].state, 'awaiting_payment');
  const ao = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [a.draft.id]);
  assert.equal(ao.rows[0].state, 'confirmed');
});

/* ======================= failure and cancellation ======================= */

test('a failed payment leaves the order unpaid', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000018');
  const res = await app.inject(signedWebhook({
    event: 'payment.failed',
    payload: { payment: { entity: { id: 'pay_f', order_id: intent.gatewayOrderId,
                                    amount: 14000, status: 'failed' } } },
  }));
  assert.equal(res.statusCode, 200);
  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'awaiting_payment');
  const p = await pool.query(`SELECT status FROM payment WHERE order_id=$1`, [draft.id]);
  assert.equal(p.rows[0].status, 'failed');
});

test('the customer can cancel an unpaid order, and it does not become paid', async () => {
  const { draft, c } = await orderAwaitingPayment('+919700000019');
  const r = await c.post('/payments/cancel', { orderId: draft.id });
  assert.equal(r.status, 200);
  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'cancelled');
});

/* ======================= the frontend is never trusted =================== */

test('no frontend call can confirm an order — only the webhook can', async () => {
  const { draft, c } = await orderAwaitingPayment('+919700000020');

  /* Every shape a client might try. */
  const attempts = [
    await c.post(`/orders/${draft.id}/transition`, { to: 'confirmed' }),
    await c.post(`/orders/${draft.id}/transition`, { to: 'awaiting_payment' }),
    await c.post(`/orders/${draft.id}/transition`, { to: 'preparing' }),
    await c.post(`/orders/${draft.id}/transition`, { to: 'delivered' }),
  ];
  for (const a of attempts) assert.ok(a.status >= 400, 'the client cannot advance payment state');

  /* The payment status endpoint reports what the SERVER knows. */
  const st = await c.get(`/payments/status?orderId=${draft.id}`);
  assert.equal(st.body.confirmed, false);
  assert.equal(st.body.payment, 'pending');

  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'awaiting_payment');
});

/* ======================= refunds ======================================== */

test('a refund is server-side, authorized, and only after a real capture', async () => {
  const { draft, intent, user } = await orderAwaitingPayment('+919700000021');
  await app.inject(signedWebhook(captured(intent.gatewayOrderId, 14000)));

  /* The customer cannot refund themselves. */
  const cs = await as(user);
  assert.equal((await cs.post('/refunds', { orderId: draft.id, reason: 'gimme' })).status, 403);

  /* An admin can. The outbound call really goes to the adapter. */
  const admin = await makeUser(pool, { phone: '+919700000022', name: 'Adm', roles: ['platform_admin'] });
  const ca = await as(admin);
  const before = stubCalls.length;
  const r = await ca.post('/refunds', { orderId: draft.id, reason: 'item unavailable' });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'completed');
  assert.equal(r.body.amountPaise, 14000);

  const call = stubCalls[before];
  assert.match(call.url, /^\/v1\/payments\/pay_stub_1\/refund$/);
  assert.equal(call.body.amount, 14000, 'the refund amount comes from OUR payment row');

  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'refunded');
  const p = await pool.query(`SELECT status FROM payment WHERE order_id=$1`, [draft.id]);
  assert.equal(p.rows[0].status, 'refunded');

  /* And it cannot be refunded twice. */
  assert.equal((await ca.post('/refunds', { orderId: draft.id, reason: 'again' })).status, 409);
});

test('a refund cannot exceed what was captured', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000023');
  await app.inject(signedWebhook(captured(intent.gatewayOrderId, 14000)));
  const admin = await makeUser(pool, { phone: '+919700000024', name: 'Adm', roles: ['platform_admin'] });
  const ca = await as(admin);
  const r = await ca.post('/refunds', { orderId: draft.id, reason: 'x', amountPaise: 99999 });
  assert.equal(r.status, 400);
});

/* ======================= observability =================================== */

test('the webhook path is audited, and the signature never reaches the log', async () => {
  const { intent } = await orderAwaitingPayment('+919700000025');
  await app.inject(signedWebhook(captured(intent.gatewayOrderId, 14000)));
  /* And a forgery. */
  await app.inject({
    method: 'POST', url: '/payments/webhook', payload: JSON.stringify(captured(intent.gatewayOrderId, 14000)),
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'bad',
               'x-razorpay-event-id': 'evt_bad' },
  });

  const rows = (await pool.query(
    `SELECT action, outcome, detail FROM audit_log WHERE action LIKE 'payment%'`)).rows;
  const actions = rows.map((r) => `${r.action}:${r.outcome}`);
  assert.ok(actions.includes('payment.captured:ok'), 'a capture is audited');
  assert.ok(actions.some((a) => a.startsWith('payment.webhook:denied')), 'a forgery is audited');

  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(WEBHOOK_SECRET), 'the webhook secret must never be logged');
  assert.ok(!dump.includes(KEY_SECRET), 'the key secret must never be logged');
});
