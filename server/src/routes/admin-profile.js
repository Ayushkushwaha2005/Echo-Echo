/* ==========================================================================
   ECHO ECHO — MY PROFILE (an administrator's own account)

     GET    /admin/me                   profile, sign-in set-up, own sessions,
                                        own security activity
     PATCH  /admin/me                   display name
     POST   /admin/me/photo             upload or replace the profile photo
     DELETE /admin/me/photo             remove it
     GET    /admin/photos/:userId       an administrator's photo, to other
                                        signed-in administrators only
     POST   /admin/me/sessions/revoke   end one of my sessions, or all others

   Every route acts on the CALLER and only the caller: there is no user id in
   any write, so no permission - however broad - lets one administrator edit
   another's name, photo, sessions, password or authenticator here. Password
   and authenticator changes stay on /auth/admin/credential/*, which demand
   the current password and a code.

   Only a session opened as an administrator (password + authenticator) can
   use these; the student session of the same person cannot.
   ========================================================================== */
import { createHash } from 'node:crypto';
import { q, one } from '../db/index.js';
import { BadRequest, Forbidden, NotFound, isPlatformRole } from '../auth/rbac.js';
import { assertPasskeySession, assertRecentPasskey } from '../auth/passkey-policy.js';
import { revokeAllForUser } from '../auth/session.js';
import { credentialStatus } from '../services/admin-auth.js';
import { putImage, getImage, removeImage } from '../services/storage.js';
import { audit } from '../audit.js';

const ROLE_LABEL = { platform_owner: 'Owner', platform_admin: 'Administrator', support: 'Support' };

/* The caller, if they are an administrator in an administrator session. */
function me(req) {
  if (!req.actor) throw Forbidden('Sign in required');
  assertPasskeySession(req.actor);
  if (!req.actor.roles.some(isPlatformRole)) throw Forbidden('This is for administrators');
  return req.actor;
}

/* A session's public handle: derived from its token hash, so it identifies
   the row without being anything a cookie could be made from. */
const handleOf = (tokenHash) => createHash('sha256').update(`session-handle:${tokenHash}`).digest('hex').slice(0, 20);

/** Display name rules: what a person would write as their name. */
export function checkDisplayName(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 40) throw BadRequest('A display name is 2 to 40 characters');
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(s)) {
    throw BadRequest('Use letters, spaces, full stops, apostrophes or hyphens');
  }
  return s;
}

/* What administrators see as a person's name: their chosen display name,
   otherwise the account's own name. */
export const DISPLAY_NAME_SQL = (u, p) => `COALESCE(${p}.display_name, ${u}.name)`;

/* The security events that belong in someone's own history. */
const OWN_EVENTS = [
  'auth.admin.login', 'auth.admin.login.password', 'auth.admin.reauth', 'auth.logout',
  'admin.password.set', 'admin.password.reset.request', 'admin.password.reset.verify', 'admin.password.reset.complete',
  'admin.authenticator.begin', 'admin.authenticator.confirm', 'admin.authenticator.replace',
  'admin.session.revoke', 'admin.session.revoke_others', 'admin.profile.update', 'admin.profile.photo',
];

export default async function adminProfileRoutes(app) {
  app.get('/admin/me', async (req) => {
    const a = me(req);
    const u = await one(
      `SELECT u.id, u.name AS account_name, u.student_email AS email, u.status, u.created_at,
              p.display_name, p.photo_asset IS NOT NULL AS has_photo, p.updated_at AS profile_updated_at,
              ac.status AS admin_status, ac.activated_at
         FROM app_user u LEFT JOIN admin_profile p ON p.user_id = u.id
         LEFT JOIN admin_account ac ON ac.user_id = u.id WHERE u.id = $1`, [a.id]);
    const sessions = (await q(
      `SELECT token_hash, issued_at, expires_at, auth_method, ip, left(coalesce(user_agent,''), 140) AS user_agent
         FROM session WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY issued_at DESC LIMIT 20`, [a.id])).rows;
    const activity = (await q(
      `SELECT at, action, outcome, ip, detail->>'reason' AS reason FROM audit_log
        WHERE action = ANY($3::text[])
          AND (actor_id = $1::uuid OR resource_id = $4 OR resource_id = $2)
        ORDER BY at DESC LIMIT 40`, [a.id, u.email || '', OWN_EVENTS, String(a.id)])).rows;
    return {
      profile: {
        id: u.id, email: u.email, displayName: u.display_name || u.account_name || u.email,
        accountName: u.account_name, hasPhoto: !!u.has_photo, status: u.status,
        adminStatus: a.isOwner ? 'active' : (u.admin_status || 'active'),
        roles: a.roles.filter(isPlatformRole).map((r) => ROLE_LABEL[r] || r),
        isOwner: !!a.isOwner, memberSince: u.created_at, adminSince: u.activated_at || null,
        permissionsCount: a.isOwner ? null : (a.permissions || []).length,
      },
      security: await credentialStatus(a.id),
      sessions: sessions.map((s) => ({
        handle: handleOf(s.token_hash), current: s.token_hash === a.tokenHash,
        issuedAt: s.issued_at, expiresAt: s.expires_at,
        method: s.auth_method === 'admin_totp' ? 'Password + authenticator' : s.auth_method === 'code' ? 'Student email code' : s.auth_method,
        ip: s.ip, userAgent: s.user_agent,
      })),
      activity,
    };
  });

  app.patch('/admin/me', async (req) => {
    const a = me(req);
    const name = checkDisplayName(req.body?.displayName);
    await q(
      `INSERT INTO admin_profile (user_id, display_name) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET display_name = $2, updated_at = now()`, [a.id, name]);
    await audit(req, { action: 'admin.profile.update', resource: 'admin_profile', resourceId: a.id, outcome: 'ok' });
    return { displayName: name };
  });

  app.post('/admin/me/photo', async (req) => {
    const a = me(req);
    let buf = null;
    for await (const part of req.parts()) if (part.type === 'file') buf = await part.toBuffer();
    if (!buf) throw BadRequest('No image received');
    const asset = await putImage(buf, { ownerId: a.id, kind: 'admin_photo' });
    if ((asset.width && asset.width < 96) || (asset.height && asset.height < 96)) {
      await removeImage(asset.id);
      throw BadRequest('That photo is too small', 'Use an image at least 96 × 96 pixels.');
    }
    const old = await one(`SELECT photo_asset FROM admin_profile WHERE user_id = $1`, [a.id]);
    await q(
      `INSERT INTO admin_profile (user_id, photo_asset) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET photo_asset = $2, updated_at = now()`, [a.id, asset.id]);
    if (old?.photo_asset) await removeImage(old.photo_asset);
    await audit(req, { action: 'admin.profile.photo', resource: 'admin_profile', resourceId: a.id, outcome: 'ok',
                       detail: { change: old?.photo_asset ? 'replaced' : 'added', bytes: asset.bytes } });
    return { hasPhoto: true };
  });

  app.delete('/admin/me/photo', async (req) => {
    const a = me(req);
    const old = await one(`SELECT photo_asset FROM admin_profile WHERE user_id = $1`, [a.id]);
    if (!old?.photo_asset) return { hasPhoto: false };
    await q(`UPDATE admin_profile SET photo_asset = NULL, updated_at = now() WHERE user_id = $1`, [a.id]);
    await removeImage(old.photo_asset);
    await audit(req, { action: 'admin.profile.photo', resource: 'admin_profile', resourceId: a.id, outcome: 'ok',
                       detail: { change: 'removed' } });
    return { hasPhoto: false };
  });

  /* Administrators' photos are for other administrators, nobody else. */
  app.get('/admin/photos/:userId', async (req, reply) => {
    me(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.userId)) throw NotFound('No photo');
    const p = await one(`SELECT photo_asset FROM admin_profile WHERE user_id = $1`, [req.params.userId]);
    if (!p?.photo_asset) throw NotFound('No photo');
    const got = await getImage(p.photo_asset);
    if (!got) throw NotFound('No photo');
    reply.header('Cache-Control', 'private, max-age=300');
    if (got.url) return reply.redirect(got.url);
    return reply.type(got.asset.mime).send(got.bytes);
  });

  app.post('/admin/me/sessions/revoke', async (req) => {
    const a = me(req);
    assertRecentPasskey(a, 'ending your sessions');
    if (req.body?.others === true) {
      await revokeAllForUser(a.id, { exceptTokenHash: a.tokenHash });
      await audit(req, { action: 'admin.session.revoke_others', resource: 'session', resourceId: a.id, outcome: 'ok' });
      return { ok: true };
    }
    const handle = String(req.body?.handle || '');
    if (!/^[0-9a-f]{20}$/.test(handle)) throw BadRequest('Which session?');
    const mine = (await q(`SELECT token_hash FROM session WHERE user_id = $1 AND revoked_at IS NULL`, [a.id])).rows;
    const hit = mine.find((s) => handleOf(s.token_hash) === handle);
    if (!hit) throw NotFound('No such session of yours');
    if (hit.token_hash === a.tokenHash) throw BadRequest('That is this session', 'Use Sign out to end it.');
    await q(`UPDATE session SET revoked_at = now() WHERE token_hash = $1 AND user_id = $2`, [hit.token_hash, a.id]);
    await audit(req, { action: 'admin.session.revoke', resource: 'session', resourceId: a.id, outcome: 'ok' });
    return { ok: true };
  });
}
