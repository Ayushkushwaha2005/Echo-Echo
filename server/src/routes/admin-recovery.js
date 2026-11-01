/* ==========================================================================
   ECHO ECHO - ADMINISTRATOR RECOVERY

     GET  /auth/admin/recovery-codes         how many remain, never the codes
     POST /auth/admin/recovery-codes         new set, shown once; fresh authentication
     PUT  /auth/admin/alert-email            second address for security alerts
     POST /auth/admin/recovery/begin         password + recovery code -> ticket + new key
     POST /auth/admin/recovery/complete      ticket + code from the new key

   A recovery code stands in for a lost authenticator, and only for that. It is
   never enough without the password, it opens no session, and using one alerts
   every address on the account. The password reset keeps its own rule: it never
   touches the authenticator, so the two can't be combined with one mailbox unless
   that person also holds a recovery code.
   ========================================================================== */
import { randomBytes, createHash } from 'node:crypto';
import { one, tx } from '../db/index.js';
import { BadRequest, Forbidden, TooMany, isPlatformRole } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { RATE_LIMITS, ADMIN_AUTH } from '../config.js';
import { audit, auditTx } from '../audit.js';
import {
  verifyAdminPassword, clearLoginChallenges, newTotpSecret, encryptSecret, decryptSecret, verifyTotp, otpauthUri,
} from '../services/admin-auth.js';
import { issueRecoveryCodes, remainingRecoveryCodes, platformRolesOf, useRecoveryCode } from '../services/admin-credentials.js';
import { normaliseStaffEmail } from '../services/admin-invitation.js';
import { sendEmail, emailConfigured } from '../services/email.js';

const TICKET_MINUTES = 15;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const GENERIC = () => Forbidden('Email, password or recovery code is not right', 'Check them and try again.');

async function alertRecovery(req, userId, what) {
  if (!emailConfigured()) {
    req.log.error({ userId }, 'recovery alert could not be sent: no email provider');
    return;
  }
  const u = await one(
    `SELECT coalesce(u.staff_email, u.student_email) AS email, c.alert_email
       FROM app_user u LEFT JOIN admin_credential c ON c.user_id = u.id WHERE u.id = $1`, [userId]);
  for (const to of new Set([u?.email, u?.alert_email].filter(Boolean))) {
    await sendEmail({
      kind: 'admin_invite', to, log: req.log,
      subject: 'ECHO ECHO security alert: a recovery code was used',
      text: `${what}\n\nTime: ${new Date().toUTCString()}\n\nIf this was not you, your password and a recovery code are both known to someone else. Treat the account as compromised and act now.`,
    }).catch((e) => req.log.error({ code: e.code }, 'recovery alert not delivered'));
  }
}

export default async function adminRecoveryRoutes(app) {
  const limited = { config: { rateLimit: { max: RATE_LIMITS.adminLogin, timeWindow: RATE_LIMITS.windowMinutes * 60_000 }, edgeLimit: true } };

  const assertAdmin = (actor) => {
    if (!actor) throw Forbidden('Sign in required');
    if (!actor.roles?.some(isPlatformRole)) throw Forbidden('This needs a Campus Control session');
  };

  app.get('/auth/admin/recovery-codes', async (req) => {
    assertAdmin(req.actor);
    const alert = await one(`SELECT alert_email FROM admin_credential WHERE user_id = $1`, [req.actor.id]);
    return { remaining: await remainingRecoveryCodes(req.actor.id), alertEmail: alert?.alert_email || null };
  });

  app.post('/auth/admin/recovery-codes', async (req) => {
    assertAdmin(req.actor);
    assertRecentPasskey(req.actor, 'creating recovery codes');
    const codes = await tx(async (c) => {
      const out = await issueRecoveryCodes(c, req.actor.id);
      await auditTx(c, req, { action: 'admin.recovery_codes.issue', resource: 'admin', resourceId: req.actor.id, detail: { count: out.length } });
      return out;
    });
    return { codes, note: 'Shown once. Any earlier codes have stopped working.' };
  });

  app.put('/auth/admin/alert-email', async (req) => {
    assertAdmin(req.actor);
    assertRecentPasskey(req.actor, 'changing your security alert address');
    const email = req.body?.email ? normaliseStaffEmail(req.body.email) : null;
    await tx(async (c) => {
      const r = await c.query(`UPDATE admin_credential SET alert_email = $2, updated_at = now() WHERE user_id = $1`, [req.actor.id, email]);
      if (!r.rowCount) throw BadRequest('Finish setting up your sign-in first');
      await auditTx(c, req, { action: 'admin.alert_email.set', resource: 'admin', resourceId: req.actor.id, detail: { set: !!email } });
    });
    return { alertEmail: email };
  });

  /* Password first, so a recovery code cannot be tested without it. */
  app.post('/auth/admin/recovery/begin', limited, async (req) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const u = await one(`SELECT id, status FROM app_user WHERE student_email = $1 OR staff_email = $1`, [email]);
    const roles = u && u.status === 'active' ? await platformRolesOf(u.id, { allowInvited: false }) : [];
    if (!roles.length) {
      await audit(req, { action: 'auth.recovery.begin', resource: 'admin', outcome: 'denied', detail: { reason: 'not_an_administrator' } });
      throw GENERIC();
    }
    try {
      await verifyAdminPassword({ userId: u.id, password: req.body?.password, ip: req.ip, userAgent: req.headers['user-agent'] });
    } catch (e) {
      if (e.status === 429) throw e;
      await audit(req, { action: 'auth.recovery.begin', resource: 'admin', resourceId: u.id, outcome: 'denied', detail: { reason: 'password' } });
      throw GENERIC();
    }
    /* That challenge is not what recovery uses, so it does not stay redeemable. */
    await tx((c) => clearLoginChallenges(c, u.id));
    try {
      await useRecoveryCode(u.id, req.body?.recoveryCode);
    } catch (e) {
      if (e.status === 429) throw TooMany('Too many incorrect recovery codes', 'Try again in an hour.');
      await audit(req, { action: 'auth.recovery', resource: 'admin', resourceId: u.id, outcome: 'denied' });
      throw GENERIC();
    }
    const ticket = randomBytes(32).toString('base64url');
    const secret = newTotpSecret();
    await tx(async (c) => {
      await c.query(`UPDATE admin_recovery_ticket SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [u.id]);
      await c.query(
        `INSERT INTO admin_recovery_ticket (user_id, ticket_hash, totp_secret_enc, expires_at)
         VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`, [u.id, sha(ticket), encryptSecret(secret), String(TICKET_MINUTES)]);
      await auditTx(c, req, { action: 'auth.recovery', resource: 'admin', resourceId: u.id, outcome: 'ok', actorId: u.id });
    });
    await alertRecovery(req, u.id, 'A recovery code was just used on your Campus Control account, together with your password, to start replacing your authenticator.');
    return { ticket, expiresInMinutes: TICKET_MINUTES, secret, uri: otpauthUri(secret, { email }), issuer: ADMIN_AUTH.totpIssuer, digits: 6, periodSeconds: ADMIN_AUTH.totpPeriodSeconds };
  });

  app.post('/auth/admin/recovery/complete', limited, async (req) => {
    const out = await tx(async (c) => {
      const t = (await c.query(
        `SELECT * FROM admin_recovery_ticket WHERE ticket_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`,
        [sha(req.body?.ticket ?? '')])).rows[0];
      if (!t) throw Forbidden('This recovery has expired', 'Start again. That recovery code cannot be reused.');
      const step = verifyTotp(decryptSecret(t.totp_secret_enc), req.body?.code);
      if (step === null) throw BadRequest('That code is not right', 'Enter the six digits the NEW entry in your authenticator app shows.');
      await c.query(
        `UPDATE admin_credential SET totp_secret_enc = $2, totp_confirmed_at = now(), totp_last_step = $3, totp_pending_enc = NULL,
                totp_pending_at = NULL, failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE user_id = $1`,
        [t.user_id, t.totp_secret_enc, step]);
      await c.query(`UPDATE admin_recovery_ticket SET used_at = now(), totp_secret_enc = NULL WHERE id = $1`, [t.id]);
      /* Whoever held the old authenticator is signed out everywhere. */
      await c.query(`UPDATE session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.user_id]);
      await auditTx(c, req, { action: 'admin.authenticator.recover', resource: 'admin', resourceId: t.user_id, actorId: t.user_id });
      return t.user_id;
    });
    await alertRecovery(req, out, 'The authenticator on your Campus Control account was replaced using a recovery code. All sessions were signed out.');
    return { ok: true, next: 'sign_in' };
  });
}

