/* ==========================================================================
   HANDOVER CODES — pickup and delivery verification

   Two physical handovers, two secrets, neither of them held by the delivery
   partner. What is proven here is not that the happy path works — the e2e
   flow already does that — but that every way around it is closed:

     * a partner cannot reach picked_up or delivered without a code
     * a partner cannot READ either code, including through the generic
       transition endpoint or by asking for the other party's route
     * a cafeteria cannot complete a delivery it is not physically making
     * a wrong code costs an attempt, and the attempts run out
     * a correct code works exactly once
     * an expired code is refused
     * one partner cannot act on another partner's order

   Everything runs against the real migrations, the real Fastify stack and
   the real triggers on order_handover_code.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus, setTerms }
  from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const WEBHOOK_SECRET = 'whsec_test_' + 'h'.repeat(24);

let app, pool, stub, stubUrl, campus;

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
  campus = await makeCampus(pool);
});

const as = async (u) => client(app, await sessionFor(pool, u.id));
const rnd = () => String(Math.floor(Math.random() * 90000) + 10000);

/* ---------- a delivery order sitting at `assigned` ------------------------
   Payment goes through the real webhook so the order is genuinely confirmed
   and genuinely allocated; the partner assignment is written directly
   because the offer/accept race is delivery.js's business, not this file's. */
async function assignedOrder() {
  const vendor = await makeVendor(pool, { name: 'Frisco', slug: 'frisco-' + Math.random() });
  const item = await makeItem(pool, vendor.id, { name: 'Thali', paise: 10000 });
  const customer = await makeUser(pool, { phone: '+9190100' + rnd(), name: 'Customer' });
  const owner = await makeUser(pool, { phone: '+9190101' + rnd(), name: 'Owner',
                                       roles: ['vendor_owner'], vendorId: vendor.id });
  const partner = await makeUser(pool, { phone: '+9190102' + rnd(), name: 'Partner',
                                         roles: ['delivery_partner'], studentStatus: 'approved' });

  await setTerms(pool, {
    commission_bps: 200, commission_mode: 'deduct_from_cafeteria',
    platform_fee_flat_paise: 500, delivery_fee_paise: 1000, delivery_earning_paise: 1000,
  });

  const cs = await as(customer);
  const draft = await cs.post('/orders/draft', {
    vendorId: vendor.id, lines: [{ itemId: item.id, qty: 1 }],
    fulfilment: 'delivery', destinationId: campus.blockB.id });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));

  const intent = await cs.post('/payments/intent', { orderId: draft.body.id });
  assert.equal(intent.status, 200, JSON.stringify(intent.body));
  const raw = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_' + Math.random(),
      order_id: intent.body.gatewayOrderId, amount: intent.body.amountPaise,
      status: 'captured' } } } });
  const res = await app.inject({ method: 'POST', url: '/payments/webhook', payload: raw,
    headers: { 'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
      'x-razorpay-event-id': 'evt_' + Math.random() } });
  assert.equal(res.statusCode, 200);

  const ow = await as(owner);
  await ow.post(`/orders/${draft.body.id}/transition`, { to: 'preparing' });
  await ow.post(`/orders/${draft.body.id}/transition`, { to: 'ready' });
  await pool.query(`UPDATE food_order SET state='assigned', partner_id=$2 WHERE id=$1`,
                   [draft.body.id, partner.id]);

  return { id: draft.body.id, vendor, customer, owner, partner,
           cs, ow, ps: await as(partner) };
}

/* platform_config is emptied by truncateAll, so the service falls back to its
   own default. Read it the same way it does rather than assuming a row. */
async function maxAttempts() {
  const r = await pool.query(
    `SELECT value FROM platform_config WHERE key='handover_max_attempts'`);
  const n = Number(r.rows[0]?.value);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

const stateOf = async (id) =>
  (await pool.query(`SELECT state FROM food_order WHERE id=$1`, [id])).rows[0].state;

/* ==========================================================================
   PICKUP — the cafeteria's code
   ========================================================================== */

test('a partner cannot reach picked_up without the cafeteria pickup code', async () => {
  const o = await assignedOrder();

  /* The generic state endpoint is the obvious way round, and it is closed. */
  const viaTransition = await o.ps.post(`/orders/${o.id}/transition`, { to: 'picked_up' });
  assert.equal(viaTransition.status, 403);
  assert.match(viaTransition.body.error, /pickup code/i);

  /* And so is the pickup route itself, with nothing issued. */
  const noCode = await o.ps.post(`/orders/${o.id}/pickup`, { code: '123456' });
  assert.equal(noCode.status, 409);
  assert.equal(await stateOf(o.id), 'assigned');
});

test('the delivery partner cannot read the pickup code they must be told', async () => {
  const o = await assignedOrder();
  assert.equal((await o.ps.get(`/orders/${o.id}/pickup-code`)).status, 403);
  /* Nor can the customer: it is the cafeteria's secret, not theirs. */
  assert.equal((await o.cs.get(`/orders/${o.id}/pickup-code`)).status, 403);
});

test('a pickup code is six digits, single-use, and moves the order exactly once', async () => {
  const o = await assignedOrder();
  const issued = await o.ow.get(`/orders/${o.id}/pickup-code`);
  assert.equal(issued.status, 200);
  assert.match(issued.body.code, /^\d{6}$/);

  const ok = await o.ps.post(`/orders/${o.id}/pickup`, { code: issued.body.code });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await stateOf(o.id), 'picked_up');

  /* Replaying the same code cannot collect the order a second time. */
  const replay = await o.ps.post(`/orders/${o.id}/pickup`, { code: issued.body.code });
  assert.equal(replay.status, 409);

  /* The row records who consumed it, which is what makes it evidence. */
  const row = (await pool.query(
    `SELECT consumed_at, consumed_by FROM order_handover_code
      WHERE order_id=$1 AND kind='pickup'`, [o.id])).rows[0];
  assert.ok(row.consumed_at);
  assert.equal(row.consumed_by, o.partner.id);
});

test('wrong pickup codes burn attempts and then lock the code out', async () => {
  const o = await assignedOrder();
  const issued = await o.ow.get(`/orders/${o.id}/pickup-code`);
  const right = issued.body.code;
  /* Never collide with the real code while probing. */
  const wrong = right === '000000' ? '111111' : '000000';

  const max = await maxAttempts();

  for (let i = 1; i < max; i++) {
    const r = await o.ps.post(`/orders/${o.id}/pickup`, { code: wrong });
    assert.equal(r.status, 400, `attempt ${i} should be a plain rejection`);
  }
  /* The last one exhausts the ceiling and kills the code. */
  const last = await o.ps.post(`/orders/${o.id}/pickup`, { code: wrong });
  assert.equal(last.status, 429);

  /* Now even the CORRECT code is dead — the ceiling is not a speed bump. */
  const tooLate = await o.ps.post(`/orders/${o.id}/pickup`, { code: right });
  assert.equal(tooLate.status, 409);
  assert.equal(await stateOf(o.id), 'assigned');
});

test('an expired pickup code cannot collect an order', async () => {
  const o = await assignedOrder();
  /* expires_at is immutable once issued — the trigger sees to that — so the
     lifetime is configured down instead, which also exercises the fact that
     it IS configurable. */
  await pool.query(
    `INSERT INTO platform_config (key, value) VALUES ('handover_pickup_ttl_seconds','1')
     ON CONFLICT (key) DO UPDATE SET value = '1'`);
  const issued = await o.ow.get(`/orders/${o.id}/pickup-code`);
  await new Promise((r) => setTimeout(r, 1200));

  const r = await o.ps.post(`/orders/${o.id}/pickup`, { code: issued.body.code });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /expired/i);
  assert.equal(await stateOf(o.id), 'assigned');
});

test('re-issuing rotates the code: the previous one stops working', async () => {
  const o = await assignedOrder();
  const first = (await o.ow.get(`/orders/${o.id}/pickup-code`)).body.code;
  const second = (await o.ow.get(`/orders/${o.id}/pickup-code`)).body.code;
  assert.notEqual(first, second, 'a re-issue mints a new secret');

  /* The retired code is not "used", it is simply wrong against the live one. */
  assert.equal((await o.ps.post(`/orders/${o.id}/pickup`, { code: first })).status, 400);
  assert.equal((await o.ps.post(`/orders/${o.id}/pickup`, { code: second })).status, 200);
});

test('one partner cannot collect another partner\'s order', async () => {
  const o = await assignedOrder();
  const issued = await o.ow.get(`/orders/${o.id}/pickup-code`);

  const other = await makeUser(pool, { phone: '+9190103' + rnd(), name: 'Other',
                                       roles: ['delivery_partner'], studentStatus: 'approved' });
  const os = await as(other);
  /* Even holding the correct code, the scope check refuses: this order is
     not assigned to them. */
  const r = await os.post(`/orders/${o.id}/pickup`, { code: issued.body.code });
  assert.equal(r.status, 403);
  assert.equal(await stateOf(o.id), 'assigned');
});

/* ==========================================================================
   DELIVERY — the customer's code
   ========================================================================== */

async function pickedUpOrder() {
  const o = await assignedOrder();
  const code = (await o.ow.get(`/orders/${o.id}/pickup-code`)).body.code;
  assert.equal((await o.ps.post(`/orders/${o.id}/pickup`, { code })).status, 200);
  return o;
}

test('a partner cannot reach delivered without the customer code', async () => {
  const o = await pickedUpOrder();

  const viaTransition = await o.ps.post(`/orders/${o.id}/transition`, { to: 'delivered' });
  assert.ok([400, 403].includes(viaTransition.status), 'no self-certified delivery');

  const noCode = await o.ps.post(`/orders/${o.id}/handoff`, { code: '123456' });
  assert.equal(noCode.status, 409);
  assert.equal(await stateOf(o.id), 'picked_up');
});

test('the cafeteria cannot mark a delivery order delivered', async () => {
  const o = await pickedUpOrder();
  /* This was a real hole: a cafeteria holds order.transition over its own
     orders, and the state machine allows picked_up to delivered. It could
     therefore complete a delivery — and post the partner's earning — while
     the food was still in the partner's bag. */
  const r = await o.ow.post(`/orders/${o.id}/transition`,
    { to: 'delivered', note: 'the cafeteria says it arrived' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /customer's code/i);
  assert.equal(await stateOf(o.id), 'picked_up');
});

test('the delivery partner cannot read the customer\'s delivery code', async () => {
  const o = await pickedUpOrder();
  assert.equal((await o.ps.get(`/orders/${o.id}/handoff-code`)).status, 403);
});

test('the customer code delivers the order and earns the partner their money', async () => {
  const o = await pickedUpOrder();

  const before = (await pool.query(
    `SELECT COALESCE(sum(balance_paise),0)::int AS b FROM v_account_balance
      WHERE kind='delivery_payable' AND partner_id=$1`, [o.partner.id])).rows[0].b;
  assert.equal(before, 0);

  const code = (await o.cs.get(`/orders/${o.id}/handoff-code`)).body.code;
  const ok = await o.ps.post(`/orders/${o.id}/handoff`, { code });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await stateOf(o.id), 'delivered');

  const after = (await pool.query(
    `SELECT COALESCE(sum(balance_paise),0)::int AS b FROM v_account_balance
      WHERE kind='delivery_payable' AND partner_id=$1`, [o.partner.id])).rows[0].b;
  assert.equal(after, 1000, 'the earning is posted in the same transaction');

  /* Replay: neither the state nor the balance moves again. */
  assert.equal((await o.ps.post(`/orders/${o.id}/handoff`, { code })).status, 409);
  const still = (await pool.query(
    `SELECT COALESCE(sum(balance_paise),0)::int AS b FROM v_account_balance
      WHERE kind='delivery_payable' AND partner_id=$1`, [o.partner.id])).rows[0].b;
  assert.equal(still, 1000, 'a replayed handoff pays nobody twice');
});

test('wrong delivery codes lock out, and a failed handoff earns nothing', async () => {
  const o = await pickedUpOrder();
  const right = (await o.cs.get(`/orders/${o.id}/handoff-code`)).body.code;
  const wrong = right === '000000' ? '111111' : '000000';
  const max = await maxAttempts();

  for (let i = 1; i < max; i++) {
    assert.equal((await o.ps.post(`/orders/${o.id}/handoff`, { code: wrong })).status, 400);
  }
  assert.equal((await o.ps.post(`/orders/${o.id}/handoff`, { code: wrong })).status, 429);
  assert.equal(await stateOf(o.id), 'picked_up');

  const bal = (await pool.query(
    `SELECT COALESCE(sum(balance_paise),0)::int AS b FROM v_account_balance
      WHERE kind='delivery_payable' AND partner_id=$1`, [o.partner.id])).rows[0].b;
  assert.equal(bal, 0, 'a partner who never proved delivery is owed nothing');
});

test('an unresolved delivery stays open until platform staff resolve it', async () => {
  const o = await pickedUpOrder();

  /* The customer cannot produce a code. Nobody on the delivery side can
     force it through. */
  assert.ok([400, 403].includes(
    (await o.ps.post(`/orders/${o.id}/transition`,
      { to: 'delivered', note: 'customer phone was dead' })).status));
  assert.equal(await stateOf(o.id), 'picked_up');

  const admin = await makeUser(pool, { phone: '+9190104' + rnd(), name: 'Admin',
                                       roles: ['platform_owner'] });
  const ad = await as(admin);

  /* Even for staff, no reason means no override. */
  assert.equal((await ad.post(`/orders/${o.id}/transition`, { to: 'delivered' })).status, 400);
  assert.equal(await stateOf(o.id), 'picked_up');

  const forced = await ad.post(`/orders/${o.id}/transition`,
    { to: 'delivered', note: 'Customer confirmed receipt by phone to support.' });
  assert.equal(forced.status, 200);
  assert.equal(await stateOf(o.id), 'delivered');

  /* It is recorded as an override, with the reason, not as a normal delivery. */
  const log = (await pool.query(
    `SELECT detail FROM audit_log WHERE resource_id=$1 AND action='delivery.force_complete'`,
    [o.id])).rows;
  assert.equal(log.length, 1);
  assert.match(JSON.stringify(log[0].detail), /confirmed receipt by phone/i);
});

/* ==========================================================================
   THE CODES THEMSELVES
   ========================================================================== */

test('codes are never stored in the clear', async () => {
  const o = await assignedOrder();
  const issued = await o.ow.get(`/orders/${o.id}/pickup-code`);
  const row = (await pool.query(
    `SELECT * FROM order_handover_code WHERE order_id=$1`, [o.id])).rows[0];

  assert.notEqual(row.code_hash, issued.body.code);
  assert.equal(row.code_hash.length, 64, 'sha-256 hex');
  assert.ok(row.salt && row.salt.length >= 16, 'per-row salt');
  assert.ok(!JSON.stringify(row).includes(issued.body.code),
    'the plaintext appears nowhere in the row');
});

test('the attempt counter cannot be wound back, and codes cannot be rewritten', async () => {
  const o = await assignedOrder();
  const issued = await o.ow.get(`/orders/${o.id}/pickup-code`);
  const wrong = issued.body.code === '000000' ? '111111' : '000000';
  assert.equal((await o.ps.post(`/orders/${o.id}/pickup`, { code: wrong })).status, 400);
  assert.equal((await pool.query(
    `SELECT attempts FROM order_handover_code WHERE order_id=$1`, [o.id])).rows[0].attempts, 1);

  await assert.rejects(
    () => pool.query(`UPDATE order_handover_code SET attempts = 0 WHERE order_id = $1`, [o.id]),
    /wound back/);
  await assert.rejects(
    () => pool.query(`UPDATE order_handover_code SET code_hash = 'x' WHERE order_id = $1`, [o.id]),
    /cannot be rewritten/);
  await assert.rejects(
    () => pool.query(`DELETE FROM order_handover_code WHERE order_id = $1`, [o.id]),
    /not deleted/);
});

test('two live codes for the same handover cannot exist', async () => {
  const o = await assignedOrder();
  await o.ow.get(`/orders/${o.id}/pickup-code`);
  await assert.rejects(
    () => pool.query(
      `INSERT INTO order_handover_code (order_id, kind, code_hash, salt, max_attempts, expires_at)
       VALUES ($1,'pickup','deadbeef','salt',5, now() + interval '10 minutes')`, [o.id]),
    /one_live_handover_code|duplicate key/);
});

test('a collection order has no handover codes at all', async () => {
  const vendor = await makeVendor(pool, { name: 'Frisco', slug: 'frisco-' + Math.random() });
  const item = await makeItem(pool, vendor.id, { name: 'Thali', paise: 10000 });
  const customer = await makeUser(pool, { phone: '+9190105' + rnd(), name: 'Customer' });
  const owner = await makeUser(pool, { phone: '+9190106' + rnd(), name: 'Owner',
                                       roles: ['vendor_owner'], vendorId: vendor.id });
  await setTerms(pool, { commission_bps: 200, platform_fee_flat_paise: 500 });

  const cs = await as(customer);
  const draft = await cs.post('/orders/draft', {
    vendorId: vendor.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'pickup' });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));

  const ow = await as(owner);
  /* A collection order has no delivery leg to protect. */
  const r = await ow.get(`/orders/${draft.body.id}/pickup-code`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /collection order/i);
});
