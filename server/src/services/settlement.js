/* ==========================================================================
   QUAD — SCHEDULED SETTLEMENT

   Cafeterias settle every evening, delivery partners once a week. Nobody
   calculates either amount by hand: the run reads each payee's ledger
   balance — which is already gross sales, less commission, less their share
   of refunds, less adjustments, less everything previously paid — and writes
   one pending payout per payee.

   Three properties this file has to get right:

   1. IT NEVER MOVES MONEY. A scheduled run only builds a batch of pending
      payouts. Approval and release are separate, deliberate admin actions,
      and release still requires a configured provider or an administrator's
      own recorded bank transfer. `settlement_auto_release` exists but is
      false by default and is refused outright with no provider connected.

   2. IT IS SAFE TO RUN CONSTANTLY. The scheduler ticks every minute and asks
      "has the batch for this period been built yet?". The answer comes from
      a UNIQUE index on (kind, period_key), not from a timer's memory, so a
      restart loop, a redeploy at 20:00, or two instances running side by side
      all produce exactly one batch for the evening.

   3. IT CATCHES UP. The question is "is it past 20:00 and is today's batch
      missing", not "did the clock just strike 20:00". A server that was down
      all evening builds the batch when it returns, rather than silently
      skipping a day of settlements.

   Times are wall-clock in `settlement_timezone`, because "8 PM" means 8 PM
   on campus. The server's own timezone is never used.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { PAYOUTS } from '../config.js';
import { runScheduledReconciliation } from './reconciliation.js';
import { buildBatch, releaseBatch } from './payouts.js';

const DEFAULTS = {
  timezone: 'Asia/Kolkata',
  cafeteria: { enabled: true, hour: 20, minute: 0, min_paise: 100 },
  partner: { enabled: true, weekday: 1, hour: 20, minute: 0, min_paise: 100 },
};

async function config(key, fallback) {
  const r = await one(`SELECT value FROM platform_config WHERE key = $1`, [key]);
  if (!r) return fallback;
  return r.value;
}

export async function schedule() {
  return {
    timezone: await config('settlement_timezone', DEFAULTS.timezone),
    cafeteria: { ...DEFAULTS.cafeteria,
                 ...(await config('settlement_cafeteria_schedule', {})) },
    partner: { ...DEFAULTS.partner,
               ...(await config('settlement_partner_schedule', {})) },
    autoRelease: (await config('settlement_auto_release', false)) === true,
  };
}

/* ---------- wall-clock arithmetic ----------------------------------------
   Intl is the only thing in Node that knows what time it is in Kolkata
   without pulling in a timezone library, and it knows it correctly across
   DST changes in the zones that have them. */
export function localParts(instant, timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    /* '24' is how Intl renders midnight under hour12:false in some ICU
       versions; normalise it, or a batch would never build after midnight. */
    hour: Number(p.hour) % 24, minute: Number(p.minute),
    weekday: WEEKDAY[p.weekday],
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/* ISO week, so a weekly period key is stable across a year boundary. */
export function isoWeekKey(instant, timeZone) {
  const { year, month, day } = localParts(instant, timeZone);
  const d = new Date(Date.UTC(year, month - 1, day));
  const dow = d.getUTCDay() || 7;               // Monday = 1 … Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dow);       // the Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Which period, if any, is due right now and not yet settled.
 *
 * Returns null when the schedule is disabled, or when the scheduled moment
 * has not arrived yet in the configured timezone. Deliberately pure and
 * exported, so the tests can drive it with a fixed instant instead of
 * waiting for 8 PM.
 */
export function duePeriod(kind, cfg, now, timeZone) {
  if (!cfg?.enabled) return null;
  const t = localParts(now, timeZone);

  if (kind === 'cafeteria') {
    /* Past this evening's time? Then today's batch is due. */
    if (t.hour < cfg.hour || (t.hour === cfg.hour && t.minute < cfg.minute)) return null;
    return { periodKey: `cafeteria:${t.date}`, label: `evening of ${t.date}` };
  }

  if (kind === 'partner') {
    /* The weekly run happens on one weekday. On any other day nothing is
       due — and because the key is the ISO week, a run that is late by a day
       still settles the week it was meant to settle, once. */
    if (t.weekday !== cfg.weekday) return null;
    if (t.hour < cfg.hour || (t.hour === cfg.hour && t.minute < cfg.minute)) return null;
    const week = isoWeekKey(now, timeZone);
    return { periodKey: `partner:${week}`, label: `week ${week}` };
  }
  return null;
}

/**
 * Build the batches that are due and have not been built.
 *
 * @param now  the instant to evaluate against; injectable for the tests.
 * @returns    what it did, per kind, in enough detail to log honestly.
 */
export async function runSettlementSchedules({ now = new Date(), log } = {}) {
  const cfg = await schedule();
  const out = {};

  for (const kind of ['cafeteria', 'partner']) {
    const due = duePeriod(kind, cfg[kind], now, cfg.timezone);
    if (!due) { out[kind] = { due: false }; continue; }

    /* Already built? The index is the authority, not a timer. */
    const existing = await one(
      `SELECT id, state FROM payout_batch WHERE kind = $1 AND period_key = $2`,
      [kind, due.periodKey]);
    if (existing) {
      out[kind] = { due: true, alreadyBuilt: true, batchId: existing.id, state: existing.state };
      continue;
    }

    try {
      /* A scheduled batch has no human author. `created_by` is NOT NULL, so it
         is attributed to the platform owner — the account accountable for the
         platform's money, and the only one guaranteed to exist. */
      const owner = await platformOwnerId();
      const built = await tx((c) => buildBatch(c, {
        kind,
        periodKey: due.periodKey,
        origin: 'scheduled',
        periodEnd: now,
        minPaise: cfg[kind].min_paise,
        actorId: owner,
        note: `Scheduled settlement, ${due.label}`,
      }));
      out[kind] = {
        due: true, built: true, batchId: built.batch.id,
        payouts: built.payouts.length,
        totalPaise: built.payouts.reduce((s, p) => s + p.amount_paise, 0),
        skipped: built.skipped.length,
      };

      /* Unattended release. Off by default, and impossible to switch on
         without a payout provider (the schedule route refuses), because
         "released" with nothing to release through would be a lie. When it
         IS on, the batch is approved in the platform owner's name and sent —
         and every guard downstream still applies: only a provider-confirmed
         transfer marks a payout paid, and the ledger posting is idempotent
         on the payout id. */
      if (cfg.autoRelease && PAYOUTS.configured && built.payouts.length) {
        const owner = await platformOwnerId();
        const approved = await one(
          `UPDATE payout_batch SET state='approved', approved_by=$2, approved_at=now()
            WHERE id=$1 AND state='open' RETURNING *`, [built.batch.id, owner]);
        if (approved) {
          const rel = await releaseBatch({ q, tx }, { batch: approved, actorId: owner });
          await q(
            `UPDATE payout_batch SET state='completed', completed_at=now(), released_at=now()
              WHERE id=$1 AND state='approved'
                AND NOT EXISTS (SELECT 1 FROM payout
                                 WHERE batch_id=$1 AND state IN ('pending','processing'))`,
            [built.batch.id]);
          out[kind].autoReleased = { paid: rel.paid.length, failed: rel.failed.length,
                                     skipped: rel.skipped.length };
        }
      }
      log?.info({ settlement: out[kind] }, `settlement batch built for ${due.label}`);
    } catch (e) {
      /* Another instance won the race. That is the index doing its job, not
         an error to alarm anyone with. */
      if (e.code === '23505') {
        out[kind] = { due: true, alreadyBuilt: true, raced: true };
        continue;
      }
      out[kind] = { due: true, error: e.message };
      log?.error({ e }, `settlement run failed for ${kind}`);
    }
  }
  return out;
}

async function platformOwnerId() {
  const r = await one(
    `SELECT user_id FROM user_role WHERE role = 'platform_owner' LIMIT 1`);
  if (!r) throw new Error('no platform owner exists; cannot attribute a scheduled settlement');
  return r.user_id;
}

/**
 * The ticker. One minute is plenty: the run is a cheap "is it built yet"
 * query on every tick but the one that matters.
 */
export function startSettlementScheduler(app, intervalMs = 60_000) {
  const timer = setInterval(async () => {
    try {
      const out = await runSettlementSchedules({ log: app.log });
      if (Object.values(out).some((v) => v.built)) app.log.info({ settlement: out }, 'settlement');

      /* Settlement reconciliation rides the same tick. It is deliberately
         AFTER the batch build rather than before: reconciliation records
         what the gateway charged Quad, which never affects what a cafeteria
         is owed, so making tonight's payout wait on a provider API that may
         be slow would be trading a real obligation for a bookkeeping one.

         Its own guard keeps it to one run a day; this interval is 60s. */
      const recon = await runScheduledReconciliation({ log: app.log });
      if (recon.ran) app.log.info({ reconciliation: recon }, 'settlement reconciliation');
    } catch (e) {
      app.log.error({ e }, 'settlement scheduler failed');
    }
  }, intervalMs);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));
  return timer;
}
