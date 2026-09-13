/* ==========================================================================
   SECURITY — the audit from §39, expressed as tests so it stays true.

   Each case is an attack, run against the real stack and the real database.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus }
  from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool;

before(async () => {
  await startDb();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const as = async (u) => client(app, await sessionFor(pool, u.id));

/* ---------- SQL injection ------------------------------------------------ */
test('SQL injection through search parameters does nothing', async () => {
  const u = await makeUser(pool, { phone: '+919400000001', name: 'A', roles: ['platform_admin'] });
  const c = await as(u);
  const payloads = [
    "'; DROP TABLE app_user; --",
    "' OR '1'='1",
    "%'; DELETE FROM vendor WHERE '1'='1",
    "\\'; TRUNCATE audit_log; --",
  ];
  for (const p of payloads) {
    const r = await c.get(`/admin/users?q=${encodeURIComponent(p)}`);
    assert.ok(r.status < 500, `${p} caused ${r.status}`);
  }
  /* The tables are all still there. */
  const t = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('app_user','vendor','audit_log')`);
  assert.equal(t.rows[0].n, 3);
});

test('SQL injection through campus search and resolve does nothing', async () => {
  await makeCampus(pool);
  const c = client(app);
  const r1 = await c.get(`/campus/search?q=${encodeURIComponent("' OR 1=1 --")}`);
  assert.ok(r1.status < 500);
  const r2 = await c.post('/campus/resolve', { text: "'; DROP TABLE campus_node; --" });
  assert.ok(r2.status < 500);
  const n = await pool.query(`SELECT count(*)::int AS n FROM campus_node`);
  assert.ok(n.rows[0].n > 0, 'campus_node survived');
});

/* ---------- session security -------------------------------------------- */
test('the raw session token is never stored, only its hash', async () => {
  const u = await makeUser(pool, { phone: '+919400000010', name: 'A' });
  const token = await sessionFor(pool, u.id);
  const { rows } = await pool.query(`SELECT token_hash FROM session WHERE user_id = $1`, [u.id]);
  assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'));
  assert.notEqual(rows[0].token_hash, token);
  /* And the raw token appears nowhere in the table. */
  const any = await pool.query(`SELECT count(*)::int AS n FROM session WHERE token_hash = $1`, [token]);
  assert.equal(any.rows[0].n, 0);
});

test('a forged or guessed session token is rejected', async () => {
  for (const bogus of ['x', 'a'.repeat(43), '../../etc/passwd', '']) {
    const c = client(app, bogus);
    const r = await c.get('/orders');
    assert.equal(r.status, 401, `token ${bogus} must not authenticate`);
  }
});

test('session fixation: a token issued before a role change gains nothing', async () => {
  const u = await makeUser(pool, { phone: '+919400000011', name: 'A' });
  const c = await as(u);
  assert.equal((await c.get('/admin/users')).status, 403);
  /* Roles are read per request, so granting later works — and revoking
     later takes effect immediately (covered in api.test.mjs). The point
     here is that the OLD token never carried authority of its own. */
  await pool.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'platform_admin')`, [u.id]);
  assert.equal((await c.get('/admin/users')).status, 200);
});

test('the session cookie is HttpOnly, SameSite=Lax and Path=/', async () => {
  const { cookieOptions } = await import('../src/auth/session.js');
  const o = cookieOptions();
  assert.equal(o.httpOnly, true, 'JS must not be able to read the session');
  assert.equal(o.sameSite, 'lax');
  assert.equal(o.path, '/');
});

/* ---------- IDOR --------------------------------------------------------- */
test('IDOR: every id-addressed resource checks ownership', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const victim = await makeUser(pool, { phone: '+919400000020', name: 'Victim' });
  const attacker = await makeUser(pool, { phone: '+919400000021', name: 'Attacker' });
  const cv = await as(victim), ca = await as(attacker);

  const order = (await cv.post('/orders/draft',
    { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' })).body;
  const kase = (await cv.post('/support/cases', { category: 'other', subject: 'mine' })).body;
  const vcase = (await pool.query(
    `INSERT INTO verification_case (user_id) VALUES ($1) RETURNING id`, [victim.id])).rows[0];

  const attempts = [
    ['get', `/orders/${order.id}`],
    ['get', `/orders/${order.id}/handoff-code`],
    ['post', `/orders/${order.id}/transition`, { to: 'cancelled' }],
    ['get', `/support/cases/${kase.id}`],
    ['post', `/support/cases/${kase.id}/messages`, { body: 'hi' }],
    ['get', `/admin/verification/${vcase.id}/image/front`],
    ['post', '/payments/cancel', { orderId: order.id }],
    ['get', `/payments/status?orderId=${order.id}`],
  ];
  for (const [m, url, body] of attempts) {
    const r = await ca[m](url, body);
    assert.ok([403, 404].includes(r.status), `${m.toUpperCase()} ${url} returned ${r.status}`);
  }
});

/* ---------- file upload -------------------------------------------------- */
test('upload: a disguised file is rejected on its magic bytes', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919400000030', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const { putImage } = await import('../src/services/storage.js');

  /* A PHP web shell named "photo.jpg". */
  await assert.rejects(
    () => putImage(Buffer.from('<?php system($_GET["c"]); ?>'), { ownerId: owner.id, kind: 'food_photo' }),
    /Unsupported image format/);
  /* An SVG with script — SVG is not on the allow list at all. */
  await assert.rejects(
    () => putImage(Buffer.from('<svg onload="alert(1)"></svg>'), { ownerId: owner.id, kind: 'food_photo' }),
    /Unsupported image format/);
  /* An HTML file. */
  await assert.rejects(
    () => putImage(Buffer.from('<!doctype html><script>x</script>'), { ownerId: owner.id, kind: 'food_photo' }),
    /Unsupported image format/);
});

test('upload: oversized files are refused before they are written', async () => {
  const u = await makeUser(pool, { phone: '+919400000031', name: 'A' });
  const { putImage } = await import('../src/services/storage.js');
  const { STORAGE } = await import('../src/config.js');
  const huge = Buffer.alloc(STORAGE.maxBytes + 1024);
  huge[0] = 0xff; huge[1] = 0xd8; huge[2] = 0xff;      // valid JPEG magic
  await assert.rejects(() => putImage(huge, { ownerId: u.id, kind: 'food_photo' }), /too large/);
});

test('ID card images are never served publicly', async () => {
  const u = await makeUser(pool, { phone: '+919400000032', name: 'A' });
  const asset = (await pool.query(
    `INSERT INTO asset (owner_id, kind, mime, bytes, storage_key, sha256)
     VALUES ($1,'id_front','image/jpeg',50000,'k','h') RETURNING id`, [u.id])).rows[0];
  /* Even the owner cannot fetch it from the public asset route. */
  const c = await as(u);
  const r = await c.get(`/assets/${asset.id}`);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /not public/i);
});

/* ---------- rate limiting ------------------------------------------------ */
test('per-IP limits are NAT-safe — a shared campus address must not lock everyone out', async () => {
  const { RATE_LIMITS } = await import('../src/config.js');
  /* Every student on campus WiFi shares a handful of NAT addresses, so a
     tight per-IP cap on login would take the whole university offline the
     moment a lecture ended. These are enumeration speed bumps, not the
     account protection. */
  assert.ok(RATE_LIMITS.otpSend >= 100, 'OTP send must tolerate a shared campus IP');
  assert.ok(RATE_LIMITS.otpVerify >= 100);
  assert.ok(RATE_LIMITS.enrol >= 100);
});

test('the REAL limits are per-identity and enforced in the database', async () => {
  /* This is what actually stops an attacker: it cannot be diluted by
     rotating IP addresses, because it is keyed on the phone number. */
  const { OTP } = await import('../src/config.js');
  assert.ok(OTP.maxSendsPerHour <= 10, 'a single number has a hard hourly send cap');
  assert.ok(OTP.maxAttempts <= 10, 'a single challenge has a hard attempt ceiling');

  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/services/otp.js', import.meta.url), 'utf8'));
  assert.match(src, /FROM otp_challenge[\s\S]{0,200}created_at > now\(\) - interval '1 hour'/,
    'the hourly cap must be a database query, not in-process state');
  /* Claimed in the same statement that increments, so parallel guesses
     cannot all pass the check (behaviour: otp-login.test.mjs). */
  assert.match(src, /SET attempts = attempts \+ 1[\s\S]{0,80}WHERE id = \$1 AND attempts < max_attempts/,
    'the attempt ceiling is enforced atomically against the row');
});

test('enrolment codes carry their own database-backed attempt ceiling', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/services/enrolment.js', import.meta.url), 'utf8'));
  assert.match(src, /rec\.attempts >= rec\.max_attempts/);
  assert.match(src, /UPDATE enrolment_code SET revoked_at = now\(\)/,
    'exhausting the attempts must kill the code');
});

/* ---------- error hygiene ------------------------------------------------ */
test('errors never leak a stack trace, SQL, or a connection string', async () => {
  const c = client(app);
  const probes = [
    ['get', '/orders/not-a-uuid'],
    ['get', '/vendors/%00/menu'],
    ['post', '/campus/resolve', { text: { nested: ['weird'] } }],
    ['get', '/admin/users/00000000-0000-0000-0000-000000000000'],
  ];
  for (const [m, url, body] of probes) {
    const r = await c[m](url, body);
    const s = JSON.stringify(r.body || {});
    assert.ok(!/postgres:\/\//.test(s), `${url} leaked a connection string`);
    assert.ok(!/\bat \w+ \(/.test(s), `${url} leaked a stack trace`);
    assert.ok(!/SELECT .* FROM/i.test(s), `${url} leaked SQL`);
    assert.ok(!/node_modules/.test(s), `${url} leaked a path`);
  }
});

test('the logger redacts credentials and one-time codes', async () => {
  const { build } = await import('../src/index.js');
  /* Assert the configured redact list rather than scraping stdout. */
  const paths = ['req.headers.cookie', 'req.headers.authorization',
                 'req.body.code', 'req.body.password', '*.token_hash', '*.apiKey'];
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'));
  for (const p of paths) {
    assert.ok(src.includes(p), `logger must redact ${p}`);
  }
});

/* ---------- privilege boundaries ---------------------------------------- */
test('mass assignment: a request body cannot set fields it should not', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const staff = await makeUser(pool, { phone: '+919400000040', name: 'S',
    roles: ['vendor_staff'], vendorId: v.id });
  const c = await as(staff);

  /* Staff may set availability. Bundling a price change in the same body
     must fail the whole request, not silently apply the allowed half. */
  const r = await c.patch(`/menu/${i.id}`, { available: false, price: '1' });
  assert.equal(r.status, 403);
  const row = await pool.query(`SELECT price_paise, available FROM menu_item WHERE id=$1`, [i.id]);
  assert.equal(row.rows[0].price_paise, 9000, 'price unchanged');
  assert.equal(row.rows[0].available, true, 'the allowed half must not apply either');
});

test('a student cannot create a campus location for themselves', async () => {
  const u = await makeUser(pool, { phone: '+919400000041', name: 'A' });
  const c = await as(u);
  const r = await c.post('/campus/nodes',
    { kind: 'spot', name: 'My house', deliverable: true });
  assert.equal(r.status, 403);
  const n = await pool.query(`SELECT count(*)::int AS n FROM campus_node WHERE name='My house'`);
  assert.equal(n.rows[0].n, 0);
});

test('a shopkeeper cannot refund, and neither can support', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const owner = await makeUser(pool, { phone: '+919400000042', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const sup = await makeUser(pool, { phone: '+919400000043', name: 'S', roles: ['support'] });
  for (const u of [owner, sup]) {
    const c = await as(u);
    const r = await c.post('/refunds', { orderId: '00000000-0000-0000-0000-000000000000', reason: 'x' });
    assert.equal(r.status, 403, `${u.name} must not be able to refund`);
  }
});

/* ---------- SSRF --------------------------------------------------------- */
test('SSRF: no outbound request targets a URL derived from the caller', async () => {
  /* SSRF needs a caller-supplied URL to reach an outbound request. Every
     outbound call here must therefore be rooted in a literal host or in
     server configuration — never in req.body, a query string, or a route
     param. Both src/routes and src/services are scanned; the services are
     where the provider calls actually live. */
  const fs = await import('node:fs');
  const targets = [];
  for (const sub of ['routes', 'services']) {
    const dir = new URL(`../src/${sub}/`, import.meta.url);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(new URL(f, dir), 'utf8');
      for (const m of src.matchAll(/\bfetch\(\s*([^,)]+)/g)) {
        targets.push({ file: `${sub}/${f}`, expr: m[1].trim() });
      }
    }
  }
  assert.ok(targets.length >= 8, 'the scan should be finding the provider calls');

  /* Hard rule: nothing request-shaped may appear in a fetch target. */
  for (const { file, expr } of targets) {
    assert.ok(!/\breq\b|\brequest\b|\bbody\b|\bquery\b|\bparams\b|\bheaders\b/.test(expr),
      `${file}: fetch target "${expr}" references the incoming request`);
  }

  /* And every target must be a literal https host, or built from config. */
  const CONFIG_ROOTED = /^`\$\{(ROSTER|OCR|AI|PAYMENTS|PAYOUTS|OTP|STORAGE|NOTIFY)\./;
  for (const { file, expr } of targets) {
    const literalHttps = /^(['"`])https:\/\//.test(expr);
    const configRooted = CONFIG_ROOTED.test(expr);
    /* s3.js builds a URL object from the configured endpoint + bucket. */
    const s3Built = file === 'services/s3.js' && expr === 'url';
    assert.ok(literalHttps || configRooted || s3Built,
      `${file}: fetch target "${expr}" is neither a literal https host nor config-rooted`);
  }
});

test('SSRF: the S3 URL builder is rooted in configuration, not input', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/services/s3.js', import.meta.url), 'utf8');
  /* objectUrl() is the only thing that produces the fetch target, and it is
     endpoint(from config) + bucket(from config) + a percent-encoded key. */
  assert.match(src, /const objectUrl = \(key\) =>\s*`\$\{endpointFor\(\)\}/,
    'the URL must be built by objectUrl from endpointFor()');
  assert.match(src, /encPath\(key\)/, 'the object key must be path-encoded');
  assert.match(src, /enc\(STORAGE\.s3\.bucket\)/, 'the bucket must come from config');
  /* endpointFor() reads the configured endpoint, or derives the AWS host
     from the configured region — either way, never from a request. */
  assert.match(src, /function endpointFor\(\)[\s\S]{0,400}?s3\.endpoint/,
    'the endpoint must come from config');
  assert.match(src, /function endpointFor\(\)[\s\S]{0,400}?s3\.region/,
    'the region fallback must come from config');
});

test('interpolated path segments in provider URLs are encoded', async () => {
  /* Provider ids — an order id, a payment id — go into URL PATHS. They come
     from our own database, but they originally came off the wire from the
     gateway, so they are encoded rather than trusted.

     This scans every fetch() template in the provider adapters and requires
     that each interpolated path segment is either encodeURIComponent(...) or
     a PAYMENTS/PAYOUTS config root (the base URL itself). A raw `${id}` in a
     path is a rejection: it is how a value containing "../" or a query
     string escapes the endpoint it was meant to address. */
  const fs = await import('node:fs');
  const files = ['../src/services/payment-providers.js', '../src/services/payout-providers.js'];
  let checked = 0;
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const m of src.matchAll(/\bfetch\(\s*`([^`]+)`/g)) {
      const url = m[1];
      for (const seg of url.matchAll(/\$\{([^}]+)\}/g)) {
        const expr = seg[1].trim();
        checked++;
        const encoded = /^encodeURIComponent\(/.test(expr);
        const configRoot = /^(PAYMENTS|PAYOUTS)\./.test(expr);
        assert.ok(encoded || configRoot,
          `${f}: "${expr}" enters a URL path unencoded (in "${url}")`);
      }
    }
  }
  assert.ok(checked >= 4, `the scan should be finding the provider URLs (found ${checked})`);
});

/* ---------- order access control ----------------------------------------
   §15. Placing an order requires an authenticated, phone-verified,
   ADMIN-APPROVED student on an active account, ordering to a campus-eligible
   destination — and every one of those is enforced on the server, at the
   endpoint, against the session's database row.

   The point of these cases is that they bypass the app entirely. They call
   the API directly, exactly as a modified client or a curl command would,
   and the answer must be identical to the one the app's route guards give.
   A route guard is a courtesy to an honest user; it is not a control.       */

/* Every entry point that can bring an order into existence. If one of these
   is ever added without the gate, this list is where it shows up. */
async function orderingSurfaces(c, ctx) {
  return [
    ['checkout draft', await c.post('/orders/draft', {
      vendorId: ctx.vendorId, lines: [{ itemId: ctx.itemId, qty: 1 }],
      fulfilment: 'delivery', destinationId: ctx.destinationId })],
    ['AI assistant', await c.post('/ai/chat', { message: 'order me a coffee' })],
  ];
}

async function orderingFixture(phone, studentStatus, status = 'active') {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'F', slug: 'gate-' + phone.slice(-5) });
  const i = await makeItem(pool, v.id, { name: 'Coffee', paise: 7000 });
  const u = await makeUser(pool, { phone, name: 'S', studentStatus, status });
  return { u, c: await as(u),
           ctx: { vendorId: v.id, itemId: i.id, destinationId: n.blockB.id } };
}

test('an UNVERIFIED student cannot place an order through any surface', async () => {
  const { c, ctx } = await orderingFixture('+919400000200', 'unverified');
  for (const [name, r] of await orderingSurfaces(c, ctx)) {
    assert.ok(r.status >= 400, `${name} must refuse an unverified student (got ${r.status})`);
  }
  const n = await pool.query(`SELECT count(*)::int AS n FROM food_order`);
  assert.equal(n.rows[0].n, 0, 'not even a draft may exist');
});

test('every not-approved verification state is refused, with a reason', async () => {
  /* `pending` is the interesting one: the student has done everything asked
     of them and is waiting on a human. That is still not permission. */
  let i = 0;
  for (const state of ['unverified', 'pending', 'needs_review', 'rejected']) {
    const { c, ctx } = await orderingFixture(`+91940000021${i++}`, state);
    const r = await c.post('/orders/draft', {
      vendorId: ctx.vendorId, lines: [{ itemId: ctx.itemId, qty: 1 }],
      fulfilment: 'delivery', destinationId: ctx.destinationId });
    assert.equal(r.status, 403, `${state} must be refused`);
    assert.match(r.body.error, /verification/i, `${state} must say why`);
    assert.ok(r.body.detail, `${state} must tell the student what to do next`);
  }
});

test('an APPROVED student on a suspended account cannot order', async () => {
  const { c, ctx } = await orderingFixture('+919400000220', 'approved', 'suspended');
  const r = await c.post('/orders/draft', {
    vendorId: ctx.vendorId, lines: [{ itemId: ctx.itemId, qty: 1 }],
    fulfilment: 'delivery', destinationId: ctx.destinationId });
  assert.ok(r.status >= 400);
});

test('a student cannot verify themselves — the flag is the server\'s, not theirs', async () => {
  const { u, c, ctx } = await orderingFixture('+919400000230', 'unverified');

  /* Everything a client might try to flip its own status with. */
  /* The self-approval attempt that must be REFUSED outright: deciding a
     verification case is an admin capability, and holding a student session
     is not a way to acquire it. */
  const decide = await c.post(`/admin/verifications/${u.id}/decide`, { decision: 'approve' });
  assert.ok(decide.status === 403 || decide.status === 404,
    `a student calling the admin decision endpoint must be refused (got ${decide.status})`);

  /* These may legitimately succeed as requests — submitting a verification
     is something a student is supposed to do, and an unknown body field is
     ignored rather than rejected. What must NOT happen is the smuggled
     `approved` taking effect, which the database check below proves. */
  await c.post('/orders/draft', {
    vendorId: ctx.vendorId, lines: [{ itemId: ctx.itemId, qty: 1 }],
    fulfilment: 'delivery', destinationId: ctx.destinationId,
    studentStatus: 'approved', isVerified: true, verified: true });
  await c.patch('/me', { studentStatus: 'approved', student_status: 'approved' });
  await c.post('/verification/submit', { state: 'approved', studentStatus: 'approved' });

  const row = await pool.query(`SELECT student_status FROM app_user WHERE id=$1`, [u.id]);
  assert.notEqual(row.rows[0].student_status, 'approved',
    'no request a student can make may approve them');

  /* And ordering is still refused afterwards. */
  const r = await c.post('/orders/draft', {
    vendorId: ctx.vendorId, lines: [{ itemId: ctx.itemId, qty: 1 }],
    fulfilment: 'delivery', destinationId: ctx.destinationId });
  assert.equal(r.status, 403);
});

test('an approved student CAN order — the gate refuses the right people only', async () => {
  const { c, ctx } = await orderingFixture('+919400000240', 'approved');
  const r = await c.post('/orders/draft', {
    vendorId: ctx.vendorId, lines: [{ itemId: ctx.itemId, qty: 1 }],
    fulfilment: 'delivery', destinationId: ctx.destinationId });
  assert.equal(r.status, 200, 'a fail-closed gate that fails on everything is just an outage');
  assert.equal(r.body.state, 'draft');
});

test('verification revoked between drafting and paying stops the payment', async () => {
  /* A draft is not a licence to complete a purchase. The gate is re-checked
     at /payments/intent for exactly this case. */
  const { u, c, ctx } = await orderingFixture('+919400000250', 'approved');
  const draft = (await c.post('/orders/draft', {
    vendorId: ctx.vendorId, lines: [{ itemId: ctx.itemId, qty: 1 }],
    fulfilment: 'delivery', destinationId: ctx.destinationId })).body;
  assert.equal(draft.state, 'draft');

  await pool.query(`UPDATE app_user SET student_status='rejected' WHERE id=$1`, [u.id]);
  const r = await c.post('/payments/intent', { orderId: draft.id });
  assert.equal(r.status, 403);

  const o = await pool.query(`SELECT state FROM food_order WHERE id=$1`, [draft.id]);
  assert.equal(o.rows[0].state, 'draft', 'and the order never reached awaiting_payment');
});

test('a student cannot read another student\'s verification case or ID document', async () => {
  const a = await orderingFixture('+919400000260', 'pending');
  const b = await orderingFixture('+919400000261', 'approved');
  const kase = (await pool.query(
    `INSERT INTO verification_case (user_id, claimed_name, claimed_roll)
     VALUES ($1,'A','R1') RETURNING *`, [a.u.id])).rows[0];

  for (const url of [`/admin/verifications/${kase.id}`,
                     `/verification/${kase.id}`,
                     `/admin/verifications`]) {
    const r = await b.c.get(url);
    assert.ok(r.status >= 400, `${url} must not expose another student's case (got ${r.status})`);
  }
});

test('client errors raised by the framework keep their status and never look like a server fault', async () => {
  const big = await app.inject({ method: 'POST', url: '/auth/email/send',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    payload: JSON.stringify({ email: 'x'.repeat(1_200_000) }) });
  assert.equal(big.statusCode, 413);
  assert.equal(JSON.parse(big.body).code, 'payload_too_large');
  const media = await app.inject({ method: 'POST', url: '/auth/email/send',
    headers: { 'content-type': 'text/xml', origin: 'http://localhost:3000' }, payload: '<x/>' });
  assert.equal(media.statusCode, 415);
  assert.ok(!/stack|Error:|FST_/.test(media.body), 'no framework internals in the body');
});
