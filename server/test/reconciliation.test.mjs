/* ==========================================================================
   SETTLEMENT RECONCILIATION — the importer, exercised adversarially.

   The feature exists because a payment webhook is not authoritative about
   what the gateway kept. So the tests are mostly about what the importer
   REFUSES to do: apply a fee it cannot justify, absorb a deduction nobody
   explained, overwrite a figure already recorded, count a line twice, or
   call a run reconciled because an HTTP request succeeded.

   The provider is a local server speaking Cashfree's settlement-recon wire
   format. The real adapter makes real HTTP requests to it, so pagination,
   the rupee/paise conversion and the request body are genuinely exercised.
   What it cannot prove is that Cashfree's live report matches this shape —
   that needs a real account and is listed as an outstanding blocker.

   Money in this file: a 100 rupee thali, 2% commission, 5 rupee platform
   fee, 10 rupees delivery charged and earned. The customer pays 11500 paise.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus, setTerms }
  from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const APP_ID = 'TEST_APPID_recon';
const SECRET = 'cfsk_test_recon_secret_' + 'y'.repeat(16);

let app, pool, stub, stubUrl, campus, recon;

/* What the stub's recon report contains for the next call. Tests set this. */
let reconPages = [];
let reconCalls = [];
let reconMode = 'ok';

function startStub() {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        const json = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };

        if (req.url === '/pg/settlement/recon' && req.method === 'POST') {
          reconCalls.push({ filters: parsed.filters, pagination: parsed.pagination,
                            clientId: req.headers['x-client-id'] });
          if (reconMode === 'error') return json(500, { message: 'provider is having a day' });
          const cursor = parsed.pagination?.cursor;
          const idx = cursor ? Number(cursor) : 0;
          const page = reconPages[idx] || [];
          return json(200, {
            data: page,
            cursor: idx + 1 < reconPages.length ? String(idx + 1) : null,
          });
        }
        if (req.method === 'POST' && req.url === '/pg/orders') {
          const b = JSON.parse(body);
          return json(200, {
            cf_order_id: 'cf_' + b.order_id, order_id: b.order_id,
            order_amount: b.order_amount, order_currency: b.order_currency,
            order_status: 'ACTIVE', payment_session_id: 'session_' + b.order_id });
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
  recon = await import('../src/services/reconciliation.js');
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
  campus = await makeCampus(pool);
  reconPages = [];
  reconCalls = [];
  reconMode = 'ok';
});

const as = async (u) => client(app, await sessionFor(pool, u.id));
const row = (r) => (r.rows[0] || null);

async function makePlatformOwner() {
  return makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['platform_owner'] });
}

/* One captured order, paid through the real Cashfree path so the payment
   carries genuine provider identifiers to match on. */
let seq = 0;
async function paidOrder() {
  seq++;
  const vendor = await makeVendor(pool, { name: 'Frisco', slug: 'f-recon-' + seq });
  const item = await makeItem(pool, vendor.id, { name: 'Thali', paise: 10000 });
  const customer = await makeUser(pool, { phone: '+9198000000' + String(100 + seq), name: 'Cust' });
  await setTerms(pool, { commission_bps: 200, platform_fee_flat_paise: 500,
                         delivery_fee_paise: 1000, delivery_earning_paise: 1000 });
  const cs = await as(customer);
  const draft = await cs.post('/orders/draft', {
    vendorId: vendor.id, lines: [{ itemId: item.id, qty: 1 }],
    fulfilment: 'delivery', destinationId: campus.blockB.id });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const intent = await cs.post('/payments/intent', { orderId: draft.body.id });
  assert.equal(intent.status, 200, JSON.stringify(intent.body));

  const cfPaymentId = String(500000 + seq);
  const evt = {
    type: 'PAYMENT_SUCCESS_WEBHOOK',
    data: {
      order: { order_id: intent.body.gatewayOrderId, order_amount: '115.00',
               order_currency: 'INR' },
      payment: { cf_payment_id: cfPaymentId, payment_status: 'SUCCESS',
                 payment_amount: '115.00', payment_currency: 'INR' },
    },
  };
  const raw = JSON.stringify(evt);
  const ts = String(Date.now());
  await app.inject({ method: 'POST', url: '/payments/webhook', payload: raw, headers: {
    'content-type': 'application/json', 'x-webhook-timestamp': ts,
    'x-idempotency-key': 'idem_' + seq,
    'x-webhook-signature': createHmac('sha256', SECRET).update(ts + raw).digest('base64') } });

  const payment = row(await pool.query(
    `SELECT * FROM payment WHERE order_id=$1`, [draft.body.id]));
  assert.equal(payment.status, 'paid', 'the fixture must start from a genuinely captured payment');
  assert.equal(payment.amount_paise, 11500);
  return { orderId: draft.body.id, vendor, customer, payment, cfPaymentId,
           providerOrderId: intent.body.gatewayOrderId };
}

/* A settlement report line, in Cashfree's shape. */
const line = (o, over = {}) => ({
  cf_payment_id: Number(o.cfPaymentId),
  order_id: o.providerOrderId,
  cf_settlement_id: 900001,
  transfer_utr: 'UTRRECON1',
  event_type: 'PAYMENT',
  payment_amount: '115.00',
  order_amount: '115.00',
  service_charge: '2.24',
  service_tax: '0.40',
  settlement_amount: '112.36',
  ...over,
});

const runImport = (over = {}) => recon.importSettlements({
  from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z',
  detectUnsettled: false, ...over });

const snapshotOf = async (orderId) => row(await pool.query(
  `SELECT * FROM order_financials WHERE order_id=$1`, [orderId]));
const paymentOf = async (id) => row(await pool.query(`SELECT * FROM payment WHERE id=$1`, [id]));
const exceptionsOf = async (kind) => (await pool.query(
  `SELECT * FROM reconciliation_exception ${kind ? 'WHERE kind=$1' : ''}`,
  kind ? [kind] : [])).rows;

/* ======================= 1. the happy path ============================== */

test('an importer run records the ACTUAL fee, marks the payment, and posts the ledger', async () => {
  const o = await paidOrder();
  /* Before: Cashfree reported no fee on the webhook, so there is none. */
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 0);
  assert.equal((await paymentOf(o.payment.id)).reconciled_at, null);

  reconPages = [[line(o)]];
  const run = await runImport();

  assert.equal(run.state, 'completed', 'no differences, so a clean run');
  assert.equal(run.entries_seen, 1);
  assert.equal(run.entries_new, 1);
  assert.equal(run.entries_matched, 1);
  assert.equal(run.exceptions_raised, 0);
  assert.equal(Number(run.fees_recorded_paise), 264, '224 charge + 40 tax');

  /* The fee is on the snapshot, and it is the provider's number. */
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 264);

  /* The payment is explicitly marked, with its settlement as evidence. */
  const pay = await paymentOf(o.payment.id);
  assert.ok(pay.reconciled_at);
  assert.equal(pay.settlement_id, '900001');

  /* And the correcting ledger posting exists, balanced, append-only. */
  const legs = (await pool.query(
    `SELECT a.kind, e.amount_paise FROM ledger_entry e
       JOIN ledger_txn t ON t.id = e.txn_id
       JOIN ledger_account a ON a.id = e.account_id
      WHERE t.kind='adjustment' AND t.ref = $1`, [`gateway_fee:${o.payment.id}`])).rows;
  assert.equal(legs.length, 2);
  assert.equal(legs.reduce((s, l) => s + Number(l.amount_paise), 0), 0, 'the posting balances');
  const fee = legs.find((l) => l.kind === 'gateway_fee');
  const clearing = legs.find((l) => l.kind === 'gateway_clearing');
  assert.equal(Number(fee.amount_paise), 264, 'the expense is booked');
  assert.equal(Number(clearing.amount_paise), -264, 'the bank never held that part');
});

test('net revenue is recalculated from the provider figure, not estimated', async () => {
  const owner = await makePlatformOwner();
  const o = await paidOrder();
  const admin = await as(owner);

  const before = (await admin.get('/admin/finance/summary')).body;
  assert.equal(before.gatewayFeesPaise, 0);
  assert.equal(before.quadNetRevenuePaise, before.quadGrossRevenuePaise,
    'with no reconciliation, net is gross wearing a different label');

  reconPages = [[line(o)]];
  await runImport();

  const after = (await admin.get('/admin/finance/summary')).body;
  assert.equal(after.gatewayFeesPaise, 264);
  assert.equal(after.quadGrossRevenuePaise, before.quadGrossRevenuePaise,
    'GROSS revenue is untouched — reconciliation is not a repricing');
  assert.equal(after.quadNetRevenuePaise, before.quadGrossRevenuePaise - 264,
    'net falls by exactly what the provider actually charged');
});

test('a genuinely ZERO fee still reconciles — the 0% offer is not "unreconciled"', async () => {
  /* The trap this whole design exists to avoid: under Cashfree's launch
     offer the correct fee is 0, and inferring reconciliation from a non-zero
     amount would mark every properly reconciled order as outstanding. */
  const o = await paidOrder();
  reconPages = [[line(o, { service_charge: '0.00', service_tax: '0.00',
                           settlement_amount: '115.00' })]];
  const run = await runImport();

  assert.equal(run.state, 'completed');
  assert.equal(run.exceptions_raised, 0, 'a zero fee is a normal outcome, not a difference');
  const pay = await paymentOf(o.payment.id);
  assert.ok(pay.reconciled_at, 'reconciled state is explicit, never inferred from the amount');
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 0);
});

/* ======================= 2. idempotency ================================= */

test('re-running the SAME reconciliation job changes nothing', async () => {
  const o = await paidOrder();
  reconPages = [[line(o)]];

  const first = await runImport();
  const snapAfterFirst = await snapshotOf(o.orderId);
  const second = await runImport();
  const third = await runImport();

  assert.equal(first.entries_new, 1);
  assert.equal(second.entries_new, 0, 'nothing new on a re-run');
  assert.equal(second.entries_duplicate, 1, 'and the re-read line is recognised');
  assert.equal(third.entries_duplicate, 1);
  assert.equal(Number(second.fees_recorded_paise), 0, 'no fee applied a second time');

  /* The numbers are byte-identical. */
  assert.deepEqual(await snapshotOf(o.orderId), snapAfterFirst);

  /* Exactly one entry row, one ledger posting, one fee. */
  const entries = await pool.query(`SELECT count(*)::int AS n FROM provider_settlement_entry`);
  assert.equal(entries.rows[0].n, 1);
  const txns = await pool.query(
    `SELECT count(*)::int AS n FROM ledger_txn WHERE kind='adjustment' AND ref=$1`,
    [`gateway_fee:${o.payment.id}`]);
  assert.equal(txns.rows[0].n, 1);
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 264, 'not 528');
});

test('duplicate settlement IMPORT of the same window double-counts nothing', async () => {
  /* Two orders, imported, then the exact same report imported again — the
     shape of a cron that fired twice, or an operator re-running after a
     timeout that had actually succeeded. */
  const a = await paidOrder();
  const b = await paidOrder();
  reconPages = [[line(a), line(b, { cf_settlement_id: 900002 })]];

  await runImport();
  await runImport();

  const total = await pool.query(
    `SELECT COALESCE(sum(gateway_fee_paise),0)::int AS n FROM order_financials`);
  assert.equal(total.rows[0].n, 528, 'two orders at 264, not four');
  const entries = await pool.query(`SELECT count(*)::int AS n FROM provider_settlement_entry`);
  assert.equal(entries.rows[0].n, 2);
});

/* ======================= 3. mapping failures ============================ */

test('a settlement for a payment Quad does not have raises missing_payment', async () => {
  await paidOrder();
  reconPages = [[line({ cfPaymentId: '999999', providerOrderId: 'not-a-quad-order' })]];
  const run = await runImport();

  assert.equal(run.state, 'completed_with_exceptions');
  assert.equal(run.entries_matched, 0);
  const x = await exceptionsOf('missing_payment');
  assert.equal(x.length, 1);
  assert.equal(x[0].severity, 'blocking');
  assert.equal(x[0].payment_id, null, 'nothing was invented to match it to');

  /* The raw line is kept regardless — it is evidence. */
  const e = row(await pool.query(`SELECT * FROM provider_settlement_entry`));
  assert.equal(e.match_state, 'unmatched');
  assert.equal(e.applied, false);
});

test('WRONG payment mapping is refused, not resolved by picking one', async () => {
  /* The report's payment id points at order A; its order id points at B.
     Two immutable identifiers disagreeing is not something to guess at. */
  const a = await paidOrder();
  const b = await paidOrder();
  reconPages = [[line(a, { order_id: b.providerOrderId })]];
  const run = await runImport();

  assert.equal(run.state, 'completed_with_exceptions');
  const x = await exceptionsOf('order_mismatch');
  assert.equal(x.length, 1);
  assert.equal(x[0].payment_id, a.payment.id);

  /* Neither order got a fee. */
  assert.equal((await snapshotOf(a.orderId)).gateway_fee_paise, 0);
  assert.equal((await snapshotOf(b.orderId)).gateway_fee_paise, 0);
  assert.equal((await paymentOf(a.payment.id)).reconciled_at, null);
  const e = row(await pool.query(`SELECT * FROM provider_settlement_entry`));
  assert.equal(e.match_state, 'conflicted');
  assert.equal(e.applied, false);
});

test('matching is on provider identifiers, never on amount', async () => {
  /* Two orders for the identical amount at the identical moment — an
     ordinary Tuesday on a campus. An amount-based match would pick one at
     random and be right half the time. */
  const a = await paidOrder();
  const b = await paidOrder();
  assert.equal(a.payment.amount_paise, b.payment.amount_paise);

  reconPages = [[line(b)]];                       // only B is settled
  await runImport();

  assert.equal((await snapshotOf(b.orderId)).gateway_fee_paise, 264);
  assert.equal((await snapshotOf(a.orderId)).gateway_fee_paise, 0, 'A is untouched');
  assert.ok((await paymentOf(b.payment.id)).reconciled_at);
  assert.equal((await paymentOf(a.payment.id)).reconciled_at, null);
});

/* ======================= 4. amount failures ============================= */

test('an AMOUNT MISMATCH blocks the fee rather than trusting the report', async () => {
  const o = await paidOrder();
  reconPages = [[line(o, { payment_amount: '99.00', order_amount: '99.00',
                           settlement_amount: '96.36' })]];
  const run = await runImport();

  assert.equal(run.state, 'completed_with_exceptions');
  const x = await exceptionsOf('amount_mismatch');
  assert.equal(x.length, 1);
  assert.equal(x[0].detail.expectedPaise, 11500);
  assert.equal(x[0].detail.reportedPaise, 9900);

  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 0,
    'no fee is applied against a payment whose amount is in dispute');
  assert.equal((await paymentOf(o.payment.id)).reconciled_at, null);
});

test('an UNEXPECTED DEDUCTION is surfaced, never absorbed into the fee', async () => {
  /* settlement != amount - charge - tax. The temptation is to call the
     difference "fee" and move on; that would hide it inside a number that
     already looks like a cost. */
  const o = await paidOrder();
  reconPages = [[line(o, { settlement_amount: '100.00' })]];   // 12.36 unexplained
  const run = await runImport();

  assert.equal(run.state, 'completed_with_exceptions');
  const x = await exceptionsOf('partial_settlement');
  assert.equal(x.length, 1, 'a shortfall against a positive settlement is a partial settlement');
  assert.equal(x[0].detail.unexplainedPaise, 1236);
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 0, 'nothing applied');
});

test('a SURPLUS is a reconciliation failure too — money appearing is not a windfall', async () => {
  const o = await paidOrder();
  reconPages = [[line(o, { settlement_amount: '120.00' })]];
  const run = await runImport();
  assert.equal(run.state, 'completed_with_exceptions');
  const x = await exceptionsOf('unexpected_deduction');
  assert.equal(x.length, 1);
  assert.equal(x[0].detail.unexplainedPaise, -764);
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 0);
});

test('PARTIAL settlement is named as such and applies no fee', async () => {
  const o = await paidOrder();
  reconPages = [[line(o, { settlement_amount: '50.00' })]];
  const run = await runImport();
  const x = await exceptionsOf('partial_settlement');
  assert.equal(x.length, 1);
  assert.equal(x[0].detail.reportedSettlementPaise, 5000);
  assert.equal(x[0].detail.expectedSettlementPaise, 11236);
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 0);
  assert.equal((await paymentOf(o.payment.id)).reconciled_at, null);
});

test('an amount with more precision than paise is refused, never rounded', async () => {
  const o = await paidOrder();
  reconPages = [[line(o, { service_charge: '2.245' })]];
  const run = await runImport();

  assert.equal(run.state, 'completed_with_exceptions');
  const x = await exceptionsOf('unexpected_deduction');
  assert.equal(x.length, 1);
  assert.match(x[0].detail.reason || '', /could not be read exactly/);
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 0);
  /* The line is still stored — an unreadable provider fact is still a fact. */
  const e = row(await pool.query(`SELECT * FROM provider_settlement_entry`));
  assert.equal(e.service_charge_paise, null);
  assert.equal(e.applied, false);
});

/* ======================= 5. fee already recorded ======================== */

test('an UNEXPECTED FEE never overwrites one already recorded', async () => {
  const o = await paidOrder();
  /* Simulate the Razorpay case: a fee was recorded at capture. */
  await pool.query(`UPDATE order_financials SET gateway_fee_paise=300 WHERE order_id=$1`,
                   [o.orderId]);

  reconPages = [[line(o)]];                       // report says 264, not 300
  const run = await runImport();

  assert.equal(run.state, 'completed_with_exceptions');
  const x = await exceptionsOf('fee_mismatch');
  assert.equal(x.length, 1);
  assert.equal(x[0].detail.recordedPaise, 300);
  assert.equal(x[0].detail.settlementPaise, 264);

  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 300,
    'the recorded value stands until a human decides');
  assert.equal((await paymentOf(o.payment.id)).reconciled_at, null);
});

test('a settlement AGREEING with an already-recorded fee reconciles cleanly', async () => {
  const o = await paidOrder();
  await pool.query(`UPDATE order_financials SET gateway_fee_paise=264 WHERE order_id=$1`,
                   [o.orderId]);
  reconPages = [[line(o)]];
  const run = await runImport();

  assert.equal(run.state, 'completed', 'agreement is not a difference');
  assert.equal(run.exceptions_raised, 0);
  assert.ok((await paymentOf(o.payment.id)).reconciled_at);
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 264);
});

/* ======================= 6. duplicate provider transaction ============== */

test('ONE payment settled under TWO settlement ids raises duplicate_provider_txn', async () => {
  const o = await paidOrder();
  reconPages = [[
    line(o, { cf_settlement_id: 900001 }),
    line(o, { cf_settlement_id: 900002 }),
  ]];
  const run = await runImport();

  assert.equal(run.state, 'completed_with_exceptions');
  const x = await exceptionsOf('duplicate_provider_txn');
  assert.equal(x.length, 1, 'the second line is what raises it');
  assert.deepEqual([...x[0].detail.settlements].sort(), ['900001', '900002']);

  /* Both lines are stored — the duplicate is evidence, not noise — but only
     the first applied a fee, and the second applied nothing. */
  const entries = (await pool.query(
    `SELECT settlement_id, applied FROM provider_settlement_entry ORDER BY settlement_id`)).rows;
  assert.equal(entries.length, 2);
  assert.equal(entries[1].applied, false, 'the duplicate applies nothing');
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 264, 'charged once, not twice');
});

/* ======================= 7. refunds and adjustments ===================== */

test('a REFUND line is recorded and does not become a fee on the payment', async () => {
  const owner = await makePlatformOwner();
  const o = await paidOrder();
  /* A real refund, through the real flow, so there is something to match. */
  await pool.query(
    `INSERT INTO refund (order_id, payment_id, amount_paise, reason, requested_by, state)
     VALUES ($1,$2,$3,'cold food',$4,'completed')`,
    [o.orderId, o.payment.id, 11500, owner.id]);

  reconPages = [[line(o, { event_type: 'REFUND', cf_settlement_id: 900003,
                           service_charge: '0.00', service_tax: '0.00',
                           settlement_amount: '115.00' })]];
  const run = await runImport();

  assert.equal(run.exceptions_raised, 0, 'a known refund is not a difference');
  assert.equal(run.entries_matched, 1);
  const e = row(await pool.query(`SELECT * FROM provider_settlement_entry`));
  assert.equal(e.event_type, 'REFUND');
  assert.equal(e.applied, false, 'a refund line applies no gateway fee');
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 0);
});

test('a refund the provider made that Quad has no record of is raised', async () => {
  const o = await paidOrder();
  reconPages = [[line(o, { event_type: 'REFUND', cf_settlement_id: 900004 })]];
  const run = await runImport();

  assert.equal(run.state, 'completed_with_exceptions');
  const x = await exceptionsOf('refund_unmatched');
  assert.equal(x.length, 1);
  assert.equal(x[0].payment_id, o.payment.id);
});

/* ======================= 8. payout already executed ===================== */

test('reconciling AFTER a payout alters no payout, and says so', async () => {
  const owner = await makePlatformOwner();
  const o = await paidOrder();
  /* The cafeteria has already been paid for this order's window. */
  const payout = row(await pool.query(
    `INSERT INTO payout (vendor_id, amount_paise, state, method, external_reference, paid_at)
     VALUES ($1, 9800, 'paid', 'manual_bank_transfer', 'UTR-PAID-1', now()) RETURNING *`,
    [o.vendor.id]));

  reconPages = [[line(o)]];
  const run = await runImport();

  /* Informational, not blocking: the gateway fee is Quad's cost and was
     never part of the cafeteria payable, so nothing is retroactively wrong. */
  const x = await exceptionsOf('payout_already_executed');
  assert.equal(x.length, 1);
  assert.equal(x[0].severity, 'informational');

  /* The fee IS applied — a prior payout does not block Quad learning its own
     cost — and the payout is byte-identical. */
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 264);
  const after = row(await pool.query(`SELECT * FROM payout WHERE id=$1`, [payout.id]));
  assert.deepEqual(after, payout, 'a settled payout is never rewritten by reconciliation');
  assert.equal(run.entries_matched, 1);
});

/* ======================= 9. missing provider transactions =============== */

test('a captured payment the provider NEVER settled is detected', async () => {
  const o = await paidOrder();
  /* Age it past the grace window: settlement genuinely takes days, so a
     payment captured an hour ago is not yet a problem. */
  await pool.query(`UPDATE payment SET settled_at = now() - interval '8 days' WHERE id=$1`,
                   [o.payment.id]);

  reconPages = [[]];                              // the provider reports nothing
  const run = await recon.importSettlements({
    from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' });

  assert.equal(run.state, 'completed_with_exceptions');
  const x = await exceptionsOf('unsettled_payment');
  assert.equal(x.length, 1, 'money taken from a student and not passed on is visible');
  assert.equal(x[0].payment_id, o.payment.id);
  assert.equal(x[0].detail.amountPaise, 11500);
});

test('a recently captured payment is NOT flagged as unsettled', async () => {
  await paidOrder();
  reconPages = [[]];
  const run = await recon.importSettlements({
    from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' });
  assert.equal((await exceptionsOf('unsettled_payment')).length, 0,
    'settlement takes days; flagging an hour-old capture is noise, not signal');
  assert.equal(run.state, 'completed');
});

test('the unsettled sweep does not re-raise the same exception every run', async () => {
  const o = await paidOrder();
  await pool.query(`UPDATE payment SET settled_at = now() - interval '8 days' WHERE id=$1`,
                   [o.payment.id]);
  reconPages = [[]];
  const opts = { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' };
  await recon.importSettlements(opts);
  await recon.importSettlements(opts);
  await recon.importSettlements(opts);
  assert.equal((await exceptionsOf('unsettled_payment')).length, 1,
    'a daily cron over an unresolved problem must not breed a queue nobody can clear');
});

/* ======================= 10. run state honesty ========================== */

test('a provider 200 does not by itself mean reconciled', async () => {
  const o = await paidOrder();
  reconPages = [[line(o, { payment_amount: '1.00' })]];       // the API is perfectly healthy
  const run = await runImport();

  assert.equal(run.state, 'completed_with_exceptions',
    'the API answered fine; the money did not reconcile, and the state says which');
  assert.notEqual(run.state, 'completed');
  assert.equal((await paymentOf(o.payment.id)).reconciled_at, null);
});

test('a provider failure is recorded as FAILED, not as an empty success', async () => {
  await paidOrder();
  reconMode = 'error';
  await assert.rejects(() => runImport(), /cashfree_pg 500/);

  const run = row(await pool.query(`SELECT * FROM provider_settlement_import`));
  assert.equal(run.state, 'failed');
  assert.ok(run.finished_at, 'a terminal state carries its finish time');
  assert.match(run.error, /500/);
});

test('a failed run is safe to re-run, and picks up where it left off', async () => {
  const o = await paidOrder();
  reconMode = 'error';
  await assert.rejects(() => runImport());
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 0);

  reconMode = 'ok';
  reconPages = [[line(o)]];
  const run = await runImport();
  assert.equal(run.state, 'completed');
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 264);
});

test('pagination is walked, and every page is applied', async () => {
  const a = await paidOrder();
  const b = await paidOrder();
  const c = await paidOrder();
  reconPages = [
    [line(a, { cf_settlement_id: 900010 })],
    [line(b, { cf_settlement_id: 900011 })],
    [line(c, { cf_settlement_id: 900012 })],
  ];
  const run = await runImport();

  assert.equal(run.entries_seen, 3, 'all three pages were read');
  assert.equal(run.entries_matched, 3);
  assert.equal(Number(run.fees_recorded_paise), 792);
  assert.ok(reconCalls.length >= 3, 'the cursor was actually followed');
  assert.equal(reconCalls[0].clientId, APP_ID, 'authenticated as ourselves');
});

/* ======================= 11. immutability =============================== */

test('reconciliation NEVER touches an allocation value', async () => {
  const o = await paidOrder();
  const before = await snapshotOf(o.orderId);
  reconPages = [[line(o)]];
  await runImport();
  const after = await snapshotOf(o.orderId);

  for (const k of ['customer_total_paise', 'cafeteria_payable_paise', 'delivery_earning_paise',
                   'platform_gross_paise', 'tax_payable_paise', 'food_subtotal_paise',
                   'commission_paise', 'platform_fee_paise', 'delivery_fee_paise']) {
    assert.equal(after[k], before[k], `${k} must be untouched by reconciliation`);
  }
  assert.notEqual(after.gateway_fee_paise, before.gateway_fee_paise,
    'the fee is the ONE field reconciliation may write');
});

test('the database refuses an allocation rewrite even if the importer tried', async () => {
  const o = await paidOrder();
  await assert.rejects(
    () => pool.query(`UPDATE order_financials SET cafeteria_payable_paise = 1 WHERE order_id=$1`,
                     [o.orderId]),
    /immutable/);
  await assert.rejects(
    () => pool.query(`UPDATE order_financials SET platform_gross_paise = 99999 WHERE order_id=$1`,
                     [o.orderId]),
    /immutable/);
});

test('the fee cannot be written twice, even directly', async () => {
  const o = await paidOrder();
  reconPages = [[line(o)]];
  await runImport();
  await assert.rejects(
    () => pool.query(`UPDATE order_financials SET gateway_fee_paise = 500 WHERE order_id=$1`,
                     [o.orderId]),
    /immutable/, 'write-once, from zero, and no second chance');
});

test('the ledger correction is append-only — the capture posting is untouched', async () => {
  const o = await paidOrder();
  const captureBefore = (await pool.query(
    `SELECT e.amount_paise, a.kind FROM ledger_entry e
       JOIN ledger_txn t ON t.id=e.txn_id JOIN ledger_account a ON a.id=e.account_id
      WHERE t.kind='order_capture' AND t.ref=$1 ORDER BY a.kind`, [o.payment.id])).rows;

  reconPages = [[line(o)]];
  await runImport();

  const captureAfter = (await pool.query(
    `SELECT e.amount_paise, a.kind FROM ledger_entry e
       JOIN ledger_txn t ON t.id=e.txn_id JOIN ledger_account a ON a.id=e.account_id
      WHERE t.kind='order_capture' AND t.ref=$1 ORDER BY a.kind`, [o.payment.id])).rows;
  assert.deepEqual(captureAfter, captureBefore,
    'the original posting is history and history is not edited');
});

/* ======================= 12. the settlement batch ======================= */

test('the daily settlement batch is built from the LEDGER, not from provider figures', async () => {
  /* The requirement is that a cafeteria's payable comes from Quad's own
     double-entry balance. Proof: reconciliation changes what the GATEWAY
     kept, and the cafeteria's payable does not move by a paisa. */
  const owner = await makePlatformOwner();
  const o = await paidOrder();
  const admin = await as(owner);

  const before = (await admin.get('/admin/finance/summary')).body;
  reconPages = [[line(o)]];
  await runImport();
  const after = (await admin.get('/admin/finance/summary')).body;

  assert.equal(after.cafeteriaPayablePaise, before.cafeteriaPayablePaise,
    "the gateway's fee is Quad's cost, never a deduction from the cafeteria");
  assert.equal(after.deliveryPayablePaise, before.deliveryPayablePaise);
  assert.equal(after.deliveryUnearnedPaise, before.deliveryUnearnedPaise);

  /* The clearing balance DOES fall — that money never reached the bank. */
  assert.equal(after.clearingBalancePaise, before.clearingBalancePaise - 264);

  /* And the built batch pays the ledger balance, not a provider number. */
  const built = await admin.post('/admin/payouts/batches', { kind: 'cafeteria' });
  assert.equal(built.status, 200, JSON.stringify(built.body));
  const payout = row(await pool.query(`SELECT * FROM payout WHERE vendor_id=$1`, [o.vendor.id]));
  assert.equal(payout.amount_paise, after.cafeteriaPayablePaise,
    'the payout is the ledger balance, full stop');
  assert.equal(payout.amount_paise, 9800, '100 food less 2% commission');
});

/* ======================= 13. the admin surface ========================== */

test('the reconciliation surface reports coverage and open differences', async () => {
  const owner = await makePlatformOwner();
  const good = await paidOrder();
  const bad = await paidOrder();
  reconPages = [[line(good), line(bad, { cf_settlement_id: 900020, payment_amount: '1.00' })]];
  await runImport();

  const admin = await as(owner);
  const r = await admin.get('/admin/finance/reconciliation');
  assert.equal(r.status, 200);
  assert.equal(r.body.coverage.paidPayments, 2);
  assert.equal(r.body.coverage.reconciledPayments, 1);
  assert.equal(r.body.coverage.unreconciledPayments, 1,
    'how much of the book is actually reconciled is the number that matters');
  assert.equal(r.body.blockingCount, 1);
  assert.equal(r.body.imports.length, 1);
  assert.equal(r.body.imports[0].state, 'completed_with_exceptions');
});

test('the import endpoint says whether it actually reconciled', async () => {
  const owner = await makePlatformOwner();
  const o = await paidOrder();
  const admin = await as(owner);
  reconPages = [[line(o, { payment_amount: '1.00' })]];

  const r = await admin.post('/admin/finance/reconciliation/import',
    { from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' });
  assert.equal(r.status, 200);
  assert.equal(r.body.reconciled, false, 'a 200 from the gateway is not reconciliation');
  assert.equal(r.body.needsAttention, true);
});

test('resolving a difference needs a person and a reason, and moves no money', async () => {
  const owner = await makePlatformOwner();
  const o = await paidOrder();
  reconPages = [[line(o, { payment_amount: '1.00' })]];
  await runImport();
  const x = row(await pool.query(`SELECT * FROM reconciliation_exception`));
  const admin = await as(owner);

  assert.equal((await admin.post(
    `/admin/finance/reconciliation/exceptions/${x.id}/resolve`, { note: 'ok' })).status, 400,
    'a one-word dismissal is not a resolution');

  const r = await admin.post(`/admin/finance/reconciliation/exceptions/${x.id}/resolve`,
    { note: 'Provider confirmed a reporting error on their side; reissued next cycle.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'resolved');
  assert.equal(r.body.resolved_by, owner.id);

  /* Resolving records a judgement; it does not apply a fee. */
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 0);
  assert.equal((await paymentOf(o.payment.id)).reconciled_at, null);

  const audit = await pool.query(
    `SELECT 1 FROM audit_log WHERE action='reconciliation.exception.resolved'`);
  assert.equal(audit.rowCount, 1);
});

test('only payout.manage may run the importer or resolve a difference', async () => {
  const o = await paidOrder();
  reconPages = [[line(o, { payment_amount: '1.00' })]];
  await runImport();
  const x = row(await pool.query(`SELECT * FROM reconciliation_exception`));

  const student = await makeUser(pool, { phone: '+919777000111', name: 'S' });
  const cs = await as(student);
  assert.equal((await cs.post('/admin/finance/reconciliation/import', {})).status, 403);
  assert.equal((await cs.get('/admin/finance/reconciliation')).status, 403);
  assert.equal((await cs.post(
    `/admin/finance/reconciliation/exceptions/${x.id}/resolve`, { note: 'let me in please' }))
    .status, 403);
});

/* ======================= 14. the scheduled run ========================== */

test('the scheduled run reconciles a rolling window, at most once a day', async () => {
  const o = await paidOrder();
  reconPages = [[line(o)]];

  const first = await recon.runScheduledReconciliation({});
  assert.equal(first.ran, true);
  assert.equal(first.state, 'completed');
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 264);

  /* A second tick the same day does nothing. Not because a re-run would
     corrupt anything — it would not — but because 1,440 identical import
     rows a day is a history nobody can read. */
  const second = await recon.runScheduledReconciliation({});
  assert.equal(second.ran, false);
  assert.match(second.reason, /already reconciled today/);

  const imports = await pool.query(`SELECT count(*)::int AS n FROM provider_settlement_import`);
  assert.equal(imports.rows[0].n, 1);
});

test('a FAILED scheduled run does not block the next attempt', async () => {
  const o = await paidOrder();
  reconMode = 'error';
  const bad = await recon.runScheduledReconciliation({});
  assert.equal(bad.failed, true, 'the failure is reported, not swallowed into a success');

  /* A failed run must not count as "reconciled today" — otherwise one bad
     morning would silently skip a whole day's books. */
  reconMode = 'ok';
  reconPages = [[line(o)]];
  const good = await recon.runScheduledReconciliation({});
  assert.equal(good.ran, true);
  assert.equal(good.state, 'completed');
  assert.equal((await snapshotOf(o.orderId)).gateway_fee_paise, 264);
});

test('an unknown provider is refused before any import row is written', async () => {
  /* Configuration is read once at boot, so "unconfigured" is not a state a
     running process enters — which is why this tests the reachable guard:
     a provider this build has no adapter for. It must refuse with a 503-shaped
     error and, importantly, leave nothing behind that reads as a run. */
  await assert.rejects(
    () => recon.importSettlements({ provider: 'not_a_gateway',
                                    from: '2026-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' }),
    /Unknown payment provider/);
  const imports = await pool.query(`SELECT count(*)::int AS n FROM provider_settlement_import`);
  assert.equal(imports.rows[0].n, 0,
    'a refused import must not leave an import row claiming it happened');
});
