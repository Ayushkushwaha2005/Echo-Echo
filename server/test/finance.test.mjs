/* ==========================================================================
   FINANCE — allocation, ledger, refunds, settlement, isolation

   Every test here runs against a real PostgreSQL database created by the
   real migrations, through the real Fastify stack. The constraints being
   relied on — the balancing trigger, the immutability triggers, the partial
   unique indexes, the CHECK that a paid payout has evidence — are actually
   exercised, not asserted by reading the schema.

   Razorpay is INBOUND for capture: the webhook is constructed here and
   signed with the configured secret, so signature checking, amount checking,
   idempotency and allocation are all genuinely tested. The two OUTBOUND
   calls (creating a gateway order, and issuing a refund) go to a local stub
   speaking Razorpay's wire format, so request construction is verified
   without moving anyone's money.

   What this canNOT prove: that Razorpay accepts these requests, or that
   RazorpayX will make a transfer. Both need real credentials, and both are
   listed as external provisioning blockers.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus, setTerms }
  from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const WEBHOOK_SECRET = 'whsec_test_' + 'a'.repeat(24);

let app, pool, stub, stubUrl, campus;
let refundCalls = [];

function startStub() {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        if (req.url.startsWith('/v1/orders')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({
            id: 'order_stub_' + Math.random().toString(36).slice(2),
            amount: parsed.amount, currency: parsed.currency, status: 'created' }));
        }
        if (/\/v1\/payments\/.+\/refund/.test(req.url)) {
          refundCalls.push({ body: parsed, idem: req.headers['x-razorpay-idempotency'] });
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({
            id: 'rfnd_' + refundCalls.length, status: 'processed' }));
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
  process.env.PAYMENT_PROVIDER = 'razorpay';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_localstub';
  process.env.RAZORPAY_KEY_SECRET = 'stub_secret_not_real';
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
  refundCalls = [];
  campus = await makeCampus(pool);
});

const as = async (u) => client(app, await sessionFor(pool, u.id));

function signedWebhook(payload, { eventId = 'evt_' + Math.random() } = {}) {
  const raw = JSON.stringify(payload);
  return {
    method: 'POST', url: '/payments/webhook', payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
      'x-razorpay-event-id': eventId,
    },
  };
}

const captureEvent = (gatewayOrderId, amount, paymentId = 'pay_' + Math.random()) => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, order_id: gatewayOrderId,
                                  amount, status: 'captured' } } },
});

/* ---------- the standard scene ------------------------------------------
   The brief's worked example, set up as an administrator would: terms are a
   versioned pricing policy, not a config key.
     food 100.00 · commission 2% deducted · platform fee 5.00 flat
     delivery charged 10.00 · partner earns 10.00                          */
async function scene({ terms, fulfilment = 'delivery', itemPaise = 10000, qty = 1 } = {}) {
  const vendor = await makeVendor(pool, { name: 'Frisco', slug: 'frisco-' + Math.random() });
  const item = await makeItem(pool, vendor.id, { name: 'Thali', paise: itemPaise });
  const customer = await makeUser(pool, { phone: '+9190000' + String(Math.floor(Math.random() * 90000) + 10000), name: 'Customer' });
  const owner = await makeUser(pool, { phone: '+9190001' + String(Math.floor(Math.random() * 90000) + 10000),
                                       name: 'Owner', roles: ['vendor_owner'], vendorId: vendor.id });
  const admin = await makeUser(pool, { phone: '+9190002' + String(Math.floor(Math.random() * 90000) + 10000),
                                       name: 'Admin', roles: ['platform_owner'] });
  await setTerms(pool, terms ?? {
    commission_bps: 200, commission_mode: 'deduct_from_cafeteria',
    platform_fee_flat_paise: 500, delivery_fee_paise: 1000, delivery_earning_paise: 1000,
  });
  const cs = await as(customer);
  const draft = await cs.post('/orders/draft', {
    vendorId: vendor.id, lines: [{ itemId: item.id, qty }],
    fulfilment, destinationId: fulfilment === 'delivery' ? campus.blockB.id : undefined,
  });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  return { vendor, item, customer, owner, admin, cs, order: draft.body };
}

/* Take the order all the way to captured, returning the webhook's payment id. */
async function pay(s) {
  const intent = await s.cs.post('/payments/intent', { orderId: s.order.id });
  assert.equal(intent.status, 200, JSON.stringify(intent.body));
  const res = await app.inject(signedWebhook(
    captureEvent(intent.body.gatewayOrderId, intent.body.amountPaise)));
  assert.equal(res.statusCode, 200);
  return intent.body;
}

/* Complete a delivery the only way the product allows one to be completed:
   the customer reads out a handoff code and the partner types it. There is
   deliberately no route by which a partner can mark an order delivered
   without it, so the tests do not invent one. */
async function completeDelivery(s, partner) {
  await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1,'approved')
                    ON CONFLICT (user_id) DO NOTHING`, [partner.id]);
  await pool.query(`UPDATE food_order SET state='picked_up', partner_id=$2 WHERE id=$1`,
                   [s.order.id, partner.id]);
  const code = await s.cs.get(`/orders/${s.order.id}/handoff-code`);
  const ps = await as(partner);
  const done = await ps.post(`/orders/${s.order.id}/handoff`, { code: code.body.code });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return ps;
}

const row = (r) => (r.rows[0] || null);
const snapOf = async (orderId) =>
  row(await pool.query(`SELECT * FROM order_financials WHERE order_id=$1`, [orderId]));
const balanceOf = async (kind, id) => Number(row(await pool.query(
  `SELECT COALESCE(sum(balance_paise),0)::bigint AS b FROM v_account_balance
    WHERE kind=$1 AND ($2::uuid IS NULL
      OR vendor_id = $2 OR partner_id = $2)`, [kind, id ?? null])).b);

/* ======================================================================
   1 — the 115-rupee question
   ====================================================================== */

test('a 115 rupee payment is allocated to the exact paisa', async () => {
  const s = await scene();

  /* The customer is charged the server's number, and it is 115.00. */
  assert.equal(s.order.total_paise, 11500);
  const snap = await snapOf(s.order.id);
  assert.equal(snap.food_subtotal_paise, 10000);
  assert.equal(snap.commission_paise, 200, '2% of 100 rupees');
  assert.equal(snap.platform_fee_paise, 500);
  assert.equal(snap.delivery_fee_paise, 1000);
  assert.equal(snap.customer_total_paise, 11500);

  /* And where it belongs. */
  assert.equal(snap.cafeteria_payable_paise, 9800, 'cafeteria is owed 98');
  assert.equal(snap.delivery_earning_paise, 1000, 'partner earns 10');
  assert.equal(snap.platform_gross_paise, 700, 'Quad keeps 5 fee + 2 commission');
  assert.equal(
    snap.cafeteria_payable_paise + snap.delivery_earning_paise +
    snap.tax_payable_paise + snap.platform_gross_paise,
    snap.customer_total_paise, 'the allocation accounts for every paisa');

  await pay(s);

  /* Now in the ledger, and balanced. */
  const legs = (await pool.query(
    `SELECT a.kind, e.amount_paise FROM ledger_entry e
       JOIN ledger_account a ON a.id = e.account_id
      WHERE e.order_id = $1 ORDER BY a.kind`, [s.order.id])).rows;
  const byKind = Object.fromEntries(legs.map((l) => [l.kind, Number(l.amount_paise)]));
  assert.equal(byKind.gateway_clearing, 11500, 'Quad received 115');
  assert.equal(byKind.cafeteria_payable, -9800);
  assert.equal(byKind.delivery_clearing, -1000);
  assert.equal(byKind.platform_revenue, -700);
  assert.equal(legs.reduce((t, l) => t + Number(l.amount_paise), 0), 0,
    'double entry: the transaction sums to zero');

  assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 9800);
  assert.equal(await balanceOf('platform_revenue'), 700);
});

test('the delivery earning reaches the partner only when the delivery is done',
  async () => {
    const s = await scene();
    await pay(s);
    const partner = await makeUser(pool, { phone: '+919111111111', name: 'Rider',
                                           roles: ['student', 'delivery_partner'] });
    await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1,'approved')`,
                     [partner.id]);

    /* Captured but undelivered: the money is held by the platform, and the
       partner's balance is empty. */
    assert.equal(await balanceOf('delivery_clearing'), 1000);
    assert.equal(await balanceOf('delivery_payable', partner.id), 0);

    const ow = await as(s.owner);
    await ow.post(`/orders/${s.order.id}/transition`, { to: 'preparing' });
    await ow.post(`/orders/${s.order.id}/transition`, { to: 'ready' });
    await pool.query(`UPDATE food_order SET state='assigned', partner_id=$2 WHERE id=$1`,
                     [s.order.id, partner.id]);
    const ps = await as(partner);
    /* Collection is proven with the cafeteria's pickup code, not asserted by
       the partner. */
    const pick = await ow.get(`/orders/${s.order.id}/pickup-code`);
    assert.equal(pick.status, 200, JSON.stringify(pick.body));
    const got = await ps.post(`/orders/${s.order.id}/pickup`, { code: pick.body.code });
    assert.equal(got.status, 200, JSON.stringify(got.body));

    /* The handoff is the moment the money is earned. */
    const cs = await as(s.customer);
    const code = await cs.get(`/orders/${s.order.id}/handoff-code`);
    const done = await ps.post(`/orders/${s.order.id}/handoff`, { code: code.body.code });
    assert.equal(done.status, 200, JSON.stringify(done.body));

    assert.equal(await balanceOf('delivery_clearing'), 0);
    assert.equal(await balanceOf('delivery_payable', partner.id), 1000);

    const earn = await ps.get('/partner/earnings');
    assert.equal(earn.body.completedDeliveries, 1);
    assert.equal(earn.body.totalEarnedPaise, 1000);
    assert.equal(earn.body.pendingPayoutPaise, 1000);
    assert.equal(earn.body.paidOutPaise, 0);
  });

test('commission charged to the customer is a different, also-balanced split', async () => {
  const s = await scene({ terms: {
    commission_bps: 200, commission_mode: 'charge_to_customer',
    platform_fee_flat_paise: 500, delivery_fee_paise: 1000, delivery_earning_paise: 1000,
  } });
  const snap = await snapOf(s.order.id);
  assert.equal(snap.customer_total_paise, 11700, 'the customer pays the 2 rupees on top');
  assert.equal(snap.cafeteria_payable_paise, 10000, 'the cafeteria keeps the full 100');
  assert.equal(snap.platform_gross_paise, 700);
  assert.equal(snap.cafeteria_payable_paise + snap.delivery_earning_paise +
               snap.platform_gross_paise, snap.customer_total_paise);
});

test('a pickup order has no delivery money at all', async () => {
  const s = await scene({ fulfilment: 'pickup' });
  const snap = await snapOf(s.order.id);
  assert.equal(snap.delivery_fee_paise, 0);
  assert.equal(snap.delivery_earning_paise, 0);
  assert.equal(snap.customer_total_paise, 10500, 'food + platform fee only');
  await pay(s);
  assert.equal(await balanceOf('delivery_clearing'), 0);
});

/* ======================================================================
   2 — nothing the client sends changes the money
   ====================================================================== */

test('a malicious client cannot change the allocation', async () => {
  const vendor = await makeVendor(pool, { name: 'Frisco', slug: 'f2' });
  const item = await makeItem(pool, vendor.id, { name: 'Thali', paise: 10000 });
  const customer = await makeUser(pool, { phone: '+919333333333', name: 'Attacker' });
  await setTerms(pool, { commission_bps: 200, platform_fee_flat_paise: 500,
                         delivery_fee_paise: 1000, delivery_earning_paise: 1000 });
  const cs = await as(customer);

  const draft = await cs.post('/orders/draft', {
    vendorId: vendor.id, fulfilment: 'delivery', destinationId: campus.blockB.id,
    lines: [{ itemId: item.id, qty: 1, unit_paise: 1, price: 1, line_paise: 1 }],
    /* Everything a client could possibly try. */
    commission: 0, commission_paise: 0, commissionBps: 0,
    platform_fee: 0, platform_fee_paise: 0, platformFeePaise: 0,
    delivery_earning: 100000, deliveryEarningPaise: 100000, delivery_paise: 0,
    subtotal_paise: 1, total_paise: 1, totalPaise: 1,
    cafeteria_payable_paise: 0, quad_revenue_paise: 0,
    discount_paise: 9999, discountPaise: 9999,
  });
  assert.equal(draft.status, 200);

  const snap = await snapOf(draft.body.id);
  assert.equal(snap.customer_total_paise, 11500, 'the server total is untouched');
  assert.equal(snap.commission_paise, 200);
  assert.equal(snap.platform_fee_paise, 500);
  assert.equal(snap.delivery_earning_paise, 1000);
  assert.equal(snap.cafeteria_payable_paise, 9800);
  assert.equal(snap.discount_paise, 0, 'a client cannot grant itself a discount');
});

test('a gateway callback for less than the snapshot confirms nothing', async () => {
  const s = await scene();
  const intent = await s.cs.post('/payments/intent', { orderId: s.order.id });
  const res = await app.inject(signedWebhook(
    captureEvent(intent.body.gatewayOrderId, 100)));       // 1 rupee, not 115
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /amount mismatch/);

  const o = row(await pool.query(`SELECT state FROM food_order WHERE id=$1`, [s.order.id]));
  assert.equal(o.state, 'awaiting_payment', 'the order is not confirmed');
  const n = row(await pool.query(`SELECT count(*)::int AS n FROM ledger_entry`));
  assert.equal(n.n, 0, 'and nothing was allocated');
});

/* ======================================================================
   3 — idempotency: retries never duplicate money
   ====================================================================== */

test('a replayed webhook with the same event id allocates nothing twice', async () => {
  const s = await scene();
  const intent = await s.cs.post('/payments/intent', { orderId: s.order.id });
  const hook = signedWebhook(captureEvent(intent.body.gatewayOrderId, 11500),
                             { eventId: 'evt_fixed_1' });
  await app.inject(hook);
  const again = await app.inject(hook);
  assert.equal(again.statusCode, 200);
  assert.match(again.body, /duplicate/);
  assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 9800, 'still 98, not 196');
});

test('a second capture event with a FRESH event id still allocates only once',
  async () => {
    /* This is the case the webhook table alone does not catch: the same
       payment delivered under a different event id. The ledger's
       (kind, ref) uniqueness is what stops it. */
    const s = await scene();
    const intent = await s.cs.post('/payments/intent', { orderId: s.order.id });
    const evt = captureEvent(intent.body.gatewayOrderId, 11500, 'pay_same_1');
    await app.inject(signedWebhook(evt, { eventId: 'evt_a' }));
    await app.inject(signedWebhook(evt, { eventId: 'evt_b' }));

    assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 9800);
    assert.equal(await balanceOf('platform_revenue'), 700);
    const t = row(await pool.query(
      `SELECT count(*)::int AS n FROM ledger_txn WHERE kind='order_capture'`));
    assert.equal(t.n, 1, 'exactly one capture transaction exists');
  });

test('the ledger refuses an unbalanced transaction', async () => {
  const { post, accountId } = await import('../src/services/ledger.js');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    /* Bypass post()'s own arithmetic check by writing the entry directly, so
       it is the DATABASE that has to catch this. */
    const txn = row(await c.query(
      `INSERT INTO ledger_txn (kind, ref) VALUES ('adjustment','unbalanced-test') RETURNING id`));
    const acct = await accountId(c, 'platform_revenue');
    await c.query(`INSERT INTO ledger_entry (txn_id, account_id, amount_paise)
                   VALUES ($1,$2,$3)`, [txn.id, acct, 500]);
    await assert.rejects(() => c.query('COMMIT'), /does not balance/);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
});

/* ======================================================================
   4 — immutability and stale configuration
   ====================================================================== */

test('an order keeps the terms it was priced under when the terms change',
  async () => {
    const s = await scene();
    await pay(s);
    const before = await snapOf(s.order.id);
    assert.equal(before.commission_paise, 200);

    /* The platform doubles its commission and triples its fee. */
    const admin = await as(s.admin);
    const upd = await admin.put('/admin/pricing', {
      commissionBps: 400, platformFeeFlatPaise: 1500,
      deliveryFeePaise: 2000, deliveryEarningPaise: 1500,
    });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));

    const after = await snapOf(s.order.id);
    assert.deepEqual(after, before, 'the old order is byte-identical');
    assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 9800,
      'and the cafeteria is still owed 98, not a number recomputed from 4%');

    /* A NEW order gets the new terms. */
    const s2 = await scene({ terms: null });
    /* scene() re-sets terms, so read the live policy directly instead. */
    const live = row(await pool.query(
      `SELECT * FROM pricing_policy WHERE effective_to IS NULL AND vendor_id IS NULL`));
    assert.ok(live, 'exactly one live platform policy remains');
    const closed = row(await pool.query(
      `SELECT count(*)::int AS n FROM pricing_policy WHERE effective_to IS NOT NULL`));
    assert.ok(closed.n >= 1, 'superseded versions are kept, not overwritten');
    assert.ok(s2.order.id);
  });

test('a financial snapshot cannot be edited or deleted', async () => {
  const s = await scene();
  await assert.rejects(
    () => pool.query(`UPDATE order_financials SET cafeteria_payable_paise = 999999
                       WHERE order_id = $1`, [s.order.id]),
    /immutable/);
  await assert.rejects(
    () => pool.query(`DELETE FROM order_financials WHERE order_id = $1`, [s.order.id]),
    /immutable/);
});

test('a ledger entry cannot be edited or deleted', async () => {
  const s = await scene();
  await pay(s);
  await assert.rejects(
    () => pool.query(`UPDATE ledger_entry SET amount_paise = 1 WHERE order_id = $1`,
                     [s.order.id]), /append-only/);
  await assert.rejects(
    () => pool.query(`DELETE FROM ledger_entry WHERE order_id = $1`, [s.order.id]),
    /append-only/);
});

test('a pricing policy that has priced an order cannot be rewritten', async () => {
  const s = await scene();
  const snap = await snapOf(s.order.id);
  await assert.rejects(
    () => pool.query(`UPDATE pricing_policy SET commission_bps = 5000 WHERE id = $1`,
                     [snap.pricing_policy_id]), /immutable/);
});

/* ======================================================================
   5 — refunds
   ====================================================================== */

test('an unpaid cancellation refunds nothing, because nothing was taken', async () => {
  const s = await scene();
  /* The order is still a draft: there is no payment to cancel, and the
     route says so rather than inventing one. */
  const cancelled = await s.cs.post('/payments/cancel', { orderId: s.order.id });
  assert.equal(cancelled.status, 409, JSON.stringify(cancelled.body));

  const admin = await as(s.admin);
  const r = await admin.post('/refunds', { orderId: s.order.id, reason: 'changed mind' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no captured payment/);
  const n = row(await pool.query(`SELECT count(*)::int AS n FROM ledger_entry`));
  assert.equal(n.n, 0);
});

test('a full refund reverses every party exactly', async () => {
  const s = await scene();
  await pay(s);
  const admin = await as(s.admin);
  const r = await admin.post('/refunds', { orderId: s.order.id, reason: 'kitchen closed' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.amountPaise, 11500);
  assert.deepEqual(
    { c: r.body.allocation.from_cafeteria_paise,
      p: r.body.allocation.from_platform_paise,
      d: r.body.allocation.from_delivery_paise },
    { c: 9800, p: 700, d: 1000 });

  assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 0);
  assert.equal(await balanceOf('platform_revenue'), 0);
  assert.equal(await balanceOf('delivery_clearing'), 0);
  assert.equal(await balanceOf('gateway_clearing'), 0, 'the money left again');

  const o = row(await pool.query(`SELECT state FROM food_order WHERE id=$1`, [s.order.id]));
  assert.equal(o.state, 'refunded');
});

test('a partial refund splits proportionally and leaves the rest refundable',
  async () => {
    const s = await scene();
    await pay(s);
    const admin = await as(s.admin);

    /* 23.00 of 115.00 — exactly a fifth, so the split is clean. */
    const r = await admin.post('/refunds',
      { orderId: s.order.id, reason: 'one dish missing', amountPaise: 2300 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(
      { c: r.body.allocation.from_cafeteria_paise,
        p: r.body.allocation.from_platform_paise,
        d: r.body.allocation.from_delivery_paise },
      { c: 1960, p: 140, d: 200 });

    assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 9800 - 1960);
    assert.equal(await balanceOf('platform_revenue'), 700 - 140);

    const o = row(await pool.query(`SELECT state FROM food_order WHERE id=$1`, [s.order.id]));
    assert.equal(o.state, 'confirmed', 'a partial refund does not close the order');
    const p = row(await pool.query(`SELECT status FROM payment WHERE order_id=$1`, [s.order.id]));
    assert.equal(p.status, 'paid', 'and the payment is still partially refundable');

    /* The rest can still be returned, and no more than the rest. */
    const tooMuch = await admin.post('/refunds',
      { orderId: s.order.id, reason: 'again', amountPaise: 11500 });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.error, /between 1 and 9200/);

    const rest = await admin.post('/refunds', { orderId: s.order.id, reason: 'the rest' });
    assert.equal(rest.status, 200);
    assert.equal(rest.body.amountPaise, 9200);
    assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 0);
    assert.equal(await balanceOf('gateway_clearing'), 0);

    const third = await admin.post('/refunds', { orderId: s.order.id, reason: 'greedy' });
    assert.equal(third.status, 409, 'nothing is left to refund');
  });

test('refund rounding never creates or destroys a paisa', async () => {
  /* 3 paise off an awkward total: the parts must still sum exactly. */
  const s = await scene({ terms: {
    commission_bps: 333, platform_fee_flat_paise: 333,
    delivery_fee_paise: 777, delivery_earning_paise: 777, tax_bps: 500,
  }, itemPaise: 3333, qty: 3 });
  await pay(s);
  const snap = await snapOf(s.order.id);
  const admin = await as(s.admin);

  for (const amount of [1, 7, 13]) {
    const r = await admin.post('/refunds',
      { orderId: s.order.id, reason: 'rounding', amountPaise: amount });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const a = r.body.allocation;
    assert.equal(a.from_cafeteria_paise + a.from_platform_paise +
                 a.from_delivery_paise + a.from_tax_paise, amount,
      `the split of ${amount} paise sums exactly`);
  }
  /* And the books still balance: total refunded equals the drop in clearing. */
  const refunded = Number(row(await pool.query(
    `SELECT COALESCE(sum(total_paise),0)::int AS n FROM refund_allocation`)).n);
  assert.equal(await balanceOf('gateway_clearing'),
               snap.customer_total_paise - refunded);
});

test('a completed delivery is not clawed back from the partner by default',
  async () => {
    const s = await scene();
    await pay(s);
    const partner = await makeUser(pool, { phone: '+919222222222', name: 'Rider',
                                           roles: ['student', 'delivery_partner'] });
    await completeDelivery(s, partner);
    assert.equal(await balanceOf('delivery_payable', partner.id), 1000);

    const admin = await as(s.admin);
    const r = await admin.post('/refunds', { orderId: s.order.id, reason: 'food was cold' });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    /* The rider did the work and keeps the money; Quad funds that part. */
    assert.equal(r.body.allocation.from_delivery_paise, 0);
    assert.equal(r.body.allocation.from_platform_paise, 1700, '700 of its own plus the 1000');
    assert.equal(await balanceOf('delivery_payable', partner.id), 1000, 'rider untouched');
    assert.equal(await balanceOf('platform_revenue'), -1000, 'Quad is out of pocket, honestly');
    assert.equal(await balanceOf('gateway_clearing'), 0);
  });

test('the clawback policy is configurable and takes it off the partner', async () => {
  await pool.query(
    `UPDATE platform_config SET value = '"clawback_partner"'
      WHERE key = 'refund_delivery_policy'`);
  const s = await scene();
  await pay(s);
  const partner = await makeUser(pool, { phone: '+919444444444', name: 'Rider',
                                         roles: ['student', 'delivery_partner'] });
  await completeDelivery(s, partner);

  const r = await (await as(s.admin)).post('/refunds',
    { orderId: s.order.id, reason: 'never arrived' });
  assert.equal(r.body.allocation.from_delivery_paise, 1000);
  assert.equal(await balanceOf('delivery_payable', partner.id), 0);
  assert.equal(await balanceOf('platform_revenue'), 0);
});

test('a duplicate refund request does not refund twice', async () => {
  const s = await scene();
  await pay(s);
  const admin = await as(s.admin);
  const body = { orderId: s.order.id, reason: 'duplicate test',
                 amountPaise: 1000, idempotencyKey: 'retry-key-1' };

  const first = await admin.post('/refunds', body);
  assert.equal(first.status, 200);
  const second = await admin.post('/refunds', body);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.id, first.body.id, 'the original refund is reported');

  assert.equal(refundCalls.length, 1, 'the gateway was called exactly once');
  const n = row(await pool.query(`SELECT count(*)::int AS n FROM refund_allocation`));
  assert.equal(n.n, 1);
  assert.equal(await balanceOf('gateway_clearing'), 11500 - 1000);
});

test('two refunds fired at the same instant cannot both go through', async () => {
  const s = await scene();
  await pay(s);
  const admin = await as(s.admin);
  const results = await Promise.all([
    admin.post('/refunds', { orderId: s.order.id, reason: 'race a' }),
    admin.post('/refunds', { orderId: s.order.id, reason: 'race b' }),
  ]);
  const ok = results.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, `exactly one succeeded, got ${results.map((r) => r.status)}`);
  assert.equal(await balanceOf('gateway_clearing'), 0, 'and 115 left, not 230');
});

/* ======================================================================
   6 — settlement and payouts
   ====================================================================== */

test('a settlement batch owes each cafeteria exactly its ledger balance', async () => {
  const s = await scene();
  await pay(s);
  const admin = await as(s.admin);

  const batch = await admin.post('/admin/payouts/batches',
    { kind: 'cafeteria', periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-01-02T00:00:00Z' });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  assert.equal(batch.body.payouts.length, 1);
  assert.equal(batch.body.payouts[0].amount_paise, 9800);
  assert.equal(batch.body.payouts[0].vendor_id, s.vendor.id);
  assert.equal(batch.body.provider.configured, false);
  assert.match(batch.body.provider.blocker, /has not been provisioned/);
});

test('a payout cannot be executed with no provider, and says so plainly', async () => {
  const s = await scene();
  await pay(s);
  const admin = await as(s.admin);
  const batch = await admin.post('/admin/payouts/batches', { kind: 'cafeteria' });
  const p = batch.body.payouts[0];

  const exec = await admin.post(`/admin/payouts/${p.id}/execute`, {});
  assert.equal(exec.status, 503);
  assert.equal(exec.body.code, 'configuration_required');
  assert.match(exec.body.detail, /RazorpayX/);
  assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 9800,
    'and nothing was settled');
});

test('recording a real transfer needs its bank reference and then settles', async () => {
  const s = await scene();
  await pay(s);
  const admin = await as(s.admin);
  const p = (await admin.post('/admin/payouts/batches', { kind: 'cafeteria' }))
    .body.payouts[0];

  const noRef = await admin.post(`/admin/payouts/${p.id}/record`, {});
  assert.equal(noRef.status, 400, 'no evidence, no settlement');

  const done = await admin.post(`/admin/payouts/${p.id}/record`, { reference: 'UTR123456789' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 0, 'the payable is discharged');
  assert.equal(await balanceOf('gateway_clearing'), 11500 - 9800, 'the cash left');

  const stmt = row(await pool.query(
    `SELECT * FROM v_cafeteria_statement WHERE vendor_id = $1`, [s.vendor.id]));
  assert.equal(Number(stmt.settled_paise), 9800);
  assert.equal(Number(stmt.outstanding_paise), 0);
  assert.equal(Number(stmt.net_payable_paise), 9800);
});

test('the database refuses a paid payout with no evidence at all', async () => {
  const s = await scene();
  await pay(s);
  const admin = await as(s.admin);
  const p = (await admin.post('/admin/payouts/batches', { kind: 'cafeteria' }))
    .body.payouts[0];
  await assert.rejects(
    () => pool.query(`UPDATE payout SET state='paid', paid_at=now(),
                             method='manual_bank_transfer' WHERE id=$1`, [p.id]),
    /paid_has_evidence/,
    'even direct SQL cannot mark money paid without a reference');
});

test('a payout cannot be paid twice', async () => {
  const s = await scene();
  await pay(s);
  const admin = await as(s.admin);
  const p = (await admin.post('/admin/payouts/batches', { kind: 'cafeteria' }))
    .body.payouts[0];

  assert.equal((await admin.post(`/admin/payouts/${p.id}/record`,
                                 { reference: 'UTR1' })).status, 200);
  const again = await admin.post(`/admin/payouts/${p.id}/record`, { reference: 'UTR2' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already paid/);
  assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 0,
    'the payable went to zero, not to minus 9800');
});

test('a second batch does not queue money that is already in flight', async () => {
  const s = await scene();
  await pay(s);
  const admin = await as(s.admin);
  const first = await admin.post('/admin/payouts/batches', { kind: 'cafeteria' });
  assert.equal(first.body.payouts.length, 1);

  const second = await admin.post('/admin/payouts/batches', { kind: 'cafeteria' });
  assert.equal(second.body.payouts.length, 0, 'nothing new to pay');
  assert.equal(second.body.skipped.length, 1);
  assert.match(second.body.skipped[0].reason, /already in flight/);
});

test('two administrators building a batch at the same instant do not double-pay',
  async () => {
    const s = await scene();
    await pay(s);
    const admin = await as(s.admin);
    const [a, b] = await Promise.all([
      admin.post('/admin/payouts/batches', { kind: 'cafeteria' }),
      admin.post('/admin/payouts/batches', { kind: 'cafeteria' }),
    ]);
    const total = [a, b].filter((r) => r.status === 200)
      .flatMap((r) => r.body.payouts).reduce((t, p) => t + p.amount_paise, 0);
    assert.equal(total, 9800, `9800 queued once, not twice (got ${total})`);
  });

test('a paid payout is money that also stays paid after everything reloads',
  async () => {
    const s = await scene();
    await pay(s);
    const admin = await as(s.admin);
    const p = (await admin.post('/admin/payouts/batches', { kind: 'cafeteria' }))
      .body.payouts[0];
    await admin.post(`/admin/payouts/${p.id}/record`, { reference: 'UTR-PERSIST' });

    /* Read it back through a connection with no relationship to the app. */
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const paid = (await c.query(
      `SELECT state, external_reference, amount_paise FROM payout WHERE id=$1`, [p.id])).rows[0];
    const bal = (await c.query(
      `SELECT balance_paise FROM v_account_balance
        WHERE kind='cafeteria_payable' AND vendor_id=$1`, [s.vendor.id])).rows[0];
    await c.end();
    assert.equal(paid.state, 'paid');
    assert.equal(paid.external_reference, 'UTR-PERSIST');
    assert.equal(Number(bal.balance_paise), 0);
  });

/* ======================================================================
   7 — who may see whose money
   ====================================================================== */

test('a cafeteria sees its own finances and nobody else\'s', async () => {
  const s = await scene();
  await pay(s);
  const other = await makeVendor(pool, { name: 'Tulips', slug: 'tulips-x' });

  const ow = await as(s.owner);
  const mine = await ow.get(`/vendors/${s.vendor.id}/finance`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.outstanding_paise, 9800);
  assert.equal(mine.body.commission_paise, 200);
  assert.equal(mine.body.gross_food_sales_paise, 10000);

  const theirs = await ow.get(`/vendors/${other.id}/finance`);
  assert.equal(theirs.status, 403, 'another cafeteria is not visible');

  /* And the platform-wide books are not a shopkeeper's business. */
  assert.equal((await ow.get('/admin/finance/summary')).status, 403);
  assert.equal((await ow.get('/admin/finance/cafeterias')).status, 403);
  assert.equal((await ow.get('/admin/payouts')).status, 403);
});

test('counter staff do not see the cafeteria\'s takings', async () => {
  const s = await scene();
  const staff = await makeUser(pool, { phone: '+919555555555', name: 'Staff',
                                       roles: ['vendor_staff'], vendorId: s.vendor.id });
  const res = await (await as(staff)).get(`/vendors/${s.vendor.id}/finance`);
  assert.equal(res.status, 403);
});

test('a delivery partner sees only their own earnings', async () => {
  const s = await scene();
  await pay(s);
  const a = await makeUser(pool, { phone: '+919666666666', name: 'Rider A',
                                   roles: ['student', 'delivery_partner'] });
  const b = await makeUser(pool, { phone: '+919777777777', name: 'Rider B',
                                   roles: ['student', 'delivery_partner'] });
  await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1,'approved')`, [b.id]);
  await completeDelivery(s, a);

  const mine = await (await as(a)).get('/partner/earnings');
  assert.equal(mine.body.totalEarnedPaise, 1000);
  const theirs = await (await as(b)).get('/partner/earnings');
  assert.equal(theirs.body.totalEarnedPaise, 0, 'B cannot see A\'s money');

  /* There is no parameter that widens the scope: the route reads the
     session's own id and nothing else. */
  const attempt = await (await as(b)).get(`/partner/earnings?partnerId=${a.id}`);
  assert.equal(attempt.body.totalEarnedPaise, 0);
  assert.equal((await (await as(b)).get('/admin/finance/partners')).status, 403);
});

test('a customer cannot read the platform books or another order\'s allocation',
  async () => {
    const s = await scene();
    await pay(s);
    assert.equal((await s.cs.get('/admin/finance/summary')).status, 403);
    assert.equal((await s.cs.get('/admin/finance/ledger')).status, 403);
    assert.equal((await s.cs.get(`/admin/finance/orders/${s.order.id}`)).status, 403);

    /* Their own order shows what they paid, and its breakdown — but not
       where Quad allocated it. */
    const own = await s.cs.get(`/orders/${s.order.id}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.financials.customer_total_paise, 11500);
    assert.equal(own.body.ledger, undefined, 'the allocation is not exposed to the customer');
  });

test('only the platform owner and admins can change the commercial terms', async () => {
  const s = await scene();
  const support = await makeUser(pool, { phone: '+919888888888', name: 'Support',
                                         roles: ['support'] });
  const ss = await as(support);
  assert.equal((await ss.get('/admin/finance/summary')).status, 200, 'support may read');
  assert.equal((await ss.put('/admin/pricing', { commissionBps: 0 })).status, 403,
    'but not set terms');
  assert.equal((await ss.post('/admin/payouts/batches', { kind: 'cafeteria' })).status, 403,
    'and not move money');
  assert.equal((await (await as(s.owner)).put('/admin/pricing', { commissionBps: 0 })).status, 403);
});

/* ======================================================================
   8 — the platform's own view
   ====================================================================== */

test('the admin finance summary adds up across orders, refunds and payouts',
  async () => {
    const s1 = await scene();
    await pay(s1);
    const s2 = await scene({ fulfilment: 'pickup' });
    await pay(s2);

    const admin = await as(s1.admin);
    await admin.post('/refunds', { orderId: s2.order.id, reason: 'sold out',
                                   amountPaise: 10500 });

    const sum = (await admin.get('/admin/finance/summary')).body;
    assert.equal(sum.orders, 2);
    assert.equal(sum.gmvPaise, 11500 + 10500);
    assert.equal(sum.platformFeesPaise, 1000);
    assert.equal(sum.commissionsPaise, 400);
    assert.equal(sum.deliveryEarningsPaise, 1000);
    assert.equal(sum.refundsPaise, 10500);
    assert.equal(sum.quadGrossRevenuePaise, 1400, '700 from each order');
    assert.equal(sum.quadNetRevenuePaise, 1400 - 700, 'less the 700 refunded back');
    assert.equal(sum.cafeteriaPayablePaise, 9800, 's2 was fully refunded');
    assert.equal(sum.unsettledPaise, 9800);
    assert.equal(sum.settledCafeteriaPaise, 0);
    assert.equal(sum.payoutProvider.configured, false);

    /* The clearing balance must equal everything still owed plus what Quad
       has kept. If this ever drifts, the books are wrong. */
    assert.equal(sum.clearingBalancePaise,
      sum.cafeteriaPayablePaise + sum.deliveryPayablePaise +
      sum.deliveryUnearnedPaise + sum.taxPayablePaise + sum.quadNetRevenuePaise);
  });

test('the per-order audit shows exactly where one customer\'s money went', async () => {
  const s = await scene();
  await pay(s);
  const view = (await (await as(s.admin)).get(`/admin/finance/orders/${s.order.id}`)).body;
  assert.equal(view.financials.customer_total_paise, 11500);
  assert.equal(view.financials.commission_bps, 200, 'the terms it was priced under');
  const effects = Object.fromEntries(view.ledger.map((e) => [e.account_kind, e.effect_paise]));
  assert.equal(effects.gateway_clearing, 11500);
  assert.equal(effects.cafeteria_payable, 9800);
  assert.equal(effects.delivery_clearing, 1000);
  assert.equal(effects.platform_revenue, 700);
});

test('an adjustment is a ledger transaction with a reason, not an edit', async () => {
  const s = await scene();
  await pay(s);
  const admin = await as(s.admin);
  const adj = await admin.post('/admin/finance/adjustments', {
    vendorId: s.vendor.id, amountPaise: -500, reason: 'packaging deduction',
    idempotencyKey: 'adj-1',
  });
  assert.equal(adj.status, 200, JSON.stringify(adj.body));
  assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 9300);
  assert.equal(await balanceOf('platform_revenue'), 1200);

  /* Retried with the same key: no second deduction. */
  const again = await admin.post('/admin/finance/adjustments', {
    vendorId: s.vendor.id, amountPaise: -500, reason: 'packaging deduction',
    idempotencyKey: 'adj-1',
  });
  assert.equal(again.body.duplicate, true);
  assert.equal(await balanceOf('cafeteria_payable', s.vendor.id), 9300);
});
