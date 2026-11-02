import { test, expect } from '@playwright/test';
import { db, userWith, signInAs, watchProblems, vendor, partnerReady } from './helpers.mjs';

const uniq = () => `${Date.now() % 1000000}`;
const near = { latitude: 30.4172, longitude: 77.9681 };

test('cafe discovery works signed out, and a sign-in is offered', async ({ page }) => {
  const problems = watchProblems(page);
  await vendor('Discovery Cafe');
  await page.goto('/web/#/cafes');
  await expect(page.locator('body')).toBeVisible();
  await page.waitForTimeout(800);
  const status = await page.evaluate(async () => (await fetch('/api/vendors')).status);
  expect(status).toBe(200);
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
});

test('a partner chooses to share: a clear notice first, a visible indicator after, and it stops on request', async ({ browser }) => {
  const context = await browser.newContext({ geolocation: near, permissions: ['geolocation'], viewport: { width: 390, height: 844 } });
  const v = await vendor('Share Cafe');
  const cust = await userWith({ name: 'Share Customer' });
  const partner = await userWith({ name: 'Share Partner', roles: ['student', 'delivery_partner'], email: `share.${uniq()}@stu.upes.ac.in` });
  await partnerReady(partner.id);
  const { rows: [order] } = await db.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id, destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery','picked_up',9000,10000,$4,'{"name":"Block 4"}','+919999900002','manual_map_spot',30.4172,77.9681) RETURNING id`,
    [`S${uniq()}`, cust.id, v.id, partner.id]);
  await signInAs(context, partner.id, 'code');
  const page = await context.newPage();
  await page.goto('/web/#/partner');

  const start = page.getByRole('button', { name: 'Start sharing' });
  await start.waitFor({ timeout: 15000 }).catch(async () => { throw new Error(`partner screen: ${(await page.locator('body').innerText()).slice(0, 400)} @ ${page.url()}`); });
  await expect(start).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/no location history is kept/)).toBeVisible();
  expect((await db.query(`SELECT count(*)::int n FROM partner_location WHERE order_id = $1`, [order.id])).rows[0].n, 'nothing before the choice').toBe(0);

  await start.click();
  await expect(page.getByText('Sharing your location')).toBeVisible();
  await expect.poll(async () => (await db.query(`SELECT count(*)::int n FROM partner_location WHERE order_id = $1`, [order.id])).rows[0].n, { timeout: 15000 }).toBe(1);
  const c = (await db.query(`SELECT notice_version, stopped_at FROM location_share_consent WHERE order_id = $1`, [order.id])).rows[0];
  expect(c.notice_version).toBeTruthy();
  expect(c.stopped_at).toBeNull();

  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await expect.poll(async () => (await db.query(`SELECT count(*)::int n FROM partner_location WHERE order_id = $1`, [order.id])).rows[0].n, { timeout: 10000 }).toBe(0);
  await expect(page.getByRole('button', { name: 'Start sharing' })).toBeVisible();
  await context.close();
});

test('GPS permission denied: the partner is told what to do and no position is stored', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const v = await vendor('Denied Cafe');
  const cust = await userWith({ name: 'Denied Customer' });
  const partner = await userWith({ name: 'Denied Partner', roles: ['student', 'delivery_partner'], email: `denied.${uniq()}@stu.upes.ac.in` });
  await partnerReady(partner.id);
  const { rows: [order] } = await db.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id, destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery','picked_up',9000,10000,$4,'{"name":"Block 4"}','+919999900002','manual_map_spot',30.4172,77.9681) RETURNING id`,
    [`D${uniq()}`, cust.id, v.id, partner.id]);
  await signInAs(context, partner.id, 'code');
  const page = await context.newPage();
  /* Chromium with no granted permission and no prompt UI answers "denied". */
  await page.addInitScript(() => {
    navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: 1, PERMISSION_DENIED: 1, message: 'denied' }), 50); return 1; };
  });
  await page.goto('/web/#/partner');
  await page.getByRole('button', { name: 'Start sharing' }).click({ timeout: 15000 });
  await expect(page.getByText(/Location is blocked for this site/)).toBeVisible();
  expect((await db.query(`SELECT count(*)::int n FROM partner_location WHERE order_id = $1`, [order.id])).rows[0].n).toBe(0);
  await context.close();
});

test('Counter shows a first name and status for an order on its way, and no coordinates', async ({ page, context }) => {
  const problems = watchProblems(page);
  const v = await vendor('Counter Cafe');
  const cust = await userWith({ name: 'Counter Customer' });
  const partner = await userWith({ name: 'Priya Sharma', roles: ['student', 'delivery_partner'] });
  await db.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id, destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery','picked_up',9000,10000,$4,'{"name":"Block 4"}','+919999900002','manual_map_spot',30.4172,77.9681)`,
    [`C${uniq()}`, cust.id, v.id, partner.id]);
  const staff = await userWith({ name: 'Counter Staff', roles: ['vendor_owner'], vendorId: v.id });
  await signInAs(context, staff.id, 'code');
  const bodies = [];
  page.on('response', async (r) => { if (/delivery-status/.test(r.url())) bodies.push(await r.text()); });
  await page.goto('/shop/');
  await expect(page.locator('[data-delivery-status]').first()).toContainText('Priya', { timeout: 15000 });
  expect(bodies.join('')).not.toContain('Sharma');
  expect(bodies.join('')).not.toMatch(/"lat|"lng/);
  expect(problems.filter((p) => /Content Security Policy|Refused/.test(p))).toEqual([]);
});

test('Campus Control sign-in page loads under the enforced CSP with no violations', async ({ page }) => {
  const problems = watchProblems(page);
  const res = await page.goto('/admin/');
  expect(res.headers()['content-security-policy'], 'the policy really is enforced here').toBeTruthy();
  await expect(page.locator('input[type=email], input[name=email]').first()).toBeVisible();
  expect(problems).toEqual([]);
});

test('the student site stays report-only until checkout can be tested', async ({ page }) => {
  const res = await page.goto('/web/');
  expect(res.headers()['content-security-policy-report-only']).toBeTruthy();
  expect(res.headers()['content-security-policy']).toBeUndefined();
});

test('an injected script is really blocked on Campus Control', async ({ page }) => {
  await page.goto('/admin/');
  const ran = await page.evaluate(() => new Promise((resolve) => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = 1';
    document.head.append(s);
    setTimeout(() => resolve(window.__injected === 1), 100);
  }));
  expect(ran).toBe(false);
  const remote = await page.evaluate(() => new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://evil.example/x.js';
    s.onerror = () => resolve('blocked');
    s.onload = () => resolve('loaded');
    document.head.append(s);
    setTimeout(() => resolve('blocked'), 1500);
  }));
  expect(remote).toBe('blocked');
});
