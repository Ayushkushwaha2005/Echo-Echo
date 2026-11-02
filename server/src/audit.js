/* Every sensitive action lands here: who, what, when, resource, result.
   Denials are recorded too — an audit log that only shows successes tells
   you nothing about who is probing. */
import { pool, atomicStore } from './db/index.js';

export async function audit(req, { action, resource, resourceId, outcome, detail }) {
  const a = req?.actor;
  const row = [a?.id || null, a?.roles?.[0] || null, action, resource || null,
    resourceId ? String(resourceId) : null, outcome,
    detail ? JSON.stringify(detail) : null, req?.ip || null];
  const sql = `INSERT INTO audit_log (actor_id, actor_role, action, resource, resource_id, outcome, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
  /* Inside a privileged route (atomic-routes.js), a success is written on the
     route's own transaction and a failure to write it undoes the action. A refusal
     waits until that transaction has rolled back, or it would be rolled back too. */
  const store = atomicStore();
  if (store && outcome === 'ok') { await store.client.query(sql, row); return; }
  const write = () => pool.query(sql, row).catch((e) => { req?.log?.error({ e }, 'audit write failed'); });
  if (store) { store.after.push(write); return; }
  await write();
}

/* The privileged form: written on the caller's transaction, so the action and
   its record commit together. There is deliberately no catch. If this row
   cannot be written the transaction aborts, and the action does not happen. */
export async function auditTx(c, req, { action, resource, resourceId, outcome = 'ok', detail, actorId = null, actorRole = null }) {
  const a = req?.actor;
  await c.query(
    `INSERT INTO audit_log (actor_id, actor_role, action, resource, resource_id, outcome, detail, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a?.id || actorId, a?.roles?.[0] || actorRole, action, resource || null,
     resourceId ? String(resourceId) : null, outcome,
     detail ? JSON.stringify(detail) : null, req?.ip || null]);
}

/* Wraps a handler so a thrown HttpError is logged as a denial and rethrown. */
export function audited(action, resourceOf, fn) {
  return async (req, reply) => {
    try {
      const out = await fn(req, reply);
      await audit(req, { action, resource: resourceOf?.(req, out), resourceId: out?.id, outcome: 'ok' });
      return out;
    } catch (e) {
      await audit(req, {
        action, resource: resourceOf?.(req), outcome: e.status && e.status < 500 ? 'denied' : 'error',
        detail: { message: e.message, code: e.code },
      });
      throw e;
    }
  };
}
