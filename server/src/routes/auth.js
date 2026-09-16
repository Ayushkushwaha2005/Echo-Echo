/* ==========================================================================
   QUAD — AUTH ROUTES

   One way in per audience, and the role is never something the request
   asks for. Students prove their university mailbox with a six-digit code
   sent to it; administrators sign in with a password and an authenticator
   code (routes/admin-signin.js). The role is read from the database after
   verification and the landing surface is derived from it server-side, so
   "select Admin and get admin" is not expressible on any request here.
   ========================================================================== */
import { issueSession, revokeSession, cookieOptions } from '../auth/session.js';
import { landingSurface, SURFACE_ROLES, Forbidden, HttpError, verificationView } from '../auth/rbac.js';
import { q, one, tx } from '../db/index.js';
import { SESSION, PLATFORM_OWNER, providerStatus, RATE_LIMITS, STUDENT_EMAIL, ADMIN } from '../config.js';
import { audit } from '../audit.js';
import { flag } from '../services/flags.js';
import { acceptPendingInvitation } from '../services/admin-credentials.js';
import { profileOf, validateMobile } from '../services/profile.js';
import {
  normaliseStudentEmail, sendStudentEmailCode, verifyStudentEmailCode, recordMailboxProof,
  isConfigured as emailConfigured,
} from '../services/student-email.js';

/* Administrators named in server configuration, identified by a mailbox the
   email-code flow has just proven. The role grants nothing by itself: every
   administrator power needs a passkey session, and the first passkey needs a
   one-time invite issued on the server. */
export async function grantConfiguredAdminRoles(c, userId, email) {
  const grant = async (role) => c.query(
    `INSERT INTO user_role (user_id, role, granted_via) VALUES ($1,$2,'bootstrap_config')
     ON CONFLICT (user_id, role, COALESCE(vendor_id,'00000000-0000-0000-0000-000000000000'::uuid))
     DO NOTHING`, [userId, role]);
  if (PLATFORM_OWNER.emailValid && email === PLATFORM_OWNER.email) {
    /* One owner. If the owner is identified by email alone, any other owner
       row becomes an admin, exactly as migrate.js does for the phone owner. */
    if (!PLATFORM_OWNER.phoneValid) {
      await c.query(`UPDATE user_role SET role = 'platform_admin' WHERE role = 'platform_owner' AND user_id <> $1
                       AND NOT EXISTS (SELECT 1 FROM user_role x WHERE x.user_id = user_role.user_id AND x.role = 'platform_admin')`, [userId]);
      await c.query(`UPDATE user_role SET status = 'revoked', revoked_at = now() WHERE role = 'platform_owner' AND user_id <> $1`, [userId]);
    }
    await grant('platform_owner');
  } else if (ADMIN.emails.includes(email)) {
    await grant('platform_admin');
  }
}

export default async function authRoutes(app) {
  /* Surfaces call this on boot to know what is actually available, so they
     can render a truthful unavailable state instead of a dead form. */
  app.get('/auth/status', async () => ({
    /* Phone sign-in no longer exists. Reported as permanently unconfigured
       so an older cached bundle renders its unavailable state rather than a
       form that cannot work. */
    otp: { configured: false, removed: true },
    email: { configured: emailConfigured(), domains: STUDENT_EMAIL.domains,
             codeLength: STUDENT_EMAIL.length },
    providers: providerStatus(),
  }));

  /* ---------- institutional email: the zero-cost student sign-in ---------
     One step signs the student in AND proves mailbox control. The account is
     keyed by the verified mailbox; no role is taken from the request. */
  app.post('/auth/email/send', {
    config: { rateLimit: { max: RATE_LIMITS.emailSend, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req) => {
    const email = normaliseStudentEmail(req.body?.email);
    const out = await sendStudentEmailCode(email, { purpose: 'login', ip: req.ip });
    await audit(req, { action: 'auth.email.send', resource: 'student_email', resourceId: email, outcome: 'ok' });
    /* Same answer whether or not an account exists. */
    return { sent: true, email, expiresAt: out.expiresAt,
             resendAfterSeconds: out.resendAfterSeconds, length: out.length };
  });

  app.post('/auth/email/verify', {
    config: { rateLimit: { max: RATE_LIMITS.emailVerify, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req, reply) => {
    const email = normaliseStudentEmail(req.body?.email);
    try {
      await verifyStudentEmailCode(email, req.body?.code, { purpose: 'login' });
    } catch (e) {
      await audit(req, { action: 'auth.email.verify', resource: 'student_email', resourceId: email,
                         outcome: 'denied', detail: { message: e.message } });
      throw e;
    }

    const { user, created, proof } = await tx(async (c) => {
      /* Serialise account creation for one mailbox. */
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('student-email:' || $1))`, [email]);
      let u = (await c.query(`SELECT * FROM app_user WHERE student_email = $1`, [email])).rows[0];
      let created = false;
      if (!u) {
        u = (await c.query(
          `INSERT INTO app_user (student_email, student_email_verified_at)
           VALUES ($1, now()) RETURNING *`, [email])).rows[0];
        created = true;
        await c.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'student') ON CONFLICT DO NOTHING`, [u.id]);
      }
      /* A suspended account gains nothing from a code, including a status change. */
      if (u.status !== 'active') return { user: u, created, proof: { before: u.student_status, after: u.student_status } };
      const proof = await recordMailboxProof(c, u.id, email);
      await grantConfiguredAdminRoles(c, u.id, email);
      /* An owner's invitation to this mailbox takes effect only now that the
         mailbox is proven. It grants nothing usable until a passkey exists. */
      await acceptPendingInvitation(c, u.id, email);
      u = (await c.query(`SELECT * FROM app_user WHERE id = $1`, [u.id])).rows[0];
      return { user: u, created, proof };
    });

    if (user.status !== 'active') {
      await audit(req, { action: 'auth.login', resourceId: user.id, outcome: 'denied',
                         detail: { reason: user.status, via: 'student_email' } });
      throw Forbidden('Account suspended', 'Contact campus support.');
    }

    const roles = (await q(
      `SELECT role FROM user_role WHERE user_id = $1 AND status = 'active'`, [user.id])).rows.map((r) => r.role);
    const token = await issueSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.setCookie(SESSION.cookieName, token, cookieOptions());

    await audit(req, { action: 'auth.login', resource: 'user', resourceId: user.id, outcome: 'ok',
                       detail: { created, roles, via: 'student_email', verification: proof } });
    if (proof.before !== proof.after) {
      await audit(req, { action: 'verification.email', resource: 'user', resourceId: user.id, outcome: 'ok',
                         detail: { from: proof.before, to: proof.after, email } });
    }

    return {
      user: { id: user.id, name: user.name, phone: user.phone, studentEmail: user.student_email,
              studentStatus: user.student_status },
      verification: verificationView(user.student_status, user.status),
      roles,
      surface: landingSurface(roles),
      newAccount: created,
    };
  });

  /* Contact number for payment gateways that require one. Self-declared,
     never an identity — see migration 010. */
  app.post('/auth/me/contact-phone', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const raw = req.body?.phone;
    const phone = raw === null || raw === '' ? null : validateMobile(raw);
    await q(`UPDATE app_user SET contact_phone = $2, profile_updated_at = now() WHERE id = $1`, [req.actor.id, phone]);
    await audit(req, { action: 'user.contact_phone', resource: 'user', resourceId: req.actor.id, outcome: 'ok' });
    return { contactPhone: phone };
  });

  /* ---------- phone sign-in: removed --------------------------------------
     There is no phone login in this product. Students sign in with their
     institutional mailbox; administrators with a password and an
     authenticator code. A phone number is collected once, at checkout, as
     the delivery contact number — it is never an identity and never opens a
     session.

     These two endpoints answered on this path until migration 018. They are
     answered explicitly rather than left to the 404 handler so that an old
     cached bundle, or anything still pointed at them, gets a truthful
     reason instead of looking like a routing fault. */
  const phoneGone = async () => {
    throw new HttpError(410, 'endpoint_removed', 'Phone sign-in has been removed',
      'Sign in with your university student email. A phone number is only used as a delivery contact.');
  };
  app.post('/auth/otp/send', phoneGone);
  app.post('/auth/otp/verify', phoneGone);

  app.post('/auth/logout', async (req, reply) => {
    await revokeSession(req.cookies?.[SESSION.cookieName]);
    reply.clearCookie(SESSION.cookieName, { path: '/' });
    await audit(req, { action: 'auth.logout', outcome: 'ok' });
    return { ok: true };
  });

  /* The client's single source of truth about who it is talking to. */
  app.get('/auth/me', async (req) => {
    if (!req.actor) return { authenticated: false };
    const partner = await one(
      `SELECT status, online FROM partner_profile WHERE user_id = $1`, [req.actor.id]);
    const vcase = await one(
      `SELECT state, method, submitted_at, sla_due_at FROM verification_case
        WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1`, [req.actor.id]);
    const extra = await one(
      `SELECT student_email, contact_phone, partner_photo_asset IS NOT NULL AS has_partner_photo
         FROM app_user WHERE id = $1`, [req.actor.id]);
    return {
      authenticated: true,
      user: {
        id: req.actor.id, name: req.actor.name, phone: req.actor.phone,
        studentEmail: extra?.student_email || null, contactPhone: extra?.contact_phone || null,
        hasPartnerPhoto: !!extra?.has_partner_photo,
        studentStatus: req.actor.studentStatus,
        verificationState: verificationView(req.actor.studentStatus, req.actor.status).state,
      },
      verificationStatus: verificationView(req.actor.studentStatus, req.actor.status),
      profile: await profileOf(req.actor.id),
      /* The live-location check. `required` is the admin feature flag;
         `confirmed` is what this session actually proved, read from the
         session row — the browser is told, never asked. */
      location: {
        required: await flag('live_location'),
        confirmed: !!req.actor.campusPresenceAt,
        confirmedAt: req.actor.campusPresenceAt,
        accuracyM: req.actor.campusPresenceAccuracyM,
        campusId: req.actor.campusPresenceSiteId,
      },
      roles: req.actor.roles,
      /* Granular administrator permissions usable from THIS session. The
         surfaces use them to hide controls; the server enforces them. */
      permissions: req.actor.permissions || [],
      isOwner: !!req.actor.isOwner,
      vendorIds: req.actor.vendorIds,
      surface: landingSurface(req.actor.roles),
      surfaces: Object.entries(SURFACE_ROLES)
        .filter(([, allowed]) => req.actor.roles.some((r) => allowed.includes(r)))
        .map(([s]) => s),
      partner: partner || null,
      verification: vcase || null,
      /* Administrator roles this account holds but this session may not use
         until it is confirmed with a passkey. The surfaces use it to show the
         passkey step instead of a permission error. */
      passkey: {
        withheldRoles: req.actor.withheldRoles || [],
        adminSurfacesPending: Object.entries(SURFACE_ROLES)
          .filter(([s, allowed]) => (req.actor.withheldRoles || []).some((r) => allowed.includes(r)) &&
                                   !req.actor.roles.some((r) => allowed.includes(r)))
          .map(([s]) => s),
        sessionVerified: req.actor.sessionKind === 'passkey' && !!req.actor.passkeyAt,
        recoverySession: req.actor.sessionKind === 'recovery',
      },
    };
  });
}
