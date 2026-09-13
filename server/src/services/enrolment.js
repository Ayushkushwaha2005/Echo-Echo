/* ==========================================================================
   QUAD — ENROLMENT CODES

   The provider-free way into the platform. An administrator (or, for the
   platform owner, a CLI run on the server itself) issues a one-time code
   that a person delivers out of band; the recipient redeems it for a normal
   session.

   Everything an OTP gets, this gets: cryptographic randomness, storage as a
   salted hash only, an expiry, an attempt ceiling, single-use consumption
   under a transaction, and an audit trail. The plaintext code exists exactly
   once, in the response to the issuing admin, and is never stored or logged.

   What this is NOT: a bypass. It cannot be used to sign in as someone whose
   account an admin is not entitled to manage, it cannot reach the platform
   owner, and it does not weaken the OTP path in any way.
   ========================================================================== */
import { randomInt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { q, one, tx } from '../db/index.js';
import { BadRequest, TooMany, Forbidden, NotFound } from '../auth/rbac.js';

/* Long enough that guessing is hopeless against a 5-attempt ceiling, short
   enough to read aloud over a counter. Ambiguous characters are excluded so
   nobody loses ten minutes to O-versus-0. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUPS = 3;
const GROUP_LEN = 4;
export const TTL_MINUTES = Number(process.env.ENROLMENT_TTL_MINUTES || 60 * 24);
const MAX_ATTEMPTS = 5;

function generateCode() {
  const pick = () => ALPHABET[randomInt(0, ALPHABET.length)];
  return Array.from({ length: GROUPS },
    () => Array.from({ length: GROUP_LEN }, pick).join('')).join('-');
}

/* Normalising means a code read aloud is accepted however it is typed —
   lower case, missing dashes, stray spaces — without weakening it. */
export const normaliseCode = (input) =>
  String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const hash = (code, salt) =>
  createHash('sha256').update(`${salt}:${normaliseCode(code)}`).digest('hex');

/* Roles that may be reached by enrolment. Deliberately excludes
   platform_owner: an admin must never be able to mint their way into the
   owner account. The owner uses the bootstrap CLI, which requires shell
   access to the server and is therefore proof of control of the deployment. */
export const ENROLLABLE_ROLES = ['platform_admin', 'support', 'vendor_owner', 'vendor_staff'];

export async function assertEnrollable(userId) {
  const roles = (await q(
    `SELECT role FROM user_role WHERE user_id = $1 AND status = 'active'`, [userId]
  )).rows.map((r) => r.role);

  if (roles.includes('platform_owner')) {
    throw Forbidden('The platform owner cannot be enrolled from the admin API',
      'Run `npm run enrol:owner` on the server instead — controlling the host is the proof of ownership.');
  }
  if (!roles.some((r) => ENROLLABLE_ROLES.includes(r))) {
    throw Forbidden('This account has no staff or admin role',
      'Enrolment codes exist for cafeteria and platform staff. Students sign in with a phone OTP.');
  }
  return roles;
}

/**
 * Issues a code and returns the PLAINTEXT once. Any existing live code for
 * that user is revoked in the same transaction, so a person always has
 * exactly one valid code and re-issuing invalidates whatever was read out
 * before.
 */
export async function issueCode(userId, { issuedBy = null, via = 'admin' } = {}) {
  const user = await one(`SELECT id, phone, name, status FROM app_user WHERE id = $1`, [userId]);
  if (!user) throw NotFound('No such user');
  if (user.status === 'suspended') {
    throw Forbidden('That account is suspended', 'Restore it before issuing an enrolment code.');
  }

  const code = generateCode();
  const salt = randomBytes(12).toString('hex');

  const row = await tx(async (c) => {
    await c.query(
      `UPDATE enrolment_code SET revoked_at = now()
        WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [userId]);
    return (await c.query(
      `INSERT INTO enrolment_code (user_id, code_hash, salt, issued_by, issued_via,
                                   max_attempts, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval)
       RETURNING id, expires_at`,
      [userId, hash(code, salt), salt, issuedBy, via, MAX_ATTEMPTS, String(TTL_MINUTES)])).rows[0];
  });

  /* The only moment the plaintext exists outside the recipient's head. */
  return {
    id: row.id,
    code,
    phone: user.phone,
    name: user.name,
    expiresAt: row.expires_at,
    ttlMinutes: TTL_MINUTES,
  };
}

/**
 * Redeems a code. Returns the user id on success; throws otherwise. The
 * caller issues the session — this function never does, so there is exactly
 * one place in the codebase that mints sessions.
 */
export async function redeemCode(phone, code) {
  const normalised = normaliseCode(code);
  if (normalised.length !== GROUPS * GROUP_LEN) {
    throw BadRequest('That enrolment code is not the right length');
  }

  const user = await one(`SELECT id, status FROM app_user WHERE phone = $1`, [phone]);
  /* Same error whether the account is missing or the code is wrong, so this
     cannot be used to discover which numbers have accounts. */
  const wrong = () => BadRequest('That code is not valid for this number');
  if (!user) throw wrong();
  if (user.status === 'suspended') throw Forbidden('Account suspended', 'Contact campus support.');

  const rec = await one(
    `SELECT * FROM enrolment_code
      WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`, [user.id]);
  if (!rec) throw wrong();

  if (rec.attempts >= rec.max_attempts) {
    await q(`UPDATE enrolment_code SET revoked_at = now() WHERE id = $1`, [rec.id]);
    throw TooMany('Too many incorrect attempts', 'Ask for a new enrolment code.');
  }
  await q(`UPDATE enrolment_code SET attempts = attempts + 1 WHERE id = $1`, [rec.id]);

  const attempt = Buffer.from(hash(normalised, rec.salt));
  const stored = Buffer.from(rec.code_hash);
  const ok = attempt.length === stored.length && timingSafeEqual(attempt, stored);
  if (!ok) {
    const left = rec.max_attempts - rec.attempts - 1;
    throw BadRequest('That code is not valid for this number',
      left > 0 ? `${left} attempt${left === 1 ? '' : 's'} remaining.` : 'No attempts remaining.');
  }

  /* Consume atomically — a concurrent second redemption finds nothing. */
  const consumed = await one(
    `UPDATE enrolment_code SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL RETURNING id`, [rec.id]);
  if (!consumed) throw BadRequest('That code has already been used');

  return user.id;
}

/* For the admin UI: whether a live code exists, never the code itself. */
export async function codeStatus(userId) {
  const rec = await one(
    `SELECT created_at, expires_at, attempts, max_attempts FROM enrolment_code
      WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
        AND expires_at > now() LIMIT 1`, [userId]);
  if (!rec) return { live: false };
  return {
    live: true,
    issuedAt: rec.created_at,
    expiresAt: rec.expires_at,
    attemptsUsed: rec.attempts,
    maxAttempts: rec.max_attempts,
  };
}
