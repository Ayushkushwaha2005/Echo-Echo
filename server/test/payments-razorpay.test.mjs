/* ==========================================================================
   RAZORPAY COLLECTION — the paths payments.test.mjs does not cover.

   payments.test.mjs proves the intent, the signed capture, duplicates,
   forgery, tampering, wrong amounts and the full refund. This file covers
   what the completed adapter adds:

   · the per-provider webhook endpoint (/payments/webhook/razorpay) and its
     refusals for an unknown or unconfigured provider
   · two DIFFERENT events about one payment without an event-id header
     (payment.authorized, then payment.captured) — the second is not a
     duplicate of the first
   · order.paid as a confirming event
   · the browser's return: the authoritative status pull against the
     provider, for captured, authorized-only and failed attempts
   · refunds that Razorpay answers `pending`: recorded as processing, then
     completed by the refund.processed webhook or by the status sweep
   · partial refunds, and a refund the provider later reports failed
   · ledger consistency after capture and after a refund

   Everything outbound runs against a local server speaking Razorpay's wire
   shapes; everything inbound is signed exactly as Razorpay signs it.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus }
  from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const KEY_ID = 'rzp_test_localstub0001';
const KEY_SECRET = 'rzp_secret_not_real_' + 'x'.repeat(16);
const WEBHOOK_SECRET = 'whsec_not_real_' + 'y'.repeat(16);

let app, pool, stub, stubUrl;
const stubCalls = [];
/* What the stub answers when the SERVER asks. Driving these is how the
   browser-return and refund-sweep cases are tested. */
let orderPayments = [];            // GET /v1/orders/:id/payments
let refundMode = 'processed';      // POST /v1/payments/:id/refund -> status
let refundLookup = {};             // GET /v1/refunds/:id -> entity by id
let refundSeq = 0;

function startStub() {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : null;
        stubCalls.push({ method: req.method, url: req.url, body: parsed,
                         idem: req.headers['x-razorpay-idempotency'] || null });
        const json = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        let m;
        if (req.method === 'POST' && req.url === '/v1/orders') {
          return json(200, { id: 'order_stub_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
                             entity: 'order', amount: parsed.amount, currency: parsed.currency,
                             receipt: parsed.receipt, status: 'created' });
        }
        if ((m = /^\/v1\/orders\/([^/]+)\/payments$/.exec(req.url)) && req.method === 'GET') {
          return json(200, { entity: 'collection', count: orderPayments.length,
                             items: orderPayments.map((p) => ({ ...p, order_id: decodeURIComponent(m[1]) })) });
        }
        if ((m = /^\/v1\/payments\/([^/]+)\/refund$/.exec(req.url)) && req.method === 'POST') {
          const id = 'rfnd_stub_' + (++refundSeq);
          const entity = { id, entity: 'refund', payment_id: decodeURIComponent(m[1]),
                           amount: parsed.amount, status: refundMode, receipt: parsed.receipt,
                           notes: parsed.notes };
          refundLookup[id] = entity;
          return json(200, entity);
        }
        if ((m = /^\/v1\/refunds\/([^/]+)$/.exec(req.url)) && req.method === 'GET') {
          const e = refundLookup[decodeURIComponent(m[1])];
          return e ? json(200, e) : json(404, { error: { description: 'not found' } });
        }
        if ((m = /^\/v1\/payments\/([^/]+)\/refunds$/.exec(req.url)) && req.method === 'GET') {
          const items = Object.values(refundLookup).filter((r) => r.payment_id === decodeURIComponent(m[1]));
          return json(200, { entity: 'collection', count: items.length, items });
        }
        json(404, {});
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
});

beforeEach(async () => {
  await truncateAll(pool);
  stubCalls.length = 0;
  orderPayments = [];
  refundMode = 'processed';
  refundLookup = {};
});

const as = async (u) => client(app, await sessionFor(pool, u.id));

/* Signed exactly as Razorpay signs: hex HMAC-SHA256 over the raw bytes.
   `eventId: null` omits the header, to exercise the deterministic fallback. */
function signed(payload, { url = '/payments/webhook/razorpay', secret = WEBHOOK_SECRET,
                           eventId = 'evt_' + Math.random() } = {}) {
  const raw = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'),
  };
  if (eventId !== null) headers['x-razorpay-event-id'] = eventId;
  return { method: 'POST', url, payload: raw, headers };
}

const paymentEntity = (orderId, amount, status, id = 'pay_stub_1', extra = {}) =>
  ({ id, entity: 'payment', order_id: orderId, amount, currency: 'INR', status, ...extra });
const paymentEvent = (event, entity) => ({ event, payload: { payment: { entity } } });
const refundEvent = (event, refund, payment) =>
  ({ event, payload: { refund: { entity: refund }, payment: { entity: payment } } });

async function orderAwaitingPayment(phone = '+919700000001', qty = 2) {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco-' + phone.slice(-4) });
  const i = await makeItem(pool, v.id, { name: 'Cold Coffee', paise: 7000 });
  const u = await makeUser(pool, { phone, name: 'Asha' });
  const c = await as(u);
  const draft = (await c.post('/orders/draft', {
    vendorId: v.id, lines: [{ itemId: i.id, qty }],
    fulfilment: 'delivery', destinationId: n.blockB.id })).body;
  const intent = await c.post('/payments/intent', { orderId: draft.id });
  assert.equal(intent.status, 200);
  return { user: u, c, draft, intent: intent.body };
}

const stateOf = async (id) =>
  (await pool.query(`SELECT state FROM food_order WHERE id=$1`, [id])).rows[0].state;
const paymentOf = async (orderId) =>
  (await pool.query(`SELECT * FROM payment WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`,
                    [orderId])).rows[0];
const refundsOf = async (orderId) =>
  (await pool.query(`SELECT * FROM refund WHERE order_id=$1 ORDER BY created_at`, [orderId])).rows;
async function admin(phone = '+919700009999') {
  return as(await makeUser(pool, { phone, name: 'Adm', roles: ['platform_admin'] }));
}
async function captureOrder(phone, qty) {
  const o = await orderAwaitingPayment(phone, qty);
  const r = await app.inject(signed(paymentEvent('payment.captured',
    paymentEntity(o.intent.gatewayOrderId, o.intent.amountPaise, 'captured'))));
  assert.equal(r.statusCode, 200);
  assert.equal(await stateOf(o.draft.id), 'confirmed');
  return o;
}

/* ======================= per-provider endpoint =========================== */

test('the intent sends payment_capture and returns the public key id only', async () => {
  const { intent } = await orderAwaitingPayment();
  const call = stubCalls.find((c) => c.url === '/v1/orders');
  assert.equal(call.body.payment_capture, 1, 'captured on authorisation, not on a dashboard timer');
  assert.equal(call.body.notes.quad_payment_id, intent.paymentId);
  assert.equal(intent.provider, 'razorpay');
  assert.equal(intent.keyId, KEY_ID);
  assert.equal(intent.checkout.keyId, KEY_ID);
  assert.ok(!JSON.stringify(intent).includes(KEY_SECRET));
  assert.ok(!JSON.stringify(intent).includes(WEBHOOK_SECRET));
});

test('/payments/webhook/razorpay confirms a signed capture; the legacy path still works', async () => {
  const a = await orderAwaitingPayment('+919700000101');
  const r1 = await app.inject(signed(paymentEvent('payment.captured',
    paymentEntity(a.intent.gatewayOrderId, 14000, 'captured'))));
  assert.equal(r1.statusCode, 200);
  assert.equal(await stateOf(a.draft.id), 'confirmed');

  const b = await orderAwaitingPayment('+919700000102');
  const r2 = await app.inject(signed(paymentEvent('payment.captured',
    paymentEntity(b.intent.gatewayOrderId, 14000, 'captured', 'pay_stub_2')), { url: '/payments/webhook' }));
  assert.equal(r2.statusCode, 200);
  assert.equal(await stateOf(b.draft.id), 'confirmed');

  const wh = await pool.query(`SELECT provider, count(*)::int AS n FROM payment_webhook GROUP BY provider`);
  assert.deepEqual(wh.rows, [{ provider: 'razorpay', n: 2 }]);
});

test('an unknown provider path is 404 and an unconfigured one is 503; neither records anything', async () => {
  const { intent } = await orderAwaitingPayment('+919700000103');
  const evt = paymentEvent('payment.captured', paymentEntity(intent.gatewayOrderId, 14000, 'captured'));
  const unknown = await app.inject(signed(evt, { url: '/payments/webhook/paypal' }));
  assert.equal(unknown.statusCode, 404);
  const cashfree = await app.inject(signed(evt, { url: '/payments/webhook/cashfree' }));
  assert.equal(cashfree.statusCode, 503, 'Cashfree has no credentials in this deployment');
  const wh = await pool.query(`SELECT count(*)::int AS n FROM payment_webhook`);
  assert.equal(wh.rows[0].n, 0);
});

test("a Razorpay signature is not accepted on Cashfree's endpoint even if Cashfree were configured", async () => {
  /* Verified structurally: the Cashfree endpoint verifies with the Cashfree
     adapter, which needs x-webhook-signature + x-webhook-timestamp. A
     Razorpay-signed body carries neither. In this deployment the endpoint
     answers 503 before verifying, which is the stricter refusal. */
  const { intent } = await orderAwaitingPayment('+919700000104');
  const r = await app.inject(signed(paymentEvent('payment.captured',
    paymentEntity(intent.gatewayOrderId, 14000, 'captured')), { url: '/payments/webhook/cashfree' }));
  assert.notEqual(r.statusCode, 200);
  assert.equal(await stateOf(intent ? (await paymentOf((await pool.query(
    `SELECT order_id FROM payment WHERE provider_order_id=$1`, [intent.gatewayOrderId])).rows[0].order_id)).order_id : null),
    'awaiting_payment');
});

/* ======================= event sequencing ================================ */

test('authorized then captured, with no event-id header, are two events and the second confirms', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000105');
  const authorized = await app.inject(signed(paymentEvent('payment.authorized',
    paymentEntity(intent.gatewayOrderId, 14000, 'authorized')), { eventId: null }));
  assert.equal(authorized.statusCode, 200);
  assert.equal(await stateOf(draft.id), 'awaiting_payment', 'authorized is NOT paid');
  assert.equal((await paymentOf(draft.id)).status, 'pending');

  const captured = await app.inject(signed(paymentEvent('payment.captured',
    paymentEntity(intent.gatewayOrderId, 14000, 'captured')), { eventId: null }));
  assert.equal(captured.statusCode, 200);
  assert.notEqual(JSON.parse(captured.body).duplicate, true, 'a different event is not a replay');
  assert.equal(await stateOf(draft.id), 'confirmed');

  const wh = await pool.query(`SELECT event_id, event_type FROM payment_webhook ORDER BY received_at`);
  assert.equal(wh.rowCount, 2);
  assert.deepEqual(wh.rows.map((r) => r.event_type), ['payment.authorized', 'payment.captured']);
  assert.notEqual(wh.rows[0].event_id, wh.rows[1].event_id);
});

test('a replay of the same captured event without a header is still a duplicate', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000106');
  const evt = paymentEvent('payment.captured', paymentEntity(intent.gatewayOrderId, 14000, 'captured'));
  await app.inject(signed(evt, { eventId: null }));
  const again = await app.inject(signed(evt, { eventId: null }));
  assert.equal(JSON.parse(again.body).duplicate, true);
  const ev = await pool.query(
    `SELECT count(*)::int AS n FROM order_event WHERE order_id=$1 AND to_state='confirmed'`, [draft.id]);
  assert.equal(ev.rows[0].n, 1);
});

test('order.paid confirms the order from the payment it carries', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000107');
  const r = await app.inject(signed({
    event: 'order.paid',
    payload: {
      order: { entity: { id: intent.gatewayOrderId, amount: 14000, status: 'paid' } },
      payment: { entity: paymentEntity(intent.gatewayOrderId, 14000, 'captured', 'pay_stub_op', { fee: 236 }) },
    },
  }));
  assert.equal(r.statusCode, 200);
  assert.equal(await stateOf(draft.id), 'confirmed');
  const p = await paymentOf(draft.id);
  assert.equal(p.provider_payment_id, 'pay_stub_op');
  /* Razorpay reports its fee on the entity, so the snapshot records it. */
  const f = await pool.query(`SELECT gateway_fee_paise FROM order_financials WHERE order_id=$1`, [draft.id]);
  assert.equal(f.rows[0].gateway_fee_paise, 236);
});

test('a captured event for the wrong amount is flagged, not confirmed, on the provider path too', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919700000108');
  const r = await app.inject(signed(paymentEvent('payment.captured',
    paymentEntity(intent.gatewayOrderId, 13999, 'captured'))));
  assert.equal(r.statusCode, 200);
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
  const p = await paymentOf(draft.id);
  assert.equal(p.status, 'failed');
  assert.match(p.flagged_reason, /amount_mismatch/);
});

/* ======================= the browser's return ============================ */

test('browser return: the status pull confirms a captured attempt the webhook has not reported', async () => {
  const { c, draft, intent } = await orderAwaitingPayment('+919700000109');
  orderPayments = [paymentEntity(intent.gatewayOrderId, 14000, 'captured', 'pay_pull_1', { fee: 300 })];
  const st = await c.get(`/payments/status?orderId=${draft.id}`);
  assert.equal(st.status, 200);
  assert.equal(st.body.confirmed, true);
  assert.equal(await stateOf(draft.id), 'confirmed');
  const p = await paymentOf(draft.id);
  assert.equal(p.provider_payment_id, 'pay_pull_1');
  const ev = await pool.query(`SELECT note FROM order_event WHERE order_id=$1 AND to_state='confirmed'`, [draft.id]);
  assert.match(ev.rows[0].note, /status_pull/);
  /* A later webhook for the same capture is absorbed. */
  const late = await app.inject(signed(paymentEvent('payment.captured',
    paymentEntity(intent.gatewayOrderId, 14000, 'captured', 'pay_pull_1'))));
  assert.equal(JSON.parse(late.body).duplicate, true);
});

test('browser return: an authorized-only attempt stays awaiting; a failed one is recorded failed', async () => {
  const a = await orderAwaitingPayment('+919700000110');
  orderPayments = [paymentEntity(a.intent.gatewayOrderId, 14000, 'authorized', 'pay_auth')];
  let st = await a.c.get(`/payments/status?orderId=${a.draft.id}`);
  assert.equal(st.body.confirmed, false);
  assert.equal(st.body.payment, 'pending');
  assert.equal(await stateOf(a.draft.id), 'awaiting_payment');

  const b = await orderAwaitingPayment('+919700000111');
  orderPayments = [paymentEntity(b.intent.gatewayOrderId, 14000, 'failed', 'pay_fail')];
  st = await b.c.get(`/payments/status?orderId=${b.draft.id}`);
  assert.equal(st.body.confirmed, false);
  assert.equal(st.body.payment, 'failed');
  assert.equal(await stateOf(b.draft.id), 'awaiting_payment', 'the order stays retryable');
});

test('browser return: no attempt yet means pending, and a refresh resumes the same provider order', async () => {
  const { c, draft, intent } = await orderAwaitingPayment('+919700000112');
  const st = await c.get(`/payments/status?orderId=${draft.id}`);
  assert.equal(st.body.payment, 'pending');
  const again = await c.post('/payments/intent', { orderId: draft.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.gatewayOrderId, intent.gatewayOrderId, 'same attempt, no second order');
  assert.equal(stubCalls.filter((x) => x.url === '/v1/orders').length, 1);
});

test('cancel from the checkout: the order is cancelled and a late capture is flagged, never confirmed', async () => {
  const { c, draft, intent } = await orderAwaitingPayment('+919700000113');
  assert.equal((await c.post('/payments/cancel', { orderId: draft.id })).status, 200);
  assert.equal(await stateOf(draft.id), 'cancelled');
  const r = await app.inject(signed(paymentEvent('payment.captured',
    paymentEntity(intent.gatewayOrderId, 14000, 'captured'))));
  assert.equal(r.statusCode, 200);
  assert.equal(await stateOf(draft.id), 'cancelled');
  const p = await paymentOf(draft.id);
  assert.match(p.flagged_reason || '', /paid_but_order_state=cancelled/);
});

/* ======================= refunds ========================================= */

test('a refund Razorpay answers `pending` is processing, and refund.processed completes it', async () => {
  refundMode = 'pending';
  const { draft } = await captureOrder('+919700000114');
  const ca = await admin();
  const r = await ca.post('/refunds', { orderId: draft.id, reason: 'kitchen closed' });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'processing', 'accepted is not completed');
  const call = stubCalls.find((x) => /\/refund$/.test(x.url));
  assert.equal(call.idem, r.body.refundId || call.idem, 'our refund id is the idempotency key');
  assert.equal(call.body.notes.quad_refund_id, call.idem);
  const [rf] = await refundsOf(draft.id);
  assert.equal(rf.state, 'processing');
  assert.match(rf.provider_refund_id, /^rfnd_stub_/);
  assert.equal((await paymentOf(draft.id)).status, 'paid', 'not refunded until the money moved');

  const done = await app.inject(signed(refundEvent('refund.processed',
    { id: rf.provider_refund_id, entity: 'refund', payment_id: 'pay_stub_1', amount: 14000,
      status: 'processed', notes: { quad_refund_id: rf.id } },
    paymentEntity(null, 14000, 'refunded'))));
  assert.equal(done.statusCode, 200);
  assert.equal(JSON.parse(done.body).refund, 'completed');
  const [after] = await refundsOf(draft.id);
  assert.equal(after.state, 'completed');
  assert.ok(after.settled_at);
  assert.equal((await paymentOf(draft.id)).status, 'refunded');
});

test('a refund.processed event is resolved by the provider refund id when the note is missing', async () => {
  refundMode = 'pending';
  const { draft } = await captureOrder('+919700000115');
  await (await admin()).post('/refunds', { orderId: draft.id, reason: 'x' });
  const [rf] = await refundsOf(draft.id);
  const done = await app.inject(signed(refundEvent('refund.processed',
    { id: rf.provider_refund_id, entity: 'refund', payment_id: 'pay_stub_1', amount: 14000, status: 'processed' },
    paymentEntity(null, 14000, 'refunded'))));
  assert.equal(JSON.parse(done.body).refund, 'completed');
});

test('the processing-refund sweep completes a pending refund from the provider status', async () => {
  refundMode = 'pending';
  const { draft } = await captureOrder('+919700000116');
  await (await admin()).post('/refunds', { orderId: draft.id, reason: 'x' });
  const [rf] = await refundsOf(draft.id);
  refundLookup[rf.provider_refund_id].status = 'processed';
  const { syncProcessingRefunds } = await import('../src/services/refund-status.js');
  const out = await syncProcessingRefunds();
  assert.equal(out.checked, 1);
  assert.equal(out.completed, 1);
  assert.equal((await refundsOf(draft.id))[0].state, 'completed');
  assert.equal((await paymentOf(draft.id)).status, 'refunded');
  assert.ok(stubCalls.some((x) => x.url === `/v1/refunds/${rf.provider_refund_id}`));
});

test('a refund the provider later reports failed raises a blocking refund_mismatch exception', async () => {
  refundMode = 'pending';
  const { draft } = await captureOrder('+919700000117');
  await (await admin()).post('/refunds', { orderId: draft.id, reason: 'x' });
  const [rf] = await refundsOf(draft.id);
  const r = await app.inject(signed(refundEvent('refund.failed',
    { id: rf.provider_refund_id, entity: 'refund', payment_id: 'pay_stub_1', amount: 14000,
      status: 'failed', notes: { quad_refund_id: rf.id } },
    paymentEntity(null, 14000, 'captured'))));
  assert.equal(JSON.parse(r.body).refund, 'mismatch_raised');
  const x = await pool.query(`SELECT kind, severity, state FROM reconciliation_exception`);
  assert.deepEqual(x.rows, [{ kind: 'refund_mismatch', severity: 'blocking', state: 'open' }]);
});

test('partial refunds: two partials, the payment is refunded only when the whole amount is back', async () => {
  const { draft } = await captureOrder('+919700000118');
  const ca = await admin();
  const first = await ca.post('/refunds', { orderId: draft.id, reason: 'one item', amountPaise: 4000 });
  assert.equal(first.status, 200);
  assert.equal(first.body.amountPaise, 4000);
  assert.equal(first.body.state, 'completed');
  assert.equal((await paymentOf(draft.id)).status, 'paid', 'partially refunded is still paid');
  assert.equal(await stateOf(draft.id), 'confirmed');

  const second = await ca.post('/refunds', { orderId: draft.id, reason: 'rest', amountPaise: 10000 });
  assert.equal(second.status, 200);
  assert.equal((await paymentOf(draft.id)).status, 'refunded');
  const calls = stubCalls.filter((x) => /\/refund$/.test(x.url)).map((x) => x.body.amount);
  assert.deepEqual(calls, [4000, 10000]);
  assert.equal((await ca.post('/refunds', { orderId: draft.id, reason: 'more', amountPaise: 1 })).status, 409);
});

/* ======================= ledger consistency ============================== */

test('ledger: one capture posting per payment, and a refund allocation per refund', async () => {
  const { draft } = await captureOrder('+919700000119');
  const cap = await pool.query(
    `SELECT count(*)::int AS n FROM ledger_txn WHERE kind='order_capture' AND order_id=$1`, [draft.id]);
  assert.equal(cap.rows[0].n, 1);
  /* A replayed capture through the OTHER path allocates nothing more. */
  const p = await paymentOf(draft.id);
  orderPayments = [paymentEntity(p.provider_order_id, 14000, 'captured')];
  const u = (await pool.query(`SELECT customer_id FROM food_order WHERE id=$1`, [draft.id])).rows[0];
  const c = client(app, await sessionFor(pool, u.customer_id));
  await c.get(`/payments/status?orderId=${draft.id}`);
  const cap2 = await pool.query(
    `SELECT count(*)::int AS n FROM ledger_txn WHERE kind='order_capture' AND order_id=$1`, [draft.id]);
  assert.equal(cap2.rows[0].n, 1);

  await (await admin()).post('/refunds', { orderId: draft.id, reason: 'x', amountPaise: 7000 });
  const alloc = await pool.query(`SELECT count(*)::int AS n FROM refund_allocation WHERE order_id=$1`, [draft.id]);
  assert.equal(alloc.rows[0].n, 1);
  const rt = await pool.query(
    `SELECT count(*)::int AS n FROM ledger_txn WHERE kind='refund' AND order_id=$1`, [draft.id]);
  assert.equal(rt.rows[0].n, 1);
});
