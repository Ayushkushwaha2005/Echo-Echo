/* ==========================================================================
   ECHO ECHO — CAMPUS CONTROL: WHAT CHANGED

     GET /admin/changes   one small answer per area: a stamp that moves
                          whenever that area's records change, plus my
                          unread notification count

   Campus Control asks every few seconds while it is open and visible, and
   reloads the page in front of the administrator only when that page's
   stamp has moved. The stamps are computed from the records themselves
   (fingerprints of the small tables, the order event log for orders), so a
   change made anywhere - the student site, the counter, another
   administrator, a webhook - is seen the same way. Nothing is copied into a
   second table to make this work.

   A stamp is only an opaque string: it says THAT something changed, never
   what. Each one is computed only for an administrator who may read that
   area, so the endpoint reveals nothing a page would not.
   ========================================================================== */
import { one } from '../db/index.js';
import { can, Forbidden, Unauthenticated, isPlatformRole } from '../auth/rbac.js';
import { unreadCount } from '../services/notify.js';

/* Area -> [the capability that reads it, the SQL whose single value is its stamp]. */
const AREAS = {
  cafes: ['vendor.read',
    `SELECT md5(COALESCE(string_agg(v::text, '|' ORDER BY v.id), '')) AS s FROM vendor v`],
  menu: ['menu.read',
    `SELECT md5(COALESCE(string_agg(m::text, '|' ORDER BY m.id), '')) AS s FROM menu_item m`],
  /* Every order state change is an order_event row, so the newest event id
     plus the order count moves on any placement, payment or transition. */
  orders: ['order.read_all',
    `SELECT (SELECT count(*) FROM food_order) || ':' || COALESCE((SELECT max(id) FROM order_event), 0) AS s`],
  users: ['user.read',
    `SELECT (SELECT count(*) || ':' || COALESCE(max(profile_updated_at), max(created_at))::text FROM app_user)
         || ':' || (SELECT md5(COALESCE(string_agg(c.id::text || c.state || COALESCE(c.decided_at::text, ''), '|' ORDER BY c.id), '')) FROM verification_case c)
         || ':' || (SELECT count(*) || ':' || COALESCE(max(COALESCE(revoked_at, granted_at)), now() - interval '100 years')::text FROM user_role) AS s`],
  partners: ['partner.read',
    `SELECT md5(COALESCE(string_agg(p::text, '|' ORDER BY p.user_id), '')) AS s FROM partner_profile p`],
  site: ['site.read',
    `SELECT COALESCE((SELECT version FROM site_config_live WHERE id), 0) || ':' || COALESCE((SELECT revision FROM site_config_draft WHERE id), 0) AS s`],
};

export default async function liveRoutes(app) {
  app.get('/admin/changes', async (req, reply) => {
    if (!req.actor) throw Unauthenticated('Sign in required', 'No session on this request.');
    if (!req.actor.roles?.some(isPlatformRole)) throw Forbidden('Campus Control only', 'This needs an administrator session.');
    reply.header('Cache-Control', 'private, no-store');
    const stamps = {};
    await Promise.all(Object.entries(AREAS).map(async ([area, [cap, sql]]) => {
      if (can(req.actor, cap)) stamps[area] = (await one(sql))?.s ?? '';
    }));
    return { at: new Date().toISOString(), stamps, unread: await unreadCount(req.actor.id) };
  });
}
