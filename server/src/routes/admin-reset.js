/* ==========================================================================
   ECHO ECHO — CAMPUS CONTROL PASSWORD RESET

   Three steps, and the mailbox is the only thing being proved:

     POST /auth/admin/password-reset/request   email  → a code is sent
     POST /auth/admin/password-reset/verify    code   → a single-use token
     POST /auth/admin/password-reset/complete  token + new password

   What this deliberately cannot do:

     · it never opens a session. The last step ends on the sign-in screen,
       and getting in from there still needs the password AND a code from the
       authenticator app. A compromised mailbox does not reach Campus Control.
     · it never touches the authenticator secret, and there is no "reset my
       authenticator by email" anywhere in this file. Losing that device is
       handled by the owner, in person, from the server shell.
     · it never says whether an address belongs to an administrator. Every
       request answers the same way, so this is not an account-enumeration
       oracle for the people who can move money.

   The code itself is issued and checked by services/student-email.js under
   the 'admin_reset' purpose, which brings that module's rate limits, attempt
   counting, HMAC-at-rest and atomic single-use consumption with it rather
   than growing a second, less-tested copy of all four.
   ========================================================================== */
import { sendStudentEmailCode, verifyStudentEmailCode, isConfigured } from '../services/student-email.js';
import { issuePasswordReset, completePasswordReset } from '../services/admin-auth.js';
import { platformRolesOf } from '../services/admin-credentials.js';
import { revokeAllForUser } from '../auth/session.js';
import { BadRequest } from '../auth/rbac.js';
import { RATE_LIMITS } from '../config.js';
import { one } from '../db/index.js';
import { audit } from '../audit.js';

const normEmail = (v) => String(v ?? '').trim().toLowerCase();

/* The one answer every request to /request gets, whatever is true about the
   address. Said in the second person so it reads as reassurance rather than
   as a result. */
const SENT = {
  ok: true,
  message: 'If that address belongs to an administrator, a code is on its way to it.',
};

/* Resolve an address to an administrator account, or to null. Never throws
   for "not an administrator" — the caller must not be able to tell. */
async function administratorFor(email) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  const u = await one(`SELECT id, status FROM app_user WHERE student_email = $1`, [email]);
  if (!u || u.status !== 'active') return null;
  const roles = await platformRolesOf(u.id, { allowInvited: false });
  return roles.length ? u : null;
}

export default async function adminResetRoutes(app) {
  /* ---- step 1: ask for a code ---------------------------------------- */
  app.post('/auth/admin/password-reset/request', {
    config: { rateLimit: { max: RATE_LIMITS.adminLogin, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req) => {
    const email = normEmail(req.body?.email);
    const u = await administratorFor(email);

    if (!u) {
      await audit(req, { action: 'admin.password.reset.request', resource: 'admin', resourceId: email,
                         outcome: 'denied', detail: { reason: 'not_an_administrator' } });
      return SENT;
    }
    if (!isConfigured()) {
      /* Nothing can be sent, and saying so to a stranger would be an
         enumeration signal. It is recorded where an administrator will see
         it instead. */
      await audit(req, { action: 'admin.password.reset.request', resource: 'admin', resourceId: u.id,
                         outcome: 'error', detail: { reason: 'email_provider_unconfigured' } });
      return SENT;
    }

    try {
      await sendStudentEmailCode(email, { purpose: 'admin_reset', ip: req.ip });
      await audit(req, { action: 'admin.password.reset.request', resource: 'admin', resourceId: u.id, outcome: 'ok' });
    } catch (e) {
      /* A rate limit or a provider failure must not become an oracle
         either. Recorded, then answered like every other request. */
      await audit(req, { action: 'admin.password.reset.request', resource: 'admin', resourceId: u.id,
                         outcome: 'error', detail: { reason: e.code || 'send_failed' } });
    }
    return SENT;
  });

  /* ---- step 2: prove the code ---------------------------------------- */
  app.post('/auth/admin/password-reset/verify', {
    config: { rateLimit: { max: RATE_LIMITS.adminLogin, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req) => {
    const email = normEmail(req.body?.email);
    const u = await administratorFor(email);
    /* Past this point the caller has produced a code, so a specific answer
       is no longer a free probe — but there is still nothing to gain from
       distinguishing "wrong code" from "wrong address". */
    const wrong = () => BadRequest('That code has expired or was not requested', 'Request a new one.');
    if (!u) throw wrong();

    await verifyStudentEmailCode(email, req.body?.code, { purpose: 'admin_reset' });

    const { token, expiresInMinutes } = await issuePasswordReset(u.id, { ip: req.ip });
    await audit(req, { action: 'admin.password.reset.verify', resource: 'admin', resourceId: u.id, outcome: 'ok' });
    return { token, expiresInMinutes };
  });

  /* ---- step 3: choose the new password -------------------------------- */
  app.post('/auth/admin/password-reset/complete', {
    config: { rateLimit: { max: RATE_LIMITS.adminLogin, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req) => {
    const userId = await completePasswordReset({
      token: req.body?.token, password: req.body?.password,
    });

    /* Every session this account had, everywhere, ends: if the reset was
       somebody else recovering a stolen account, the thief is signed out. */
    await revokeAllForUser(userId);
    await audit(req, { action: 'admin.password.reset.complete', resource: 'admin', resourceId: userId, outcome: 'ok' });

    /* No session, on purpose. Back to the sign-in screen, both factors. */
    return { ok: true, next: 'sign_in',
             message: 'Your password has been changed. Sign in with your new password and your authenticator code.' };
  });
}
