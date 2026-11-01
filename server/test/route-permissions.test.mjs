/* ==========================================================================
   GENERATED ROUTE-PERMISSION MATRIX

   Asks Fastify for every registered route, then calls each one as nobody, as a
   student, and as an administrator holding no permissions. Anything that answers
   with data must be on the short written list below. So a new route that forgets
   its check fails this test, without anyone having to remember to add it.

   This checks the door, not each permission's exact meaning: the per-permission
   behaviour is covered by the feature tests.
   ========================================================================== */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser } from './helpers/db.mjs';
import { makeApp, sessionFor } from './helpers/api.mjs';

let app, pool;
const ID = '00000000-0000-4000-8000-000000000000';

before(async () => {
  await startDb();
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.ADMIN_PASSKEY_REQUIRED = 'true';
  process.env.LIVE_STREAMS_ENABLED = 'false';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  process.env.SWEEPER = 'off';
  process.env.NODE_ENV = 'test';
  app = await makeApp();
  ({ pool } = await import('../src/db/index.js'));
  process.env.ADMIN_PASSKEY_REQUIRED = 'true';
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });

function allRoutes() {
  /* printRoutes is the framework's own list of what is registered. */
  const lines = app.printRoutes({ commonPrefix: false, includeHooks: false });
  const found = [];
  const stack = [];
  for (const line of lines.split('\n')) {
    const m = /^([│ ]*)[├└]── (\S+) \(([^)]+)\)/.exec(line) || /^([│ ]*)[├└]── (\S+)$/.exec(line);
    if (!m) continue;
    const depth = m[1].length / 4;
    stack.length = depth;
    stack[depth] = m[2];
    if (m[3]) {
      const path = stack.join('').replace(/\/\/+/g, '/');
      for (const method of m[3].split(',').map((s) => s.trim())) found.push({ method, path });
    }
  }
  return found.filter((r) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
}
const concrete = (path) => path.replace(/:[A-Za-z]+/g, ID).replace(/\*$/, 'x');

/* Everything reachable without an account, on purpose. Prefixes of paths. */
const PUBLIC = [
  /^\/health/, /^\/ready/, /^\/csp-report/, /^\/auth\//, /^\/payments\/webhook/, /^\/payouts\/webhook/,
  /^\/vendors(\/[^/]+\/(menu|contact|categories))?\/?$/, /^\/menu\/search/, /^\/reviews/, /^\/campus\//, /^\/campuses/,
  /^\/ai\/(status|chat)/, /^\/partner\/policy/, /^\/pricing\/current/, /^\/assets\/[0-9a-f-]{36}/, /^\/assets\/limits/,
  /^\/site\/(config|version)/, /^\/live\/stream/, /^\/tracking\/stream/,
];
const isPublic = (p) => PUBLIC.some((re) => re.test(p));

async function call(r, cookie) {
  const headers = { origin: 'http://localhost:3000' };
  if (cookie) headers.cookie = `quad_session=${cookie}`;
  const init = { method: r.method, url: concrete(r.path), headers };
  if (r.method !== 'GET' && r.method !== 'DELETE') { init.payload = {}; headers['content-type'] = 'application/json'; }
  return (await app.inject(init)).statusCode;
}

test('the matrix found the routes it claims to check', () => {
  const list = allRoutes();
  assert.ok(list.length > 150, `found only ${list.length} routes`);
  for (const must of ['/admin/access/invitations', '/admin/approvals', '/partner/location', '/admin/changes']) {
    assert.ok(list.some((r) => r.path.replace(/\/$/, '') === must), `${must} is in the list`);
  }
});

test('every route not on the public list refuses a caller with no session', async () => {
  const open = [];
  for (const r of allRoutes()) {
    if (isPublic(concrete(r.path))) continue;
    const s = await call(r, null);
    if (s !== 401) open.push(`${r.method} ${r.path} -> ${s}`);
  }
  assert.deepEqual(open, []);
});

test('no /admin route answers a student, or an administrator holding no permissions', async () => {
  await truncateAll(pool);
  const student = await makeUser(pool, { phone: '+919444400001', name: 'Student' });
  const bare = await makeUser(pool, { phone: '+919444400002', name: 'Bare Admin', roles: ['platform_admin'] });
  await pool.query(`INSERT INTO admin_account (user_id, status, permissions) VALUES ($1,'active','{}')`, [bare.id]);
  const asStudent = await sessionFor(pool, student.id);
  const asBare = await sessionFor(pool, bare.id, { method: 'admin_totp' });
  const leaks = [];
  /* A bare administrator may look at their own account, nothing else. */
  const OWN = [/^\/admin\/me/, /^\/admin\/access\/me/, /^\/admin\/changes/, /^\/admin\/notifications/, /^\/admin\/live\/stream/, /^\/admin\/approvals\/?$/, /^\/admin\/chat/, /^\/admin\/topbar/, /^\/admin\/site\/preview/];
  for (const r of allRoutes().filter((x) => x.path.startsWith('/admin'))) {
    const s = await call(r, asStudent);
    /* /admin/access/me only answers "you hold nothing". */
    if (s < 400 && !/^\/admin\/access\/me/.test(r.path)) leaks.push(`student: ${r.method} ${r.path} -> ${s}`);
    if (OWN.some((re) => re.test(r.path))) continue;
    const b = await call(r, asBare);
    if (b < 400) leaks.push(`bare admin: ${r.method} ${r.path} -> ${b}`);
  }
  assert.deepEqual(leaks, []);
});

test('an administrator\'s student session holds no administrator power', async () => {
  await truncateAll(pool);
  const a = await makeUser(pool, { phone: '+919444400003', name: 'Two Hats', roles: ['student', 'platform_admin'] });
  const email = await sessionFor(pool, a.id, { method: 'code' });
  const list = allRoutes().filter((x) => x.path.startsWith('/admin') && x.method === 'GET');
  const leaks = [];
  for (const r of list) {
    if (/^\/admin\/live\/stream|^\/admin\/me|^\/admin\/access\/me/.test(r.path)) continue;
    const s = await call(r, email);
    if (s < 400) leaks.push(`${r.path} -> ${s}`);
  }
  assert.deepEqual(leaks, []);
});
