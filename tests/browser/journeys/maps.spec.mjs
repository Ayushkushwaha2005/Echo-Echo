/* ==========================================================================
   THE CHECKOUT SPOT PICKER ON GOOGLE MAPS (and its OpenStreetMap fallback).

   Real production bundle, real API, disposable database. Google itself is
   NOT contacted: the Maps JavaScript loader is answered by a small local
   stand-in (FAKE_GOOGLE below) that implements just the classes the app uses,
   and records how many maps were created. /campus/map is answered by the real
   API with a test `maps` setting added, because the harness has no Google key.
   What this proves: the checkout wiring, the controller contract, one map
   load per visit, mobile layout and the fallback. What it cannot prove: how
   Google's real tiles look - that is checked on the real site.
   ========================================================================== */
import { test, expect } from '@playwright/test';
import { db, userWith, signInAs, vendor, watchProblems } from './helpers.mjs';

const uniq = () => `${Date.now() % 1000000}`;
const INSIDE = { latitude: 30.4166, longitude: 77.9676 };
/* Fixtures this file adds to the shared test database, removed afterwards so
   later journeys see the database as they always have. */
const created = { boundary: null, node: null };
test.afterAll(async () => {
  if (created.node) await db.query(`DELETE FROM campus_node WHERE id = $1`, [created.node]);
  if (created.boundary) await db.query(`DELETE FROM campus_boundary WHERE id = $1`, [created.boundary]);
});

const FAKE_GOOGLE = `(() => {
  const gm = window.__gm = { maps: 0, markers: [] };
  class LatLng { constructor(a, b) { this.a = a; this.b = b; } lat() { return this.a; } lng() { return this.b; } }
  class MVC { constructor() { this.l = {}; } addListener(n, f) { (this.l[n] ||= []).push(f); return { remove() {} }; }
    trigger(n, e) { (this.l[n] || []).forEach((f) => f(e)); } }
  class LatLngBounds { constructor() { this.n = -90; this.s = 90; this.e = -180; this.w = 180; }
    extend(p) { const la = typeof p.lat === 'function' ? p.lat() : p.lat, lo = typeof p.lng === 'function' ? p.lng() : p.lng;
      this.n = Math.max(this.n, la); this.s = Math.min(this.s, la); this.e = Math.max(this.e, lo); this.w = Math.min(this.w, lo); }
    getNorthEast() { return new LatLng(this.n, this.e); } getSouthWest() { return new LatLng(this.s, this.w); } }
  class Map extends MVC {
    constructor(el, o) { super(); gm.maps += 1; gm.map = this; this.el = el; this.type = o.mapTypeId; this.z = o.zoom;
      this.b = { n: 30.422, s: 30.410, e: 77.975, w: 77.960 };
      el.style.position = 'relative';
      const d = document.createElement('div'); d.className = 'fake-gmap'; d.style.cssText = 'position:absolute;inset:0;background:#cfe3d4';
      el.append(d); this.canvas = d;
      d.addEventListener('click', (e) => { const r = d.getBoundingClientRect(), b = this.b;
        this.trigger('click', { latLng: new LatLng(b.n - (e.clientY - r.top) / r.height * (b.n - b.s), b.w + (e.clientX - r.left) / r.width * (b.e - b.w)) }); });
      this.controls = new Proxy({}, { get: () => ({ push: (n) => { n.style.position = 'absolute'; n.style.left = '0'; n.style.bottom = '0'; n.style.zIndex = 5; el.append(n); } }) });
    }
    fitBounds(b) { this.b = { n: b.n, s: b.s, e: b.e, w: b.w }; } setCenter() {} panTo() {} setZoom(z) { this.z = z; } getZoom() { return this.z; }
    getCenter() { return new LatLng((this.b.n + this.b.s) / 2, (this.b.e + this.b.w) / 2); }
    setMapTypeId(t) { this.type = t; } getMapTypeId() { return this.type; }
  }
  class Shape extends MVC { constructor(o = {}) { super(); Object.assign(this, o); } setMap(m) { this.map = m; } setPath() {} setOptions() {} setCenter() {} setRadius() {} }
  class InfoWindow extends Shape { setContent(c) { this.c = c; } open({ map }) { this.c.classList.add('fake-info'); map.el.append(this.c); } close() { this.c?.remove(); } }
  class AdvancedMarkerElement extends MVC {
    constructor(o) { super(); this._map = null; this._c = null; this.position = o.position; this.title = o.title; this.content = o.content; this.map = o.map; gm.markers.push(this); }
    set content(c) { this._c?.remove(); this._c = c; if (c && this._map) this._attach(); }
    get content() { return this._c; }
    set map(m) { this._map = m; if (m) this._attach(); else this._c?.remove(); }
    get map() { return this._map; }
    _attach() { this._c.style.cursor = 'pointer'; this._c.onclick = (e) => { e.stopPropagation(); this.trigger('click', {}); }; this._map.el.append(this._c); }
  }
  /* Laid out exactly as Google's real libraries are (checked on production):
     LatLngBounds, LatLng and ControlPosition are in 'core', NOT in 'maps'. */
  const libs = { maps: { Map, InfoWindow, Polygon: Shape, Polyline: Shape, Circle: Shape },
    marker: { AdvancedMarkerElement }, core: { LatLngBounds, LatLng, ControlPosition: { TOP_RIGHT: 3, LEFT_BOTTOM: 6 } },
    geometry: { encoding: { decodePath: () => [] } } };
  window.google = { maps: { importLibrary: async (n) => libs[n] } };
  const cb = new URL(document.currentScript.src).searchParams.get('callback');
  window[cb]();
})();`;

async function checkoutReady(browser, { google = true } = {}) {
  const v = await vendor(`Map Cafe ${uniq()}`);
  await db.query(`INSERT INTO menu_item (vendor_id, name, price_paise, available, active) VALUES ($1,'Map Chai',3000,true,true)`, [v.id]);
  const person = await userWith({ name: 'Map Student', email: `map.${uniq()}@stu.upes.ac.in` });
  await db.query(`UPDATE app_user SET campus_site_id = (SELECT id FROM campus_site ORDER BY created_at LIMIT 1),
                  contact_phone = '+919999900007', student_status = 'approved' WHERE id = $1`, [person.id]);
  /* A test campus outline and one named delivery point, if none exists yet. */
  const site = (await db.query(`SELECT id FROM campus_site ORDER BY created_at LIMIT 1`)).rows[0].id;
  const b = await db.query(`INSERT INTO campus_boundary (name, polygon, campus_site_id, status, active, source, verified_at)
                  VALUES ('Test Campus', $1, $2, 'active', true, 'browser test fixture', now())
                  ON CONFLICT (campus_site_id) WHERE status = 'active' DO NOTHING RETURNING id`,
  [JSON.stringify([[30.410, 77.960], [30.410, 77.975], [30.422, 77.975], [30.422, 77.960]]), site]);
  if (b.rows[0]) created.boundary = created.boundary || b.rows[0].id;
  const has = (await db.query(`SELECT 1 FROM campus_node WHERE name = 'Map Lawn' AND campus_site_id = $1`, [site])).rowCount;
  if (!has) {
    const n = await db.query(`INSERT INTO campus_node (campus_site_id, kind, name, deliverable, delivery_enabled, lat, lng, verification, radius_m)
                    VALUES ($1,'zone','Map Lawn',true,true,30.4160,77.9680,'confirmed',60) RETURNING id`, [site]);
    created.node = n.rows[0].id;
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, geolocation: INSIDE, permissions: ['geolocation'] });
  await signInAs(context, person.id, 'code');
  const page = await context.newPage();
  const loads = { google: 0 };
  await page.route('https://maps.googleapis.com/maps/api/js**', (route) => {
    loads.google += 1;
    return google ? route.fulfill({ contentType: 'text/javascript', body: FAKE_GOOGLE }) : route.abort();
  });
  await page.route('**/api/campus/map**', async (route) => {
    const r = await route.fetch();
    const body = await r.json();
    body.maps = { provider: 'google', browserKey: 'browser-test-key', mapId: 'TEST_MAP_ID' };
    return route.fulfill({ response: r, json: body });
  });
  await page.goto(`/web/#/menu/${v.id}`);
  await page.locator('[data-act=add]').first().click();
  await page.goto('/web/#/cart');
  return { context, page, loads };
}

test('checkout picker on Google Maps: my location, a named point, a tapped spot, confirm; one map per visit', async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page, loads } = await checkoutReady(browser);
  const problems = watchProblems(page);
  await page.locator('[data-act=sheet][data-sheet=location]').first().click();
  const host = page.locator('.echo-picker-slot .echo-map');
  await expect(page.locator('.fake-gmap')).toHaveCount(1, { timeout: 15000 });
  expect(await page.evaluate(() => window.__gm.map.type)).toBe('hybrid');

  /* Mobile layout: the map fits the 390 px screen and is tall enough to use. */
  const box = await host.boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  expect(box.height).toBeGreaterThanOrEqual(250);

  /* Named point drawn from the API's own delivery points. */
  await expect(page.locator('.eg-tag', { hasText: 'Map Lawn' })).toBeVisible();

  /* Use my current location: the accepted reading is drawn on the same map. */
  await page.locator('[data-act=useGps]').first().click();
  await expect(page.locator('.eg-live')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('#spot-ok')).toBeVisible({ timeout: 15000 });

  /* Tap a custom spot on the map: the server checks it is inside the campus. */
  const pinCalls = [];
  page.on('request', (r) => { if (r.url().includes('/campus/pin')) pinCalls.push(r.url()); });
  await page.locator('.fake-gmap').click({ position: { x: Math.round(box.width / 2), y: Math.round(box.height / 2) } });
  await expect(page.locator('.eg-spot')).toHaveCount(1);
  await expect(page.locator('#spot-ok')).toBeVisible({ timeout: 15000 });
  expect(pinCalls.length).toBeGreaterThan(0);

  /* Named point instead: tapping its marker chooses it. */
  await page.locator('.eg-dest').first().click();
  await expect(page.locator('.eg-dest.sel')).toHaveCount(1, { timeout: 10000 });

  /* Back to the tapped spot, and confirm it. */
  await page.locator('.fake-gmap').click({ position: { x: Math.round(box.width / 3), y: Math.round(box.height / 2) } });
  await expect(page.locator('#spot-ok')).toBeVisible({ timeout: 15000 });
  await page.locator('.sheet-foot .btn-primary:not([disabled])').click();
  await expect(page.locator('.desttile')).not.toHaveClass(/is-empty/, { timeout: 10000 });

  /* Reopening the sheet reuses the same map: no second map load. */
  await page.locator('[data-act=sheet][data-sheet=location]').first().click();
  await expect(page.locator('.fake-gmap')).toHaveCount(1, { timeout: 10000 });
  expect(await page.evaluate(() => window.__gm.maps)).toBe(1);
  expect(loads.google).toBe(1);
  await page.keyboard.press('Escape');

  /* The existing checkout validation now lets the order continue. */
  await expect(page.getByRole('button', { name: /^Continue/ }).first()).toBeEnabled({ timeout: 10000 });
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
  await context.close();
});

test('if Google Maps cannot load, the checkout picker falls back to OpenStreetMap', async ({ browser }) => {
  test.setTimeout(60_000);
  const { context, page, loads } = await checkoutReady(browser, { google: false });
  await page.locator('[data-act=sheet][data-sheet=location]').first().click();
  /* Leaflet's map, or its own "could not load" list when the CDN is out of
     reach in this environment: either way, not a blank Google box. */
  await expect(page.locator('.echo-picker-slot .leaflet-container, .echo-picker-slot .map-empty')).toHaveCount(1, { timeout: 25000 });
  await expect(page.locator('.fake-gmap')).toHaveCount(0);
  expect(loads.google).toBe(1);
  await expect(page.locator('[data-act=useGps]').first()).toBeEnabled();
  await context.close();
});

/* Quota exhausted or key refused AFTER the map is on screen. Google reports
   it through gm_authFailure and/or its own error box in the map; both are
   simulated here exactly as Google delivers them. The student must end up
   on the OpenStreetMap picker and still be able to choose a spot. */
for (const how of ['gm_authFailure', 'error box']) {
  test(`Google failing after load (${how}): checkout falls back to OpenStreetMap and a spot can still be chosen`, async ({ browser }) => {
    test.setTimeout(90_000);
    const { context, page } = await checkoutReady(browser);
    await page.locator('[data-act=sheet][data-sheet=location]').first().click();
    await expect(page.locator('.fake-gmap')).toHaveCount(1, { timeout: 15000 });
    if (how === 'gm_authFailure') await page.evaluate(() => window.gm_authFailure());
    else {
      await page.evaluate(() => {
        const box = document.createElement('div');
        box.className = 'gm-err-container';
        box.textContent = "This page can't load Google Maps correctly.";
        window.__gm.map.el.append(box);
      });
    }
    await expect(page.locator('.fake-gmap')).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator('.echo-picker-slot .leaflet-container, .echo-picker-slot .map-empty')).toHaveCount(1, { timeout: 25000 });
    await page.locator('[data-act=useGps]').first().click();
    await expect(page.locator('#spot-ok')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.sheet-foot .btn-primary:not([disabled])')).toHaveCount(1);
    await context.close();
  });
}
