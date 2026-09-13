/* ==========================================================================
   QUAD - ADMINISTRATOR PASSKEY ROUTES

   Sign in        POST /auth/passkey/login/options  -> /login/verify
   Re-confirm     POST /auth/passkey/reauth/options -> /reauth/verify
   Register       POST /auth/passkey/register/options -> /register/verify
                  allowed when ONE of these holds for an account that holds
                  an administrator role:
                    - the session is already passkey-verified (a second device)
                    - the session was opened with a recovery code
                    - the account has no passkey yet and a valid one-time
                      invite code is supplied (issued on the server shell, or
                      by the platform owner)
   Recovery       POST /auth/recovery/verify  (from an email-code session)
   Devices        GET  /auth/passkey/status, POST /auth/passkey/credentials/:id/revoke
   Invites        POST /admin/passkey-invites  (platform owner, recent passkey)
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { BadRequest, Forbidden, NotFound, Unauthenticated, landingSurface, SURFACE_ROLES, isPlatformRole } from '../auth/rbac.js';
import { issueSession, cookieOptions } from '../auth/session.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { newChallenge, verifyRegistration, verifyAssertion, b64url, fromB64url } from '../auth/webauthn.js';
import { SESSION, WEBAUTHN, ADMIN, RATE_LIMITS } from '../config.js';
import { audit } from '../audit.js';
import {
  platformRolesOf, activeCredentialCount, issueInvite, checkInvite,
  issueRecoveryCodes, remainingRecoveryCodes, useRecoveryCode,
} from '../services/admin-credentials.js';

const ADMIN_TTL = Number(process.env.ADMIN_SESSION_TTL_MINUTES || 240);
const limit = (max) => ({ config: { rateLimit: { max, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } } });

async function storeChallenge(purpose, userId) {
  const challenge = newChallenge();
  await q(`INSERT INTO webauthn_challenge (challenge, purpose, user_id, expires_at)
           VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval)`,
    [challenge, purpose, userId, String(WEBAUTHN.challengeTtlSeconds)]);
  return challenge;
}
const consumer = (purpose, userId) => async (challenge) => !!(await one(
  `UPDATE webauthn_challenge SET consumed_at = now()
    WHERE challenge = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
      AND ($3::uuid IS NULL AND user_id IS NULL OR user_id = $3) RETURNING id`,
  [challenge, purpose, userId]));

const loadCredential = (userId = null) => async (credentialId) => one(
  `SELECT * FROM webauthn_credential WHERE credential_id = $1 AND ($2::uuid IS NULL OR user_id = $2)`,
  [credentialId, userId]);

const allHeldRoles = (actor) => [...actor.roles, ...(actor.withheldRoles || [])];

export default async function passkeyRoutes(app) {
  /* ---------- sign in ------------------------------------------------------- */
  app.post('/auth/passkey/login/options', limit(RATE_LIMITS.otpSend), async () => ({
    challenge: await storeChallenge('login', null),
    rpId: WEBAUTHN.rpId, timeout: WEBAUTHN.challengeTtlSeconds * 1000,
    userVerification: 'required', allowCredentials: [],
  }));

  app.post('/auth/passkey/login/verify', limit(RATE_LIMITS.otpVerify), async (req, reply) => {
    let result;
    try {
      result = await verifyAssertion(req.body?.credential, {
        rpId: WEBAUTHN.rpId, origins: WEBAUTHN.origins,
        loadCredential: loadCredential(), consumeChallenge: consumer('login', null),
      });
    } catch (e) {
      await audit(req, { action: 'auth.passkey.login', outcome: 'denied', detail: { message: e.message } });
      throw e;
    }
    const { stored, signCount, backedUp } = result;
    const user = await one(`SELECT * FROM app_user WHERE id = $1`, [stored.user_id]);
    if (!user || user.status !== 'active') {
      await audit(req, { action: 'auth.passkey.login', resourceId: stored.user_id, outcome: 'denied', detail: { reason: 'inactive' } });
      throw Forbidden('This account is not active');
    }
    const roles = await platformRolesOf(user.id, { allowInvited: false });
    if (!roles.length) {
      await audit(req, { action: 'auth.passkey.login', resourceId: user.id, outcome: 'denied', detail: { reason: 'no_admin_role' } });
      throw Forbidden('This passkey is for an account that no longer administers ECHO ECHO');
    }
    await q(`UPDATE webauthn_credential SET sign_count = $2, last_used_at = now(), backed_up = $3 WHERE id = $1`,
      [stored.id, signCount, backedUp]);
    const token = await issueSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'],
                                                method: 'passkey', credentialId: stored.id, ttlMinutes: ADMIN_TTL });
    reply.setCookie(SESSION.cookieName, token, cookieOptions(ADMIN_TTL));
    await audit(req, { action: 'auth.passkey.login', resource: 'user', resourceId: user.id, outcome: 'ok',
                       detail: { credential: stored.label } });
    const all = (await q(`SELECT role FROM user_role WHERE user_id = $1 AND status = 'active'`, [user.id])).rows.map((r) => r.role);
    return { user: { id: user.id, name: user.name }, roles: all, surface: landingSurface(all), via: 'passkey' };
  });

  /* ---------- re-confirm on an existing session ------------------------------ */
  app.post('/auth/passkey/reauth/options', async (req) => {
    if (!req.actor) throw Unauthenticated();
    const creds = (await q(`SELECT credential_id, transports FROM webauthn_credential
                             WHERE user_id = $1 AND revoked_at IS NULL`, [req.actor.id])).rows;
    if (!creds.length) throw Forbidden('This account has no passkey yet', 'Set one up first.');
    return {
      challenge: await storeChallenge('reauth', req.actor.id),
      rpId: WEBAUTHN.rpId, timeout: WEBAUTHN.challengeTtlSeconds * 1000, userVerification: 'required',
      allowCredentials: creds.map((c) => ({ type: 'public-key', id: c.credential_id, transports: c.transports })),
    };
  });

  app.post('/auth/passkey/reauth/verify', async (req) => {
    if (!req.actor) throw Unauthenticated();
    if (req.actor.sessionKind === 'recovery') throw Forbidden('Set up a new passkey first');
    let result;
    try {
      result = await verifyAssertion(req.body?.credential, {
        rpId: WEBAUTHN.rpId, origins: WEBAUTHN.origins,
        loadCredential: loadCredential(req.actor.id), consumeChallenge: consumer('reauth', req.actor.id),
      });
    } catch (e) {
      await audit(req, { action: 'auth.passkey.reauth', resourceId: req.actor.id, outcome: 'denied', detail: { message: e.message } });
      throw e;
    }
    await q(`UPDATE webauthn_credential SET sign_count = $2, last_used_at = now() WHERE id = $1`,
      [result.stored.id, result.signCount]);
    await q(`UPDATE session SET auth_method = 'passkey', passkey_verified_at = now(), passkey_credential_id = $2,
                    expires_at = least(expires_at, now() + ($3 || ' minutes')::interval)
              WHERE token_hash = $1`, [req.actor.tokenHash, result.stored.id, String(ADMIN_TTL)]);
    await audit(req, { action: 'auth.passkey.reauth', resource: 'user', resourceId: req.actor.id, outcome: 'ok' });
    return { ok: true, validForMinutes: ADMIN.reauthMinutes };
  });

  /* ---------- status --------------------------------------------------------- */
  app.get('/auth/passkey/status', async (req) => {
    if (!req.actor) throw Unauthenticated();
    const eligible = allHeldRoles(req.actor).some(isPlatformRole);
    const credentials = eligible ? (await q(
      `SELECT id, label, created_at, last_used_at, backed_up FROM webauthn_credential
        WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at`, [req.actor.id])).rows : [];
    const invite = eligible && !credentials.length ? await one(
      `SELECT expires_at FROM admin_passkey_invite WHERE user_id = $1 AND consumed_at IS NULL
          AND revoked_at IS NULL AND expires_at > now()`, [req.actor.id]) : null;
    return {
      required: ADMIN.passkeyRequired, eligible,
      sessionVerified: req.actor.sessionKind === 'passkey' && !!req.actor.passkeyAt,
      recoverySession: req.actor.sessionKind === 'recovery',
      credentials, inviteWaiting: !!invite,
      recoveryCodesRemaining: eligible ? await remainingRecoveryCodes(req.actor.id) : 0,
      reauthMinutes: ADMIN.reauthMinutes,
    };
  });

  /* ---------- register -------------------------------------------------------- */
  async function assertMayRegister(req, { consumeInvite = false, client = null } = {}) {
    if (!req.actor) throw Unauthenticated();
    const held = allHeldRoles(req.actor);
    if (!held.some(isPlatformRole) && !(await platformRolesOf(req.actor.id)).length) {
      throw Forbidden('Passkeys are for administrator accounts');
    }
    if (req.actor.sessionKind === 'passkey' && req.actor.passkeyAt) return 'additional_device';
    if (req.actor.sessionKind === 'recovery') return 'recovery';
    if ((await activeCredentialCount(req.actor.id)) > 0) {
      throw Forbidden('This account already has a passkey',
        'Sign in with it to add another device, or use a recovery code if you have lost it.');
    }
    if (!req.body?.inviteCode) throw BadRequest('Enter your one-time passkey invite code');
    await checkInvite(req.actor.id, req.body.inviteCode, { consume: consumeInvite, client });
    return 'invite';
  }

  app.post('/auth/passkey/register/options', limit(RATE_LIMITS.enrol), async (req) => {
    const via = await assertMayRegister(req);
    const u = await one(`SELECT name, student_email, phone FROM app_user WHERE id = $1`, [req.actor.id]);
    const existing = (await q(`SELECT credential_id FROM webauthn_credential WHERE user_id = $1 AND revoked_at IS NULL`,
      [req.actor.id])).rows;
    return {
      via,
      challenge: await storeChallenge('register', req.actor.id),
      rp: { id: WEBAUTHN.rpId, name: WEBAUTHN.rpName },
      user: { id: b64url(Buffer.from(req.actor.id.replace(/-/g, ''), 'hex')),
              name: u.student_email || u.phone || req.actor.id, displayName: u.name || 'ECHO ECHO administrator' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      timeout: WEBAUTHN.challengeTtlSeconds * 1000,
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.credential_id })),
    };
  });

  app.post('/auth/passkey/register/verify', limit(RATE_LIMITS.enrol), async (req, reply) => {
    const label = String(req.body?.label || '').trim().slice(0, 60) || 'Passkey';
    const out = await tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('passkey:' || $1))`, [req.actor?.id || '']);
      const via = await assertMayRegister(req, { consumeInvite: true, client: c });
      const reg = await verifyRegistration(req.body?.credential, {
        rpId: WEBAUTHN.rpId, origins: WEBAUTHN.origins,
        consumeChallenge: async (ch) => !!(await c.query(
          `UPDATE webauthn_challenge SET consumed_at = now()
            WHERE challenge = $1 AND purpose = 'register' AND user_id = $2 AND consumed_at IS NULL
              AND expires_at > now() RETURNING id`, [ch, req.actor.id])).rowCount,
      });
      const cred = (await c.query(
        `INSERT INTO webauthn_credential (user_id, credential_id, public_key_jwk, algorithm, sign_count, aaguid,
                                          transports, backed_up, label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, label, created_at`,
        [req.actor.id, reg.credentialId, JSON.stringify(reg.jwk), reg.alg, reg.signCount, reg.aaguid,
         Array.isArray(req.body?.credential?.response?.transports) ? req.body.credential.response.transports.slice(0, 6) : [],
         reg.backedUp, label])).rows[0];
      /* First passkey, or a recovery: new recovery codes, shown once. A
         recovery also revokes the lost passkeys and every other session. */
      let recoveryCodes = null;
      if (via !== 'additional_device') recoveryCodes = await issueRecoveryCodes(c, req.actor.id);
      /* An invited administrator becomes active by completing this ceremony. */
      if (via === 'invite') {
        await c.query(`UPDATE admin_account SET status = 'active', activated_at = coalesce(activated_at, now()),
                              updated_at = now() WHERE user_id = $1 AND status = 'invited'`, [req.actor.id]);
      }
      if (via === 'recovery') {
        await c.query(`UPDATE webauthn_credential SET revoked_at = now(), revoked_by = $1
                        WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`, [req.actor.id, cred.id]);
        await c.query(`UPDATE session SET revoked_at = now()
                        WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2`, [req.actor.id, req.actor.tokenHash]);
      }
      /* The ceremony verified the person on the device; the session becomes
         a passkey session. */
      await c.query(`UPDATE session SET auth_method = 'passkey', passkey_verified_at = now(), passkey_credential_id = $2,
                            expires_at = least(expires_at, now() + ($3 || ' minutes')::interval)
                      WHERE token_hash = $1`, [req.actor.tokenHash, cred.id, String(ADMIN_TTL)]);
      return { cred, via, recoveryCodes };
    });
    reply.setCookie(SESSION.cookieName, req.cookies[SESSION.cookieName], cookieOptions(ADMIN_TTL));
    await audit(req, { action: 'auth.passkey.register', resource: 'user', resourceId: req.actor.id, outcome: 'ok',
                       detail: { via: out.via, label: out.cred.label } });
    return {
      credential: out.cred, via: out.via,
      recoveryCodes: out.recoveryCodes,
      note: out.recoveryCodes
        ? 'Save these recovery codes somewhere safe and offline. Each works once, only to set up a new passkey. They are not shown again.'
        : null,
    };
  });

  /* ---------- recovery ---------------------------------------------------------- */
  app.post('/auth/recovery/verify', limit(RATE_LIMITS.enrol), async (req) => {
    if (!req.actor) throw Unauthenticated('Sign in with your student email first');
    if (!(await platformRolesOf(req.actor.id)).length) throw Forbidden('Recovery codes are for administrator accounts');
    try {
      await useRecoveryCode(req.actor.id, req.body?.code);
    } catch (e) {
      await audit(req, { action: 'auth.recovery', resource: 'user', resourceId: req.actor.id, outcome: 'denied' });
      throw e;
    }
    await q(`UPDATE session SET auth_method = 'recovery', passkey_verified_at = NULL,
                    expires_at = least(expires_at, now() + interval '15 minutes')
              WHERE token_hash = $1`, [req.actor.tokenHash]);
    await audit(req, { action: 'auth.recovery', resource: 'user', resourceId: req.actor.id, outcome: 'ok' });
    return { ok: true, next: 'Register a new passkey within 15 minutes. Your old passkeys will be revoked when you do.' };
  });

  /* ---------- devices ------------------------------------------------------------ */
  app.post('/auth/passkey/credentials/:id/revoke', async (req) => {
    if (!req.actor) throw Unauthenticated();
    assertRecentPasskey(req.actor, 'removing a passkey');
    const cred = await one(`SELECT * FROM webauthn_credential WHERE id = $1 AND revoked_at IS NULL`, [req.params.id]);
    if (!cred) throw NotFound('No such passkey');
    const own = cred.user_id === req.actor.id;
    if (!own && !req.actor.roles.includes('platform_owner')) {
      throw Forbidden('Only the platform owner can remove another administrator\'s passkey');
    }
    await q(`UPDATE webauthn_credential SET revoked_at = now(), revoked_by = $2 WHERE id = $1`, [cred.id, req.actor.id]);
    /* Sessions opened with that passkey end now. */
    await q(`UPDATE session SET revoked_at = now() WHERE passkey_credential_id = $1 AND revoked_at IS NULL
               AND token_hash <> $2`, [cred.id, req.actor.tokenHash]);
    await audit(req, { action: 'auth.passkey.revoke', resource: 'webauthn_credential', resourceId: cred.id,
                       outcome: 'ok', detail: { owner: cred.user_id, label: cred.label } });
    return { ok: true };
  });

  /* ---------- invites (owner) ---------------------------------------------------- */
  app.post('/admin/passkey-invites', async (req) => {
    if (!req.actor?.roles.includes('platform_owner')) {
      throw Forbidden('Only the platform owner issues administrator passkey invites');
    }
    assertRecentPasskey(req.actor, 'inviting an administrator to set up a passkey');
    const target = await one(`SELECT id FROM app_user WHERE id = $1`, [req.body?.userId]);
    if (!target) throw NotFound('No such account');
    if (target.id === req.actor.id) throw BadRequest('Add a device from your own passkey settings instead');
    const out = await issueInvite(target.id, { issuedBy: req.actor.id });
    await audit(req, { action: 'auth.passkey.invite', resource: 'user', resourceId: target.id, outcome: 'ok',
                       detail: { expiresAt: out.expiresAt } });
    return { ...out, note: 'Give this code to the administrator in person or by a channel you trust. It is shown once.' };
  });

  app.get('/admin/administrators', async (req) => {
    if (!req.actor?.roles.some(isPlatformRole)) throw Forbidden('Administrators only');
    if (!req.actor.isOwner && !(req.actor.permissions || []).includes('admins.view')) {
      throw Forbidden('You do not have permission to see administrators');
    }
    const { rows } = await q(
      `SELECT u.id, u.name, u.student_email, r.role, r.granted_via,
              (SELECT count(*)::int FROM webauthn_credential w WHERE w.user_id = u.id AND w.revoked_at IS NULL) AS passkeys,
              (SELECT max(last_used_at) FROM webauthn_credential w WHERE w.user_id = u.id) AS last_passkey_use,
              (SELECT json_agg(json_build_object('id', w.id, 'label', w.label, 'created_at', w.created_at, 'last_used_at', w.last_used_at))
                 FROM webauthn_credential w WHERE w.user_id = u.id AND w.revoked_at IS NULL) AS credentials
         FROM user_role r JOIN app_user u ON u.id = r.user_id
        WHERE r.status = 'active' AND r.role IN ('platform_owner','platform_admin','support')
        ORDER BY r.role, u.name`);
    return { administrators: rows, required: ADMIN.passkeyRequired };
  });
}

export { SURFACE_ROLES, fromB64url };
