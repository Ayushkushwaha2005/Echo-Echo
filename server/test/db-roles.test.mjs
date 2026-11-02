/* ==========================================================================
   THE RUNTIME DATABASE ROLE - proved on the disposable test cluster.

   deploy/db-roles.sql is not applied to production by anything. This shows what
   it would do: the role the API would connect as can work with data, but cannot
   disable an append-only trigger or change the schema.
   ========================================================================== */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { startDb, stopDb, truncateAll, makeUser } from './helpers/db.mjs';

let pool, runtime;
before(async () => {
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  await truncateAll(pool);
  await pool.query(readFileSync(new URL('../../deploy/db-roles.sql', import.meta.url), 'utf8'));
  await pool.query(`ALTER ROLE echo_runtime PASSWORD 'test-only-runtime'`);
  const url = new URL(process.env.DATABASE_URL);
  url.username = 'echo_runtime'; url.password = 'test-only-runtime';
  runtime = new pg.Client({ connectionString: url.toString() });
  await runtime.connect();
});
after(async () => {
  await runtime?.end();
  await pool.query(`DROP OWNED BY echo_runtime; DROP ROLE echo_runtime`).catch(() => {});
  await pool?.end();
  await stopDb();
});

test('it can do the application\'s ordinary work', async () => {
  const u = await makeUser(pool, { phone: '+919111100001', name: 'Runtime Test' });
  const r = await runtime.query(`UPDATE app_user SET name = 'Changed' WHERE id = $1 RETURNING name`, [u.id]);
  assert.equal(r.rows[0].name, 'Changed');
  await runtime.query(`INSERT INTO audit_log (action, outcome) VALUES ('role.test','ok')`);
  await runtime.query(`SELECT count(*) FROM schema_migration`);
});

test('it cannot disable an append-only trigger or weaken the schema', async () => {
  for (const [sql, why] of [
    ['ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only', 'disable the audit trigger'],
    ['DROP TRIGGER audit_log_append_only ON audit_log', 'drop the audit trigger'],
    ['ALTER TABLE change_event DISABLE TRIGGER ALL', 'disable feed triggers'],
    ['ALTER TABLE approval_request DROP CONSTRAINT approval_no_self_decision', 'drop the self-approval rule'],
    ['DROP TABLE audit_log', 'drop a table'],
    ['CREATE TABLE sneaky (id int)', 'create a table'],
    ['TRUNCATE audit_log', 'truncate the audit log'],
    ['ALTER ROLE echo_runtime SUPERUSER', 'promote itself'],
    ["INSERT INTO schema_migration (name) VALUES ('999_fake.sql')", 'fake a migration'],
  ]) {
    await assert.rejects(runtime.query(sql), /permission denied|must be owner|must be superuser/i, why);
  }
});

test('it cannot rewrite or delete audit history, by privilege as well as by trigger', async () => {
  await assert.rejects(runtime.query(`UPDATE audit_log SET outcome = 'x'`), /permission denied/);
  await assert.rejects(runtime.query(`DELETE FROM audit_log`), /permission denied/);
});
