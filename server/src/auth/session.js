/* ==========================================================================
   QUAD — SESSIONS

   The cookie carries a 32-byte random token. Only its SHA-256 is stored, so
   a database leak does not yield usable sessions. The actor object handed to
   authorize() is rebuilt from the database on every request — roles are
   never carried in the cookie, so a role revoked at 10:00 stops working at
   10:00 rather than when the session happens to expire.

   Platform roles (owner, admin, support) are only placed on the actor when
   the session was opened or re-confirmed with that account's passkey. From
   any other session they are withheld, so every permission check in the
   codebase - authorize() and each direct role test alike - fails closed.
   A recovery session carries no roles at all: it can register a passkey and
   nothing else.
   ========================================================================== */
import { randomBytes, createHash } from 'node:crypto';
import { q, one } from '../db/index.js';
import { SESSION, HTTP, ADMIN } from '../config.js';
import { Unauthenticated, isPlatformRole } from './rbac.js';
import { PERMISSIONS, PERMISSION_KEYS, ROLE_DEFAULT_PERMISSIONS, capsFor } from './permissions.js';

const sha = (t) => createHash('sha256').update(t).digest('hex');
export const tokenHash = sha;

export async function issueSession(userId, { ip, userAgent, method = 'code', credentialId = null, ttlMinutes } = {}) {
  const token = randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO session (token_hash, user_id, expires_at, user_agent, ip, auth_method,
                          passkey_verified_at, passkey_credential_id)
     VALUES ($1,$2, now() + ($3 || ' minutes')::interval, $4, $5, $6,
             CASE WHEN $6 IN ('passkey','admin_totp') THEN now() END, $7)`,
    [sha(token), userId, String(ttlMinutes || SESSION.ttlMinutes), userAgent || null, ip || null,
     method, credentialId]);
  return token;
}

export async function revokeSession(token) {
  if (!token) return false;
  const r = await q(`UPDATE session SET revoked_at = now()
                      WHERE token_hash = $1 AND revoked_at IS NULL`, [sha(token)]);
  return r.rowCount > 0;
}

export async function revokeAllForUser(userId, { exceptTokenHash = null } = {}) {
  await q(`UPDATE session SET revoked_at = now()
            WHERE user_id = $1 AND revoked_at IS NULL
              AND ($2::text IS NULL OR token_hash <> $2)`, [userId, exceptTokenHash]);
}

/* Resolves the request's actor. Roles and vendor scope come from the
   database every time — this is deliberate and worth the query. */
export async function actorFromToken(token) {
  if (!token) return null;
  const s = await one(
    `SELECT s.token_hash, s.user_id, u.status, u.name, u.phone, u.student_status,
            s.auth_method, s.passkey_verified_at, s.issued_at,
            s.campus_presence_at, s.campus_presence_site_id, s.campus_presence_accuracy_m,
            u.student_email, u.student_email_verified_at, u.contact_phone, u.campus_site_id,
            c.service_status AS campus_service_status, c.name AS campus_name,
            (SELECT method FROM verification_case v WHERE v.user_id = u.id AND v.state = 'approved'
              ORDER BY coalesce(v.decided_at, v.submitted_at) DESC LIMIT 1) AS verified_via
       FROM session s JOIN app_user u ON u.id = s.user_id
       LEFT JOIN campus_site c ON c.id = u.campus_site_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha(token)]);
  if (!s) return null;

  const { rows } = await q(
    `SELECT role, vendor_id FROM user_role
      WHERE user_id = $1 AND status = 'active'`, [s.user_id]);

  await q(`UPDATE app_user SET last_seen_at = now() WHERE id = $1`, [s.user_id]);

  /* The administrator record: lifecycle and the owner-granted permission
     list. Read per request, so a suspension, revocation or permission change
     applies to sessions that are already open - not at their expiry. */
  const acct = await one(`SELECT status, permissions FROM admin_account WHERE user_id = $1`, [s.user_id]);
  const isOwner = rows.some((r) => r.role === 'platform_owner');
  /* The owner is never narrowed or suspended by this table. For everybody
     else: no row = legacy/config admin at the role default; a row that is
     not 'active' means no platform power at all. */
  const adminStatus = isOwner || !acct ? 'active' : acct.status;
  let held = rows.map((r) => r.role);
  /* Invited: the roles are shown as withheld (so the passkey set-up step is
     offered) but can never be used until the invite ceremony activates the
     account. Suspended/revoked: gone entirely. */
  if (!['active', 'invited'].includes(adminStatus)) held = held.filter((r) => !isPlatformRole(r) || r === 'platform_owner');
  const platformHeld = held.filter((r) => r === 'platform_admin' || r === 'support');
  const permissionKeys = isOwner ? PERMISSION_KEYS
    : acct?.permissions ? acct.permissions.filter((k) => PERMISSIONS[k] && !PERMISSIONS[k].ownerOnly)
    : [...new Set(platformHeld.flatMap((r) => ROLE_DEFAULT_PERMISSIONS[r] || []))];
  const adminCaps = !isOwner && platformHeld.length ? capsFor(permissionKeys) : null;

  const all = held;
  /* "Strongly authenticated as an administrator." Campus Control is opened
     with password + authenticator code (auth_method 'admin_totp'); the
     older passkey method still satisfies the same gate for any deployment
     that still has credentials registered. An email-code session never
     does, so a student who is also an admin cannot touch Campus Control
     from the session they order lunch with. */
  const passkeyOk = !ADMIN.passkeyRequired ||
    (['passkey', 'admin_totp'].includes(s.auth_method) && !!s.passkey_verified_at);
  const recovery = s.auth_method === 'recovery';
  const roles = recovery ? [] : all.filter((r) => !isPlatformRole(r) || (passkeyOk && adminStatus === 'active'));
  const withheldRoles = all.filter((r) => !roles.includes(r));

  return {
    id: s.user_id,
    tokenHash: s.token_hash,
    name: s.name,
    phone: s.phone,
    status: s.status,
    studentStatus: s.student_status,
    /* Profile inputs, read fresh per request, for assertMayOrder(). */
    profile: {
      name: s.name, phone: s.phone, contact_phone: s.contact_phone,
      student_email: s.student_email, student_email_verified_at: s.student_email_verified_at,
      student_status: s.student_status, campus_site_id: s.campus_site_id,
    },
    studentEmail: s.student_email,
    studentEmailVerifiedAt: s.student_email_verified_at,
    verifiedVia: s.verified_via || null,
    sessionKind: s.auth_method,              // 'code' | 'admin_totp' | 'passkey' | 'recovery'
    /* The live-location check this session passed, if any. Read from the
       session row, so a browser cannot assert it. */
    campusPresenceAt: s.campus_presence_at || null,
    campusPresenceSiteId: s.campus_presence_site_id || null,
    campusPresenceAccuracyM: s.campus_presence_accuracy_m ?? null,
    passkeyAt: s.passkey_verified_at,
    campusId: s.campus_site_id,
    campusServiceStatus: s.campus_service_status || null,
    campusName: s.campus_name || null,
    roles,
    withheldRoles,
    isOwner: isOwner && roles.includes('platform_owner'),
    adminStatus: acct && !isOwner ? acct.status : (platformHeld.length || isOwner ? 'active' : null),
    adminCaps,
    /* Granular permission keys this session can actually use right now. */
    permissions: roles.some(isPlatformRole) ? permissionKeys : [],
    vendorIds: recovery ? [] : rows.map((r) => r.vendor_id).filter(Boolean),
  };
}

export const cookieOptions = (ttlMinutes = SESSION.ttlMinutes) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: HTTP.secureCookies,
  path: '/',
  maxAge: ttlMinutes * 60,
});

/* Fastify preHandler. `optional` lets a route serve anonymous browsing. */
export function requireAuth({ optional = false } = {}) {
  return async (req) => {
    if (!req.actor && !optional) throw Unauthenticated();
    return req.actor;
  };
}
