/* Home on a sleeping API (3 Nov 2026: cafés took ~45 s on an iPhone while
   Render woke), the retired self-pickup card, and the wordmark. */
import { test, expect } from '@playwright/test';
import { db, vendor, watchProblems } from './helpers.mjs';

const hold = (ms) => async (r) => { await new Promise((res) => setTimeout(res, ms)); await r.continue().catch(() => {}); };
/* By id: the same name may be left over from an earlier run, and a featured café is drawn twice. */
const card = (page, v) => page.locator(`.cafcard[data-caf="${v.id}"]`).first();

test('a returning visitor sees the cafés at once while the server wakes, marked Checking, not Open or Closed', async ({ browser }) => {
  const v = await vendor('Wake Test Cafe');
  for (const viewport of [{ width: 390, height: 844 }, { width: 412, height: 915 }, { width: 1280, height: 800 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const problems = watchProblems(page);
    await page.goto('/web/#/home');
    await expect(card(page, v)).toBeVisible({ timeout: 15000 });
    await expect(card(page, v).locator('.status-open')).toBeVisible();
    /* Next visit: the server is asleep. Everything it is asked takes 25 s. */
    await page.route(/\/api\/(vendors|auth\/me|auth\/status|campuses)\//, hold(25_000));
    const t = Date.now();
    await page.reload();
    await expect(card(page, v), `${viewport.width}px`).toBeVisible({ timeout: 2000 });
    expect(Date.now() - t, `${viewport.width}px: cafés shown in under 2 s`).toBeLessThan(2000);
    await expect(card(page, v).locator('.status-checking')).toHaveText(/Checking/);
    await expect(card(page, v).locator('.status-open, .status-closed')).toHaveCount(0);
    await expect(page.getByText(/Loading cafés/)).toHaveCount(0);
    expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
    await context.close();
  }
});

test('a copy the edge kept while the server slept is shown as Checking, then the server\'s own answer replaces it', async ({ page }) => {
  const v = await vendor('Edge Copy Cafe');
  const fresh = [];
  /* What Vercel serves while it revalidates: the list, an hour old. */
  await page.route(/\/api\/vendors\/\?(?!.*fresh=)/, async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, headers: { ...res.headers(), age: '3600' } });
  });
  await page.route(/\/api\/vendors\/\?.*fresh=1/, async (r) => { fresh.push(r.request().url()); await new Promise((res) => setTimeout(res, 1500)); await r.continue(); });
  await page.goto('/web/#/home');
  await expect(card(page, v).locator('.status-checking')).toBeVisible({ timeout: 10000 });
  await expect(card(page, v).locator('.status-open')).toBeVisible({ timeout: 10000 });
  expect(fresh.length, 'the server itself was asked, past the edge').toBeGreaterThan(0);
});

test('when the refresh fails the remembered cafés stay on screen', async ({ page }) => {
  const v = await vendor('Kept Cafe');
  await page.goto('/web/#/home');
  await expect(card(page, v)).toBeVisible({ timeout: 15000 });
  await page.route(/\/api\/vendors\//, (r) => r.abort());
  await page.reload();
  await expect(card(page, v)).toBeVisible({ timeout: 3000 });
  await page.waitForTimeout(1500);
  await expect(card(page, v)).toBeVisible();
  await expect(page.getByText(/Cannot reach the ECHO ECHO server/)).toHaveCount(0);
});

test('Home has no self-pickup card; self pickup is still chosen in the cart', async ({ page }) => {
  const v = await vendor('Pickup Flow Cafe');
  await db.query(`INSERT INTO menu_item (vendor_id, name, price_paise, available, active) VALUES ($1,'Pickup Samosa',2500,true,true)`, [v.id]);
  await page.goto('/web/#/home');
  await expect(card(page, v)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/In a hurry\?/)).toHaveCount(0);
  await expect(page.getByText(/Skip the delivery fee/)).toHaveCount(0);
  await card(page, v).click();
  await page.locator('.item', { hasText: 'Pickup Samosa' }).locator('[data-act=add]').click();
  await page.goto('/web/#/cart');
  const pickup = page.locator('[data-act=setfulfil][data-f=pickup]');
  await expect(pickup).toBeVisible({ timeout: 10000 });
  await pickup.click();
  await expect(pickup).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('No delivery fee').first()).toBeVisible();
});

test('the wordmark is the brand face, reads ECHO ECHO, and the logo beside it is the approved artwork', async ({ page }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/web/#/home');
    const name = page.locator('.site-brand .brand-name, .brand-lockup .brand-name').first();
    await expect(name).toBeVisible({ timeout: 15000 });
    await expect(name).toHaveText('ECHO ECHO');
    const look = await name.evaluate((el) => {
      const s = getComputedStyle(el), e = getComputedStyle(el.querySelector('.brand-echo'));
      return { family: s.fontFamily, weight: Number(s.fontWeight), size: parseFloat(s.fontSize), first: s.color, echo: e.color };
    });
    expect(look.family).toMatch(/Bricolage Grotesque/);
    expect(look.weight).toBeGreaterThanOrEqual(800);
    expect(look.size, `${viewport.width}px`).toBeGreaterThanOrEqual(19);
    expect(look.echo, 'the second ECHO is the accent').not.toBe(look.first);
    const logoSrc = await page.locator('.brand-lockup img').first().getAttribute('src');
    expect(logoSrc).toMatch(/echoecho-logo-(320|640)\.webp$/);
  }
});
