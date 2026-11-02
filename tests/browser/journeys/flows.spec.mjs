/* The journeys the first pass left out: real sign-in as a student, a cart that stops
   before any payment, applying to deliver, a delivery from offer to handoff code, bulk
   prices, restoring a menu item, a deletion request end to end, and a lost authenticator. */
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { db, owner, userWith, signInAs, totp, lastMailTo, PASSWORD, watchProblems, vendor, openAdmin, partnerReady } from './helpers.mjs';

const uniq = () => `${Date.now() % 1000000}`;

async function cafeWithItem(cafe = 'Flow Cafe', dish = 'Flow Chai', paise = 2500) {
  const v = await vendor(cafe);
  const { rows: [item] } = await db.query(
    `INSERT INTO menu_item (vendor_id, name, price_paise, available, active) VALUES ($1,$2,$3,true,true) RETURNING id, revision`, [v.id, dish, paise]);
  return { v, item };
}

test('bulk prices: the preview changes nothing, a conflict is refused, Apply all changes every row', async ({ page, context }) => {
  const problems = watchProblems(page);
  const o = await owner();
  await signInAs(context, o.id);
  const { v, item } = await cafeWithItem(`Bulk Cafe ${uniq()}`, 'Bulk Tea', 2000);
  const { rows: [second] } = await db.query(`INSERT INTO menu_item (vendor_id, name, price_paise, available, active) VALUES ($1,'Bulk Bun',4000,true,true) RETURNING id`, [v.id]);

  const openBulk = async () => {
    await openAdmin(page, 'menu');
    await page.locator('[data-act=pickVendor]').selectOption({ value: v.id });
    await page.locator('[data-act=bulkPrices]').click();
  };
  await openBulk();
  await page.locator(`input[name="p:${item.id}"]`).fill('25');
  await page.locator(`input[name="p:${second.id}"]`).fill('45');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.getByRole('button', { name: 'Apply all' })).toBeVisible();
  expect((await db.query(`SELECT price_paise FROM menu_item WHERE id = $1`, [item.id])).rows[0].price_paise, 'preview saved nothing').toBe(2000);

  /* Someone else edits one item while this person is reading the preview. */
  await db.query(`UPDATE menu_item SET name = 'Bulk Tea Edited' WHERE id = $1`, [item.id]);
  await page.getByRole('button', { name: 'Apply all' }).click();
  await expect(page.getByText(/Nothing was changed/).first()).toBeVisible();
  expect((await db.query(`SELECT price_paise FROM menu_item WHERE id = $1`, [second.id])).rows[0].price_paise, 'all or nothing').toBe(4000);

  await page.goto('/admin/');
  await openBulk();
  await page.locator(`input[name="p:${item.id}"]`).fill('25');
  await page.locator(`input[name="p:${second.id}"]`).fill('45');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('button', { name: 'Apply all' }).click();
  await expect(page.getByText('2 prices updated')).toBeVisible();
  const prices = (await db.query(`SELECT price_paise FROM menu_item WHERE vendor_id = $1 ORDER BY name`, [v.id])).rows.map((r) => r.price_paise);
  expect(prices.sort()).toEqual([2500, 4500]);
  expect(problems).toEqual([]);
});

test('a wrong menu edit can be undone from its history', async ({ page, context }) => {
  const problems = watchProblems(page);
  const o = await owner();
  await signInAs(context, o.id);
  const { v, item } = await cafeWithItem(`Restore Cafe ${uniq()}`, 'Restore Tea', 2000);
  await db.query(`UPDATE menu_item SET price_paise = 9900 WHERE id = $1`, [item.id]);

  await openAdmin(page, 'menu');
  await page.locator('[data-act=pickVendor]').selectOption({ value: v.id });
  await page.locator(`[data-act=itemHistory][data-id="${item.id}"]`).click();
  await page.locator('[data-act=itemRestore]').first().click();
  await expect(page.getByText(/Restored revision/)).toBeVisible();
  expect((await db.query(`SELECT price_paise FROM menu_item WHERE id = $1`, [item.id])).rows[0].price_paise).toBe(2000);
  expect(problems).toEqual([]);
});

test('a deletion request, end to end: asked, reviewed, answered, and the person sees the answer', async ({ browser }) => {
  const leaving = `Leaving ${uniq().replace(/\d/g, (d) => 'abcdefghij'[d])}`;
  const person = await userWith({ name: leaving, email: `leaving.${uniq()}@stu.upes.ac.in` });
  await partnerReady(person.id);
  const sc = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await signInAs(sc, person.id, 'code');
  const s = await sc.newPage();
  const asked = [];
  s.on('dialog', (d) => { asked.push(d.message()); d.accept(); });
  await s.goto('/web/#/profile');
  await s.locator('[data-act=askDeletion]').click();
  await expect(s.getByText(/Request sent/)).toBeVisible();

  const o = await owner();
  const ac = await browser.newContext();
  await signInAs(ac, o.id);
  const a = await ac.newPage();
  const problems = watchProblems(a);
  await openAdmin(a, 'privacy');
  const row = a.getByRole('row', { name: new RegExp(leaving) });
  await row.locator('[data-act=reviewDataRequest]').click();
  await expect(a.getByRole('cell', { name: 'Identity documents' })).toBeVisible();
  await a.locator('.modalwrap select[name=status]').selectOption('completed');
  await a.locator('.modalwrap input[name=note]').fill('Profile cleared by hand; order records kept.');
  await a.locator('.modalwrap button[type=submit]').click();
  await expect(a.getByRole('row', { name: new RegExp(leaving) }).getByText('completed')).toBeVisible();
  expect((await db.query(`SELECT count(*)::int n FROM app_user WHERE id = $1`, [person.id])).rows[0].n, 'recording deletes nothing').toBe(1);
  expect(problems).toEqual([]);

  await s.goto('/web/#/profile');
  await s.locator('[data-act=askDeletion]').click();
  await expect.poll(() => asked.at(-1)).toMatch(/completed: Profile cleared by hand; order records kept/);
  await sc.close();
  await ac.close();
});

test('a student signs in with their university mailbox and reaches a cart that stops before payment', async ({ browser }) => {
  const { v } = await cafeWithItem(`Student Cafe ${uniq()}`, 'Student Chai', 3000);
  const email = `first.${uniq()}@stu.upes.ac.in`;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const problems = watchProblems(page);
  const paymentCalls = [];
  page.on('request', (r) => { if (/\/payments?\/|cashfree|razorpay/i.test(r.url())) paymentCalls.push(r.url()); });

  await page.goto('/web/#/signin');
  await page.getByRole('button', { name: /Continue as Student/ }).click();
  await page.locator('[data-act=pickCollege]').first().click();
  await page.locator('[data-act=pickObCampus]').first().click();
  await page.locator('#ob-em').fill(email.split('@')[0]);
  await page.locator('form[data-form=email] button[type=submit]').click();
  const [, code] = await lastMailTo(email, /(\d{6})/);
  const boxes = page.locator('form[data-form=emailcode] [data-otp]');
  for (let i = 0; i < code.length; i++) await boxes.nth(i).fill(code[i]);
  await page.locator('form[data-form=emailcode] button[type=submit]').click();
  await expect.poll(async () => (await db.query(`SELECT count(*)::int n FROM app_user WHERE student_email = $1`, [email])).rows[0].n, { timeout: 15000 }).toBe(1);

  await page.getByRole('textbox', { name: 'Full name' }).fill('First Student');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect.poll(async () => (await db.query(`SELECT name FROM app_user WHERE student_email = $1`, [email])).rows[0]?.name, { timeout: 15000 }).toBe('First Student');

  await page.goto(`/web/#/menu/${v.id}`);
  await page.locator('[data-act=add]').first().click();
  await page.goto('/web/#/cart');
  await expect(page.getByText('Student Chai').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/30/).first()).toBeVisible();
  expect(paymentCalls, 'no payment call on the way to the cart').toEqual([]);
  expect((await db.query(`SELECT count(*)::int n FROM food_order o JOIN app_user u ON u.id = o.customer_id WHERE u.student_email = $1`, [email])).rows[0].n).toBe(0);
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
  await context.close();
});

test('applying to deliver: the policy must be accepted, and the application reaches Campus Control', async ({ browser }) => {
  const name = `Applicant ${uniq().replace(/\d/g, (d) => 'abcdefghij'[d])}`;
  const person = await userWith({ name, email: `apply.${uniq()}@stu.upes.ac.in` });
  await db.query(`UPDATE app_user SET campus_site_id = (SELECT id FROM campus_site ORDER BY created_at LIMIT 1), contact_phone = '+919999900004', student_status = 'approved' WHERE id = $1`, [person.id]);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await signInAs(context, person.id, 'code');
  const page = await context.newPage();
  await page.goto('/web/#/partner');
  /* The real upload: the server re-encodes it, then the button opens. */
  const require = createRequire(new URL('../../../server/package.json', import.meta.url));
  const noise = Buffer.alloc(400 * 400 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = 90 + ((i * 7919) ^ (i >> 3)) % 120;
  const photo = await require('sharp')(noise, { raw: { width: 400, height: 400, channels: 3 } }).png().toBuffer();
  await page.locator('[data-partner-photo]').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: photo });
  const join = page.locator('[data-act=joinPartner]:not([disabled])').first();
  await join.waitFor({ timeout: 15000 });
  await join.click();
  await expect(page.getByText(/Tick the box/)).toBeVisible();
  await page.locator('#accept-policy').check();
  await page.locator('[data-act=joinPartner]').first().click();
  await expect.poll(async () => (await db.query(`SELECT status FROM partner_profile WHERE user_id = $1`, [person.id])).rows[0]?.status, { timeout: 15000 }).toBe('pending');
  await context.close();

  const o = await owner();
  const ac = await browser.newContext();
  await signInAs(ac, o.id);
  const a = await ac.newPage();
  await openAdmin(a, 'partners');
  await expect(a.getByText(name).first()).toBeVisible({ timeout: 15000 });
  await ac.close();
});

test('a delivery from offer to handoff: accept, counter code, student code, and the position is gone', async ({ browser }) => {
  test.setTimeout(120_000);
  const { v } = await cafeWithItem(`Handoff Cafe ${uniq()}`, 'Handoff Roll', 9000);
  const customer = await userWith({ name: 'Handoff Customer', email: `hc.${uniq()}@stu.upes.ac.in` });
  await partnerReady(customer.id);
  const partner = await userWith({ name: 'Handoff Partner', roles: ['student', 'delivery_partner'], email: `hp.${uniq()}@stu.upes.ac.in` });
  await partnerReady(partner.id);
  await db.query(`UPDATE partner_profile SET online = true WHERE user_id = $1`, [partner.id]);
  const { rows: [order] } = await db.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery','ready',9000,10000,'{"name":"Block 4","label":"Block 4"}','+919999900002','manual_map_spot',30.4172,77.9681) RETURNING id, code`,
    [`H${uniq()}`, customer.id, v.id]);
  await db.query(`INSERT INTO delivery_offer (order_id, partner_id, expires_at) VALUES ($1,$2, now() + interval '10 minutes')`, [order.id, partner.id]);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, geolocation: { latitude: 30.4172, longitude: 77.9681 }, permissions: ['geolocation'] });
  await signInAs(context, partner.id, 'code');
  const p = await context.newPage();
  const problems = watchProblems(p);
  await p.goto('/web/#/partner');
  await p.locator('[data-act=acceptOffer]').first().click();
  await expect.poll(async () => (await db.query(`SELECT partner_id FROM food_order WHERE id = $1`, [order.id])).rows[0].partner_id, { timeout: 15000 }).toBe(partner.id);

  /* The counter's code, read the way the counter reads it. */
  const counter = await userWith({ name: 'Counter Staff', roles: ['vendor_owner'], vendorId: v.id });
  const cc = await browser.newContext();
  await signInAs(cc, counter.id, 'code');
  const cp = await cc.newPage();
  await cp.goto('/shop/');
  const pickup = await cp.evaluate(async (id) => (await (await fetch(`/api/orders/${id}/pickup-code`, { credentials: 'include' })).json()).code, order.id);
  expect(pickup).toMatch(/^\d+$/);
  await cc.close();

  await p.locator('[data-act=pickupCode]').first().click();
  await p.locator('.sheet input, input[name=code]').first().fill(pickup);
  await p.locator('.sheet button[type=submit], form button[type=submit]').first().click();
  await expect.poll(async () => (await db.query(`SELECT state FROM food_order WHERE id = $1`, [order.id])).rows[0].state, { timeout: 15000 }).toBe('picked_up');

  /* The customer's screen shows the code; the partner types it in. */
  const stc = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await signInAs(stc, customer.id, 'code');
  const st = await stc.newPage();
  await st.goto(`/web/#/tracking/${order.id}`);
  await st.locator('[data-act=handoff]').first().click();
  const digits = (await st.locator('.codebox').first().innerText()).replace(/\D/g, '');
  expect(digits).toMatch(/^\d{4,6}$/);
  await stc.close();

  await p.goto('/web/#/partner');
  await p.locator('[data-act=doHandoff]').first().click();
  await p.locator('.sheet input, input[name=code]').first().fill(digits);
  await p.locator('.sheet button[type=submit], form button[type=submit]').first().click();
  await expect.poll(async () => (await db.query(`SELECT state FROM food_order WHERE id = $1`, [order.id])).rows[0].state, { timeout: 15000 }).toBe('delivered');
  expect((await db.query(`SELECT count(*)::int n FROM partner_location WHERE order_id = $1`, [order.id])).rows[0].n, 'no position outlives the delivery').toBe(0);
  expect(problems.filter((x) => x.startsWith('pageerror'))).toEqual([]);
  await context.close();
});

test('a lost authenticator: recovery codes, password and a new authenticator, then normal sign-in, and the old code is dead', async ({ page, context, browser }) => {
  test.setTimeout(150_000);
  const o = await owner();
  await signInAs(context, o.id);
  const email = `lost.${uniq()}@example.org`;
  await openAdmin(page, 'admins');
  await page.getByRole('button', { name: 'Invite administrator' }).click();
  await page.locator('input[name=name]').fill('Lost Key');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[type=checkbox][value="students.view"]').check();
  await page.locator('.modalwrap button[type=submit]').click();
  const [, token] = await lastMailTo(email, /#invite=([\w-]+)/);

  const emp = await browser.newContext();
  const p = await emp.newPage();
  await p.goto(`/admin/#invite=${token}`);
  await p.getByRole('button', { name: 'Email me a code' }).click();
  const [, otp] = await lastMailTo(email, /is: (\d{6})/);
  await p.locator('input[name=code]').fill(otp);
  await p.getByRole('button', { name: 'Continue' }).click();
  await p.getByRole('button', { name: 'Accept this invitation' }).click();
  await p.locator('input[name=password]').fill(PASSWORD);
  await p.locator('input[name=again]').fill(PASSWORD);
  await p.getByRole('button', { name: 'Save password' }).click();
  await p.getByRole('button', { name: 'Show my QR code' }).click();
  await p.locator('.enrol-key summary').click();
  const oldSecret = (await p.locator('.enrol-secret').textContent()).replace(/\s/g, '');
  await p.locator('input[name=code]').fill(totp(oldSecret));
  await p.getByRole('button', { name: 'Finish setup' }).click();

  const signIn = async (secret) => {
    await db.query(`UPDATE admin_credential SET totp_last_step = NULL WHERE user_id = (SELECT id FROM app_user WHERE staff_email = $1)`, [email]);
    await p.goto('/admin/');
    await p.locator('input[type=email], input[name=email]').first().fill(email);
    await p.locator('input[type=password]').first().fill(PASSWORD);
    await p.locator('button[type=submit]').first().click();
    await p.locator('input[inputmode=numeric]').first().fill(totp(secret));
    await p.locator('button[type=submit]').first().click();
  };
  await p.getByRole('button', { name: 'Go to Campus Control sign-in' }).click();
  await signIn(oldSecret);
  await p.locator('.cc-frame').waitFor();

  await p.locator('.cc-navbtn[data-route=profile], [data-route=profile]').first().evaluate((b) => b.click());
  await p.locator('[data-act=newRecoveryCodes]').click();
  await p.locator('.modalwrap button[type=submit]').click();
  const codesText = await p.locator('.modalwrap').filter({ hasText: 'Your recovery codes' }).innerText({ timeout: 15000 });
  const code = codesText.match(/[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+/)?.[0];
  expect(code, 'a code was shown').toBeTruthy();

  await emp.clearCookies();
  await p.goto('/admin/');
  await p.getByRole('button', { name: /lost.*authenticator|authenticator.*lost|recover/i }).first().click();
  await p.locator('input[name=email]').fill(email);
  await p.locator('input[name=password]').fill(PASSWORD);
  await p.locator('input[name=recoveryCode]').fill(code);
  await p.locator('button[type=submit]').click();
  await p.locator('.enrol-key summary').click();
  const newSecret = (await p.locator('.enrol-secret').textContent()).replace(/\s/g, '');
  await p.locator('input[name=code]').fill(totp(newSecret));
  await p.locator('button[type=submit]').click();
  await expect(p.getByRole('heading', { name: 'Authenticator replaced' })).toBeVisible();
  await lastMailTo(email, /recover|authenticator/i);

  await signIn(newSecret);
  await p.locator('.cc-frame').waitFor();
  await emp.clearCookies();
  await signIn(oldSecret);
  await expect(p.locator('.cc-frame')).toHaveCount(0);
  await emp.close();
});
