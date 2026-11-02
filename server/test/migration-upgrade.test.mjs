/* ==========================================================================
   Upgrading a database that looks like production's today: migrations up to 035
   applied, real rows in place, then 036 onwards. Nothing already there may be
   removed, retyped or changed, because the previous release has to keep working on
   this schema if it is rolled back, and money tables must not move.
   ========================================================================== */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { startDb, stopDb } from './helpers/db.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db');
const all = readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
const released = all.filter((f) => Number(f.slice(0, 3)) <= 35);
const added = all.filter((f) => Number(f.slice(0, 3)) > 35);

const MONEY = ['ledger_txn', 'ledger_entry', 'order_financials', 'payout', 'payout_batch', 'refund', 'pricing_policy', 'deposit_movement'];
const db = 'quad_upgrade_check';
let admin, c;

before(async () => {
  await startDb();
  const url = new URL(process.env.DATABASE_URL);
  admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin.query(`CREATE DATABASE ${db}`);
  url.pathname = `/${db}`;
  c = new pg.Client({ connectionString: url.href });
  await c.connect();
});
after(async () => {
  await c?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin?.end();
  await stopDb();
});

const columns = async () => (await c.query(
  `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`)).rows
  .map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable}`);
const fingerprint = async (t) => (await c.query(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM ${t} x`)).rows[0];

test('036 onwards are present, and the release they follow stops at 035', () => {
  assert.ok(released.some((f) => f.startsWith('035')));
  assert.ok(added.length >= 7, added.join());
  /* Nothing a new migration does may be destructive to what was already there. */
  for (const f of added) {
    const sql = readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i, f);
    assert.doesNotMatch(sql, /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, f);
  }
});

test('an upgrade with rows in place keeps every column and row, and money tables do not move', async () => {
  for (const f of released) await c.query(readFileSync(join(dir, f), 'utf8'));

  const { rows: [u] } = await c.query(`INSERT INTO app_user (phone, name) VALUES ('+919111100001','Existing Person') RETURNING id`);
  const { rows: [v] } = await c.query(`INSERT INTO vendor (slug, name, is_open, accepting) VALUES ('existing','Existing Cafe',true,true) RETURNING id`);
  const { rows: [i] } = await c.query(`INSERT INTO menu_item (vendor_id, name, price_paise) VALUES ($1,'Existing Chai',2500) RETURNING id`, [v.id]);
  await c.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'platform_admin')`, [u.id]);
  await c.query(`INSERT INTO admin_account (user_id, status, permissions, activated_at) VALUES ($1,'active','{admins.view,orders.view}', now())`, [u.id]);
  await c.query(`INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise) VALUES ('EXIST1',$1,$2,'pickup','confirmed',2500,2500)`, [u.id, v.id]);

  const before = await columns();
  const money = Object.fromEntries(await Promise.all(MONEY.map(async (t) => [t, await fingerprint(t)])));

  for (const f of added) await c.query(readFileSync(join(dir, f), 'utf8'));

  const after = new Set(await columns());
  const lost = before.filter((x) => !after.has(x));
  /* A new NOT NULL column with a default is fine; an existing column may only loosen. */
  /* 036: an invitation no longer stores an emailed code up front. A loosened rule; old code still writes both. */
  const loosened = ['admin_invitation.salt text NO', 'admin_invitation.code_hash text NO'];
  assert.deepEqual(lost.filter((x) => !loosened.includes(x)), [], `columns removed or changed: ${lost.join(', ')}`);
  for (const t of MONEY) assert.deepEqual(await fingerprint(t), money[t], t);

  assert.equal((await c.query(`SELECT name FROM app_user WHERE id = $1`, [u.id])).rows[0].name, 'Existing Person');
  assert.equal((await c.query(`SELECT price_paise FROM menu_item WHERE id = $1`, [i.id])).rows[0].price_paise, 2500);

  /* Nobody who could do something before loses it. */
  const perms = (await c.query(`SELECT permissions FROM admin_account WHERE user_id = $1`, [u.id])).rows[0].permissions;
  for (const p of ['admins.view', 'orders.view', 'sessions.read', 'reports.export']) assert.ok(perms.includes(p), p);
  assert.ok(!perms.includes('delivery.track'), 'nobody is migrated into seeing coordinates');
});

test('a write made by the previous release on the new schema still works, and is versioned', async () => {
  /* Old code knows nothing of revision or staff_email: these are its own statements. */
  const v = (await c.query(`SELECT id FROM vendor WHERE slug = 'existing'`)).rows[0];
  await c.query(`UPDATE vendor SET name = 'Renamed by old code' WHERE id = $1`, [v.id]);
  const item = (await c.query(`INSERT INTO menu_item (vendor_id, name, price_paise) VALUES ($1,'Old Code Item',1000) RETURNING id, revision`, [v.id])).rows[0];
  await c.query(`UPDATE menu_item SET price_paise = 1100 WHERE id = $1`, [item.id]);
  const versions = (await c.query(`SELECT revision, snapshot->>'price_paise' AS p FROM catalog_version WHERE entity_id = $1 ORDER BY revision`, [item.id])).rows;
  assert.deepEqual(versions.map((r) => Number(r.p)), [1000, 1100]);
});
