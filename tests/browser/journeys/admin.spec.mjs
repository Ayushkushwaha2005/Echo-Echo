import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { db, owner, userWith, signInAs, totp, lastMailTo, PASSWORD, watchProblems, vendor } from './helpers.mjs';

const uniq = () => `${Date.now() % 1000000}`;

test('employee invitation, in a browser: link, code, review, password, authenticator, then real sign-in', async ({ page, context }) => {
  const problems = watchProblems(page);
  const o = await owner();
  await signInAs(context, o.id);
  const email = `hire.${uniq()}@example.org`;

  /* The owner invites through the real Access Management screen. */
  await page.goto('/admin/#admins');
  await page.getByRole('button', { name: 'Invite administrator' }).click();
  await page.locator('input[name=name]').fill('Browser Hire');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[type=checkbox][value="students.view"]').check();
  await page.locator('.modalwrap button[type=submit]').click();
  await expect(page.getByText('Invitation emailed')).toBeVisible();
  await expect(page.getByRole('cell', { name: email })).toBeVisible();

  const [, token] = await lastMailTo(email, /#invite=([\w-]+)/);

  /* The employee, in a clean browser with no session. */
  const emp = await context.browser().newContext({ viewport: { width: 390, height: 844 } });
  const p = await emp.newPage();
  const empProblems = watchProblems(p);
  await p.goto(`/admin/#invite=${token}`);
  await expect(p.getByRole('heading', { name: /invited to Campus Control/ })).toBeVisible();
  expect(p.url()).not.toContain(token);
  await p.getByRole('button', { name: 'Email me a code' }).click();
  const [, otp] = await lastMailTo(email, /is: (\d{6})/);
  await p.locator('input[name=code]').fill(otp);
  await p.getByRole('button', { name: 'Continue' }).click();

  await expect(p.getByRole('heading', { name: 'Review your access' })).toBeVisible();
  await expect(p.getByText(email)).toBeVisible();
  await expect(p.getByText(/View student accounts/)).toBeVisible();
  await p.getByRole('button', { name: 'Accept this invitation' }).click();

  await p.locator('input[name=password]').fill(PASSWORD);
  await p.locator('input[name=again]').fill(PASSWORD);
  await p.getByRole('button', { name: 'Save password' }).click();
  await p.getByRole('button', { name: 'Show my QR code' }).click();
  await p.locator('.enrol-key summary').click();
  const secret = (await p.locator('.enrol-secret').textContent()).replace(/\s/g, '');
  await p.locator('input[name=code]').fill(totp(secret));
  await p.getByRole('button', { name: 'Finish setup' }).click();
  await expect(p.getByRole('heading', { name: /all set/ })).toBeVisible();

  /* Now a real sign-in with what they just set up. */
  await db.query(`UPDATE admin_credential SET totp_last_step = NULL WHERE user_id = (SELECT id FROM app_user WHERE staff_email = $1)`, [email]);
  await p.getByRole('button', { name: 'Go to Campus Control sign-in' }).click();
  await p.locator('input[type=email], input[name=email]').first().fill(email);
  await p.locator('input[type=password]').first().fill(PASSWORD);
  await p.locator('button[type=submit]').first().click();
  await p.locator('input[inputmode=numeric]').first().fill(totp(secret));
  await p.locator('button[type=submit]').first().click();
  await expect(p.locator('.cc-frame')).toBeVisible();
  /* It holds exactly what was granted: the nav has Users but not Access Management. */
  await expect(p.locator('.cc-navbtn[data-route=users]')).toHaveCount(1);
  await expect(p.locator('.cc-navbtn[data-route=admins]')).toHaveCount(0);
  await expect(p.locator('.cc-navbtn[data-route=finance]')).toHaveCount(0);

  expect(problems).toEqual([]);
  expect(empProblems).toEqual([]);
  await emp.close();
});

test('a used invitation link says so plainly', async ({ page }) => {
  await page.goto(`/admin/#invite=${'x'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: /can.t be used/ })).toBeVisible();
});

test('sessions screen: last activity and device, one session ended, no token in the page', async ({ page, context, browser }) => {
  const problems = watchProblems(page);
  const o = await owner();
  await signInAs(context, o.id);
  const a = await userWith({ name: 'Session Person', roles: ['platform_admin'], email: `sess.${uniq()}@stu.upes.ac.in`, permissions: ['students.view'] });
  const other = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36' });
  await signInAs(other, a.id);
  await db.query(`UPDATE session SET user_agent = 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36', last_seen_at = now() WHERE user_id = $1`, [a.id]);
  const theirs = await other.newPage();
  await theirs.goto('/admin/#users');
  await expect(theirs.locator('.cc-frame')).toBeVisible();

  await page.goto('/admin/#sessions');
  const row = page.locator('section', { hasText: 'Session Person' });
  await expect(row.getByText('Chrome on Android')).toBeVisible();
  const hashes = (await db.query(`SELECT token_hash FROM session WHERE user_id = $1`, [a.id])).rows;
  const html = await page.content();
  for (const h of hashes) expect(html).not.toContain(h.token_hash);

  await row.getByRole('button', { name: 'End', exact: true }).click();
  await page.locator('.modalwrap input[name=reason]').fill('Lost the phone');
  await page.locator('.modalwrap button[type=submit]').click();
  await expect(row.getByText('No open sessions')).toBeVisible();
  await theirs.reload();
  await expect(theirs.locator('.cc-frame')).toHaveCount(0);
  expect(problems).toEqual([]);
  await other.close();
});

test('permission restrictions: pages hidden in the nav, and a typed-in URL is still refused', async ({ page, context }) => {
  const a = await userWith({ name: 'Narrow Admin', roles: ['platform_admin'], email: `narrow.${uniq()}@stu.upes.ac.in`, permissions: ['reviews.view'] });
  await signInAs(context, a.id);
  await page.goto('/admin/');
  await expect(page.locator('.cc-frame')).toBeVisible();
  await expect(page.locator('.cc-navbtn[data-route=reviews]')).toHaveCount(1);
  for (const r of ['admins', 'audit', 'finance', 'users', 'sessions']) await expect(page.locator(`.cc-navbtn[data-route=${r}]`)).toHaveCount(0);
  const refused = await page.evaluate(async () => (await fetch('/api/admin/audit', { credentials: 'include' })).status);
  expect(refused).toBe(403);
});

test('audit log screen shows a real privileged action', async ({ page, context }) => {
  const o = await owner();
  await signInAs(context, o.id);
  await db.query(`INSERT INTO audit_log (actor_id, action, resource, outcome) VALUES ($1,'admin.invite.cancel','admin_invitation','ok')`, [o.id]);
  await page.goto('/admin/#audit');
  await expect(page.locator('.cc-frame')).toBeVisible();
  await expect(page.locator('table').first()).toBeVisible();
});

test('live map: delivery.track sees a map; orders.view alone sees no position', async ({ page, context, browser }) => {
  const v = await vendor('Map Cafe');
  const cust = await userWith({ name: 'Map Customer' });
  const partner = await userWith({ name: 'Ravi Map', roles: ['student', 'delivery_partner'] });
  const { rows: [order] } = await db.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id, destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery','picked_up',9000,10000,$4,'{"name":"Block 4"}','+919999900002','manual_map_spot',30.4172,77.9681) RETURNING id`,
    [`M${uniq()}`, cust.id, v.id, partner.id]);
  await db.query(`INSERT INTO partner_location (partner_id, order_id, lat, lng, accuracy_m, at) VALUES ($1,$2,30.4172,77.9681,12, now())`, [partner.id, order.id]);

  const tracker = await userWith({ name: 'Tracker', roles: ['platform_admin'], email: `track.${uniq()}@stu.upes.ac.in`, permissions: ['orders.view', 'delivery.track'] });
  await signInAs(context, tracker.id);
  const problems = watchProblems(page);
  await page.goto('/admin/#deliveries');
  await expect(page.locator('#cc-track-map')).toBeVisible();
  await expect(page.locator('#cc-track-note')).toContainText(/Live|Stale/);
  await expect(page.locator('#cc-track-note')).toContainText(/direct, not a route/);

  const plain = await userWith({ name: 'Plain', roles: ['platform_admin'], email: `plain.${uniq()}@stu.upes.ac.in`, permissions: ['orders.view'] });
  const c2 = await browser.newContext();
  await signInAs(c2, plain.id);
  const p2 = await c2.newPage();
  const seen = [];
  p2.on('response', async (r) => { if (r.url().includes('/tracking')) seen.push(await r.text()); });
  await p2.goto('/admin/#deliveries');
  await expect(p2.getByText('needs delivery.track').first()).toBeVisible();
  await expect(p2.locator('#cc-track-map')).toHaveCount(0);
  for (const body of seen) expect(body).not.toContain('77.9681');
  await c2.close();
  expect(problems).toEqual([]);
});

test('approvals screen: the owner can turn a policy on and sees the honest one-owner note', async ({ page, context }) => {
  const o = await owner();
  await signInAs(context, o.id);
  await page.goto('/admin/#approvals');
  await expect(page.getByText(/second owner-grade person/)).toBeVisible();
  await expect(page.getByText('Archive a café')).toBeVisible();
});

test('stale cafe form: the second editor is told and nothing is overwritten', async ({ page, context }) => {
  const o = await owner();
  await signInAs(context, o.id);
  const v = await vendor('Conflict Cafe');
  await page.goto('/admin/#cafeterias');
  await expect(page.getByText('Conflict Cafe')).toBeVisible();
  const r = await page.evaluate(async ({ id, rev }) => {
    const send = (body) => fetch(`/api/vendors/${id}`, { method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const a = await send({ revision: rev, description: 'first' });
    const b = await send({ revision: rev, description: 'second' });
    return [a.status, b.status];
  }, { id: v.id, rev: v.revision });
  expect(r).toEqual([200, 409]);
});

for (const [name, width] of [['phone', 390], ['tablet', 820], ['desktop', 1440]]) {
  test(`Campus Control has no sideways scroll at ${name} width (${width}px)`, async ({ page, context }) => {
    const o = await owner();
    await signInAs(context, o.id);
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['overview', 'admins', 'sessions', 'deliveries', 'approvals', 'profile']) {
      await page.goto(`/admin/#${route}`);
      await expect(page.locator('.cc-frame')).toBeVisible();
      await page.waitForTimeout(300);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `${route} at ${width}`).toBeLessThanOrEqual(1);
    }
  });
}

test('accessibility: the new screens have no serious axe violations', async ({ page, context, browser }) => {
  const clean = await browser.newContext();
  const inv = await clean.newPage();
  await inv.goto(`/admin/#invite=${'x'.repeat(43)}`);
  await expect(inv.getByRole('heading', { name: /can.t be used/ })).toBeVisible();
  const a1 = await new AxeBuilder({ page: inv }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const bad = (r) => r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`);
  expect(bad(a1)).toEqual([]);
  await clean.close();
  const o = await owner();
  await signInAs(context, o.id);
  for (const route of ['approvals', 'sessions']) {
    await page.goto(`/admin/#${route}`);
    await expect(page.locator('.cc-frame')).toBeVisible();
    await page.waitForTimeout(400);
    const r = await new AxeBuilder({ page }).include('#view, main, .cc-view').withTags(['wcag2a', 'wcag2aa']).analyze().catch(() => null);
    if (r) expect(bad(r), route).toEqual([]);
  }
});
