/* ==========================================================================
   CASHFREE COLLECTION — the full inbound path, exercised adversarially.

   The same principle as payments.test.mjs, applied to the second provider:

   · The WEBHOOK is inbound, so nothing about a real Cashfree account is
     needed to test it properly. Requests are constructed here, signed with
     the configured secret exactly as Cashfree signs them —
     Base64(HMAC-SHA256(timestamp + rawBody, secretKey)) — and posted at the
     real route. Signature verification, freshness, amount checking, order
     mapping, idempotency and the state transition are all genuinely
     exercised against the real handler.

   · The OUTBOUND calls (creating an order, pulling authoritative status,
     refunding) run against a local server speaking Cashfree's wire format.
     It is a stub of CASHFREE, never of Quad's own code: the real adapter
     makes real HTTP requests to it, so request construction, headers, the
     rupee/paise conversion and error handling are all verified. It is
     reachable only because CASHFREE_PG_BASE_URL points at it, and the boot
     guard refuses a non-https base URL in production.

   What this canNOT prove: that Cashfree accepts our requests. Only sandbox
   credentials can prove that, and it is listed as an outstanding blocker in
   docs/PAYMENTS-PROVIDER.md.

   Every test below is an attack that must fail, or a legitimate path that
   must survive the attacks around it.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus }
  from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const APP_ID = 'TEST_APPID_localstub';
const SECRET = 'cfsk_test_secret_not_real_' + 'z'.repeat(16);

let app, pool, stub, stubUrl;
const stubCalls = [];

/* What the stub should say when the SERVER asks it what happened. This is
   the authoritative pull the browser's return triggers, so being able to
   drive it is how the back-button and abandonment cases are tested. */
let orderState = { status: 'ACTIVE', payments: [] };
let createMode = 'ok';

function startStub() {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        stubCalls.push({
          method: req.method, url: req.url,
          clientId: req.headers['x-client-id'] || null,
          clientSecret: req.headers['x-client-secret'] || null,
          apiVersion: req.headers['x-api-version'] || null,
          idempotencyKey: req.headers['x-idempotency-key'] || null,
          body: body ? JSON.parse(body) : null,
        });
        const json = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };

        if (req.method === 'POST' && req.url === '/pg/orders') {
          if (createMode === 'error') {
            return json(400, { message: 'stub rejection', code: 'order_creation_failed' });
          }
          const b = JSON.parse(body);
          return json(200, {
            cf_order_id: 'cf_' + b.order_id,
            order_id: b.order_id,
            order_amount: b.order_amount,
            order_currency: b.order_currency,
            order_status: 'ACTIVE',
            payment_session_id: 'session_' + b.order_id,
          });
        }
        let m = /^\/pg\/orders\/([^/]+)\/payments$/.exec(req.url);
        if (m && req.method === 'GET') return json(200, orderState.payments);
        m = /^\/pg\/orders\/([^/?]+)$/.exec(req.url);
        if (m && req.method === 'GET') {
          return json(200, {
            cf_order_id: 'cf_' + decodeURIComponent(m[1]),
            order_id: decodeURIComponent(m[1]),
            order_amount: orderState.amount ?? '140.00',
            order_currency: 'INR',
            order_status: orderState.status,
          });
        }
        if (/^\/pg\/orders\/[^/]+\/refunds$/.test(req.url) && req.method === 'POST') {
          const b = JSON.parse(body);
          return json(200, { cf_refund_id: 'cfrfnd_1', refund_id: b.refund_id,
                             refund_amount: b.refund_amount, refund_status: 'SUCCESS' });
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
  process.env.PAYMENT_PROVIDER = 'cashfree';
  process.env.CASHFREE_PG_APP_ID = APP_ID;
  process.env.CASHFREE_PG_SECRET_KEY = SECRET;
  process.env.CASHFREE_PG_BASE_URL = stubUrl;
  ({ pool } = await import('../src/db/index.js'));
  const { build } = await import('../src/index.js');
  app = await build();
});

after(async () => {
  await app?.close();
  await pool?.end();
  await new Promise((r) => stub.close(r));
  await stopDb();
  for (const k of ['PAYMENT_PROVIDER', 'CASHFREE_PG_APP_ID', 'CASHFREE_PG_SECRET_KEY',
                   'CASHFREE_PG_BASE_URL']) delete process.env[k];
});

beforeEach(async () => {
  await truncateAll(pool);
  stubCalls.length = 0;
  createMode = 'ok';
  orderState = { status: 'ACTIVE', payments: [] };
});

const as = async (u) => client(app, await sessionFor(pool, u.id));

/* ---------- building a webhook exactly as Cashfree would ------------------
   Raw JSON bytes, HMAC-SHA256 over (timestamp + those precise bytes), the
   result base64-encoded into x-webhook-signature. Nothing here is a mock of
   our verifier — it is the provider's documented algorithm, and the route
   either agrees or does not. */
function signedWebhook(payload, { secret = SECRET, ts = Date.now(), key } = {}) {
  const raw = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    'x-webhook-timestamp': String(ts),
    'x-webhook-signature': createHmac('sha256', secret).update(String(ts) + raw).digest('base64'),
  };
  if (key !== null) headers['x-idempotency-key'] = key || 'idem_' + Math.random();
  return { method: 'POST', url: '/payments/webhook', payload: raw, headers };
}

const successEvent = (orderId, amount = '140.00', cfPaymentId = 990001) => ({
  type: 'PAYMENT_SUCCESS_WEBHOOK',
  event_time: new Date().toISOString(),
  data: {
    order: { order_id: orderId, order_amount: amount, order_currency: 'INR' },
    payment: { cf_payment_id: cfPaymentId, payment_status: 'SUCCESS',
               payment_amount: amount, payment_currency: 'INR',
               payment_time: new Date().toISOString() },
  },
});

const statusEvent = (orderId, status, type, amount = '140.00') => ({
  type,
  data: {
    order: { order_id: orderId, order_amount: amount, order_currency: 'INR' },
    payment: { cf_payment_id: 990002, payment_status: status,
               payment_amount: amount, payment_currency: 'INR' },
  },
});

/* An order sitting at awaiting_payment with a live Cashfree attempt. */
async function orderAwaitingPayment(phone = '+919600000001') {
  const n = await makeCampus(pool);
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

const stateOf = async (id) =>
  (await pool.query(`SELECT state FROM food_order WHERE id=$1`, [id])).rows[0].state;
const paymentOf = async (orderId) =>
  (await pool.query(`SELECT * FROM payment WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1`,
                    [orderId])).rows[0];

/* ======================= 1. intent construction ========================== */

test('the server creates a Cashfree order with ITS OWN amount and leaks no secret', async () => {
  const { draft, intent, intentStatus } = await orderAwaitingPayment();
  assert.equal(intentStatus, 200);
  assert.equal(draft.total_paise, 14000, '2 × ₹70, priced by the server');

  const call = stubCalls.find((c) => c.url === '/pg/orders');
  assert.ok(call, 'the outbound request really happened, against the real adapter');
  assert.equal(call.body.order_amount, '140.00',
    'integer paise converted exactly to a rupee decimal string — no float multiplication');
  assert.equal(call.body.order_currency, 'INR');
  assert.equal(call.clientId, APP_ID);
  assert.equal(call.clientSecret, SECRET, 'the secret authenticates the call, server-side only');
  assert.ok(call.apiVersion, 'an x-api-version is pinned');
  assert.equal(call.idempotencyKey, call.body.order_id,
    "the payment attempt's own id is the provider idempotency key");

  /* The Cashfree order id IS our payment id: one provider order per attempt,
     which is what keeps the webhook lookup unambiguous. */
  const pay = await paymentOf(draft.id);
  assert.equal(call.body.order_id, pay.id);
  assert.equal(pay.provider, 'cashfree');
  assert.equal(pay.amount_paise, 14000);
  assert.equal(pay.status, 'pending');

  /* Nothing secret reaches the client. */
  const asJson = JSON.stringify(intent);
  assert.ok(!asJson.includes(SECRET), 'the secret key must never be returned to a browser');
  assert.equal(intent.appId, APP_ID, 'only the public app id is sent');
  assert.equal(intent.paymentSessionId, 'session_' + pay.id);
  assert.equal(intent.provider, 'cashfree');

  assert.equal(await stateOf(draft.id), 'awaiting_payment', 'not confirmed by creating an intent');
});

test('a gateway failure leaves the order unpaid and surfaces an error', async () => {
  createMode = 'error';
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'F', slug: 'f-err' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919600000002', name: 'A' });
  const c = await as(u);
  const draft = (await c.post('/orders/draft', {
    vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }],
    fulfilment: 'delivery', destinationId: n.blockB.id })).body;

  const r = await c.post('/payments/intent', { orderId: draft.id });
  assert.ok(r.status >= 400, 'a rejected gateway call must not look successful');
  assert.equal(await stateOf(draft.id), 'draft', 'the order stays unpaid');
  const pay = await paymentOf(draft.id);
  assert.equal(pay.status, 'failed', 'the failed attempt is recorded, not hidden');
});

test('double-tapping Pay resumes the same attempt instead of creating a second one', async () => {
  const { draft, c, intent } = await orderAwaitingPayment('+919600000003');
  const before = stubCalls.filter((x) => x.url === '/pg/orders').length;
  const again = await c.post('/payments/intent', { orderId: draft.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.paymentSessionId, intent.paymentSessionId, 'the SAME checkout session');
  assert.equal(stubCalls.filter((x) => x.url === '/pg/orders').length, before,
    'no second provider order competing for the same money');
  const n = await pool.query(`SELECT count(*)::int AS n FROM payment WHERE order_id=$1`, [draft.id]);
  assert.equal(n.rows[0].n, 1);
});

/* ======================= 2. the happy path =============================== */

test('a correctly signed SUCCESS webhook confirms the order and allocates the ledger', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919600000010');
  const pay = await paymentOf(draft.id);

  const res = await app.inject(signedWebhook(successEvent(pay.id)));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).confirmed, true);

  assert.equal(await stateOf(draft.id), 'confirmed', 'ONLY a verified webhook can do this');
  const after = await paymentOf(draft.id);
  assert.equal(after.status, 'paid');
  assert.equal(after.provider_payment_id, '990001');
  assert.ok(after.settled_at);
  assert.equal(after.flagged_reason, null);

  /* The allocation happened in the same transaction as the confirmation. */
  const led = await pool.query(`SELECT count(*)::int AS n FROM ledger_txn WHERE order_id=$1`,
                               [draft.id]);
  assert.ok(led.rows[0].n > 0, 'a confirmed order without ledger entries must be impossible');

  /* Cashfree does not report its fee on the payment webhook, so the fee is
     left at zero rather than estimated. Truthful beats convenient. */
  const snap = await pool.query(`SELECT gateway_fee_paise FROM order_financials WHERE order_id=$1`,
                                [draft.id]);
  assert.equal(snap.rows[0].gateway_fee_paise, 0);
});

/* ======================= 3. signature forgery ============================ */

test('a forged, missing or tampered signature is rejected and changes nothing', async () => {
  const { draft } = await orderAwaitingPayment('+919600000011');
  const pay = await paymentOf(draft.id);
  const evt = successEvent(pay.id);
  const raw = JSON.stringify(evt);
  const ts = String(Date.now());
  const good = createHmac('sha256', SECRET).update(ts + raw).digest('base64');

  const attempts = [
    ['wrong secret', { 'x-webhook-timestamp': ts,
      'x-webhook-signature': createHmac('sha256', 'attacker').update(ts + raw).digest('base64') }],
    ['no signature at all', { 'x-webhook-timestamp': ts }],
    ['no timestamp', { 'x-webhook-signature': good }],
    ['empty signature', { 'x-webhook-timestamp': ts, 'x-webhook-signature': '' }],
    ['truncated signature', { 'x-webhook-timestamp': ts, 'x-webhook-signature': good.slice(0, 20) }],
    ['hex instead of base64', { 'x-webhook-timestamp': ts,
      'x-webhook-signature': createHmac('sha256', SECRET).update(ts + raw).digest('hex') }],
    /* Signed WITHOUT the timestamp prefix: the correct secret, the correct
       body, and still refused. The timestamp is inside the signed material
       precisely so it cannot be swapped. */
    ['body-only signature', { 'x-webhook-timestamp': ts,
      'x-webhook-signature': createHmac('sha256', SECRET).update(raw).digest('base64') }],
    /* A valid signature over a DIFFERENT timestamp, replayed with a fresh
       one to get inside the freshness window. */
    ['signature/timestamp mismatch', { 'x-webhook-timestamp': String(Date.now() + 1),
      'x-webhook-signature': good }],
  ];

  for (const [name, headers] of attempts) {
    const res = await app.inject({
      method: 'POST', url: '/payments/webhook', payload: raw,
      headers: { 'content-type': 'application/json',
                 'x-idempotency-key': 'idem_' + name, ...headers },
    });
    assert.equal(res.statusCode, 400, `${name} must be rejected`);
  }

  assert.equal(await stateOf(draft.id), 'awaiting_payment', 'no forgery may confirm an order');
  const wh = await pool.query(`SELECT count(*)::int AS n FROM payment_webhook`);
  assert.equal(wh.rows[0].n, 0, 'a rejected webhook is not even recorded');
});

test('tampering with the body after signing invalidates the signature', async () => {
  const { draft } = await orderAwaitingPayment('+919600000012');
  const pay = await paymentOf(draft.id);
  const ts = String(Date.now());
  const honest = JSON.stringify(successEvent(pay.id, '140.00'));
  const signature = createHmac('sha256', SECRET).update(ts + honest).digest('base64');
  /* Same signature, a body claiming ₹1 was paid. */
  const tampered = JSON.stringify(successEvent(pay.id, '1.00'));

  const res = await app.inject({
    method: 'POST', url: '/payments/webhook', payload: tampered,
    headers: { 'content-type': 'application/json', 'x-webhook-timestamp': ts,
               'x-webhook-signature': signature, 'x-idempotency-key': 'idem_tamper' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
});

/* ======================= 4. replay ======================================= */

test('a webhook replayed outside the freshness window is refused', async () => {
  const { draft } = await orderAwaitingPayment('+919600000013');
  const pay = await paymentOf(draft.id);

  /* A perfectly signed delivery captured an hour ago and replayed now. The
     signature verifies — it is genuine — and it is still refused, because
     the timestamp it commits to is far outside the window. */
  const stale = signedWebhook(successEvent(pay.id), { ts: Date.now() - 3600_000 });
  const res = await app.inject(stale);
  assert.equal(res.statusCode, 400, 'a stale replay must not be accepted');
  assert.equal(await stateOf(draft.id), 'awaiting_payment');

  /* Nor from the future, which is the same attack with the clock inverted. */
  const future = signedWebhook(successEvent(pay.id), { ts: Date.now() + 3600_000 });
  assert.equal((await app.inject(future)).statusCode, 400);
  assert.equal(await stateOf(draft.id), 'awaiting_payment');

  const audits = await pool.query(
    `SELECT detail FROM audit_log WHERE action='payment.webhook' AND outcome='denied'`);
  assert.ok(audits.rowCount >= 2, 'both refusals are audited');
  assert.ok(JSON.stringify(audits.rows).includes('stale_timestamp'),
    'and audited with the reason, so an operator can tell a replay from a forgery');
});

test('a duplicate delivery of the SAME event confirms exactly once', async () => {
  const { draft } = await orderAwaitingPayment('+919600000014');
  const pay = await paymentOf(draft.id);
  const req = signedWebhook(successEvent(pay.id), { key: 'idem_fixed' });

  const first = await app.inject(req);
  const second = await app.inject(req);
  const third = await app.inject(req);
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(second.body).duplicate, true, 'the replay is recognised');
  assert.equal(JSON.parse(third.body).duplicate, true);

  const ev = await pool.query(
    `SELECT count(*)::int AS n FROM order_event WHERE order_id=$1 AND to_state='confirmed'`,
    [draft.id]);
  assert.equal(ev.rows[0].n, 1, 'the order must not be confirmed twice');
  const wh = await pool.query(`SELECT count(*)::int AS n FROM payment_webhook`);
  assert.equal(wh.rows[0].n, 1);
  /* And the money was allocated once, not three times. */
  const led = await pool.query(
    `SELECT count(*)::int AS n FROM ledger_txn WHERE order_id=$1 AND kind='order_capture'`,
    [draft.id]);
  assert.ok(led.rows[0].n <= 1, 'the capture allocation is idempotent');
});

test('a SECOND success event for an already-paid order confirms nothing further', async () => {
  const { draft } = await orderAwaitingPayment('+919600000015');
  const pay = await paymentOf(draft.id);
  await app.inject(signedWebhook(successEvent(pay.id), { key: 'idem_one' }));
  assert.equal(await stateOf(draft.id), 'confirmed');

  /* A different event id — so idempotency on the webhook table does NOT
     absorb it — carrying the same payment. The payment's own status is the
     guard that stops a second confirmation. */
  const again = await app.inject(
    signedWebhook(successEvent(pay.id, '140.00', 990009), { key: 'idem_two' }));
  assert.equal(JSON.parse(again.body).duplicate, true);
  const ev = await pool.query(
    `SELECT count(*)::int AS n FROM order_event WHERE order_id=$1 AND to_state='confirmed'`,
    [draft.id]);
  assert.equal(ev.rows[0].n, 1);
});

/* ======================= 5. amount and currency ========================== */

test('a correctly signed webhook for the WRONG amount flags rather than confirms', async () => {
  const { draft } = await orderAwaitingPayment('+919600000016');
  const pay = await paymentOf(draft.id);

  /* The attacker pays ₹1 through their own means. The signature is genuine;
     the amount is not the one the server pinned to the order. */
  const res = await app.inject(signedWebhook(successEvent(pay.id, '1.00')));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).rejected, 'amount mismatch');

  assert.equal(await stateOf(draft.id), 'awaiting_payment', 'underpayment must never confirm');
  const after = await paymentOf(draft.id);
  assert.equal(after.status, 'failed');
  assert.match(after.flagged_reason, /amount_mismatch expected=14000 got=100/);
  assert.ok(after.flagged_at, 'the flag carries its time');

  const a = await pool.query(`SELECT 1 FROM audit_log WHERE action='payment.flagged'`);
  assert.equal(a.rowCount, 1, 'the discrepancy is an audited fact, not a log line');
});

test('OVERpayment is refused too — it is a reconciliation failure, not a bonus', async () => {
  const { draft } = await orderAwaitingPayment('+919600000017');
  const pay = await paymentOf(draft.id);
  const res = await app.inject(signedWebhook(successEvent(pay.id, '99999.00')));
  assert.equal(JSON.parse(res.body).rejected, 'amount mismatch');
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
});

test('an amount with sub-paise precision is refused rather than rounded', async () => {
  const { draft } = await orderAwaitingPayment('+919600000018');
  const pay = await paymentOf(draft.id);
  /* 140.001 is not representable in paise. Coercing it would be inventing a
     number; the fail-closed direction is to refuse. */
  const res = await app.inject(signedWebhook(successEvent(pay.id, '140.001')));
  assert.equal(JSON.parse(res.body).rejected, 'amount mismatch');
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
});

test('a payment in another currency cannot confirm a rupee order', async () => {
  const { draft } = await orderAwaitingPayment('+919600000019');
  const pay = await paymentOf(draft.id);
  const evt = successEvent(pay.id);
  evt.data.payment.payment_currency = 'USD';
  const res = await app.inject(signedWebhook(evt));
  assert.equal(JSON.parse(res.body).rejected, 'currency mismatch');
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
  const after = await paymentOf(draft.id);
  assert.match(after.flagged_reason, /currency_mismatch/);
});

test('a flagged payment can never be revived by a later well-formed webhook', async () => {
  const { draft } = await orderAwaitingPayment('+919600000020');
  const pay = await paymentOf(draft.id);
  await app.inject(signedWebhook(successEvent(pay.id, '1.00'), { key: 'idem_bad' }));
  assert.match((await paymentOf(draft.id)).flagged_reason, /amount_mismatch/);

  /* Now the correct amount arrives. The payment is already flagged for
     investigation, and a flagged payment is out of the confirmation path
     for good — in the route AND in the database CHECK constraint. */
  const res = await app.inject(signedWebhook(successEvent(pay.id, '140.00'), { key: 'idem_good' }));
  assert.equal(JSON.parse(res.body).rejected, 'payment is flagged for investigation');
  assert.equal(await stateOf(draft.id), 'awaiting_payment');

  /* And the constraint refuses it even below the application. */
  await assert.rejects(
    () => pool.query(`UPDATE payment SET status='paid' WHERE id=$1`, [pay.id]),
    /payment_flagged_not_paid/);
});

/* ======================= 6. order mapping ================================ */

test('a webhook for an unknown provider order is ignored, not guessed at', async () => {
  const { draft } = await orderAwaitingPayment('+919600000021');
  const res = await app.inject(signedWebhook(
    successEvent('11111111-1111-1111-1111-111111111111')));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).ignored, 'unknown payment');
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
});

test("a successful payment for another order cannot confirm this one", async () => {
  const a = await orderAwaitingPayment('+919600000022');
  const b = await orderAwaitingPayment('+919600000023');
  const payA = await paymentOf(a.draft.id);

  /* A's genuine, correctly signed, correctly priced success. B must be
     untouched: the mapping is by provider order id, and there is no
     amount-based fallback that could match B's identical total. */
  await app.inject(signedWebhook(successEvent(payA.id)));
  assert.equal(await stateOf(a.draft.id), 'confirmed');
  assert.equal(await stateOf(b.draft.id), 'awaiting_payment');
  assert.equal((await paymentOf(b.draft.id)).status, 'pending');
});

/* ======================= 7. not-success outcomes ========================= */

test('an ABANDONED checkout does not create a paid order', async () => {
  const { draft } = await orderAwaitingPayment('+919600000024');
  const pay = await paymentOf(draft.id);
  const res = await app.inject(signedWebhook(
    statusEvent(pay.id, 'USER_DROPPED', 'PAYMENT_USER_DROPPED_WEBHOOK')));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).outcome, 'dropped',
    'abandonment is its own outcome, never mistaken for success');
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
  assert.notEqual((await paymentOf(draft.id)).status, 'paid');
});

test('a PENDING payment does not create a paid order', async () => {
  const { draft } = await orderAwaitingPayment('+919600000025');
  const pay = await paymentOf(draft.id);
  const res = await app.inject(signedWebhook(statusEvent(pay.id, 'PENDING', 'PAYMENT_SUCCESS_WEBHOOK')));
  assert.equal(JSON.parse(res.body).outcome, 'pending');
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
  assert.equal((await paymentOf(draft.id)).status, 'pending',
    'still pending, so a later genuine success can still land');
});

test('a FAILED payment does not create a paid order', async () => {
  const { draft } = await orderAwaitingPayment('+919600000026');
  const pay = await paymentOf(draft.id);
  await app.inject(signedWebhook(statusEvent(pay.id, 'FAILED', 'PAYMENT_FAILED_WEBHOOK')));
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
  assert.equal((await paymentOf(draft.id)).status, 'failed');
});

/* ======================= 8. the browser's return ========================= */

test('the BACK BUTTON does not pay for anything', async () => {
  /* The customer opens checkout, pays nothing, and comes straight back. The
     provider still says ACTIVE — nobody has paid. */
  const { draft, c } = await orderAwaitingPayment('+919600000030');
  orderState = { status: 'ACTIVE', payments: [] };

  const st = await c.get(`/payments/status?orderId=${draft.id}`);
  assert.equal(st.status, 200);
  assert.equal(st.body.confirmed, false);
  assert.equal(st.body.payment, 'pending');
  assert.equal(await stateOf(draft.id), 'awaiting_payment');

  /* And the server really did ask the provider rather than believing the
     browser's arrival. */
  assert.ok(stubCalls.some((x) => /^\/pg\/orders\//.test(x.url) && x.method === 'GET'),
    'the return path pulls authoritative status from the gateway');
});

test('a closed checkout reported as TERMINATED does not confirm', async () => {
  const { draft, c } = await orderAwaitingPayment('+919600000031');
  orderState = { status: 'TERMINATED', payments: [] };
  const st = await c.get(`/payments/status?orderId=${draft.id}`);
  assert.equal(st.body.confirmed, false);
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
});

test('the return path CONFIRMS when the provider says paid, even with no webhook', async () => {
  /* The self-healing case, and the reason the pull exists: a webhook that
     never arrives must not cost a customer their money. Note no webhook is
     posted anywhere in this test. */
  const { draft, c } = await orderAwaitingPayment('+919600000032');
  const pay = await paymentOf(draft.id);
  orderState = { status: 'PAID', amount: '140.00', payments: [
    { cf_payment_id: 777001, payment_status: 'SUCCESS',
      payment_amount: '140.00', payment_currency: 'INR' }] };

  const st = await c.get(`/payments/status?orderId=${draft.id}`);
  assert.equal(st.body.confirmed, true);
  assert.equal(await stateOf(draft.id), 'confirmed');
  const after = await paymentOf(draft.id);
  assert.equal(after.status, 'paid');
  assert.equal(after.provider_payment_id, '777001');

  /* Attributed to the pull, so an auditor can tell which source confirmed. */
  const a = await pool.query(
    `SELECT detail FROM audit_log WHERE action='payment.captured'`);
  assert.match(JSON.stringify(a.rows), /status_pull/);
  assert.notEqual(pay.status, 'paid', 'it was genuinely pending beforehand');
});

test('the return path applies the SAME amount check as the webhook', async () => {
  /* The pull is authoritative about what the provider says, not about
     whether it is acceptable. A provider reporting a paid order for the
     wrong amount is flagged here exactly as it is on the webhook. */
  const { draft, c } = await orderAwaitingPayment('+919600000033');
  orderState = { status: 'PAID', amount: '1.00', payments: [
    { cf_payment_id: 777002, payment_status: 'SUCCESS',
      payment_amount: '1.00', payment_currency: 'INR' }] };

  const st = await c.get(`/payments/status?orderId=${draft.id}`);
  assert.equal(st.body.confirmed, false);
  assert.equal(st.body.underReview, true, 'the customer is told the truth, not shown a spinner');
  assert.equal(await stateOf(draft.id), 'awaiting_payment');
  assert.match((await paymentOf(draft.id)).flagged_reason, /amount_mismatch/);
});

test('the status endpoint cannot be pointed at somebody else\'s order', async () => {
  const a = await orderAwaitingPayment('+919600000034');
  const b = await orderAwaitingPayment('+919600000035');
  /* The ONLY input the browser contributes to the whole confirmation path is
     an order id, and it must own it. */
  const r = await b.c.get(`/payments/status?orderId=${a.draft.id}`);
  assert.equal(r.status, 403);
});

test('an unreachable gateway leaves the order pending — never paid, never failed', async () => {
  const { draft, c } = await orderAwaitingPayment('+919600000036');
  const saved = process.env.CASHFREE_PG_BASE_URL;
  process.env.CASHFREE_PG_BASE_URL = 'http://127.0.0.1:1';   // nothing listening
  try {
    const st = await c.get(`/payments/status?orderId=${draft.id}`);
    assert.equal(st.status, 200, 'the customer sees a state, not a stack trace');
    assert.equal(st.body.confirmed, false);
    assert.equal(await stateOf(draft.id), 'awaiting_payment');
    assert.equal((await paymentOf(draft.id)).status, 'pending',
      'an unreachable gateway is not evidence of failure any more than of success');
  } finally {
    process.env.CASHFREE_PG_BASE_URL = saved;
  }
});

/* ======================= 9. no frontend authority ======================== */

test('no frontend call of any shape can mark an order paid', async () => {
  const { draft, c } = await orderAwaitingPayment('+919600000040');
  const pay = await paymentOf(draft.id);

  const attempts = [
    ['transition to confirmed', await c.post(`/orders/${draft.id}/transition`, { to: 'confirmed' })],
    ['transition to preparing', await c.post(`/orders/${draft.id}/transition`, { to: 'preparing' })],
    ['transition to delivered', await c.post(`/orders/${draft.id}/transition`, { to: 'delivered' })],
    /* There is no success endpoint to call. These 404 rather than 403, which
       is the strongest possible answer: the attack surface does not exist. */
    ['invented success endpoint', await c.post('/payments/success', { orderId: draft.id })],
    ['invented confirm endpoint', await c.post('/payments/confirm', { orderId: draft.id, paid: true })],
    ['webhook with no signature', await c.post('/payments/webhook', successEvent(pay.id))],
  ];
  for (const [name, r] of attempts) {
    assert.ok(r.status >= 400, `${name} must not succeed (got ${r.status})`);
  }

  /* Nor by claiming a different amount at intent time. */
  const cheat = await c.post('/payments/intent',
                             { orderId: draft.id, amountPaise: 1, total_paise: 1, amount: 1 });
  assert.equal(cheat.body.amountPaise, 14000, 'the request body cannot influence the amount');

  assert.equal(await stateOf(draft.id), 'awaiting_payment');
});

test('cancelling at checkout leaves a cancelled order that a late success cannot revive', async () => {
  const { draft, c } = await orderAwaitingPayment('+919600000041');
  const pay = await paymentOf(draft.id);
  assert.equal((await c.post('/payments/cancel', { orderId: draft.id })).status, 200);
  assert.equal(await stateOf(draft.id), 'cancelled');

  /* A genuine success arriving afterwards must not quietly resurrect an
     order the customer cancelled. It is flagged for a human instead. */
  const res = await app.inject(signedWebhook(successEvent(pay.id)));
  assert.equal(res.statusCode, 200);
  assert.equal(await stateOf(draft.id), 'cancelled');
  const after = await paymentOf(draft.id);
  assert.notEqual(after.status, 'paid');
  assert.match(after.flagged_reason || '', /paid_but_order_state=cancelled/);
});

/* ======================= 10. secrets and audit =========================== */

test('the webhook path is audited and no secret ever reaches the log or the client', async () => {
  const { draft, intent } = await orderAwaitingPayment('+919600000050');
  const pay = await paymentOf(draft.id);
  await app.inject(signedWebhook(successEvent(pay.id)));
  await app.inject({
    method: 'POST', url: '/payments/webhook', payload: JSON.stringify(successEvent(pay.id)),
    headers: { 'content-type': 'application/json', 'x-webhook-timestamp': String(Date.now()),
               'x-webhook-signature': 'bad', 'x-idempotency-key': 'idem_bad2' },
  });

  const rows = (await pool.query(
    `SELECT action, outcome, detail FROM audit_log WHERE action LIKE 'payment%'`)).rows;
  const actions = rows.map((r) => `${r.action}:${r.outcome}`);
  assert.ok(actions.includes('payment.captured:ok'), 'a capture is audited');
  assert.ok(actions.some((a) => a.startsWith('payment.webhook:denied')), 'a forgery is audited');

  const dump = JSON.stringify(rows) + JSON.stringify(intent);
  assert.ok(!dump.includes(SECRET), 'the Cashfree secret key must never be logged or returned');
});
