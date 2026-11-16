/* ==========================================================================
   ECHO ECHO — RECORD THE OWNER'S HISTORICAL BASELINE (offline books)

     node --env-file=.env scripts/record-offline-baseline.mjs --from 2026-11-10 --to 2026-11-16            # dry run
     node --env-file=.env scripts/record-offline-baseline.mjs --from 2026-11-10 --to 2026-11-16 --apply    # write

   Records the figures the platform owner provided from ECHO ECHO's offline
   pen-and-paper books as owner-attested historical records (migration 047),
   which the Overview cards then show as their baseline:

     Total orders            126       up to --as-of (default: --to)
     ECHO ECHO revenue       ₹12,430   up to --as-of
     Owed to cafés           ₹8,915    up to --as-of
     Owed to partners        ₹1,240    up to --as-of
     Orders                  37        --from to --to, inclusive
     GMV                     ₹4,860    --from to --to, inclusive
     Platform fees           ₹185      --from to --to, inclusive

   The Overview shows every figure as a running total: the figure plus all
   activity after its cutoff (the end of the day it runs to, India time).

   Each row is attested by the active platform owner, with the source "Offline
   pen-and-paper business records", and gets an offline_record.attest audit row
   in the same transaction. Nothing else is written: no order, payment, ledger
   entry, payout or settlement. Re-running skips any figure already recorded
   for the same period, so it is safe to run twice. Without --apply nothing is
   written and the plan is printed.
   ========================================================================== */
import { pool } from '../src/db/index.js';
import { DB } from '../src/config.js';
import { parseRecord } from '../src/routes/offline-records.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const from = arg('--from');
const to = arg('--to');
const asOf = arg('--as-of') || to;
const apply = process.argv.includes('--apply');
if (!DB.configured) { console.error('✗ DATABASE_URL is not set.'); process.exit(1); }
if (!from || !to) { console.error('✗ Pass --from and --to (YYYY-MM-DD): the dates the 37 orders, ₹4,860 GMV and ₹185 fees cover.'); process.exit(1); }

const NOTE = 'Figures provided by the owner from the offline books, 16 Nov 2026';
/* As provided by the owner. Amounts in paise (₹1 = 100 paise). */
const FIGURES = [
  { metric: 'orders',          value: 126,       periodEnd: asOf },
  { metric: 'net_revenue',     value: 12430_00,  periodEnd: asOf },
  { metric: 'cafe_payable',    value: 8915_00,   periodEnd: asOf },
  { metric: 'partner_payable', value: 1240_00,   periodEnd: asOf },
  { metric: 'orders',          value: 37,        periodStart: from, periodEnd: to },
  { metric: 'gmv',             value: 4860_00,   periodStart: from, periodEnd: to },
  { metric: 'platform_fees',   value: 185_00,    periodStart: from, periodEnd: to },
].map((f) => parseRecord({ ...f, note: NOTE }));

const c = await pool.connect();
try {
  await c.query('BEGIN');
  const owners = (await c.query(
    `SELECT u.id, u.name FROM app_user u JOIN user_role r ON r.user_id = u.id
      WHERE r.role = 'platform_owner' AND r.status = 'active' AND u.status = 'active'`)).rows;
  if (owners.length !== 1) throw new Error(`expected exactly one active platform owner, found ${owners.length}`);
  const owner = owners[0];
  console.log(`\nAttested by: ${owner.name} (platform owner)   ${apply ? 'WRITING' : 'dry run — nothing is written'}\n`);
  for (const f of FIGURES) {
    const exists = (await c.query(
      `SELECT id FROM offline_record WHERE withdrawn_at IS NULL AND metric = $1
          AND period_start IS NOT DISTINCT FROM $2::date AND period_end = $3::date`,
      [f.metric, f.periodStart, f.periodEnd])).rows[0];
    const what = `${f.metric.padEnd(16)} ${String(f.value).padStart(9)}  ${f.periodStart ? `${f.periodStart} to ${f.periodEnd}` : `up to ${f.periodEnd}`}`;
    if (exists) { console.log(`  skip   ${what}  (already recorded: ${exists.id})`); continue; }
    if (!apply) { console.log(`  would  ${what}`); continue; }
    const row = (await c.query(
      `INSERT INTO offline_record (metric, value, period_start, period_end, counterparty, source, source_reference, note, attested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [f.metric, f.value, f.periodStart, f.periodEnd, f.counterparty, f.source, f.sourceReference, f.note, owner.id])).rows[0];
    await c.query(
      `INSERT INTO audit_log (actor_id, actor_role, action, resource, resource_id, outcome, detail)
       VALUES ($1,'platform_owner','offline_record.attest','offline_record',$2,'ok',$3)`,
      [owner.id, row.id, JSON.stringify({ ...f, via: 'scripts/record-offline-baseline.mjs' })]);
    console.log(`  wrote  ${what}  ${row.id}`);
  }
  await c.query(apply ? 'COMMIT' : 'ROLLBACK');
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`✗ ${e.message}`); process.exitCode = 1;
} finally {
  c.release(); await pool.end();
}
