/* ==========================================================================
   REAL PostgreSQL for the test suite.

   These are genuine PostgreSQL binaries, not an emulation, so foreign keys,
   partial unique indexes, CHECK constraints and transaction semantics are
   actually exercised rather than asserted by reading the schema.

   Two things this file has to get right on a developer machine:

   1. initdb is slow (minutes on Windows, where the AV scans every binary),
      so the cluster is created ONCE into server/var/pgdata and reused.
      Each run drops and recreates the `quad_test` database instead, which
      still exercises the real migrations from scratch.

   2. A test run killed mid-flight (a CI timeout, a Ctrl-C) can leave the
      port unusable in two different ways, and BOTH have bitten this suite:
        · a live postmaster still holding the cluster's shared memory, and
        · an orphaned listening socket whose process is already gone, which
          accepts TCP and then never completes the handshake.
      The second is the nastier one: `tasklist` shows no such pid, so there
      is nothing to kill and the socket lingers at the kernel's discretion.

   So the port is NOT fixed. `startDb()` reuses a healthy cluster if one is
   already up, otherwise it reclaims what it safely can and then binds the
   first genuinely free port, recording the choice in var/pgport so sibling
   test processes join the same cluster instead of racing to start their own.

     node test/helpers/db.mjs init     # one-time, or after deleting var/
   ========================================================================== */
import EmbeddedPostgres from 'embedded-postgres';
import { readdir, readFile, writeFile, rm, access, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..', '..');
const dataDir = join(serverRoot, 'var', 'pgdata');
const portFile = join(serverRoot, 'var', 'pgport');
const migrationsDir = join(serverRoot, 'src', 'db');

const BASE_PORT = Number(process.env.TEST_PG_PORT || 55432);
const PORT_ATTEMPTS = 12;

const exists = (p) => access(p).then(() => true, () => false);
const urlFor = (port, db) => `postgres://quad:quad@localhost:${port}/${db}`;

function instance(port) {
  return new EmbeddedPostgres({
    databaseDir: dataDir, user: 'quad', password: 'quad',
    port, persistent: true, onLog: () => {}, onError: () => {},
  });
}

/* One-time cluster creation. Slow; run it yourself, not from a test. */
export async function initCluster() {
  if (await exists(join(dataDir, 'PG_VERSION'))) {
    console.log('cluster already initialised at var/pgdata');
    return;
  }
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  console.log('initialising PostgreSQL (this can take a few minutes)…');
  await instance(BASE_PORT).initialise();
  console.log('initialised');
}

let running = null;          // set only in the process that started it
let activePort = null;

/* A real handshake, not just a TCP connect — an orphaned socket accepts the
   connection and then goes silent, which is exactly the state we must treat
   as "not usable". */
async function canConnect(port, ms = 2500) {
  const c = new pg.Client({ connectionString: urlFor(port, 'postgres'), connectionTimeoutMillis: ms });
  try {
    await c.connect();
    await c.query('SELECT 1');
    await c.end();
    return true;
  } catch {
    try { await c.end(); } catch { /* already broken */ }
    return false;
  }
}

/* Can we actually bind this port ourselves? The only reliable answer on
   Windows, where a dead process's socket can still refuse a new bind. */
const portFree = (port) => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(false));
  s.once('listening', () => s.close(() => resolve(true)));
  s.listen(port, '127.0.0.1');
});

/* ---------- reclaiming a stale cluster ----------------------------------
   Only ever touches a process we can positively identify as postgres, and
   only one tied to OUR data directory (via its pid file) or holding OUR
   port. Never a blanket "kill all postgres". */
function listenerPids(port) {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      if (!(cols[1] || '').endsWith(':' + port)) continue;
      const pid = Number(cols[cols.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch { return []; }
}

function imageName(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
                             { encoding: 'utf8' });
    return (out.match(/^"([^"]+)"/m) || [])[1] || null;
  } catch { return null; }
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch { return false; }
}

/* Postgres processes that are dead husks: still in the process table, but
   with no resolvable executable path. A LIVE PostgreSQL — including one the
   developer installed for their own work — always has a path, so this can
   only ever match a leftover. That distinction is what makes it safe to
   kill these automatically; matching on the image name alone would not be.

   These husks are the real blocker: they keep the data directory's shared
   memory mapped, so `start()` fails on EVERY port, not just the one they
   were listening on. */
function deadPostgresHusks() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | " +
      "ForEach-Object { $_.ProcessId.ToString() + '|' + $_.ExecutablePath }",
    ], { encoding: 'utf8', timeout: 15000 });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .map((l) => { const [pid, path] = l.split('|'); return { pid: Number(pid), path: (path || '').trim() }; })
      .filter((p) => Number.isInteger(p.pid) && p.pid > 0 && !p.path)
      .map((p) => p.pid);
  } catch { return []; }
}

async function reclaim(port) {
  let killedSomething = false;

  /* 1 — the postmaster recorded in our own data directory. */
  const pidFile = join(dataDir, 'postmaster.pid');
  if (await exists(pidFile)) {
    const pid = Number((await readFile(pidFile, 'utf8')).trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0 && killPid(pid)) killedSomething = true;
    await unlink(pidFile).catch(() => {});
  }

  /* 2 — anything still holding the port that is identifiably postgres. */
  for (const pid of listenerPids(port)) {
    const img = imageName(pid);
    if (img && /^postgres/i.test(img) && killPid(pid)) killedSomething = true;
  }

  /* 3 — dead husks anywhere, since they block every port at once. */
  for (const pid of deadPostgresHusks()) {
    if (killPid(pid)) killedSomething = true;
  }

  if (killedSomething) await new Promise((r) => setTimeout(r, 1500));
  return killedSomething;
}

/* ---------- start -------------------------------------------------------- */
/**
 * @param reuse  Keep whatever is already in quad_test instead of dropping
 *               and recreating it. The persistence suite needs this: it
 *               restarts PostgreSQL and must then find its data still
 *               there, which is impossible if every start wipes the schema.
 */
export async function startDb({ reuse = false } = {}) {
  if (!(await exists(join(dataDir, 'PG_VERSION')))) {
    throw new Error(
      'No test cluster. Run `node test/helpers/db.mjs init` once before running integration tests.');
  }

  /* A sibling process (or the parent runner) may already have one up. */
  const known = Number(process.env.QUAD_TEST_PG_PORT) ||
    Number(await readFile(portFile, 'utf8').catch(() => 0));
  if (known && await canConnect(known)) {
    activePort = known;
    return prepareDatabase(known, reuse);
  }

  /* Nothing usable — reclaim what we safely can, then find a port we can
     actually bind and start there. */
  let lastError = null;

  /* Two passes: the first reclaims what we can see now, the second covers a
     husk that only became visible once the first start attempt failed. */
  for (let pass = 0; pass < 2; pass++) {
    await reclaim(BASE_PORT);

    for (let i = 0; i < PORT_ATTEMPTS; i++) {
      const port = BASE_PORT + i;
      if (!(await portFree(port))) continue;        // orphaned socket or other tenant
      const pgi = instance(port);
      try {
        await pgi.start();
      } catch (e) {
        /* embedded-postgres rejects with a non-Error for some failures, so
           the message is frequently undefined — hence the fallback text. */
        lastError = String(e?.message ?? e ?? '') || 'start rejected without a message';
        if (!(await canConnect(port))) continue;
      }
      if (!(await canConnect(port))) {
        lastError = lastError || 'started but never completed a handshake';
        continue;
      }
      running = pgi;
      activePort = port;
      await writeFile(portFile, String(port), 'utf8').catch(() => {});
      process.env.QUAD_TEST_PG_PORT = String(port);
      return prepareDatabase(port, reuse);
    }
  }

  throw new Error(
    `Could not start PostgreSQL on ports ${BASE_PORT}..${BASE_PORT + PORT_ATTEMPTS - 1}` +
    (lastError ? ` (last error: ${lastError})` : '') +
    '. A leftover postgres.exe usually holds the data directory: check for one, ' +
    'or delete server/var and re-run `node test/helpers/db.mjs init`.');
}

/* Drop and recreate quad_test, then apply the real migration files in order.
   Every run therefore exercises the migrations, not a snapshot. */
async function prepareDatabase(port, reuse = false) {
  const admin = new pg.Client({ connectionString: urlFor(port, 'postgres') });
  await admin.connect();
  const present = await admin.query(
    `SELECT 1 FROM pg_database WHERE datname='quad_test'`);
  /* reuse keeps the existing data; otherwise every run starts from a clean
     schema built by the real migrations. */
  if (!reuse || present.rowCount === 0) {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='quad_test'`);
    await admin.query('DROP DATABASE IF EXISTS quad_test');
    await admin.query('CREATE DATABASE quad_test');
  }
  await admin.end();

  const url = urlFor(port, 'quad_test');
  process.env.DATABASE_URL = url;
  process.env.QUAD_TEST_PG_PORT = String(port);

  /* Migrations are applied exactly the way src/db/migrate.js applies them in
     production: tracked in schema_migration, each in its own transaction, and
     applied once. That is what makes `reuse` correct rather than a special
     case — a restarted database simply has nothing new to apply, which is
     also true of a real deployment restarting against its live database. */
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
                        name text PRIMARY KEY,
                        applied_at timestamptz NOT NULL DEFAULT now())`);

  const files = (await readdir(migrationsDir)).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const done = await client.query(`SELECT 1 FROM schema_migration WHERE name = $1`, [f]);
    if (done.rowCount) continue;
    try {
      await client.query('BEGIN');
      await client.query(await readFile(join(migrationsDir, f), 'utf8'));
      await client.query(`INSERT INTO schema_migration (name) VALUES ($1)`, [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
      throw new Error(`migration ${f} failed: ${e.message}${e.position ? ` (pos ${e.position})` : ''}`);
    }
  }
  await client.end();
  return url;
}

/* Only the process that started the cluster stops it; a process that merely
   attached leaves it running for the next test file. */
/* embedded-postgres resolves stop() before the postmaster has always
   actually exited, which used to leave a database server running after the
   suite finished. Verify, and force it down if it is still answering —
   otherwise the next run has to reclaim it, and a developer is left with a
   stray server they never started. */
export async function stopDb() {
  if (!running) return;
  const port = activePort;
  try { await running.stop(); } catch { /* already down */ }
  running = null;

  /* Still answering? stop() did not take — force it. */
  if (port && await canConnect(port, 1200)) {
    for (const pid of listenerPids(port)) {
      const img = imageName(pid);
      if (img && /^postgres/i.test(img)) killPid(pid);
    }
  }
  /* Not answering, but a husk is left behind holding the data directory's
     shared memory. Harmless to this run, but it would make the NEXT run do
     the reclaiming — so clean up after ourselves instead. */
  for (const pid of deadPostgresHusks()) killPid(pid);

  await unlink(portFile).catch(() => {});
}

/* Used by the runner to bring the shared cluster down at the very end. */
export async function shutdownCluster() {
  const port = activePort ||
    Number(process.env.QUAD_TEST_PG_PORT) ||
    Number(await readFile(portFile, 'utf8').catch(() => 0)) ||
    BASE_PORT;
  if (running) return stopDb();
  if (!(await canConnect(port))) { await unlink(portFile).catch(() => {}); return; }
  try { await instance(port).stop(); } catch { /* nothing to do */ }
  await unlink(portFile).catch(() => {});
}

export async function truncateAll(pool) {
  await pool.query(`
    TRUNCATE audit_log, notification, support_message, support_case,
             refund_allocation, refund,
             ledger_entry, ledger_txn, ledger_account,
             payout, payout_batch, payout_destination,
             order_financials, pricing_policy,
             review, order_event, order_item, payment_webhook, payment,
             delivery_offer, food_order, partner_profile, verification_case,
             asset, menu_price_history, menu_item, category, vendor,
             campus_boundary, campus_node, session, otp_challenge, email_challenge,
             review_report, deposit_deduction, deposit_refund_request, deposit_movement,
             partner_policy_consent, partner_deposit_policy, delivery_incident,
             user_role, app_user, feature_flag, platform_config, email_send_log
    RESTART IDENTITY CASCADE`);
  /* The finance tables are not empty in a migrated database: 004 seeds the
     platform-wide ledger accounts and a zero-rated default pricing policy,
     without which nothing can be priced. Truncating and then restoring them
     keeps each test starting from the state a fresh deployment is in. */
  await pool.query(`
    INSERT INTO ledger_account (kind, normal) VALUES
      ('gateway_clearing','debit'), ('gateway_fee','debit'),
      ('platform_revenue','credit'), ('delivery_clearing','credit'),
      ('tax_payable','credit'), ('deposit_bank','debit')`);
  await pool.query(`
    INSERT INTO partner_deposit_policy (amount_paise, dispute_window_hours, terms)
    VALUES (0, 72, 'Test fixture mirroring migration 011: no deposit is required until an administrator publishes one.')`);
  await pool.query(
    `UPDATE campus_site SET service_status = CASE slug WHEN 'upes-bidholi' THEN 'active' ELSE 'coming_soon' END`);
  await pool.query(`
    INSERT INTO pricing_policy (vendor_id, note)
    VALUES (NULL, 'zero-rated default (test fixture, mirrors migration 004)')`);
  await pool.query(`
    INSERT INTO platform_config (key, value) VALUES
      ('refund_delivery_policy', '"platform_absorbs"'),
      ('settlement_timezone', '"Asia/Kolkata"'),
      ('settlement_cafeteria_schedule',
       '{"enabled": true, "hour": 20, "minute": 0, "min_paise": 100}'),
      ('settlement_partner_schedule',
       '{"enabled": true, "weekday": 1, "hour": 20, "minute": 0, "min_paise": 100}'),
      ('settlement_auto_release', 'false')`);
}

/* ---------- finance fixtures ---------------------------------------------
   Set the commercial terms the way an administrator would: by closing the
   live policy and opening a new one. Never by editing a row — the database
   refuses that, and so should a test.                                      */
export async function setTerms(pool, terms = {}, { vendorId = null } = {}) {
  const t = {
    commission_bps: 0, commission_mode: 'deduct_from_cafeteria',
    platform_fee_flat_paise: 0, platform_fee_bps: 0,
    delivery_fee_paise: 0, delivery_earning_paise: 0,
    tax_bps: 0, discount_funded_by: 'platform', ...terms,
  };
  await pool.query(
    `UPDATE pricing_policy SET effective_to = now()
      WHERE effective_to IS NULL AND vendor_id IS NOT DISTINCT FROM $1`, [vendorId]);
  const { rows } = await pool.query(
    `INSERT INTO pricing_policy (vendor_id, commission_bps, commission_mode,
       platform_fee_flat_paise, platform_fee_bps, delivery_fee_paise,
       delivery_earning_paise, tax_bps, discount_funded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [vendorId, t.commission_bps, t.commission_mode, t.platform_fee_flat_paise,
     t.platform_fee_bps, t.delivery_fee_paise, t.delivery_earning_paise,
     t.tax_bps, t.discount_funded_by]);
  return rows[0];
}

/* ---------- fixtures ----------------------------------------------------- */
/* studentStatus defaults to 'approved' because most tests are about
   something else and need an account that can actually place an order —
   verification is gated server-side by assertMayOrder(). Tests that are
   ABOUT verification pass an explicit status; see the order-access-control
   cases in security.test.mjs. */
export const campusId = async (pool, slug = 'upes-bidholi') =>
  (await pool.query(`SELECT id FROM campus_site WHERE slug = $1`, [slug])).rows[0].id;

/* Students are placed on Bidholi, the campus in service, by default, so a
   test about something else starts from an account that can order. */
export async function makeUser(pool, { phone, name, roles = ['student'], vendorId = null,
                                       studentStatus = 'approved', status = 'active',
                                       campus = 'upes-bidholi' }) {
  const u = (await pool.query(
    `INSERT INTO app_user (phone, name, student_status, status, campus_site_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    /* Many tests name users with a single letter. A real profile needs a full
       name, so a placeholder letter becomes "<letter> Tester". */
    [phone, name && name.length < 2 ? `${name} Tester` : name, studentStatus, status,
     campus ? await campusId(pool, campus) : null])).rows[0];
  for (const r of roles) {
    await pool.query(
      `INSERT INTO user_role (user_id, role, vendor_id) VALUES ($1,$2,$3)`,
      [u.id, r, ['vendor_owner', 'vendor_staff'].includes(r) ? vendorId : null]);
  }
  return u;
}

/* What a partner application requires besides verification: a profile photo
   and consent to the live deposit policy. Written directly, like makeUser's
   verified status, for tests that are about something other than the photo
   checks or the consent screen (those have their own tests). */
export async function makePartnerReady(pool, userId) {
  const a = (await pool.query(
    `INSERT INTO asset (owner_id, kind, mime, bytes, width, height, storage_key, sha256)
     VALUES ($1,'partner_photo','image/jpeg',60000,600,600,$2,$3) RETURNING id`,
    [userId, `partner_photo/fixture-${userId}.jpg`, `fixture-${userId}`])).rows[0];
  await pool.query(`UPDATE app_user SET partner_photo_asset = $2 WHERE id = $1`, [userId, a.id]);
  const policy = (await pool.query(`SELECT id FROM partner_deposit_policy WHERE effective_to IS NULL`)).rows[0];
  return { policyId: policy.id };
}

export async function makeVendor(pool, { name, slug, open = true, campus = 'upes-bidholi' }) {
  return (await pool.query(
    `INSERT INTO vendor (slug, name, is_open, accepting, delivery_enabled, campus_site_id)
     VALUES ($1,$2,$3,$3,true,$4) RETURNING *`, [slug, name, open, await campusId(pool, campus)])).rows[0];
}

export async function makeItem(pool, vendorId, { name, paise, available = true }) {
  return (await pool.query(
    `INSERT INTO menu_item (vendor_id, name, price_paise, available)
     VALUES ($1,$2,$3,$4) RETURNING *`, [vendorId, name, paise, available])).rows[0];
}

export async function makeCampus(pool, { boundary = 'active' } = {}) {
  /* Test locations belong to Bidholi. By default the campus also gets a
     CONFIRMED test boundary, because delivery is refused on a campus without
     one; tests about that rule pass boundary: 'none' or 'proposed'. */
  const cid = await campusId(pool);
  const node = async (cols, vals) => (await pool.query(
    `INSERT INTO campus_node (campus_site_id, ${cols.join(',')})
     VALUES ($1, ${vals.map((_, i) => '$' + (i + 2)).join(',')}) RETURNING *`, [cid, ...vals])).rows[0];
  const zone = await node(['kind', 'name', 'aliases', 'deliverable'], ['zone', 'Academic Area', ['academic'], false]);
  /* TEST FIXTURE positions, inside the test polygon below - not real places.
     Delivery points need a recorded position (the gate refuses one without). */
  const blockB = await node(['parent_id', 'kind', 'name', 'aliases', 'deliverable', 'lat', 'lng'], [zone.id, 'building', 'Block B', ['block b'], true, 30.4150, 77.9650]);
  const hostelZone = await node(['kind', 'name', 'aliases', 'deliverable'], ['zone', 'Hostel Area', ['hostel'], false]);
  /* The ambiguity case: a second "Block B" in a different zone. */
  const hostelB = await node(['parent_id', 'kind', 'name', 'aliases', 'deliverable', 'lat', 'lng'], [hostelZone.id, 'building', 'Block B', ['block b'], true, 30.4180, 77.9700]);
  const hostelA = await node(['parent_id', 'kind', 'name', 'aliases', 'deliverable'], [hostelZone.id, 'building', 'Hostel A', ['hostel a'], false]);
  const hostelA2 = await node(['parent_id', 'kind', 'name', 'aliases', 'deliverable', 'lat', 'lng'], [hostelA.id, 'floor', 'Block 2', ['block 2'], true, 30.4185, 77.9705]);
  const ground = await node(['kind', 'name', 'aliases', 'deliverable', 'lat', 'lng', 'radius_m'],
    ['zone', 'Ground', ['ground', 'maidan'], true, 30.4160, 77.9680, 80]);
  const disabled = await node(['kind', 'name', 'deliverable', 'delivery_enabled'], ['spot', 'Restricted Lab', true, false]);
  const archived = await node(['kind', 'name', 'deliverable', 'active'], ['spot', 'Old Canteen', true, false]);
  if (boundary !== 'none') {
    await pool.query(
      `INSERT INTO campus_boundary (name, polygon, campus_site_id, status, active, source, verified_at)
       VALUES ('Test Campus', $1, $2, $3, $4, 'test fixture', CASE WHEN $3 = 'active' THEN now() END)
       ON CONFLICT (campus_site_id) WHERE status = 'active' DO NOTHING`,
      [JSON.stringify([[30.410, 77.960], [30.410, 77.975], [30.422, 77.975], [30.422, 77.960]]), cid,
       boundary, boundary === 'active']);
  }
  return { zone, blockB, hostelZone, hostelB, hostelA, hostelA2, ground, disabled, archived, campusId: cid };
}
if (process.argv[2] === 'init') {
  await initCluster();
  process.exit(0);
}
