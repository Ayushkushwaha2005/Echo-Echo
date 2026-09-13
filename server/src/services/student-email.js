/* ==========================================================================
   QUAD — STUDENT VERIFICATION BY INSTITUTIONAL MAILBOX

   Read this before changing it:

   Typing an address that ends in @stu.upes.ac.in proves nothing. What this
   service establishes is that the person holding this browser session can
   READ that mailbox: the server generates a code, sends it only to that
   exact address, and accepts it back only from the same address within a
   short window. The university issues (and withdraws) those mailboxes, which
   is why control of one is evidence of being a current student.

   Guarantees, all enforced against the database so they survive restarts
   and hold across instances:
     · the domain is an EXACT match against the configured list — no
       subdomains, no lookalikes, no personal mail, no plus-addressing;
     · the code comes from crypto.randomInt and is stored only as an HMAC
       keyed with a server secret, so a database leak alone cannot recover it;
     · short expiry, per-challenge attempt ceiling claimed atomically, resend
       cooldown, hourly and daily per-address send caps;
     · consumption is atomic, so a code works exactly once;
     · a 'link' challenge is bound to one account by foreign key;
     · one mailbox can verify at most one account (unique index).

   There is no development bypass, no fixed code and no logged code. With no
   email provider configured, sending returns 503 configuration_required.
   ========================================================================== */
import { randomInt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { q, one, tx } from '../db/index.js';
import { STUDENT_EMAIL, HTTP, PLATFORM } from '../config.js';
import { ProviderUnavailable, TooMany, BadRequest, Conflict } from '../auth/rbac.js';
import { sendEmail } from './email.js';

/* ---------- normalisation & validation -----------------------------------
   Deliberately narrower than RFC 5321. Institutional student addresses are
   plain ASCII; anything outside this shape is refused rather than
   interpreted, which removes homoglyph, quoting, comment and IP-literal
   tricks in one step. '+' is refused because plus-addressing would let one
   mailbox verify many accounts.                                            */
const LOCAL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function normaliseStudentEmail(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  const bad = (d) => BadRequest('Enter your university student email address', d);
  if (!raw || raw.length > 254) throw bad();
  if (/[^\x21-\x7e]/.test(raw)) throw bad('Only plain letters, digits, dots, hyphens and underscores are allowed.');
  const at = raw.lastIndexOf('@');
  if (at <= 0 || raw.indexOf('@') !== at) throw bad();
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!STUDENT_EMAIL.domains.includes(domain)) {
    throw BadRequest('Use your university student email',
      `Only addresses ending in @${STUDENT_EMAIL.domains.join(' or @')} can be verified.`);
  }
  if (!LOCAL.test(local) || local.includes('..')) {
    throw bad('That does not look like a student mailbox name.');
  }
  return `${local}@${domain}`;
}

/* HMAC keyed with the server secret. Without the key, a leaked row cannot be
   brute-forced offline across the 10^6 code space. */
const hash = (code, salt) =>
  createHmac('sha256', HTTP.cookieSecret || 'quad-email-code')
    .update(`${salt}:${code}`).digest('hex');

const minutes = () => Math.round(STUDENT_EMAIL.ttlSeconds / 60);

function message(code) {
  return {
    subject: `${code} is your ECHO ECHO student verification code`,
    text:
`Your ECHO ECHO verification code is: ${code}

It expires in ${minutes()} minutes and works once.

Enter it on the ECHO ECHO sign-in screen to confirm that this university
mailbox belongs to you. ECHO ECHO staff will never ask you for this code.

If you did not request it, ignore this email - nobody can use your address
without the code.

- ${PLATFORM.legal}`,
  };
}

export const isConfigured = () => STUDENT_EMAIL.configured;

/* ---------- send ---------------------------------------------------------- */
export async function sendStudentEmailCode(email, { purpose = 'login', userId = null, ip } = {}) {
  if (!STUDENT_EMAIL.configured) {
    throw ProviderUnavailable('Email verification is not configured',
      'Set EMAIL_PROVIDER=resend, RESEND_API_KEY and EMAIL_FROM on the server. ' +
      'No code can be issued until then.');
  }
  if (purpose === 'link') {
    if (!userId) throw BadRequest('Sign in first');
    const taken = await one(
      `SELECT id FROM app_user WHERE student_email = $1 AND id <> $2`, [email, userId]);
    if (taken) {
      throw Conflict('That student email is already verified on another account',
        'Sign in with that email instead, or contact campus support if it is not yours.');
    }
  }

  return tx(async (c) => {
    /* Serialise sends per address: without this a parallel burst passes the
       cooldown check before any challenge is recorded. */
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('email:' || $1))`, [email]);

    const counts = (await c.query(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour,
              count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS day,
              max(created_at) AS last
         FROM email_challenge WHERE email = $1`, [email])).rows[0];
    /* Per-source cap across ALL addresses: one client cycling through many
       plausible mailbox names is how a 100-emails/day free quota would be
       drained. Deliberately looser than per-address, because a campus shares
       a few NAT addresses. */
    if (ip && STUDENT_EMAIL.maxSendsPerIpHour > 0) {
      const perIp = (await c.query(
        `SELECT count(*)::int n FROM email_challenge WHERE ip = $1 AND created_at > now() - interval '1 hour'`,
        [ip])).rows[0].n;
      if (perIp >= STUDENT_EMAIL.maxSendsPerIpHour) {
        throw TooMany('Too many codes requested from this network', 'Try again in a little while.');
      }
    }
    if (counts.day >= STUDENT_EMAIL.maxSendsPerDay) {
      throw TooMany('Too many codes requested today', 'Try again tomorrow, or contact campus support.');
    }
    if (counts.hour >= STUDENT_EMAIL.maxSendsPerHour) {
      throw TooMany('Too many codes requested', `Limit is ${STUDENT_EMAIL.maxSendsPerHour} per hour. Try again later.`);
    }
    if (counts.last) {
      const since = (Date.now() - new Date(counts.last).getTime()) / 1000;
      if (since < STUDENT_EMAIL.resendCooldownSeconds) {
        throw TooMany('Please wait before requesting another code',
          `${Math.ceil(STUDENT_EMAIL.resendCooldownSeconds - since)}s remaining.`);
      }
    }

    /* A new code supersedes any live one for this address. */
    await c.query(
      `UPDATE email_challenge SET consumed_at = now()
        WHERE email = $1 AND consumed_at IS NULL`, [email]);

    const code = String(randomInt(0, 10 ** STUDENT_EMAIL.length)).padStart(STUDENT_EMAIL.length, '0');
    const salt = randomBytes(16).toString('hex');

    /* Send FIRST: a gateway failure must not leave a live code nobody got. */
    const ref = await sendEmail({ to: email, ...message(code), secret: code, kind: 'student_code' });

    const row = (await c.query(
      `INSERT INTO email_challenge (email, purpose, user_id, code_hash, salt, max_attempts,
                                    expires_at, provider, provider_ref, ip)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval, 'resend', $8, $9)
       RETURNING id, expires_at`,
      [email, purpose, purpose === 'link' ? userId : null, hash(code, salt), salt,
       STUDENT_EMAIL.maxAttempts, String(STUDENT_EMAIL.ttlSeconds), ref, ip || null])).rows[0];

    return {
      expiresAt: row.expires_at,
      resendAfterSeconds: STUDENT_EMAIL.resendCooldownSeconds,
      length: STUDENT_EMAIL.length,
    };
  });
}

/* ---------- verify -------------------------------------------------------
   Resolves only for a live, unconsumed challenge of the right purpose (and,
   for 'link', the right account) whose code matches. Throws otherwise.     */
export async function verifyStudentEmailCode(email, code, { purpose = 'login', userId = null } = {}) {
  if (!STUDENT_EMAIL.configured) {
    throw ProviderUnavailable('Email verification is not configured');
  }
  const input = String(code ?? '');
  if (!new RegExp(`^\\d{${STUDENT_EMAIL.length}}$`).test(input)) {
    throw BadRequest(`Enter the ${STUDENT_EMAIL.length}-digit code from your email`);
  }

  const c = await one(
    `SELECT * FROM email_challenge
      WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
        AND ($3::uuid IS NULL OR user_id = $3)
      ORDER BY created_at DESC LIMIT 1`,
    [email, purpose, purpose === 'link' ? userId : null]);
  if (!c) throw BadRequest('That code has expired or was not requested', 'Request a new one.');

  /* Claim one attempt atomically so a parallel burst gets exactly
     max_attempts guesses between them. */
  const claim = await one(
    `UPDATE email_challenge SET attempts = attempts + 1
      WHERE id = $1 AND attempts < max_attempts AND consumed_at IS NULL AND expires_at > now()
      RETURNING attempts`, [c.id]);
  if (!claim) {
    await q(`UPDATE email_challenge SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`, [c.id]);
    throw TooMany('Too many incorrect attempts', 'Request a new code.');
  }

  const attempt = Buffer.from(hash(input, c.salt));
  const stored = Buffer.from(c.code_hash);
  if (!(attempt.length === stored.length && timingSafeEqual(attempt, stored))) {
    const left = c.max_attempts - claim.attempts;
    if (left <= 0) {
      await q(`UPDATE email_challenge SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`, [c.id]);
    }
    throw BadRequest('Incorrect code',
      left > 0 ? `${left} attempt${left === 1 ? '' : 's'} remaining.` : 'No attempts remaining. Request a new code.');
  }

  const consumed = await one(
    `UPDATE email_challenge SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL RETURNING id`, [c.id]);
  if (!consumed) throw BadRequest('That code has already been used', 'Request a new one.');
  return true;
}

/* ---------- recording the proof -------------------------------------------
   Called inside a transaction once a code has been verified. Decides what
   the proof does to the account's verification state. Admin decisions are
   never overridden by a student action: a REJECTED or SUSPENDED student
   stays that way, and a case an administrator flagged (needs_review) stays
   with the administrator.                                                  */
export async function recordMailboxProof(c, userId, email) {
  const u = (await c.query(`SELECT * FROM app_user WHERE id = $1 FOR UPDATE`, [userId])).rows[0];

  if (u.student_email && u.student_email !== email) {
    throw Conflict('This account is already verified with a different student email');
  }
  if (!u.student_email) {
    /* The unique index is the real guard; this gives the friendly message. */
    const taken = (await c.query(
      `SELECT 1 FROM app_user WHERE student_email = $1 AND id <> $2`, [email, userId])).rows[0];
    if (taken) throw Conflict('That student email is already verified on another account');
    await c.query(
      `UPDATE app_user SET student_email = $2, student_email_verified_at = now() WHERE id = $1`,
      [userId, email]);
  } else {
    /* The same mailbox proven again: the proof is fresh. This is what lets
       STUDENT_EMAIL_REVERIFY_DAYS work - a mailbox the university has since
       withdrawn can no longer renew it. */
    await c.query(`UPDATE app_user SET student_email_verified_at = now() WHERE id = $1`, [userId]);
  }

  const before = u.student_status;
  let after = before;
  let caseState = null;

  if (['unverified', 'email_verified', 'pending'].includes(before)) {
    if (STUDENT_EMAIL.emailRequiresAdminReview) {
      after = 'pending';
      caseState = 'pending';
    } else {
      after = 'approved';
      caseState = 'approved';
    }
  }

  if (caseState) {
    if (caseState === 'approved') {
      /* A pending ID-card case is superseded by the stronger proof. */
      await c.query(
        `UPDATE verification_case SET state = 'approved', decided_at = now(),
                decision_note = 'Superseded by institutional email verification'
          WHERE user_id = $1 AND state = 'pending'`, [userId]);
      await c.query(
        `INSERT INTO verification_case (user_id, method, student_email, state, decided_at, decision_note)
         VALUES ($1, 'institutional_email', $2, 'approved', now(),
                 'Mailbox control proven by one-time code')`, [userId, email]);
    } else {
      const open = (await c.query(
        `SELECT id FROM verification_case WHERE user_id = $1 AND state IN ('pending','needs_review')`,
        [userId])).rows[0];
      if (open) {
        await c.query(`UPDATE verification_case SET student_email = $2 WHERE id = $1`, [open.id, email]);
      } else {
        await c.query(
          `INSERT INTO verification_case (user_id, method, student_email, state)
           VALUES ($1, 'institutional_email', $2, 'pending')`, [userId, email]);
      }
    }
    await c.query(`UPDATE app_user SET student_status = $2 WHERE id = $1`, [userId, after]);
  }

  return { before, after };
}
