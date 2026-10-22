/* ==========================================================================
   CAMPUS CONTROL OPERATIONS API (src/routes/admin-ops.js)

   Enforcement is on the server: an administrator holds only the permissions
   the owner granted, and each route checks its own. Figures come from the
   ledger and money tables. Exports are audited, quote-safe and never carry
   a full account number.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeVerifiedDestination } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';
let app, pool, csvCell, toCsv, paging;
before(async () => {
  await startDb();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  ({ pool } = await import('../src/db/index.js'));
  ({ csvCell, toCsv, paging } = await import('../src/routes/admin-ops.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); await pool.query('TRUNCATE admin_account'); });

let seq = 0;
const phone = () => '+9198' + String(10000000 + (++seq) * 7717 % 89999999).padStart(8, '0');

/* An administrator holding exactly `permissions`, signed in as Campus Control is. */
async function admin(permissions) {
  const u = await makeUser(pool, { phone: phone(), name: 'Admin ' + seq, roles: ['platform_admin'] });
  await pool.query(`INSERT INTO admin_account (user_id, status, permissions, activated_at) VALUES ($1,'active',$2, now())`,
                   [u.id, permissions]);
  return { u, c: client(app, await sessionFor(pool, u.id, { method: 'passkey' })) };
}
const owner = async () => {
  const u = await makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['platform_owner'] });
  return { u, c: client(app, await sessionFor(pool, u.id, { method: 'passkey' })) };
};

/* An order with a payment, written directly: these tests are about reading. */
async function order({ vendor, code, state = 'delivered', fulfilment = 'pickup', total = 11000, payment = 'paid', at = null }) {
  const customer = await makeUser(pool, { phone: phone(), name: 'Asha ' + code });
  const o = (await pool.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now())) RETURNING *`,
    [code, customer.id, vendor.id, fulfilment, state, total - 1000, total, at])).rows[0];
  await pool.query(`INSERT INTO order_event (order_id, from_state, to_state, actor_role) VALUES ($1,NULL,'awaiting_payment','student'),($1,'awaiting_payment','confirmed','system')`, [o.id]);
  const p = (await pool.query(
    `INSERT INTO payment (order_id, provider, provider_order_id, provider_payment_id, amount_paise, status)
     VALUES ($1,'cashfree',$2,$3,$4,$5) RETURNING *`, [o.id, 'cf_' + code, 'pay_' + code, total, payment])).rows[0];
  await pool.query(`INSERT INTO payment_webhook (provider, event_id, payload, event_type) VALUES ('cashfree',$1,$2,'PAYMENT_SUCCESS_WEBHOOK')`,
                   ['evt_' + code, JSON.stringify({ data: { order: { order_id: 'cf_' + code }, payment: { secret_looking: 'x' } } })]);
  return { o, p };
}

test('an administrator without orders.view cannot list orders; one with it can; a student never can', async () => {
  const v = await makeVendor(pool, { name: 'Tulips', slug: 'tulips' });
  await order({ vendor: v, code: 'EE-1001' });
  const audits = await admin(['audit.view']);
  const r = await audits.c.get('/admin/orders');
  assert.equal(r.status, 403);
  const ops = await admin(['orders.view']);
  const ok = await ops.c.get('/admin/orders');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.total, 1);
  const student = await makeUser(pool, { phone: phone(), name: 'S' });
  assert.equal((await client(app, await sessionFor(pool, student.id)).get('/admin/orders')).status, 403);
  assert.equal((await client(app).get('/admin/orders')).status, 401);
  /* orders.view does not open the money pages. */
  assert.equal((await ops.c.get('/admin/payments')).status, 403);
  assert.equal((await ops.c.get('/admin/reports/ledger?from=2026-01-01&to=2026-12-31')).status, 403);
});

test('orders: search, state, fulfilment and payment filters, and real pagination', async () => {
  const v = await makeVendor(pool, { name: 'Chai Garam', slug: 'cg' });
  for (let i = 0; i < 4; i++) await order({ vendor: v, code: `EE-20${i}` });
  for (let i = 4; i < 7; i++) await order({ vendor: v, code: `EE-20${i}`, state: 'cancelled', payment: 'failed' });
  const { c } = await owner();
  const p1 = await c.get('/admin/orders?pageSize=3&page=1');
  assert.equal(p1.body.total, 7);
  assert.equal(p1.body.orders.length, 3);
  const p3 = await c.get('/admin/orders?pageSize=3&page=3');
  assert.equal(p3.body.orders.length, 1);
  assert.equal((await c.get('/admin/orders?q=EE-203')).body.total, 1);
  assert.equal((await c.get('/admin/orders?payment=failed')).body.total, 3);
  assert.equal((await c.get('/admin/orders?state=cancelled')).body.total, 3);
  assert.equal((await c.get('/admin/orders?fulfilment=pickup')).body.total, 7);
  assert.equal((await c.get('/admin/orders?state=nonsense')).status, 400);
  assert.equal((await c.get('/admin/orders?from=not-a-date')).status, 400);
});

test('order timeline joins state changes, payments and webhooks in order, without webhook payloads', async () => {
  const v = await makeVendor(pool, { name: 'Tulips', slug: 'tulips' });
  const { o } = await order({ vendor: v, code: 'EE-3001' });
  const { c } = await owner();
  const t = await c.get(`/admin/orders/${o.id}/timeline`);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const kinds = t.body.timeline.map((e) => e.kind);
  assert.ok(kinds.includes('state') && kinds.includes('payment') && kinds.includes('webhook'), kinds.join());
  assert.ok(!JSON.stringify(t.body).includes('secret_looking'), 'no webhook payload is returned');
  assert.equal((await c.get('/admin/orders/00000000-0000-0000-0000-000000000000/timeline')).status, 404);
  assert.equal((await c.get('/admin/orders/not-a-uuid/timeline')).status, 404);
});

test('reliability reports a balanced ledger, and flags an unbalanced transaction with the next action', async () => {
  const { c } = await owner();
  const r = await c.get('/admin/reliability');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ledger = r.body.checks.find((x) => x.id === 'ledger');
  assert.equal(ledger.ok, true);
  assert.equal(r.body.checks.find((x) => x.id === 'migrations').ok, true);

  /* The database itself refuses an unbalanced transaction at commit. */
  await pool.query(`INSERT INTO ledger_account (kind, normal) VALUES ('platform_revenue','credit') ON CONFLICT DO NOTHING`);
  const acct = (await pool.query(`SELECT id FROM ledger_account WHERE kind='platform_revenue' AND vendor_id IS NULL AND partner_id IS NULL`)).rows[0];
  const forge = async (cx, ref) => {
    await cx.query('BEGIN');
    const txn = (await cx.query(`INSERT INTO ledger_txn (kind, ref, memo) VALUES ('adjustment',$1,'test') RETURNING id`, [ref])).rows[0];
    await cx.query(`INSERT INTO ledger_entry (txn_id, account_id, amount_paise) VALUES ($1,$2,500)`, [txn.id, acct.id]);
    await cx.query('COMMIT');
  };
  const cx = await pool.connect();
  try {
    await assert.rejects(forge(cx, 'forged-1'), /does not balance/);
    await cx.query('ROLLBACK');
    /* Defence in depth: if rows ever got past that guard (a restore, a manual
       session with triggers off), the reliability check still says so. */
    await cx.query(`SET session_replication_role = replica`);
    await forge(cx, 'forged-2');
    await cx.query(`SET session_replication_role = origin`);
  } finally { cx.release(); }
  const bad = await c.get('/admin/reliability');
  const l2 = bad.body.checks.find((x) => x.id === 'ledger');
  assert.equal(l2.ok, false);
  assert.match(l2.detail, /1 unbalanced/);
  assert.ok(l2.action);
  assert.equal(bad.body.ok, false);
});

test('reliability flags a payout stuck in processing', async () => {
  const partner = await makeUser(pool, { phone: phone(), name: 'Ravi', roles: ['delivery_partner'] });
  const d = await makeVerifiedDestination(pool, { partnerId: partner.id });
  await pool.query(`INSERT INTO payout (partner_id, amount_paise, destination_id, state, created_at)
                    VALUES ($1, 10000, $2, 'processing', now() - interval '3 hours')`, [partner.id, d.id]);
  const { c } = await owner();
  const s = (await c.get('/admin/reliability')).body.checks.find((x) => x.id === 'stale_payouts');
  assert.equal(s.ok, false);
  assert.equal(s.detail, '1');
  assert.match(s.action, /Never re-send/);
});

test('CSV cells are quoted and formula-safe', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('+91 98'), `"'+91 98"`);
  assert.equal(csvCell('-5'), `"'-5"`);
  assert.equal(csvCell('@SUM'), `"'@SUM"`);
  assert.equal(csvCell(null), '""');
  assert.equal(toCsv(['a', 'b'], [{ a: 1, b: 'x,y' }]), '"a","b"\r\n"1","x,y"\r\n');
  assert.deepEqual(paging({ page: '-4', pageSize: '1000' }), { page: 1, pageSize: 100, offset: 0 });
});

test('reports: permission-checked, bounded, audited, and payouts show only the masked destination', async () => {
  const v = await makeVendor(pool, { name: '=cmd|calc', slug: 'evil' });
  await order({ vendor: v, code: 'EE-4001', at: '2026-10-10T10:00:00Z' });
  await order({ vendor: v, code: 'EE-4002', at: '2026-09-30T19:00:00Z' });   // 1 Oct, 00:30 IST
  await order({ vendor: v, code: 'EE-4003', at: '2026-09-30T18:00:00Z' });   // 30 Sep, 23:30 IST
  const partner = await makeUser(pool, { phone: phone(), name: 'Ravi', roles: ['delivery_partner'] });
  const d = await makeVerifiedDestination(pool, { partnerId: partner.id });
  await pool.query(`UPDATE payout_destination SET masked = 'XXXX9012' WHERE id = $1`, [d.id]);
  await pool.query(`INSERT INTO payout (partner_id, amount_paise, destination_id, created_at) VALUES ($1, 12345, $2, '2026-10-11T10:00:00Z')`, [partner.id, d.id]);
  const { c } = await owner();

  assert.equal((await c.get('/admin/reports/orders')).status, 400, 'a date range is required');
  assert.equal((await c.get('/admin/reports/orders?from=2025-01-01&to=2026-10-20')).status, 400, 'at most 366 days');
  assert.equal((await c.get('/admin/reports/everything?from=2026-10-01&to=2026-10-20')).status, 404);

  const r = await app.inject({ method: 'GET', url: '/admin/reports/orders?from=2026-10-01&to=2026-10-20',
                               headers: { cookie: `quad_session=${await sessionFor(pool, (await owner2()).id, { method: 'passkey' })}` } });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.headers['content-disposition'], /echoecho-orders-2026-10-01-to-2026-10-20\.csv/);
  assert.match(r.body, /"EE-4001"/);
  assert.match(r.body, /"EE-4002"/, 'a bare date is a day in IST: 00:30 IST on the 1st is included');
  assert.doesNotMatch(r.body, /"EE-4003"/, '23:30 IST on the 30th is not');
  assert.match(r.body, /"'=cmd\|calc"/, 'a hostile café name cannot become a formula');
  assert.match(r.body, /"110\.00"/, 'rupees with two decimals');

  const p = await c.get('/admin/reports/payouts?from=2026-10-01&to=2026-10-20');
  assert.equal(p.status, 200);
  assert.match(String(p.body), /XXXX9012/);
  assert.match(String(p.body), /"123\.45"/);

  const audited = (await pool.query(`SELECT resource_id, detail FROM audit_log WHERE action = 'report.export' ORDER BY at`)).rows;
  assert.deepEqual(audited.map((a) => a.resource_id), ['orders', 'payouts']);
  assert.equal(audited[0].detail.rows, 2);
});

/* A second owner-strength session for raw inject calls. */
async function owner2() {
  return (await pool.query(`SELECT u.id FROM app_user u JOIN user_role r ON r.user_id = u.id AND r.role = 'platform_owner' LIMIT 1`)).rows[0];
}

test('webhooks: deliveries and refusals are listed, payloads are not', async () => {
  const v = await makeVendor(pool, { name: 'Tulips', slug: 'tulips' });
  await order({ vendor: v, code: 'EE-5001' });
  await pool.query(`INSERT INTO audit_log (action, outcome, detail) VALUES ('payment.webhook','denied','{"reason":"bad signature"}')`);
  const { c } = await owner();
  const w = await c.get('/admin/webhooks');
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.payments.length, 1);
  assert.equal(w.body.refused[0].reason, 'bad signature');
  assert.ok(!JSON.stringify(w.body).includes('secret_looking'));
});
