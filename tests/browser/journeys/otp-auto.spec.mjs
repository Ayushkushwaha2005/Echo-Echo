/* ==========================================================================
   CAMPUS CONTROL: THE AUTHENTICATOR CODE SUBMITS ITSELF

   Real bundle, real API, disposable database. A staff account is made through
   the real invitation (its authenticator setup is itself auto-submitted), then
   sign-in is exercised the ways people enter a code: typing, pasting, a wrong
   code then a right one, and Enter pressed while the check is running. Each
   counts the real POST /auth/admin/login requests.
   ========================================================================== */
import { test, expect } from '@playwright/test';
import { db, owner, signInAs, totp, lastMailTo, PASSWORD, openAdmin } from './helpers.mjs';

const uniq = () => `${Date.now() % 1000000}`;

/* An administrator with a password and an authenticator, made the real way. */
async function staffAccount(browser) {
  const o = await owner();
  const oc = await browser.newContext();
  await signInAs(oc, o.id);
  const page = await oc.newPage();
  const email = `otp.${uniq()}@example.org`;
  await openAdmin(page, 'admins');
  await page.getByRole('button', { name: 'Invite administrator' }).click();
  await page.locator('input[name=name]').fill('Otp Tester');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[type=checkbox][value="students.view"]').check();
  await page.locator('.modalwrap button[type=submit]').click();
  await expect(page.getByText('Invitation emailed')).toBeVisible();
  await oc.close();

  const [, token] = await lastMailTo(email, /#invite=([\w-]+)/);
  const ec = await browser.newContext();
  const p = await ec.newPage();
  await p.goto(`/admin/#invite=${token}`);
  await p.getByRole('button', { name: 'Email me a code' }).click();
  const [, otp] = await lastMailTo(email, /is: (\d{6})/);
  await p.locator('input[name=code]').fill(otp);
  await p.getByRole('button', { name: 'Continue' }).click();   // email code: unchanged, still a button
  await p.getByRole('button', { name: 'Accept this invitation' }).click();
  await p.locator('input[name=password]').fill(PASSWORD);
  await p.locator('input[name=again]').fill(PASSWORD);
  await p.getByRole('button', { name: 'Save password' }).click();
  await p.getByRole('button', { name: 'Show my QR code' }).click();
  await p.locator('.enrol-key summary').click();
  const secret = (await p.locator('.enrol-secret').textContent()).replace(/\s/g, '');
  /* Setup's own authenticator step: no Finish button, the code finishes it. */
  await expect(p.getByRole('button', { name: 'Finish setup' })).toBeHidden();
  await p.locator('input[name=code]').fill(totp(secret));
  await expect(p.getByRole('heading', { name: /all set/ })).toBeVisible();
  await ec.close();
  return { email, secret };
}

/* Up to the authenticator step of a fresh sign-in, counting login requests. */
async function toCodeStep(browser, email, viewport) {
  await db.query(`UPDATE admin_credential SET totp_last_step = NULL WHERE user_id = (SELECT id FROM app_user WHERE staff_email = $1)`, [email]);
  const c = await browser.newContext({ viewport });
  const p = await c.newPage();
  const logins = [];
  p.on('request', (r) => { if (r.method() === 'POST' && /\/auth\/admin\/login\/?$/.test(new URL(r.url()).pathname)) logins.push(r); });
  await p.goto('/admin/');
  await p.locator('input[type=email], input[name=email]').first().fill(email);
  await p.locator('input[type=password]').first().fill(PASSWORD);
  await p.locator('button[type=submit]').first().click();
  await expect(p.getByRole('heading', { name: 'Authenticator code' })).toBeVisible();
  return { c, p, logins };
}

let account;
test.beforeAll(async ({ browser }) => { test.setTimeout(120_000); account = await staffAccount(browser); });

for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
  test(`${label}: typing six digits signs in with exactly one request, no button, field focused`, async ({ browser }) => {
    const { c, p, logins } = await toCodeStep(browser, account.email, viewport);
    await expect(p.locator('button.auth-btn[type=submit]')).toBeHidden();
    await expect(p.locator('input[name=code]')).toBeFocused();
    await p.keyboard.type(totp(account.secret), { delay: 40 });
    await expect(p.locator('.cc-frame')).toBeVisible({ timeout: 15000 });
    expect(logins.length).toBe(1);
    await c.close();
  });
}

test('pasting the code signs in with exactly one request', async ({ browser }) => {
  const { c, p, logins } = await toCodeStep(browser, account.email, { width: 1280, height: 800 });
  const code = totp(account.secret);
  await p.locator('input[name=code]').evaluate((input, text) => {
    const dt = new DataTransfer();
    dt.setData('text', `Your code is ${text.slice(0, 3)} ${text.slice(3)}`);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, code);
  await expect(p.locator('.cc-frame')).toBeVisible({ timeout: 15000 });
  expect(logins.length).toBe(1);
  await c.close();
});

test('a wrong code shows the error once, is not resent, and a corrected code then signs in', async ({ browser }) => {
  const { c, p, logins } = await toCodeStep(browser, account.email, { width: 1280, height: 800 });
  const right = totp(account.secret);
  const wrong = String((Number(right) + 111111) % 1000000).padStart(6, '0');
  await p.locator('input[name=code]').fill(wrong);
  await expect(p.locator('[data-otp10][data-state=error]')).toBeVisible({ timeout: 15000 });
  await expect(p.locator('.auth-error')).toBeVisible();
  await p.waitForTimeout(1500);
  expect(logins.length, 'one request for the wrong code, and no automatic retry').toBe(1);
  await p.locator('input[name=code]').fill(right);
  await expect(p.locator('.cc-frame')).toBeVisible({ timeout: 15000 });
  expect(logins.length).toBe(2);
  await c.close();
});

test('Enter and repeated input while the code is being checked send nothing more', async ({ browser }) => {
  const { c, p, logins } = await toCodeStep(browser, account.email, { width: 1280, height: 800 });
  /* Hold the server's answer so the check is visibly in progress. */
  let release;
  const held = new Promise((r) => { release = r; });
  await p.route('**/auth/admin/login', async (route) => { await held; await route.continue(); });
  const input = p.locator('input[name=code]');
  await input.fill(totp(account.secret));
  await expect(p.locator('[data-otp10][data-state=loading]')).toBeVisible();
  await input.press('Enter');
  await input.evaluate((el) => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.evaluate(() => document.querySelector('form').requestSubmit());
  release();
  await expect(p.locator('.cc-frame')).toBeVisible({ timeout: 15000 });
  expect(logins.length).toBe(1);
  await c.close();
});
