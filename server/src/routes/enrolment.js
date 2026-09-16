/* ==========================================================================
   QUAD — ENROLMENT ROUTES

   The provider-free entry path. Issuing is an administrative act; redeeming
   is public in the same sense that OTP verification is public — it proves
   possession of a secret, and only then does a session exist.
   ========================================================================== */
import { authorize, BadRequest, Forbidden } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { issueCode, redeemCode, codeStatus, assertEnrollable, TTL_MINUTES } from '../services/enrolment.js';
import { normalisePhone } from '../services/otp.js';
import { issueSession, cookieOptions } from '../auth/session.js';
import { landingSurface } from '../auth/rbac.js';
import { SESSION, RATE_LIMITS } from '../config.js';
import { q, one } from '../db/index.js';
import { audit } from '../audit.js';

export default async function enrolmentRoutes(app) {
  /* ---------- issue (admin) --------------------------------------------- */
  app.post('/admin/users/:id/enrolment', async (req) => {
    authorize(req.actor, 'user.enrol');
    assertRecentPasskey(req.actor, 'issuing a sign-in code');
    const targetRoles = await assertEnrollable(req.params.id);
    /* A sign-in code for another administrator's account is the owner's call:
       otherwise a delegated admin could sign in as a colleague. */
    if (targetRoles.some((r) => ['platform_admin', 'support'].includes(r)) && !req.actor.isOwner) {
      throw Forbidden('Only the platform owner can issue a sign-in code for an administrator');
    }

    const out = await issueCode(req.params.id, { issuedBy: req.actor.id, via: 'admin' });
    await audit(req, {
      action: 'user.enrolment.issue', resource: 'user', resourceId: req.params.id,
      outcome: 'ok', detail: { expiresAt: out.expiresAt },   // never the code
    });
    return {
      code: out.code,                       // shown once, to the issuing admin
      phone: out.phone,
      name: out.name,
      expiresAt: out.expiresAt,
      ttlMinutes: out.ttlMinutes,
      note: 'Read this code to them in person. It is shown once, works once, ' +
            'and expires. Issuing a new code invalidates this one.',
    };
  });

  app.get('/admin/users/:id/enrolment', async (req) => {
    authorize(req.actor, 'user.enrol');
    return codeStatus(req.params.id);
  });

  app.post('/admin/users/:id/enrolment/revoke', async (req) => {
    authorize(req.actor, 'user.enrol');
    assertRecentPasskey(req.actor, 'issuing a sign-in code');
    const r = await q(
      `UPDATE enrolment_code SET revoked_at = now()
        WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [req.params.id]);
    await audit(req, { action: 'user.enrolment.revoke', resource: 'user',
                       resourceId: req.params.id, outcome: 'ok' });
    return { revoked: r.rowCount };
  });

  /* ---------- redeem (public) -------------------------------------------
     Rate limited like the OTP endpoints, and deliberately vague about
     whether the number or the code was wrong. */
  app.post('/auth/enrol', {
    config: { rateLimit: { max: RATE_LIMITS.enrol, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req, reply) => {
    const phone = normalisePhone(req.body?.phone);
    const code = String(req.body?.code || '');
    if (!code) throw BadRequest('Enter your enrolment code');

    let userId;
    try {
      userId = await redeemCode(phone, code);
    } catch (e) {
      await audit(req, { action: 'auth.enrol', resource: 'phone', resourceId: phone,
                         outcome: 'denied', detail: { message: e.message } });
      throw e;
    }

    const roles = (await q(
      `SELECT role FROM user_role WHERE user_id = $1 AND status = 'active'`, [userId]
    )).rows.map((r) => r.role);

    /* ---- what an enrolment code is, and is not -------------------------
       It is how CAFETERIA staff sign in at the counter: a number and a code
       an administrator reads out, needing no SMS gateway and no mailbox.

       It is not a way into a student account, and it is not a way into
       Campus Control. Students sign in with their university mailbox;
       administrators with a password and an authenticator code. Allowing
       either here would be a second door onto a flow this product
       deliberately has one door for, so the session is refused after the
       code is spent rather than before — the code is burnt either way, so
       this cannot be used to probe which accounts are staff. */
    const COUNTER_ROLES = ['vendor_owner', 'vendor_staff'];
    if (!roles.some((r) => COUNTER_ROLES.includes(r))) {
      await audit(req, { action: 'auth.enrol', resource: 'user', resourceId: userId,
                         outcome: 'denied', detail: { reason: 'not_counter_staff', roles } });
      throw Forbidden('This code is for cafeteria counter staff',
        roles.includes('student') && roles.length === 1
          ? 'Students sign in with their university student email.'
          : 'Administrators sign in to Campus Control with their password and authenticator code.');
    }

    const token = await issueSession(userId, { ip: req.ip, userAgent: req.headers['user-agent'] });
    reply.setCookie(SESSION.cookieName, token, cookieOptions());

    const user = await one(`SELECT id, name, phone, student_status FROM app_user WHERE id = $1`, [userId]);
    await audit(req, { action: 'auth.enrol', resource: 'user', resourceId: userId,
                       outcome: 'ok', detail: { roles } });

    return {
      user: { id: user.id, name: user.name, phone: user.phone, studentStatus: user.student_status },
      roles,
      surface: landingSurface(roles),
      via: 'enrolment_code',
    };
  });

  /* Lets the login screen offer the enrolment path when SMS is unavailable. */
  app.get('/auth/enrol/available', async () => ({
    available: true,
    ttlMinutes: TTL_MINUTES,
    note: 'Enrolment codes are issued by an administrator and need no SMS provider.',
  }));
}
