/* ==========================================================================
   QUAD — POSTGRES POOL

   One pool per process. Managed providers (Neon, Supabase, RDS, Render)
   terminate idle connections and require TLS, so both are configured here
   rather than left to whatever the driver defaults to on the day.
   ========================================================================== */
import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DB } from '../config.js';

/* Money is integer paise everywhere. Stop node-postgres turning int8 into a
   string, which would silently break every arithmetic comparison. */
pg.types.setTypeParser(20, (v) => Number(v));      // int8

export const pool = new pg.Pool({
  connectionString: DB.url,
  ssl: DB.ssl,
  max: DB.poolMax,
  /* Below the typical 5-minute idle cull on managed Postgres, so we retire
     a connection before the provider does and never hand a dead socket to
     a request. */
  idleTimeoutMillis: DB.idleTimeoutMs,
  connectionTimeoutMillis: DB.connectTimeoutMs,
  /* A hard ceiling on a single statement. Without it one pathological query
     can pin a connection until the provider kills it. */
  statement_timeout: DB.statementTimeoutMs,
  query_timeout: DB.statementTimeoutMs,
  application_name: 'quad',
});

/* A pool error is emitted for idle clients that die outside a query. Without
   a listener Node treats it as an unhandled 'error' event and exits — which
   is how a routine provider restart turns into an outage. */
pool.on('error', (err) => {
  console.error(JSON.stringify({
    level: 'error', msg: 'idle postgres client error',
    code: err.code, detail: String(err.message).slice(0, 200),
  }));
});

/* Set only inside atomic(). Everywhere else this is empty and q, one and tx behave
   exactly as they always have. */
const held = new AsyncLocalStorage();

/* A straggler that outlives its atomic() must not touch a connection already back in
   the pool, where it would land in someone else's transaction. */
const live = () => { const s = held.getStore(); return s && !s.done ? s : null; };

export const q = (text, params) => (live()?.client || pool).query(text, params);

export async function one(text, params) {
  const { rows } = await q(text, params);
  return rows[0] || null;
}

export async function tx(fn) {
  const store = live();
  if (store) {
    /* Already inside atomic(): one connection, one commit. A second connection
       here could wait forever on a lock this request holds. */
    await store.client.query('SAVEPOINT nested_tx');
    try {
      const out = await fn(store.client);
      await store.client.query('RELEASE SAVEPOINT nested_tx');
      return out;
    } catch (e) {
      await store.client.query('ROLLBACK TO SAVEPOINT nested_tx').catch(() => {});
      throw e;
    }
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});   // the connection may be gone
    throw e;
  } finally {
    c.release();
  }
}

/* Runs fn so that every q, one and tx inside it, however deep, is one transaction:
   the whole of it commits or none of it does. `after` work (a refusal's audit row)
   runs once the transaction has ended, on its own connection, so it survives the
   rollback and cannot wait on a lock the transaction held. */
export async function atomic(fn) {
  if (live()) return fn();
  const store = { client: null, after: [], done: false };
  try {
    return await tx((client) => { store.client = client; return held.run(store, fn); });
  } finally {
    store.done = true;
    await Promise.all(store.after.map((work) => work()));
  }
}
export const atomicStore = () => live();
/* For work that must not join the caller's transaction, such as a notification
   sent without waiting for it. */
export const detached = (fn) => held.exit(fn);

/* Used by /ready. Reports latency and pool saturation, so a slow database
   is visible before it becomes a failing one. */
export async function health() {
  const t = Date.now();
  try {
    const r = await pool.query('SELECT current_database() AS db, version() AS v');
    return {
      ok: true,
      latencyMs: Date.now() - t,
      database: r.rows[0].db,
      server: String(r.rows[0].v).split(',')[0],
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: DB.poolMax },
    };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t, error: e.code || String(e.message).slice(0, 120) };
  }
}

/* Which migrations this database has actually applied — surfaced on /ready
   so a half-migrated deploy is visible rather than mysterious. */
export async function migrationState() {
  try {
    const r = await pool.query(
      `SELECT name, applied_at FROM schema_migration ORDER BY name`);
    return { applied: r.rows.map((x) => x.name), count: r.rowCount };
  } catch (e) {
    if (e.code === '42P01') return { applied: [], count: 0, note: 'no migrations applied yet' };
    return { error: e.code };
  }
}
