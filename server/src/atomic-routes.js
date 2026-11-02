/* ==========================================================================
   ECHO ECHO - PRIVILEGED ROUTES COMMIT WITH THEIR AUDIT RECORD

   Each route listed here runs inside atomic(): its writes and its audit row are
   one transaction, so an action can no longer succeed unaudited. Finance, wallet,
   payment and refund routes are deliberately not listed while payments are frozen,
   and sign-in routes keep the best-effort audit, because a logging fault must not
   lock every administrator out.
   ========================================================================== */
import { atomic } from './db/index.js';

export const ATOMIC_ROUTES = new Set([
  'POST /admin/users/role', 'POST /admin/users/role/revoke', 'POST /admin/users/:id/status',
  'POST /admin/partners/:userId/decide', 'PUT /admin/flags/:key', 'PUT /admin/config/:key',
  'PUT /admin/access/admins/:id/permissions', 'POST /admin/access/admins/:id/suspend',
  'POST /admin/access/admins/:id/restore', 'POST /admin/access/admins/:id/revoke',
  'POST /admin/access/admins/:id/sessions/revoke',
  'PUT /admin/site/draft', 'POST /admin/site/draft/reset', 'POST /admin/site/publish', 'POST /admin/site/rollback',
  'POST /vendors', 'PATCH /vendors/:id', 'POST /vendors/:id/menu', 'PATCH /menu/:id', 'DELETE /menu/:id',
  'POST /vendors/:id/categories', 'PATCH /categories/:id', 'DELETE /categories/:id',
  'POST /campus/nodes', 'PATCH /campus/nodes/:id', 'POST /campus/nodes/:id/confirm', 'POST /campus/nodes/:id/archive',
  'POST /admin/campuses/:id/boundaries', 'PUT /campus/boundary', 'POST /admin/boundaries/:id/activate', 'POST /admin/boundaries/:id/retire',
  'POST /admin/verification/:id/decide', 'POST /admin/users/:id/student-verification',
  'POST /admin/users/:id/enrolment', 'POST /admin/users/:id/enrolment/revoke',
  'POST /admin/campuses/:id/points/import', 'POST /admin/campuses/:id/points/confirm', 'POST /admin/campuses/:id/boundaries/import',
  'PATCH /admin/me', 'POST /admin/me/photo', 'DELETE /admin/me/photo', 'POST /admin/me/sessions/revoke',
  'POST /support/cases/:id/state', 'POST /admin/reviews/:id/hide',
]);

export function installAtomicRoutes(app) {
  const seen = new Set();
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      const key = `${method} ${route.url.replace(/\/$/, '') || '/'}`;
      if (!ATOMIC_ROUTES.has(key)) continue;
      seen.add(key);
      const handler = route.handler;
      route.handler = function atomicHandler(req, reply) { return atomic(() => handler.call(this, req, reply)); };
    }
  });
  /* A renamed route must not quietly fall out of this protection. */
  app.addHook('onReady', async () => {
    const missing = [...ATOMIC_ROUTES].filter((k) => !seen.has(k));
    if (missing.length) throw new Error(`atomic-routes: no such route: ${missing.join(', ')}`);
  });
}
