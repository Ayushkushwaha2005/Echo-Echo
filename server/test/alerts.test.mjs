/* ==========================================================================
   OPERATIONS ALERTS — the owner hears about money that needs a person.

   The email provider is a local stub speaking Brevo's shape (BREVO_BASE_URL),
   as in email-brevo.test.mjs. Checked: the alert is sent, once per cooldown,
   survives a restart (the cooldown lives in the database), carries no
   personal or payment detail, never throws into the money path, and a
   payment whose amount does not match raises one.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus } from './helpers/db.mjs';

let stub, stubStatus = 201, pool, alerts;
const mailbox = [];

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      mailbox.push(JSON.parse(raw || '{}'));
      res.setHeader('content-type', 'application/json');
      res.statusCode = stubStatus;
      res.end(stubStatus === 201 ? JSON.stringify({ messageId: `<m-${mailbox.length}@stub>` }) : '{"code":"err"}');
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await startDb();
  Object.assign(process.env, {
    PLATFORM_OWNER_EMAIL: 'owner@stu.upes.ac.in', PLATFORM_OWNER_PHONE: '',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'xkeysib-test', RESEND_API_KEY: '',
    EMAIL_FROM: 'ECHO ECHO <alerts@example.org>',
    BREVO_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
    ALERT_EMAIL: 'ops@example.org', ALERT_COOLDOWN_HOURS: '6',
  });
  ({ pool } = await import('../src/db/index.js'));
  alerts = await import('../src/services/alerts.js');
});
after(async () => { await pool?.end(); await stopDb(); stub?.close(); });
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query(`DELETE FROM platform_config WHERE key LIKE 'ops_alert:%'`);
  await pool.query('TRUNCATE email_send_log');
  mailbox.length = 0; stubStatus = 201;
});
const quiet = { log: { error() {}, warn() {} } };

test('an alert reaches the configured address, prefixed and free of personal detail', async () => {
  const r = await alerts.alertOwner('reconciliation', 'Reconciliation needs a person', ['1 new: payout stuck'], quiet);
  assert.equal(r, 'sent');
  assert.equal(mailbox.length, 1);
  const m = mailbox[0];
  assert.deepEqual(m.to, [{ email: 'ops@example.org' }]);
  assert.match(m.subject, /^\[ECHO ECHO\] Reconciliation needs a person$/);
  assert.match(m.textContent, /1 new: payout stuck/);
  assert.match(m.textContent, /no customer, partner or payment details/);
});

test('the same alert is sent once per cooldown, and the cooldown survives a restart', async () => {
  assert.equal(await alerts.alertOwner('k1', 'S', [], quiet), 'sent');
  assert.equal(await alerts.alertOwner('k1', 'S', [], quiet), 'cooldown');
  /* A fresh module instance stands in for a restarted (or woken) server. */
  const again = await import(`../src/services/alerts.js?restart=${Date.now()}`);
  assert.equal(await again.alertOwner('k1', 'S', [], quiet), 'cooldown', 'remembered in the database, not in memory');
  assert.equal(await alerts.alertOwner('k2', 'S', [], quiet), 'sent', 'a different condition is not held back');
  /* Once the cooldown has passed, it can be sent again. */
  await pool.query(`UPDATE platform_config SET updated_at = now() - interval '7 hours' WHERE key = 'ops_alert:k1'`);
  assert.equal(await alerts.alertOwner('k1', 'S', [], quiet), 'sent');
  assert.equal(mailbox.length, 3);
});

test('two alerts for the same condition at the same instant send one email', async () => {
  const out = await Promise.all([1, 2, 3, 4].map(() => alerts.alertOwner('race', 'S', [], quiet)));
  assert.equal(out.filter((x) => x === 'sent').length, 1, JSON.stringify(out));
  assert.equal(mailbox.length, 1);
});

test('a provider failure never throws, and frees the slot for the next attempt', async () => {
  stubStatus = 401;
  assert.equal(await alerts.alertOwner('down', 'S', [], quiet), 'failed');
  stubStatus = 201;
  assert.equal(await alerts.alertOwner('down', 'S', [], quiet), 'sent');
});

test('a payment whose amount does not match its order raises an alert and is not confirmed', async () => {
  /* The real webhook handler, through applyOutcome: build an awaiting payment directly. */
  await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'Tulips', slug: 'tulips-alert' });
  await makeItem(pool, v.id, { name: 'Softy', paise: 5500 });
  const u = await makeUser(pool, { phone: '+919700000777', name: 'Asha' });
  const o = (await pool.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, delivery_paise, total_paise)
     VALUES ('ALRT0001', $1, $2, 'pickup', 'awaiting_payment', 5500, 0, 6500) RETURNING id`, [u.id, v.id])).rows[0];
  const pay = (await pool.query(
    `INSERT INTO payment (order_id, provider, amount_paise, status, provider_order_id)
     VALUES ($1, 'cashfree', 6500, 'pending', 'cf_alert_1') RETURNING *`, [o.id])).rows[0];
  const { applyOutcome } = await import('../src/routes/payments.js');
  const out = await applyOutcome({ id: null, actor: null, headers: {}, log: quiet.log, ip: '127.0.0.1' }, pay,
    { outcome: 'paid', amountPaise: 1, currency: 'INR', providerPaymentId: 'cf_pay_x', providerOrderId: 'cf_alert_1' }, 'webhook');
  assert.equal(out.rejected, 'amount mismatch');
  assert.equal((await pool.query(`SELECT state FROM food_order WHERE id=$1`, [o.id])).rows[0].state, 'awaiting_payment');
  for (let i = 0; i < 40 && !mailbox.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(mailbox.length, 1, 'the owner is told');
  assert.match(mailbox[0].subject, /did not match/);
  assert.ok(!/ALRT0001|cf_pay_x|cf_alert_1|\+91/.test(JSON.stringify(mailbox[0])), 'no order code, payment id or phone in the email');
});
