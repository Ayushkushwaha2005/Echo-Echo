/* ==========================================================================
   THE CAFÉ LIST, FAST AND STILL TRUE
   Three things make the homepage's cafés appear sooner, and each has a
   condition that keeps it honest:

   * The browser asks for /api/vendors/ (slashed) directly instead of being
     308-redirected there by vercel.json's trailingSlash. The API must give
     the slashed and unslashed spellings the same answer, signed out too.
   * Vercel's edge keeps the public list fresh for 15 s and may serve an
     older copy, up to a day, while it asks the sleeping server again (a cold
     start measured 25-50 s on 3 Nov 2026). An older copy still says which
     cafés exist, never who is open: the edge's Age header reaches the page,
     which shows any copy older than one minute as "Checking" and asks again
     with ?fresh=1, which the edge never keeps. That is only safe because the
     list is the same for every caller and sets no cookie; the archived-café
     list (staff only) is never given the cache header.
   * Ordering does not trust the list: a closed café is refused at order
     time whatever a cached list said (covered in cafe-hours.test.mjs).
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, truncateAll, makeUser, campusId } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

const VERCEL = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../vercel.json', import.meta.url)), 'utf8'));

let app, pool, cid;
before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.4@stu.upes.ac.in';
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => {
  await truncateAll(pool);
  cid = await campusId(pool);
  await pool.query(`INSERT INTO vendor (slug, name, campus_site_id, is_open, accepting, active)
                    VALUES ('chai-garam', 'Chai Garam', $1, true, true, true),
                           ('old-kiosk', 'Old Kiosk', $1, false, false, false)`, [cid]);
});

const anon = (url) => app.inject({ method: 'GET', url });

test('the slashed list URL is public and answers exactly like the unslashed one', async () => {
  const a = await anon(`/vendors?campusId=${cid}`);
  const b = await anon(`/vendors/?campusId=${cid}`);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.deepEqual(b.json(), a.json());
  assert.deepEqual(b.json().vendors.map((v) => v.slug), ['chai-garam']);
});

test('the public list is the same for every caller and sets no cookie, so an edge may share it', async () => {
  const s = await client(app, await sessionFor(pool, (await makeUser(pool, { phone: '+919610009001', name: 'Test Student' })).id));
  const signedIn = await s.get(`/vendors/?campusId=${cid}`);
  const signedOut = await anon(`/vendors/?campusId=${cid}`);
  assert.deepEqual(signedIn.body, signedOut.json());
  assert.equal(signedOut.headers['set-cookie'], undefined);
});

test('the archived-café list needs staff, and the edge rule never applies to it', async () => {
  assert.equal((await anon('/vendors/?includeArchived=true')).statusCode, 401);
  const rule = VERCEL.headers.find((h) => h.source === '/api/vendors/' && h.headers.some((x) => /cdn-cache-control/i.test(x.key)));
  assert.ok(rule, 'vercel.json caches the café list at the edge');
  assert.equal(rule.source, '/api/vendors/', 'only the list: never a menu, an order or anything signed-in');
  assert.ok(rule.missing?.some((m) => m.type === 'query' && m.key === 'includeArchived'));
  assert.ok(rule.missing?.some((m) => m.type === 'query' && m.key === 'fresh'), 'a ?fresh=1 request always reaches the server');
});

test('?fresh=1 is the same list, so skipping the edge changes nothing but its age', async () => {
  const a = await anon(`/vendors/?campusId=${cid}`);
  const b = await anon(`/vendors/?campusId=${cid}&fresh=1`);
  assert.equal(b.statusCode, 200);
  assert.deepEqual(b.json(), a.json());
});

/* Reference data: which campuses exist and how sign-in works. It changes a few
   times a year, nothing is ordered from it, and the server checks a campus again
   at sign-in and at every order. Served stale while the edge refreshes, it lets
   the first screen appear while a sleeping API wakes; never past a day. */
const REFERENCE = ['/api/campuses/', '/api/auth/status/'];

test('reference data is the same for everyone and sets no cookie, so a day-old copy is safe to share', async () => {
  const u = await makeUser(pool, { phone: '+919811100001', name: 'Signed In', roles: ['student'] });
  const me = client(app, await sessionFor(pool, u.id));
  for (const src of REFERENCE) {
    const path = src.replace(/^\/api/, '');
    const out = await anon(path);
    assert.equal(out.statusCode, 200, path);
    assert.equal(out.headers['set-cookie'], undefined, `${path} sets no cookie`);
    assert.deepEqual((await me.get(path)).body, JSON.parse(out.body), `${path} is the same signed in`);
    const value = VERCEL.headers.find((h) => h.source === src).headers.find((x) => /cdn-cache-control/i.test(x.key)).value;
    const n = (k) => Number(new RegExp(`${k}=(\\d+)`).exec(value)?.[1] ?? 0);
    assert.ok(n('max-age') > 0 && n('max-age') <= 300, `${src}: fresh for at most 5 minutes`);
    assert.ok(n('max-age') + n('stale-while-revalidate') <= 86_400, `${src}: never older than a day`);
    assert.doesNotMatch(value, /stale-if-error/, src);
  }
});

/* Lists the page reads the age of, and shows as "Checking" past a minute (web/src/app.js, vendorsFor). */
const AGED = ['/api/vendors/'];

test('an aged café list is fresh 15 s, never older than a day, and its age reaches the page', async () => {
  const value = VERCEL.headers.find((h) => h.source === '/api/vendors/').headers.find((x) => /cdn-cache-control/i.test(x.key)).value;
  const n = (k) => Number(new RegExp(`${k}=(\\d+)`).exec(value)?.[1] ?? 0);
  assert.equal(n('max-age'), 15);
  assert.ok(n('max-age') + n('stale-while-revalidate') <= 86_400, value);
  assert.doesNotMatch(value, /stale-if-error/);
  globalThis.QUAD_API_BASE = '/api';
  const was = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ vendors: [] }), { status: 200, headers: { Age: '3600' } });
  try {
    const { quad } = await import('../../packages/data/client.js');
    assert.equal((await quad.vendors({ campusId: cid })).ageSeconds, 3600, 'the page is told the copy is an hour old');
    globalThis.fetch = async () => new Response(JSON.stringify({ vendors: [] }), { status: 200 });
    assert.equal((await quad.vendors({ campusId: cid })).ageSeconds, 0, 'an answer straight from the server is new');
  } finally { globalThis.fetch = was; }
});

test('the edge never holds anything else longer than the page itself would (60 s)', () => {
  const all = VERCEL.headers.flatMap((h) => h.headers.filter((x) => /cdn-cache-control/i.test(x.key)).map((x) => [h.source, x.value]));
  /* Only public, identical-for-everyone answers are held at the edge: the café
     list and the PUBLISHED website settings (never a draft, which lives under
     /admin/site and needs a session), plus the reference data below. */
  assert.deepEqual(all.map(([src]) => src).sort(),
    ['/api/auth/status/', '/api/campuses/', '/api/site/config/', '/api/site/version/', '/api/vendors/'],
    `edge-cached routes: ${JSON.stringify(all)}`);
  const caching = all.filter(([src]) => !REFERENCE.includes(src) && !AGED.includes(src));
  for (const [src, value] of caching) {
    const n = (k) => Number(new RegExp(`${k}=(\\d+)`).exec(value)?.[1] ?? 0);
    assert.ok(n('max-age') > 0, src);
    assert.ok(n('max-age') + n('stale-while-revalidate') <= 60, `${src}: ${value}`);
    assert.doesNotMatch(value, /stale-if-error/, 'an outage must not stretch how old an answer can be');
  }
});

test('the browser client asks for slashed paths, and the API serves them', async () => {
  const seen = [];
  globalThis.QUAD_API_BASE = '/api';
  globalThis.fetch = async (url, init) => {
    seen.push(url);
    const r = await app.inject({ method: init.method, url: url.replace(/^\/api/, ''), payload: init.body });
    return new Response(r.body, { status: r.statusCode });
  };
  const { quad } = await import('../../packages/data/client.js');
  const list = await quad.vendors({ campusId: cid });
  await quad.campuses();
  await quad.me();
  assert.deepEqual(seen, [`/api/vendors/?campusId=${cid}`, '/api/campuses/', '/api/auth/me/']);
  assert.deepEqual(list.vendors.map((v) => v.slug), ['chai-garam']);
});
