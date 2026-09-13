/* ==========================================================================
   ECHO ECHO - ADMINISTRATOR ACCESS (owner-managed)

   GET  /admin/access/catalog                     admins.view
   GET  /admin/access/admins                      admins.view
   GET  /admin/access/admins/:id                  admins.view   (+ activity)
   POST /admin/access/invitations                 owner only    name, email, permissions
   POST /admin/access/admins/:id/invite           owner only    re-issue a one-time invite
   PUT  /admin/access/admins/:id/permissions      owner only
   POST /admin/access/admins/:id/suspend          admins.suspend
   POST /admin/access/admins/:id/restore          owner only
   POST /admin/access/admins/:id/revoke           owner only
   POST /admin/access/admins/:id/sessions/revoke  sessions.revoke

   Rules that hold for every route here, all server-side:
     - the platform owner is never a target (cannot be suspended, revoked,
       narrowed or signed out by anyone through this API);
     - nobody acts on their own administrator record;
     - every change needs a passkey confirmation from the last few minutes
       and a written reason, and is audited with before/after;
     - invite codes are shown to the owner only when email delivery is not
       available, exactly once, and are never logged.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { authorize, BadRequest, NotFound, Forbidden, Conflict } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { catalogue, validatePermissionList, PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from '../auth/permissions.js';
import { normaliseStudentEmail } from '../services/student-email.js';
import { issueInvite, newInviteSecret } from '../services/admin-credentials.js';
import { sendEmail, emailConfigured } from '../services/email.js';
import { ADMIN, HTTP } from '../config.js';
import { audit } from '../audit.js';

const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);

function assertOwner(actor, what) {
  if (!actor?.isOwner) {
    throw Forbidden('Only the platform owner can do this', `${what} is reserved to the platform owner.`);
  }
}

function requireReason(body, min = 5) {
  const r = text(body?.reason);
  if (r.length < min) throw BadRequest('Record a reason', 'It is kept in the audit log.');
  return r;
}

async function loadTarget(id, actor) {
  const t = await one(
    `SELECT u.id, u.name, u.student_email, u.status AS account_status,
            a.status, a.permissions, a.display_name,
            (SELECT array_agg(role) FROM user_role r WHERE r.user_id = u.id AND r.status = 'active'
               AND r.role IN ('platform_owner','platform_admin','support')) AS roles,
            (SELECT array_agg(role) FROM user_role r WHERE r.user_id = u.id
               AND r.role IN ('platform_admin','support')) AS any_platform_roles
       FROM app_user u LEFT JOIN admin_account a ON a.user_id = u.id WHERE u.id = $1`, [id]);
  if (!t || (!t.roles?.length && !t.status)) throw NotFound('No such administrator');
  if (t.roles?.includes('platform_owner')) {
    throw Forbidden('The platform owner cannot be changed here',
      'Owner identity is set in server configuration (PLATFORM_OWNER_EMAIL) and nowhere else.');
  }
  if (t.id === actor.id) throw Forbidden('You cannot change your own administrator access');
  return t;
}

function effective(row) {
  const roles = row.roles || [];
  if (roles.includes('platform_owner')) return { permissions: Object.keys(PERMISSIONS), source: 'owner' };
  if (row.permissions) return { permissions: row.permissions, source: 'explicit' };
  return { permissions: [...new Set(roles.flatMap((r) => ROLE_DEFAULT_PERMISSIONS[r] || []))], source: 'role_default' };
}

const ADMIN_LIST_SQL = `
  SELECT u.id, u.name, u.student_email AS email, u.status AS account_status,
         coalesce(a.status, CASE WHEN r.roles IS NOT NULL THEN 'active' END) AS status,
         a.permissions, a.invited_at, a.activated_at, a.suspended_at, a.revoked_at, a.status_reason,
         a.permissions_updated_at, ib.name AS invited_by_name, r.roles,
         (SELECT count(*)::int FROM webauthn_credential w WHERE w.user_id = u.id AND w.revoked_at IS NULL) AS passkeys,
         (SELECT max(issued_at) FROM session s WHERE s.user_id = u.id AND s.auth_method = 'passkey') AS last_sign_in_at,
         (SELECT count(*)::int FROM session s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
         (SELECT max(at) FROM audit_log l WHERE l.actor_id = u.id) AS last_activity_at
    FROM app_user u
    LEFT JOIN admin_account a ON a.user_id = u.id
    LEFT JOIN app_user ib ON ib.id = a.invited_by
    LEFT JOIN LATERAL (SELECT array_agg(role ORDER BY role) AS roles FROM user_role x
                        WHERE x.user_id = u.id AND x.status = 'active'
                          AND x.role IN ('platform_owner','platform_admin','support')) r ON true
   WHERE a.user_id IS NOT NULL OR r.roles IS NOT NULL`;

export default async function adminAccessRoutes(app) {
  app.get('/admin/access/catalog', async (req) => {
    authorize(req.actor, 'admin.read');
    return { ...catalogue(), inviteTtlHours: ADMIN.inviteTtlHours, emailDelivery: emailConfigured() };
  });

  app.get('/admin/access/me', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    return { isOwner: !!req.actor.isOwner, permissions: req.actor.permissions || [], adminStatus: req.actor.adminStatus };
  });

  app.get('/admin/access/admins', async (req) => {
    authorize(req.actor, 'admin.read');
    const { rows } = await q(`${ADMIN_LIST_SQL} ORDER BY ('platform_owner' = ANY(r.roles)) DESC NULLS LAST, u.name`);
    return {
      administrators: rows.map((row) => ({
        ...row, isOwner: !!row.roles?.includes('platform_owner'), effective: effective(row),
      })),
    };
  });

  app.get('/admin/access/admins/:id', async (req) => {
    authorize(req.actor, 'admin.read');
    const row = await one(`${ADMIN_LIST_SQL} AND u.id = $1`, [req.params.id]);
    if (!row) throw NotFound('No such administrator');
    const credentials = (await q(
      `SELECT id, label, created_at, last_used_at, backed_up, revoked_at FROM webauthn_credential
        WHERE user_id = $1 ORDER BY created_at DESC`, [row.id])).rows;
    /* Session metadata only - never a token or its hash. */
    const sessions = (await q(
      `SELECT issued_at, expires_at, auth_method, ip, left(coalesce(user_agent,''), 120) AS user_agent
         FROM session WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY issued_at DESC LIMIT 20`, [row.id])).rows;
    const activity = (await q(
      `SELECT at, action, resource, resource_id, outcome FROM audit_log
        WHERE actor_id = $1 ORDER BY at DESC LIMIT 100`, [row.id])).rows;
    const history = (await q(
      `SELECT l.at, l.action, l.outcome, l.detail, u.name AS actor_name FROM audit_log l
         LEFT JOIN app_user u ON u.id = l.actor_id
        WHERE (l.resource = 'admin_account' AND l.resource_id = $1)
           OR (l.resource = 'admin_invitation' AND l.detail->>'email' = $2)
        ORDER BY l.at DESC LIMIT 50`, [row.id, row.email])).rows;
    return { administrator: { ...row, isOwner: !!row.roles?.includes('platform_owner'), effective: effective(row) },
             credentials, sessions, activity, history };
  });

  /* ---------- invite ------------------------------------------------------ */
  app.post('/admin/access/invitations', async (req) => {
    authorize(req.actor, 'admin.invite');
    assertOwner(req.actor, 'Inviting an administrator');
    assertRecentPasskey(req.actor, 'inviting an administrator');
    const b = req.body || {};
    const name = text(b.name, 80);
    if (name.length < 2) throw BadRequest('Enter the administrator\'s name');
    const email = normaliseStudentEmail(b.email);
    const role = b.role || 'platform_admin';
    if (!['platform_admin', 'support'].includes(role)) throw BadRequest('Role must be platform_admin or support');
    const check = validatePermissionList(b.permissions);
    if (!check.ok) throw BadRequest('Choose the permissions to grant', check.problem);
    if (!check.permissions.length) throw BadRequest('Grant at least one permission');

    const target = await tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('student-email:' || $1))`, [email]);
      const u = (await c.query(`SELECT * FROM app_user WHERE student_email = $1`, [email])).rows[0];
      if (!u) {
        /* Nobody has proven this mailbox yet, so no account is created. The
           invitation waits, keyed by email, and takes effect when that mailbox
           signs in with its email code (services/admin-credentials.js). */
        await c.query(`UPDATE admin_invitation SET revoked_at = now() WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [email]);
        const s = newInviteSecret();
        const row = (await c.query(
          `INSERT INTO admin_invitation (email, name, role, permissions, invited_by, code_hash, salt, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' hours')::interval) RETURNING id, expires_at`,
          [email, name, role, check.permissions, req.actor.id, s.codeHash, s.salt, String(ADMIN.inviteTtlHours)])).rows[0];
        return { pending: true, invitationId: row.id, code: s.code, expiresAt: row.expires_at };
      }
      const owner = (await c.query(`SELECT 1 FROM user_role WHERE user_id = $1 AND role = 'platform_owner' AND status = 'active'`, [u.id])).rows[0];
      if (owner) throw Conflict('That is the platform owner\'s address');
      const live = (await c.query(`SELECT status FROM admin_account WHERE user_id = $1`, [u.id])).rows[0];
      if (live && ['active', 'suspended'].includes(live.status)) {
        throw Conflict(`That person is already an administrator (${live.status})`, 'Change their permissions or restore them instead.');
      }
      if (u.status !== 'active') throw Conflict('That account is suspended', 'Reinstate the account first.');
      if (!u.name) await c.query(`UPDATE app_user SET name = $2 WHERE id = $1`, [u.id, name]);
      await c.query(
        `INSERT INTO user_role (user_id, role, granted_by, granted_via) VALUES ($1,$2,$3,'api')
         ON CONFLICT (user_id, role, COALESCE(vendor_id,'00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET status = 'active', revoked_at = NULL, granted_by = $3, granted_at = now()`,
        [u.id, role, req.actor.id]);
      await c.query(
        `INSERT INTO admin_account (user_id, status, permissions, display_name, invited_by, invited_at,
                                    permissions_updated_at, permissions_updated_by)
         VALUES ($1,'invited',$2,$3,$4, now(), now(), $4)
         ON CONFLICT (user_id) DO UPDATE SET status = 'invited', permissions = $2, display_name = $3,
                invited_by = $4, invited_at = now(), revoked_at = NULL, suspended_at = NULL, status_reason = NULL,
                permissions_updated_at = now(), permissions_updated_by = $4, updated_at = now()`,
        [u.id, check.permissions, name, req.actor.id]);
      return u;
    });

    if (target.pending) {
      const out = await sendInvite(req, { code: target.code, expiresAt: target.expiresAt }, email, name);
      if (out.emailed) await q(`UPDATE admin_invitation SET email_sent_at = now() WHERE id = $1`, [target.invitationId]);
      await audit(req, { action: 'admin.invite', resource: 'admin_invitation', resourceId: target.invitationId, outcome: 'ok',
                         detail: { email, role, permissions: check.permissions, emailed: out.emailed, expiresAt: out.expiresAt, accountExists: false } });
      return { administrator: { id: null, invitationId: target.invitationId, name, email, role, status: 'invited', permissions: check.permissions }, ...out };
    }
    const out = await deliverInvite(req, target.id, email, name);
    await audit(req, { action: 'admin.invite', resource: 'admin_account', resourceId: target.id, outcome: 'ok',
                       detail: { email, role, permissions: check.permissions, emailed: out.emailed, expiresAt: out.expiresAt, accountExists: true } });
    return { administrator: { id: target.id, name, email, role, status: 'invited', permissions: check.permissions }, ...out };
  });

  app.get('/admin/access/invitations', async (req) => {
    authorize(req.actor, 'admin.read');
    const { rows } = await q(
      `SELECT i.id, i.email, i.name, i.role, i.permissions, i.created_at, i.expires_at, i.email_sent_at,
              i.accepted_at, i.revoked_at, u.name AS invited_by_name,
              CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.accepted_at IS NOT NULL THEN 'accepted'
                   WHEN i.expires_at <= now() THEN 'expired' ELSE 'waiting' END AS state
         FROM admin_invitation i JOIN app_user u ON u.id = i.invited_by
        ORDER BY i.created_at DESC LIMIT 100`);
    return { invitations: rows };
  });

  app.post('/admin/access/invitations/:id/revoke', async (req) => {
    authorize(req.actor, 'admin.invite');
    assertOwner(req.actor, 'Cancelling an administrator invitation');
    assertRecentPasskey(req.actor, 'cancelling an administrator invitation');
    const row = await one(`UPDATE admin_invitation SET revoked_at = now()
                            WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id, email`, [req.params.id]);
    if (!row) throw Conflict('No open invitation with that id');
    await audit(req, { action: 'admin.invite.cancel', resource: 'admin_invitation', resourceId: row.id, outcome: 'ok', detail: { email: row.email } });
    return { ok: true };
  });

  app.post('/admin/access/admins/:id/invite', async (req) => {
    authorize(req.actor, 'admin.invite');
    assertOwner(req.actor, 'Re-issuing an administrator invitation');
    assertRecentPasskey(req.actor, 'inviting an administrator');
    const t = await loadTarget(req.params.id, req.actor);
    if (t.status !== 'invited') throw Conflict(`This administrator is ${t.status || 'not invited'}`, 'Only an invited administrator gets a new invitation.');
    const out = await deliverInvite(req, t.id, t.student_email, t.display_name || t.name);
    await audit(req, { action: 'admin.invite.reissue', resource: 'admin_account', resourceId: t.id, outcome: 'ok',
                       detail: { emailed: out.emailed, expiresAt: out.expiresAt } });
    return out;
  });

  async function deliverInvite(req, userId, email, name) {
    const inv = await issueInvite(userId, { issuedBy: req.actor.id });
    return sendInvite(req, inv, email, name);
  }

  async function sendInvite(req, inv, email, name) {
    const site = HTTP.origin.split(',').map((s) => s.trim()).find((o) => /admin/.test(o)) || HTTP.origin.split(',')[0];
    if (emailConfigured()) {
      try {
        await sendEmail({
          kind: 'admin_invite', to: email, secret: inv.code, log: req.log,
          subject: 'You have been invited to administer ECHO ECHO',
          text:
`Hello ${name},

The ECHO ECHO platform owner has invited you to Campus Control.

1. Open ${site} and sign in with this university email address (${email}).
2. When asked, enter this one-time invitation code: ${inv.code}
3. Create a passkey on your device (fingerprint, face, Windows Hello or device PIN).

The code works once and expires ${new Date(inv.expiresAt).toUTCString()}.
Nobody from ECHO ECHO will ever ask you for it. If you did not expect this, ignore this email.`,
        });
        return { emailed: true, expiresAt: inv.expiresAt,
                 note: 'The invitation code was emailed. It is not shown here.' };
      } catch (e) {
        req.log.warn({ code: e.code }, 'admin invite email not sent; returning the code to the owner once');
      }
    }
    return { emailed: false, inviteCode: inv.code, expiresAt: inv.expiresAt,
             note: 'Email could not be sent. Give this one-time code to the administrator in person or over a channel you trust. It is shown once.' };
  }

  /* ---------- permissions ------------------------------------------------- */
  app.put('/admin/access/admins/:id/permissions', async (req) => {
    authorize(req.actor, 'admin.permissions');
    assertOwner(req.actor, 'Changing administrator permissions');
    assertRecentPasskey(req.actor, 'changing administrator permissions');
    const t = await loadTarget(req.params.id, req.actor);
    const reason = requireReason(req.body);
    if (t.status === 'revoked') throw Conflict('Access is revoked', 'Restore it first.');
    const check = validatePermissionList(req.body?.permissions);
    if (!check.ok) throw BadRequest('Invalid permissions', check.problem);
    const before = effective(t);
    await q(
      `INSERT INTO admin_account (user_id, status, permissions, permissions_updated_at, permissions_updated_by, activated_at)
       VALUES ($1,'active',$2, now(), $3, now())
       ON CONFLICT (user_id) DO UPDATE SET permissions = $2, permissions_updated_at = now(),
              permissions_updated_by = $3, updated_at = now()`, [t.id, check.permissions, req.actor.id]);
    const added = check.permissions.filter((p) => !before.permissions.includes(p));
    const removed = before.permissions.filter((p) => !check.permissions.includes(p));
    await audit(req, { action: 'admin.permissions.update', resource: 'admin_account', resourceId: t.id, outcome: 'ok',
                       detail: { reason, added, removed, before: before.permissions, after: check.permissions } });
    return { id: t.id, permissions: check.permissions, added, removed,
             note: 'Applied to their open sessions on their next request.' };
  });

  /* ---------- lifecycle --------------------------------------------------- */
  app.post('/admin/access/admins/:id/suspend', async (req) => {
    authorize(req.actor, 'admin.suspend');
    assertRecentPasskey(req.actor, 'suspending an administrator');
    const t = await loadTarget(req.params.id, req.actor);
    const reason = requireReason(req.body);
    if (t.status === 'suspended') throw Conflict('Already suspended');
    if (t.status === 'revoked') throw Conflict('Access is already revoked');
    await tx(async (c) => {
      await c.query(
        `INSERT INTO admin_account (user_id, status, suspended_at, suspended_by, status_reason, activated_at)
         VALUES ($1,'suspended', now(), $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE SET status = 'suspended', suspended_at = now(), suspended_by = $2,
                status_reason = $3, updated_at = now()`, [t.id, req.actor.id, reason]);
      await c.query(`UPDATE session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.id]);
    });
    await audit(req, { action: 'admin.suspend', resource: 'admin_account', resourceId: t.id, outcome: 'ok',
                       detail: { reason, from: t.status || 'active' } });
    return { id: t.id, status: 'suspended', note: 'All their sessions were ended. Their passkeys are kept for a restore.' };
  });

  app.post('/admin/access/admins/:id/restore', async (req) => {
    authorize(req.actor, 'admin.restore');
    assertOwner(req.actor, 'Restoring administrator access');
    assertRecentPasskey(req.actor, 'restoring an administrator');
    const t = await loadTarget(req.params.id, req.actor);
    const reason = requireReason(req.body);
    if (!['suspended', 'revoked'].includes(t.status)) throw Conflict(`This administrator is ${t.status || 'active'}`);
    const role = t.any_platform_roles?.[0] || 'platform_admin';
    const hasPasskey = (await one(`SELECT count(*)::int n FROM webauthn_credential WHERE user_id = $1 AND revoked_at IS NULL`, [t.id])).n > 0;
    const status = hasPasskey ? 'active' : 'invited';
    await tx(async (c) => {
      await c.query(
        `INSERT INTO user_role (user_id, role, granted_by, granted_via) VALUES ($1,$2,$3,'api')
         ON CONFLICT (user_id, role, COALESCE(vendor_id,'00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET status = 'active', revoked_at = NULL, granted_by = $3, granted_at = now()`, [t.id, role, req.actor.id]);
      await c.query(`UPDATE admin_account SET status = $2, status_reason = $3, suspended_at = NULL, revoked_at = NULL,
                            updated_at = now() WHERE user_id = $1`, [t.id, status, reason]);
    });
    await audit(req, { action: 'admin.restore', resource: 'admin_account', resourceId: t.id, outcome: 'ok',
                       detail: { reason, from: t.status, to: status, role } });
    return { id: t.id, status, permissions: effective({ ...t, roles: [role] }).permissions,
             note: hasPasskey ? 'Access restored with the permissions they had.'
                              : 'Their passkeys were revoked, so they need a new invitation: POST /admin/access/admins/:id/invite.' };
  });

  app.post('/admin/access/admins/:id/revoke', async (req) => {
    authorize(req.actor, 'admin.revoke');
    assertOwner(req.actor, 'Revoking administrator access');
    assertRecentPasskey(req.actor, 'revoking an administrator');
    const t = await loadTarget(req.params.id, req.actor);
    const reason = requireReason(req.body);
    if (t.status === 'revoked') throw Conflict('Access is already revoked');
    const counts = await tx(async (c) => {
      await c.query(
        `INSERT INTO admin_account (user_id, status, revoked_at, revoked_by, status_reason)
         VALUES ($1,'revoked', now(), $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET status = 'revoked', revoked_at = now(), revoked_by = $2,
                status_reason = $3, updated_at = now()`, [t.id, req.actor.id, reason]);
      const roles = (await c.query(`UPDATE user_role SET status = 'revoked', revoked_at = now()
                      WHERE user_id = $1 AND role IN ('platform_admin','support') AND status = 'active'`, [t.id])).rowCount;
      const passkeys = (await c.query(`UPDATE webauthn_credential SET revoked_at = now(), revoked_by = $2
                      WHERE user_id = $1 AND revoked_at IS NULL`, [t.id, req.actor.id])).rowCount;
      await c.query(`UPDATE admin_recovery_code SET revoked_at = now() WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [t.id]);
      await c.query(`UPDATE admin_passkey_invite SET revoked_at = now() WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [t.id]);
      const sessions = (await c.query(`UPDATE session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.id])).rowCount;
      return { roles, passkeys, sessions };
    });
    await audit(req, { action: 'admin.revoke', resource: 'admin_account', resourceId: t.id, outcome: 'ok',
                       detail: { reason, ...counts } });
    return { id: t.id, status: 'revoked', ...counts,
             note: 'Administrator roles, passkeys, recovery codes, pending invites and every session were revoked. Their student account is unaffected.' };
  });

  app.post('/admin/access/admins/:id/sessions/revoke', async (req) => {
    authorize(req.actor, 'session.revoke');
    assertRecentPasskey(req.actor, 'signing an administrator out');
    const t = await loadTarget(req.params.id, req.actor);
    const reason = requireReason(req.body);
    const n = (await q(`UPDATE session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.id])).rowCount;
    await audit(req, { action: 'admin.sessions.revoke', resource: 'admin_account', resourceId: t.id, outcome: 'ok',
                       detail: { reason, sessions: n } });
    return { id: t.id, sessionsRevoked: n };
  });
}
