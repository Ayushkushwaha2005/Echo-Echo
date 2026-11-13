/* ==========================================================================
   ECHO ECHO - APPROVALS FOR HIGH-RISK, NON-PAYMENT ACTIONS

   A request freezes a payload and its hash. Only an action type listed in
   HANDLERS can exist, each with a fixed handler that re-checks current state
   and then does the work on the decider's transaction, so a decision and its
   outcome commit together or not at all.

   Payment and finance actions are deliberately not here while payments are
   frozen. See docs/ADMIN-ACCESS.md for what adding them later involves.

   With one owner there is no second person. The owner's own action runs
   directly after fresh authentication and is audited; the queue only holds
   what another administrator asks for. Independent second-person approval of
   the owner needs another owner-grade administrator, and that does not exist.
   ========================================================================== */
import { createHash, randomUUID } from 'node:crypto';
import { q, one, tx } from '../db/index.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../auth/rbac.js';
import { auditTx } from '../audit.js';

const hashOf = (payload) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

/* Each handler receives the transaction, re-checks the world as it is now and
   throws to refuse. Nothing else can execute. */
export const HANDLERS = {
  'vendor.archive': {
    label: 'Archive a café',
    async run(c, { vendorId }, actorId) {
      const v = (await c.query(`SELECT id, name, active FROM vendor WHERE id = $1 FOR UPDATE`, [vendorId])).rows[0];
      if (!v) throw Conflict('That café no longer exists');
      if (!v.active) throw Conflict('That café is already archived');
      const open = (await c.query(
        `SELECT count(*)::int n FROM food_order WHERE vendor_id = $1
          AND state NOT IN ('delivered','collected','cancelled','refunded','failed','expired')`, [vendorId])).rows[0].n;
      if (open) throw Conflict(`That café has ${open} order${open === 1 ? '' : 's'} still open`);
      await c.query(`SELECT set_config('app.actor_id', $1, true)`, [actorId]);
      await c.query(`UPDATE vendor SET active = false, is_open = false WHERE id = $1`, [vendorId]);
      return { vendorId, name: v.name };
    },
  },
};

export const policyOf = (actionType) => one(`SELECT * FROM approval_policy WHERE action_type = $1`, [actionType]);

/* The owner acts directly. Everyone else queues, if the owner turned it on. */
export async function needsApproval(actor, actionType) {
  if (actor?.isOwner) return false;
  const p = await policyOf(actionType);
  return !!p?.enabled;
}

export async function requestApproval(req, { actionType, payload, summary, reason, idempotencyKey }) {
  if (!HANDLERS[actionType]) throw BadRequest('That action cannot be requested');
  const why = String(reason ?? '').trim().slice(0, 500);
  if (why.length < 5) throw BadRequest('Record a reason', 'The person deciding reads it.');
  const key = String(idempotencyKey || randomUUID()).slice(0, 100);
  return tx(async (c) => {
    const p = (await c.query(`SELECT expiry_hours FROM approval_policy WHERE action_type = $1`, [actionType])).rows[0];
    if (!p) throw BadRequest('That action has no approval policy');
    const dup = (await c.query(`SELECT * FROM approval_request WHERE idempotency_key = $1`, [key])).rows[0];
    if (dup) {
      if (dup.requested_by !== req.actor.id || dup.payload_hash !== hashOf(payload)) throw Conflict('That request key was already used for something else');
      return { ...dup, duplicate: true };
    }
    const row = (await c.query(
      `INSERT INTO approval_request (action_type, payload, payload_hash, summary, reason, idempotency_key, requested_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' hours')::interval) RETURNING *`,
      [actionType, payload, hashOf(payload), summary, why, key, req.actor.id, String(p.expiry_hours)])).rows[0];
    await auditTx(c, req, { action: 'approval.request', resource: 'approval_request', resourceId: row.id, detail: { actionType, summary, reason: why } });
    return row;
  });
}

export async function listApprovals({ status } = {}) {
  await expireStale();
  const { rows } = await q(
    `SELECT a.id, a.action_type, a.summary, a.reason, a.status, a.requested_at, a.expires_at, a.decided_at, a.decision_note,
            a.executed_at, a.result, a.requested_by, COALESCE((SELECT ap.display_name FROM admin_profile ap WHERE ap.user_id = r.id), r.name) AS requested_by_name, COALESCE((SELECT ap.display_name FROM admin_profile ap WHERE ap.user_id = d.id), d.name) AS decided_by_name
       FROM approval_request a JOIN app_user r ON r.id = a.requested_by LEFT JOIN app_user d ON d.id = a.decided_by
      WHERE ($1::text IS NULL OR a.status = $1) ORDER BY a.requested_at DESC LIMIT 100`, [status || null]);
  return rows;
}

export async function expireStale() {
  const { rows } = await q(`UPDATE approval_request SET status = 'expired' WHERE status = 'pending' AND expires_at <= now() RETURNING id`);
  return rows.length;
}

/* approve or reject. The row lock plus the pending check is what makes a
   second, simultaneous decision a refusal instead of a second execution. */
export async function decideApproval(req, id, { approve, note }) {
  const r = await tx(async (c) => {
    const a = (await c.query(`SELECT * FROM approval_request WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!a) throw NotFound('No such request');
    if (a.status !== 'pending') throw Conflict(`This request is already ${a.status}`);
    if (a.requested_by === req.actor.id) throw Forbidden('You cannot decide your own request');
    if (new Date(a.expires_at) <= new Date()) {
      await c.query(`UPDATE approval_request SET status = 'expired' WHERE id = $1`, [id]);
      await auditTx(c, req, { action: 'approval.expired', resource: 'approval_request', resourceId: id });
      return { error: Conflict('This request has expired', 'Nothing was done.') };
    }
    if (hashOf(a.payload) !== a.payload_hash) throw Conflict('This request does not match its recorded hash', 'Nothing was done.');
    const decisionNote = String(note ?? '').trim().slice(0, 500) || null;
    if (!approve) {
      const row = (await c.query(
        `UPDATE approval_request SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1 RETURNING *`,
        [id, req.actor.id, decisionNote])).rows[0];
      await auditTx(c, req, { action: 'approval.reject', resource: 'approval_request', resourceId: id, detail: { actionType: a.action_type } });
      return { row };
    }
    const handler = HANDLERS[a.action_type];
    if (!handler) throw Conflict('This kind of request can no longer be carried out');
    let result;
    let status = 'executed';
    await c.query('SAVEPOINT approval_run');
    try {
      result = await handler.run(c, a.payload, req.actor.id);
      await c.query('RELEASE SAVEPOINT approval_run');
    } catch (e) {
      /* A failed precondition is recorded; the handler's partial work is not kept. */
      await c.query('ROLLBACK TO SAVEPOINT approval_run');
      if (!e.status) throw e;
      status = 'failed';
      result = { message: e.message };
    }
    const row = (await c.query(
      `UPDATE approval_request SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
              executed_at = CASE WHEN $2 = 'executed' THEN now() END, result = $5 WHERE id = $1 RETURNING *`,
      [id, status, req.actor.id, decisionNote, result])).rows[0];
    await auditTx(c, req, { action: 'approval.approve', resource: 'approval_request', resourceId: id, outcome: status === 'executed' ? 'ok' : 'error',
                            detail: { actionType: a.action_type, status, result } });
    return { row };
  });
  if (r.error) throw r.error;
  return r.row;
}
