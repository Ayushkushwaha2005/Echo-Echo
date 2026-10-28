/* ==========================================================================
   WHERE THE PAGES MAY CHANGE THINGS FROM, IN THE BROWSER

   * config.js (tools/site-origins.mjs): a PRODUCTION build of Campus Control
     or the counter opened on a deployment's own *.vercel.app address goes
     to the same page on www.echoecho.tech; a listed address, a preview and
     a local build stay where they are; the student site gets no redirect.
   * The list is render.yaml's WEB_ORIGIN, the value the server runs with.
   * A refused save says where to make it (packages/data/client.js), and a
     preview says it can never change live data.
   * The public website hears a publish made in the same browser at once
     and fetches that version by name (packages/data/site-config.js).
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { writeOrigins, configJs, CANONICAL_ORIGIN } from '../../tools/site-origins.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGINS = writeOrigins(readFileSync(join(repoRoot, 'render.yaml'), 'utf8'));
const DEPLOYMENT = 'https://echo-echo-hs6un7rqm-ayushkushwaha2005s-projects.vercel.app';

/* Runs a config.js as the browser would and reports where it navigated. */
function open(src, origin, path = '/admin/', hash = '#/profile') {
  let went = null;
  const u = new URL(origin);
  const location = { origin, protocol: u.protocol, host: u.host, pathname: path, search: '', hash, replace: (x) => { went = x; } };
  const window = {};
  vm.runInNewContext(src, { window, location });
  return { went, window };
}

test('the canonical address is one the server accepts changes from', () => {
  assert.ok(ORIGINS.includes(CANONICAL_ORIGIN));
  assert.ok(ORIGINS.every((o) => /^https:\/\/[^*]+$/.test(o)), 'https only, no wildcard');
});

test('a production deployment URL is sent to www.echoecho.tech, keeping the page', () => {
  const src = configJs({ apiBase: '/api', surface: 'admin', env: 'production', origins: ORIGINS });
  const r = open(src, DEPLOYMENT, '/admin/', '#/profile');
  assert.equal(r.went, `${CANONICAL_ORIGIN}/admin/#/profile`);
  assert.equal(r.window.QUAD_API_BASE, '/api');
  assert.equal(open(configJs({ apiBase: '/api', surface: 'shop', env: 'production', origins: ORIGINS }), DEPLOYMENT, '/shop/', '').went,
    `${CANONICAL_ORIGIN}/shop/`, 'the counter too');
  for (const o of ORIGINS) assert.equal(open(src, o).went, null, `${o} stays`);
});

test('a preview, a local build and the student site are never redirected', () => {
  const preview = configJs({ apiBase: '/api', surface: 'admin', env: 'preview', origins: ORIGINS });
  assert.equal(open(preview, 'https://echo-echo-rad2lyw9g-ayushkushwaha2005s-projects.vercel.app').went, null);
  assert.equal(open(configJs({ apiBase: 'http://localhost:8080', surface: 'admin', env: undefined, origins: ORIGINS }), 'http://localhost:3000').went, null);
  const web = configJs({ apiBase: '/api', surface: 'web', env: 'production', origins: ORIGINS });
  assert.equal(open(web, DEPLOYMENT, '/web/', '').went, null);
  assert.equal(open(web, DEPLOYMENT, '/web/', '').window.QUAD_DEPLOY.env, 'production');
});

/* ---------- the refused save, as the page shows it ------------------------- */
async function refusedSave(env, origin) {
  globalThis.QUAD_API_BASE = '/api';
  globalThis.QUAD_DEPLOY = { env, canonical: CANONICAL_ORIGIN, writeHosts: ORIGINS.map((o) => new URL(o).host) };
  globalThis.location = { origin, pathname: '/admin/' };
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Cross-origin request rejected', code: 'forbidden',
    detail: `Origin ${origin} is not an allowed origin for this deployment.` }), { status: 403 });
  try {
    const { quad, staffRequests } = await import('../../packages/data/client.js');
    staffRequests();
    return await quad.saveMyAdminProfile('Name').then(() => null, (e) => e);
  } finally { globalThis.fetch = saved; }
}

test('a refused save says where to make the change', async () => {
  const e = await refusedSave('production', DEPLOYMENT);
  assert.equal(e.code, 'origin_not_allowed');
  assert.equal(e.status, 403);
  assert.match(e.detail, /https:\/\/www\.echoecho\.tech\/admin\//);
  const p = await refusedSave('preview', 'https://echo-echo-rad2lyw9g-ayushkushwaha2005s-projects.vercel.app');
  assert.match(p.detail, /preview deployment.*never change it/);
});

/* ---------- the public website hears a publish ----------------------------- */
test('a publish announced in this browser is fetched by version at once', async () => {
  const { startSiteSync } = await import('../../packages/data/site-config.js');
  const asked = [];
  const api = {
    siteVersion: async () => ({ version: 1 }),
    siteConfig: async (v) => { asked.push(v ?? null); return { version: v ?? 1, config: { hero: { heading: `v${v ?? 1}` } }, featuredItems: [] }; },
  };
  const seen = [];
  /* The page's timer and channel would keep this test process alive. */
  const [realInterval, RealChannel] = [globalThis.setInterval, globalThis.BroadcastChannel];
  globalThis.setInterval = () => 0;
  globalThis.BroadcastChannel = class extends RealChannel { constructor(n) { super(n); this.unref?.(); } };
  try { startSiteSync({ api, onChange: (s) => seen.push(s.version) }); }
  finally { globalThis.setInterval = realInterval; globalThis.BroadcastChannel = RealChannel; }
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, [1]);
  const t0 = Date.now();
  const ch = new BroadcastChannel('echo-site');
  ch.postMessage({ type: 'published', version: 2 });
  for (let i = 0; i < 50 && !seen.includes(2); i++) await new Promise((r) => setTimeout(r, 20));
  ch.close();
  assert.deepEqual(seen, [1, 2]);
  assert.ok(Date.now() - t0 < 1000, 'well under a second');
  assert.equal(asked.at(-1), 2, 'asked for version 2 by name (its own CDN entry)');
});
