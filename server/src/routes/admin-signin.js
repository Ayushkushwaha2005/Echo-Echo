/* ==========================================================================
   ECHO ECHO — CAMPUS CONTROL SIGN-IN

   Email → password, then the authenticator code, on two screens:

     POST /auth/admin/login/password   proves the password, opens no session
     POST /auth/admin/login            proves the code, opens the session

   Stage one hands back a short-lived, single-use challenge and nothing else:
   no cookie, no roles, no account details. Stage two will not issue a session
   for anything but a live challenge. Neither half is worth anything alone,
   which is what makes this two screens rather than two factors' worth of
   security theatre.

   Splitting the form does tell a caller that a password was correct before
   they produce a code. That is the deliberate, requested product behaviour,
   and it is why stage one counts every failure against the same lock-out the
   single-call form used, and why the challenge expires in minutes.

   What is NOT here, on purpose:

     · no role parameter. The roles come from the database after the
       credentials check, and the landing surface is derived from them.
     · no "remember this device". A device that skips the second factor is
       not a second factor.
     · no student path. An account with only the `student` role cannot open
       a session here at all, whatever it types.

   Password reset lives in routes/admin-reset.js: an emailed code proves the
   institutional mailbox and buys a new password, never a session, and never
   a way past the authenticator.
   ========================================================================== */
import {
  verifyAdminSignIn, verifyAdminPassword, verifyAdminChallengeCode,
  credentialStatus, beginAuthenticator, confirmAuthenticator, setPassword,
} from '../services/admin-auth.js';
import { issueSession, revokeSession, cookieOptions, revokeAllForUser } from '../auth/session.js';
import { landingSurface, Forbidden, BadRequest, NotFound, HttpError } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { platformRolesOf } from '../services/admin-credentials.js';
import { q, one } from '../db/index.js';
import { SESSION, RATE_LIMITS, ADMIN_AUTH, PLATFORM_OWNER } from '../config.js';
import { audit } from '../audit.js';

const normEmail = (v) => String(v ?? '').trim().toLowerCase();

export default async function adminSignInRoutes(app) {
  /* What the Campus Control sign-in screen needs to render truthfully. */
  app.get('/auth/admin/status', async () => ({
    method: 'password_totp',
    configured: ADMIN_AUTH.configured,
    issuer: ADMIN_AUTH.totpIssuer,
    /* The owner's address is fixed in server configuration and shown so an
       administrator can tell they are on the right deployment. It is not a
       secret and it cannot be changed from any client. */
    ownerEmail: PLATFORM_OWNER.emailValid ? PLATFORM_OWNER.email : null,
  }));

  /* ---- stage one: email + password -----------------------------------
     Opens no session and sets no cookie. On success it returns a challenge
     the second screen redeems, and nothing else about the account. */
  app.post('/auth/admin/login/password', {
    config: { rateLimit: { max: RATE_LIMITS.adminLogin, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req) => {
    assertAdminAuthConfigured();
    const email = normEmail(req.body?.email);
    const u = await adminAccountFor(req, email, 'auth.admin.login.password');

    try {
      const { token, expiresInSeconds } = await verifyAdminPassword({
        userId: u.id, password: req.body?.password,
        ip: req.ip, userAgent: req.headers['user-agent'],
      });
      await audit(req, { action: 'auth.admin.login.password', resource: 'admin', resourceId: u.id, outcome: 'ok' });
      /* `next` is what the screen advances to. It is a statement about the
         flow, not a grant: the challenge still has to survive stage two. */
      return { next: 'authenticator', challenge: token, expiresInSeconds, issuer: ADMIN_AUTH.totpIssuer };
    } catch (e) {
      await audit(req, { action: 'auth.admin.login.password', resource: 'admin', resourceId: u.id,
                         outcome: 'denied', detail: { reason: e.code || 'bad_password' } });
      throw e;
    }
  });

  /* ---- stage two: the authenticator code ------------------------------
     The account is whichever one stage one proved. A caller cannot name it
     here, so a correct code for one administrator can never open another's
     session. */
  app.post('/auth/admin/login', {
    config: { rateLimit: { max: RATE_LIMITS.adminLogin, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req, reply) => {
    assertAdminAuthConfigured();

    let userId;
    try {
      userId = await verifyAdminChallengeCode({ token: req.body?.challenge, code: req.body?.code });
    } catch (e) {
      await audit(req, { action: 'auth.admin.login', resource: 'admin',
                         outcome: 'denied', detail: { reason: e.code || 'bad_code' } });
      throw e;
    }

    /* Re-read the account as it stands NOW. Between the two screens an owner
       may have suspended it, and the older single-call route checked this
       before letting anyone in; so does this one. */
    const u = await one(`SELECT id, name, status, student_email FROM app_user WHERE id = $1`, [userId]);
    const roles = u && u.status === 'active' ? await platformRolesOf(u.id, { allowInvited: false }) : [];
    if (!roles.length) {
      await audit(req, { action: 'auth.admin.login', resource: 'admin', resourceId: userId,
                         outcome: 'denied', detail: { reason: 'no_longer_an_administrator' } });
      throw Forbidden('This account can no longer sign in to Campus Control');
    }

    const token = await issueSession(u.id, {
      ip: req.ip, userAgent: req.headers['user-agent'],
      method: 'admin_totp', ttlMinutes: ADMIN_AUTH.sessionMinutes,
    });
    reply.setCookie(SESSION.cookieName, token, cookieOptions(ADMIN_AUTH.sessionMinutes));
    await audit(req, { action: 'auth.admin.login', resource: 'admin', resourceId: u.id,
                       outcome: 'ok', detail: { roles } });

    const all = (await q(`SELECT role FROM user_role WHERE user_id = $1 AND status = 'active'`, [u.id]))
      .rows.map((r) => r.role);
    return { user: { id: u.id, name: u.name, email: u.student_email }, roles: all, surface: landingSurface(all) };
  });

  /* Re-confirmation for money, permissions and campus boundaries. Same two
     factors, no session issued — it refreshes the one already open. */
  app.post('/auth/admin/reauth', {
    config: { rateLimit: { max: RATE_LIMITS.adminLogin, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } },
  }, async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const email = req.actor.studentEmail;
    if (!email) throw Forbidden('This account has no administrator mailbox');
    try {
      await verifyAdminSignIn({ userId: req.actor.id, email, password: req.body?.password, code: req.body?.code });
    } catch (e) {
      await audit(req, { action: 'auth.admin.reauth', resourceId: req.actor.id, outcome: 'denied' });
      throw e;
    }
    await q(`UPDATE session SET passkey_verified_at = now(), auth_method = 'admin_totp'
              WHERE token_hash = $1`, [req.actor.tokenHash]);
    await audit(req, { action: 'auth.admin.reauth', resourceId: req.actor.id, outcome: 'ok' });
    return { confirmed: true, minutes: (await import('../config.js')).ADMIN.reauthMinutes };
  });

  /* ---------- enrolment: setting up your own password and authenticator ---
     Reachable from a session that has already proved the mailbox with an
     email code — that is how an invited administrator arrives — and from an
     administrator session that wants to rotate either factor. */
  app.get('/auth/admin/credential', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    return credentialStatus(req.actor.id);
  });

  app.post('/auth/admin/credential/password', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    await assertEnrollable(req.actor);
    const current = await credentialStatus(req.actor.id);
    /* Changing a password you already have needs the old one. Setting the
       first one needs the proven mailbox, which is how you got here. */
    if (current.passwordSet) {
      if (!req.actor.passkeyAt) assertRecentPasskey(req.actor, 'changing your administrator password');
      await verifyAdminSignIn({ userId: req.actor.id, email: req.actor.studentEmail,
                                password: req.body?.currentPassword, code: req.body?.code });
    }
    await setPassword(req.actor.id, req.body?.password, { email: req.actor.studentEmail || '' });
    await audit(req, { action: 'admin.password.set', resourceId: req.actor.id, outcome: 'ok',
                       detail: { replaced: current.passwordSet } });
    /* A new password ends every other session for this account. */
    await revokeAllForUser(req.actor.id, { exceptTokenHash: req.actor.tokenHash });
    return credentialStatus(req.actor.id);
  });

  app.post('/auth/admin/credential/authenticator/begin', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    await assertEnrollable(req.actor);
    const current = await credentialStatus(req.actor.id);
    if (current.authenticatorReady) {
      /* Replacing a working authenticator is a re-auth-level action. */
      assertRecentPasskey(req.actor, 'replacing your authenticator');
    }
    const out = await beginAuthenticator(req.actor.id, req.actor.studentEmail);
    await audit(req, { action: 'admin.authenticator.begin', resourceId: req.actor.id, outcome: 'ok' });
    /* The secret and URI are returned exactly once, to the administrator
       enrolling their own device, and are never stored in the clear. */
    return out;
  });

  app.post('/auth/admin/credential/authenticator/confirm', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    await assertEnrollable(req.actor);
    await confirmAuthenticator(req.actor.id, req.body?.code);
    await audit(req, { action: 'admin.authenticator.confirm', resourceId: req.actor.id, outcome: 'ok' });
    return credentialStatus(req.actor.id);
  });

  app.post('/auth/admin/logout', async (req, reply) => {
    await revokeSession(req.cookies?.[SESSION.cookieName]);
    reply.clearCookie(SESSION.cookieName, { path: '/' });
    await audit(req, { action: 'auth.logout', outcome: 'ok', detail: { surface: 'admin' } });
    return { ok: true };
  });
}

/* The same answer for "no such account", "not an administrator" and
   "suspended". Which of the three it is, is not a fact a stranger gets to
   probe, so all of them return the account-shaped object's opposite: a
   throw that looks exactly like a wrong password.

   It returns the row on success so the caller can go on to check the
   password against it. */
const GENERIC_SIGNIN = () => Forbidden('Email or password is not right', 'Check both and try again.');

async function adminAccountFor(req, email, action) {
  const deny = async (reason) => {
    await audit(req, { action, resource: 'admin', resourceId: email, outcome: 'denied', detail: { reason } });
    throw GENERIC_SIGNIN();
  };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw GENERIC_SIGNIN();

  const u = await one(`SELECT id, name, status FROM app_user WHERE student_email = $1`, [email]);
  if (!u) return deny('no_account');
  if (u.status !== 'active') return deny(u.status);
  /* allowInvited:false — an invited administrator has to finish enrolling
     (password + authenticator) before any session exists. */
  const roles = await platformRolesOf(u.id, { allowInvited: false });
  if (!roles.length) return deny('not_an_administrator');
  return u;
}

function assertAdminAuthConfigured() {
  if (ADMIN_AUTH.configured) return;
  throw new HttpError(503, 'configuration_required',
    'Administrator sign-in is not configured on this server',
    'Set ADMIN_TOTP_KEY (or a COOKIE_SECRET of at least 32 characters) so authenticator secrets can be stored.');
}

/* Only an account that already holds a platform role — including one still
   `invited` — may set administrator credentials. A student cannot give
   themselves a password and an authenticator and become an administrator,
   because holding the role is the precondition, not the consequence. */
async function assertEnrollable(actor) {
  const roles = await platformRolesOf(actor.id, { allowInvited: true });
  if (!roles.length) throw Forbidden('This account is not an administrator');
  if (!actor.studentEmail) {
    throw BadRequest('Confirm your institutional email first',
      'An administrator account is identified by its university mailbox.');
  }
  return roles;
}
