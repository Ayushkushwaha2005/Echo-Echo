/* ==========================================================================
   ECHO ECHO - LIVE STREAMS

     GET  /live/stream                 public catalogue areas, area and version only
     GET  /admin/live/stream           the areas this administrator may read
     POST /orders/:id/tracking/ticket  a 60-second, single-use viewer ticket
     GET  /tracking/stream?ticket=     "this order's position moved", no coordinates

   See services/live.js. Every one of these answers 204 while streams are off.
   ========================================================================== */
import { randomBytes, createHash } from 'node:crypto';
import { can, isPlatformRole, Forbidden, Unauthenticated, TooMany } from '../auth/rbac.js';
import { actorFromToken } from '../auth/session.js';
import { SESSION } from '../config.js';
import { edgePeer } from '../edge-limit.js';
import { closeAllStreams, canOpenStream, openStream, streamsEnabled } from '../services/live.js';
import { canFollowOrder } from '../services/partner-location.js';

const PUBLIC_AREAS = ['cafes', 'menu'];
/* Area -> the capability that may read it. Same as /admin/changes. */
const ADMIN_AREAS = {
  cafes: 'vendor.read', menu: 'menu.read', partners: 'partner.read', support: 'support.read',
  reviews: 'review.read', incidents: 'incident.read', locations: 'location.read',
};
const TICKET_SECONDS = 60;
const MAX_TICKETS = 5000;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const tickets = new Map();   // hash -> { orderId, userId, tokenHash, expiresAt }

const pruneTickets = () => {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.expiresAt <= now) tickets.delete(k);
};

const sinceOf = (req) => {
  const v = Number(req.headers['last-event-id']);
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
};

function guard(req, reply) {
  req.peerKey = edgePeer(req).ip;
  if (!streamsEnabled()) { reply.code(204).send(); return false; }
  if (!canOpenStream(req.peerKey)) throw TooMany('Too many live connections', 'This page will keep updating by polling.');
  return true;
}

export default async function liveStreamRoutes(app) {
  /* preClose, not onClose: Fastify runs onClose only after in-flight requests finish,
     and an open stream never finishes, so shutdown would hang until the host killed it. */
  app.addHook('preClose', async () => closeAllStreams());

  app.get('/live/stream', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    openStream(req, reply, { areas: PUBLIC_AREAS, sinceId: sinceOf(req) });
    return reply;
  });

  app.get('/admin/live/stream', async (req, reply) => {
    if (!req.actor) throw Unauthenticated('Sign in required');
    if (!req.actor.roles?.some(isPlatformRole)) throw Forbidden('Campus Control only');
    if (!guard(req, reply)) return reply;
    const areas = Object.entries(ADMIN_AREAS).filter(([, cap]) => can(req.actor, cap)).map(([a]) => a);
    const cookie = req.cookies?.[SESSION.cookieName];
    openStream(req, reply, {
      areas, sinceId: sinceOf(req), recheckMs: 30_000,
      /* A revoked or suspended administrator is cut off while connected. */
      recheck: async () => { const a = await actorFromToken(cookie); return !!a?.roles?.some(isPlatformRole); },
    });
    return reply;
  });

  app.post('/orders/:id/tracking/ticket', async (req, reply) => {
    if (!req.actor) throw Unauthenticated('Sign in required');
    if (!streamsEnabled()) { reply.code(204).send(); return reply; }
    if (!(await canFollowOrder(req.actor, req.params.id))) throw Forbidden('That delivery cannot be followed');
    pruneTickets();
    if (tickets.size >= MAX_TICKETS) throw TooMany('Too many live connections', 'This page will keep updating by polling.');
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(sha(ticket), {
      orderId: req.params.id, userId: req.actor.id, cookie: req.cookies?.[SESSION.cookieName],
      expiresAt: Date.now() + TICKET_SECONDS * 1000,
    });
    return { ticket, expiresInSeconds: TICKET_SECONDS };
  });

  app.get('/tracking/stream', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const key = sha(String(req.query?.ticket || ''));
    const t = tickets.get(key);
    tickets.delete(key);
    if (!t || t.expiresAt <= Date.now()) throw Forbidden('That ticket is no longer valid');
    const check = async () => {
      const actor = await actorFromToken(t.cookie);
      return !!actor && actor.id === t.userId && canFollowOrder(actor, t.orderId);
    };
    if (!(await check())) throw Forbidden('That delivery cannot be followed');
    openStream(req, reply, { orderId: t.orderId, recheck: check });
    return reply;
  });
}
