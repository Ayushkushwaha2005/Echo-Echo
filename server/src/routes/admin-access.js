/* ==========================================================================
   ECHO ECHO - ADMINISTRATOR ACCESS (owner-managed)

   GET  /admin/access/catalog                     admins.view
   GET  /admin/access/admins                      admins.view
   GET  /admin/access/admins/:id                  admins.view   (+ activity)
   POST /admin/access/invitations                 owner only    name, email, permissions
   POST /admin/access/invitations/:id/resend      owner only    new link, old link dies
   POST /admin/access/invitations/:id/revoke      owner only
   POST /admin/access/admins/:id/invite           owner only    new link for a stuck 'invited' account
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
     - an invitation link is shown to the owner only when email delivery is
       not available, exactly once, and is never logged;
     - inviting grants nothing. Only services/admin-invitation.js complete()
       creates a role, an active administrator or a credential.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { authorize, can, BadRequest, NotFound, Forbidden, Conflict } from '../auth/rbac.js';
import { deviceName, sessionHandle } from '../services/device.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { catalogue, validatePermissionList, PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from '../auth/permissions.js';
import { emailConfigured } from '../services/email.js';
import {
  normaliseStaffEmail, newLinkToken, inviteLink, sendInvitationEmail, RESEND_COOLDOWN_SECONDS,
} from '../services/admin-invitation.js';
import { ADMIN, HTTP } from '../config.js';
import { audit, auditTx } from '../audit.js';

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
    `SELECT u.id, u.name, u.student_email, coalesce(u.staff_email, u.student_email) AS admin_email, u.status AS account_status,
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
  SELECT u.id, COALESCE(pr.display_name, u.name) AS name, coalesce(u.staff_email, u.student_email) AS email, u.status AS account_status,
         pr.photo_asset IS NOT NULL AS has_photo,
         coalesce(a.status, CASE WHEN r.roles IS NOT NULL THEN 'active' END) AS status,
         a.permissions, a.invited_at, a.activated_at, a.suspended_at, a.revoked_at, a.status_reason,
         a.permissions_updated_at, COALESCE(ibp.display_name, ib.name) AS invited_by_name, r.roles,
         (SELECT count(*)::int FROM webauthn_credential w WHERE w.user_id = u.id AND w.revoked_at IS NULL) AS passkeys,
         /* Whether this administrator can actually sign in: a password AND
            a confirmed authenticator. Never the values themselves. */
         (SELECT ac.password_hash IS NOT NULL AND ac.totp_confirmed_at IS NOT NULL
            FROM admin_credential ac WHERE ac.user_id = u.id) AS "signInReady",
         (SELECT max(issued_at) FROM session s WHERE s.user_id = u.id AND s.auth_method IN ('passkey','admin_totp')) AS last_sign_in_at,
         (SELECT count(*)::int FROM session s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions,
         (SELECT max(at) FROM audit_log l WHERE l.actor_id = u.id) AS last_activity_at
    FROM app_user u
    LEFT JOIN admin_account a ON a.user_id = u.id
    LEFT JOIN admin_profile pr ON pr.user_id = u.id
    LEFT JOIN app_user ib ON ib.id = a.invited_by
    LEFT JOIN admin_profile ibp ON ibp.user_id = a.invited_by
    LEFT JOIN LATERAL (SELECT array_agg(role ORDER BY role) AS roles FROM user_role x
                        WHERE x.user_id = u.id AND x.status = 'active'
                          AND x.role IN ('platform_owner','platform_admin','support')) r ON true
   WHERE (a.user_id IS NOT NULL OR r.roles IS NOT NULL)`;

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
    const sessions = can(req.actor, 'session.read') ? (await q(
      `SELECT token_hash, issued_at, expires_at, last_seen_at, auth_method, ip, left(coalesce(user_agent,''), 200) AS user_agent
         FROM session WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY coalesce(last_seen_at, issued_at) DESC LIMIT 20`, [row.id])).rows.map(({ token_hash, ...s }) => ({
      ...s, handle: sessionHandle(token_hash), device: deviceName(s.user_agent),
    })) : [];
    const activity = (await q(
      `SELECT at, action, resource, resource_id, outcome FROM audit_log
        WHERE actor_id = $1 ORDER BY at DESC LIMIT 100`, [row.id])).rows;
    const history = (await q(
      `SELECT l.at, l.action, l.outcome, l.detail, COALESCE(up.display_name, u.name) AS actor_name FROM audit_log l
         LEFT JOIN app_user u ON u.id = l.actor_id
         LEFT JOIN admin_profile up ON up.user_id = l.actor_id
        WHERE (l.resource = 'admin_account' AND l.resource_id = $1)
           OR (l.resource = 'admin_invitation' AND l.detail->>'email' = $2)
        ORDER BY l.at DESC LIMIT 50`, [row.id, row.email])).rows;
    return { administrator: { ...row, isOwner: !!row.roles?.includes('platform_owner'), effective: effective(row) },
             credentials, sessions, activity, history };
  });

  /* ---------- invite ------------------------------------------------------
     Writes one invitation row and nothing else. No account, role or
     admin_account appears until the invited person finishes the whole flow. */
  async function createInvitation(req, { email, name, role, permissions }) {
    const link = newLinkToken();
    const row = await tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('student-email:' || $1))`, [email]);
      const u = (await c.query(`SELECT * FROM app_user WHERE student_email = $1 OR staff_email = $1`, [email])).rows[0];
      if (u) {
        const owner = (await c.query(`SELECT 1 FROM user_role WHERE user_id = $1 AND role = 'platform_owner' AND status = 'active'`, [u.id])).rows[0];
        if (owner) throw Conflict('That is the platform owner\'s address');
        const live = (await c.query(`SELECT status FROM admin_account WHERE user_id = $1`, [u.id])).rows[0];
        if (live && ['active', 'suspended'].includes(live.status)) {
          throw Conflict(`That person is already an administrator (${live.status})`, 'Change their permissions or restore them instead.');
        }
        if (u.status !== 'active') throw Conflict('That account is suspended', 'Reinstate the account first.');
      }
      const open = (await c.query(
        `SELECT id, expires_at, token_hash FROM admin_invitation
          WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`, [email])).rows[0];
      if (open && open.token_hash && new Date(open.expires_at) > new Date()) {
        /* Never silently replace a live link: the owner chooses to resend or cancel. */
        throw Conflict('This person already has an open invitation', 'Resend it or cancel it instead.');
      }
      if (open) {
        await c.query(`UPDATE admin_invitation SET revoked_at = now(), revoked_by = $2 WHERE id = $1`, [open.id, req.actor.id]);
        await auditTx(c, req, { action: 'admin.invite.cancel', resource: 'admin_invitation', resourceId: open.id, detail: { email, reason: 'superseded_expired_or_legacy' } });
      }
      const inserted = (await c.query(
        `INSERT INTO admin_invitation (email, name, role, permissions, invited_by, token_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval) RETURNING id, expires_at`,
        [email, name, role, permissions, req.actor.id, link.tokenHash, String(ADMIN.inviteTtlHours)])).rows[0];
      await auditTx(c, req, { action: 'admin.invite', resource: 'admin_invitation', resourceId: inserted.id,
                              detail: { email, role, permissions, expiresAt: inserted.expires_at, accountExists: !!u } });
      return inserted;
    });
    return { id: row.id, expiresAt: row.expires_at, token: link.token };
  }

  /* Delivery happens after the commit: a provider outage must not undo the
     invitation, and the owner is told plainly which case this is. */
  async function deliver(req, invitationId, { token, expiresAt }, email, name) {
    /* The name the invitee sees is the inviter's Campus Control display name
       (admin_profile), not the raw student-account name, which may be a
       nickname or misspelt and is not theirs to present to staff. */
    const inviterName = (await q(
      `SELECT COALESCE(p.display_name, u.name) AS name FROM app_user u
         LEFT JOIN admin_profile p ON p.user_id = u.id WHERE u.id = $1`, [req.actor.id])).rows[0]?.name || null;
    let emailed = false;
    if (emailConfigured()) {
      try {
        await sendInvitationEmail({ email, name, token, expiresAt, inviterName, log: req.log });
        emailed = true;
      } catch (e) {
        req.log.warn({ code: e.code }, 'admin invitation email not sent; returning the link to the owner once');
      }
    }
    await q(`UPDATE admin_invitation SET send_count = send_count + 1, last_sent_at = now(),
                    email_sent_at = CASE WHEN $2 THEN now() ELSE email_sent_at END WHERE id = $1`, [invitationId, emailed]);
    return emailed
      ? { emailed: true, expiresAt, note: 'The invitation link was emailed. It is not shown here.' }
      : { emailed: false, inviteLink: inviteLink(token), expiresAt,
          note: 'Email could not be sent. Give this link to the person over a channel you trust. It is shown once.' };
  }

  app.post('/admin/access/invitations', async (req) => {
    authorize(req.actor, 'admin.invite');
    assertOwner(req.actor, 'Inviting an administrator');
    assertRecentPasskey(req.actor, 'inviting an administrator');
    const b = req.body || {};
    const name = text(b.name, 80);
    if (name.length < 2) throw BadRequest('Enter the administrator\'s name');
    const email = normaliseStaffEmail(b.email);
    const role = b.role || 'platform_admin';
    if (!['platform_admin', 'support'].includes(role)) throw BadRequest('Role must be platform_admin or support');
    const check = validatePermissionList(b.permissions);
    if (!check.ok) throw BadRequest('Choose the permissions to grant', check.problem);
    if (!check.permissions.length) throw BadRequest('Grant at least one permission');

    const inv = await createInvitation(req, { email, name, role, permissions: check.permissions });
    const out = await deliver(req, inv.id, inv, email, name);
    return { administrator: { id: null, invitationId: inv.id, name, email, role, status: 'invited', permissions: check.permissions }, ...out };
  });

  app.get('/admin/access/invitations', async (req) => {
    authorize(req.actor, 'admin.read');
    const { rows } = await q(
      `SELECT i.id, i.email, i.name, i.role, i.permissions, i.created_at, i.expires_at, i.email_sent_at, i.send_count, i.last_sent_at,
              i.accepted_at, i.revoked_at, COALESCE(ip.display_name, u.name) AS invited_by_name,
              i.email_verified_at IS NOT NULL AS email_verified, i.terms_accepted_at IS NOT NULL AS terms_accepted,
              i.token_hash IS NULL AS legacy,
              CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked' WHEN i.accepted_at IS NOT NULL THEN 'accepted'
                   WHEN i.expires_at <= now() THEN 'expired' ELSE 'waiting' END AS state
         FROM admin_invitation i JOIN app_user u ON u.id = i.invited_by
         LEFT JOIN admin_profile ip ON ip.user_id = i.invited_by
        ORDER BY i.created_at DESC LIMIT 100`);
    return { invitations: rows };
  });

  app.post('/admin/access/invitations/:id/revoke', async (req) => {
    authorize(req.actor, 'admin.invite');
    assertOwner(req.actor, 'Cancelling an administrator invitation');
    assertRecentPasskey(req.actor, 'cancelling an administrator invitation');
    await tx(async (c) => {
      const row = (await c.query(
        `UPDATE admin_invitation SET revoked_at = now(), revoked_by = $2, password_hash = NULL, password_salt = NULL,
                password_params = NULL, totp_secret_enc = NULL, otp_hash = NULL, otp_salt = NULL, setup_hash = NULL
          WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id, email`, [req.params.id, req.actor.id])).rows[0];
      if (!row) throw Conflict('No open invitation with that id');
      await auditTx(c, req, { action: 'admin.invite.cancel', resource: 'admin_invitation', resourceId: row.id, detail: { email: row.email } });
    });
    return { ok: true };
  });

  /* A new link for the same person and the same permissions. The old link
     stops working now and any progress made on it is discarded, because
     whoever holds the new link has to prove the mailbox again. */
  app.post('/admin/access/invitations/:id/resend', async (req) => {
    authorize(req.actor, 'admin.invite');
    assertOwner(req.actor, 'Resending an administrator invitation');
    assertRecentPasskey(req.actor, 'resending an administrator invitation');
    const link = newLinkToken();
    const row = await tx(async (c) => {
      const i = (await c.query(`SELECT * FROM admin_invitation WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`, [req.params.id])).rows[0];
      if (!i) throw Conflict('No open invitation with that id');
      if (i.last_sent_at && Date.now() - new Date(i.last_sent_at).getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
        throw Conflict('That invitation was sent a moment ago', 'Give it a minute before sending it again.');
      }
      const out = (await c.query(
        `UPDATE admin_invitation SET token_hash = $2, code_hash = NULL, salt = NULL, expires_at = now() + ($3 || ' hours')::interval,
                otp_hash = NULL, otp_salt = NULL, otp_expires_at = NULL, otp_attempts = 0, otp_sent_at = NULL,
                email_verified_at = NULL, setup_hash = NULL, setup_expires_at = NULL, terms_accepted_at = NULL,
                password_hash = NULL, password_salt = NULL, password_params = NULL, totp_secret_enc = NULL
          WHERE id = $1 RETURNING id, email, name, expires_at`, [i.id, link.tokenHash, String(ADMIN.inviteTtlHours)])).rows[0];
      await auditTx(c, req, { action: 'admin.invite.resend', resource: 'admin_invitation', resourceId: i.id, detail: { email: i.email, expiresAt: out.expires_at } });
      return out;
    });
    return deliver(req, row.id, { token: link.token, expiresAt: row.expires_at }, row.email, row.name);
  });

  /* Repairs an account the older flow left in 'invited'. It holds no power;
     completing this invitation is what activates it. */
  app.post('/admin/access/admins/:id/invite', async (req) => {
    authorize(req.actor, 'admin.invite');
    assertOwner(req.actor, 'Re-issuing an administrator invitation');
    assertRecentPasskey(req.actor, 'inviting an administrator');
    const t = await loadTarget(req.params.id, req.actor);
    if (t.status !== 'invited') throw Conflict(`This administrator is ${t.status || 'not invited'}`, 'Only an invited administrator gets a new invitation.');
    if (!t.admin_email) throw Conflict('This account has no email address to invite');
    const role = t.any_platform_roles?.[0] || 'platform_admin';
    const inv = await createInvitation(req, { email: t.admin_email, name: t.display_name || t.name || t.admin_email, role, permissions: t.permissions || [] });
    return deliver(req, inv.id, inv, t.admin_email, t.display_name || t.name || t.admin_email);
  });

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
    /* A restored account needs something it can actually sign in with. */
    const canSignIn = (await one(
      `SELECT (EXISTS (SELECT 1 FROM webauthn_credential WHERE user_id = $1 AND revoked_at IS NULL)
            OR EXISTS (SELECT 1 FROM admin_credential WHERE user_id = $1 AND password_hash IS NOT NULL AND totp_confirmed_at IS NOT NULL)) AS ok`, [t.id])).ok;
    const hasPasskey = canSignIn;
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
                              : 'Their sign-in was removed, so they need a new invitation.' };
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
      /* The password and authenticator go too: revoked means revoked. */
      await c.query(`DELETE FROM admin_credential WHERE user_id = $1`, [t.id]);
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

  /* One session, by its opaque handle. The handle is derived from the token
     hash and reveals neither. */
  app.post('/admin/access/admins/:id/sessions/:handle/revoke', async (req) => {
    authorize(req.actor, 'session.revoke');
    assertRecentPasskey(req.actor, 'signing an administrator out');
    const t = await loadTarget(req.params.id, req.actor);
    const reason = requireReason(req.body);
    await tx(async (c) => {
      const open = (await c.query(`SELECT token_hash FROM session WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [t.id])).rows;
      const hit = open.find((s) => sessionHandle(s.token_hash) === req.params.handle);
      if (!hit) throw NotFound('That session has already ended');
      await c.query(`UPDATE session SET revoked_at = now() WHERE token_hash = $1`, [hit.token_hash]);
      await auditTx(c, req, { action: 'admin.session.revoke_one', resource: 'admin_account', resourceId: t.id, detail: { reason } });
    });
    return { id: t.id, revoked: true };
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
