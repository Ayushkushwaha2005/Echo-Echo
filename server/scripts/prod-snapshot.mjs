/* Read-only logical snapshot of every public table to var/backups/<stamp>/,
   plus a fingerprint (row count + md5 of the ordered rows) of the money
   tables, so a migration can be proven not to have touched them.
     node --env-file=.env scripts/prod-snapshot.mjs [label]            */
import pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const label = process.argv[2] || 'snapshot';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('SET default_transaction_read_only = on');
await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
const dir = join('var', 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`);
mkdirSync(dir, { recursive: true });
const tables = (await client.query(
  `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows.map((r) => r.tablename);
const MONEY = ['ledger_entry', 'ledger_txn', 'ledger_account', 'order_financials', 'pricing_policy', 'payment',
               'refund', 'refund_allocation', 'payout', 'payout_batch', 'food_order', 'deposit_movement', 'deposit_deduction'];
const fp = {};
let total = 0;
for (const t of tables) {
  const rows = (await client.query(`SELECT * FROM "${t}"`)).rows;
  writeFileSync(join(dir, `${t}.json`), JSON.stringify(rows));
  total += rows.length;
  if (MONEY.includes(t)) {
    const h = (await client.query(
      `SELECT count(*)::int n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM "${t}" x`)).rows[0];
    fp[t] = h;
  }
}
const mig = (await client.query(`SELECT name FROM schema_migration ORDER BY name`)).rows.map((r) => r.name);
await client.query('COMMIT'); await client.end();
writeFileSync(join(dir, '_fingerprint.json'), JSON.stringify({ fp, migrations: mig }, null, 1));
console.log(JSON.stringify({ dir, tables: tables.length, rows: total, migrations: mig.length, last: mig.at(-1), money: fp }, null, 1));
