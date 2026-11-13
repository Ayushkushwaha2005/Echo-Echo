/* ==========================================================================
   ECHO ECHO - ADMINISTRATOR INVITATIONS

   The link is 32 random bytes. Only its SHA-256 is stored, it lives 72 hours
   and it is spent once. Holding it grants nothing: it opens a page that can
   only ask for a code sent to the invited mailbox.

     open -> email code -> read and accept -> password -> authenticator -> complete

   Nothing before complete() touches app_user, user_role, admin_account or
   admin_credential. complete() does all of it in one transaction, together
   with its audit row, or none of it. An email code alone can never activate
   anything, and neither can any single step here.
   ========================================================================== */
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { q, tx } from '../db/index.js';
import { ADMIN, ADMIN_AUTH } from '../config.js';
import { BadRequest, Conflict, Forbidden, TooMany, HttpError } from '../auth/rbac.js';
import { validatePermissionList, PERMISSIONS } from '../auth/permissions.js';
import { hashPassword, validatePassword, newTotpSecret, encryptSecret, decryptSecret, verifyTotp, otpauthUri } from './admin-auth.js';
import { sendEmail, emailConfigured } from './email.js';
import { auditTx } from '../audit.js';

export const OTP_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_COOLDOWN_SECONDS = 60;
export const SETUP_MINUTES = 30;
export const RESEND_COOLDOWN_SECONDS = 60;

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const otpHash = (code, salt) => sha(`${salt}:${code}`);

/* Every failure looks like this, so a stranger cannot tell an unknown token
   from an expired or revoked one. The owner's screen shows the real state. */
const Dead = () => new HttpError(410, 'invitation_unusable', 'This invitation link is no longer valid',
  'Ask the platform owner to send a new one.');

/** The address an administrator is identified by. */
export function normaliseStaffEmail(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  const bad = () => BadRequest('Enter a valid email address');
  if (!raw || raw.length > 254 || /[^\x21-\x7e]/.test(raw)) throw bad();
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw) || raw.includes('..')) throw bad();
  return raw;
}

export const newLinkToken = () => { const token = randomBytes(32).toString('base64url'); return { token, tokenHash: sha(token) }; };

/* The token goes in the fragment: browsers do not send it to any server, so
   it cannot reach an access log or a Referer header. */
export const inviteLink = (token) => `${ADMIN.publicUrl}#invite=${token}`;

const state = (i) => (i.revoked_at ? 'revoked' : i.accepted_at ? 'accepted'
  : new Date(i.expires_at) <= new Date() ? 'expired' : 'waiting');

export const permissionLabels = (keys) => (keys || []).map((k) => ({
  key: k, label: PERMISSIONS[k]?.label || k, group: PERMISSIONS[k]?.group || 'Other',
}));

const maskEmail = (e) => e.replace(/^(.)[^@]*@/, (_, f) => `${f}***@`);

async function load(client, token, { lock = false } = {}) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 64) throw Dead();
  const row = (await client.query(
    `SELECT i.*, COALESCE(ip.display_name, u.name) AS inviter_name FROM admin_invitation i JOIN app_user u ON u.id = i.invited_by
         LEFT JOIN admin_profile ip ON ip.user_id = i.invited_by
      WHERE i.token_hash = $1 ${lock ? 'FOR UPDATE OF i' : ''}`, [sha(token)])).rows[0];
  if (!row || state(row) !== 'waiting') throw Dead();
  return row;
}

function assertSetup(i, setup) {
  if (!i.email_verified_at || !i.setup_hash || !setup || !same(sha(setup), i.setup_hash)) {
    throw Forbidden('Confirm your email first');
  }
  if (new Date(i.setup_expires_at) <= new Date()) {
    throw Forbidden('This setup page has timed out', 'Ask for a new email code to carry on.');
  }
}

const describe = (i) => ({
  email: i.email, name: i.name, role: i.role, invitedBy: i.inviter_name, invitedAt: i.created_at, expiresAt: i.expires_at,
  permissions: permissionLabels(i.permissions),
  accepted: !!i.terms_accepted_at, passwordSet: !!i.password_hash, authenticatorStarted: !!i.totp_secret_enc,
});

/* What a person who holds the link but has not proven the mailbox may see. */
export async function openInvitation(token) {
  const i = await load({ query: q }, token);
  return { state: 'waiting', email: maskEmail(i.email), expiresAt: i.expires_at };
}

export async function sendInvitationCode(token, { log } = {}) {
  if (!emailConfigured()) {
    throw new HttpError(503, 'email_unavailable', 'We cannot send email right now', 'Try again shortly.');
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = randomBytes(12).toString('hex');
  const i = await tx(async (c) => {
    const row = await load(c, token, { lock: true });
    if (row.otp_sent_at && Date.now() - new Date(row.otp_sent_at).getTime() < OTP_COOLDOWN_SECONDS * 1000) {
      throw TooMany('A code was sent a moment ago', 'Check your inbox, or try again in a minute.');
    }
    await c.query(
      `UPDATE admin_invitation SET otp_hash = $2, otp_salt = $3, otp_attempts = 0, otp_sent_at = now(),
              otp_expires_at = now() + ($4 || ' minutes')::interval WHERE id = $1`,
      [row.id, otpHash(code, salt), salt, String(OTP_MINUTES)]);
    return row;
  });
  await sendEmail({
    kind: 'admin_invite', to: i.email, secret: code, log,
    subject: 'Your ECHO ECHO invitation code',
    text: `Your code to continue your ECHO ECHO Campus Control invitation is: ${code}\n\nIt expires in ${OTP_MINUTES} minutes. Nobody from ECHO ECHO will ask you for it.`,
  });
  return { sent: true, email: maskEmail(i.email), expiresInMinutes: OTP_MINUTES };
}

export async function verifyInvitationCode(req, token, code) {
  const input = String(code ?? '');
  if (!/^\d{6}$/.test(input)) throw BadRequest('Enter the 6-digit code from your email');
  const setup = randomBytes(32).toString('base64url');
  /* A refused guess returns from the transaction rather than throwing out of
     it, so the attempt it cost is committed. */
  const r = await tx(async (c) => {
    const i = await load(c, token, { lock: true });
    if (!i.otp_hash || new Date(i.otp_expires_at) <= new Date()) {
      return { error: BadRequest('That code has expired or was not requested', 'Request a new one.') };
    }
    if (i.otp_attempts >= OTP_MAX_ATTEMPTS) {
      await c.query(`UPDATE admin_invitation SET otp_hash = NULL, otp_salt = NULL, otp_expires_at = NULL WHERE id = $1`, [i.id]);
      await auditTx(c, req, { action: 'admin.invite.email_verify', resource: 'admin_invitation', resourceId: i.id, outcome: 'denied', detail: { reason: 'too_many_attempts' } });
      return { error: TooMany('Too many incorrect codes', 'Request a new code.') };
    }
    if (!same(otpHash(input, i.otp_salt), i.otp_hash)) {
      await c.query(`UPDATE admin_invitation SET otp_attempts = otp_attempts + 1 WHERE id = $1`, [i.id]);
      await auditTx(c, req, { action: 'admin.invite.email_verify', resource: 'admin_invitation', resourceId: i.id, outcome: 'denied', detail: { reason: 'wrong_code' } });
      return { error: BadRequest('That code is not right') };
    }
    await c.query(
      `UPDATE admin_invitation SET otp_hash = NULL, otp_salt = NULL, otp_expires_at = NULL, otp_attempts = 0,
              email_verified_at = now(), setup_hash = $2, setup_expires_at = now() + ($3 || ' minutes')::interval
        WHERE id = $1`, [i.id, sha(setup), String(SETUP_MINUTES)]);
    await auditTx(c, req, { action: 'admin.invite.email_verify', resource: 'admin_invitation', resourceId: i.id, outcome: 'ok' });
    return { i };
  });
  if (r.error) throw r.error;
  return { setup, ...describe(r.i) };
}

export async function acceptInvitationTerms(req, token, setup) {
  return tx(async (c) => {
    const i = await load(c, token, { lock: true });
    assertSetup(i, setup);
    await c.query(`UPDATE admin_invitation SET terms_accepted_at = coalesce(terms_accepted_at, now()) WHERE id = $1`, [i.id]);
    await auditTx(c, req, { action: 'admin.invite.accept', resource: 'admin_invitation', resourceId: i.id, outcome: 'ok' });
    return { accepted: true };
  });
}

export async function setInvitationPassword(token, setup, password) {
  /* Hashed before the row lock: scrypt is deliberately slow. */
  const peek = await load({ query: q }, token);
  assertSetup(peek, setup);
  if (!peek.terms_accepted_at) throw Forbidden('Accept the invitation first');
  validatePassword(password, { email: peek.email });
  const { hash, salt, params } = await hashPassword(password);
  return tx(async (c) => {
    const i = await load(c, token, { lock: true });
    assertSetup(i, setup);
    await c.query(`UPDATE admin_invitation SET password_hash = $2, password_salt = $3, password_params = $4 WHERE id = $1`,
      [i.id, hash, salt, params]);
    return { passwordSet: true };
  });
}

export async function beginInvitationAuthenticator(token, setup) {
  const secret = newTotpSecret();
  return tx(async (c) => {
    const i = await load(c, token, { lock: true });
    assertSetup(i, setup);
    if (!i.password_hash) throw Forbidden('Choose your password first');
    await c.query(`UPDATE admin_invitation SET totp_secret_enc = $2 WHERE id = $1`, [i.id, encryptSecret(secret)]);
    return { secret, uri: otpauthUri(secret, { email: i.email }), issuer: ADMIN_AUTH.totpIssuer,
             periodSeconds: ADMIN_AUTH.totpPeriodSeconds, digits: 6, algorithm: 'SHA1' };
  });
}

/* The only place an invited person becomes an administrator. */
export async function completeInvitation(req, token, setup, code) {
  return tx(async (c) => {
    const i = await load(c, token, { lock: true });
    assertSetup(i, setup);
    if (!i.terms_accepted_at) throw Forbidden('Accept the invitation first');
    if (!i.password_hash) throw Forbidden('Choose your password first');
    if (!i.totp_secret_enc) throw Forbidden('Set up your authenticator first');
    const step = verifyTotp(decryptSecret(i.totp_secret_enc), code);
    if (step === null) throw BadRequest('That code is not right', 'Check the six digits your authenticator app shows now.');

    /* Re-read everything the invitation relied on, as it stands now. */
    const check = validatePermissionList(i.permissions);
    if (!check.ok || !check.permissions.length) throw Conflict('These permissions are no longer valid', 'Ask the platform owner for a new invitation.');
    const inviter = (await c.query(
      `SELECT 1 FROM user_role r JOIN app_user u ON u.id = r.user_id
        WHERE r.user_id = $1 AND r.role = 'platform_owner' AND r.status = 'active' AND u.status = 'active'`, [i.invited_by])).rows[0];
    if (!inviter) throw Conflict('The person who invited you can no longer grant access', 'Ask the platform owner for a new invitation.');

    await c.query(`SELECT pg_advisory_xact_lock(hashtext('student-email:' || $1))`, [i.email]);
    let u = (await c.query(`SELECT * FROM app_user WHERE student_email = $1 OR staff_email = $1 FOR UPDATE`, [i.email])).rows[0];
    if (u) {
      const owner = (await c.query(`SELECT 1 FROM user_role WHERE user_id = $1 AND role = 'platform_owner' AND status = 'active'`, [u.id])).rows[0];
      if (owner) throw Conflict('That is the platform owner\'s address');
      if (u.status !== 'active') throw Conflict('That account is suspended', 'Contact the platform owner.');
      const live = (await c.query(`SELECT status FROM admin_account WHERE user_id = $1`, [u.id])).rows[0];
      if (live && ['active', 'suspended'].includes(live.status)) throw Conflict(`This person is already an administrator (${live.status})`);
      if (!u.name) await c.query(`UPDATE app_user SET name = $2 WHERE id = $1`, [u.id, i.name]);
    } else {
      /* No student account: this mailbox has just been proven, so it is the
         account's identity. It carries no student role and cannot order. */
      u = (await c.query(
        `INSERT INTO app_user (name, staff_email, staff_email_verified_at) VALUES ($1,$2, now()) RETURNING *`,
        [i.name, i.email])).rows[0];
    }
    await c.query(
      `INSERT INTO user_role (user_id, role, granted_by, granted_via) VALUES ($1,$2,$3,'api')
       ON CONFLICT (user_id, role, COALESCE(vendor_id,'00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET status = 'active', revoked_at = NULL, granted_by = $3, granted_at = now()`,
      [u.id, i.role, i.invited_by]);
    await c.query(
      `INSERT INTO admin_account (user_id, status, permissions, display_name, invited_by, invited_at, invite_email_sent_at,
                                  activated_at, permissions_updated_at, permissions_updated_by)
       VALUES ($1,'active',$2,$3,$4,$5,$6, now(), now(), $4)
       ON CONFLICT (user_id) DO UPDATE SET status = 'active', permissions = $2, display_name = $3, invited_by = $4,
              invited_at = $5, invite_email_sent_at = $6, activated_at = now(), revoked_at = NULL, suspended_at = NULL,
              status_reason = NULL, permissions_updated_at = now(), permissions_updated_by = $4, updated_at = now()`,
      [u.id, check.permissions, i.name, i.invited_by, i.created_at, i.email_sent_at]);
    await c.query(
      `INSERT INTO admin_credential (user_id, password_hash, password_salt, password_params, password_updated_at,
                                     totp_secret_enc, totp_confirmed_at, totp_last_step, failed_attempts, locked_until)
       VALUES ($1,$2,$3,$4, now(), $5, now(), $6, 0, NULL)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = $2, password_salt = $3, password_params = $4,
              password_updated_at = now(), totp_secret_enc = $5, totp_confirmed_at = now(), totp_last_step = $6,
              totp_pending_enc = NULL, totp_pending_at = NULL, failed_attempts = 0, locked_until = NULL, updated_at = now()`,
      [u.id, i.password_hash, i.password_salt, i.password_params, i.totp_secret_enc, step]);
    /* Anything the older flow left behind for this account stops working. */
    await c.query(`UPDATE admin_passkey_invite SET revoked_at = now() WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [u.id]);
    await c.query(
      `UPDATE admin_invitation SET accepted_at = now(), accepted_user_id = $2, password_hash = NULL, password_salt = NULL,
              password_params = NULL, totp_secret_enc = NULL, otp_hash = NULL, otp_salt = NULL, setup_hash = NULL,
              setup_expires_at = NULL WHERE id = $1`, [i.id, u.id]);
    await auditTx(c, req, {
      action: 'admin.invite.complete', resource: 'admin_account', resourceId: u.id, outcome: 'ok',
      actorId: u.id, actorRole: i.role,
      detail: { invitationId: i.id, email: i.email, role: i.role, permissions: check.permissions, invitedBy: i.invited_by },
    });
    return { activated: true, next: 'sign_in', email: i.email };
  });
}

export async function sendInvitationEmail({ email, name, token, expiresAt, inviterName, log }) {
  const link = inviteLink(token);
  await sendEmail({
    kind: 'admin_invite', to: email, log, secret: token,
    subject: 'You have been invited to ECHO ECHO Campus Control',
    text:
`Hello ${name},

${inviterName || 'The ECHO ECHO platform owner'} has invited you to Campus Control.

Open this link to continue:
${link}

You will confirm this email address with a code, review what access you are being given, then set a password and an authenticator app.

The link works once and expires ${new Date(expiresAt).toUTCString()}.
If you did not expect this, ignore this email and nothing will happen.`,
  });
}
