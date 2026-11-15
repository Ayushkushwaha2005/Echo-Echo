/* The weekly café schedule in Edit café, and the two switches from the owner's
   supplied components (the light/dark switch and the general switch), driven in
   a real browser against the real API and a disposable database. */
import { test, expect } from '@playwright/test';
import { db, owner, signInAs, watchProblems, vendor, openAdmin } from './helpers.mjs';

const LEGACY_WEEK = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: d, open: d <= 6, opens: '08:00', closes: '18:00' }));
const shot = (page, name) => page.screenshot({ path: `test-results/schedule-toggles-${name}.png`, fullPage: false });

test('weekly schedule: each day its own hours, closed days keep theirs, bulk actions, saved without touching the switches', async ({ page, context }) => {
  const problems = watchProblems(page);
  const o = await owner();
  await signInAs(context, o.id);
  const v = await vendor('Week Cafe');
  await db.query(`UPDATE vendor SET open_days = '{1,2,3,4,5,6}', opens_at = '08:00', closes_at = '18:00', weekly_hours = $2::jsonb,
                         is_open = true, accepting = false, manual_availability = false WHERE id = $1`, [v.id, JSON.stringify(LEGACY_WEEK)]);
  await openAdmin(page, 'cafeterias');
  await page.locator(`[data-act=editVendor][data-id="${v.id}"]`).click();
  const wk = page.locator('.modalwrap [data-wk]');
  const row = (d) => wk.locator(`.wk-row[data-day="${d}"]`);
  await expect(wk.locator('[data-wk-summary]')).toHaveText('Mon–Sat 8 AM–6 PM · Sun closed');
  await expect(row(7).locator('[data-wk-opens]')).toBeDisabled();

  /* Wednesday closed with a click on its switch: its hours stay, greyed out. */
  await row(3).locator('.m3s-track').click();
  await expect(row(3).locator('[data-wk-open]')).not.toBeChecked();
  await expect(row(3).locator('[data-wk-opens]')).toBeDisabled();
  await expect(row(3).locator('[data-wk-opens]')).toHaveValue('08:00');
  await expect(row(3).locator('[data-wk-state]')).toHaveText('Closed');

  /* Thursday 10 AM-8 PM through "Apply hours" on the selected day. */
  await row(4).locator('[data-wk-pick]').check();
  await wk.locator('[data-wk-bulk=opens]').fill('10:00');
  await wk.locator('[data-wk-bulk=closes]').fill('20:00');
  await wk.getByRole('button', { name: 'Apply hours' }).click();
  await expect(row(4).locator('[data-wk-opens]')).toHaveValue('10:00');

  /* Friday overnight, typed into its own fields. */
  await row(5).locator('[data-wk-opens]').fill('18:00');
  await row(5).locator('[data-wk-closes]').fill('02:00');
  await expect(row(5).locator('[data-wk-night]')).toBeVisible();

  /* Thursday copied to Saturday. */
  await row(4).locator('[data-wk-pick]').uncheck();
  await row(6).locator('[data-wk-pick]').check();
  await wk.locator('[data-wk-from]').selectOption('4');
  await wk.getByRole('button', { name: 'Copy to selected' }).click();
  await expect(row(6).locator('[data-wk-closes]')).toHaveValue('20:00');

  /* Sunday on and off again from the keyboard (Space on the switch). */
  await row(7).locator('[data-wk-open]').focus();
  await page.keyboard.press('Space');
  await expect(row(7).locator('[data-wk-open]')).toBeChecked();
  await expect(row(7).locator('[data-wk-opens]')).toBeEnabled();
  await page.keyboard.press('Space');
  await expect(row(7).locator('[data-wk-open]')).not.toBeChecked();

  /* A day opened without hours is caught before it is sent. */
  await expect(wk.locator('[data-wk-summary]')).toHaveText('Mon–Tue 8 AM–6 PM · Thu, Sat 10 AM–8 PM · Fri 6 PM–2 AM · Wed, Sun closed');
  await shot(page, 'editor-desktop');

  await wk.getByRole('button', { name: 'Save weekly schedule' }).click();
  await expect(wk.locator('[data-wk-saved]')).toHaveText('Weekly schedule saved');
  const saved = (await db.query(`SELECT weekly_hours, is_open, accepting, manual_availability, open_days FROM vendor WHERE id = $1`, [v.id])).rows[0];
  expect(saved.weekly_hours).toEqual([
    { day: 1, open: true, opens: '08:00', closes: '18:00' },
    { day: 2, open: true, opens: '08:00', closes: '18:00' },
    { day: 3, open: false, opens: '08:00', closes: '18:00' },
    { day: 4, open: true, opens: '10:00', closes: '20:00' },
    { day: 5, open: true, opens: '18:00', closes: '02:00' },
    { day: 6, open: true, opens: '10:00', closes: '20:00' },
    { day: 7, open: false, opens: '08:00', closes: '18:00' },
  ]);
  expect([saved.is_open, saved.accepting, saved.manual_availability]).toEqual([true, false, false]);
  expect(saved.open_days).toEqual([1, 2, 4, 5, 6]);

  /* The rest of the form still saves after the schedule did (no stale-revision refusal). */
  await page.locator('.modalwrap input[name=prepMinutes]').fill('12');
  await page.locator('.modalwrap button[type=submit]').click();
  await expect(page.locator('.modalwrap')).toHaveCount(0);
  const after = (await db.query(`SELECT prep_minutes, weekly_hours FROM vendor WHERE id = $1`, [v.id])).rows[0];
  expect(after.prep_minutes).toBe(12);
  expect(after.weekly_hours).toEqual(saved.weekly_hours);

  /* The card and the student site read the same week. */
  await expect(page.getByText('Mon–Tue 8 AM–6 PM · Thu, Sat 10 AM–8 PM · Fri 6 PM–2 AM · Wed, Sun closed').first()).toBeVisible();
  const menu = await page.evaluate(async (id) => (await (await fetch(`/api/vendors/${id}/menu`)).json()).vendor.hours.label, v.id);
  expect(menu).toBe('Mon–Tue 8 AM–6 PM · Thu, Sat 10 AM–8 PM · Fri 6 PM–2 AM · Wed, Sun closed');
  expect(problems).toEqual([]);
});

test('weekly schedule on a phone: no sideways scroll, and an on/off setting works from the keyboard', async ({ page, context }) => {
  const problems = watchProblems(page);
  const o = await owner();
  await signInAs(context, o.id);
  const v = await vendor('Phone Week Cafe');
  await page.setViewportSize({ width: 390, height: 844 });
  await openAdmin(page, 'cafeterias');
  await page.locator(`[data-act=editVendor][data-id="${v.id}"]`).evaluate((b) => b.click());
  const wk = page.locator('.modalwrap [data-wk]');
  await expect(wk.locator('[data-wk-summary]')).toHaveText('No weekly schedule yet');
  const over = await page.locator('.modalwrap .modal-body').evaluate((m) => m.scrollWidth - m.clientWidth);
  expect(over).toBeLessThanOrEqual(1);
  await wk.scrollIntoViewIfNeeded();
  await shot(page, 'editor-phone');

  /* "Offers delivery" is the shared switch over a real checkbox. */
  const delivery = page.locator('.modalwrap input[name=deliveryEnabled]');
  const was = await delivery.isChecked();
  await delivery.focus();
  await page.keyboard.press('Space');
  await expect(delivery).toBeChecked({ checked: !was });
  expect(await delivery.getAttribute('role')).toBe('switch');
  /* Opening Edit café and saving another field sends no week. */
  await page.locator('.modalwrap button[type=submit]').click();
  await expect(page.locator('.modalwrap')).toHaveCount(0);
  expect((await db.query(`SELECT weekly_hours, delivery_enabled FROM vendor WHERE id = $1`, [v.id])).rows[0]).toEqual({ weekly_hours: null, delivery_enabled: !was });
  expect(problems).toEqual([]);
});

test('light/dark switch: one beside the profile, remembered after reload, operable from the keyboard', async ({ page, context }) => {
  const problems = watchProblems(page);
  const o = await owner();
  await signInAs(context, o.id);
  await openAdmin(page, 'overview');
  const sw = page.locator('[data-theme-switch]');
  await expect(sw).toHaveCount(1);
  await expect(page.locator('.cc-theme + .cc-profile')).toHaveCount(1);
  await expect(sw).toHaveAttribute('role', 'switch');
  const first = await sw.getAttribute('aria-checked');
  const flip = first === 'true' ? 'false' : 'true';
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', flip);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(flip === 'true' ? 'dark' : 'light');
  await page.waitForTimeout(1100);
  await shot(page, `admin-${flip === 'true' ? 'dark' : 'light'}`);
  await page.reload();
  await page.locator('.cc-frame').waitFor();
  await expect(page.locator('[data-theme-switch]')).toHaveAttribute('aria-checked', flip);
  await page.locator('[data-theme-switch]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-theme-switch]')).toHaveAttribute('aria-checked', first);
  await page.waitForTimeout(1100);
  await shot(page, `admin-${first === 'true' ? 'dark' : 'light'}`);

  /* The student site: one switch in the header, its own remembered choice. */
  await page.goto('/web/#/cafes');
  const web = page.locator('.site-head [data-theme-switch]');
  await expect(web).toHaveCount(1);
  await expect(page.locator('[data-theme-switch]')).toHaveCount(1);
  const w0 = await web.getAttribute('aria-checked');
  await web.click();
  const w1 = w0 === 'true' ? 'false' : 'true';
  await expect(web).toHaveAttribute('aria-checked', w1);
  expect(await page.evaluate(() => localStorage.getItem('frisco-theme'))).toBe(w1 === 'true' ? 'dark' : 'light');
  await page.reload();
  await expect(page.locator('.site-head [data-theme-switch]')).toHaveAttribute('aria-checked', w1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.site-head [data-theme-switch]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.waitForTimeout(1100);
  await shot(page, 'web-phone');
  expect(problems).toEqual([]);
});
