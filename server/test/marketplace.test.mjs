/* ==========================================================================
   MARKETPLACE MONEY — collection, allocation, partner wallet, withdrawals,
   café settlement accounts, refunds, cancellation, incidents.

   The whole path runs through the real Fastify stack and real PostgreSQL.
   Cashfree (PG and Payouts) is a local server speaking Cashfree's wire
   format; the real adapters make real HTTP requests to it. This proves our
   side of every exchange. It does NOT prove Cashfree accepts our requests —
   only the owner's sandbox credentials can, and that is reported separately
   (docs/CASHFREE-MARKETPLACE.md).

   The worked example, from the business rules:
     food 100 + delivery 5 + platform fee 10 = 115 charged
     café 100 · platform fee 10 · partner earning 10 (configured)
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus, setTerms,
         makeVerifiedDestination } from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const PG_SECRET = 'cfsk_test_pg_secret_not_real_' + 'q'.repeat(12);
const PO_SECRET = 'cfsk_test_payout_secret_not_real_' + 'w'.repeat(8);
const ACCOUNT = '123456789012';

let app, pool, stub, stubUrl, campus;
const calls = [];
const transfers = new Map();                  // transfer_id -> status
let transferMode = 'SUCCESS';                 // SUCCESS | RECEIVED | reject400 | error500
let beneficiaryStatus = 'VERIFIED';
let refundStatus = 'SUCCESS';

function startStub() {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const b = body ? JSON.parse(body) : null;
        calls.push({ method: req.method, url: req.url, body: b });
        const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.method === 'POST' && req.url === '/pg/orders') {
          return json(200, { order_id: b.order_id, order_amount: b.order_amount, order_currency: 'INR',
                             order_status: 'ACTIVE', payment_session_id: 'session_' + b.order_id });
        }
        if (req.method === 'POST' && /^\/pg\/orders\/[^/]+\/refunds$/.test(req.url)) {
          return json(200, { cf_refund_id: 'cfr_' + b.refund_id, refund_id: b.refund_id,
                             refund_amount: b.refund_amount, refund_status: refundStatus });
        }
        if (req.method === 'POST' && req.url === '/pg/settlement/recon') {
          return json(200, { cursor: null, data: reconLines });
        }
        if (req.method === 'POST' && req.url === '/payout/beneficiary') {
          return json(200, { beneficiary_id: b.beneficiary_id, beneficiary_status: beneficiaryStatus });
        }
        if (req.method === 'POST' && req.url === '/payout/transfers') {
          if (transfers.has(b.transfer_id)) return json(409, { code: 'transfer_id_already_exists' });
          if (transferMode === 'reject400') return json(400, { code: 'beneficiary_blacklisted' });
          if (transferMode === 'error500') { transfers.set(b.transfer_id, 'SUCCESS'); return json(502, { code: 'upstream' }); }
          transfers.set(b.transfer_id, transferMode);
          return json(200, { transfer_id: b.transfer_id, cf_transfer_id: 'cft_' + b.transfer_id.slice(0, 8),
                             status: transferMode, transfer_utr: transferMode === 'SUCCESS' ? 'UTR' + b.transfer_id.slice(0, 6) : null });
        }
        const m = /^\/payout\/transfers\?transfer_id=(.+)$/.exec(req.url);
        if (m && req.method === 'GET') {
          const id = decodeURIComponent(m[1]);
          if (!transfers.has(id)) return json(404, { code: 'transfer_not_found' });
          return json(200, { transfer_id: id, cf_transfer_id: 'cft_' + id.slice(0, 8), status: transfers.get(id),
                             transfer_utr: 'UTRSYNC' + id.slice(0, 4) });
        }
        json(404, {});
      });
    });
    stub.listen(0, '127.0.0.1', () => { stubUrl = `http://127.0.0.1:${stub.address().port}`; resolve(); });
  });
}
let reconLines = [];

before(async () => {
  await startDb();
  await startStub();
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000', COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    WEB_ORIGIN: 'http://localhost:3000', SWEEPER: 'off', NODE_ENV: 'test',
    PAYMENT_PROVIDER: 'cashfree', CASHFREE_PG_APP_ID: 'TEST_APP', CASHFREE_PG_SECRET_KEY: PG_SECRET,
    CASHFREE_PG_BASE_URL: stubUrl,
    PAYOUT_PROVIDER: 'cashfree', CASHFREE_PAYOUT_CLIENT_ID: 'TEST_PAYOUT', CASHFREE_PAYOUT_CLIENT_SECRET: PO_SECRET,
    CASHFREE_PAYOUT_BASE_URL: stubUrl,
  });
  ({ pool } = await import('../src/db/index.js'));
  const { build } = await import('../src/index.js');
  app = await build();
});

after(async () => {
  await app?.close(); await pool?.end();
  await new Promise((r) => stub.close(r));
  await stopDb();
  for (const k of ['PAYMENT_PROVIDER', 'CASHFREE_PG_APP_ID', 'CASHFREE_PG_SECRET_KEY', 'CASHFREE_PG_BASE_URL',
                   'PAYOUT_PROVIDER', 'CASHFREE_PAYOUT_CLIENT_ID', 'CASHFREE_PAYOUT_CLIENT_SECRET',
                   'CASHFREE_PAYOUT_BASE_URL']) delete process.env[k];
});

beforeEach(async () => {
  await truncateAll(pool);
  campus = await makeCampus(pool);
  calls.length = 0; transfers.clear(); reconLines = [];
  transferMode = 'SUCCESS'; beneficiaryStatus = 'VERIFIED'; refundStatus = 'SUCCESS';
});

const as = async (u, opts) => client(app, await sessionFor(pool, u.id, opts));
let seq = 0;
const phone = () => '+9197' + String(10000000 + (++seq) * 7919 % 89999999).padStart(8, '0');

function signed(url, payload, secret, key) {
  const raw = JSON.stringify(payload); const ts = String(Math.floor(Date.now() / 1000));
  return { method: 'POST', url, payload: raw, headers: {
    'content-type': 'application/json', 'x-webhook-timestamp': ts,
    'x-webhook-signature': createHmac('sha256', secret).update(ts + raw).digest('base64'),
    ...(key ? { 'x-idempotency-key': key } : {}) } };
}
const paidEvent = (orderId, amount, cf = 777) => ({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: {
  order: { order_id: orderId, order_amount: amount, order_currency: 'INR' },
  payment: { cf_payment_id: cf, payment_status: 'SUCCESS', payment_amount: amount, payment_currency: 'INR' } } });

async function setPayoutConfig(patch) {
  await pool.query(
    `INSERT INTO platform_config (key, value) VALUES ('partner_payout_config', $1)
     ON CONFLICT (key) DO UPDATE SET value = platform_config.value || EXCLUDED.value`, [JSON.stringify(patch)]);
}
const owner = () => makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['platform_owner'] });

/* One paid order through the real intent + signed webhook. */
async function paidOrder({ vendor, food = 10000, key } = {}) {
  vendor ||= await makeVendor(pool, { name: 'Chai Garam', slug: 'cg-' + (++seq) });
  const item = await makeItem(pool, vendor.id, { name: 'Thali ' + seq, paise: food });
  const customer = await makeUser(pool, { phone: phone(), name: 'Asha' });
  const cs = await as(customer);
  const draft = await cs.post('/orders/draft', { vendorId: vendor.id, lines: [{ itemId: item.id, qty: 1 }],
                                                 fulfilment: 'delivery', destinationId: campus.blockB.id });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const intent = await cs.post('/payments/intent', { orderId: draft.body.id });
  assert.equal(intent.status, 200, JSON.stringify(intent.body));
  const amount = (intent.body.amountPaise / 100).toFixed(2);
  const r = await app.inject(signed('/payments/webhook', paidEvent(intent.body.paymentId, amount, 1000 + seq),
                                    PG_SECRET, key || 'evt_' + seq));
  assert.equal(r.statusCode, 200, r.body);
  return { vendor, customer, cs, orderId: draft.body.id, intent: intent.body };
}

async function deliver(orderId, partner, cs) {
  await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1,'approved') ON CONFLICT (user_id) DO NOTHING`, [partner.id]);
  await pool.query(`UPDATE food_order SET state='picked_up', partner_id=$2 WHERE id=$1`, [orderId, partner.id]);
  const code = await cs.get(`/orders/${orderId}/handoff-code`);
  const done = await (await as(partner)).post(`/orders/${orderId}/handoff`, { code: code.body.code });
  assert.equal(done.status, 200, JSON.stringify(done.body));
}
const newPartner = () => makeUser(pool, { phone: phone(), name: 'Ravi', roles: ['delivery_partner'] });
const bal = async (kind, where = '') => Number((await pool.query(
  `SELECT COALESCE(sum(balance_paise),0)::bigint n FROM v_account_balance WHERE kind=$1 ${where}`, [kind])).rows[0].n);

const TERMS_115 = { platform_fee_flat_paise: 1000, delivery_fee_paise: 500, delivery_earning_paise: 1000 };

/* ======================= collection and allocation ====================== */

test('₹100 food + ₹5 delivery + ₹10 platform fee charges exactly ₹115, UPI and cards only', async () => {
  await setTerms(pool, TERMS_115);
  const { orderId, intent } = await paidOrder();
  assert.equal(intent.amountPaise, 11500);
  assert.deepEqual({ food: intent.breakdown.foodPaise, delivery: intent.breakdown.deliveryPaise,
                     platform: intent.breakdown.platformFeePaise }, { food: 10000, delivery: 500, platform: 1000 });
  const create = calls.find((c) => c.url === '/pg/orders');
  assert.equal(create.body.order_amount, '115.00');
  assert.equal(create.body.order_meta.payment_methods, 'cc,dc,upi');
  assert.equal(create.body.order_splits, undefined, 'no Easy Split unless Cashfree activated it');
  const o = (await pool.query(`SELECT state FROM food_order WHERE id=$1`, [orderId])).rows[0];
  assert.equal(o.state, 'confirmed');
});

test('allocation: café ₹100, platform fee ₹10 tracked separately, partner earning ₹10, gateway fee unknown until settlement', async () => {
  await setTerms(pool, TERMS_115);
  const { orderId, vendor } = await paidOrder();
  const f = (await pool.query(`SELECT * FROM order_financials WHERE order_id=$1`, [orderId])).rows[0];
  assert.equal(f.cafeteria_payable_paise, 10000);
  assert.equal(f.platform_fee_paise, 1000);
  assert.equal(f.delivery_earning_paise, 1000);
  /* 10 fee + 5 delivery charged − 10 paid to the partner = 5 net to the platform. */
  assert.equal(f.platform_gross_paise, 500);
  assert.equal(f.gateway_fee_paise, 0);
  assert.equal(await bal('cafeteria_payable', `AND vendor_id='${vendor.id}'`), 10000);
  assert.equal(await bal('delivery_clearing'), 1000, 'not earned until delivered');
  assert.equal(await bal('platform_revenue'), 500);
});

test('gateway fee is reconciled separately from the settlement report, never from the café', async () => {
  await setTerms(pool, TERMS_115);
  const { orderId, intent } = await paidOrder();
  const pay = (await pool.query(`SELECT * FROM payment WHERE order_id=$1`, [orderId])).rows[0];
  reconLines = [{ cf_payment_id: Number(pay.provider_payment_id), order_id: intent.paymentId, cf_settlement_id: 501,
                  transfer_utr: 'UTRSET1', event_type: 'PAYMENT', payment_amount: '115.00',
                  service_charge: '2.00', service_tax: '0.36', settlement_amount: '112.64' }];
  const { importSettlements } = await import('../src/services/reconciliation.js');
  const run = await importSettlements({ provider: 'cashfree', from: new Date(Date.now() - 86400000), to: new Date() });
  assert.equal(run.state, 'completed', JSON.stringify(run));
  const f = (await pool.query(`SELECT * FROM order_financials WHERE order_id=$1`, [orderId])).rows[0];
  assert.equal(f.gateway_fee_paise, 236);
  assert.equal(f.cafeteria_payable_paise, 10000, 'the café still receives its full ₹100');
});

test('duplicate webhook (same event, or same payment under a new event id) never allocates twice', async () => {
  await setTerms(pool, TERMS_115);
  const { orderId, intent } = await paidOrder({ key: 'evt_fixed' });
  const again = await app.inject(signed('/payments/webhook', paidEvent(intent.paymentId, '115.00', 1000 + seq), PG_SECRET, 'evt_fixed'));
  assert.equal(JSON.parse(again.body).duplicate, true);
  const other = await app.inject(signed('/payments/webhook', paidEvent(intent.paymentId, '115.00', 1000 + seq), PG_SECRET, 'evt_other'));
  assert.equal(other.statusCode, 200);
  const n = (await pool.query(`SELECT count(*)::int n FROM ledger_txn WHERE order_id=$1 AND kind='order_capture'`, [orderId])).rows[0].n;
  assert.equal(n, 1);
  const dup = (await pool.query(`SELECT duplicate_count FROM payment_webhook WHERE event_id='evt_fixed'`)).rows[0];
  assert.equal(dup.duplicate_count, 1, 'duplicates are counted for reconciliation');
  assert.equal(await bal('platform_revenue'), 500);
});

test('an unsigned or forged webhook confirms nothing', async () => {
  await setTerms(pool, TERMS_115);
  const vendor = await makeVendor(pool, { name: 'V', slug: 'v-forge' });
  const item = await makeItem(pool, vendor.id, { name: 'X', paise: 10000 });
  const cs = await as(await makeUser(pool, { phone: phone(), name: 'Asha' }));
  const d = await cs.post('/orders/draft', { vendorId: vendor.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'delivery', destinationId: campus.blockB.id });
  const i = await cs.post('/payments/intent', { orderId: d.body.id });
  const r = await app.inject(signed('/payments/webhook', paidEvent(i.body.paymentId, '115.00'), 'wrong-secret', 'k1'));
  assert.equal(r.statusCode, 400);
  assert.equal((await pool.query(`SELECT state FROM food_order WHERE id=$1`, [d.body.id])).rows[0].state, 'awaiting_payment');
});

/* ======================= partner earnings and wallet ==================== */

test('earning appears only after verified delivery, starts pending, then becomes available', async () => {
  await setTerms(pool, TERMS_115);
  const partner = await newPartner();
  const { orderId, cs } = await paidOrder();
  const ps = await as(partner);
  let w = (await ps.get('/partner/wallet')).body;
  assert.equal(w.totalEarnedPaise, 0, 'nothing earned before delivery');
  await deliver(orderId, partner, cs);
  w = (await ps.get('/partner/wallet')).body;
  assert.equal(w.totalEarnedPaise, 1000);
  assert.equal(w.pendingPaise, 1000, 'inside the 24h hold');
  assert.equal(w.availablePaise, 0);
  assert.equal(w.canWithdraw, false);
  await setPayoutConfig({ earning_hold_hours: 0 });
  w = (await ps.get('/partner/wallet')).body;
  assert.equal(w.availablePaise, 1000);
  assert.equal(w.pendingPaise, 0);
});

test('₹15 earning from a ₹300 subtotal, ₹10 below it — from the pricing policy, not code', async () => {
  await setTerms(pool, { ...TERMS_115, delivery_earning_high_paise: 1500, delivery_earning_threshold_paise: 30000 });
  const small = await paidOrder({ food: 29900 });
  const big = await paidOrder({ food: 30000 });
  const e = async (id) => (await pool.query(`SELECT delivery_earning_paise FROM order_financials WHERE order_id=$1`, [id])).rows[0].delivery_earning_paise;
  assert.equal(await e(small.orderId), 1000);
  assert.equal(await e(big.orderId), 1500);
});

test('₹65 cannot be withdrawn; reaching ₹100 enables withdrawal; the threshold is configuration', async () => {
  await setPayoutConfig({ earning_hold_hours: 0 });
  const partner = await newPartner();
  await makeVerifiedDestination(pool, { partnerId: partner.id });
  const ps = await as(partner);
  await setTerms(pool, { ...TERMS_115, delivery_earning_paise: 6500 });
  const a = await paidOrder(); await deliver(a.orderId, partner, a.cs);
  let w = (await ps.get('/partner/wallet')).body;
  assert.equal(w.availablePaise, 6500);
  assert.equal(w.canWithdraw, false);
  assert.match(w.blockers.join(' '), /₹35\.00 to go/);
  const refused = await ps.post('/partner/withdrawals', { idempotencyKey: 'wd-65-attempt' });
  assert.equal(refused.status, 409);
  assert.equal(calls.filter((c) => c.url === '/payout/transfers').length, 0);

  await setTerms(pool, { ...TERMS_115, delivery_earning_paise: 3500 });
  const b = await paidOrder(); await deliver(b.orderId, partner, b.cs);
  w = (await ps.get('/partner/wallet')).body;
  assert.equal(w.availablePaise, 10000);
  assert.equal(w.canWithdraw, true, JSON.stringify(w.blockers));

  /* The business lowers the threshold: a config write, nothing else. */
  await setPayoutConfig({ min_withdrawal_paise: 5000 });
  assert.equal((await ps.get('/partner/wallet')).body.minWithdrawalPaise, 5000);
});

test('bank payout details go to Cashfree only; Quad keeps a masked hint and the verification verdict', async () => {
  const partner = await newPartner();
  const ps = await as(partner);
  const r = await ps.put('/partner/payout-method', { instrument: 'bank', accountNumber: ACCOUNT,
                                                     ifsc: 'HDFC0001234', holderName: 'Ravi Kumar' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.destination.status, 'verified');
  assert.equal(r.body.destination.masked, 'XXXX9012');
  const sent = calls.find((c) => c.url === '/payout/beneficiary');
  assert.equal(sent.body.beneficiary_instrument_details.bank_account_number, ACCOUNT);
  const dump = JSON.stringify((await pool.query(`SELECT * FROM payout_destination`)).rows)
             + JSON.stringify((await pool.query(`SELECT * FROM audit_log`)).rows);
  assert.ok(!dump.includes(ACCOUNT), 'the full account number is never stored');
});

test('UPI details left pending by Cashfree do not enable withdrawal', async () => {
  beneficiaryStatus = 'INITIATED';
  await setPayoutConfig({ earning_hold_hours: 0, min_withdrawal_paise: 500 });
  await setTerms(pool, TERMS_115);
  const partner = await newPartner();
  const ps = await as(partner);
  const r = await ps.put('/partner/payout-method', { instrument: 'upi', vpa: 'ravi.k@okhdfc', holderName: 'Ravi Kumar' });
  assert.equal(r.body.destination.status, 'pending');
  assert.equal(r.body.destination.masked, 'ra***@okhdfc');
  const a = await paidOrder(); await deliver(a.orderId, partner, a.cs);
  const w = await ps.post('/partner/withdrawals', { idempotencyKey: 'wd-upi-pending' });
  assert.equal(w.status, 409);
  assert.match(w.body.error, /not verified/);
});

test('withdrawal pays through Cashfree Payouts; a duplicate request cannot pay twice', async () => {
  await setPayoutConfig({ earning_hold_hours: 0, min_withdrawal_paise: 1000 });
  await setTerms(pool, TERMS_115);
  const partner = await newPartner();
  await makeVerifiedDestination(pool, { partnerId: partner.id });
  const ps = await as(partner);
  const a = await paidOrder(); await deliver(a.orderId, partner, a.cs);
  const r1 = await ps.post('/partner/withdrawals', { idempotencyKey: 'wd-key-0001' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.state, 'paid');
  assert.equal(r1.body.amountPaise, 1000);
  const r2 = await ps.post('/partner/withdrawals', { idempotencyKey: 'wd-key-0001' });
  assert.equal(r2.body.duplicate, true);
  assert.equal(r2.body.id, r1.body.id);
  const r3 = await ps.post('/partner/withdrawals', { idempotencyKey: 'wd-key-0002' });
  assert.equal(r3.status, 409, 'nothing left, and weekly frequency');
  assert.equal(calls.filter((c) => c.url === '/payout/transfers').length, 1);
  assert.equal(await bal('delivery_payable', `AND partner_id='${partner.id}'`), 0);
  const w = (await ps.get('/partner/wallet')).body;
  assert.equal(w.lastPayout.id, r1.body.id);
  assert.equal(w.history[0].label, 'Paid');
});

test('a refused payout keeps the earning, records the reason, and retries safely under a new transfer id', async () => {
  await setPayoutConfig({ earning_hold_hours: 0, min_withdrawal_paise: 1000 });
  await setTerms(pool, TERMS_115);
  const partner = await newPartner();
  await makeVerifiedDestination(pool, { partnerId: partner.id });
  const ps = await as(partner);
  const a = await paidOrder(); await deliver(a.orderId, partner, a.cs);
  transferMode = 'reject400';
  const r1 = await ps.post('/partner/withdrawals', { idempotencyKey: 'wd-fail-0001' });
  assert.equal(r1.body.state, 'failed');
  const failed = (await pool.query(`SELECT * FROM payout WHERE id=$1`, [r1.body.id])).rows[0];
  assert.match(failed.failure_reason, /400/);
  assert.equal(await bal('delivery_payable', `AND partner_id='${partner.id}'`), 1000, 'earning not destroyed');
  assert.equal((await ps.get('/partner/wallet')).body.availablePaise, 1000);

  transferMode = 'SUCCESS';
  const retry = await ps.post(`/partner/withdrawals/${r1.body.id}/retry`);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.state, 'paid');
  assert.notEqual(retry.body.id, r1.body.id);
  const again = await ps.post(`/partner/withdrawals/${r1.body.id}/retry`);
  assert.equal(again.status, 409);
  assert.equal(await bal('delivery_payable', `AND partner_id='${partner.id}'`), 0);
  const ids = calls.filter((c) => c.url === '/payout/transfers').map((c) => c.body.transfer_id);
  assert.equal(new Set(ids).size, ids.length, 'every attempt used its own transfer id');
});

test('a timed-out payout is never re-sent: it stays processing until Cashfree says what happened', async () => {
  await setPayoutConfig({ earning_hold_hours: 0, min_withdrawal_paise: 1000 });
  await setTerms(pool, TERMS_115);
  const partner = await newPartner();
  await makeVerifiedDestination(pool, { partnerId: partner.id });
  const ps = await as(partner);
  const a = await paidOrder(); await deliver(a.orderId, partner, a.cs);
  transferMode = 'error500';                   // accepted at Cashfree, but we saw a 502
  const r = await ps.post('/partner/withdrawals', { idempotencyKey: 'wd-timeout-1' });
  assert.equal(r.body.state, 'processing');
  const retry = await ps.post(`/partner/withdrawals/${r.body.id}/retry`);
  assert.equal(retry.status, 409, 'processing is not failed; no second transfer');
  const { syncInFlightPayouts } = await import('../src/services/wallet.js');
  await pool.query(`UPDATE payout SET provider_synced_at = now() - interval '1 hour' WHERE id=$1`, [r.body.id]);
  const s = await syncInFlightPayouts();
  assert.equal(s.paid, 1);
  assert.equal((await pool.query(`SELECT state FROM payout WHERE id=$1`, [r.body.id])).rows[0].state, 'paid');
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url === '/payout/transfers').length, 1);
});

test('signed payout webhook settles a processing transfer once; a replay changes nothing', async () => {
  await setPayoutConfig({ earning_hold_hours: 0, min_withdrawal_paise: 1000 });
  await setTerms(pool, TERMS_115);
  const partner = await newPartner();
  await makeVerifiedDestination(pool, { partnerId: partner.id });
  const ps = await as(partner);
  const a = await paidOrder(); await deliver(a.orderId, partner, a.cs);
  transferMode = 'RECEIVED';
  const r = await ps.post('/partner/withdrawals', { idempotencyKey: 'wd-webhook-1' });
  assert.equal(r.body.state, 'processing');
  const evt = { type: 'TRANSFER_SUCCESS', data: { transfer_id: r.body.id, cf_transfer_id: 'cft1', status: 'SUCCESS', transfer_utr: 'UTRWH1' } };
  const bad = await app.inject(signed('/payouts/webhook', evt, 'nope', 'po1'));
  assert.equal(bad.statusCode, 400);
  const ok1 = await app.inject(signed('/payouts/webhook', evt, PO_SECRET, 'po1'));
  assert.equal(JSON.parse(ok1.body).state, 'paid');
  const ok2 = await app.inject(signed('/payouts/webhook', evt, PO_SECRET, 'po1'));
  assert.equal(JSON.parse(ok2.body).duplicate, true);
  const n = (await pool.query(`SELECT count(*)::int n FROM ledger_txn WHERE kind='payout' AND ref=$1`, [r.body.id])).rows[0].n;
  assert.equal(n, 1);
});

/* ======================= café settlement ================================ */

test('a café with no verified bank account accrues its payable but is never paid; verification unblocks it', async () => {
  await setTerms(pool, TERMS_115);
  await owner();
  const { vendor } = await paidOrder();
  const settlement = await import('../src/services/settlement.js');
  const MON_8PM = new Date('2026-09-07T14:30:00Z');
  const r1 = await settlement.runSettlementSchedules({ now: MON_8PM });
  assert.equal(r1.cafeteria.payouts, 0);
  assert.equal(r1.cafeteria.skipped, 1);
  assert.equal(await bal('cafeteria_payable', `AND vendor_id='${vendor.id}'`), 10000, 'tracked in full');
  const acct = (await pool.query(`SELECT settlement_status FROM v_vendor_settlement_account WHERE vendor_id=$1`, [vendor.id])).rows[0];
  assert.equal(acct.settlement_status, 'PENDING');

  await makeVerifiedDestination(pool, { vendorId: vendor.id });
  const r2 = await settlement.runSettlementSchedules({ now: new Date('2026-09-08T14:30:00Z') });
  assert.equal(r2.cafeteria.payouts, 1);
  assert.equal(r2.cafeteria.totalPaise, 10000);
});

test('café owner sees only their own settlement; a student sees none', async () => {
  await setTerms(pool, TERMS_115);
  const { vendor } = await paidOrder();
  const other = await makeVendor(pool, { name: 'Tulips', slug: 'tulips-x' });
  const ownerU = await makeUser(pool, { phone: phone(), name: 'Shop Owner', roles: ['vendor_owner'], vendorId: vendor.id });
  const os = await as(ownerU);
  const mine = await os.get(`/vendors/${vendor.id}/settlement`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.settlementStatus, 'PENDING');
  assert.equal((await os.get(`/vendors/${other.id}/settlement`)).status, 403);
  const student = await as(await makeUser(pool, { phone: phone(), name: 'Stu' }));
  assert.equal((await student.get(`/vendors/${vendor.id}/settlement`)).status, 403);
  assert.equal((await student.get('/partner/wallet')).status, 403);
  assert.equal((await student.put('/admin/payout-config', { min_withdrawal_paise: 100 })).status, 403);
  assert.equal((await student.post('/partner/withdrawals', { idempotencyKey: 'student-try-1' })).status, 403);
});

/* ======================= refunds and cancellation ======================= */

test('refund before settlement reverses each party\'s pending allocation exactly', async () => {
  await setTerms(pool, TERMS_115);
  const admin = await owner();
  const { orderId, vendor } = await paidOrder();
  const as_ = await as(admin, { method: 'passkey' });
  const r = await as_.post('/refunds', { orderId, reason: 'kitchen could not make it', idempotencyKey: 'rf-1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, 'completed');
  assert.equal(await bal('cafeteria_payable', `AND vendor_id='${vendor.id}'`), 0);
  assert.equal(await bal('platform_revenue'), 0);
  assert.equal(await bal('delivery_clearing'), 0);
  const again = await as_.post('/refunds', { orderId, reason: 'kitchen could not make it', idempotencyKey: 'rf-1' });
  assert.equal(again.body.duplicate, true);
});

test('refund after the café was paid leaves history intact and nets off the next settlement', async () => {
  await setTerms(pool, TERMS_115);
  const admin = await owner();
  const { orderId, vendor } = await paidOrder();
  await makeVerifiedDestination(pool, { vendorId: vendor.id });
  const settlement = await import('../src/services/settlement.js');
  await settlement.runSettlementSchedules({ now: new Date('2026-09-07T14:30:00Z') });
  const p = (await pool.query(`SELECT id FROM payout WHERE vendor_id=$1`, [vendor.id])).rows[0];
  const as_ = await as(admin, { method: 'passkey' });
  await as_.post(`/admin/payouts/${p.id}/record`, { reference: 'UTRCAFE001' });
  const r = await as_.post('/refunds', { orderId, reason: 'food was cold on arrival', idempotencyKey: 'rf-after' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await bal('cafeteria_payable', `AND vendor_id='${vendor.id}'`), -10000,
    'a compensating entry: the café owes it back against future sales');
  const paid = (await pool.query(`SELECT state, amount_paise FROM payout WHERE id=$1`, [p.id])).rows[0];
  assert.deepEqual(paid, { state: 'paid', amount_paise: 10000 }, 'the paid payout is never mutated');
});

test('cancelling a paid order refunds the customer automatically and pays no partner', async () => {
  await setTerms(pool, TERMS_115);
  const { orderId, vendor } = await paidOrder();
  const vo = await as(await makeUser(pool, { phone: phone(), name: 'Counter', roles: ['vendor_owner'], vendorId: vendor.id }));
  const r = await vo.post(`/orders/${orderId}/transition`, { to: 'cancelled', note: 'out of stock' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.refund.state, 'completed');
  assert.equal(r.body.refund.amountPaise, 11500);
  assert.equal(await bal('cafeteria_payable', `AND vendor_id='${vendor.id}'`), 0);
  assert.equal(await bal('delivery_payable'), 0);
  assert.equal(await bal('delivery_clearing'), 0);
  assert.equal(await bal('platform_revenue'), 0, 'the platform fee is returned too');
  const again = await vo.post(`/orders/${orderId}/transition`, { to: 'cancelled' });
  assert.notEqual(again.status, 200);
  const n = (await pool.query(`SELECT count(*)::int n FROM refund WHERE order_id=$1`, [orderId])).rows[0].n;
  assert.equal(n, 1);
});

test('reconciliation flags a cancelled order whose money was never returned', async () => {
  await setTerms(pool, TERMS_115);
  const { orderId } = await paidOrder();
  await pool.query(`UPDATE food_order SET state='cancelled' WHERE id=$1`, [orderId]);
  const { detectOperationalDifferences } = await import('../src/services/reconciliation.js');
  const out = await detectOperationalDifferences();
  assert.equal(out.refundMissing, 1);
  const again = await detectOperationalDifferences();
  assert.equal(again.refundMissing, 0, 'raised once, not every tick');
});

/* ======================= incidents ====================================== */

test('an accusation alone moves no money; a reviewed finding with evidence can adjust earnings', async () => {
  await setPayoutConfig({ earning_hold_hours: 0 });
  await setTerms(pool, TERMS_115);
  const admin = await owner();
  const partner = await newPartner();
  const { orderId, cs } = await paidOrder();
  await deliver(orderId, partner, cs);
  const rep = await cs.post(`/orders/${orderId}/incidents`, { category: 'suspected_theft',
    description: 'Two items were missing and the bag was opened.' });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  const ps = await as(partner);
  let w = (await ps.get('/partner/wallet')).body;
  assert.equal(w.pendingPaise, 1000, 'held while under review, not deducted');
  assert.equal(await bal('delivery_payable', `AND partner_id='${partner.id}'`), 1000);

  const as_ = await as(admin, { method: 'passkey' });
  const noFault = await as_.post(`/admin/incidents/${rep.body.id}/resolve`, { outcome: 'no_fault_found',
    note: 'Café confirmed it packed only one item.', actions: ['earning_adjustment'], earningAdjustmentPaise: 500,
    evidence: 'counter confirmation and handover code timing' });
  assert.equal(noFault.status, 409, 'no deduction without a finding of fault');

  const fault = await as_.post(`/admin/incidents/${rep.body.id}/resolve`, { outcome: 'partner_responsible',
    note: 'Seal broken between pickup and handoff; partner admitted it.', actions: ['earning_adjustment', 'warning'],
    earningAdjustmentPaise: 500, evidence: 'Pickup photo shows a sealed bag; customer photo shows the seal broken.' });
  assert.equal(fault.status, 200, JSON.stringify(fault.body));
  assert.equal(await bal('delivery_payable', `AND partner_id='${partner.id}'`), 500);
  w = (await ps.get('/partner/wallet')).body;
  assert.equal(w.pendingPaise, 0);
  const ev = (await as_.get(`/admin/incidents/${rep.body.id}/events`)).body.events.map((e) => e.event);
  assert.deepEqual(ev, ['reported', 'resolved', 'action:earning_adjustment', 'action:warning']);
});
