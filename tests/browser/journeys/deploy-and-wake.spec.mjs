/* Two production failures, reproduced: photos turning into café monograms once a
   deploy had retired the build folder they were loaded from, and the college list
   waiting minutes while the API woke up. */
import { test, expect } from '@playwright/test';
import { db, vendor, watchProblems } from './helpers.mjs';

test('after a deploy retires the old build folder, café and dish photos still load', async ({ page }) => {
  const problems = watchProblems(page);
  const v = await vendor('Chai Garam Photo Test');
  await db.query(`UPDATE vendor SET slug = $2 WHERE id = $1`, [v.id, `chai-garam-${Date.now() % 100000}`]);
  await db.query(`INSERT INTO menu_item (vendor_id, name, price_paise, available, active) VALUES ($1,'Masala Chai',2000,true,true)`, [v.id]);
  /* What a page opened before a deploy meets: every file under the old /_v/ build is gone. */
  await page.route(/\/_v\/[^/]+\/packages\/media\/.+\.(webp|jpe?g|png)$/, (r) => r.fulfill({ status: 404, body: 'not found' }));
  const asked = [];
  page.on('request', (r) => { if (r.resourceType() === 'image') asked.push(new URL(r.url()).pathname); });
  await page.goto(`/web/#/menu/${v.id}`);
  await expect(page.getByText('Masala Chai').first()).toBeVisible({ timeout: 15000 });
  const dish = page.locator('.item img').first();
  await expect(dish).toBeVisible();
  await expect.poll(() => dish.evaluate((i) => i.complete && i.naturalWidth > 0), { timeout: 10000 }).toBe(true);
  expect(asked.some((p) => p.startsWith('/media/dishes/')), 'photos come from the stable path').toBe(true);
  expect(asked.filter((p) => p.includes('/_v/') && p.includes('/media/')), 'no photo from a build folder').toEqual([]);
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
});

test('the real Chai Garam slug shows its campus photograph, not the monogram', async ({ page }) => {
  const existing = (await db.query(`SELECT id FROM vendor WHERE slug = 'chai-garam'`)).rows[0];
  const id = existing?.id || (await db.query(
    `INSERT INTO vendor (slug, name, is_open, accepting, active, campus_site_id) VALUES ('chai-garam','Chai Garam',true,true,true,(SELECT id FROM campus_site ORDER BY created_at LIMIT 1)) RETURNING id`)).rows[0].id;
  await db.query(`UPDATE vendor SET active = true, photo_asset = NULL WHERE id = $1`, [id]);
  await page.route(/\/_v\/[^/]+\/packages\/media\/.+\.(webp|jpe?g|png)$/, (r) => r.fulfill({ status: 404, body: 'not found' }));
  await page.goto(`/web/#/menu/${id}`);
  const hero = page.locator('.cafhero-photo img, .cafphoto img').first();
  await expect(hero).toBeVisible({ timeout: 15000 });
  await expect.poll(() => hero.evaluate((i) => i.complete && i.naturalWidth > 0), { timeout: 10000 }).toBe(true);
  expect(await hero.evaluate((i) => new URL(i.currentSrc).pathname)).toMatch(/^\/media\/cafes\/chai-garam-cafe-/);
});

test('the college list appears while the account check is still waiting on a waking server', async ({ browser }) => {
  for (const [label, remembered] of [['first visit', false], ['returning visit', true]]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    if (remembered) {
      await page.goto('/web/#/signin');
      await expect.poll(() => page.evaluate(() => localStorage.getItem('echo.campuses')), { timeout: 15000 }).toBeTruthy();
    }
    /* A sleeping instance: the account and provider checks take 25 s. */
    await page.route('**/api/auth/me**', async (r) => { await new Promise((res) => setTimeout(res, 25_000)); await r.continue().catch(() => {}); });
    await page.route('**/api/auth/status**', async (r) => { await new Promise((res) => setTimeout(res, 25_000)); await r.continue().catch(() => {}); });
    if (remembered) await page.route('**/api/campuses**', async (r) => { await new Promise((res) => setTimeout(res, 25_000)); await r.continue().catch(() => {}); });
    const t = Date.now();
    await page.goto('/web/#/signin');
    await page.getByRole('button', { name: /Continue as Student/ }).click();
    await expect(page.locator('[data-act=pickCollege]').first(), label).toBeVisible({ timeout: 5000 });
    expect(Date.now() - t, `${label}: colleges shown in under 5 s`).toBeLessThan(5000);
    await context.close();
  }
});

test('requesting a code: honest wording, a running resend countdown, and a second press cannot send twice', async ({ page }) => {
  const sends = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/auth\/email\/send/.test(r.url())) sends.push(Date.now()); });
  await page.goto('/web/#/signin');
  await page.getByRole('button', { name: /Continue as Student/ }).click();
  await page.locator('[data-act=pickCollege]').first().click();
  await page.locator('[data-act=pickObCampus]').first().click();
  await page.locator('#ob-em').fill(`code.${Date.now() % 100000}`);
  const submit = page.locator('form[data-form=email] button[type=submit]');
  const t = Date.now();
  await submit.click();
  await submit.click({ timeout: 500 }).catch(() => {});
  await expect(page.getByText(/has accepted a code for/)).toBeVisible({ timeout: 10000 });
  expect(Date.now() - t, 'acknowledged quickly').toBeLessThan(3000);
  expect(sends.length, 'one request for two presses').toBe(1);
  const resend = page.locator('#resend-email');
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText(/Send another code in \d+ s/);
  const first = await resend.textContent();
  await page.waitForTimeout(2100);
  expect(await resend.textContent(), 'the countdown moves').not.toBe(first);
  await expect(page.getByText(/We sent a code/)).toHaveCount(0);
});
