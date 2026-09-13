/* ==========================================================================
   PERSISTENCE ACROSS RESTART

   Every other suite drops and recreates the database, so none of them can
   prove anything survives. This one writes real data through the real API in
   one process, kills the Fastify server AND the PostgreSQL process, brings
   both back, and reads the data again from a completely fresh process.

   If any part of the backend were holding production state in memory, this
   is the suite where it would show up as missing data.
   ========================================================================== */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, truncateAll } from './helpers/db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const phaseScript = join(here, 'helpers', 'persist-phase.mjs');

/* A phase runs as its own process: new heap, new module graph, new pool. */
function runPhase(mode) {
  const r = spawnSync(process.execPath, [phaseScript, mode],
                      { encoding: 'utf8', env: process.env });
  return { status: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

before(async () => {
  await startDb();                       // clean schema from the real migrations
  const { pool } = await import('../src/db/index.js');
  await truncateAll(pool);
  await pool.end();
});
after(async () => { await stopDb(); });

test('data written through the API is created in a real database', () => {
  const r = runPhase('create');
  assert.equal(r.status, 0, `create phase failed:\n${r.out}`);
  assert.match(r.out, /CREATE OK/);
});

test('PostgreSQL and the server are both fully restarted', async () => {
  await stopDb();                        // the database PROCESS goes down
  const url = await startDb({ reuse: true });
  assert.ok(url.includes('quad_test'));
});

test('a brand-new process finds every entity intact', () => {
  const r = runPhase('verify');
  assert.equal(r.status, 0, `verify phase failed:\n${r.out}`);
  assert.match(r.out, /VERIFY OK/);
});

test('a second restart cycle is also survivable', async () => {
  /* Once could be luck — e.g. an OS file cache. Twice is persistence. */
  await stopDb();
  await startDb({ reuse: true });
  const r = runPhase('verify');
  assert.equal(r.status, 0, `second verify failed:\n${r.out}`);
});

test('the data really is on disk, not in a connection', async () => {
  /* Read it with a connection that has no relationship to the app at all. */
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const o = (await c.query(
    `SELECT o.code, o.total_paise, oi.unit_paise_snapshot, v.name AS vendor
       FROM food_order o
       JOIN order_item oi ON oi.order_id = o.id
       JOIN vendor v ON v.id = o.vendor_id
      WHERE v.name = 'Persistence Cafe'`)).rows[0];
  await c.end();

  assert.ok(o, 'the order is readable from a plain psql-style connection');
  assert.equal(o.total_paise, 13500);
  assert.equal(o.unit_paise_snapshot, 4500, 'the price snapshot is on disk');
  assert.equal(o.vendor, 'Persistence Cafe');
});
