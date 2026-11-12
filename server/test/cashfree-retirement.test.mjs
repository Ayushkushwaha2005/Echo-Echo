/* ==========================================================================
   CASHFREE RETIREMENT — the gateway cannot come back.

   Cashfree was retired on 12 November 2026 (docs/CASHFREE-RETIREMENT.md).
   This file is the enforcement: it configures the server EXACTLY as a
   deployment that still carried every Cashfree variable would, points those
   variables at a live local stub, and proves that

     · the variables are ignored: Cashfree is never configured, never active
     · no new payment can be initiated through it
     · its webhook endpoint accepts nothing and records nothing
     · a historical Cashfree payment is still visible, still refundable only
       by a person, and never re-processed or pulled from the gateway
     · the stub receives zero requests throughout
     · the Cashfree-specific admin routes refuse
     · no source, bundle, CSP, Blueprint or env template still wires it

   Historical rows are inserted the way the live adapter wrote them, and
   nothing here deletes or rewrites one.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus }
  from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const serverRoot = dirname(fileURLToPath(new URL('.', import.meta.url)));
const repoRoot = join(serverRoot, '..');

const APP_ID = 'PRODAPP_retired_not_real';
const SECRET = 'cfsk_retired_secret_not_real_' + 'q'.repeat(16);

let app, pool, stub, stubUrl;
const stubCalls = [];

before(async () => {
  await startDb();
  await new Promise((resolve) => {
    stub = createServer((req, res) => {
      stubCalls.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    stub.listen(0, '127.0.0.1', () => { stubUrl = `http://127.0.0.1:${stub.address().port}`; resolve(); });
  });
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    WEB_ORIGIN: 'http://localhost:3000', SWEEPER: 'off', NODE_ENV: 'test',
    /* The full pre-retirement configuration, every variable present. */
    PAYMENT_PROVIDER: 'cashfree',
    CASHFREE_PG_APP_ID: APP_ID, CASHFREE_PG_SECRET_KEY: SECRET, CASHFREE_PG_BASE_URL: stubUrl,
    CASHFREE_PG_NOTIFY_URL: 'https://api.example/payments/webhook', CASHFREE_EASY_SPLIT: 'on',
    PAYOUT_PROVIDER: 'cashfree',
    CASHFREE_PAYOUT_CLIENT_ID: 'CF_retired', CASHFREE_PAYOUT_CLIENT_SECRET: 'not_real',
    CASHFREE_PAYOUT_BASE_URL: stubUrl,
  });
  ({ pool } = await import('../src/db/index.js'));
  const { build } = await import('../src/index.js');
  app = await build();
});

after(async () => {
  await app?.close();
  await pool?.end();
  await new Promise((r) => stub.close(r));
  await stopDb();
  for (const k of Object.keys(process.env)) if (/^CASHFREE_|^PAYMENT_PROVIDER$|^PAYOUT_PROVIDER$/.test(k)) delete process.env[k];
});

beforeEach(async () => { await truncateAll(pool); stubCalls.length = 0; });

const as = async (u, opts) => client(app, await sessionFor(pool, u.id, opts));
let seq = 0;
const phone = () => '+9197' + String(20000000 + (++seq) * 7919 % 79999999).padStart(8, '0');

/* Signed exactly as Cashfree signed its webhooks when it was live. */
function cfSigned(payload, url = '/payments/webhook/cashfree') {
  const raw = JSON.stringify(payload);
  const ts = String(Date.now());
  return { method: 'POST', url, payload: raw, headers: {
    'content-type': 'application/json', 'x-webhook-timestamp': ts,
    'x-webhook-signature': createHmac('sha256', SECRET).update(ts + raw).digest('base64'),
    'x-idempotency-key': 'idem_' + Math.random() } };
}
const cfSuccess = (orderId, amount) => ({
  type: 'PAYMENT_SUCCESS_WEBHOOK',
  data: { order: { order_id: orderId, order_amount: amount, order_currency: 'INR' },
          payment: { cf_payment_id: 990001, payment_status: 'SUCCESS', payment_amount: amount, payment_currency: 'INR' } },
});

async function draft() {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'Tulips', slug: 'tulips-' + seq });
  const i = await makeItem(pool, v.id, { name: 'Softy', paise: 7000 });
  const u = await makeUser(pool, { phone: phone(), name: 'Ravi' });
  const c = await as(u);
  const d = await c.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: i.id, qty: 2 }],
    fulfilment: 'delivery', destinationId: n.blockB.id });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  return { u, c, v, draft: d.body };
}

/* A Cashfree attempt as the live adapter left it: pending, awaiting payment. */
async function historicalPending() {
  const o = await draft();
  const pay = (await pool.query(
    `INSERT INTO payment (order_id, provider, amount_paise, status, provider_order_id, provider_session_id)
     VALUES ($1,'cashfree',$2,'pending',$3,$4) RETURNING *`,
    [o.draft.id, o.draft.total_paise, 'cf_hist_' + seq, 'session_hist_' + seq])).rows[0];
  await pool.query(`UPDATE food_order SET state='awaiting_payment' WHERE id=$1`, [o.draft.id]);
  return { ...o, pay };
}

/* A Cashfree payment captured while it was live: paid, order confirmed. */
async function historicalPaid() {
  const o = await draft();
  const pay = (await pool.query(
    `INSERT INTO payment (order_id, provider, amount_paise, status, provider_order_id, provider_payment_id, settled_at)
     VALUES ($1,'cashfree',$2,'paid',$3,$4, now() - interval '20 days') RETURNING *`,
    [o.draft.id, o.draft.total_paise, 'cf_paid_' + seq, '5114' + seq])).rows[0];
  await pool.query(`UPDATE food_order SET state='confirmed' WHERE id=$1`, [o.draft.id]);
  await pool.query(`INSERT INTO payment_webhook (provider, event_id, payload, event_type)
                    VALUES ('cashfree',$1,'{}','PAYMENT_SUCCESS_WEBHOOK')`, ['hist_evt_' + seq]);
  return { ...o, pay };
}
const stateOf = async (id) => (await pool.query(`SELECT state FROM food_order WHERE id=$1`, [id])).rows[0].state;
const count = async (sql, p = []) => (await pool.query(sql, p)).rows[0].n;
const admin = async () => as(await makeUser(pool, { phone: phone(), name: 'Admin', roles: ['platform_admin'] }), { method: 'passkey' });

/* ---------- configuration ------------------------------------------------ */
test('every Cashfree variable is present and every one is ignored', async () => {
  const { PAYMENTS, PAYOUTS } = await import('../src/config.js');
  assert.equal(process.env.CASHFREE_PG_APP_ID, APP_ID, 'the environment really holds the old setting');
  assert.equal(PAYMENTS.provider, 'cashfree', 'the deployment asked for it');
  assert.equal(PAYMENTS.configured, false, 'and did not get it');
  assert.equal(PAYMENTS.providerConfigured('cashfree'), false);
  assert.deepEqual(PAYMENTS.configuredProviders.filter((p) => p === 'cashfree'), []);
  assert.deepEqual(PAYMENTS.publicConfig, {}, 'nothing Cashfree reaches a browser');
  assert.equal(PAYMENTS.cashfree.easySplit, false, 'CASHFREE_EASY_SPLIT=on changes nothing');
  assert.equal(PAYOUTS.configured, false);
  assert.equal(PAYOUTS.method, null);
  assert.equal(JSON.stringify(PAYMENTS).includes(APP_ID), false, 'the app id is not even read into config');
});

test('the registry knows the id (history resolves) but never hands out a working adapter', async () => {
  const reg = await import('../src/services/providers/index.js');
  assert.ok(reg.PROVIDER_IDS.includes('cashfree'), 'a historical row is a known provider, not an "unknown" one');
  assert.equal(reg.cashfree.retired, true);
  assert.equal(reg.cashfree.configured, false);
  assert.equal(reg.activeAdapter(), null);
  assert.equal(reg.configuredAdapter('cashfree'), null);
  assert.equal(reg.configuredAdapters().some((a) => a.id === 'cashfree'), false);
  assert.throws(() => reg.adapterFor('cashfree'), (e) => e.status === 503 && /retired/.test(e.detail));
  assert.throws(() => reg.requireAdapter(), (e) => e.status === 503);
  assert.deepEqual(reg.capabilitiesOf(reg.cashfree), { requiresCustomerPhone: true, supportsSplits: false });
  assert.deepEqual(reg.publicConfigOf(reg.cashfree), {});
  const payouts = await import('../src/services/payout-providers.js');
  assert.equal(payouts.cashfree.retired, true);
  assert.equal(payouts.activeAdapter(), null);
  await assert.rejects(() => payouts.cashfree.send({}, {}), (e) => e.status === 503 && /retired/.test(e.detail));
  await assert.rejects(() => payouts.sendPayout({}, {}), (e) => e.status === 503);
});

/* ---------- no new payment ----------------------------------------------- */
test('checkout cannot start: the intent is refused, no payment row, no order change, no call to Cashfree', async () => {
  const { c, draft: d } = await draft();
  const r = await c.post('/payments/intent', { orderId: d.id });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, 'configuration_required');
  assert.equal(await count(`SELECT count(*)::int AS n FROM payment`), 0);
  assert.equal(await stateOf(d.id), 'draft');
  assert.deepEqual(stubCalls, []);
});

/* ---------- webhooks ----------------------------------------------------- */
test('a perfectly signed Cashfree success on /payments/webhook/cashfree is refused and records nothing', async () => {
  const { draft: d, pay } = await historicalPending();
  const r = await app.inject(cfSigned(cfSuccess(pay.provider_order_id, '140.00')));
  assert.equal(r.statusCode, 503);
  assert.equal(await stateOf(d.id), 'awaiting_payment');
  assert.equal((await pool.query(`SELECT status FROM payment WHERE id=$1`, [pay.id])).rows[0].status, 'pending');
  assert.equal(await count(`SELECT count(*)::int AS n FROM payment_webhook`), 0, 'nothing unverified is stored');
  assert.equal(await count(`SELECT count(*)::int AS n FROM ledger_txn`), 0, 'no money moved');
});

test('the active webhook endpoint is closed too, and an unknown provider name is still a 404', async () => {
  const { pay } = await historicalPending();
  assert.equal((await app.inject(cfSigned(cfSuccess(pay.provider_order_id, '140.00'), '/payments/webhook'))).statusCode, 503);
  assert.equal((await app.inject(cfSigned(cfSuccess(pay.provider_order_id, '140.00'), '/payments/webhook/cashfreepg'))).statusCode, 404);
  assert.equal(await count(`SELECT count(*)::int AS n FROM payment_webhook`), 0);
});

/* ---------- history ------------------------------------------------------ */
test('a pending historical attempt is reported from the database and never pulled from Cashfree', async () => {
  const { c, draft: d } = await historicalPending();
  const st = await c.get(`/payments/status?orderId=${d.id}`);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.confirmed, false);
  assert.equal(st.body.orderState, 'awaiting_payment');
  assert.deepEqual(stubCalls, [], 'no status pull left the server');
});

test('a paid historical Cashfree payment stays on record, visible to finance, with its webhook history', async () => {
  const { draft: d, pay } = await historicalPaid();
  const a = await admin();
  const list = await a.get('/admin/payments?provider=cashfree');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.total, 1);
  assert.equal(list.body.payments[0].id, pay.id);
  assert.equal(list.body.payments[0].order_code, d.code);
  assert.equal(list.body.payments[0].status, 'paid');
  assert.equal(list.body.totals.collectedPaise, pay.amount_paise);
  assert.equal(await count(`SELECT count(*)::int AS n FROM payment_webhook WHERE provider='cashfree'`), 1);
  assert.equal(await stateOf(d.id), 'confirmed', 'nothing about the order was touched');
});

test('a refund on a historical Cashfree payment is refused before anything is written, and moves no money', async () => {
  /* With Cashfree still selected as the (retired, so unconfigured) active
     provider, the refund route refuses at its door: no gateway, no refund.
     The case where another provider is active and the historical row is
     resolved to the retired adapter by name is in providers-isolation. */
  const { draft: d, pay } = await historicalPaid();
  const a = await admin();
  const r = await a.post('/refunds', { orderId: d.id, reason: 'customer never received it' });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, 'configuration_required');
  const refunds = (await pool.query(`SELECT state, error FROM refund WHERE payment_id=$1`, [pay.id])).rows;
  assert.equal(refunds.length, 0, 'nothing was written');
  assert.equal(await count(`SELECT count(*)::int AS n FROM refund_allocation`), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM ledger_txn`), 0);
  assert.equal((await pool.query(`SELECT status FROM payment WHERE id=$1`, [pay.id])).rows[0].status, 'paid');
  assert.deepEqual(stubCalls, [], 'Cashfree was not asked');
});

/* ---------- Cashfree-specific admin and partner routes ------------------- */
test('Easy Split routes refuse without touching anything', async () => {
  const { v } = await draft();
  const a = await admin();
  const put = await a.put(`/admin/vendors/${v.id}/easy-split`, { providerVendorId: 'cf_vendor_1' });
  assert.equal(put.status, 503);
  assert.match(JSON.stringify(put.body), /retired/i);
  const settled = await a.post(`/admin/vendors/${v.id}/easy-split/settled`, { reference: 'UTR0001' });
  assert.equal(settled.status, 503);
  assert.equal(await count(`SELECT count(*)::int AS n FROM vendor_split_account`), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM payout`), 0);
  const accounts = await a.get('/admin/finance/settlement-accounts');
  assert.equal(accounts.status, 200);
  assert.equal(accounts.body.easySplitEnabled, false);
});

test('payout details are refused rather than registered with a retired provider, and nothing is stored', async () => {
  const { makePartnerReady } = await import('./helpers/db.mjs');
  const p = await makeUser(pool, { phone: phone(), name: 'Partner', roles: ['student', 'delivery_partner'] });
  await makePartnerReady(pool, p.id);
  const r = await (await as(p)).put('/partner/payout-method',
    { instrument: 'upi', holderName: 'Partner Tester', vpa: 'partner@okaxis' });
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(await count(`SELECT count(*)::int AS n FROM payout_destination`), 0);
  assert.deepEqual(stubCalls, []);
});

/* ---------- nothing wires it any more ----------------------------------- */
const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    if (['node_modules', 'var', 'dist', '.git', 'prototype'].includes(f)) continue;
    const p = join(dir, f);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};

test('no server source reads a CASHFREE_* variable or addresses a Cashfree host', () => {
  const offenders = [];
  for (const f of walk(join(serverRoot, 'src')).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(f, 'utf8');
    if (/\b(env|bool)\(\s*'CASHFREE_|process\.env\.CASHFREE_|process\.env\[\s*'CASHFREE_/.test(src)) offenders.push(`${f}: reads CASHFREE_*`);
    if (/(api|sandbox|sdk|payout)\.cashfree\.com/.test(src)) offenders.push(`${f}: Cashfree host`);
  }
  assert.deepEqual(offenders, []);
});

test('the retired adapter has no outbound call and the live one cannot be re-imported from history', () => {
  const src = readFileSync(join(serverRoot, 'src', 'services', 'providers', 'cashfree.js'), 'utf8');
  assert.ok(!/fetch\(/.test(src), 'no HTTP call remains');
  assert.ok(!/createHmac|timingSafeEqual/.test(src), 'no signature code remains');
  assert.ok(/retired: true/.test(src));
});

test('the student bundle, CSP, Render Blueprint and env template carry no Cashfree', () => {
  const web = readFileSync(join(repoRoot, 'web', 'src', 'app.js'), 'utf8');
  assert.ok(!/cashfree/i.test(web), 'web/src/app.js');
  const csp = readFileSync(join(repoRoot, 'vercel.json'), 'utf8');
  assert.ok(!/cashfree/i.test(csp), 'vercel.json CSP');
  const yaml = readFileSync(join(repoRoot, 'render.yaml'), 'utf8');
  assert.ok(!/^\s*- key: CASHFREE_/m.test(yaml), 'render.yaml declares no Cashfree key');
  assert.ok(!/value: *cashfree/.test(yaml), 'render.yaml must not select cashfree');
  const env = readFileSync(join(serverRoot, '.env.example'), 'utf8');
  assert.ok(!/^\s*#?\s*CASHFREE_[A-Z_]*=/m.test(env), '.env.example documents no Cashfree variable');
});
