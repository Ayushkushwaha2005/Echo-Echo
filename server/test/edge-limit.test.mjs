/* ==========================================================================
   THE EDGE LIMIT — a forged X-Forwarded-For cannot buy unlimited sign-in codes.

   Reproduces what was measured against the live API on 14 Oct 2026: with
   TRUST_PROXY=true the per-IP limit keys on the left-most X-Forwarded-For
   entry, so a caller who changes that header every request lands in a fresh
   bucket every request. The edge limit keys on the address the edge vouches
   for (cf-connecting-ip behind Cloudflare), which the caller cannot set.

   Limits are shrunk so the caps are reachable: per-IP 4 per window, edge 2×.
   The address used is a non-student one, so every request is refused before
   any code is created or any email sent — the limits run before the handler.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb } from './helpers/db.mjs';
import { makeApp } from './helpers/api.mjs';

const ORIGIN = 'http://localhost:3000';

let app, edge;

before(async () => {
  await startDb();
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    TRUST_PROXY: 'true',
    EDGE_CLIENT_IP_HEADER: 'CF-Connecting-IP',
    RL_EMAIL_SEND: '4',
    RL_EDGE_MULTIPLIER: '2',
  });
  edge = await import('../src/edge-limit.js');
  app = await makeApp();
});
after(async () => { await app?.close(); await stopDb(); });
beforeEach(() => edge.resetEdgeLimits());

const send = (headers) => app.inject({
  method: 'POST', url: '/auth/email/send',
  headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
  payload: { email: 'probe@example.com' },
});

test('rotating a forged X-Forwarded-For stops at the edge cap', async () => {
  const statuses = [];
  for (let i = 1; i <= 12; i++) {
    const r = await send({ 'x-forwarded-for': `203.0.113.${i}`, 'cf-connecting-ip': '198.51.100.10' });
    statuses.push(r.statusCode);
  }
  /* Every request had its own left-most address, so the per-IP limit (4)
     never saw a second request from any of them... */
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(400), 'refused as a non-student address, not rate limited');
  /* ...but the edge saw one caller, and its cap is 4 × 2. */
  assert.deepEqual(statuses.slice(8), Array(4).fill(429), 'the ninth request onward is rate limited');
});

test('the cap is per edge address: another caller is unaffected', async () => {
  for (let i = 1; i <= 9; i++) await send({ 'x-forwarded-for': `203.0.113.${50 + i}`, 'cf-connecting-ip': '198.51.100.20' });
  const other = await send({ 'x-forwarded-for': '192.0.2.7', 'cf-connecting-ip': '198.51.100.21' });
  assert.equal(other.statusCode, 400, 'a different edge address still has its whole allowance');
});

test('the per-IP limit still applies to an honest client first', async () => {
  const h = { 'x-forwarded-for': '192.0.2.30', 'cf-connecting-ip': '198.51.100.30' };
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await send(h)).statusCode);
  assert.deepEqual(statuses, [400, 400, 400, 400, 429], 'per-IP limit of 4, unchanged');
});

test('a 429 from the edge limit is the standard error shape and says when to retry', async () => {
  let r;
  for (let i = 1; i <= 9; i++) r = await send({ 'x-forwarded-for': `203.0.113.${100 + i}`, 'cf-connecting-ip': '198.51.100.40' });
  assert.equal(r.statusCode, 429);
  assert.equal(JSON.parse(r.body).code, 'rate_limited');
  assert.ok(Number(r.headers['retry-after']) > 0);
});

test('with the edge header absent the key falls back to the request address, never one shared bucket', async () => {
  /* No cf-connecting-ip: the edge limit keys on req.ip exactly as before.
     Two different honest clients must not share a bucket. */
  for (let i = 0; i < 9; i++) await send({ 'x-forwarded-for': '192.0.2.60' });
  const other = await send({ 'x-forwarded-for': '192.0.2.61' });
  assert.equal(other.statusCode, 400);
});

test('edgePeer ignores a header nobody configured, and rejects a value that is not an address', () => {
  const req = { ip: '192.0.2.1', headers: { 'cf-connecting-ip': '198.51.100.9', 'x-edge': 'not-an-ip' } };
  assert.deepEqual(edge.edgePeer(req, null), { ip: '192.0.2.1', source: 'request' });
  assert.deepEqual(edge.edgePeer(req, 'cf-connecting-ip'), { ip: '198.51.100.9', source: 'edge' });
  assert.deepEqual(edge.edgePeer(req, 'x-edge'), { ip: '192.0.2.1', source: 'request' });
});

test('routes keyed per account are not edge-limited; the webhooks carry no limit at all', async () => {
  const routes = app.printRoutes({ commonPrefix: false, includeHooks: false });
  assert.ok(routes.includes('payments/webhook'));
  /* A provider retrying a webhook from one address must never be throttled. */
  for (let i = 0; i < 12; i++) {
    const r = await app.inject({ method: 'POST', url: '/payments/webhook', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.50' }, payload: {} });
    assert.notEqual(r.statusCode, 429);
  }
});

test('/health/client reports the proxy chain without naming any address', async () => {
  const r = await app.inject({ method: 'GET', url: '/health/client',
    headers: { 'x-forwarded-for': '203.0.113.200, 198.51.100.60', 'cf-connecting-ip': '198.51.100.60' } });
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body, { edgeHeader: 'cf-connecting-ip', edgeKeySource: 'edge', cfConnectingIpPresent: true,
                           cfConnectingIpHopsFromRight: 0, forwardedForEntries: 2, trustProxy: true });
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(r.body), 'no IP address in the response');
});

/* ---------- CSP violation reports ---------------------------------------- */

test('/csp-report accepts both report formats without a session or Origin, and answers 204', async () => {
  const legacy = await app.inject({ method: 'POST', url: '/csp-report', headers: { 'content-type': 'application/csp-report' },
    payload: JSON.stringify({ 'csp-report': { 'document-uri': 'https://www.echoecho.tech/web/?token=secret#/cart',
      'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/x.js?a=1', disposition: 'report' } }) });
  assert.equal(legacy.statusCode, 204);
  const modern = await app.inject({ method: 'POST', url: '/csp-report', headers: { 'content-type': 'application/reports+json' },
    payload: JSON.stringify([{ type: 'csp-violation', body: { documentURL: 'https://www.echoecho.tech/web/',
      effectiveDirective: 'img-src', blockedURL: 'https://tiles.example/1/2/3.png', disposition: 'report' } }]) });
  assert.equal(modern.statusCode, 204);
  const junk = await app.inject({ method: 'POST', url: '/csp-report', headers: { 'content-type': 'application/csp-report' }, payload: 'not json' });
  assert.equal(junk.statusCode, 204, 'a malformed report is dropped, not an error');
});

test('/csp-report even with a session cookie needs no Origin (it changes nothing)', async () => {
  const r = await app.inject({ method: 'POST', url: '/csp-report',
    headers: { 'content-type': 'application/csp-report', cookie: 'quad_session=whatever' }, payload: '{}' });
  assert.equal(r.statusCode, 204);
});
