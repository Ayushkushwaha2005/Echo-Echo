/* ==========================================================================
   ECHO ECHO - OWNER-ATTESTED OFFLINE HISTORICAL RECORDS (migration 047)

   Aggregate figures from the business's offline (paper) books, entered by
   the platform owner as their own attestation, with the source, the period
   the figure covers, and who recorded it and when.

   They are kept apart from the books on purpose: nothing here posts to the
   ledger or creates an order, payment, payout or settlement, and no figure
   computed from transactions (finance summary, settlements, reports) reads
   this table. A payable recorded here is a claim to be reconciled, not a
   balance anything can pay out.

   Figures are listed one by one with their periods and never summed: two
   records can overlap (all orders to 15 Nov, and the orders of 15 Nov), and
   adding them would count the same business twice.

   Recording and withdrawing are the owner's alone (records.attest, which is
   owner-only), need a recent sign-in confirmation, run atomically with their
   audit row (atomic-routes.js), and never edit a figure: a correction is a
   withdrawal plus a new record. Reading needs finance.view.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { authorize, BadRequest, NotFound, Conflict } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { audit } from '../audit.js';

/* What each metric is, and in which unit its value is stored. */
export const METRICS = {
  orders:          { unit: 'count', label: 'Orders' },
  gmv:             { unit: 'paise', label: 'Gross order value (GMV)' },
  platform_fees:   { unit: 'paise', label: 'Platform fees' },
  net_revenue:     { unit: 'paise', label: 'ECHO ECHO revenue' },
  cafe_payable:    { unit: 'paise', label: 'Owed to cafés' },
  partner_payable: { unit: 'paise', label: 'Owed to delivery partners' },
};
export const DEFAULT_SOURCE = 'Offline pen-and-paper business records';
const PAYABLES = new Set(['cafe_payable', 'partner_payable']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
/* Today in India, where the books are kept: a record cannot cover the future. */
const todayIST = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

function optionalText(v, max, what) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw BadRequest(`${what} must be text`);
  const s = v.trim();
  if (!s) return null;
  if (s.length > max) throw BadRequest(`${what} is too long`, `At most ${max} characters.`);
  return s;
}

/** Validates a new record's body. Exported for the unit tests. */
export function parseRecord(body) {
  const b = body && typeof body === 'object' ? body : {};
  const m = METRICS[b.metric];
  if (!m) throw BadRequest('Unknown figure', `metric must be one of: ${Object.keys(METRICS).join(', ')}.`);
  if (typeof b.value !== 'number' || !Number.isSafeInteger(b.value) || b.value < 0) {
    throw BadRequest('The figure must be a whole number of zero or more',
      m.unit === 'paise' ? 'Amounts are sent in paise (₹1 = 100 paise).' : 'Orders are a count.');
  }
  if (!isDate(b.periodEnd)) throw BadRequest('Say which day the figure runs up to', 'periodEnd must be a date, YYYY-MM-DD.');
  const periodStart = b.periodStart == null || b.periodStart === '' ? null : b.periodStart;
  if (periodStart !== null && !isDate(periodStart)) throw BadRequest('periodStart must be a date, YYYY-MM-DD');
  if (periodStart && periodStart > b.periodEnd) throw BadRequest('The period starts after it ends');
  if (b.periodEnd > todayIST()) throw BadRequest('A record from the books cannot cover a day that has not happened yet');
  const counterparty = optionalText(b.counterparty, 120, 'The café or partner name');
  if (counterparty && !PAYABLES.has(b.metric)) {
    throw BadRequest('Only an amount owed is recorded against a café or partner');
  }
  return {
    metric: b.metric, value: b.value, periodStart, periodEnd: b.periodEnd, counterparty,
    source: optionalText(b.source, 200, 'The source') || DEFAULT_SOURCE,
    sourceReference: optionalText(b.sourceReference, 200, 'The source reference'),
    note: optionalText(b.note, 500, 'The note'),
  };
}

const view = (r) => ({
  id: r.id, metric: r.metric, unit: METRICS[r.metric]?.unit, label: METRICS[r.metric]?.label, value: Number(r.value),
  periodStart: r.period_start, periodEnd: r.period_end, counterparty: r.counterparty,
  source: r.source, sourceReference: r.source_reference, note: r.note,
  attestedBy: r.attested_by_name, attestedAt: r.attested_at,
  withdrawn: r.withdrawn_at ? { by: r.withdrawn_by_name, at: r.withdrawn_at, reason: r.withdraw_reason } : null,
});

const SELECT = `
  SELECT r.*, to_char(r.period_start, 'YYYY-MM-DD') AS period_start, to_char(r.period_end, 'YYYY-MM-DD') AS period_end,
         a.name AS attested_by_name, w.name AS withdrawn_by_name
    FROM offline_record r
    JOIN app_user a ON a.id = r.attested_by
    LEFT JOIN app_user w ON w.id = r.withdrawn_by`;

export default async function offlineRecordRoutes(app) {
  app.get('/admin/offline-records', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const { rows } = await q(`${SELECT} ORDER BY (r.withdrawn_at IS NOT NULL), r.period_end DESC, r.attested_at DESC`);
    return {
      records: rows.map(view),
      metrics: METRICS,
      defaultSource: DEFAULT_SOURCE,
      /* Stated with every answer, so no screen can present these as ledger figures. */
      basis: 'Owner-attested figures from the offline books. Not part of the ledger, settlements or payouts.',
    };
  });

  app.post('/admin/offline-records', async (req) => {
    authorize(req.actor, 'offline_record.attest');
    assertRecentPasskey(req.actor, 'recording figures from the offline books');
    const r = parseRecord(req.body);
    const row = await one(
      `INSERT INTO offline_record (metric, value, period_start, period_end, counterparty, source, source_reference, note, attested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [r.metric, r.value, r.periodStart, r.periodEnd, r.counterparty, r.source, r.sourceReference, r.note, req.actor.id]);
    await audit(req, { action: 'offline_record.attest', resource: 'offline_record', resourceId: row.id, outcome: 'ok',
                       detail: { ...r } });
    return view(await one(`${SELECT} WHERE r.id = $1`, [row.id]));
  });

  app.post('/admin/offline-records/:id/withdraw', async (req) => {
    authorize(req.actor, 'offline_record.attest');
    assertRecentPasskey(req.actor, 'withdrawing a figure from the offline books');
    if (!UUID.test(req.params.id)) throw NotFound('No such record');
    const reason = optionalText(req.body?.reason, 500, 'The reason');
    if (!reason) throw BadRequest('Say why the record is withdrawn', 'The reason is kept with the record and in the audit log.');
    const before = await one(`SELECT id, withdrawn_at FROM offline_record WHERE id = $1`, [req.params.id]);
    if (!before) throw NotFound('No such record');
    if (before.withdrawn_at) throw Conflict('This record is already withdrawn');
    await q(`UPDATE offline_record SET withdrawn_by = $2, withdrawn_at = now(), withdraw_reason = $3 WHERE id = $1`,
            [req.params.id, req.actor.id, reason]);
    await audit(req, { action: 'offline_record.withdraw', resource: 'offline_record', resourceId: req.params.id, outcome: 'ok',
                       detail: { reason } });
    return view(await one(`${SELECT} WHERE r.id = $1`, [req.params.id]));
  });
}
