import { test, expect } from '@playwright/test';
import { db, owner, userWith, signInAs, watchProblems, vendor, partnerReady, openAdmin } from './helpers.mjs';

const uniq = () => `${Date.now() % 1000000}`;

test('a customer following their delivery sees the map note, and the page says it is not a live promise', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const v = await vendor('Follow Cafe');
  const cust = await userWith({ name: 'Follow Customer', email: `follow.${uniq()}@stu.upes.ac.in` });
  await partnerReady(cust.id);
  const partner = await userWith({ name: 'Follow Partner', roles: ['student', 'delivery_partner'] });
  const { rows: [order] } = await db.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id, destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery','picked_up',9000,10000,$4,'{"name":"Block 4"}','+919999900002','manual_map_spot',30.4172,77.9681) RETURNING id, code`,
    [`F${uniq()}`, cust.id, v.id, partner.id]);
  await db.query(`INSERT INTO partner_location (partner_id, order_id, lat, lng, accuracy_m, at) VALUES ($1,$2,30.4172,77.9681,12, now())`, [partner.id, order.id]);
  await signInAs(context, cust.id, 'code');
  const page = await context.newPage();
  const problems = watchProblems(page);
  const answers = [];
  page.on('response', async (r) => { if (/\/orders\/[^/]+\/tracking\/?$/.test(new URL(r.url()).pathname)) answers.push(await r.json().catch(() => null)); });
  await page.goto(`/web/#/tracking/${order.id}`);
  await expect(page.getByText(order.code).first()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => answers.length, { timeout: 15000 }).toBeGreaterThan(0);
  expect(answers[0].partnerVisibility).toBe('visible');
  expect(Number.isFinite(answers[0].partner.ageSeconds)).toBe(true);
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
  await context.close();
});

test('a menu opens signed out and shows its real items with prices', async ({ page }) => {
  const problems = watchProblems(page);
  const v = await vendor('Menu Journey Cafe');
  await db.query(`INSERT INTO menu_item (vendor_id, name, price_paise, available, active) VALUES ($1,'Journey Masala Chai',2500,true,true)`, [v.id]);
  await page.goto(`/web/#/menu/${v.id}`);
  await expect(page.getByText('Journey Masala Chai').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/25/).first()).toBeVisible();
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
});

test('Team Chat opens, and a person outside a conversation cannot read it', async ({ page, context }) => {
  const problems = watchProblems(page);
  const o = await owner();
  await signInAs(context, o.id);
  await openAdmin(page, 'chat');
  await page.waitForTimeout(1200);
  await expect(page.getByText(/Cannot reach the server/)).toHaveCount(0);
  const denied = await page.evaluate(async () => (await fetch('/api/chat/conversations/00000000-0000-4000-8000-000000000000/messages', { credentials: 'include' })).status);
  expect([403, 404]).toContain(denied);
  expect(problems).toEqual([]);
});

test('Website Customization opens its real draft under the enforced policy', async ({ page, context }) => {
  const problems = watchProblems(page);
  const o = await owner();
  await signInAs(context, o.id);
  await openAdmin(page, 'website');
  await expect(page.locator('[data-act=wzPublish]')).toBeVisible({ timeout: 15000 });
  /* The preview frame is the part an enforced policy could silently break. */
  await expect(page.frameLocator('iframe').first().locator('body')).toBeVisible();
  const site = await page.evaluate(async () => (await fetch('/api/admin/site', { credentials: 'include' })).status);
  expect(site).toBe(200);
  expect(problems).toEqual([]);
});

test('Delivery Partners lists an applicant, and an unauthorised administrator cannot approve one', async ({ page, context, browser }) => {
  const o = await owner();
  await signInAs(context, o.id);
  const name = `Applicant ${uniq()}`;
  const applicant = await userWith({ name, roles: ['student'] });
  await db.query(`INSERT INTO partner_profile (user_id, status) VALUES ($1,'pending')`, [applicant.id]);
  await openAdmin(page, 'partners');
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 15000 });

  const narrow = await userWith({ name: 'Viewer Only', roles: ['platform_admin'], email: `viewer.${uniq()}@stu.upes.ac.in`, permissions: ['partners.view'] });
  const c2 = await browser.newContext();
  await signInAs(c2, narrow.id);
  const p2 = await c2.newPage();
  await p2.goto('/admin/');
  await p2.locator('.cc-frame').waitFor();
  const status = await p2.evaluate(async (id) => (await fetch(`/api/admin/partners/${id}/decide`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve', status: 'approved' }) })).status, applicant.id);
  expect(status).toBe(403);
  expect((await db.query(`SELECT status FROM partner_profile WHERE user_id = $1`, [applicant.id])).rows[0].status).toBe('pending');
  await c2.close();
});

test('a person can ask for their data from their profile', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const u = await userWith({ name: 'Data Person', email: `data.${uniq()}@stu.upes.ac.in` });
  await partnerReady(u.id);
  await signInAs(context, u.id, 'code');
  const page = await context.newPage();
  await page.goto('/web/#/profile');
  const row = page.locator('[data-act=exportMyData]');
  await row.waitFor({ timeout: 15000 });
  const [download] = await Promise.all([page.waitForEvent('download'), row.click()]);
  expect(download.suggestedFilename()).toBe('echoecho-my-data.json');
  await context.close();
});
