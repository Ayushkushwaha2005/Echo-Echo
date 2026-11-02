/* Every Campus Control page, signed in, read from the app's own list so a new page
   cannot be missed: it opens, every API call it makes succeeds, nothing is blocked,
   it fits a phone, and it passes the accessibility rules. Then the same pages and the
   student pages with script payloads stored in the fields people can type into. */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { db, owner, userWith, signInAs, watchProblems, vendor, openAdmin, partnerReady } from './helpers.mjs';

const source = readFileSync(new URL('../../../admin/src/app.js', import.meta.url), 'utf8');
const navBlock = source.slice(source.indexOf('const NAV_GROUPS = ['), source.indexOf('const NAV = NAV_GROUPS'));
const MODULES = [...navBlock.matchAll(/\['([a-z]+)', '([^']+)', '[a-z]+'\]/g)].map((m) => ({ route: m[1], label: m[2] }));
const seriousA11y = (r) => r.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`);
const uniq = () => `${Date.now() % 1000000}`;

test('the list of pages was read from the app', () => {
  expect(MODULES.length).toBeGreaterThanOrEqual(24);
  expect(MODULES.map((m) => m.route)).toContain('website');
});

for (const { route, label } of MODULES) {
  test(`${label}: opens signed in, its API calls succeed, nothing is blocked, fits a phone, accessible`, async ({ browser }) => {
    const o = await owner();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await signInAs(context, o.id);
    const page = await context.newPage();
    const problems = watchProblems(page);
    const failed = [];
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });

    await openAdmin(page, route);
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('.cc-frame')).toBeVisible();
    await expect(page.getByText(/Cannot reach the server|Something went wrong/)).toHaveCount(0);
    expect(failed, 'server errors').toEqual([]);
    expect(problems, 'blocked or crashed').toEqual([]);

    expect(seriousA11y(await new AxeBuilder({ page }).include('.cc-frame').withTags(['wcag2a', 'wcag2aa']).analyze()), 'accessibility').toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'sideways scroll at 390 px').toBeLessThanOrEqual(1);
    await context.close();
  });
}

test('an administrator with one permission sees only the pages it opens', async ({ browser }) => {
  const u = await userWith({ name: 'One Permission', roles: ['platform_admin'], email: `one.${uniq()}@stu.upes.ac.in`, permissions: ['reviews.view'] });
  const context = await browser.newContext();
  await signInAs(context, u.id);
  const page = await context.newPage();
  await page.goto('/admin/');
  await page.locator('.cc-frame').waitFor();
  const shown = await page.locator('.cc-navbtn[data-route]').evaluateAll((els) => els.map((e) => e.dataset.route));
  expect(shown).toContain('reviews');
  for (const hidden of ['finance', 'admins', 'users', 'platform', 'audit', 'privacy', 'reports']) expect(shown).not.toContain(hidden);
  await context.close();
});

/* Stored data is what an attacker controls. The Campus Control policy would block an
   inline handler anyway, so the check is on the page itself: no payload may become an
   element or an attribute. The student site's policy only reports, so there the
   payload really would run if it were not escaped. */
const PAYLOAD = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>"'><svg onload="window.__xss=3">`;

test('script payloads in stored fields stay text on every page, admin and student', async ({ browser }) => {
  test.setTimeout(240_000);
  const o = await owner();
  const v = await vendor('XSS Cafe');
  await db.query(`UPDATE vendor SET name = $2, description = $2 WHERE id = $1`, [v.id, `Cafe ${PAYLOAD}`]);
  await db.query(`INSERT INTO menu_item (vendor_id, name, description, price_paise, available, active) VALUES ($1,$2,$2,2500,true,true)`, [v.id, `Dish ${PAYLOAD}`]);
  const person = await userWith({ name: `Person ${PAYLOAD}`, email: `xss.${uniq()}@stu.upes.ac.in` });
  await partnerReady(person.id);
  await db.query(`UPDATE partner_profile SET note = $2 WHERE user_id = $1`, [person.id, PAYLOAD]);
  const { rows: [order] } = await db.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id, destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery','picked_up',9000,10000,$2,$4,'+919999900002','manual_map_spot',30.4172,77.9681) RETURNING id`,
    [`X${uniq()}`, person.id, v.id, JSON.stringify({ name: PAYLOAD, label: PAYLOAD })]);
  await db.query(`INSERT INTO review (order_id, user_id, vendor_id, stars, body) VALUES ($1,$2,$3,1,$4)`, [order.id, person.id, v.id, PAYLOAD]).catch(() => {});
  await db.query(`INSERT INTO support_case (code, user_id, subject) VALUES ($1,$2,$3)`, [`C${uniq()}`, person.id, PAYLOAD]).catch(() => {});
  await db.query(`INSERT INTO data_request (user_id, kind, note) VALUES ($1,'deletion',$2) ON CONFLICT DO NOTHING`, [person.id, PAYLOAD]);
  await db.query(`INSERT INTO campus_node (site_id, name, kind) SELECT id, $1, 'landmark' FROM campus_site LIMIT 1`, [PAYLOAD]).catch(() => {});

  const context = await browser.newContext();
  await signInAs(context, o.id);
  const page = await context.newPage();
  const leaked = async (where) => page.evaluate(() => ({
    ran: window.__xss ?? null,
    elements: document.body.querySelectorAll('img[src="x"], [onerror], [onload]').length,
  })).then((r) => expect(r, where).toEqual({ ran: null, elements: 0 }));

  for (const { route } of MODULES) {
    await openAdmin(page, route);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(150);
    await leaked(`admin ${route}`);
  }
  /* The page that shows a person's full detail. */
  await openAdmin(page, 'privacy');
  await expect(page.getByText(/Person <img/).first()).toBeVisible();
  await leaked('data requests, payload shown as text');

  const student = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await signInAs(student, person.id, 'code');
  const web = await student.newPage();
  for (const hash of ['cafes', `menu/${v.id}`, 'orders', `tracking/${order.id}`, 'profile', 'support']) {
    await web.goto(`/web/#/${hash}`);
    await web.waitForLoadState('networkidle').catch(() => {});
    await web.waitForTimeout(300);
    const r = await web.evaluate(() => ({ ran: window.__xss ?? null, elements: document.body.querySelectorAll('img[src="x"], [onerror], [onload]').length }));
    expect(r, `student ${hash}`).toEqual({ ran: null, elements: 0 });
  }
  await student.close();
  await context.close();
});
