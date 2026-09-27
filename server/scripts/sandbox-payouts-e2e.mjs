/* ==========================================================================
   CASHFREE PAYOUTS SANDBOX END-TO-END

     node --env-file=.env.sandbox scripts/sandbox-payouts-e2e.mjs

   Real Cashfree Payouts sandbox calls, using Cashfree's published test
   beneficiaries (docs: Payouts Test Data), against the local TEST database.
   Needs PAYOUT_PROVIDER=cashfree plus the Payouts sandbox client id/secret
   and the 2FA public key in .env.sandbox. Prints statuses only.

   Outcomes are read from Cashfree (status pull) — an accepted transfer is
   never counted as paid until Cashfree reports SUCCESS.
   ========================================================================== */
const sandbox = (u) => /sandbox\.cashfree\.com/.test(u || '');
if (!sandbox(process.env.CASHFREE_PAYOUT_BASE_URL)) { console.error('Refusing: payouts base URL must be the sandbox.'); process.exit(2); }
const DRY = process.argv.includes('--dry');   // validate local fixtures only, no Cashfree calls
if (!DRY && (!process.env.CASHFREE_PAYOUT_CLIENT_ID || !process.env.CASHFREE_PAYOUT_CLIENT_SECRET)) {
  console.error('Payouts sandbox client id/secret are not configured.'); process.exit(3);
}
process.env.PAYOUT_PROVIDER = 'cashfree';

const results = [];
const record = (name, ok, note = '') => { results.push({ ok }); console.log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP'}  ${name}${note ? ' — ' + note : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = await import('../test/helpers/db.mjs');
await db.startDb();
if (!/127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL || '')) { console.error('Refusing: not the test database.'); process.exit(2); }
Object.assign(process.env, { NODE_ENV: 'test', SWEEPER: 'off', LOG_LEVEL: 'warn', WEB_ORIGIN: 'http://localhost:3000',
  COOKIE_SECRET: 'sandbox-e2e-cookie-secret-at-least-32-chars', PLATFORM_OWNER_PHONE: '+919000000000',
});
const { pool } = await import('../src/db/index.js');
const { build } = await import('../src/index.js');
const { sessionFor, client } = await import('../test/helpers/api.mjs');
const app = await build();
const wallet = await import('../src/services/wallet.js');
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const bal = async (kind, where) => Number((await q1(`SELECT COALESCE(sum(balance_paise),0)::bigint n FROM v_account_balance WHERE kind=$1 ${where}`, [kind])).n);

/* Earnings are posted through the ledger functions the handoff route uses,
   on a real captured order snapshot, so the wallet reads real ledger rows. */
const { postOrderCapture, postDeliveryEarned } = await import('../src/services/ledger.js');
const { livePolicy, quote, writeSnapshot } = await import('../src/services/pricing.js');

let n = 0;
let campus;
async function earn(partnerId, vendorId, earningPaise) {
  await db.setTerms(pool, { platform_fee_flat_paise: 1000, delivery_fee_paise: 500, delivery_earning_paise: earningPaise });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cust = (await c.query(`SELECT id FROM app_user WHERE name='Payout Customer' LIMIT 1`)).rows[0];
    const o = (await c.query(
      `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, total_paise, partner_id, destination_id, delivery_contact_phone)
       VALUES ($1,$2,$3,'delivery','delivered',0,$4,$5,'+919600009999') RETURNING *`,
      ['SBXP' + (++n) + Date.now().toString(36), cust.id, vendorId, partnerId, campus.blockB.id])).rows[0];
    const pol = await livePolicy(c, vendorId);
    const qt = quote(pol, { subtotalPaise: 10000, fulfilment: 'delivery' });
    await c.query(`UPDATE food_order SET total_paise=$2 WHERE id=$1`, [o.id, qt.customer_total_paise]);
    const snap = await writeSnapshot(c, o.id, pol.id, qt);
    const pay = (await c.query(`INSERT INTO payment (order_id, provider, amount_paise, status, provider_order_id, provider_payment_id)
                                VALUES ($1,'cashfree',$2,'paid',$3,$4) RETURNING *`,
                               [o.id, qt.customer_total_paise, 'sbx_' + o.id, 'sbxpay_' + o.id])).rows[0];
    await postOrderCapture(c, { order: o, snapshot: snap, payment: pay });
    await postDeliveryEarned(c, { order: o, snapshot: snap });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
async function settleFinal(id, ms = 150000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await pool.query(`UPDATE payout SET provider_synced_at = NULL WHERE id=$1 AND state='processing'`, [id]);
    await wallet.syncInFlightPayouts();
    const p = await q1(`SELECT state, provider_status FROM payout WHERE id=$1`, [id]);
    if (['paid', 'failed'].includes(p.state)) return p;
    await sleep(5000);
  }
  return q1(`SELECT state, provider_status FROM payout WHERE id=$1`, [id]);
}

try {
  await db.truncateAll(pool);
  campus = await db.makeCampus(pool);
  await pool.query(`INSERT INTO platform_config (key, value) VALUES ('partner_payout_config',
    '{"earning_hold_hours":0,"min_withdrawal_paise":10000,"frequency":"on_request"}')`);
  const vendor = await db.makeVendor(pool, { name: 'Sandbox Café', slug: 'sbx-cafe' });
  await db.makeUser(pool, { phone: '+919600009999', name: 'Payout Customer' });
  const owner = await db.makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['platform_owner'] });
  const admin = client(app, await sessionFor(pool, owner.id, { method: 'passkey' }));
  const partner = async (i) => {
    const u = await db.makeUser(pool, { phone: '+91960001' + String(1000 + i), name: 'Sandbox Rider', roles: ['delivery_partner'] });
    await pool.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1,'approved')`, [u.id]);
    return { u, c: client(app, await sessionFor(pool, u.id)) };
  };

  if (DRY) {
    const P = await partner(99);
    await earn(P.u.id, vendor.id, 6500); await earn(P.u.id, vendor.id, 3500);
    const w = (await P.c.get('/partner/wallet')).body;
    record('dry: fixtures produce a ₹100 available wallet from real ledger postings', w.availablePaise === 10000, JSON.stringify({ a: w.availablePaise, t: w.totalEarnedPaise }));
    record('dry: café payable accrued', await bal('cafeteria_payable', `AND vendor_id='${vendor.id}'`) === 20000);
    throw Object.assign(new Error('dry run complete'), { dry: true });
  }

  /* 1. bank payout, success */
  const P1 = await partner(1);
  const ben = await P1.c.put('/partner/payout-method', { instrument: 'bank', accountNumber: '026291800001191', ifsc: 'YESB0000262', holderName: 'Sandbox Rider' });
  record('bank beneficiary registered and verified by Cashfree', ben.body?.destination?.status === 'verified', `HTTP ${ben.status} ${ben.body?.destination?.status || ben.body?.error || ''}`);
  await earn(P1.u.id, vendor.id, 6500);
  const low = await P1.c.post('/partner/withdrawals', { idempotencyKey: 'sbx-low-1' });
  record('₹65 cannot be withdrawn', low.status === 409);
  await earn(P1.u.id, vendor.id, 3500);
  const w1 = await P1.c.post('/partner/withdrawals', { idempotencyKey: 'sbx-bank-1' });
  record('₹100 withdrawal accepted', w1.status === 200, `state ${w1.body?.state}`);
  const dup = await P1.c.post('/partner/withdrawals', { idempotencyKey: 'sbx-bank-1' });
  record('same idempotency key returns the same withdrawal', dup.body?.duplicate === true && dup.body?.id === w1.body?.id);
  const second = await P1.c.post('/partner/withdrawals', { idempotencyKey: 'sbx-bank-2' });
  record('a second withdrawal while one is live is refused', second.status === 409);
  const f1 = await settleFinal(w1.body.id);
  record('bank payout reaches PAID only on Cashfree SUCCESS', f1.state === 'paid', `${f1.state}/${f1.provider_status}`);
  record('wallet and ledger discharged exactly once', await bal('delivery_payable', `AND partner_id='${P1.u.id}'`) === 0
         && (await q1(`SELECT count(*)::int n FROM ledger_txn WHERE kind='payout' AND ref=$1`, [w1.body.id])).n === 1);

  /* 2. UPI payout, success */
  const P2 = await partner(2);
  const upi = await P2.c.put('/partner/payout-method', { instrument: 'upi', vpa: 'success@upi', holderName: 'Sandbox Rider' });
  record('UPI beneficiary registered', ['verified', 'pending'].includes(upi.body?.destination?.status), upi.body?.destination?.status || upi.body?.error);
  if (upi.body?.destination?.status !== 'verified') {
    await admin.post(`/admin/payout-destinations/${upi.body.destination.id}/verify`, { evidence: 'Cashfree sandbox test VPA success@upi (published test data)' });
  }
  await earn(P2.u.id, vendor.id, 10000);
  const w2 = await P2.c.post('/partner/withdrawals', { idempotencyKey: 'sbx-upi-1' });
  const f2 = await settleFinal(w2.body.id);
  record('UPI payout paid over UPI', f2.state === 'paid', `${f2.state}/${f2.provider_status}`);

  /* 3. refused payee: invalid account */
  const P3 = await partner(3);
  const bad = await P3.c.put('/partner/payout-method', { instrument: 'bank', accountNumber: '026291800001190', ifsc: 'YESB0000262', holderName: 'Sandbox Rider' });
  const badState = bad.body?.destination?.status;
  record('invalid account is not usable for withdrawal', badState !== 'verified', `${bad.status} ${badState || bad.body?.error || ''}`);

  /* 4. failure after acceptance, then safe retry to a good account */
  const P4 = await partner(4);
  const pf = await P4.c.put('/partner/payout-method', { instrument: 'bank', accountNumber: '7766666351000', ifsc: 'YESB0000001', holderName: 'Sandbox Rider' });
  if (pf.body?.destination?.status !== 'verified' && pf.body?.destination?.id) {
    await admin.post(`/admin/payout-destinations/${pf.body.destination.id}/verify`, { evidence: 'Cashfree sandbox test account: pending, later failure' });
  }
  await earn(P4.u.id, vendor.id, 10000);
  const w4 = await P4.c.post('/partner/withdrawals', { idempotencyKey: 'sbx-fail-1' });
  record('transfer accepted but not paid while pending', w4.body?.state !== 'paid', w4.body?.state);
  const f4 = await settleFinal(w4.body.id, 240000);
  record('pending transfer resolves to FAILED from Cashfree', f4.state === 'failed', `${f4.state}/${f4.provider_status}`);
  record('earning kept after the failure', await bal('delivery_payable', `AND partner_id='${P4.u.id}'`) === 10000);
  await P4.c.put('/partner/payout-method', { instrument: 'bank', accountNumber: '00011020001772', ifsc: 'HDFC0000001', holderName: 'Sandbox Rider' });
  const r4 = await P4.c.post(`/partner/withdrawals/${w4.body.id}/retry`);
  const fr4 = r4.body?.id ? await settleFinal(r4.body.id) : { state: 'none' };
  record('retry pays under a new transfer id, exactly once', fr4.state === 'paid' && r4.body.id !== w4.body.id
         && await bal('delivery_payable', `AND partner_id='${P4.u.id}'`) === 0, fr4.state);
  const r4b = await P4.c.post(`/partner/withdrawals/${w4.body.id}/retry`);
  record('the failed payout cannot be retried twice', r4b.status === 409);

  /* 5. timeout at Cashfree (25s, later success) */
  const P5 = await partner(5);
  const pt = await P5.c.put('/partner/payout-method', { instrument: 'bank', accountNumber: '34978321547298', ifsc: 'KKBK0000001', holderName: 'Sandbox Rider' });
  if (pt.body?.destination?.status !== 'verified' && pt.body?.destination?.id) {
    await admin.post(`/admin/payout-destinations/${pt.body.destination.id}/verify`, { evidence: 'Cashfree sandbox test account: timeout, later success' });
  }
  await earn(P5.u.id, vendor.id, 10000);
  const w5 = await P5.c.post('/partner/withdrawals', { idempotencyKey: 'sbx-timeout-1' });
  record('timeout leaves the payout processing, not paid or failed', w5.body?.state === 'processing', w5.body?.state);
  record('money not treated as paid during the timeout', await bal('delivery_payable', `AND partner_id='${P5.u.id}'`) === 10000);
  const f5 = await settleFinal(w5.body.id, 240000);
  record('timeout resolves from Cashfree status, no second transfer', f5.state === 'paid', `${f5.state}/${f5.provider_status}`);

  /* 6. café settlement */
  const acct = await admin.put(`/admin/vendors/${vendor.id}/settlement-account`, { instrument: 'bank', accountNumber: '1233943142', ifsc: 'ICIC0000009', holderName: 'Sandbox Cafe' });
  record('café settlement account verified by Cashfree', acct.body?.destination?.status === 'verified', acct.body?.destination?.status || acct.body?.error);
  const settlement = await import('../src/services/settlement.js');
  await pool.query(`INSERT INTO platform_config (key, value) VALUES ('settlement_auto_release','true') ON CONFLICT (key) DO UPDATE SET value='true'`);
  const cafeOwed = await bal('cafeteria_payable', `AND vendor_id='${vendor.id}'`);
  const run = await settlement.runSettlementSchedules({
    /* 20:30 IST today: the evening run is due. */
    now: new Date(new Date().toISOString().slice(0, 10) + 'T15:00:00Z') });
  const cp = await q1(`SELECT id FROM payout WHERE vendor_id=$1 ORDER BY created_at DESC LIMIT 1`, [vendor.id]);
  const fc = cp ? await settleFinal(cp.id) : { state: 'not built' };
  record('café evening settlement pays the whole payable once', fc.state === 'paid' && await bal('cafeteria_payable', `AND vendor_id='${vendor.id}'`) === 0,
         `owed ${cafeOwed}, ${fc.state}, run ${JSON.stringify(run.cafeteria || {})}`);

  /* 7. reconciliation */
  const s = await wallet.syncInFlightPayouts();
  const open = await q1(`SELECT count(*)::int n FROM reconciliation_exception WHERE state='open' AND kind='payout_mismatch'`);
  record('payout status reconciliation finds no mismatches', open.n === 0, JSON.stringify(s));
} catch (e) { if (!e.dry) { console.error("ERROR", String(e.message).slice(0, 300)); results.push({ ok: false }); } } finally {
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
  const f = results.filter((r) => r.ok === false).length;
  console.log(`\n${results.filter((r) => r.ok === true).length} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
}
