/* ==========================================================================
   The audit's peak scenario, as far as one PC can run it: 500 open pages polling
   at their real intervals while 100 orders move through the kitchen and delivery
   in one minute (15 times the audit's 100 in 15 minutes), then every database
   connection cut mid-load, then cold starts.

   Real API and disposable PostgreSQL on this machine, synthetic data, no network,
   no cloud database and no payment. It finds bottlenecks and failures. It does not
   predict what the free Render instance and Neon would do.

     node tools/perf-peak.mjs
   ========================================================================== */
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = 4192;
const base = `http://127.0.0.1:${API}`;
const origin = 'http://localhost:3000';
const here = dirname(fileURLToPath(import.meta.url));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10 : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summary = (m) => ({ requests: m.times.length + m.errors, p50ms: pct(m.times, 50), p95ms: pct(m.times, 95), p99ms: pct(m.times, 99), errorRatePct: Math.round(((m.errors / Math.max(1, m.times.length + m.errors)) * 10000)) / 100, sampleError: m.sample });
const meter = () => ({ times: [], errors: 0, sample: undefined });

const { startDb, truncateAll, makeUser, makeVendor, makeItem, stopDb } = await import('../server/test/helpers/db.mjs');
await startDb();
Object.assign(process.env, {
  NODE_ENV: 'test', SWEEPER: 'off', PLATFORM_OWNER_PHONE: '+919000000000', WEB_ORIGIN: origin, COOKIE_SECRET: 'perf-secret-that-is-at-least-32-characters',
  ADMIN_TOTP_KEY: 'perf-totp-key-0123456789abcdef-0123', ADMIN_PASSKEY_REQUIRED: 'true', LIVE_STREAMS_ENABLED: 'false', LOG_LEVEL: process.env.PERF_LOG || 'silent',
});
const { build } = await import('../server/src/index.js');
const { pool } = await import('../server/src/db/index.js');
await truncateAll(pool);
const app = await build();
await app.listen({ port: API, host: '127.0.0.1' });

const results = { note: 'One Windows PC, API and database together, no network. Not a measure of production.' };
async function session(userId) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO session (token_hash, user_id, expires_at, auth_method) VALUES ($1,$2, now() + interval '1 hour','code')`, [createHash('sha256').update(token).digest('hex'), userId]);
  return `quad_session=${token}`;
}

const vendors = [];
for (let i = 0; i < 4; i++) {
  const v = await makeVendor(pool, { name: `Peak Cafe ${i}`, slug: `peak-${i}` });
  for (let k = 0; k < 40; k++) await makeItem(pool, v.id, { name: `Item ${i}-${k}`, paise: 2000 + k });
  vendors.push(v);
}
const owner = await makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['student', 'platform_owner'] });
const ownerCookie = await session(owner.id);
await pool.query(`UPDATE session SET auth_method = 'admin_totp', passkey_verified_at = now() WHERE user_id = $1`, [owner.id]);
const customers = [];
for (let i = 0; i < 100; i++) customers.push((await makeUser(pool, { phone: `+9195${String(10000000 + i)}`, name: `Customer ${i}`, roles: ['student'] })).id);
const orders = [];
for (let i = 0; i < 100; i++) {
  const { rows: [o] } = await pool.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery','confirmed',9000,10000,'{"name":"Block 4"}','+919999900002','manual_map_spot',30.4172,77.9681) RETURNING id, vendor_id`,
    [`P${10000 + i}`, customers[i], vendors[i % 4].id]);
  orders.push(o);
}

/* ---------- 500 open pages at the real intervals, and a stream of order work ---------- */
const pages = meter(), work = meter();
const hit = async (m, path, init) => {
  const t = performance.now();
  try {
    const r = await fetch(`${base}${path}`, init);
    await r.arrayBuffer();
    if (r.status >= 500) throw new Error(`${r.status} ${path}`);
    m.times.push(performance.now() - t);
    return r.status;
  } catch (e) { m.errors++; m.sample ??= e.message; return 0; }
};
let running = true;
const pageLoops = Array.from({ length: 500 }, async (_, i) => {
  await sleep(Math.random() * 10000);
  let n = 0;
  while (running) {
    await hit(pages, '/site/config');                              // every 10 s
    if (n % 6 === 0) await hit(pages, '/vendors');                 // every 60 s
    if (i % 5 === 0 && n % 2 === 0) await hit(pages, `/vendors/${vendors[i % 4].id}/menu`);
    n++;
    await sleep(10000);
  }
});
const adminLoop = (async () => { while (running) { await hit(pages, '/admin/changes', { headers: { cookie: ownerCookie } }); await sleep(5000); } })();

const started = Date.now();
const states = ['preparing', 'ready', 'delivered'];
const moved = { ok: 0, refused: 0 };
await Promise.all(orders.map(async (o, i) => {
  await sleep((i / 100) * 55000);
  for (const to of states) {
    const status = await hit(work, `/orders/${o.id}/transition`, { method: 'POST', headers: { cookie: ownerCookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ to }) });
    if (status === 200) moved.ok++; else moved.refused++;
  }
}));
await sleep(Math.max(0, 60000 - (Date.now() - started)));
results.peak = { openPages: 500, orders: 100, seconds: Math.round((Date.now() - started) / 1000), pagePolling: summary(pages), orderTransitions: { ...summary(work), ...moved } };

/* ---------- every database connection cut while the pages are still polling ---------- */
{
  const before = { errors: pages.errors, n: pages.times.length };
  const t0 = Date.now();
  const killer = new (pool.constructor)({ connectionString: process.env.DATABASE_URL, max: 1 });
  const { rowCount } = await killer.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'quad' AND pid <> pg_backend_pid()`);
  await killer.end();
  let recoveredMs = null;
  while (Date.now() - t0 < 30000) {
    const r = await fetch(`${base}/vendors`).catch(() => null);
    if (r?.status === 200) { recoveredMs = Date.now() - t0; break; }
    await sleep(100);
  }
  await sleep(5000);
  results.connectionsCut = { connectionsTerminated: rowCount, servingAgainAfterMs: recoveredMs, failedRequestsDuring: pages.errors - before.errors, requestsDuring: pages.times.length - before.n };
}
running = false;
await Promise.race([Promise.all(pageLoops), sleep(12000)]);
await adminLoop.catch(() => {});

await app.close();
await pool.end();

/* ---------- cold start: a new process, from nothing to answering ---------- */
{
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const child = spawn(process.execPath, ['src/index.js'], { cwd: join(here, '..', 'server'), stdio: 'ignore', env: { ...process.env, PORT: '4193' } });
    let ms = null;
    while (performance.now() - t < 30000) {
      const r = await fetch('http://127.0.0.1:4193/vendors').catch(() => null);
      if (r?.status === 200) { ms = performance.now() - t; break; }
      await sleep(25);
    }
    await new Promise((res) => { child.once('exit', res); child.kill(); });
    samples.push(Math.round(ms));
  }
  results.coldStartToFirstAnswerMs = { samples, note: 'Process start only. Render also has to wake the instance: 13 s was measured on production on 26 Oct 2026.' };
}

console.log(JSON.stringify(results, null, 2));
await stopDb();
process.exit(0);
