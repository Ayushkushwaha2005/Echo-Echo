/* What happens when streams are off, or a stream is cut. A second, real API process runs
   with streams on, so a real browser EventSource is really disconnected and reconnects. */
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, owner, signInAs, vendor, openAdmin } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '..', '..', '..', 'server');
const port = readFileSync(join(server, 'var', 'pgport'), 'utf8').trim();
const STREAM_PORT = 4176;

function startStreamApi() {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: server, stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'test', SWEEPER: 'off', PORT: String(STREAM_PORT), LIVE_STREAMS_ENABLED: 'true', TRUST_PROXY: 'false',
      DATABASE_URL: `postgres://quad:quad@127.0.0.1:${port}/quad_test`, DB_SSL: 'false', PLATFORM_OWNER_PHONE: '+919000000000', WEB_ORIGIN: 'http://127.0.0.1:4173',
      COOKIE_SECRET: 'browser-test-secret-at-least-32-characters', ADMIN_TOTP_KEY: 'browser-test-totp-key-0123456789abcdef' },
  });
  return child;
}
const stop = (child) => new Promise((res) => { child.once('exit', res); child.kill(); });
async function up() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${STREAM_PORT}/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('stream API did not start');
}

test('with streams off the browser is told so and stops asking, and an open admin page still updates by polling', async ({ page, context }) => {
  const o = await owner();
  await signInAs(context, o.id);
  const v = await vendor(`Polling Cafe ${Date.now() % 100000}`);
  const streamAsks = [];
  page.on('response', (r) => { if (/live\/stream/.test(r.url())) streamAsks.push(r.status()); });
  await openAdmin(page, 'cafeterias');
  await expect(page.getByText(v.name).first()).toBeVisible({ timeout: 15000 });
  const renamed = `${v.name} Renamed`;
  const t = Date.now();
  await db.query(`UPDATE vendor SET name = $2 WHERE id = $1`, [v.id, renamed]);
  await expect(page.getByText(renamed).first()).toBeVisible({ timeout: 15000 });
  expect(Date.now() - t, 'within the poll interval and a reload').toBeLessThan(15000);
  expect(streamAsks.every((s) => s === 204)).toBe(true);
});

test('an open public page picks up a cafe change with no stream', async ({ page }) => {
  test.setTimeout(200_000);
  const v = await vendor(`Public Poll Cafe ${Date.now() % 100000}`);
  await page.goto('/web/#/cafes');
  await expect(page.getByText(v.name).first()).toBeVisible({ timeout: 20000 });
  /* The client's own refresh runs every minute; this is the bound the audit asked for. */
  await db.query(`UPDATE vendor SET active = false WHERE id = $1`, [v.id]);
  await expect(page.getByText(v.name)).toHaveCount(0, { timeout: 150_000 });
});

test('a menu left open shows a new price and a sold-out item within the refresh, with no stream or reload', async ({ page }) => {
  test.setTimeout(200_000);
  const v = await vendor(`Open Menu Cafe ${Date.now() % 100000}`);
  const { rows: [item] } = await db.query(`INSERT INTO menu_item (vendor_id, name, price_paise, available, active) VALUES ($1,'Open Menu Tea',2500,true,true) RETURNING id`, [v.id]);
  await db.query(`INSERT INTO menu_item (vendor_id, name, price_paise, available, active) VALUES ($1,'Open Menu Bun',4000,true,true)`, [v.id]);
  await page.goto(`/web/#/menu/${v.id}`);
  await expect(page.getByText('Open Menu Tea').first()).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => { window.__sameDocument = true; });
  await db.query(`UPDATE menu_item SET price_paise = 3700 WHERE id = $1`, [item.id]);
  await db.query(`UPDATE menu_item SET available = false WHERE vendor_id = $1 AND name = 'Open Menu Bun'`, [v.id]);
  await expect(page.getByText(/37/).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Sold out').first()).toBeVisible();
  expect(await page.evaluate(() => window.__sameDocument), 'no reload').toBe(true);
});

test('a real stream is cut: the browser reconnects by itself and is told what it missed', async ({ page }) => {
  test.setTimeout(120_000);
  let api = startStreamApi();
  try {
    await up();
    const v = await vendor(`Stream Cafe ${Date.now() % 100000}`);
    /* Same origin as the stream, as it is through the Vercel rewrite in production. */
    await page.route(`http://127.0.0.1:${STREAM_PORT}/blank`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>stream</title>' }));
    await page.goto(`http://127.0.0.1:${STREAM_PORT}/blank`);
    await page.evaluate((url) => {
      window.__events = []; window.__errors = 0; window.__opens = 0;
      const es = new EventSource(url);
      es.addEventListener('open', () => { window.__opens += 1; });
      es.addEventListener('error', () => { window.__errors += 1; });
      es.addEventListener('change', (e) => window.__events.push(JSON.parse(e.data)));
    }, '/live/stream');
    await expect.poll(() => page.evaluate(() => window.__opens), { timeout: 15000 }).toBeGreaterThan(0);

    await db.query(`UPDATE vendor SET description = 'first' WHERE id = $1`, [v.id]);
    await expect.poll(() => page.evaluate(() => window.__events.length), { timeout: 15000 }).toBeGreaterThan(0);
    const before = await page.evaluate(() => window.__events.length);
    const body = JSON.stringify(await page.evaluate(() => window.__events));
    expect(body, 'an event names an area, never a record').not.toContain(v.id);

    await stop(api);
    await expect.poll(() => page.evaluate(() => window.__errors), { timeout: 15000 }).toBeGreaterThan(0);
    await db.query(`UPDATE vendor SET description = 'changed while the stream was down' WHERE id = $1`, [v.id]);

    api = startStreamApi();
    await up();
    await expect.poll(() => page.evaluate(() => window.__opens), { timeout: 30000 }).toBeGreaterThan(1);
    await expect.poll(() => page.evaluate(() => window.__events.length), { timeout: 30000 }).toBeGreaterThan(before);
  } finally {
    await stop(api).catch(() => {});
  }
});
