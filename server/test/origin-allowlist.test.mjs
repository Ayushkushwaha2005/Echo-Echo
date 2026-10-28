/* ==========================================================================
   THE PRODUCTION ORIGIN ALLOWLIST, EXACTLY AS render.yaml SETS IT

   Reproduces what was measured against the live API on 16 Oct 2026: the
   campus location modal on Vercel's git-main alias of the production build
   was refused on every write - POST /campus/presence answered 403 "Cross-
   origin request rejected" - because that origin was not in WEB_ORIGIN.

   The server is built with the WEB_ORIGIN value read from render.yaml, so
   this tests the configuration production runs, not a fixture of it: each
   listed origin reaches authentication (preflight included), and a sibling
   Vercel URL, a look-alike, or a foreign site is still refused.
   ========================================================================== */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, makeUser } from './helpers/db.mjs';
import { sessionFor } from './helpers/api.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const yaml = readFileSync(join(repoRoot, 'render.yaml'), 'utf8');
const WEB_ORIGIN = /^\s*- key: WEB_ORIGIN[ \t]*\r?\n[ \t]*value: *(\S+)/m.exec(yaml)?.[1];
const LISTED = String(WEB_ORIGIN).split(',');

const GIT_MAIN = 'https://echo-echo-git-main-ayushkushwaha2005s-projects.vercel.app';
const REFUSED = [
  'https://evil.example',
  /* Another branch, a preview deployment, and a look-alike of the alias:
     none of them is the production build. */
  'https://echo-echo-git-feature-ayushkushwaha2005s-projects.vercel.app',
  'https://echo-echo-it6c4453i-ayushkushwaha2005s-projects.vercel.app',
  /* Reported 28 Oct 2026: the production deployment's own address and the
     PR #24 preview. Both stay refused; the build sends the first to the
     ECHO ECHO address instead (tools/site-origins.mjs). */
  'https://echo-echo-hs6un7rqm-ayushkushwaha2005s-projects.vercel.app',
  'https://echo-echo-rad2lyw9g-ayushkushwaha2005s-projects.vercel.app',
  'https://echo-echo-git-main-ayushkushwaha2005s-projects.vercel.app.evil.example',
  'http://echo-echo-git-main-ayushkushwaha2005s-projects.vercel.app',
  'null',
];

let app, pool;

before(async () => {
  await startDb();
  Object.assign(process.env, {
    WEB_ORIGIN, SWEEPER: 'off', NODE_ENV: 'test',
    PLATFORM_OWNER_PHONE: '+919000000000',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
  });
  ({ pool } = await import('../src/db/index.js'));
  const { build } = await import('../src/index.js');
  app = await build();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });

/* What the location modal sends: a cookie-bearing write. A forged cookie is
   enough to arm the origin check, which runs before the session lookup. */
const presence = (origin) => app.inject({
  method: 'POST', url: '/campus/presence',
  headers: { 'content-type': 'application/json', origin, cookie: 'quad_session=forged-value-that-is-not-a-session' },
  payload: { lat: 30.4168071, lng: 77.9679063, accuracy: 9 },
});
const preflight = (origin) => app.inject({
  method: 'OPTIONS', url: '/campus/presence',
  headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
});

test('render.yaml lists the git-main alias alongside the canonical origins', () => {
  assert.ok(WEB_ORIGIN, 'WEB_ORIGIN has a value in render.yaml');
  for (const o of ['https://echoecho.tech', 'https://www.echoecho.tech', 'https://echo-echo-nu.vercel.app', GIT_MAIN]) {
    assert.ok(LISTED.includes(o), `${o} is listed`);
  }
});

test('every listed origin, the git-main alias included, reaches authentication', async () => {
  for (const origin of LISTED) {
    const r = await presence(origin);
    assert.equal(r.statusCode, 401, `${origin}: ${r.body}`);
    assert.equal(JSON.parse(r.body).code, 'unauthenticated');
  }
});

test('the preflight for the git-main alias allows that exact origin with credentials', async () => {
  const r = await preflight(GIT_MAIN);
  assert.equal(r.statusCode, 204);
  assert.equal(r.headers['access-control-allow-origin'], GIT_MAIN);
  assert.equal(r.headers['access-control-allow-credentials'], 'true');
  assert.match(r.headers['access-control-allow-methods'], /\bPOST\b/);
  assert.match(r.headers['access-control-allow-headers'], /content-type/);
  assert.match(String(r.headers.vary), /Origin/);
});

test('a signed-in write from the git-main alias succeeds', async () => {
  const u = await makeUser(pool, { phone: '+919200000091', name: 'A' });
  const token = await sessionFor(pool, u.id);
  const r = await app.inject({ method: 'POST', url: '/support/cases',
    headers: { 'content-type': 'application/json', origin: GIT_MAIN, cookie: `quad_session=${token}` },
    payload: { category: 'other', subject: 'Origin check' } });
  assert.equal(r.statusCode, 200, r.body);
});

test('an unlisted origin is still refused, and is never echoed back', async () => {
  for (const origin of REFUSED) {
    const r = await presence(origin);
    assert.equal(r.statusCode, 403, origin);
    assert.match(JSON.parse(r.body).error, /Cross-origin request rejected/);
    const p = await preflight(origin);
    assert.equal(p.headers['access-control-allow-origin'], undefined, `${origin} not echoed`);
  }
});

/* The display-name save that failed on the deployment URL: from the ECHO
   ECHO address it is saved and reads back; from the deployment URL it is
   refused and the stored name is untouched. */
test('My Profile saves from www.echoecho.tech and is refused from a deployment URL', async () => {
  const owner = await makeUser(pool, { phone: '+919200000092', name: 'Owner Origin', roles: ['platform_owner'] });
  const token = await sessionFor(pool, owner.id, { method: 'admin_totp' });
  const send = (origin, method, payload) => app.inject({ method, url: '/admin/me',
    headers: { 'content-type': 'application/json', origin, cookie: `quad_session=${token}` }, payload });
  const saved = await send('https://www.echoecho.tech', 'PATCH', { displayName: 'Origin Check' });
  assert.equal(saved.statusCode, 200, saved.body);
  const refused = await send('https://echo-echo-hs6un7rqm-ayushkushwaha2005s-projects.vercel.app', 'PATCH', { displayName: 'Should Not Save' });
  assert.equal(refused.statusCode, 403);
  const back = JSON.parse((await send('https://www.echoecho.tech', 'GET')).body);
  assert.equal(back.profile.displayName, 'Origin Check');
  const row = (await pool.query(`SELECT display_name FROM admin_profile WHERE user_id = $1`, [owner.id])).rows[0];
  assert.equal(row.display_name, 'Origin Check', 'what the database holds');
});
