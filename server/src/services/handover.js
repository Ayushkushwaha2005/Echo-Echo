/* ==========================================================================
   QUAD — HANDOVER VERIFICATION CODES

   Two physical handovers, two independent secrets, held by two different
   people who are not the delivery partner:

     pickup    the CAFETERIA holds it. The partner collecting the food must
               type what the counter reads out. This is what makes it
               impossible for a partner to claim a collection they did not
               make, or for one partner to collect another's order.

     delivery  the CUSTOMER holds it. The partner must type what the customer
               reads out. This is what makes `delivered` mean "the food
               reached the person who paid for it" rather than "the partner
               pressed a button".

   The partner is on the VERIFYING side of both, never the issuing side.
   There is no route by which a partner can read, generate, regenerate or
   change either code — issuePickup() authorises the cafeteria and
   issueDelivery() authorises the customer, and both are the only writers.

   Everything else here is the same discipline as services/otp.js, because
   it is the same problem: a short numeric secret that guards a real-world
   action. Salted SHA-256, never stored or logged in the clear, expiring,
   attempt-capped, single-use, and enforced in the database rather than in
   process memory so it survives a restart and works across instances.

   Deliberately NOT SMS. Both parties are already signed in and already
   authorised to see the order, so the code is shown in-app. An SMS would add
   per-message cost and a new failure mode (a phone with no signal in a
   basement kitchen) without adding any proof.
   ========================================================================== */
import { randomInt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { q, one } from '../db/index.js';
import { BadRequest, Conflict, TooMany, NotFound } from '../auth/rbac.js';

const LENGTH = 6;

const DEFAULTS = {
  handover_pickup_ttl_seconds: 1800,
  handover_delivery_ttl_seconds: 5400,
  handover_max_attempts: 5,
};

/* Config lives in platform_config so an administrator can retune the
   lifetimes without a deploy. A missing or malformed row falls back to the
   default rather than to "no expiry". */
async function setting(key) {
  const row = await one(`SELECT value FROM platform_config WHERE key = $1`, [key]);
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULTS[key];
}

const hash = (code, salt) => createHash('sha256').update(`${salt}:${code}`).digest('hex');

/* Uniform over the whole range, so 000000 is exactly as likely as any other
   code and there is no leading-digit bias to exploit. */
const freshCode = () => String(randomInt(0, 10 ** LENGTH)).padStart(LENGTH, '0');

/* ---------- issuing ------------------------------------------------------
   Issuing is idempotent in the way that matters to a human: asking twice
   inside the lifetime returns the SAME code rather than either refusing
   (which strands a customer who closed the app) or minting a second live
   code (which would mean two valid secrets for one handover).

   It cannot be used to extend a code's life — the expiry is set once, when
   the code is first created, and a re-issue never moves it.
   ========================================================================== */
async function issue(c, orderId, kind, { issuedTo, ttlSeconds, maxAttempts }) {
  /* An unconsumed, unexpired code stands. `one_live_handover_code` makes
     this the only row that can exist for the pair. */
  const live = (await c.query(
    `SELECT * FROM order_handover_code
      WHERE order_id = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > now()
      FOR UPDATE`, [orderId, kind])).rows[0];
  if (live) {
    /* The plaintext is gone — it was returned once and never stored — so a
       standing code cannot be re-shown. Rotating it is the honest answer:
       the previous one is retired and a new one issued to the same party. */
    await c.query(
      `UPDATE order_handover_code SET consumed_at = now() WHERE id = $1`, [live.id]);
  }

  const code = freshCode();
  const salt = randomBytes(12).toString('hex');
  const row = (await c.query(
    `INSERT INTO order_handover_code
       (order_id, kind, code_hash, salt, max_attempts, issued_to, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)
     RETURNING id, expires_at, max_attempts`,
    [orderId, kind, hash(code, salt), salt, maxAttempts, issuedTo || null,
     String(ttlSeconds)])).rows[0];

  /* The ONLY moment the plaintext exists outside the issuing party's screen.
     It is returned up the stack, rendered once, and never persisted, logged
     or notified. */
  return { code, codeId: row.id, expiresAt: row.expires_at,
           maxAttempts: row.max_attempts, kind, rotated: !!live };
}

export async function issuePickup(c, orderId, { issuedTo } = {}) {
  return issue(c, orderId, 'pickup', {
    issuedTo,
    ttlSeconds: await setting('handover_pickup_ttl_seconds'),
    maxAttempts: await setting('handover_max_attempts'),
  });
}

export async function issueDelivery(c, orderId, { issuedTo } = {}) {
  return issue(c, orderId, 'delivery', {
    issuedTo,
    ttlSeconds: await setting('handover_delivery_ttl_seconds'),
    maxAttempts: await setting('handover_max_attempts'),
  });
}

/* ---------- verifying ----------------------------------------------------
   Called inside the same transaction as the state change it authorises, so
   there is no window in which a code is consumed but the order did not move,
   or an order moved on a code that was not consumed.

   Every outcome costs an attempt, including a malformed one: otherwise the
   ceiling could be walked around by sending rubbish to learn the shape of
   the error. Exhausting the ceiling kills the code outright rather than
   merely reporting a failure, so a partner cannot grind a 6-digit space.

   @returns the consumed row, for the caller's audit detail.
   @throws  BadRequest / TooMany / Conflict — never a boolean, so a caller
            that forgets to check a return value still cannot proceed.
   ========================================================================== */
export async function verify(c, orderId, kind, code, { verifiedBy }) {
  /* ---- the attempt is spent on its OWN connection, deliberately --------
     verify() runs inside the transaction that will move the order, and that
     transaction is rolled back whenever verification fails. If the attempt
     counter were incremented on `c`, the rollback would take the increment
     with it — every wrong guess would be free, the ceiling would never
     engage, and a six-digit code would be walkable in a few seconds.

     So the counter is written through the pool, outside the caller's
     transaction, where it survives the rollback. Consumption on success
     stays on `c`, because THAT must be atomic with the state change.

     The read and the increment are one statement so two concurrent guesses
     cannot both see the same `attempts` value, and the row is never locked
     by `c` first — locking it there and then updating it here would
     deadlock the request against itself. */
  const bumped = (await q(
    `UPDATE order_handover_code
        SET attempts = attempts + 1
      WHERE id = (SELECT id FROM order_handover_code
                   WHERE order_id = $1 AND kind = $2
                   ORDER BY issued_at DESC LIMIT 1)
        AND consumed_at IS NULL
        AND expires_at > now()
        AND attempts < max_attempts
      RETURNING *`, [orderId, kind])).rows[0];

  if (!bumped) {
    /* Nothing was spendable. Say precisely why, from the row as it stands. */
    const row = await one(
      `SELECT * FROM order_handover_code
        WHERE order_id = $1 AND kind = $2 ORDER BY issued_at DESC LIMIT 1`,
      [orderId, kind]);
    if (!row) {
      throw Conflict(`No ${kind} code has been issued for this order`,
        kind === 'pickup'
          ? 'The cafeteria has not shown a pickup code yet. Ask at the counter.'
          : 'The customer has not been shown a delivery code yet.');
    }
    if (row.consumed_at) {
      throw Conflict(`That ${kind} code is no longer valid`,
        'It has already been used, replaced, or locked after too many attempts.');
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw Conflict(`That ${kind} code has expired`,
        kind === 'pickup'
          ? 'Ask the counter to show a new one.'
          : 'Ask the customer to refresh their code in the app.');
    }
    /* Attempts exhausted but never retired — retire it now. */
    await q(`UPDATE order_handover_code SET consumed_at = now()
              WHERE id = $1 AND consumed_at IS NULL`, [row.id]);
    throw TooMany('Too many incorrect attempts',
      `This ${kind} code has been locked. A new one must be issued.`);
  }

  const supplied = String(code ?? '').trim();
  const attempt = Buffer.from(hash(supplied, bumped.salt));
  const stored = Buffer.from(bumped.code_hash);
  const ok = attempt.length === stored.length && timingSafeEqual(attempt, stored);

  if (!ok) {
    const left = bumped.max_attempts - bumped.attempts;
    if (left <= 0) {
      /* That was the last one. Retire the code rather than leaving a dead
         row that reports "0 attempts remaining" for ever. */
      await q(`UPDATE order_handover_code SET consumed_at = now()
                WHERE id = $1 AND consumed_at IS NULL`, [bumped.id]);
      throw TooMany('Too many incorrect attempts',
        `This ${kind} code is now locked. A new one must be issued.`);
    }
    throw BadRequest('That code does not match',
      `${left} attempt${left === 1 ? '' : 's'} remaining.`);
  }

  /* Correct. Consume it inside the CALLER's transaction, so the code and the
     state change commit together or not at all. A concurrent second verify —
     two taps, two devices — finds the row already consumed and gets nothing. */
  const consumed = (await c.query(
    `UPDATE order_handover_code SET consumed_at = now(), consumed_by = $2
      WHERE id = $1 AND consumed_at IS NULL
      RETURNING id, kind, attempts, issued_at, consumed_at`,
    [bumped.id, verifiedBy || null])).rows[0];
  if (!consumed) {
    throw Conflict(`That ${kind} code has already been used`,
      'Another device confirmed this handover a moment ago.');
  }
  return consumed;
}

/* ---------- reading ------------------------------------------------------
   Status only — never the code. Used by the order detail view so each party
   can see whether a handover is still outstanding without either of them
   learning the other's secret.                                             */
export async function statusFor(qy, orderId) {
  const { rows } = await qy(
    `SELECT kind, attempts, max_attempts, issued_at, expires_at, consumed_at
       FROM order_handover_code WHERE order_id = $1 ORDER BY issued_at`, [orderId]);
  const out = {};
  for (const r of rows) {
    out[r.kind] = {
      issued: true,
      verified: !!r.consumed_at,
      expired: !r.consumed_at && new Date(r.expires_at).getTime() <= Date.now(),
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      expiresAt: r.expires_at,
    };
  }
  for (const k of ['pickup', 'delivery']) {
    if (!out[k]) out[k] = { issued: false, verified: false, expired: false };
  }
  return out;
}

/* Whether a given handover has actually been proven. The state machine asks
   this before it will move an order, so a missing code is a refusal rather
   than a silently skipped check. */
export async function isVerified(c, orderId, kind) {
  const r = (await c.query(
    `SELECT 1 FROM order_handover_code
      WHERE order_id = $1 AND kind = $2 AND consumed_at IS NOT NULL
        AND consumed_by IS NOT NULL LIMIT 1`, [orderId, kind])).rows[0];
  return !!r;
}

export const CODE_LENGTH = LENGTH;
