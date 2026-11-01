/* ==========================================================================
   ECHO ECHO - APPROVAL QUEUE

     GET  /admin/approvals              the queue, for the owner and requesters
     GET  /admin/approvals/policy       which actions queue
     PUT  /admin/approvals/policy/:type owner only, fresh authentication
     POST /admin/approvals/:id/decide   owner only, fresh authentication
   ========================================================================== */
import { Forbidden, Unauthenticated, BadRequest, isPlatformRole } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { q, tx } from '../db/index.js';
import { auditTx } from '../audit.js';
import { HANDLERS, decideApproval, listApprovals } from '../services/approvals.js';

const assertAdmin = (actor) => {
  if (!actor) throw Unauthenticated('Sign in required');
  if (!actor.roles?.some(isPlatformRole)) throw Forbidden('Campus Control only');
};
const assertOwner = (actor) => {
  assertAdmin(actor);
  if (!actor.isOwner) throw Forbidden('Only the platform owner can do this');
};

export default async function approvalRoutes(app) {
  app.get('/admin/approvals', async (req) => {
    assertAdmin(req.actor);
    const rows = await listApprovals({ status: req.query?.status });
    /* An administrator sees their own requests; only the owner sees the queue. */
    const visible = req.actor.isOwner ? rows : rows.filter((r) => r.requested_by === req.actor.id);
    return { requests: visible, canDecide: !!req.actor.isOwner };
  });

  app.get('/admin/approvals/policy', async (req) => {
    assertOwner(req.actor);
    const { rows } = await q(`SELECT action_type, enabled, expiry_hours, updated_at FROM approval_policy ORDER BY action_type`);
    return { policies: rows.map((p) => ({ ...p, label: HANDLERS[p.action_type]?.label || p.action_type })) };
  });

  app.put('/admin/approvals/policy/:type', async (req) => {
    assertOwner(req.actor);
    assertRecentPasskey(req.actor, 'changing an approval policy');
    if (!HANDLERS[req.params.type]) throw BadRequest('That action has no approval handler');
    const enabled = !!req.body?.enabled;
    const hours = Number(req.body?.expiryHours ?? 24);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw BadRequest('Expiry must be between 1 and 168 hours');
    await tx(async (c) => {
      await c.query(
        `INSERT INTO approval_policy (action_type, enabled, expiry_hours, updated_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (action_type) DO UPDATE SET enabled = $2, expiry_hours = $3, updated_by = $4, updated_at = now()`,
        [req.params.type, enabled, hours, req.actor.id]);
      await auditTx(c, req, { action: 'approval.policy', resource: 'approval_policy', resourceId: req.params.type, detail: { enabled, expiryHours: hours } });
    });
    return { actionType: req.params.type, enabled, expiryHours: hours };
  });

  app.post('/admin/approvals/:id/decide', async (req) => {
    assertOwner(req.actor);
    assertRecentPasskey(req.actor, 'deciding an approval request');
    const d = req.body?.decision;
    if (d !== 'approve' && d !== 'reject') throw BadRequest('Decision must be approve or reject');
    return decideApproval(req, req.params.id, { approve: d === 'approve', note: req.body?.note });
  });
}
