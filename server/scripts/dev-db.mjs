/* ==========================================================================
   LOCAL DEVELOPMENT DATABASE — real PostgreSQL, not an emulation.

     npm run db          # from server/ (or the repo root)

   Starts the embedded PostgreSQL binaries against server/var/pgdev and keeps
   them running until Ctrl+C. The first run initialises the cluster, which
   takes a minute or two on Windows.

   Deliberately separate from the test cluster (server/var/pgdata): the test
   runner drops, recreates and finally stops its own cluster, and must never
   be able to take the development database down with it.

   Development only. Production uses a managed PostgreSQL with TLS; the
   server refuses a localhost DATABASE_URL when NODE_ENV=production.
   ========================================================================== */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { access, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run the embedded development database in production.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'var', 'pgdev');
const port = Number(process.env.DEV_PG_PORT || 55433);
const database = process.env.DEV_PG_DATABASE || 'quad';
const exists = (p) => access(p).then(() => true, () => false);

const db = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'quad', password: 'quad', port, persistent: true,
  onLog: () => {}, onError: (m) => console.error(String(m).trim()),
});

if (!(await exists(join(dataDir, 'PG_VERSION')))) {
  console.log('Initialising the development database (first run only)…');
  await db.initialise();
}
/* A crashed previous run leaves a stale pid file that blocks start-up. */
await unlink(join(dataDir, 'postmaster.pid')).catch(() => {});
await db.start();

const admin = new pg.Client({ connectionString: `postgres://quad:quad@localhost:${port}/postgres` });
await admin.connect();
const has = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
if (!has.rowCount) {
  await admin.query(`CREATE DATABASE ${database}`);
  console.log(`Created database "${database}". Next: npm run migrate`);
}
await admin.end();

console.log(`PostgreSQL ready — postgres://quad:quad@localhost:${port}/${database}`);

const stop = async () => { await db.stop().catch(() => {}); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
