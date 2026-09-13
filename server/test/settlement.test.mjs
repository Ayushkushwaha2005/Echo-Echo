/* ==========================================================================
   SCHEDULED SETTLEMENT — daily cafeterias, weekly partners

   The business rule being tested: cafeterias settle every evening at 20:00
   campus time, delivery partners once a week, nobody types an amount, and
   NOTHING moves money without a person releasing it.

   Time is injected rather than waited for: `runSettlementSchedules({ now })`
   takes the instant to evaluate, so 8 PM on a Monday in Kolkata is a value,
   not a twenty-hour test.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus, setTerms }
  from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const WEBHOOK_SECRET = 'whsec_test_' + 'b'.repeat(24);
let app, pool, stub, stubUrl, campus, settlement;

function startStub() {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'order_stub_' + Math.random().toString(36).slice(2),
                                 amount: parsed.amount, status: 'created' }));
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
  process.env.SWEEPER = 'off';                 // the scheduler is driven by hand here
  process.env.NODE_ENV = 'test';
  process.env.PAYMENT_PROVIDER = 'razorpay';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_localstub';
  process.env.RAZORPAY_KEY_SECRET = 'stub_secret_not_real';
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.RAZORPAY_BASE_URL = stubUrl;

  ({ pool } = await import('../src/db/index.js'));
  settlement = await import('../src/services/settlement.js');
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
const row = (r) => (r.rows[0] || null);

/* 8 PM in Kolkata is 14:30 UTC. These are the instants the schedule is
   evaluated against; nothing waits for a real clock. */
const IST_8PM_MON = new Date('2026-09-07T14:30:00Z');   // Monday 2026-09-07, 20:00 IST
const IST_7PM_MON = new Date('2026-09-07T13:30:00Z');   // 19:00 IST — too early
const IST_8PM_TUE = new Date('2026-09-08T14:30:00Z');   // Tuesday
const IST_11PM_MON = new Date('2026-09-07T17:30:00Z');  // 23:00 IST — a late catch-up

async function makePlatformOwner() {
  const u = await makeUser(pool, { phone: '+919000000000', name: 'Owner',
                                   roles: ['platform_owner'] });
  return u;
}

/* One paid delivery order: 100 food, 2% commission, 5 platform fee,
   10 delivery charged and earned. */
async function paidOrder({ partner = null } = {}) {
  const vendor = await makeVendor(pool, { name: 'Frisco', slug: 'f-' + Math.random() });
  const item = await makeItem(pool, vendor.id, { name: 'Thali', paise: 10000 });
  const customer = await makeUser(pool, {
    phone: '+9198' + String(Math.floor(Math.random() * 90000000) + 10000000), name: 'Customer' });
  await setTerms(pool, { commission_bps: 200, platform_fee_flat_paise: 500,
                         delivery_fee_paise: 1000, delivery_earning_paise: 1000 });
  const cs = await as(customer);
  const draft = await cs.post('/orders/draft', {
    vendorId: vendor.id, lines: [{ itemId: item.id, qty: 1 }],
    fulfilment: 'delivery', destinationId: campus.blockB.id });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));

  const intent = await cs.post('/payments/intent', { orderId: draft.body.id });
  const payload = { event: 'payment.captured', payload: { payment: { entity: {
    id: 'pay_' + Math.random(), order_id: intent.body.gatewayOrderId,
    amount: intent.body.amountPaise, status: 'captured' } } } };
  const raw = JSON.stringify(payload);
  await app.inject({ method: 'POST', url: '/payments/webhook', payload: raw, headers: {
    'content-type': 'application/json',
    'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
    'x-razorpay-event-id': 'evt_' + Math.random() } });

  if (partner) {
    await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1,'approved')
                      ON CONFLICT (user_id) DO NOTHING`, [partner.id]);
    await pool.query(`UPDATE food_order SET state='picked_up', partner_id=$2 WHERE id=$1`,
                     [draft.body.id, partner.id]);
    const code = await cs.get(`/orders/${draft.body.id}/handoff-code`);
    const done = await (await as(partner)).post(`/orders/${draft.body.id}/handoff`,
                                                { code: code.body.code });
    assert.equal(done.status, 200, JSON.stringify(done.body));
  }
  return { vendor, customer, orderId: draft.body.id };
}

/* ======================================================================
   the clock
   ====================================================================== */

test('the schedule is read in campus time, not the server\'s timezone', () => {
  const cfg = { enabled: true, hour: 20, minute: 0 };
  assert.equal(settlement.duePeriod('cafeteria', cfg, IST_7PM_MON, 'Asia/Kolkata'), null,
    '19:00 IST is too early');
  assert.deepEqual(settlement.duePeriod('cafeteria', cfg, IST_8PM_MON, 'Asia/Kolkata'),
    { periodKey: 'cafeteria:2026-09-07', label: 'evening of 2026-09-07' });

  /* The same instant in a different zone is a different evening — which is
     exactly why the zone is configured rather than assumed. */
  assert.equal(settlement.duePeriod('cafeteria', cfg, IST_8PM_MON, 'UTC'), null,
    '14:30 UTC has not reached 20:00 UTC');
});

test('the weekly partner run only fires on its weekday', () => {
  const cfg = { enabled: true, weekday: 1, hour: 20, minute: 0 };
  assert.ok(settlement.duePeriod('partner', cfg, IST_8PM_MON, 'Asia/Kolkata'), 'Monday');
  assert.equal(settlement.duePeriod('partner', cfg, IST_8PM_TUE, 'Asia/Kolkata'), null, 'Tuesday');
  assert.equal(settlement.duePeriod('partner', cfg, IST_7PM_MON, 'Asia/Kolkata'), null, 'too early');
  assert.equal(settlement.duePeriod('partner', { ...cfg, enabled: false },
                                    IST_8PM_MON, 'Asia/Kolkata'), null, 'disabled');
});

test('a disabled schedule builds nothing at all', async () => {
  await makePlatformOwner();
  await paidOrder();
  await pool.query(
    `UPDATE platform_config SET value = '{"enabled": false, "hour": 20, "minute": 0}'
      WHERE key = 'settlement_cafeteria_schedule'`);
  const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  assert.equal(out.cafeteria.due, false);
  const n = row(await pool.query(
    `SELECT count(*)::int AS n FROM payout_batch WHERE kind='cafeteria'`));
  assert.equal(n.n, 0, 'no cafeteria batch');
  /* The weekly partner run is a separate schedule and is untouched by
     disabling the daily one — Monday 20:00 is its moment too. */
  assert.equal(out.partner.built, true);
});

/* ======================================================================
   the daily cafeteria run
   ====================================================================== */

test('the 8 PM run calculates the cafeteria payable with nobody typing a number',
  async () => {
    await makePlatformOwner();
    const { vendor } = await paidOrder();

    /* Before 8 PM: nothing. */
    const early = await settlement.runSettlementSchedules({ now: IST_7PM_MON });
    assert.equal(early.cafeteria.due, false);
    assert.equal(row(await pool.query(`SELECT count(*)::int AS n FROM payout_batch`)).n, 0,
      'neither schedule has reached its hour');

    /* At 8 PM: one batch, one payout, and the amount is the ledger balance —
       gross 100 less the 2 commission. */
    const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
    assert.equal(out.cafeteria.built, true);
    assert.equal(out.cafeteria.payouts, 1);
    assert.equal(out.cafeteria.totalPaise, 9800);

    const batch = row(await pool.query(`SELECT * FROM payout_batch WHERE kind='cafeteria'`));
    assert.equal(batch.origin, 'scheduled');
    assert.equal(batch.period_key, 'cafeteria:2026-09-07');
    assert.equal(batch.state, 'open', 'built, but awaiting a human');

    const payout = row(await pool.query(`SELECT * FROM payout WHERE batch_id=$1`, [batch.id]));
    assert.equal(payout.amount_paise, 9800);
    assert.equal(payout.vendor_id, vendor.id);
    assert.equal(payout.state, 'pending');
    assert.equal(payout.paid_at, null, 'the schedule moved no money');
  });

test('gross sales, commission, refunds and adjustments all land in the payable',
  async () => {
    await makePlatformOwner();
    const admin0 = await makeUser(pool, { phone: '+919010101010', name: 'Admin',
                                          roles: ['platform_admin'] });
    const { vendor, orderId } = await paidOrder();
    const admin = await as(admin0);

    /* A refund on the order takes the cafeteria's share back off its balance.
       The refund route calls the gateway for real, so point it at a stub that
       speaks Razorpay's refund shape. */
    const refundStub = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'rfnd_1', status: 'processed' }));
    });
    await new Promise((r) => refundStub.listen(0, '127.0.0.1', r));
    const { PAYMENTS } = await import('../src/config.js');
    const restore = PAYMENTS.apiBase;
    PAYMENTS.apiBase = `http://127.0.0.1:${refundStub.address().port}`;
    const r = await admin.post('/refunds',
      { orderId, reason: 'cold food', amountPaise: 1150 });      // a tenth of 115
    PAYMENTS.apiBase = restore;
    await new Promise((res) => refundStub.close(res));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const fromCafeteria = r.body.allocation.from_cafeteria_paise;
    assert.equal(fromCafeteria, 980, 'a tenth of the 9800 the cafeteria was owed');

    /* And a deduction the admin posts by hand. */
    const adj = await admin.post('/admin/finance/adjustments',
      { vendorId: vendor.id, amountPaise: -300, reason: 'packaging', idempotencyKey: 'adj-s1' });
    assert.equal(adj.status, 200, JSON.stringify(adj.body));

    /* gross 10000 - commission 200 - refund share 980 - adjustment 300 */
    const expected = 10000 - 200 - 980 - 300;
    const stmt = row(await pool.query(
      `SELECT * FROM v_cafeteria_statement WHERE vendor_id=$1`, [vendor.id]));
    assert.equal(Number(stmt.gross_food_sales_paise), 10000);
    assert.equal(Number(stmt.commission_paise), 200);
    assert.equal(Number(stmt.refunds_paise), 980);
    assert.equal(Number(stmt.adjustments_paise), -300);
    assert.equal(Number(stmt.outstanding_paise), expected);

    const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
    assert.equal(out.cafeteria.built, true);

    const payout = row(await pool.query(
      `SELECT * FROM payout WHERE vendor_id = $1`, [vendor.id]));
    assert.equal(payout.amount_paise, expected,
      'the payout is exactly sales less commission, refunds and adjustments — ' +
      'nobody calculated it');
    assert.equal(payout.amount_paise, 8520);
  });

test('running the schedule repeatedly builds exactly one batch per evening',
  async () => {
    await makePlatformOwner();
    await paidOrder();
    const first = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
    assert.equal(first.cafeteria.built, true);

    /* Every subsequent tick between 20:00 and midnight. */
    for (const t of [IST_8PM_MON, IST_11PM_MON, new Date('2026-09-07T15:00:00Z')]) {
      const again = await settlement.runSettlementSchedules({ now: t });
      assert.equal(again.cafeteria.alreadyBuilt, true);
      assert.ok(!again.cafeteria.built);
    }
    assert.equal(row(await pool.query(
      `SELECT count(*)::int AS n FROM payout_batch WHERE kind='cafeteria'`)).n, 1);
  });

test('two instances running the schedule at once still build one batch', async () => {
  await makePlatformOwner();
  await paidOrder();
  const results = await Promise.all([
    settlement.runSettlementSchedules({ now: IST_8PM_MON }),
    settlement.runSettlementSchedules({ now: IST_8PM_MON }),
    settlement.runSettlementSchedules({ now: IST_8PM_MON }),
  ]);
  const built = results.filter((r) => r.cafeteria.built);
  assert.equal(built.length, 1, `exactly one build won, got ${built.length}`);
  assert.equal(row(await pool.query(
    `SELECT count(*)::int AS n FROM payout_batch WHERE kind='cafeteria'`)).n, 1);
  /* And crucially one payout, not three: the money was queued once. */
  assert.equal(row(await pool.query(`SELECT count(*)::int AS n FROM payout`)).n, 1);
});

test('a server that was down at 8 PM catches up when it returns', async () => {
  await makePlatformOwner();
  await paidOrder();
  /* Nothing ran at 20:00. At 23:00 the run still recognises the evening as
     due, because the question is "is it built" rather than "did it just
     strike 8". */
  const late = await settlement.runSettlementSchedules({ now: IST_11PM_MON });
  assert.equal(late.cafeteria.built, true);
  assert.equal(
    row(await pool.query(`SELECT period_key FROM payout_batch`)).period_key,
    'cafeteria:2026-09-07', 'and it settles the evening it missed, not a new one');
});

test('the next evening is a new batch', async () => {
  await makePlatformOwner();
  await paidOrder();
  await settlement.runSettlementSchedules({ now: IST_8PM_MON });

  /* A fresh day's takings. */
  await paidOrder();
  const tue = await settlement.runSettlementSchedules({ now: IST_8PM_TUE });
  assert.equal(tue.cafeteria.built, true);
  const keys = (await pool.query(
    `SELECT period_key FROM payout_batch WHERE kind='cafeteria' ORDER BY period_key`)).rows;
  assert.deepEqual(keys.map((k) => k.period_key),
                   ['cafeteria:2026-09-07', 'cafeteria:2026-09-08']);
});

test('an evening with nothing owed produces an empty batch, not a phantom payout',
  async () => {
    await makePlatformOwner();
    const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
    assert.equal(out.cafeteria.built, true);
    assert.equal(out.cafeteria.payouts, 0);
    assert.equal(row(await pool.query(`SELECT count(*)::int AS n FROM payout`)).n, 0);
  });

test('a balance below the minimum rolls over instead of being paid', async () => {
  await makePlatformOwner();
  await paidOrder();
  await pool.query(
    `UPDATE platform_config
        SET value = '{"enabled": true, "hour": 20, "minute": 0, "min_paise": 1000000}'
      WHERE key = 'settlement_cafeteria_schedule'`);
  const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  assert.equal(out.cafeteria.built, true);
  assert.equal(out.cafeteria.payouts, 0, '98 rupees is under a 10,000 rupee floor');
  /* And the money is still owed — it was not written off. */
  const stmt = row(await pool.query(`SELECT outstanding_paise FROM v_cafeteria_statement`));
  assert.equal(Number(stmt.outstanding_paise), 9800);
});

/* ======================================================================
   the weekly partner run
   ====================================================================== */

test('partners settle weekly, keyed by ISO week', async () => {
  await makePlatformOwner();
  const partner = await makeUser(pool, { phone: '+919123123123', name: 'Rider',
                                         roles: ['student', 'delivery_partner'] });
  await paidOrder({ partner });

  const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  assert.equal(out.partner.built, true);
  assert.equal(out.partner.totalPaise, 1000, 'one completed delivery at 10 rupees');

  const batch = row(await pool.query(`SELECT * FROM payout_batch WHERE kind='partner'`));
  assert.equal(batch.period_key, 'partner:2026-W37');
  assert.equal(batch.state, 'open');

  /* Tuesday is not a settlement day. */
  const tue = await settlement.runSettlementSchedules({ now: IST_8PM_TUE });
  assert.equal(tue.partner.due, false);
});

test('an undelivered order pays no partner, however many times the week runs',
  async () => {
    await makePlatformOwner();
    const partner = await makeUser(pool, { phone: '+919124124124', name: 'Rider',
                                           roles: ['student', 'delivery_partner'] });
    await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1,'approved')`,
                     [partner.id]);
    await paidOrder();                            // captured, never delivered

    const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
    assert.equal(out.partner.built, true);
    assert.equal(out.partner.payouts, 0, 'the 10 rupees is still in delivery_clearing');
  });

/* ======================================================================
   review, approve, release
   ====================================================================== */

test('a batch cannot be released before it is approved', async () => {
  const owner = await makePlatformOwner();
  await paidOrder();
  await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  const batch = row(await pool.query(`SELECT * FROM payout_batch WHERE kind='cafeteria'`));

  const admin = await as(owner);
  const early = await admin.post(`/admin/payouts/batches/${batch.id}/release`, {});
  assert.equal(early.status, 409);
  assert.match(early.body.error, /has not been approved/);
});

test('review shows the arithmetic, and approval moves no money', async () => {
  const owner = await makePlatformOwner();
  const { vendor } = await paidOrder();
  await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  const batchId = row(await pool.query(`SELECT id FROM payout_batch WHERE kind='cafeteria'`)).id;
  const admin = await as(owner);

  const review = await admin.get(`/admin/payouts/batches/${batchId}`);
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.totalPaise, 9800);
  assert.equal(review.body.counts.pending, 1);
  assert.equal(review.body.payouts[0].vendor_name, 'Frisco');
  assert.equal(review.body.payouts[0].gross_food_sales_paise, 10000,
    'the reviewer sees the sales behind the number');
  assert.equal(review.body.payouts[0].statement_commission_paise, 200);
  assert.equal(review.body.counts.withoutDestination, 1,
    'and that no payee has a provider destination yet');

  const ok = await admin.post(`/admin/payouts/batches/${batchId}/approve`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.batch.state, 'approved');
  assert.equal(ok.body.batch.approved_by, owner.id);

  /* Approval is a signature, not a transfer. */
  const bal = row(await pool.query(
    `SELECT balance_paise FROM v_account_balance
      WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
  assert.equal(Number(bal.balance_paise), 9800, 'still owed');
  assert.equal(row(await pool.query(`SELECT state FROM payout`)).state, 'pending');

  const twice = await admin.post(`/admin/payouts/batches/${batchId}/approve`, {});
  assert.equal(twice.status, 409, 'approving twice is refused');
});

test('releasing with no provider tells you what to transfer and pays nobody',
  async () => {
    const owner = await makePlatformOwner();
    const { vendor } = await paidOrder();
    await settlement.runSettlementSchedules({ now: IST_8PM_MON });
    const batchId = row(await pool.query(`SELECT id FROM payout_batch WHERE kind='cafeteria'`)).id;
    const admin = await as(owner);
    await admin.post(`/admin/payouts/batches/${batchId}/approve`, {});

    const rel = await admin.post(`/admin/payouts/batches/${batchId}/release`, {});
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    assert.equal(rel.body.released, 0);
    assert.equal(rel.body.mode, 'manual_bank_transfer');
    assert.equal(rel.body.totalPaise, 9800);
    assert.equal(rel.body.toTransfer.length, 1);
    assert.match(rel.body.note, /nothing was sent/);
    assert.equal(rel.body.provider.configured, false);

    /* Nothing was paid, so nothing was discharged. */
    assert.equal(row(await pool.query(`SELECT state FROM payout`)).state, 'pending');
    const bal = row(await pool.query(
      `SELECT balance_paise FROM v_account_balance
        WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
    assert.equal(Number(bal.balance_paise), 9800);

    /* Recording the real transfer is what settles it, and closes the batch. */
    const payoutId = rel.body.toTransfer[0].payoutId;
    const rec = await admin.post(`/admin/payouts/${payoutId}/record`, { reference: 'UTR-EVENING-1' });
    assert.equal(rec.status, 200, JSON.stringify(rec.body));
    const after = row(await pool.query(
      `SELECT balance_paise FROM v_account_balance
        WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
    assert.equal(Number(after.balance_paise), 0);
    assert.equal(row(await pool.query(`SELECT state FROM payout_batch WHERE id=$1`,
                                      [batchId])).state, 'completed');
  });

test('a failed payout can be retried, and a paid one never can', async () => {
  const owner = await makePlatformOwner();
  await paidOrder();
  await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  const admin = await as(owner);
  const payout = row(await pool.query(`SELECT * FROM payout`));

  await pool.query(
    `UPDATE payout SET state='failed', failure_reason='bank rejected' WHERE id=$1`, [payout.id]);
  const retry = await admin.post(`/admin/payouts/${payout.id}/retry`, {});
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.state, 'pending');
  assert.equal(row(await pool.query(`SELECT failure_reason FROM payout WHERE id=$1`,
                                    [payout.id])).failure_reason, null);

  await admin.post(`/admin/payouts/${payout.id}/record`, { reference: 'UTR-RETRIED' });
  const no = await admin.post(`/admin/payouts/${payout.id}/retry`, {});
  assert.equal(no.status, 409);
  assert.match(no.body.error, /already paid/);
});

test('a failed payout leaves the ledger untouched, so a retry cannot double-pay',
  async () => {
    const owner = await makePlatformOwner();
    const { vendor } = await paidOrder();
    await settlement.runSettlementSchedules({ now: IST_8PM_MON });
    const admin = await as(owner);
    const payout = row(await pool.query(`SELECT * FROM payout`));

    await pool.query(`UPDATE payout SET state='failed', failure_reason='timeout' WHERE id=$1`,
                     [payout.id]);
    const bal = () => pool.query(
      `SELECT balance_paise FROM v_account_balance
        WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id])
      .then((r) => Number(r.rows[0].balance_paise));
    assert.equal(await bal(), 9800, 'a failure discharged nothing');

    await admin.post(`/admin/payouts/${payout.id}/retry`, {});
    await admin.post(`/admin/payouts/${payout.id}/record`, { reference: 'UTR-A' });
    assert.equal(await bal(), 0);

    /* And a second record on the same payout cannot take it negative. */
    const again = await admin.post(`/admin/payouts/${payout.id}/record`, { reference: 'UTR-B' });
    assert.equal(again.status, 409);
    assert.equal(await bal(), 0);
  });

/* ======================================================================
   the schedule as an admin setting
   ====================================================================== */

test('an admin can move the settlement time without a deploy', async () => {
  const owner = await makePlatformOwner();
  const admin = await as(owner);

  const now = await admin.get('/admin/settlement/schedule');
  assert.equal(now.status, 200);
  assert.equal(now.body.timezone, 'Asia/Kolkata');
  assert.equal(now.body.cafeteria.hour, 20);
  assert.equal(now.body.partner.weekday, 1);
  assert.equal(now.body.autoRelease, false);
  assert.equal(now.body.autoReleasePossible, false, 'no provider connected');

  const upd = await admin.put('/admin/settlement/schedule', {
    cafeteria: { hour: 21, minute: 30, minPaise: 500 },
    partner: { weekday: 5, hour: 18, minute: 0 },
  });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.cafeteria.hour, 21);
  assert.equal(upd.body.partner.weekday, 5);

  /* And the new time is what the run honours. */
  await paidOrder();
  const at8 = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  assert.equal(at8.cafeteria.due, false, '20:00 is no longer the settlement hour');
  const at930 = await settlement.runSettlementSchedules({
    now: new Date('2026-09-07T16:00:00Z') });                 // 21:30 IST
  assert.equal(at930.cafeteria.built, true);
});

test('the schedule refuses nonsense and refuses auto-release with no provider',
  async () => {
    const owner = await makePlatformOwner();
    const admin = await as(owner);
    assert.equal((await admin.put('/admin/settlement/schedule',
      { cafeteria: { hour: 99 } })).status, 400);
    assert.equal((await admin.put('/admin/settlement/schedule',
      { partner: { hour: 20, weekday: 9 } })).status, 400);
    assert.equal((await admin.put('/admin/settlement/schedule',
      { timezone: 'Mars/Olympus' })).status, 400);

    const auto = await admin.put('/admin/settlement/schedule', { autoRelease: true });
    assert.equal(auto.status, 503);
    assert.equal(auto.body.code, 'configuration_required');
    assert.match(auto.body.detail, /no money moved/);
  });

test('running the schedule by hand is idempotent and needs payout.manage', async () => {
  const owner = await makePlatformOwner();
  await paidOrder();
  const admin = await as(owner);

  const first = await admin.post('/admin/settlement/run', {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await admin.post('/admin/settlement/run', {});
  assert.equal(second.status, 200);
  /* Whatever today's clock says, a second run never builds a second batch. */
  const batches = row(await pool.query(
    `SELECT count(*)::int AS n FROM payout_batch WHERE origin='scheduled'`));
  assert.ok(batches.n <= 2, 'at most one cafeteria and one partner batch');
  for (const kind of ['cafeteria', 'partner']) {
    const n = row(await pool.query(
      `SELECT count(*)::int AS n FROM payout_batch WHERE kind=$1 AND origin='scheduled'`, [kind]));
    assert.ok(n.n <= 1, `one ${kind} batch at most`);
  }

  const support = await makeUser(pool, { phone: '+919777000111', name: 'Support',
                                         roles: ['support'] });
  const ss = await as(support);
  assert.equal((await ss.post('/admin/settlement/run', {})).status, 403);
  assert.equal((await ss.put('/admin/settlement/schedule', { cafeteria: { hour: 9 } })).status, 403);
  assert.equal((await ss.get('/admin/settlement/schedule')).status, 200, 'but support may read');
});

/* ======================================================================
   unattended release — off by default, gated on a real provider
   ====================================================================== */

/* Runs `fn` with a stubbed RazorpayX payouts API configured. The config
   object is mutated directly and restored afterwards, because PAYOUTS.provider
   is read from the environment once at module load; this is the honest way to
   exercise the configured path without a real RazorpayX account. */
async function withPayoutProvider(handler, fn) {
  const { PAYOUTS } = await import('../src/config.js');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body ? JSON.parse(body) : {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const saved = { provider: PAYOUTS.provider, apiBase: PAYOUTS.apiBase,
                  x: { ...PAYOUTS.razorpayx } };
  PAYOUTS.provider = 'razorpayx';
  PAYOUTS.apiBase = `http://127.0.0.1:${server.address().port}`;
  PAYOUTS.razorpayx = { accountNumber: '2323230000000001', keyId: 'rzpx_test',
                        keySecret: 'stub_not_real', mode: 'IMPS' };
  assert.equal(PAYOUTS.configured, true, 'the stubbed provider reads as configured');
  try {
    return await fn(PAYOUTS);
  } finally {
    PAYOUTS.provider = saved.provider;
    PAYOUTS.apiBase = saved.apiBase;
    PAYOUTS.razorpayx = saved.x;
    await new Promise((r) => server.close(r));
  }
}

const processedPayout = (req, res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'pout_' + Math.random().toString(36).slice(2),
                           status: 'processed', utr: 'UTR' + Date.now(),
                           amount: body.amount }));
};

test('auto-release stays off by default even with a provider connected', async () => {
  await makePlatformOwner();
  const { vendor } = await paidOrder();
  const calls = [];
  await withPayoutProvider((req, res, b) => { calls.push(b); processedPayout(req, res, b); },
    async () => {
      const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
      assert.equal(out.cafeteria.built, true);
      assert.equal(out.cafeteria.autoReleased, undefined, 'nothing was released');
    });
  assert.equal(calls.length, 0, 'the provider was never called');
  const bal = row(await pool.query(
    `SELECT balance_paise FROM v_account_balance
      WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
  assert.equal(Number(bal.balance_paise), 9800, 'still owed, awaiting a human');
  assert.equal(row(await pool.query(`SELECT state FROM payout`)).state, 'pending');
});

test('with auto-release on and a provider connected, the evening settles itself',
  async () => {
    const owner = await makePlatformOwner();
    const { vendor } = await paidOrder();
    const calls = [];

    await withPayoutProvider((req, res, b) => { calls.push({ url: req.url, body: b,
      idem: req.headers['x-payout-idempotency'] }); processedPayout(req, res, b); },
      async () => {
        /* Auto-release is only settable through the route, which refuses it
           without a provider — here one is connected, so it is allowed. */
        const admin = await as(owner);
        const on = await admin.put('/admin/settlement/schedule', { autoRelease: true });
        assert.equal(on.status, 200, JSON.stringify(on.body));
        assert.equal(on.body.autoRelease, true);

        /* The payee has to be provisioned at the provider first — Quad stores
           the provider's fund-account id, never a bank account number. */
        const dest = await admin.put('/admin/payouts/destination',
          { vendorId: vendor.id, fundAccountId: 'fa_stub_1', label: 'Frisco current a/c' });
        assert.equal(dest.status, 200, JSON.stringify(dest.body));

        const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
        assert.equal(out.cafeteria.built, true);
        assert.deepEqual(out.cafeteria.autoReleased, { paid: 1, failed: 0, skipped: 0 });
      });

    assert.equal(calls.length, 1, 'exactly one transfer was requested');
    assert.equal(calls[0].body.amount, 9800, 'for exactly what was owed');
    assert.equal(calls[0].body.fund_account_id, 'fa_stub_1');
    assert.ok(calls[0].idem, 'sent with a payout idempotency key');

    const payout = row(await pool.query(`SELECT * FROM payout`));
    assert.equal(payout.state, 'paid');
    assert.equal(payout.method, 'razorpayx');
    assert.ok(payout.provider_payout_id, 'and it carries the provider reference');
    const bal = row(await pool.query(
      `SELECT balance_paise FROM v_account_balance
        WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
    assert.equal(Number(bal.balance_paise), 0, 'the payable is discharged');
    assert.equal(row(await pool.query(`SELECT state FROM payout_batch WHERE kind='cafeteria'`))
      .state, 'completed');
  });

test('auto-release skips a payee with no fund account rather than guessing',
  async () => {
    const owner = await makePlatformOwner();
    const { vendor } = await paidOrder();
    await withPayoutProvider(processedPayout, async () => {
      const admin = await as(owner);
      await admin.put('/admin/settlement/schedule', { autoRelease: true });
      /* No destination provisioned for this cafeteria. */
      const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
      assert.deepEqual(out.cafeteria.autoReleased, { paid: 0, failed: 0, skipped: 1 });
    });
    const bal = row(await pool.query(
      `SELECT balance_paise FROM v_account_balance
        WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
    assert.equal(Number(bal.balance_paise), 9800, 'still owed, nothing invented');
    assert.equal(row(await pool.query(`SELECT state FROM payout`)).state, 'pending');
  });

test('a provider that only queues a transfer does not mark it paid', async () => {
  const owner = await makePlatformOwner();
  const { vendor } = await paidOrder();
  await withPayoutProvider((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    /* RazorpayX moves queued → processing → processed. Only the last is money
       that actually left. */
    res.end(JSON.stringify({ id: 'pout_queued_1', status: 'queued' }));
  }, async () => {
    const admin = await as(owner);
    await admin.put('/admin/settlement/schedule', { autoRelease: true });
    await admin.put('/admin/payouts/destination',
      { vendorId: vendor.id, fundAccountId: 'fa_stub_2' });
    const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
    assert.deepEqual(out.cafeteria.autoReleased, { paid: 0, failed: 0, skipped: 0 });
  });

  const payout = row(await pool.query(`SELECT * FROM payout`));
  assert.equal(payout.state, 'processing');
  assert.equal(payout.paid_at, null);
  assert.equal(payout.provider_payout_id, 'pout_queued_1');
  const bal = row(await pool.query(
    `SELECT balance_paise FROM v_account_balance
      WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
  assert.equal(Number(bal.balance_paise), 9800, 'the payable stands until the money moves');
});

test('a provider rejection fails one line and leaves the ledger alone', async () => {
  const owner = await makePlatformOwner();
  const { vendor } = await paidOrder();
  await withPayoutProvider((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { description: 'insufficient balance' } }));
  }, async () => {
    const admin = await as(owner);
    await admin.put('/admin/settlement/schedule', { autoRelease: true });
    await admin.put('/admin/payouts/destination',
      { vendorId: vendor.id, fundAccountId: 'fa_stub_3' });
    const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
    assert.deepEqual(out.cafeteria.autoReleased, { paid: 0, failed: 1, skipped: 0 });
  });

  const payout = row(await pool.query(`SELECT * FROM payout`));
  assert.equal(payout.state, 'failed');
  assert.match(payout.failure_reason, /insufficient balance/);
  const bal = row(await pool.query(
    `SELECT balance_paise FROM v_account_balance
      WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
  assert.equal(Number(bal.balance_paise), 9800, 'a failure discharges nothing');

  /* And the admin can retry it once the account is funded. */
  const admin = await as(owner);
  assert.equal((await admin.post(`/admin/payouts/${payout.id}/retry`, {})).status, 200);
});

test('releasing a batch twice pays each line once', async () => {
  const owner = await makePlatformOwner();
  const { vendor } = await paidOrder();
  const calls = [];
  await withPayoutProvider((req, res, b) => { calls.push(b); processedPayout(req, res, b); },
    async () => {
      const admin = await as(owner);
      await admin.put('/admin/payouts/destination',
        { vendorId: vendor.id, fundAccountId: 'fa_stub_4' });
      await settlement.runSettlementSchedules({ now: IST_8PM_MON });
      const batchId = row(await pool.query(
        `SELECT id FROM payout_batch WHERE kind='cafeteria'`)).id;
      await admin.post(`/admin/payouts/batches/${batchId}/approve`, {});

      const first = await admin.post(`/admin/payouts/batches/${batchId}/release`, {});
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.released, 1);

      /* The batch is completed now, and a second release finds nothing
         pending — so the provider is not called again. */
      const second = await admin.post(`/admin/payouts/batches/${batchId}/release`, {});
      assert.equal(second.status, 200);
      assert.equal(second.body.released, 0);
    });

  assert.equal(calls.length, 1, 'the provider was called exactly once');
  const bal = row(await pool.query(
    `SELECT balance_paise FROM v_account_balance
      WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
  assert.equal(Number(bal.balance_paise), 0, 'paid once, not twice');
});

test('a cafeteria owner cannot see or drive the settlement schedule', async () => {
  await makePlatformOwner();
  const { vendor } = await paidOrder();
  const shopkeeper = await makeUser(pool, { phone: '+919555000222', name: 'Owner',
                                            roles: ['vendor_owner'], vendorId: vendor.id });
  const vs = await as(shopkeeper);
  assert.equal((await vs.get('/admin/settlement/schedule')).status, 403);
  assert.equal((await vs.post('/admin/settlement/run', {})).status, 403);
  await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  const batchId = row(await pool.query(`SELECT id FROM payout_batch WHERE kind='cafeteria'`)).id;
  assert.equal((await vs.get(`/admin/payouts/batches/${batchId}`)).status, 403);
  assert.equal((await vs.post(`/admin/payouts/batches/${batchId}/approve`, {})).status, 403);

  /* It does see its own settlement history, which is the point of the view. */
  const mine = await vs.get(`/vendors/${vendor.id}/finance`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.outstanding_paise, 9800);
});

/* ==========================================================================
   PROVIDER ADAPTERS

   The payout path is provider-agnostic by construction: nothing in
   settlement, payouts or the finance routes names a provider. These tests
   drive the SECOND adapter — Cashfree — through the same code path, against
   a stub speaking Cashfree's wire format, to prove that claim rather than
   assert it in a comment.

   What this cannot prove: that Cashfree accepts these requests. That needs
   real sandbox credentials and is listed as an external provisioning
   blocker.
   ========================================================================== */
async function withCashfreePayouts(handler, fn) {
  const { PAYOUTS } = await import('../src/config.js');
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body ? JSON.parse(body) : {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const saved = { provider: PAYOUTS.provider, base: PAYOUTS.cashfreeBase,
                  cf: { ...PAYOUTS.cashfree } };
  PAYOUTS.provider = 'cashfree';
  PAYOUTS.cashfreeBase = `http://127.0.0.1:${server.address().port}`;
  PAYOUTS.cashfree = { clientId: 'CF_TEST_ID', clientSecret: 'stub_not_real',
                       mode: 'imps', apiVersion: '2024-01-01' };
  assert.equal(PAYOUTS.configured, true, 'the stubbed Cashfree account reads as configured');
  assert.equal(PAYOUTS.method, 'cashfree_payouts');
  try {
    return await fn(PAYOUTS);
  } finally {
    PAYOUTS.provider = saved.provider;
    PAYOUTS.cashfreeBase = saved.base;
    PAYOUTS.cashfree = saved.cf;
    await new Promise((r) => server.close(r));
  }
}

test('the same settlement path pays through Cashfree without naming it anywhere',
  async () => {
    const owner = await makePlatformOwner();
    const { vendor } = await paidOrder();
    const calls = [];

    await withCashfreePayouts((req, res, b) => {
      calls.push({ url: req.url, body: b, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cf_transfer_id: 987654, transfer_id: b.transfer_id,
                               status: 'SUCCESS', transfer_utr: 'CFUTR123' }));
    }, async () => {
      const admin = await as(owner);
      assert.equal((await admin.put('/admin/settlement/schedule',
        { autoRelease: true })).status, 200);
      assert.equal((await admin.put('/admin/payouts/destination',
        { vendorId: vendor.id, fundAccountId: 'benef_stub_1' })).status, 200);

      const out = await settlement.runSettlementSchedules({ now: IST_8PM_MON });
      assert.equal(out.cafeteria.built, true);
      assert.deepEqual(out.cafeteria.autoReleased, { paid: 1, failed: 0, skipped: 0 });
    });

    assert.equal(calls.length, 1, 'exactly one transfer was requested');
    assert.match(calls[0].url, /\/payout\/transfers$/);
    /* Cashfree takes rupees as a decimal string. 9800 paise is 98.00 — and
       the conversion is integer arithmetic, never a float multiplication. */
    assert.equal(calls[0].body.transfer_amount, '98.00');
    assert.equal(calls[0].body.beneficiary_details.beneficiary_id, 'benef_stub_1');
    assert.equal(calls[0].headers['x-client-id'], 'CF_TEST_ID');
    assert.equal(calls[0].headers['x-api-version'], '2024-01-01');
    /* transfer_id IS the idempotency key: a retry returns the original. */
    assert.ok(calls[0].body.transfer_id, 'carries our payout id as the transfer id');
    assert.equal(calls[0].headers['x-request-id'], calls[0].body.transfer_id);

    const payout = row(await pool.query(`SELECT * FROM payout`));
    assert.equal(payout.state, 'paid');
    assert.equal(payout.method, 'cashfree_payouts', 'the method records which rail moved it');
    assert.equal(payout.external_reference, 'CFUTR123');
    const bal = row(await pool.query(
      `SELECT balance_paise FROM v_account_balance
        WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
    assert.equal(Number(bal.balance_paise), 0, 'the payable is discharged');
  });

test('a Cashfree transfer that is only ACCEPTED does not discharge the payable',
  async () => {
    const owner = await makePlatformOwner();
    const { vendor } = await paidOrder();

    await withCashfreePayouts((req, res, b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      /* Accepted for processing. The money has NOT left. */
      res.end(JSON.stringify({ cf_transfer_id: 11, transfer_id: b.transfer_id,
                               status: 'RECEIVED' }));
    }, async () => {
      const admin = await as(owner);
      assert.equal((await admin.put('/admin/settlement/schedule',
        { autoRelease: true })).status, 200);
      assert.equal((await admin.put('/admin/payouts/destination',
        { vendorId: vendor.id, fundAccountId: 'benef_stub_2' })).status, 200);
      await settlement.runSettlementSchedules({ now: IST_8PM_MON });
    });

    const payout = row(await pool.query(`SELECT * FROM payout`));
    assert.notEqual(payout.state, 'paid', 'accepted is not paid');
    assert.equal(payout.paid_at, null);
    const bal = row(await pool.query(
      `SELECT balance_paise FROM v_account_balance
        WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
    assert.equal(Number(bal.balance_paise), 9800,
      'the cafeteria is still owed until the transfer actually completes');
  });

test('a provider rejection fails the payout and leaves the money owed', async () => {
  const owner = await makePlatformOwner();
  const { vendor } = await paidOrder();

  await withCashfreePayouts((req, res) => {
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'beneficiary_id is not valid', type: 'invalid_request' }));
  }, async () => {
    const admin = await as(owner);
    assert.equal((await admin.put('/admin/settlement/schedule',
      { autoRelease: true })).status, 200);
    assert.equal((await admin.put('/admin/payouts/destination',
      { vendorId: vendor.id, fundAccountId: 'benef_bad' })).status, 200);
    await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  });

  const payout = row(await pool.query(`SELECT * FROM payout`));
  assert.equal(payout.state, 'failed');
  assert.match(payout.failure_reason, /cashfree 422/);
  const bal = row(await pool.query(
    `SELECT balance_paise FROM v_account_balance
      WHERE kind='cafeteria_payable' AND vendor_id=$1`, [vendor.id]));
  assert.equal(Number(bal.balance_paise), 9800, 'a failed transfer moves no money');

  /* And the failure is not terminal: the payable is intact, so a later batch
     picks it up again. That is the retry path. */
  const ledger = await pool.query(`SELECT 1 FROM ledger_txn WHERE kind = 'payout'`);
  assert.equal(ledger.rowCount, 0, 'nothing was posted for a transfer that never happened');
});

/* ======================================================================
   the dashboard's settlement-batch status vocabulary

   These are a contract with Campus Control's finance surface, so they are
   pinned. The statuses are DERIVED from the batch's review state and its
   payouts' real states — nothing writes a status column — which is exactly
   why they are worth a test: a derived value has no constraint protecting
   it, only this.
   ====================================================================== */

async function batchStatus(admin, id) {
  const r = await admin.get('/admin/payouts');
  return r.body.batches.find((b) => b.id === id)?.status;
}

test('a built, unapproved batch reports READY_FOR_APPROVAL', async () => {
  const owner = await makePlatformOwner();
  await paidOrder();
  await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  const batch = row(await pool.query(`SELECT * FROM payout_batch WHERE kind='cafeteria'`));
  const admin = await as(owner);
  assert.equal(await batchStatus(admin, batch.id), 'READY_FOR_APPROVAL');
});

test('approval moves the batch to APPROVED and no further', async () => {
  const owner = await makePlatformOwner();
  await paidOrder();
  await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  const batch = row(await pool.query(`SELECT * FROM payout_batch WHERE kind='cafeteria'`));
  const admin = await as(owner);
  await admin.post(`/admin/payouts/batches/${batch.id}/approve`, {});
  assert.equal(await batchStatus(admin, batch.id), 'APPROVED',
    'approving is a decision, not a transfer');
});

test('a batch whose payouts all settled reports PAID', async () => {
  const owner = await makePlatformOwner();
  await paidOrder();
  await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  const batch = row(await pool.query(`SELECT * FROM payout_batch WHERE kind='cafeteria'`));
  await pool.query(
    `UPDATE payout SET state='paid', paid_at=now(), method='manual_bank_transfer',
            external_reference='UTR123' WHERE batch_id=$1`, [batch.id]);
  const admin = await as(owner);
  assert.equal(await batchStatus(admin, batch.id), 'PAID');
});

test('a batch with one settled and one bounced transfer reports PARTIALLY_FAILED', async () => {
  /* The status that matters most, and the one a naive rollup loses. Rounding
     this to PAID hides a cafeteria that was not paid; rounding it to FAILED
     hides four that were. Both send somebody to the wrong place. */
  const owner = await makePlatformOwner();
  await paidOrder();
  await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  const batch = row(await pool.query(`SELECT * FROM payout_batch WHERE kind='cafeteria'`));
  const payouts = (await pool.query(
    `SELECT id FROM payout WHERE batch_id=$1 ORDER BY id`, [batch.id])).rows;

  /* One real payout exists; add a second payee's payout to the same batch so
     the batch genuinely contains both outcomes. */
  const other = await makeVendor(pool, { name: 'Chai Garam', slug: 'chai-garam-status' });
  await pool.query(
    `INSERT INTO payout (batch_id, vendor_id, amount_paise, state)
     VALUES ($1,$2,5000,'failed')`, [batch.id, other.id]);
  await pool.query(
    `UPDATE payout SET state='paid', paid_at=now(), method='manual_bank_transfer',
            external_reference='UTR999' WHERE id=$1`, [payouts[0].id]);

  const admin = await as(owner);
  assert.equal(await batchStatus(admin, batch.id), 'PARTIALLY_FAILED');
});

test('a cancelled batch reports CANCELLED whatever its payouts say', async () => {
  const owner = await makePlatformOwner();
  await paidOrder();
  await settlement.runSettlementSchedules({ now: IST_8PM_MON });
  const batch = row(await pool.query(`SELECT * FROM payout_batch WHERE kind='cafeteria'`));
  await pool.query(`UPDATE payout_batch SET state='cancelled' WHERE id=$1`, [batch.id]);
  const admin = await as(owner);
  assert.equal(await batchStatus(admin, batch.id), 'CANCELLED');
});
