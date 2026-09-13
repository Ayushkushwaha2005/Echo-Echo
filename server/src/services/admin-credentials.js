/* ==========================================================================
   QUAD - ADMIN PASSKEY INVITES AND RECOVERY CODES

   Both are one-time secrets: generated with crypto randomness, shown once,
   stored only as salted SHA-256, consumed atomically.
   ========================================================================== */
import { randomInt, randomBytes, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { q, one, tx } from '../db/index.js';
import { ADMIN } from '../config.js';
import { BadRequest, TooMany, Forbidden, NotFound } from '../auth/rbac.js';
import { isPlatformRole } from '../auth/rbac.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const gen = (groups, len) => Array.from({ length: groups },
  () => Array.from({ length: len }, () => ALPHABET[randomInt(0, ALPHABET.length)]).join('')).join('-');
export const normalise = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hash = (code, salt) => createHash('sha256').update(`${salt}:${normalise(code)}`).digest('hex');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/* Platform roles that currently confer anything. A suspended or revoked
   administrator holds none - so their passkey cannot open Campus Control -
   while an invited one keeps theirs so the first passkey can be registered.
   The owner is never affected by admin_account. */
export async function platformRolesOf(userId, { allowInvited = true } = {}) {
  const { rows } = await q(
    `SELECT r.role, a.status AS admin_status FROM user_role r
       LEFT JOIN admin_account a ON a.user_id = r.user_id
      WHERE r.user_id = $1 AND r.status = 'active'`, [userId]);
  return rows.filter((r) => isPlatformRole(r.role) && (r.role === 'platform_owner' || !r.admin_status ||
    r.admin_status === 'active' || (allowInvited && r.admin_status === 'invited'))).map((r) => r.role);
}

export const activeCredentialCount = async (userId) =>
  (await one(`SELECT count(*)::int n FROM webauthn_credential WHERE user_id = $1 AND revoked_at IS NULL`, [userId])).n;

/* ---------- invitations to a mailbox not yet proven ------------------------ */
export function newInviteSecret() {
  const code = gen(3, 4);
  const salt = randomBytes(12).toString('hex');
  return { code, salt, codeHash: hash(code, salt) };
}

/* Called inside the email-code sign-in transaction, after the mailbox was
   proven. Turns a live invitation into the role, the admin_account row and
   the one-time passkey invite (same code, same expiry). */
export async function acceptPendingInvitation(c, userId, email) {
  const inv = (await c.query(
    `SELECT * FROM admin_invitation WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at > now() FOR UPDATE`, [email])).rows[0];
  if (!inv) return null;
  const owner = (await c.query(`SELECT 1 FROM user_role WHERE user_id = $1 AND role = 'platform_owner' AND status = 'active'`, [userId])).rows[0];
  if (owner) return null;
  await c.query(
    `INSERT INTO user_role (user_id, role, granted_by, granted_via) VALUES ($1,$2,$3,'api')
     ON CONFLICT (user_id, role, COALESCE(vendor_id,'00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET status = 'active', revoked_at = NULL, granted_by = $3, granted_at = now()`,
    [userId, inv.role, inv.invited_by]);
  await c.query(
    `INSERT INTO admin_account (user_id, status, permissions, display_name, invited_by, invited_at,
                                invite_email_sent_at, permissions_updated_at, permissions_updated_by)
     VALUES ($1,'invited',$2,$3,$4,$5,$6, now(), $4)
     ON CONFLICT (user_id) DO UPDATE SET status = 'invited', permissions = $2, display_name = $3, invited_by = $4,
            invited_at = $5, invite_email_sent_at = $6, revoked_at = NULL, suspended_at = NULL, status_reason = NULL,
            permissions_updated_at = now(), permissions_updated_by = $4, updated_at = now()`,
    [userId, inv.permissions, inv.name, inv.invited_by, inv.created_at, inv.email_sent_at]);
  await c.query(`UPDATE admin_passkey_invite SET revoked_at = now()
                  WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [userId]);
  await c.query(
    `INSERT INTO admin_passkey_invite (user_id, code_hash, salt, issued_by, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [userId, inv.code_hash, inv.salt, inv.invited_by, inv.expires_at]);
  await c.query(`UPDATE admin_invitation SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1`, [inv.id, userId]);
  return inv;
}

/* ---------- invites -------------------------------------------------------- */
export async function issueInvite(userId, { issuedBy = null } = {}) {
  const u = await one(`SELECT id, name, student_email, phone, status FROM app_user WHERE id = $1`, [userId]);
  if (!u) throw NotFound('No such account');
  if (u.status !== 'active') throw Forbidden('That account is not active');
  if (!(await platformRolesOf(userId)).length) {
    throw Forbidden('Passkey invites are for administrator accounts only');
  }
  const code = gen(3, 4);
  const salt = randomBytes(12).toString('hex');
  const row = await tx(async (c) => {
    await c.query(`UPDATE admin_passkey_invite SET revoked_at = now()
                    WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [userId]);
    return (await c.query(
      `INSERT INTO admin_passkey_invite (user_id, code_hash, salt, issued_by, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval) RETURNING id, expires_at`,
      [userId, hash(code, salt), salt, issuedBy, String(ADMIN.inviteTtlHours)])).rows[0];
  });
  return { code, expiresAt: row.expires_at, account: u.student_email || u.phone, name: u.name };
}

/* Checks an invite and, when `consume` is set, spends it atomically. */
export async function checkInvite(userId, code, { consume = false, client = null } = {}) {
  const run = client ? (s, p) => client.query(s, p) : q;
  const rec = (await run(
    `SELECT * FROM admin_passkey_invite
      WHERE user_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1 ${client ? 'FOR UPDATE' : ''}`, [userId])).rows[0];
  if (!rec) throw BadRequest('No valid passkey invite', 'Ask the platform owner for a new invite, or have it issued on the server.');
  const claim = (await run(
    `UPDATE admin_passkey_invite SET attempts = attempts + 1
      WHERE id = $1 AND attempts < max_attempts RETURNING attempts`, [rec.id])).rows[0];
  if (!claim) {
    await run(`UPDATE admin_passkey_invite SET revoked_at = now() WHERE id = $1`, [rec.id]);
    throw TooMany('Too many incorrect invite codes', 'This invite is cancelled. Ask for a new one.');
  }
  if (!same(hash(code, rec.salt), rec.code_hash)) throw BadRequest('That invite code is not correct');
  /* A correct code does not count as a failed attempt. */
  await run(`UPDATE admin_passkey_invite SET attempts = attempts - 1 WHERE id = $1`, [rec.id]);
  if (consume) {
    const done = (await run(
      `UPDATE admin_passkey_invite SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id`, [rec.id])).rows[0];
    if (!done) throw BadRequest('That invite was already used');
  }
  return rec.id;
}

/* ---------- recovery codes ------------------------------------------------- */
export async function issueRecoveryCodes(client, userId) {
  const batch = randomUUID();
  await client.query(`UPDATE admin_recovery_code SET revoked_at = now()
                       WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId]);
  const codes = [];
  for (let i = 0; i < 10; i++) {
    const code = gen(2, 5);
    const salt = randomBytes(12).toString('hex');
    await client.query(`INSERT INTO admin_recovery_code (user_id, code_hash, salt, batch) VALUES ($1,$2,$3,$4)`,
      [userId, hash(code, salt), salt, batch]);
    codes.push(code);
  }
  return codes;
}

export const remainingRecoveryCodes = async (userId) =>
  (await one(`SELECT count(*)::int n FROM admin_recovery_code WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId])).n;

/* Spends one recovery code. Failed attempts are counted from the audit log,
   per account, so rotating IP addresses does not help: 5 failures in an
   hour locks recovery for that account for the rest of the hour. */
export async function useRecoveryCode(userId, code) {
  const fails = (await one(
    `SELECT count(*)::int n FROM audit_log
      WHERE action = 'auth.recovery' AND outcome = 'denied' AND resource_id = $1
        AND at > now() - interval '1 hour'`, [String(userId)])).n;
  if (fails >= 5) throw TooMany('Too many incorrect recovery codes', 'Try again in an hour, or ask the other administrator.');
  const candidates = (await q(
    `SELECT id, code_hash, salt FROM admin_recovery_code
      WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [userId])).rows;
  const hit = candidates.find((r) => same(hash(code, r.salt), r.code_hash));
  if (!hit) throw BadRequest('That recovery code is not valid');
  const used = await one(`UPDATE admin_recovery_code SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`, [hit.id]);
  if (!used) throw BadRequest('That recovery code was already used');
  return hit.id;
}
