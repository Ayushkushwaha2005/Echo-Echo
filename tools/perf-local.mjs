/* ==========================================================================
   Local performance measurements: real API, disposable PostgreSQL on the same
   machine. These numbers describe THIS machine with no network and no cloud
   database. They find regressions and bottlenecks; they do not predict
   production. Run a real load test on staging before quoting any of this as
   capacity. No payment is created and no provider is contacted.

     node tools/perf-local.mjs
   ========================================================================== */
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { memoryUsage, cpuUsage } from 'node:process';

const API = 4191;
const base = `http://127.0.0.1:${API}`;
const require = createRequire(new URL('../server/package.json', import.meta.url));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null; };
const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

async function timed(n, concurrency, fn) {
  const times = [], errors = [];
  let i = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < n) {
      const k = i++;
      const t = performance.now();
      try { await fn(k); times.push(performance.now() - t); } catch (e) { errors.push(e.message); }
    }
  }));
  const ms = performance.now() - started;
  return { requests: n, concurrency, p50ms: round(pct(times, 50)), p95ms: round(pct(times, 95)), p99ms: round(pct(times, 99)),
           errorRatePct: round((errors.length / n) * 100), perSecond: round((n / ms) * 1000), sampleError: errors[0] || undefined };
}

const { startDb, truncateAll, makeUser, makeVendor, makeItem, stopDb } = await import('../server/test/helpers/db.mjs');
await startDb();
Object.assign(process.env, {
  NODE_ENV: 'test', SWEEPER: 'off', PLATFORM_OWNER_PHONE: '+919000000000', WEB_ORIGIN: 'http://localhost:3000', COOKIE_SECRET: 'perf-secret-that-is-at-least-32-characters',
  ADMIN_TOTP_KEY: 'perf-totp-key-0123456789abcdef-0123', ADMIN_PASSKEY_REQUIRED: 'true', LIVE_STREAMS_ENABLED: 'true', LOG_LEVEL: 'silent',
});
const { pool } = await import('../server/src/db/index.js');
const { build } = await import('../server/src/index.js');
await truncateAll(pool);

const session = async (userId, method = 'code') => {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO session (token_hash, user_id, expires_at, auth_method, passkey_verified_at, campus_presence_at)
     VALUES ($1,$2, now() + interval '2 hours', $3, CASE WHEN $3 = 'admin_totp' THEN now() END, now())`,
    [createHash('sha256').update(token).digest('hex'), userId, method]);
  return token;
};

/* A menu sized like the real thing. */
const vendors = [];
for (let i = 0; i < 8; i++) {
  const v = await makeVendor(pool, { name: `Perf Cafe ${i}`, slug: `perf-${i}` });
  vendors.push(v);
  for (let k = 0; k < 40; k++) await makeItem(pool, v.id, { name: `Item ${i}-${k}`, paise: 2000 + k });
}
const owner = await makeUser(pool, { phone: '+919000000000', name: 'Perf Owner', roles: ['student', 'platform_owner'] });
const ownerCookie = `quad_session=${await session(owner.id, 'admin_totp')}`;
const orderCount = 200;
const customer = await makeUser(pool, { phone: '+919555500001', name: 'Perf Customer' });
const partner = await makeUser(pool, { phone: '+919555500002', name: 'Perf Partner', roles: ['student', 'delivery_partner'] });
const partnerCookie = `quad_session=${await session(partner.id)}`;
const orders = [];
for (let i = 0; i < orderCount; i++) {
  orders.push((await pool.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id, destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery','picked_up',9000,10000,$4,'{"name":"B"}','+919999900002','manual_map_spot',30.41,77.96) RETURNING id`,
    [`PF${i}`, customer.id, vendors[0].id, i === 0 ? partner.id : null])).rows[0]);
}

const app = await build();
await app.listen({ port: API, host: '127.0.0.1' });
const get = async (path, cookie) => {
  const r = await fetch(base + path, { headers: cookie ? { cookie } : {} });
  await r.arrayBuffer();
  if (r.status >= 400) throw new Error(`${path} ${r.status}`);
};

const results = {};
const before = cpuUsage();

/* Warm first, so these are warm reads. */
await get('/vendors'); await get(`/vendors/${vendors[0].id}/menu`);
results.warmCafeList = await timed(1000, 20, () => get('/vendors'));
results.warmMenu = await timed(1000, 20, (k) => get(`/vendors/${vendors[k % 8].id}/menu`));
results.adminChanges = await timed(500, 10, () => get('/admin/changes', ownerCookie));
results.adminOrderHistory = await timed(200, 5, () => get('/admin/orders?pageSize=50', ownerCookie));

/* The change feed against the old cost: one index lookup versus hashing a table. */
const t1 = performance.now();
for (let i = 0; i < 100; i++) await pool.query(`SELECT coalesce(max(id),0) FROM change_event WHERE area = 'menu'`);
const feed = (performance.now() - t1) / 100;
const t2 = performance.now();
for (let i = 0; i < 100; i++) await pool.query(`SELECT md5(COALESCE(string_agg(m::text, '|' ORDER BY m.id), '')) FROM menu_item m`);
const hash = (performance.now() - t2) / 100;
results.changeStampCost = { oldWholeTableHashMs: round(hash), newFeedLookupMs: round(feed), note: `${pool ? (await pool.query('SELECT count(*)::int n FROM menu_item')).rows[0].n : 0} menu items` };

/* How long a menu edit takes to reach a connected stream. */
{
  const latencies = [];
  const ctl = new AbortController();
  const res = await fetch(`${base}/live/stream`, { signal: ctl.signal });
  const reader = res.body.getReader();
  let waiting = null;
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (Buffer.from(value).toString().includes('event: change') && waiting) { waiting(); waiting = null; }
      }
    } catch { /* closed */ }
  })();
  await new Promise((r) => setTimeout(r, 500));
  const item = (await pool.query(`SELECT id FROM menu_item LIMIT 1`)).rows[0].id;
  for (let i = 0; i < 12; i++) {
    const t = performance.now();
    const seen = new Promise((r) => { waiting = r; });
    await pool.query(`UPDATE menu_item SET description = $2 WHERE id = $1`, [item, `v${i}`]);
    await Promise.race([seen, new Promise((r) => setTimeout(r, 8000))]);
    latencies.push(performance.now() - t);
    await new Promise((r) => setTimeout(r, 200));
  }
  ctl.abort();
  results.menuEditToStream = { samples: latencies.length, p50ms: round(pct(latencies, 50)), maxMs: round(Math.max(...latencies)), note: 'Change committed to event received; poll interval 2 s. Excludes the proxy and the client refetch.' };
}

/* GPS updates: one partner's route, real checks included. */
await fetch(`${base}/partner/location/start`, { method: 'POST', headers: { cookie: partnerCookie, origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ orderId: orders[0].id }) });
{
  const times = [];
  for (let i = 0; i < 18; i++) {
    const t = performance.now();
    const r = await fetch(`${base}/partner/location`, { method: 'POST', headers: { cookie: partnerCookie, origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: orders[0].id, lat: 30.41 + i / 10000, lng: 77.96, accuracy: 10, takenAt: Date.now() }) });
    await r.arrayBuffer();
    if (r.status === 200) times.push(performance.now() - t);
    await new Promise((res) => setTimeout(res, 15));
  }
  results.gpsReport = { accepted: times.length, p50ms: round(pct(times, 50)), p95ms: round(pct(times, 95)) };
}

/* Many open streams: the audit's 500 open pages, on this one process. */
{
  const opened = [];
  const conns = 40;
  const heapBefore = memoryUsage().rss;
  let ok = 0, refused = 0;
  process.env.LIVE_STREAMS_ENABLED = 'true';
  for (let i = 0; i < conns; i += 1) {
    const ctl = new AbortController();
    opened.push(ctl);
    fetch(`${base}/live/stream`, { signal: ctl.signal, headers: { 'x-edge-client-ip': `10.0.${i >> 8}.${i & 255}` } })
      .then((r) => { if (r.status === 200) ok++; else refused++; })
      .catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 2500));
  const during = await timed(200, 10, () => get('/vendors'));
  results.openStreams = { attempted: conns, accepted: ok, refusedByPerPeerLimit: refused, rssGrowthMb: round((memoryUsage().rss - heapBefore) / 1048576), cafeListWhileOpen: during,
    note: 'All from one address, so only the per-address cap of 20 is exercised. This is not a measure of capacity for 500 real clients.' };
  for (const c of opened) c.abort();
}

const cpu = cpuUsage(before);
results.process = { rssMb: round(memoryUsage().rss / 1048576), cpuSeconds: round((cpu.user + cpu.system) / 1e6) };

console.log(JSON.stringify(results, null, 2));
await app.close();
await pool.end();
await stopDb();
process.exit(0);
