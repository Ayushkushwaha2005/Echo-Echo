/* ==========================================================================
   QUAD — OTP

   Read this before changing it:

   There is NO development bypass. There is no fixed code, no "accept any
   six digits", no console-logged code that a client can read back. If no
   SMS provider is configured, sendOtp() throws ProviderUnavailable and the
   route returns 503 `configuration_required`. That means with the repo as
   shipped, nobody can log in — which is the honest state of an application
   with no SMS gateway, and is preferable to a login that lies.

   The code itself is generated with crypto.randomInt, stored only as a
   salted SHA-256, and consumed on first successful verify so it cannot be
   replayed. Expiry, per-challenge attempt ceiling, resend cooldown and a
   per-phone hourly send cap are all enforced against the database, not
   in-process memory, so they survive a restart and work across instances.
   ========================================================================== */
import { randomInt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { q, one, tx } from '../db/index.js';
import { OTP } from '../config.js';
import { ProviderUnavailable, TooMany, BadRequest } from '../auth/rbac.js';

export const E164 = /^\+[1-9]\d{7,14}$/;
export function normalisePhone(input, defaultCountry = '+91') {
  const raw = String(input || '').replace(/[\s()-]/g, '');
  if (E164.test(raw)) return raw;
  if (/^\d{10}$/.test(raw)) return defaultCountry + raw;         // bare Indian mobile
  if (/^0\d{10}$/.test(raw)) return defaultCountry + raw.slice(1);
  throw BadRequest('Enter a valid mobile number', 'Expected 10 digits, or an E.164 number.');
}

const hash = (code, salt) => createHash('sha256').update(`${salt}:${code}`).digest('hex');

/* ---------- providers ----------------------------------------------------
   Each adapter returns a provider reference for the audit trail, or throws.
   Adding a provider means adding a case here and a block in config.js.    */
/* A provider error body can quote the request, so the code is scrubbed from
   anything that might reach an exception message and from there a log. */
const scrub = (text, code) => String(text).split(code).join('[code]').slice(0, 300);

const smsBody = (code) => OTP.smsText
  .replace('{code}', code)
  .replace('{minutes}', String(Math.round(OTP.ttlSeconds / 60)));

const providers = {
  async twilio(phone, code) {
    const { accountSid, authToken, from, messagingServiceSid } = OTP.twilio;
    const body = new URLSearchParams({ To: phone, Body: smsBody(code) });
    if (messagingServiceSid) body.set('MessagingServiceSid', messagingServiceSid);
    else body.set('From', from);
    const res = await fetch(`${OTP.twilioBase}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) throw new Error(`twilio ${res.status}: ${scrub(await res.text(), code)}`);
    return (await res.json()).sid;
  },

  async msg91(phone, code) {
    const { authKey, templateId, sender } = OTP.msg91;
    const res = await fetch(`${OTP.msg91Base}/api/v5/flow/`, {
      method: 'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_id: templateId, sender,
        recipients: [{ mobiles: phone.replace('+', ''), [OTP.msg91.otpVar]: code }],
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`msg91 ${res.status}: ${scrub(text, code)}`);
    /* MSG91 answers HTTP 200 for many failures (bad template, DLT rejection,
       auth) with {"type":"error"}. Only an explicit success is "sent". */
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (json?.type !== 'success') throw new Error(`msg91 rejected the message: ${scrub(text, code)}`);
    return json.request_id || json.message || 'msg91';
  },
};

export const isConfigured = () => OTP.configured;

/* ---------- send ---------------------------------------------------------- */
export async function sendOtp(phone, { purpose = 'login', ip } = {}) {
  if (!OTP.configured) {
    throw ProviderUnavailable(
      'OTP service not configured',
      'Set OTP_PROVIDER (twilio|msg91) and its credentials on the server. ' +
      'No code can be issued and no session can be created until then.');
  }

  if (!OTP.allowedPrefixes.some((pre) => phone.startsWith(pre))) {
    throw BadRequest('Use an Indian mobile number',
      'Codes are only sent to numbers on the campus network\'s allowed list.');
  }

  /* Sends for one number are serialised: without this, a burst of parallel
     requests all pass the cooldown and hourly checks before any of them
     records a challenge, and each one pays for an SMS. The lock is scoped
     to this transaction and to this phone number only. */
  return tx(async (c) => {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('otp:' || $1))`, [phone]);

  const hourly = (await c.query(
    `SELECT count(*)::int AS n FROM otp_challenge
      WHERE phone = $1 AND created_at > now() - interval '1 hour'`, [phone])).rows[0];
  if (hourly.n >= OTP.maxSendsPerHour) {
    throw TooMany('Too many codes requested',
      `Limit is ${OTP.maxSendsPerHour} per hour for this number. Try again later.`);
  }

  const last = (await c.query(
    `SELECT created_at FROM otp_challenge WHERE phone = $1
      ORDER BY created_at DESC LIMIT 1`, [phone])).rows[0];
  if (last) {
    const since = (Date.now() - new Date(last.created_at).getTime()) / 1000;
    if (since < OTP.resendCooldownSeconds) {
      throw TooMany('Please wait before requesting another code',
        `${Math.ceil(OTP.resendCooldownSeconds - since)}s remaining.`);
    }
  }

  /* Uniform random over the full range — no leading-zero bias. */
  const code = String(randomInt(0, 10 ** OTP.length)).padStart(OTP.length, '0');
  const salt = randomBytes(12).toString('hex');

  /* Send FIRST. If the gateway fails we must not leave a live challenge
     for a code the user never received. */
  const ref = await providers[OTP.provider](phone, code);

  const row = (await c.query(
    `INSERT INTO otp_challenge (phone, code_hash, salt, purpose, max_attempts,
                                expires_at, provider, provider_ref)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval, $7,$8)
     RETURNING id, expires_at`,
    [phone, hash(code, salt), salt, purpose, OTP.maxAttempts, String(OTP.ttlSeconds), OTP.provider, ref])).rows[0];

  /* The code is never returned, logged, or persisted in the clear. */
  return {
    challengeId: row.id,
    expiresAt: row.expires_at,
    resendAfterSeconds: OTP.resendCooldownSeconds,
    length: OTP.length,
  };
  });
}

/* ---------- verify -------------------------------------------------------
   Returns true only for a live, unconsumed challenge whose code matches.
   Every outcome consumes an attempt; exhausting attempts kills the
   challenge rather than merely reporting a failure.                       */
export async function verifyOtp(phone, code) {
  if (!OTP.configured) {
    throw ProviderUnavailable('OTP service not configured',
      'Verification cannot be performed without a configured provider.');
  }
  const c = await one(
    `SELECT * FROM otp_challenge
      WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`, [phone]);

  if (!c) throw BadRequest('That code has expired', 'Request a new one.');

  /* Claim one attempt atomically. Reading the counter and then incrementing
     it let a burst of parallel guesses all pass the ceiling check; a single
     conditional UPDATE means the database hands out exactly max_attempts. */
  const claim = await one(
    `UPDATE otp_challenge SET attempts = attempts + 1
      WHERE id = $1 AND attempts < max_attempts
        AND consumed_at IS NULL AND expires_at > now()
      RETURNING attempts`, [c.id]);
  if (!claim) {
    await q(`UPDATE otp_challenge SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`, [c.id]);
    throw TooMany('Too many incorrect attempts', 'Request a new code.');
  }
  c.attempts = claim.attempts - 1;

  const attempt = Buffer.from(hash(String(code || ''), c.salt));
  const stored = Buffer.from(c.code_hash);
  const ok = attempt.length === stored.length && timingSafeEqual(attempt, stored);

  if (!ok) {
    const left = c.max_attempts - c.attempts - 1;
    throw BadRequest('Incorrect code',
      left > 0 ? `${left} attempt${left === 1 ? '' : 's'} remaining.` : 'No attempts remaining.');
  }

  /* Consume atomically — a concurrent second verify finds nothing. */
  const consumed = await one(
    `UPDATE otp_challenge SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL RETURNING id`, [c.id]);
  if (!consumed) throw BadRequest('That code has already been used', 'Request a new one.');

  return true;
}
