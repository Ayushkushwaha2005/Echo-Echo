/* ==========================================================================
   ECHO ECHO — ADMINISTRATOR PASSWORD AND AUTHENTICATOR

   Campus Control is opened with an email, a password and a six-digit code
   from an authenticator app. Three independent things have to be true, and
   all three are checked here, on the server.

   What this file deliberately does not do:

     · it never returns a password hash, a salt, or a TOTP secret to any
       caller, at any privilege level;
     · it never accepts a "skip the code" flag, a fixed code, or a longer
       window when a provider is missing — there is no provider to miss,
       because TOTP is computed locally from a shared secret (RFC 6238);
     · it never stores anything biometric. A password and a shared secret
       are all there is.

   TOTP is the standard 30-second SHA-1 construction that Microsoft
   Authenticator, Google Authenticator and 1Password all implement. One step
   of clock drift either way is tolerated, and an accepted step is recorded
   so the same six digits cannot be replayed inside their own window.
   ========================================================================== */
import {
  randomBytes, scrypt as _scrypt, timingSafeEqual, createHmac,
  createCipheriv, createDecipheriv, createHash,
} from 'node:crypto';
import { promisify } from 'node:util';
import { q, one } from '../db/index.js';
import { BadRequest, Forbidden, TooMany } from '../auth/rbac.js';
import { ADMIN_AUTH, HTTP } from '../config.js';

const scrypt = promisify(_scrypt);

/* ---------- password ------------------------------------------------------
   scrypt with per-password salt. The cost parameters are stored alongside
   the hash so they can be raised later without locking anyone out: an old
   hash is verified with the parameters it was made with. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const eq = (a, b) => {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function hashPassword(password, params = SCRYPT) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, params.keylen, params);
  return { hash: key.toString('hex'), salt, params };
}

async function passwordMatches(password, row) {
  if (!row?.password_hash || !row?.password_salt) return false;
  const params = { ...SCRYPT, ...(row.password_params || {}) };
  const key = await scrypt(password, row.password_salt, params.keylen, params);
  return eq(key.toString('hex'), row.password_hash);
}

/**
 * What an administrator password must be. Deliberately a length rule rather
 * than a character-class rule: "at least twelve characters" rejects far more
 * guessable passwords than "one capital and one symbol" ever did, and it
 * does not push people towards Passw0rd!.
 */
export function validatePassword(input, { email = '' } = {}) {
  const pw = String(input ?? '');
  if (pw.length < 12) {
    throw BadRequest('Choose a longer password', 'An administrator password must be at least 12 characters.');
  }
  if (pw.length > 200) throw BadRequest('That password is too long', 'Use at most 200 characters.');
  if (/^\s|\s$/.test(pw)) throw BadRequest('Password cannot start or end with a space');
  const local = String(email).split('@')[0].toLowerCase();
  if (local && local.length >= 4 && pw.toLowerCase().includes(local)) {
    throw BadRequest('Do not put your email address in your password');
  }
  if (/^(.)\1+$/.test(pw)) throw BadRequest('That password is a single repeated character');
  const COMMON = ['password', 'echoecho', 'campuscontrol', '123456789012', 'qwertyuiop'];
  if (COMMON.some((c) => pw.toLowerCase().includes(c))) {
    throw BadRequest('That password contains a very common phrase', 'Pick something that is not guessable.');
  }
  return pw;
}

/* ---------- TOTP secret encryption ---------------------------------------
   The secret is the second factor in full: anyone holding it can mint
   codes. Storing it in clear would mean a database dump is a complete
   bypass, so it is encrypted with a key that lives in the environment and
   not in the database. */
const keyFor = () => {
  const material = ADMIN_AUTH.totpKey || HTTP.cookieSecret;
  if (!material || material.length < 32) {
    throw new Error('ADMIN_TOTP_KEY (or COOKIE_SECRET) must be at least 32 characters to store authenticator secrets.');
  }
  return createHash('sha256').update(`echo-echo:totp:${material}`).digest();
};

export function encryptSecret(secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(), iv);
  const out = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${out.toString('base64url')}`;
}

export function decryptSecret(blob) {
  const [v, iv, tag, data] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable authenticator secret.');
  const d = createDecipheriv('aes-256-gcm', keyFor(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/* ---------- TOTP (RFC 6238) ----------------------------------------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(bytes = 20) {
  const buf = randomBytes(bytes);
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret) {
  const clean = String(secret).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('Invalid authenticator secret.');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The code for one 30-second step. Exported so tests can compute a real one. */
export function totpAt(secret, step) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

export const stepNow = (at = Date.now()) => Math.floor(at / 1000 / ADMIN_AUTH.totpPeriodSeconds);

/**
 * Verify a code against a secret, tolerating `window` steps of drift either
 * way. Returns the step it matched, or null.
 *
 * `afterStep` is the last step already spent by this account: a code is
 * accepted once and once only, so watching someone type their six digits is
 * not enough to reuse them.
 */
export function verifyTotp(secret, code, { at = Date.now(), window = ADMIN_AUTH.totpWindow, afterStep = null } = {}) {
  const digits = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const now = stepNow(at);
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (afterStep !== null && afterStep !== undefined && step <= Number(afterStep)) continue;
    const expect = totpAt(secret, step);
    if (eq(Buffer.from(expect).toString('hex'), Buffer.from(digits).toString('hex'))) return step;
  }
  return null;
}

/** The otpauth:// URI an authenticator app scans. Never logged, shown once. */
export const otpauthUri = (secret, { email, issuer = ADMIN_AUTH.totpIssuer }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}` +
  `?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
  `&algorithm=SHA1&digits=6&period=${ADMIN_AUTH.totpPeriodSeconds}`;

/* ---------- the credential record ----------------------------------------- */
export const credentialOf = (userId) =>
  one(`SELECT * FROM admin_credential WHERE user_id = $1`, [userId]);

/** What Campus Control may know about its own sign-in set-up. No secrets. */
export async function credentialStatus(userId) {
  const c = await credentialOf(userId);
  return {
    passwordSet: !!c?.password_hash,
    passwordUpdatedAt: c?.password_updated_at || null,
    authenticatorReady: !!c?.totp_confirmed_at,
    authenticatorConfirmedAt: c?.totp_confirmed_at || null,
    lockedUntil: c?.locked_until && new Date(c.locked_until) > new Date() ? c.locked_until : null,
    lastLoginAt: c?.last_login_at || null,
  };
}

export async function setPassword(userId, password, { email = '' } = {}) {
  validatePassword(password, { email });
  const { hash, salt, params } = await hashPassword(password);
  await q(
    `INSERT INTO admin_credential (user_id, password_hash, password_salt, password_params, password_updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (user_id) DO UPDATE SET password_hash = $2, password_salt = $3, password_params = $4,
       password_updated_at = now(), failed_attempts = 0, locked_until = NULL, updated_at = now()`,
    [userId, hash, salt, params]);
  return true;
}

/**
 * Begin authenticator enrolment. Returns the secret and its otpauth URI ONCE;
 * nothing is confirmed until confirmAuthenticator() sees a code from it, so
 * an abandoned enrolment cannot lock an administrator out of a working one.
 */
export async function beginAuthenticator(userId, email) {
  const secret = newTotpSecret();
  await q(
    `INSERT INTO admin_credential (user_id, totp_secret_enc, totp_confirmed_at, totp_last_step)
     VALUES ($1,$2,NULL,NULL)
     ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = $2, totp_confirmed_at = NULL,
       totp_last_step = NULL, updated_at = now()`,
    [userId, encryptSecret(secret)]);
  return { secret, uri: otpauthUri(secret, { email }), issuer: ADMIN_AUTH.totpIssuer,
           periodSeconds: ADMIN_AUTH.totpPeriodSeconds, digits: 6, algorithm: 'SHA1' };
}

export async function confirmAuthenticator(userId, code) {
  const c = await credentialOf(userId);
  if (!c?.totp_secret_enc) throw BadRequest('Set up your authenticator first');
  const step = verifyTotp(decryptSecret(c.totp_secret_enc), code, { afterStep: c.totp_last_step });
  if (step === null) throw BadRequest('That code is not right', 'Check the six digits currently shown in your authenticator app.');
  await q(`UPDATE admin_credential SET totp_confirmed_at = now(), totp_last_step = $2, updated_at = now()
            WHERE user_id = $1`, [userId, step]);
  return true;
}

/* ---------- the sign-in check ---------------------------------------------
   One function, used by the only route that opens an administrator session.
   Password and code are checked together and the answer is deliberately the
   same either way: "email, password or code is not right". Telling an
   attacker which of the three was wrong turns one unknown into three. */
export async function verifyAdminSignIn({ userId, email, password, code, at = Date.now() }) {
  const c = await credentialOf(userId);
  const generic = () => Forbidden('Email, password or authenticator code is not right',
    'Check all three and try again.');

  if (c?.locked_until && new Date(c.locked_until) > new Date(at)) {
    const mins = Math.ceil((new Date(c.locked_until) - at) / 60000);
    throw TooMany('Too many failed sign-in attempts',
      `This administrator account is locked for another ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
  if (!c?.password_hash || !c?.totp_secret_enc) {
    /* Not set up. Same shape of answer, because whether an administrator has
       finished enrolling is not a fact a stranger gets to probe. */
    await recordFailure(userId);
    throw generic();
  }

  const pwOk = await passwordMatches(String(password ?? ''), c);
  const step = pwOk ? verifyTotp(decryptSecret(c.totp_secret_enc), code, { at, afterStep: c.totp_last_step }) : null;
  if (!pwOk || step === null) {
    await recordFailure(userId);
    throw generic();
  }

  /* Spend the step and clear the throttle in one statement. A secret that
     was provisioned but never confirmed is confirmed by this first correct
     code: producing one is the only proof of enrolment there is, and it is
     exactly the proof a separate confirm step would have asked for. */
  await q(
    `UPDATE admin_credential SET totp_last_step = $2, failed_attempts = 0, locked_until = NULL,
            totp_confirmed_at = coalesce(totp_confirmed_at, now()),
            last_login_at = now(), updated_at = now() WHERE user_id = $1`, [userId, step]);
  return true;
}

/* ==========================================================================
   TWO-STAGE SIGN-IN

   Stage one proves the password. Stage two proves the authenticator code.
   Between them sits a challenge row: short-lived, single-use, stored only as
   an HMAC, and worth nothing on its own. It is not a session — it carries no
   roles and authorises nothing except having a code checked.

   Both factors are still required. Stage one issues no cookie, and stage two
   refuses to issue one unless it is redeeming a live challenge that stage one
   created. Neither half, alone, opens Campus Control.
   ========================================================================== */

/* The same HMAC construction the email codes use: a database leak must not
   yield a usable token. */
const challengeHash = (token) =>
  createHmac('sha256', HTTP.cookieSecret || 'quad-admin-challenge').update(token).digest('hex');

/**
 * Stage one. Checks ONLY the password, and on success returns an opaque
 * challenge token for stage two.
 *
 * Failure is counted against the credential exactly as a full sign-in failure
 * is, so splitting the form into two screens does not buy an attacker a
 * cheaper way to test passwords.
 */
export async function verifyAdminPassword({ userId, password, at = Date.now(), ip = null, userAgent = null }) {
  const c = await credentialOf(userId);
  const generic = () => Forbidden('Email or password is not right', 'Check both and try again.');

  if (c?.locked_until && new Date(c.locked_until) > new Date(at)) {
    const mins = Math.ceil((new Date(c.locked_until) - at) / 60000);
    throw TooMany('Too many failed sign-in attempts',
      `This administrator account is locked for another ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
  /* An account that has not finished enrolling answers the same way as a
     wrong password: whether somebody has set up their authenticator yet is
     not a fact a stranger gets to probe. */
  if (!c?.password_hash || !c?.totp_secret_enc || !(await passwordMatches(String(password ?? ''), c))) {
    await recordFailure(userId);
    throw generic();
  }

  /* One live challenge per administrator. Starting a new sign-in abandons
     any half-finished one, so an old token cannot be redeemed later. */
  await q(`UPDATE admin_login_challenge SET consumed_at = now()
            WHERE user_id = $1 AND consumed_at IS NULL`, [userId]);

  const token = randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO admin_login_challenge (user_id, token_hash, max_attempts, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)`,
    [userId, challengeHash(token), ADMIN_AUTH.maxAttempts, ip, userAgent,
     String(ADMIN_AUTH.loginChallengeSeconds)]);

  return { token, expiresInSeconds: ADMIN_AUTH.loginChallengeSeconds };
}

/**
 * Stage two. Redeems a stage-one challenge with an authenticator code.
 *
 * Resolves to the user id the challenge was issued for — the caller never
 * gets to say which account it is opening, because that was settled by the
 * password check.
 */
export async function verifyAdminChallengeCode({ token, code, at = Date.now() }) {
  const expired = () => Forbidden('Your sign-in timed out', 'Enter your email and password again.');
  if (!token || typeof token !== 'string') throw expired();

  const ch = await one(
    `SELECT * FROM admin_login_challenge
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`, [challengeHash(token)]);
  if (!ch) throw expired();

  /* Claim an attempt atomically, so a parallel burst gets max_attempts
     guesses between them rather than each. */
  const claim = await one(
    `UPDATE admin_login_challenge SET attempts = attempts + 1
      WHERE id = $1 AND attempts < max_attempts AND consumed_at IS NULL AND expires_at > now()
      RETURNING attempts`, [ch.id]);
  if (!claim) {
    await q(`UPDATE admin_login_challenge SET consumed_at = now() WHERE id = $1`, [ch.id]);
    throw TooMany('Too many incorrect codes', 'Enter your email and password again.');
  }

  const c = await credentialOf(ch.user_id);
  const step = c?.totp_secret_enc
    ? verifyTotp(decryptSecret(c.totp_secret_enc), code, { at, afterStep: c.totp_last_step })
    : null;

  if (step === null) {
    await recordFailure(ch.user_id);
    const left = ch.max_attempts - claim.attempts;
    if (left <= 0) {
      await q(`UPDATE admin_login_challenge SET consumed_at = now() WHERE id = $1`, [ch.id]);
      throw Forbidden('That code is not right', 'No attempts remaining. Enter your email and password again.');
    }
    throw Forbidden('That code is not right',
      `Check the six digits currently shown in your authenticator app. ${left} attempt${left === 1 ? '' : 's'} remaining.`);
  }

  /* Spend the challenge and the TOTP step together. Both are single-use. */
  const done = await one(
    `UPDATE admin_login_challenge SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL RETURNING id`, [ch.id]);
  if (!done) throw expired();

  await q(
    `UPDATE admin_credential SET totp_last_step = $2, failed_attempts = 0, locked_until = NULL,
            totp_confirmed_at = coalesce(totp_confirmed_at, now()),
            last_login_at = now(), updated_at = now() WHERE user_id = $1`, [ch.user_id, step]);

  return ch.user_id;
}

/** Every half-finished sign-in for an account, abandoned. */
export const clearLoginChallenges = (client, userId) =>
  (client || { query: q }).query(
    `UPDATE admin_login_challenge SET consumed_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL`, [userId]);

async function recordFailure(userId) {
  await q(
    `INSERT INTO admin_credential (user_id, failed_attempts, last_failed_at)
     VALUES ($1, 1, now())
     ON CONFLICT (user_id) DO UPDATE SET
       failed_attempts = admin_credential.failed_attempts + 1,
       last_failed_at = now(),
       locked_until = CASE WHEN admin_credential.failed_attempts + 1 >= $2
                           THEN now() + ($3 || ' minutes')::interval
                           ELSE admin_credential.locked_until END,
       updated_at = now()`,
    [userId, ADMIN_AUTH.maxAttempts, String(ADMIN_AUTH.lockMinutes)]);
}

/* ==========================================================================
   PASSWORD RESET

   Proven by the institutional mailbox, and ONLY good for the password. The
   authenticator secret is never touched by any of this: an administrator who
   resets their password still has to produce a code from the app they
   enrolled, so a mailbox on its own — however it was obtained — does not open
   Campus Control.

   The email code itself is issued and checked by services/student-email.js
   under the 'admin_reset' purpose, which brings its rate limits, its attempt
   counting and its atomic single-use consumption with it.
   ========================================================================== */

/**
 * Exchange a just-verified email code for a single-use reset token.
 * Called only after verifyStudentEmailCode() has already resolved.
 */
export async function issuePasswordReset(userId, { ip = null } = {}) {
  /* One live reset at a time. Asking again invalidates the last one. */
  await q(`UPDATE admin_password_reset SET consumed_at = now()
            WHERE user_id = $1 AND consumed_at IS NULL`, [userId]);

  const token = randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO admin_password_reset (user_id, token_hash, ip, expires_at)
     VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
    [userId, challengeHash(token), ip, String(ADMIN_AUTH.resetTokenMinutes)]);
  return { token, expiresInMinutes: ADMIN_AUTH.resetTokenMinutes };
}

/**
 * Spend a reset token and set the new password.
 *
 * Deliberately does NOT sign anyone in and does NOT clear the authenticator.
 * The administrator goes back to the sign-in screen and starts again, with
 * both factors, which is the only way in there has ever been.
 */
export async function completePasswordReset({ token, password }) {
  const expired = () => BadRequest('That reset link has expired', 'Start again from “Forgot password?”.');
  if (!token || typeof token !== 'string') throw expired();

  const r = await one(
    `SELECT * FROM admin_password_reset
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`, [challengeHash(token)]);
  if (!r) throw expired();

  const u = await one(`SELECT student_email FROM app_user WHERE id = $1`, [r.user_id]);
  /* Validate BEFORE consuming, so a password that is merely too short does
     not burn the token and force the whole email round trip again. */
  validatePassword(password, { email: u?.student_email || '' });

  const spent = await one(
    `UPDATE admin_password_reset SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL RETURNING id`, [r.id]);
  if (!spent) throw expired();

  await setPassword(r.user_id, password, { email: u?.student_email || '' });
  /* Any half-finished sign-in that was riding on the OLD password dies here. */
  await clearLoginChallenges(null, r.user_id);
  return r.user_id;
}

/** Used when an owner revokes an administrator: the credential goes too. */
export const clearCredential = (client, userId) =>
  (client || { query: q }).query(`DELETE FROM admin_credential WHERE user_id = $1`, [userId]);
