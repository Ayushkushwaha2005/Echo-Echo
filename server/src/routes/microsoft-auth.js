/* ==========================================================================
   QUAD — "CONTINUE WITH MICROSOFT" FOR STUDENTS

     GET /auth/microsoft/start     -> 302 to the university's Entra tenant
     GET /auth/microsoft/callback  -> 302 back to the student site

   Reached through the site's own /api/ proxy, so the session cookie it sets
   is first-party exactly like the email code's. Every outcome ends in a
   redirect to /web/ with ?ms=<reason>; the reason names what happened in
   words that do not reveal whether an account exists.

   CSRF / replay: `state` is random, stored only as a hash, single-use,
   ten minutes, and bound to this browser by a second random value held in
   an httpOnly cookie. PKCE (S256) binds the code to the verifier we keep.
   The nonce binds the ID token to this attempt.
   ========================================================================== */
import { MICROSOFT, SESSION, RATE_LIMITS } from '../config.js';
import { issueSession, cookieOptions } from '../auth/session.js';
import { q, one } from '../db/index.js';
import { audit } from '../audit.js';
import {
  authorizeUrl, redeemCode, verifyIdToken, studentIdentity, MicrosoftSignInError,
  randomToken, sha256, sameHash,
} from '../services/microsoft-oidc.js';
import { signInStudentMailbox, AccountLinkConflict } from './auth.js';

const BIND_COOKIE = 'quad_ms_bind';
const back = (reason, route = 'ob-email') => `${new URL(MICROSOFT.redirectUri).origin}/web/?ms=${encodeURIComponent(reason)}#/${route}`;

export default async function microsoftAuthRoutes(app, { fetchImpl } = {}) {
  const limited = { config: { rateLimit: { max: RATE_LIMITS.emailSend, timeWindow: RATE_LIMITS.windowMinutes * 60_000 }, edgeLimit: true } };

  app.get('/auth/microsoft/start', limited, async (req, reply) => {
    if (!MICROSOFT.configured) return reply.redirect(back('unavailable'));
    const state = randomToken(), nonce = randomToken(), codeVerifier = randomToken(48), bind = randomToken();
    await q(`DELETE FROM oauth_login_attempt WHERE expires_at < now() - interval '1 day'`).catch(() => {});
    await q(
      `INSERT INTO oauth_login_attempt (state_hash, browser_hash, provider, code_verifier, nonce, expires_at)
       VALUES ($1,$2,'microsoft',$3,$4, now() + ($5 || ' seconds')::interval)`,
      [sha256(state), sha256(bind), codeVerifier, nonce, String(MICROSOFT.attemptTtlSeconds)]);
    reply.setCookie(BIND_COOKIE, bind, { ...cookieOptions(MICROSOFT.attemptTtlSeconds / 60) });
    await audit(req, { action: 'auth.microsoft.start', outcome: 'ok' });
    reply.header('cache-control', 'no-store');
    return reply.redirect(authorizeUrl({ state, nonce, codeVerifier }));
  });

  app.get('/auth/microsoft/callback', limited, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const qs = req.query || {};
    const bind = req.cookies?.[BIND_COOKIE];
    reply.clearCookie(BIND_COOKIE, { path: '/' });

    const deny = async (reason, detail) => {
      await audit(req, { action: 'auth.microsoft.callback', resource: 'student_email', outcome: 'denied',
                         detail: { reason, detail: String(detail || '').slice(0, 200) } });
      return reply.redirect(back(reason));
    };

    /* The attempt is consumed whatever happens next, so a state is never
       usable twice - including after a cancellation. */
    const attempt = typeof qs.state === 'string' && qs.state.length <= 200
      ? await one(
        `UPDATE oauth_login_attempt SET consumed_at = now()
          WHERE state_hash = $1 AND provider = 'microsoft' AND consumed_at IS NULL
          RETURNING browser_hash, code_verifier, nonce, expires_at > now() AS live`, [sha256(qs.state)])
      : null;

    if (qs.error) {
      /* Microsoft sends access_denied when the person cancels or declines. */
      const reason = qs.error === 'access_denied' ? 'cancelled'
        : /consent/i.test(String(qs.error) + String(qs.error_description || '')) ? 'consent' : 'failed';
      return deny(reason, `${qs.error}: ${String(qs.error_description || '').split('\n')[0]}`);
    }
    if (!attempt) return deny('expired', 'unknown_or_used_state');
    if (!attempt.live) return deny('expired', 'state_expired');
    if (!sameHash(sha256(bind || ''), attempt.browser_hash) || !bind) return deny('expired', 'browser_mismatch');
    if (!MICROSOFT.configured) return deny('unavailable', 'not_configured');

    let identity;
    try {
      const idToken = await redeemCode(qs.code, attempt.code_verifier, { fetchImpl });
      const claims = await verifyIdToken(idToken, { nonce: attempt.nonce, fetchImpl });
      identity = studentIdentity(claims);
    } catch (e) {
      if (e instanceof MicrosoftSignInError) return deny(e.code, e.detail);
      req.log.error({ err: e }, 'microsoft sign-in failed');
      return deny('failed', e.name);
    }

    let result;
    try {
      result = await signInStudentMailbox(identity.email, { microsoft: { tid: identity.tid, oid: identity.oid } });
    } catch (e) {
      if (e instanceof AccountLinkConflict) return deny('conflict', e.detail);
      /* recordMailboxProof's Conflict: the mailbox is on another account. */
      if (e?.statusCode === 409) return deny('conflict', e.message);
      throw e;
    }
    const { user, created, proof, linked } = result;
    if (user.status !== 'active') {
      await audit(req, { action: 'auth.login', resourceId: user.id, outcome: 'denied',
                         detail: { reason: user.status, via: 'microsoft' } });
      return reply.redirect(back('suspended'));
    }

    const roles = (await q(
      `SELECT role FROM user_role WHERE user_id = $1 AND status = 'active'`, [user.id])).rows.map((r) => r.role);
    const token = await issueSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'], method: 'microsoft' });
    reply.setCookie(SESSION.cookieName, token, cookieOptions());
    await audit(req, { action: 'auth.login', resource: 'user', resourceId: user.id, outcome: 'ok',
                       detail: { created, linked: !!linked, roles, via: 'microsoft', verification: proof } });
    if (proof.before !== proof.after) {
      await audit(req, { action: 'verification.email', resource: 'user', resourceId: user.id, outcome: 'ok',
                         detail: { from: proof.before, to: proof.after, email: identity.email, via: 'microsoft' } });
    }
    return reply.redirect(back('ok', 'home'));
  });
}
