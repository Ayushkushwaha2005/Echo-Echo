/* Every sensitive action lands here: who, what, when, resource, result.
   Denials are recorded too — an audit log that only shows successes tells
   you nothing about who is probing. */
import { q } from './db/index.js';

export async function audit(req, { action, resource, resourceId, outcome, detail }) {
  const a = req?.actor;
  try {
    await q(
      `INSERT INTO audit_log (actor_id, actor_role, action, resource, resource_id, outcome, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [a?.id || null, a?.roles?.[0] || null, action, resource || null,
       resourceId ? String(resourceId) : null, outcome,
       detail ? JSON.stringify(detail) : null, req?.ip || null]);
  } catch (e) {
    req?.log?.error({ e }, 'audit write failed');
  }
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
