/* ==========================================================================
   ECHO ECHO — checks against a DEPLOYED API.

     node tools/live-check.mjs https://echo-echo-api.onrender.com
     node tools/live-check.mjs https://echo-echo-nu.vercel.app/api

   Both spellings matter and both are run: the second goes through the
   Vercel rewrite, which is the path a student's browser actually takes.

   Nothing here is mocked and nothing signs in on anybody's behalf. Each
   check states what it observed, so a pass is evidence rather than a claim.
   ========================================================================== */
const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base) { console.error('usage: node tools/live-check.mjs <base url>'); process.exit(1); }

let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };

const call = async (path, init = {}) => {
  const res = await fetch(base + path, { redirect: 'manual', ...init });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { res, text, json };
};

/* The origin a legitimate browser would send: the site the surfaces are on,
   which is this base minus any /api path prefix. */
const siteOrigin = new URL(base).origin;

console.log(`\nECHO ECHO live check — ${base}\n`);

/* ---- liveness ---------------------------------------------------------- */
{
  const { res, json } = await call('/health');
  res.status === 200 && json?.ok ? ok(`/health 200 (${json.platform})`)
                                 : bad(`/health returned ${res.status}`);
}

/* The static host in front of the API normalises trailing slashes with a
   308 that runs BEFORE its rewrites, so the API must answer both spellings.
   This is the deployment-shaped outage commit b81598e closed. */
{
  const { res } = await call('/health/');
  res.status === 200 ? ok('/health/ 200 — trailing-slash spelling survives the rewrite')
                     : bad(`/health/ returned ${res.status} — a proxied call would 404`);
}

/* ---- readiness: the database, the schema, and every provider ----------- */
{
  const { res, json } = await call('/ready');
  const c = json?.checks || {};
  res.status === 200 && json?.ready ? ok('/ready 200 — the service can actually serve')
                                    : bad(`/ready returned ${res.status} (ready=${json?.ready})`);
  c.database?.ok ? ok(`database answers (${c.database.latencyMs} ms)`)
                 : bad(`database: ${c.database?.error || 'unreachable'}`);
  c.migrations?.ok ? ok(`schema current — ${c.migrations.applied} migrations, none pending`)
                   : bad(`migrations pending: ${JSON.stringify(c.migrations?.pending)}`);
  c.data?.ok ? ok(`no development seed rows in production (${c.data.developmentSeedRows})`)
             : bad(`development seed rows present: ${c.data?.developmentSeedRows}`);
  const p = c.providers || {};
  const state = (x) => (x?.configured ? `configured (${x.provider ?? 'yes'})` : 'NOT configured');
  console.log(`      storage:  ${state(p.storage)}${p.storage?.productionReady ? ', production-ready' : ''}`);
  console.log(`      email:    ${state(p.email)}`);
  console.log(`      payments: ${state(p.payments)}  (deferred on purpose)`);
  p.storage?.productionReady ? ok('private S3 storage is live') : bad('storage is not production-ready');
  p.email?.configured ? ok('email provider is live') : bad('no email provider — no student can sign in');
}

/* ---- security headers -------------------------------------------------- */
{
  const { res } = await call('/health');
  const want = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
                 'referrer-policy': 'no-referrer' };
  for (const [h, v] of Object.entries(want)) {
    res.headers.get(h) === v ? ok(`${h}: ${v}`) : bad(`${h} is "${res.headers.get(h)}", expected "${v}"`);
  }
  res.headers.get('strict-transport-security') ? ok('HSTS present (secure cookies are on)')
                                               : bad('no HSTS — SECURE_COOKIES is not true');
  res.headers.get('x-request-id') ? ok('x-request-id on every response') : bad('no x-request-id');
}

/* ---- public reads stay public ------------------------------------------ */
for (const path of ['/campuses', '/vendors', '/auth/status', '/pricing/current']) {
  const { res } = await call(path);
  res.status === 200 ? ok(`${path} 200 — public read works signed out`)
                     : bad(`${path} returned ${res.status}`);
}

/* ---- default-deny: anything not enumerated needs a session ------------- */
for (const path of ['/orders', '/profile', '/admin/flags', '/partner/queue', '/finance/ledger']) {
  const { res, json } = await call(path);
  res.status === 401 ? ok(`${path} 401 signed out — default-deny holds`)
                     : bad(`${path} returned ${res.status} (${json?.code}) signed out, expected 401`);
}

/* ---- a signed-out write is refused ------------------------------------- */
{
  const { res } = await call('/orders', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: siteOrigin },
    body: JSON.stringify({ items: [] }) });
  res.status === 401 ? ok('POST /orders 401 signed out — no anonymous order can be created')
                     : bad(`POST /orders returned ${res.status} signed out`);
}

/* ---- CSRF: a cookie-bearing write from a foreign origin is refused ------
   This exercises the real control in src/index.js: the presence of the
   session cookie NAME is what arms the origin check, so a forged cookie is
   enough to prove the check runs before anything else looks at it. */
{
  const { res, json } = await call('/orders', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example',
               cookie: 'quad_session=forged-value-that-is-not-a-session' },
    body: JSON.stringify({ items: [] }) });
  res.status === 403 ? ok('cross-origin cookie-bearing write 403 — CSRF second layer holds')
                     : bad(`cross-origin write returned ${res.status} (${json?.code}), expected 403`);
}

/* ---- CORS is an allowlist, not a wildcard ------------------------------ */
{
  const { res } = await call('/campuses', { headers: { origin: 'https://attacker.example' } });
  const acao = res.headers.get('access-control-allow-origin');
  !acao ? ok('no Access-Control-Allow-Origin for an unknown origin — allowlist, not wildcard')
        : bad(`CORS echoed an unknown origin: ${acao}`);
}

/* ---- campus data is really in the database ----------------------------- */
{
  const { res, json } = await call('/campus/tree');
  if (res.status === 200) {
    const n = Array.isArray(json) ? json.length : (json?.nodes?.length ?? json?.children?.length ?? null);
    ok(`/campus/tree 200${n === null ? '' : ` — ${n} top-level node(s) from PostgreSQL`}`);
  } else bad(`/campus/tree returned ${res.status}`);
}

/* ---- OTP never leaks a code in a response ------------------------------ */
{
  const { res, text, json } = await call('/auth/email/send', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: siteOrigin },
    body: JSON.stringify({ email: 'nobody.doesnotexist@stu.upes.ac.in' }) });
  if (/"code"\s*:\s*"?\d{6}/.test(text)) bad('a six-digit code appeared in the response body');
  else ok(`no code in the /auth/email/send response (HTTP ${res.status} ${json?.code || ''})`);
}

console.log(failed ? `\n✗ ${failed} check(s) failed\n` : '\n✓ every check passed\n');
process.exit(failed ? 1 : 0);
