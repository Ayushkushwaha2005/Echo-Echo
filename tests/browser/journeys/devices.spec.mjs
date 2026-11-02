/* Delivery tracking on emulated phones: Pixel in Chromium and iPhone in WebKit, with
   a real permission grant, real offline and moving positions. Emulation exercises the
   page and the browser engine. It says nothing about a real phone's GPS, a locked
   screen or battery: docs/DELIVERY-TRACKING.md has that checklist for real devices. */
import { test, expect } from '@playwright/test';
import { db, userWith, signInAs, watchProblems, vendor, partnerReady } from './helpers.mjs';

const uniq = () => `${Date.now() % 1000000}`;
const near = { latitude: 30.4172, longitude: 77.9681 };

async function delivery(tag) {
  const v = await vendor(`${tag} Cafe`);
  const cust = await userWith({ name: `${tag} Customer`, email: `${tag.toLowerCase()}c.${uniq()}@stu.upes.ac.in` });
  await partnerReady(cust.id);
  const partner = await userWith({ name: `${tag} Partner`, roles: ['student', 'delivery_partner'], email: `${tag.toLowerCase()}p.${uniq()}@stu.upes.ac.in` });
  await partnerReady(partner.id);
  const { rows: [order] } = await db.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id, destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery','picked_up',9000,10000,$4,'{"name":"Block 4"}','+919999900002','manual_map_spot',30.4172,77.9681) RETURNING id, code`,
    [`${tag[0]}${uniq()}`, cust.id, v.id, partner.id]);
  return { cust, partner, order };
}
const stored = async (id) => (await db.query(`SELECT lat, lng FROM partner_location WHERE order_id = $1`, [id])).rows[0] || null;
/* Device fixtures come from the project; these journeys add geolocation per context. */
const phone = async (browser, testInfo, extra = {}) => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = testInfo.project.use;
  return browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, ...extra });
};

test('sharing starts on a phone, a moving position is followed, and the customer sees it', async ({ browser }, testInfo) => {
  const { cust, partner, order } = await delivery('Moving');
  const context = await phone(browser, testInfo, { geolocation: near, permissions: ['geolocation'] });
  await signInAs(context, partner.id, 'code');
  const page = await context.newPage();
  const problems = watchProblems(page);
  await page.goto('/web/#/partner');
  await page.getByRole('button', { name: 'Start sharing' }).click();
  await expect(page.getByText('Sharing your location')).toBeVisible();
  await expect.poll(() => stored(order.id), { timeout: 20000 }).not.toBeNull();

  const moved = { latitude: near.latitude + 0.0012, longitude: near.longitude + 0.0012 };
  await context.setGeolocation(moved);
  await expect.poll(async () => Number((await stored(order.id))?.lat), { timeout: 40000 }).toBeCloseTo(moved.latitude, 3);

  const cc = await phone(browser, testInfo);
  await signInAs(cc, cust.id, 'code');
  const cp = await cc.newPage();
  const seen = [];
  cp.on('response', async (r) => { if (/\/orders\/[^/]+\/tracking\/?$/.test(new URL(r.url()).pathname)) seen.push(await r.json().catch(() => null)); });
  await cp.goto(`/web/#/tracking/${order.id}`);
  await expect.poll(() => seen.length, { timeout: 20000 }).toBeGreaterThan(0);
  expect(seen[0].partnerVisibility).toBe('visible');
  await cc.close();

  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await expect.poll(() => stored(order.id), { timeout: 15000 }).toBeNull();
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
  await context.close();
});

test('the network drops mid-delivery: the partner is told, and sharing recovers when it returns', async ({ browser }, testInfo) => {
  const { partner, order } = await delivery('Offline');
  const context = await phone(browser, testInfo, { geolocation: near, permissions: ['geolocation'] });
  await signInAs(context, partner.id, 'code');
  const page = await context.newPage();
  await page.goto('/web/#/partner');
  await page.getByRole('button', { name: 'Start sharing' }).click();
  await expect.poll(() => stored(order.id), { timeout: 20000 }).not.toBeNull();

  await context.setOffline(true);
  await context.setGeolocation({ latitude: near.latitude + 0.002, longitude: near.longitude });
  await expect(page.getByText(/connection|network|offline|could not send|reach/i).first()).toBeVisible({ timeout: 60000 });

  await context.setOffline(false);
  const back = { latitude: near.latitude + 0.003, longitude: near.longitude };
  await context.setGeolocation(back);
  await expect.poll(async () => Number((await stored(order.id))?.lat), { timeout: 60000 }).toBeCloseTo(back.latitude, 3);
  await context.close();
});

test('a screen hidden and shown again keeps the same single watch and goes on reporting', async ({ browser }, testInfo) => {
  const { partner, order } = await delivery('Hidden');
  const context = await phone(browser, testInfo, { geolocation: near, permissions: ['geolocation'] });
  await signInAs(context, partner.id, 'code');
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__watches = 0;
    const real = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    navigator.geolocation.watchPosition = (...a) => { window.__watches += 1; return real(...a); };
  });
  await page.goto('/web/#/partner');
  await page.getByRole('button', { name: 'Start sharing' }).click();
  await expect.poll(() => stored(order.id), { timeout: 20000 }).not.toBeNull();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const next = { latitude: near.latitude + 0.0015, longitude: near.longitude };
  await context.setGeolocation(next);
  await expect.poll(async () => Number((await stored(order.id))?.lat), { timeout: 40000 }).toBeCloseTo(next.latitude, 3);
  expect(await page.evaluate(() => window.__watches)).toBe(1);
  await context.close();
});
