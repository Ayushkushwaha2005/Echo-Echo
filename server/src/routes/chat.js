/* ==========================================================================
   ECHO ECHO — TEAM CHAT

     GET  /chat/people                       who staff may start a chat with
     GET  /chat/conversations                my conversations, with unread counts
     POST /chat/conversations                start one (staff only)
     GET  /chat/conversations/:id/messages   history (members only)
     POST /chat/conversations/:id/messages   send (members only, rate-limited)
     POST /chat/conversations/:id/read       mark read up to now
     POST /chat/conversations/:id/members    add people to a group (staff)
     GET  /chat/unread                       my total unread count

   Membership is the whole access model: every read and every write checks
   chat_member for THIS user, and a conversation someone is not in answers
   404, exactly as if it did not exist. So a cafe cannot read another cafe's
   conversation, and a partner cannot read a staff-only one, unless someone
   with the right to start it put them in it.

   Who may start a conversation: an administrator or support member, from an
   administrator session (password + authenticator). Messaging partners needs
   permission to see partners; messaging cafes needs permission to see cafes.
   Partners and cafe staff reply in conversations they were added to.

   There is no socket: clients poll. A message is stored before it is
   acknowledged, and `clientRef` makes a retry after a dropped connection
   return the same message instead of a second copy. Message text is never
   written to the audit log; creating a conversation and adding people are.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { BadRequest, Forbidden, NotFound, can, isPlatformRole } from '../auth/rbac.js';
import { assertPasskeySession } from '../auth/passkey-policy.js';
import { audit } from '../audit.js';

const AUDIENCES = ['staff', 'partners', 'cafes'];
const MESSAGES_PER_MINUTE = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = `COALESCE(ap.display_name, u.name, 'Unnamed')`;
const perActor = (req) => (req.actor?.id ? `chat:${req.actor.id}` : req.ip);

function signedIn(req) {
  if (!req.actor) throw Forbidden('Sign in required');
  return req.actor;
}
/* Staff: a platform role, usable only from an administrator session. */
function staff(req) {
  const a = signedIn(req);
  if (!a.roles.some(isPlatformRole)) throw Forbidden('Only ECHO ECHO staff can start conversations');
  assertPasskeySession(a);
  return a;
}
function mayReach(actor, audience) {
  if (audience === 'partners' && !can(actor, 'partner.read')) throw Forbidden('Messaging partners needs permission to view partners');
  if (audience === 'cafes' && !can(actor, 'vendor.read')) throw Forbidden('Messaging cafés needs permission to view cafés');
}

/* People on one side of the platform, by audience. */
const PEOPLE_SQL = {
  staff: `SELECT DISTINCT u.id, ${NAME} AS name, 'Campus Control' AS detail, NULL::uuid AS vendor_id, 'staff' AS kind
            FROM app_user u JOIN user_role r ON r.user_id = u.id AND r.status = 'active'
                 AND r.role IN ('platform_owner','platform_admin','support')
            LEFT JOIN admin_account aa ON aa.user_id = u.id
            LEFT JOIN admin_profile ap ON ap.user_id = u.id
           WHERE u.status = 'active' AND (aa.status IS NULL OR aa.status = 'active')`,
  partners: `SELECT DISTINCT u.id, ${NAME} AS name, 'Delivery partner' AS detail, NULL::uuid AS vendor_id, 'partner' AS kind
               FROM app_user u JOIN user_role r ON r.user_id = u.id AND r.status = 'active' AND r.role = 'delivery_partner'
               JOIN partner_profile pp ON pp.user_id = u.id AND pp.status = 'approved'
               LEFT JOIN admin_profile ap ON ap.user_id = u.id
              WHERE u.status = 'active'`,
  cafes: `SELECT DISTINCT u.id, ${NAME} AS name,
                 v.name || CASE r.role WHEN 'vendor_owner' THEN ' · owner' ELSE ' · staff' END AS detail, r.vendor_id,
                 CASE r.role WHEN 'vendor_owner' THEN 'owner' ELSE 'staff' END AS kind
            FROM app_user u JOIN user_role r ON r.user_id = u.id AND r.status = 'active' AND r.role IN ('vendor_owner','vendor_staff')
            JOIN vendor v ON v.id = r.vendor_id AND v.active
            LEFT JOIN admin_profile ap ON ap.user_id = u.id
           WHERE u.status = 'active'`,
};

async function membership(conversationId, userId) {
  if (!UUID.test(String(conversationId))) throw NotFound('No such conversation');
  const m = await one(
    `SELECT c.*, m.last_read_at FROM chat_conversation c
       JOIN chat_member m ON m.conversation_id = c.id AND m.user_id = $2
      WHERE c.id = $1`, [conversationId, userId]);
  if (!m) throw NotFound('No such conversation');
  return m;
}

/* The members a staff member wants to add, each checked to belong to the
   conversation's audience. Cafe conversations stay inside one cafe. */
async function checkMembers(audience, ids, { vendorId = null } = {}) {
  const unique = [...new Set((ids || []).map(String))];
  if (unique.some((x) => !UUID.test(x))) throw BadRequest('memberIds must be people from the list');
  if (!unique.length) throw BadRequest('Choose at least one person');
  if (unique.length > 50) throw BadRequest('A conversation can have at most 50 people');
  const { rows } = await q(`SELECT * FROM (${PEOPLE_SQL[audience]}) p WHERE p.id = ANY($1::uuid[])`, [unique]);
  const found = new Map();
  for (const r of rows) if (!found.has(r.id)) found.set(r.id, r);
  const missing = unique.filter((x) => !found.has(x));
  if (missing.length) throw BadRequest(`Not everyone chosen can be messaged in ${audience === 'cafes' ? 'Cafés' : audience === 'partners' ? 'Delivery Partners' : 'Employees'}`);
  if (audience === 'cafes') {
    const vendors = new Set(rows.map((r) => r.vendor_id));
    if (vendorId) vendors.add(vendorId);
    if (vendors.size > 1) throw BadRequest('A café conversation includes people from one café only');
    return { ids: unique, vendorId: [...vendors][0] || null };
  }
  return { ids: unique, vendorId: null };
}

export default async function chatRoutes(app) {
  app.get('/chat/people', async (req) => {
    const a = staff(req);
    const audience = String(req.query?.audience || 'staff');
    if (!AUDIENCES.includes(audience)) throw BadRequest('audience must be staff, partners or cafes');
    mayReach(a, audience);
    const term = String(req.query?.q || '').trim().slice(0, 60);
    /* Cafés: owners and counter staff can be reached separately. */
    const role = req.query?.role ? String(req.query.role) : null;
    if (role && (audience !== 'cafes' || !['owner', 'staff'].includes(role))) throw BadRequest('role is owner or staff, for cafés only');
    const { rows } = await q(
      `SELECT DISTINCT ON (p.name, p.id) id, name, detail, vendor_id AS "vendorId", kind FROM (${PEOPLE_SQL[audience]}) p
        WHERE p.id <> $1 AND ($2 = '' OR p.name ILIKE '%' || $2 || '%' OR p.detail ILIKE '%' || $2 || '%')
          AND ($3::text IS NULL OR p.kind = $3)
        ORDER BY p.name, p.id LIMIT 50`, [a.id, term, role]);
    return { people: rows };
  });

  app.get('/chat/conversations', async (req) => {
    const a = signedIn(req);
    const audience = req.query?.audience ? String(req.query.audience) : null;
    if (audience && !AUDIENCES.includes(audience)) throw BadRequest('audience must be staff, partners or cafes');
    const { rows } = await q(
      `SELECT c.id, c.kind, c.audience, c.title, c.vendor_id AS "vendorId", c.created_at AS "createdAt",
              c.last_message_at AS "lastMessageAt", v.name AS "vendorName",
              (SELECT json_build_object('body', left(x.body, 140), 'senderId', x.sender_id, 'createdAt', x.created_at)
                 FROM chat_message x WHERE x.conversation_id = c.id ORDER BY x.id DESC LIMIT 1) AS "lastMessage",
              (SELECT count(*)::int FROM chat_message x WHERE x.conversation_id = c.id AND x.sender_id <> $1
                 AND (me.last_read_at IS NULL OR x.created_at > me.last_read_at)) AS unread,
              (SELECT json_agg(json_build_object('id', u.id, 'name', ${NAME}) ORDER BY u.id)
                 FROM chat_member om JOIN app_user u ON u.id = om.user_id LEFT JOIN admin_profile ap ON ap.user_id = u.id
                WHERE om.conversation_id = c.id) AS members
         FROM chat_conversation c JOIN chat_member me ON me.conversation_id = c.id AND me.user_id = $1
         LEFT JOIN vendor v ON v.id = c.vendor_id
        WHERE ($2::text IS NULL OR c.audience = $2)
        ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC LIMIT 100`, [a.id, audience]);
    return { conversations: rows, me: a.id };
  });

  app.post('/chat/conversations', async (req) => {
    const a = staff(req);
    const audience = String(req.body?.audience || '');
    if (!AUDIENCES.includes(audience)) throw BadRequest('audience must be staff, partners or cafes');
    mayReach(a, audience);
    const { ids, vendorId } = await checkMembers(audience, (req.body?.memberIds || []).filter((x) => x !== a.id));
    const title = req.body?.title == null ? '' : String(req.body.title).replace(/\s+/g, ' ').trim();
    if (title.length > 80) throw BadRequest('A title is at most 80 characters');
    const direct = ids.length === 1 && !title;
    if (!direct && !title) throw BadRequest('Give a group conversation a title');
    const directKey = direct ? `${audience}:${[a.id, ids[0]].sort().join(':')}` : null;

    if (directKey) {
      const existing = await one(`SELECT id FROM chat_conversation WHERE direct_key = $1`, [directKey]);
      if (existing) {
        /* Re-add the starter if they had somehow been removed. */
        await q(`INSERT INTO chat_member (conversation_id, user_id, added_by) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`, [existing.id, a.id]);
        return { id: existing.id, existing: true };
      }
    }
    const id = await tx(async (c) => {
      const conv = (await c.query(
        `INSERT INTO chat_conversation (kind, audience, title, vendor_id, created_by, direct_key)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [direct ? 'direct' : 'group', audience, title || null, vendorId, a.id, directKey])).rows[0];
      for (const uid of [a.id, ...ids]) {
        await c.query(`INSERT INTO chat_member (conversation_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [conv.id, uid, a.id]);
      }
      return conv.id;
    });
    await audit(req, { action: 'chat.conversation.create', resource: 'chat_conversation', resourceId: id, outcome: 'ok',
                       detail: { audience, kind: direct ? 'direct' : 'group', members: ids.length + 1 } });
    return { id, existing: false };
  });

  app.get('/chat/conversations/:id/messages', async (req) => {
    const a = signedIn(req);
    const conv = await membership(req.params.id, a.id);
    const after = Number.parseInt(req.query?.after, 10);
    const before = Number.parseInt(req.query?.before, 10);
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query?.limit, 10) || 50));
    const { rows } = await q(
      `SELECT * FROM (
         SELECT m.id::int AS id, m.sender_id AS "senderId", m.body, m.created_at AS "createdAt", m.client_ref AS "clientRef"
           FROM chat_message m WHERE m.conversation_id = $1
            AND ($2::bigint IS NULL OR m.id > $2) AND ($3::bigint IS NULL OR m.id < $3)
          ORDER BY m.id ${Number.isInteger(after) ? 'ASC' : 'DESC'} LIMIT $4) t ORDER BY id`,
      [conv.id, Number.isInteger(after) ? after : null, Number.isInteger(before) ? before : null, limit]);
    const members = (await q(
      `SELECT u.id, ${NAME} AS name, m.last_read_at AS "lastReadAt"
         FROM chat_member m JOIN app_user u ON u.id = m.user_id LEFT JOIN admin_profile ap ON ap.user_id = u.id
        WHERE m.conversation_id = $1 ORDER BY name`, [conv.id])).rows;
    return { conversation: { id: conv.id, kind: conv.kind, audience: conv.audience, title: conv.title },
             messages: rows, members, me: a.id };
  });

  app.post('/chat/conversations/:id/messages', {
    config: { rateLimit: { max: MESSAGES_PER_MINUTE, timeWindow: '1 minute', keyGenerator: perActor, hook: 'preHandler' } },
  }, async (req) => {
    const a = signedIn(req);
    const conv = await membership(req.params.id, a.id);
    const body = String(req.body?.body ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (!body) throw BadRequest('Write a message first');
    if (body.length > 4000) throw BadRequest('A message is at most 4000 characters');
    const ref = req.body?.clientRef == null ? null : String(req.body.clientRef);
    if (ref !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(ref)) throw BadRequest('clientRef must be 8 to 64 letters, digits, - or _');
    const msg = await tx(async (c) => {
      const ins = (await c.query(
        `INSERT INTO chat_message (conversation_id, sender_id, body, client_ref) VALUES ($1,$2,$3,$4)
         ON CONFLICT (conversation_id, sender_id, client_ref) DO NOTHING
         RETURNING id::int AS id, sender_id AS "senderId", body, created_at AS "createdAt", client_ref AS "clientRef"`,
        [conv.id, a.id, body, ref])).rows[0];
      if (!ins) {
        /* A retry of a message that was already stored: return it, once. */
        return { ...(await c.query(
          `SELECT id::int AS id, sender_id AS "senderId", body, created_at AS "createdAt", client_ref AS "clientRef"
             FROM chat_message WHERE conversation_id = $1 AND sender_id = $2 AND client_ref = $3`, [conv.id, a.id, ref])).rows[0], duplicate: true };
      }
      await c.query(`UPDATE chat_conversation SET last_message_at = $2 WHERE id = $1`, [conv.id, ins.createdAt]);
      await c.query(`UPDATE chat_member SET last_read_at = $3 WHERE conversation_id = $1 AND user_id = $2`, [conv.id, a.id, ins.createdAt]);
      return ins;
    });
    return { message: msg };
  });

  app.post('/chat/conversations/:id/read', async (req) => {
    const a = signedIn(req);
    const conv = await membership(req.params.id, a.id);
    await q(`UPDATE chat_member SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [conv.id, a.id]);
    return { ok: true };
  });

  app.post('/chat/conversations/:id/members', async (req) => {
    const a = staff(req);
    const conv = await membership(req.params.id, a.id);
    if (conv.kind !== 'group') throw BadRequest('People are added to group conversations only');
    mayReach(a, conv.audience);
    const { ids } = await checkMembers(conv.audience, req.body?.userIds, { vendorId: conv.vendor_id });
    const current = (await q(`SELECT count(*)::int AS n FROM chat_member WHERE conversation_id = $1`, [conv.id])).rows[0].n;
    if (current + ids.length > 51) throw BadRequest('A conversation can have at most 50 people besides you');
    for (const uid of ids) {
      await q(`INSERT INTO chat_member (conversation_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [conv.id, uid, a.id]);
    }
    await audit(req, { action: 'chat.members.add', resource: 'chat_conversation', resourceId: conv.id, outcome: 'ok',
                       detail: { added: ids.length } });
    return { ok: true };
  });

  app.get('/chat/unread', async (req) => {
    const a = signedIn(req);
    const r = await one(
      `SELECT count(*)::int AS n FROM chat_message x JOIN chat_member me ON me.conversation_id = x.conversation_id AND me.user_id = $1
        WHERE x.sender_id <> $1 AND (me.last_read_at IS NULL OR x.created_at > me.last_read_at)`, [a.id]);
    return { unread: r.n };
  });
}
