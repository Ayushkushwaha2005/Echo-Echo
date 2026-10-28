/* ==========================================================================
   ECHO ECHO — CAMPUS CONTROL: OPERATIONS API

   The read side Campus Control needs to run the platform day to day:

     GET /admin/orders              paged, filtered order history
     GET /admin/orders/:id/timeline state changes, payments, refunds,
                                    webhooks and audit for one order
     GET /admin/payments            gateway payments with provider references
     GET /admin/webhooks            what the gateway and payouts sent, and
                                    what was refused (signature, freshness)
     GET /admin/reliability         readiness, ledger invariants, stale or
                                    failed money movement, failed jobs
     GET /admin/reports/:kind       CSV exports, permission-checked, audited

   Every figure is computed here, from the ledger and the tables that record
   money movement; the browser only formats it. Every route checks its own
   permission: hiding a button in Campus Control is a courtesy, not security.
   Nothing here returns a webhook payload, a full account number, a secret or
   a session; personal data is limited to what orders.view already shows.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { authorize, can, BadRequest, NotFound } from '../auth/rbac.js';
import { audit } from '../audit.js';
import { webhookHealth } from '../services/reconciliation.js';

const ORDER_STATES = ['draft', 'awaiting_payment', 'confirmed', 'preparing', 'ready',
  'assigned', 'picked_up', 'delivered', 'cancelled', 'refunded'];
const PAYMENT_STATES = ['created', 'pending', 'paid', 'failed', 'cancelled', 'refunded'];

/* A payout still 'processing' after this long has not been resolved by the
   status sync or the payouts webhook and needs a person. */
export const STALE_PAYOUT_HOURS = 2;

/** Page and size from a query string, bounded. */
export function paging(query, { max = 100, def = 25 } = {}) {
  const page = Math.max(1, Math.min(10_000, Number.parseInt(query?.page, 10) || 1));
  const pageSize = Math.max(1, Math.min(max, Number.parseInt(query?.pageSize, 10) || def));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** An ISO date (or datetime) from a query string, or null; 400 if malformed. */
function dateParam(v, name) {
  if (v === undefined || v === null || v === '') return null;
  const raw = String(v);
  /* A bare date is a day in India (the business's clock), not UTC: an order
     at 00:30 IST on the 1st belongs to the 1st. */
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+05:30` : raw);
  if (Number.isNaN(d.getTime())) throw BadRequest(`${name} must be a date (YYYY-MM-DD)`);
  return d;
}

function oneOf(v, allowed, name) {
  if (v === undefined || v === null || v === '') return null;
  if (!allowed.includes(v)) throw BadRequest(`${name} must be one of ${allowed.join(', ')}`);
  return v;
}

/* ---------- CSV ------------------------------------------------------------
   RFC 4180 quoting, CRLF rows. A cell starting with = + - @ (or a tab / CR)
   is prefixed with an apostrophe so a spreadsheet never runs it as a
   formula (CSV injection) — the export is opened by people, in Excel.      */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function toCsv(columns, rows) {
  return [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}
const rupeesText = (paise) => (paise === null || paise === undefined ? '' : (Number(paise) / 100).toFixed(2));

/* ---------- filters shared by the order list and the order report --------- */
function orderFilter(query) {
  const where = []; const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  const term = String(query?.q || '').trim().slice(0, 60);
  if (term) {
    params.push(`%${term}%`);
    const n = params.length;
    where.push(`(o.code ILIKE $${n} OR u.name ILIKE $${n} OR u.phone ILIKE $${n} OR v.name ILIKE $${n})`);
  }
  /* One state, or several separated by commas (Cancelled = cancelled and
     refunded). Every one is checked against the known states. */
  const states = String(query?.state || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const s of states) oneOf(s, ORDER_STATES, 'state');
  if (states.length === 1) add('o.state = ?', states[0]);
  else if (states.length > 1) add('o.state::text = ANY(?::text[])', states);
  const fulfilment = oneOf(query?.fulfilment, ['pickup', 'delivery'], 'fulfilment');
  if (fulfilment) add('o.fulfilment = ?', fulfilment);
  const payment = oneOf(query?.payment, PAYMENT_STATES, 'payment');
  if (payment) add('p.status = ?', payment);
  if (query?.vendorId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(query.vendorId))) throw BadRequest('vendorId must be a café id');
    add('o.vendor_id = ?::uuid', String(query.vendorId));
  }
  const from = dateParam(query?.from, 'from');
  if (from) add('o.created_at >= ?', from);
  const to = dateParam(query?.to, 'to');
  /* `to` is inclusive of the whole day when given as a date. */
  if (to) add(`o.created_at < ? `, /^\d{4}-\d{2}-\d{2}$/.test(String(query.to)) ? new Date(to.getTime() + 86400000) : to);
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/* The latest payment attempt per order: an order retried after a failed
   attempt has several, and the newest one is its payment state. */
const ORDER_FROM = `
  FROM food_order o
  JOIN vendor v ON v.id = o.vendor_id
  JOIN app_user u ON u.id = o.customer_id
  LEFT JOIN LATERAL (SELECT * FROM payment x WHERE x.order_id = o.id ORDER BY x.created_at DESC LIMIT 1) p ON true
  LEFT JOIN order_financials f ON f.order_id = o.id`;

export default async function adminOpsRoutes(app) {
  /* ======================= orders ======================================= */
  app.get('/admin/orders', async (req) => {
    authorize(req.actor, 'order.read_all');
    const { page, pageSize, offset } = paging(req.query);
    const f = orderFilter(req.query);
    const total = (await one(`SELECT count(*)::int AS n ${ORDER_FROM} ${f.sql}`, f.params)).n;
    const { rows } = await q(
      `SELECT o.id, o.code, o.state, o.fulfilment, o.subtotal_paise, o.delivery_paise, o.total_paise,
              o.created_at, o.confirmed_at, o.delivered_at, o.placed_via,
              v.id AS vendor_id, v.name AS vendor_name, u.name AS customer_name,
              p.status AS payment_status, p.provider AS payment_provider,
              f.platform_fee_paise,
              (SELECT count(*)::int FROM order_item oi WHERE oi.order_id = o.id) AS item_count,
              (o.partner_id IS NOT NULL) AS has_partner,
              (SELECT pu.name FROM app_user pu WHERE pu.id = o.partner_id) AS partner_name
         ${ORDER_FROM} ${f.sql}
        ORDER BY o.created_at DESC
        LIMIT ${pageSize} OFFSET ${offset}`, f.params);
    /* Who is carrying an order is partner data: named only to an
       administrator who may see partner profiles. */
    const partners = can(req.actor, 'partner.read');
    return { orders: rows.map((r) => (partners ? r : { ...r, partner_name: null })), total, page, pageSize };
  });

  /* ---------- order summary: the figures and the Graph View ------------
     Over a date range (India time, inclusive): how many orders were placed,
     how they split between delivery and pickup, how many completed or were
     cancelled, and the value of sales, plus the same per day (or per month
     for a range over 62 days) for the chart.

     "Placed" means the payment was confirmed: the order reached confirmed
     or a later state. Drafts and orders still awaiting payment were never
     orders. "Sales" is what customers paid for placed orders that were not
     cancelled or refunded. Every figure is computed here from food_order. */
  app.get('/admin/orders/summary', async (req) => {
    authorize(req.actor, 'order.read_all');
    const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    const toDay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.to || '')) ? String(req.query.to) : today;
    const fromDefault = new Date(Date.parse(`${toDay}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
    const fromDay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.from || '')) ? String(req.query.from) : fromDefault;
    const from = dateParam(fromDay, 'from');
    const to = new Date(dateParam(toDay, 'to').getTime() + 86400000);
    if (!(from < to)) throw BadRequest('from must be on or before to');
    const days = Math.round((to - from) / 86400000);
    if (days > 731) throw BadRequest('The range can be at most two years');
    const bucket = days > 62 ? 'month' : 'day';
    const PLACED = `o.state NOT IN ('draft','awaiting_payment')`;
    const SOLD = `o.state NOT IN ('draft','awaiting_payment','cancelled','refunded')`;
    const t = await one(
      `SELECT count(*) FILTER (WHERE ${PLACED})::int AS orders,
              count(*) FILTER (WHERE ${PLACED} AND o.fulfilment = 'delivery')::int AS delivery,
              count(*) FILTER (WHERE ${PLACED} AND o.fulfilment = 'pickup')::int AS pickup,
              count(*) FILTER (WHERE o.state = 'delivered')::int AS completed,
              count(*) FILTER (WHERE ${PLACED} AND o.state IN ('cancelled','refunded'))::int AS cancelled,
              COALESCE(sum(o.total_paise) FILTER (WHERE ${SOLD}), 0)::bigint AS sales_paise
         FROM food_order o WHERE o.created_at >= $1 AND o.created_at < $2`, [from, to]);
    const { rows } = await q(
      `WITH b AS (
         SELECT generate_series(date_trunc('${bucket}', $1::timestamptz AT TIME ZONE 'Asia/Kolkata'),
                                date_trunc('${bucket}', ($2::timestamptz - interval '1 second') AT TIME ZONE 'Asia/Kolkata'),
                                interval '1 ${bucket}') AS at)
       SELECT to_char(b.at, 'YYYY-MM-DD') AS at,
              count(o.id) FILTER (WHERE ${PLACED})::int AS orders,
              COALESCE(sum(o.total_paise) FILTER (WHERE ${SOLD}), 0)::bigint AS sales_paise
         FROM b LEFT JOIN food_order o
           ON date_trunc('${bucket}', o.created_at AT TIME ZONE 'Asia/Kolkata') = b.at
          AND o.created_at >= $1 AND o.created_at < $2
        GROUP BY b.at ORDER BY b.at`, [from, to]);
    const sales = Number(t.sales_paise);
    const sold = t.orders - t.cancelled;
    return {
      from: fromDay, to: toDay, bucket,
      totals: { ...t, sales_paise: sales, average_paise: sold > 0 ? Math.round(sales / sold) : 0 },
      series: rows.map((r) => ({ at: r.at, orders: r.orders, salesPaise: Number(r.sales_paise) })),
    };
  });

  app.get('/admin/orders/:id/timeline', async (req) => {
    authorize(req.actor, 'order.read_all');
    const o = await one(`SELECT o.id, o.code, o.state, o.fulfilment, o.total_paise, o.created_at, v.name AS vendor_name,
                                cu.name AS customer_name, pu.name AS partner_name
                           FROM food_order o JOIN vendor v ON v.id = o.vendor_id
                           JOIN app_user cu ON cu.id = o.customer_id
                           LEFT JOIN app_user pu ON pu.id = o.partner_id WHERE o.id = $1::uuid`,
                        [req.params.id]).catch(() => null);
    if (!o) throw NotFound('No such order');
    /* Partner data only for someone who may see partner profiles. */
    if (!can(req.actor, 'partner.read')) o.partner_name = null;
    const [events, payments, refunds, webhooks, auditRows, financials] = await Promise.all([
      q(`SELECT e.from_state, e.to_state, e.actor_role, e.note, e.at FROM order_event e
          WHERE e.order_id = $1 ORDER BY e.at, e.id`, [o.id]),
      q(`SELECT id, provider, provider_order_id, provider_payment_id, amount_paise, status,
                created_at, settled_at, reconciled_at, settlement_id, flagged_reason
           FROM payment WHERE order_id = $1 ORDER BY created_at`, [o.id]),
      q(`SELECT id, amount_paise, reason, state, provider_refund_id, created_at, settled_at
           FROM refund WHERE order_id = $1 ORDER BY created_at`, [o.id]),
      /* Matched on the provider order id the payload names; the payload
         itself is not returned. */
      q(`SELECT w.event_type, w.event_id, w.received_at, w.duplicate_count
           FROM payment_webhook w
          WHERE w.payload #>> '{data,order,order_id}' IN (SELECT provider_order_id FROM payment WHERE order_id = $1)
          ORDER BY w.received_at`, [o.id]),
      q(`SELECT a.at, a.action, a.outcome, a.actor_role FROM audit_log a
          WHERE a.resource_id = $1::text ORDER BY a.at LIMIT 200`, [o.id]),
      one(`SELECT * FROM order_financials WHERE order_id = $1`, [o.id]),
    ]);
    /* One stream, oldest first, so a person reads what happened in order. */
    const timeline = [
      ...events.rows.map((e) => ({ at: e.at, kind: 'state', label: `${e.from_state || 'new'} → ${e.to_state}`, by: e.actor_role, note: e.note })),
      ...payments.rows.map((p) => ({ at: p.created_at, kind: 'payment', label: `payment ${p.status}`, ref: p.provider_payment_id || p.provider_order_id, amountPaise: p.amount_paise })),
      ...refunds.rows.map((r) => ({ at: r.created_at, kind: 'refund', label: `refund ${r.state}`, ref: r.provider_refund_id, amountPaise: r.amount_paise, note: r.reason })),
      ...webhooks.rows.map((w) => ({ at: w.received_at, kind: 'webhook', label: w.event_type || 'webhook', ref: w.event_id, duplicates: w.duplicate_count })),
      ...auditRows.rows.map((a) => ({ at: a.at, kind: 'audit', label: a.action, outcome: a.outcome, by: a.actor_role })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));
    return { order: o, financials, payments: payments.rows, refunds: refunds.rows, timeline };
  });

  /* ======================= payments and webhooks ======================== */
  app.get('/admin/payments', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const { page, pageSize, offset } = paging(req.query);
    const params = []; const where = [];
    const status = oneOf(req.query?.status, PAYMENT_STATES, 'status');
    if (status) { params.push(status); where.push(`p.status = $${params.length}`); }
    const term = String(req.query?.q || '').trim().slice(0, 80);
    if (term) {
      params.push(`%${term}%`);
      where.push(`(o.code ILIKE $${params.length} OR p.provider_order_id ILIKE $${params.length} OR p.provider_payment_id ILIKE $${params.length})`);
    }
    if (req.query?.unreconciled === 'true') where.push(`p.status = 'paid' AND p.reconciled_at IS NULL`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await one(`SELECT count(*)::int AS n FROM payment p JOIN food_order o ON o.id = p.order_id ${w}`, params)).n;
    const { rows } = await q(
      `SELECT p.id, p.provider, p.provider_order_id, p.provider_payment_id, p.amount_paise, p.status,
              p.created_at, p.settled_at, p.reconciled_at, p.settlement_id, p.flagged_reason,
              o.id AS order_id, o.code AS order_code, o.state AS order_state,
              (SELECT COALESCE(sum(r.amount_paise),0)::int FROM refund r WHERE r.payment_id = p.id AND r.state <> 'failed') AS refunded_paise
         FROM payment p JOIN food_order o ON o.id = p.order_id ${w}
        ORDER BY p.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
    return { payments: rows, total, page, pageSize };
  });

  app.get('/admin/webhooks', async (req) => {
    authorize(req.actor, 'finance.read_all');
    const days = Math.max(1, Math.min(90, Number.parseInt(req.query?.days, 10) || 7));
    const [payments, payouts, refused, health] = await Promise.all([
      q(`SELECT provider, event_type, event_id, received_at, duplicate_count FROM payment_webhook
          WHERE received_at > now() - ($1 || ' days')::interval ORDER BY received_at DESC LIMIT 200`, [String(days)]),
      q(`SELECT provider, payload->>'type' AS event_type, event_id, received_at, duplicate_count FROM payout_webhook
          WHERE received_at > now() - ($1 || ' days')::interval ORDER BY received_at DESC LIMIT 200`, [String(days)]),
      /* Refused deliveries: bad signature, stale timestamp. The reason only. */
      q(`SELECT at, action, detail->>'reason' AS reason FROM audit_log
          WHERE action IN ('payment.webhook', 'payout.webhook') AND outcome = 'denied'
            AND at > now() - ($1 || ' days')::interval ORDER BY at DESC LIMIT 200`, [String(days)]),
      webhookHealth(),
    ]);
    return { days, payments: payments.rows, payouts: payouts.rows, refused: refused.rows, health };
  });

  /* ======================= reliability ================================== */
  app.get('/admin/reliability', async (req) => {
    authorize(req.actor, 'platform.read');
    const canMoney = (() => { try { authorize(req.actor, 'finance.read_all'); return true; } catch { return false; } })();
    const { health, migrationState } = await import('../db/index.js');
    const { readdir } = await import('node:fs/promises');
    const db = await health();
    const shipped = (await readdir(new URL('../db/', import.meta.url))).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
    const state = db.ok ? await migrationState() : { applied: [] };
    const pending = shipped.filter((f) => !(state.applied || []).includes(f));

    const n = async (sql, p = []) => Number((await one(sql, p))?.n || 0);
    const checks = [];
    const check = (id, label, ok, detail, action, severity = 'error') =>
      checks.push({ id, label, ok, severity: ok ? 'ok' : severity, detail, action: ok ? null : action });

    check('database', 'Database answers', db.ok, db.ok ? `${db.latencyMs} ms` : 'unreachable',
      'Check the Neon project status and DATABASE_URL on Render.');
    check('migrations', 'Every shipped migration is applied', pending.length === 0,
      pending.length ? `pending: ${pending.join(', ')}` : `${state.count || 0} applied`,
      'Apply with owner approval after a snapshot (docs/RUNBOOK.md, Migrations).');

    if (db.ok) {
      /* Ledger invariants: every transaction balances, so the whole book does. */
      const unbalanced = await n(`SELECT count(*)::int AS n FROM (
          SELECT txn_id FROM ledger_entry GROUP BY txn_id HAVING sum(amount_paise) <> 0) x`);
      const bookSum = await n(`SELECT COALESCE(sum(amount_paise),0)::bigint AS n FROM ledger_entry`);
      check('ledger', 'Ledger balances (every transaction sums to zero)', unbalanced === 0 && bookSum === 0,
        `${unbalanced} unbalanced transaction(s); book sums to ${bookSum} paise`,
        'Stop settlement and investigate: the ledger is append-only, so a correcting adjustment is the only fix.');

      const failedPayments = await n(`SELECT count(*)::int AS n FROM payment WHERE status = 'failed' AND created_at > now() - interval '24 hours'`);
      check('failed_payments', 'Failed payments in the last 24 h', failedPayments === 0, `${failedPayments}`,
        'Usually a customer abandoning checkout. Many in a row suggests a gateway problem: check Cashfree status.', 'warn');

      const flagged = await n(`SELECT count(*)::int AS n FROM payment WHERE flagged_reason IS NOT NULL AND status <> 'paid'`);
      check('flagged_payments', 'Payments flagged for review', flagged === 0, `${flagged}`,
        'Open Payments and review each flagged payment against Cashfree.');

      const refused = await n(`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('payment.webhook','payout.webhook')
                                 AND outcome = 'denied' AND at > now() - interval '24 hours'`);
      check('webhook_refusals', 'Webhooks refused in the last 24 h', refused === 0, `${refused}`,
        'A refused webhook means a bad signature or a stale timestamp: check the webhook secret and server clock. Payments are still confirmed by the status pull.', 'warn');

      const stale = await n(`SELECT count(*)::int AS n FROM payout WHERE state = 'processing'
                               AND created_at < now() - ($1 || ' hours')::interval`, [String(STALE_PAYOUT_HOURS)]);
      check('stale_payouts', `Payouts processing for more than ${STALE_PAYOUT_HOURS} h`, stale === 0, `${stale}`,
        'Run "Sync payouts" in Finance. Never re-send: the status sync resolves the original transfer.');

      const failedPayouts = await n(`SELECT count(*)::int AS n FROM payout p WHERE p.state = 'failed'
                                       AND NOT EXISTS (SELECT 1 FROM payout r WHERE r.retry_of = p.id)`);
      check('failed_payouts', 'Failed payouts not yet retried', failedPayouts === 0, `${failedPayouts}`,
        'Ask the payee to correct their details, then retry (a retry is a new transfer id).', 'warn');

      const stuckRefunds = await n(`SELECT count(*)::int AS n FROM refund WHERE state IN ('requested','processing')
                                      AND created_at < now() - interval '72 hours'`);
      check('stuck_refunds', 'Refunds unresolved after 72 h', stuckRefunds === 0, `${stuckRefunds}`,
        'Check the refund in the Cashfree dashboard; the reconciliation job raises refund_stuck.');

      const blocking = await n(`SELECT count(*)::int AS n FROM reconciliation_exception WHERE state = 'open' AND severity = 'blocking'`);
      check('reconciliation', 'Open blocking reconciliation differences', blocking === 0, `${blocking}`,
        'Resolve each in Finance → Gateway reconciliation, with a note.');

      const lastImport = await one(`SELECT state, started_at, finished_at FROM provider_settlement_import ORDER BY started_at DESC LIMIT 1`);
      const importStale = lastImport && lastImport.state === 'running' && new Date(lastImport.started_at) < new Date(Date.now() - 3600_000);
      check('settlement_import', 'Last settlement import finished', !lastImport || (lastImport.state !== 'failed' && !importStale),
        lastImport ? `${lastImport.state} at ${new Date(lastImport.finished_at || lastImport.started_at).toISOString()}` : 'never run (no captured payments yet)',
        'Re-run "Import settlements" in Finance; a failed import changes nothing and is safe to repeat.', 'warn');

      const failedNotes = await n(`SELECT count(*)::int AS n FROM notification WHERE state = 'failed' AND created_at > now() - interval '24 hours'`);
      check('notifications', 'Notifications that failed to send (24 h)', failedNotes === 0, `${failedNotes}`,
        'Check the email provider (Brevo) status and sender settings.', 'warn');
    }

    const recentBatches = db.ok && canMoney
      ? (await q(`SELECT kind, period_key, state, created_at FROM payout_batch ORDER BY created_at DESC LIMIT 6`)).rows : [];
    const failing = checks.filter((c) => !c.ok);
    return {
      ok: failing.every((c) => c.severity !== 'error'),
      summary: { checks: checks.length, errors: failing.filter((c) => c.severity === 'error').length,
                 warnings: failing.filter((c) => c.severity === 'warn').length },
      commit: process.env.RENDER_GIT_COMMIT || null,
      checks, recentBatches,
      webhooks: db.ok ? await webhookHealth() : null,
    };
  });

  /* ======================= reports ====================================== */
  const REPORTS = {
    orders: {
      cap: 'order.read_all',
      columns: ['code', 'created_at', 'cafe', 'fulfilment', 'state', 'payment_status',
                'subtotal_inr', 'delivery_fee_inr', 'platform_fee_inr', 'total_inr'],
      async rows(query, from, to) {
        const f = orderFilter({ ...query, from: from.toISOString(), to: to.toISOString() });
        return (await q(`SELECT o.code, o.created_at, v.name AS cafe, o.fulfilment, o.state, p.status AS payment_status,
                                o.subtotal_paise, o.delivery_paise, f.platform_fee_paise, o.total_paise
                           ${ORDER_FROM} ${f.sql} ORDER BY o.created_at LIMIT 50000`, f.params)).rows
          .map((r) => ({ ...r, subtotal_inr: rupeesText(r.subtotal_paise), delivery_fee_inr: rupeesText(r.delivery_paise),
                         platform_fee_inr: rupeesText(r.platform_fee_paise), total_inr: rupeesText(r.total_paise) }));
      },
    },
    payments: {
      cap: 'finance.read_all',
      columns: ['order_code', 'created_at', 'provider', 'provider_order_id', 'provider_payment_id',
                'status', 'amount_inr', 'refunded_inr', 'settlement_id', 'reconciled_at'],
      async rows(_q, from, to) {
        return (await q(`SELECT o.code AS order_code, p.created_at, p.provider, p.provider_order_id, p.provider_payment_id,
                                p.status, p.amount_paise, p.settlement_id, p.reconciled_at,
                                (SELECT COALESCE(sum(r.amount_paise),0) FROM refund r WHERE r.payment_id = p.id AND r.state <> 'failed') AS refunded_paise
                           FROM payment p JOIN food_order o ON o.id = p.order_id
                          WHERE p.created_at >= $1 AND p.created_at < $2 ORDER BY p.created_at LIMIT 50000`, [from, to])).rows
          .map((r) => ({ ...r, amount_inr: rupeesText(r.amount_paise), refunded_inr: rupeesText(r.refunded_paise) }));
      },
    },
    payouts: {
      cap: 'finance.read_all',
      columns: ['created_at', 'payee_kind', 'payee', 'amount_inr', 'state', 'method', 'destination',
                'provider_payout_id', 'utr_or_reference', 'paid_at', 'failure_reason'],
      async rows(_q, from, to) {
        /* The destination is the MASKED hint; the full number is not held. */
        return (await q(`SELECT p.created_at, CASE WHEN p.vendor_id IS NOT NULL THEN 'cafe' ELSE 'partner' END AS payee_kind,
                                COALESCE(v.name, u.name) AS payee, p.amount_paise, p.state, p.method, d.masked AS destination,
                                p.provider_payout_id, p.external_reference AS utr_or_reference, p.paid_at, p.failure_reason
                           FROM payout p LEFT JOIN vendor v ON v.id = p.vendor_id LEFT JOIN app_user u ON u.id = p.partner_id
                           LEFT JOIN payout_destination d ON d.id = p.destination_id
                          WHERE p.created_at >= $1 AND p.created_at < $2 ORDER BY p.created_at LIMIT 50000`, [from, to])).rows
          .map((r) => ({ ...r, amount_inr: rupeesText(r.amount_paise) }));
      },
    },
    ledger: {
      cap: 'finance.read_all',
      columns: ['created_at', 'txn_kind', 'txn_ref', 'order_code', 'account', 'party', 'debit_inr', 'credit_inr', 'memo'],
      async rows(_q, from, to) {
        return (await q(`SELECT e.created_at, t.kind AS txn_kind, t.ref AS txn_ref, o.code AS order_code, a.kind AS account,
                                COALESCE(v.name, u.name) AS party, e.amount_paise, e.memo
                           FROM ledger_entry e JOIN ledger_txn t ON t.id = e.txn_id JOIN ledger_account a ON a.id = e.account_id
                           LEFT JOIN food_order o ON o.id = e.order_id LEFT JOIN vendor v ON v.id = a.vendor_id
                           LEFT JOIN app_user u ON u.id = a.partner_id
                          WHERE e.created_at >= $1 AND e.created_at < $2 ORDER BY e.created_at, e.id LIMIT 200000`, [from, to])).rows
          .map((r) => ({ ...r, debit_inr: r.amount_paise > 0 ? rupeesText(r.amount_paise) : '',
                         credit_inr: r.amount_paise < 0 ? rupeesText(-r.amount_paise) : '' }));
      },
    },
  };

  app.get('/admin/reports/:kind', async (req, reply) => {
    const spec = REPORTS[req.params.kind];
    if (!spec) throw NotFound(`No report "${req.params.kind}". Reports: ${Object.keys(REPORTS).join(', ')}`);
    authorize(req.actor, spec.cap);
    const from = dateParam(req.query?.from, 'from');
    const toRaw = dateParam(req.query?.to, 'to');
    if (!from || !toRaw) throw BadRequest('from and to are required (YYYY-MM-DD)');
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to)) ? new Date(toRaw.getTime() + 86400000) : toRaw;
    if (to <= from) throw BadRequest('to must be on or after from');
    if (to - from > 366 * 86400000) throw BadRequest('A report covers at most 366 days');
    const rows = await spec.rows(req.query, from, to);
    /* An export of financial or personal data is itself an auditable act. */
    await audit(req, { action: 'report.export', resource: 'report', resourceId: req.params.kind, outcome: 'ok',
                       detail: { from: from.toISOString(), to: to.toISOString(), rows: rows.length } });
    /* Built from the parsed dates, never from the raw query text. */
    const day = (raw, d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? String(raw) : d.toISOString().slice(0, 10));
    const name = `echoecho-${req.params.kind}-${day(req.query.from, from)}-to-${day(req.query.to, toRaw)}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .send('﻿' + toCsv(spec.columns, rows));
  });
}
