/* ==========================================================================
   QUAD — CAMPUS CONTROL (admin API)

   User management, role assignment, partner approval, flags and the audit
   log. Note assertGrantable(): `platform_owner` is not grantable over this
   API at all, and platform-level roles may only be granted by the owner, so
   an admin cannot escalate themselves or a friend.

   Assigning a cafeteria owner does NOT create credentials. It creates (or
   finds) the user by phone and grants the role; that person then signs in
   with their own OTP like everybody else. There is no invented password.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { authorize, assertGrantable, ROLES, BadRequest, NotFound, Conflict, Forbidden } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { normalisePhone } from '../services/otp.js';
import { revokeAllForUser } from '../auth/session.js';
import { allFlags, setFlag } from '../services/flags.js';
import { providerStatus } from '../config.js';
import { audit } from '../audit.js';
import { notifyAsync } from '../services/notify.js';
import { livePolicy, depositBalance, partnerRating } from './trust.js';
import { readiness } from '../services/readiness.js';

export default async function adminRoutes(app) {
  app.get('/admin/users', async (req) => {
    authorize(req.actor, 'user.read');
    const term = String(req.query?.q || '').trim();
    const { rows } = await q(
      `SELECT u.id, u.name, u.phone, u.email, u.student_email, u.status, u.student_status, u.roll_number,
              u.created_at, u.last_seen_at,
              coalesce(json_agg(json_build_object('role', r.role, 'vendorId', r.vendor_id,
                       'vendorName', v.name, 'status', r.status))
                       FILTER (WHERE r.role IS NOT NULL), '[]') AS roles,
              (SELECT status FROM partner_profile p WHERE p.user_id = u.id) AS partner_status
         FROM app_user u
         LEFT JOIN user_role r ON r.user_id = u.id AND r.status = 'active'
         LEFT JOIN vendor v ON v.id = r.vendor_id
        WHERE $1 = '' OR u.name ILIKE $2 OR u.phone ILIKE $2 OR u.roll_number ILIKE $2
           OR u.student_email ILIKE $2
        GROUP BY u.id ORDER BY u.created_at DESC LIMIT 100`, [term, `%${term}%`]);
    return { users: rows };
  });

  app.get('/admin/users/:id', async (req) => {
    authorize(req.actor, 'user.read');
    const u = await one(`SELECT * FROM app_user WHERE id = $1`, [req.params.id]);
    if (!u) throw NotFound('No such user');
    const roles = (await q(
      `SELECT r.*, v.name AS vendor_name FROM user_role r
         LEFT JOIN vendor v ON v.id = r.vendor_id WHERE r.user_id = $1`, [u.id])).rows;
    const cases = (await q(
      `SELECT id, state, method, submitted_at, decided_at, decision_note FROM verification_case
        WHERE user_id = $1 ORDER BY submitted_at DESC`, [u.id])).rows;
    const orders = await one(
      `SELECT count(*)::int AS n, coalesce(sum(total_paise),0)::int AS spent
         FROM food_order WHERE customer_id = $1 AND state = 'delivered'`, [u.id]);
    return { user: u, roles, verificationHistory: cases, orders };
  });

  /* Grant a role. Also the "Add Cafeteria Owner" flow: pass phone + role +
     vendorId and the account is created if it does not exist. */
  app.post('/admin/users/role', async (req) => {
    authorize(req.actor, 'user.role.grant');
    assertRecentPasskey(req.actor, 'changing administrator or cafeteria roles');
    const { role, vendorId } = req.body || {};
    if (!ROLES[role]) throw BadRequest(`Unknown role "${role}"`);
    assertGrantable(req.actor, role);

    if (['vendor_owner', 'vendor_staff'].includes(role)) {
      if (!vendorId) throw BadRequest('A cafeteria must be chosen for a vendor role');
      const v = await one(`SELECT id FROM vendor WHERE id = $1 AND active`, [vendorId]);
      if (!v) throw NotFound('No such cafeteria');
    } else if (vendorId) {
      throw BadRequest(`"${role}" is not a cafeteria-scoped role`);
    }

    const phone = normalisePhone(req.body?.phone);
    const out = await tx(async (c) => {
      let u = (await c.query(`SELECT * FROM app_user WHERE phone = $1`, [phone])).rows[0];
      let created = false;
      if (!u) {
        u = (await c.query(
          `INSERT INTO app_user (phone, name, email) VALUES ($1,$2,$3) RETURNING *`,
          [phone, req.body?.name || null, req.body?.email || null])).rows[0];
        created = true;
      } else if (req.body?.name && !u.name) {
        await c.query(`UPDATE app_user SET name = $2 WHERE id = $1`, [u.id, req.body.name]);
      }
      const r = (await c.query(
        `INSERT INTO user_role (user_id, role, vendor_id, granted_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, role, COALESCE(vendor_id,'00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET status='active', revoked_at=NULL, granted_by=$4, granted_at=now()
         RETURNING *`, [u.id, role, vendorId || null, req.actor.id])).rows[0];
      return { user: u, role: r, created };
    });

    await audit(req, { action: 'user.role.grant', resource: 'user', resourceId: out.user.id,
                       outcome: 'ok', detail: { role, vendorId, accountCreated: out.created } });
    return {
      ...out,
      /* Honest about onboarding: no credential was created, because this
         product has no passwords. They sign in with their own number. */
      onboarding: {
        method: 'phone_otp',
        message: `${phone} can now sign in with an OTP and will land on ${
          ['vendor_owner', 'vendor_staff'].includes(role) ? 'Counter' :
          ['platform_admin', 'support'].includes(role) ? 'Campus Control' : 'the student site'}.`,
        note: 'No credentials were generated. Notifying them is currently a manual step — ' +
              'no notification provider is connected.',
      },
    };
  });

  app.post('/admin/users/role/revoke', async (req) => {
    authorize(req.actor, 'user.role.revoke');
    assertRecentPasskey(req.actor, 'removing a role');
    const { userId, role, vendorId } = req.body || {};
    assertGrantable(req.actor, role);
    if (role === 'student') throw BadRequest('The student role cannot be revoked');

    const target = await one(`SELECT * FROM app_user WHERE id = $1`, [userId]);
    if (!target) throw NotFound('No such user');
    /* Nobody may strip the platform owner. */
    const isOwner = await one(
      `SELECT 1 FROM user_role WHERE user_id=$1 AND role='platform_owner' AND status='active'`, [userId]);
    if (isOwner) throw Forbidden('The platform owner cannot be modified through this API');

    const r = await q(
      `UPDATE user_role SET status='revoked', revoked_at=now()
        WHERE user_id=$1 AND role=$2 AND ($3::uuid IS NULL OR vendor_id=$3)`,
      [userId, role, vendorId || null]);
    if (!r.rowCount) throw NotFound('That role is not held by this user');
    await audit(req, { action: 'user.role.revoke', resource: 'user', resourceId: userId,
                       outcome: 'ok', detail: { role, vendorId } });
    return { ok: true };
  });

  app.post('/admin/users/:id/status', async (req) => {
    const status = req.body?.status;
    if (!['active', 'suspended'].includes(status)) throw BadRequest('Status must be active or suspended');
    authorize(req.actor, status === 'suspended' ? 'user.suspend' : 'user.reinstate');
    assertRecentPasskey(req.actor, 'suspending or restoring an account');
    const isOwner = await one(
      `SELECT 1 FROM user_role WHERE user_id=$1 AND role='platform_owner' AND status='active'`, [req.params.id]);
    if (isOwner) throw Forbidden('The platform owner cannot be suspended');
    if (req.params.id === req.actor.id) throw Forbidden('You cannot change your own account status');
    /* An administrator's account is governed from Administrator access, so a
       student-suspension permission cannot be used to lock out a colleague. */
    const targetIsAdmin = await one(
      `SELECT 1 FROM user_role WHERE user_id=$1 AND role IN ('platform_admin','support') AND status='active'`, [req.params.id]);
    if (targetIsAdmin) authorize(req.actor, 'admin.suspend');
    const reason = String(req.body?.reason || '').trim().slice(0, 500);

    const u = await one(`UPDATE app_user SET status=$2 WHERE id=$1 RETURNING *`, [req.params.id, status]);
    if (!u) throw NotFound('No such user');
    /* Suspension must take effect now, not at session expiry. */
    if (status === 'suspended') await revokeAllForUser(u.id);
    await audit(req, { action: status === 'suspended' ? 'user.suspend' : 'user.reinstate', resource: 'user',
                       resourceId: u.id, outcome: 'ok', detail: { status, reason: reason || null } });
    return u;
  });

  /* ---------- partner approvals ------------------------------------------ */
  app.get('/admin/partners', async (req) => {
    authorize(req.actor, 'partner.read');
    const { rows } = await q(
      `SELECT p.*, u.name, u.phone, u.student_status, u.roll_number,
              (SELECT count(*)::int FROM food_order o
                WHERE o.partner_id = p.user_id AND o.state='delivered') AS deliveries
         FROM partner_profile p JOIN app_user u ON u.id = p.user_id
        WHERE ($1 = 'all' OR p.status = $1)
        ORDER BY p.applied_at`, [req.query?.status || 'pending']);
    const policy = await livePolicy();
    for (const p of rows) {
      const u = await one(`SELECT partner_photo_asset, student_email FROM app_user WHERE id = $1`, [p.user_id]);
      p.has_photo = !!u.partner_photo_asset;
      p.student_email = u.student_email;
      p.deposit_paise = await depositBalance(p.user_id);
      p.deposit_required_paise = policy?.amount_paise || 0;
      p.consented = !!(policy && await one(
        `SELECT 1 FROM partner_policy_consent WHERE user_id = $1 AND policy_id = $2`, [p.user_id, policy.id]));
      p.rating = await partnerRating(p.user_id);
    }
    return { partners: rows, policy: policy && { id: policy.id, amountPaise: policy.amount_paise } };
  });

  app.post('/admin/partners/:userId/decide', async (req) => {
    const decision = req.body?.decision;
    if (!['approve', 'reject', 'suspend'].includes(decision)) throw BadRequest('Invalid decision');
    /* Approving someone who was suspended is a reinstatement, which is its
       own permission. The prior status is read from the database. */
    const prior = await one(`SELECT status FROM partner_profile WHERE user_id = $1`, [req.params.userId]);
    authorize(req.actor, decision === 'suspend' ? 'partner.suspend'
      : decision === 'approve' && prior?.status === 'suspended' ? 'partner.reinstate' : 'partner.approve');
    assertRecentPasskey(req.actor, 'deciding a delivery partner application');

    const u = await one(`SELECT * FROM app_user WHERE id = $1`, [req.params.userId]);
    if (!u) throw NotFound('No such user');
    if (decision === 'approve' && u.student_status !== 'approved') {
      throw Conflict('This account is not a verified student',
        'Approve their student ID verification first.');
    }
    if (decision === 'approve') {
      /* Identification, consent to the terms in force, and the deposit those
         terms require - each read from the database, none assumed. */
      if (!u.partner_photo_asset) {
        throw Conflict('This applicant has no profile photo', 'Customers must be able to recognise their partner.');
      }
      const policy = await livePolicy();
      const consent = policy && await one(
        `SELECT 1 FROM partner_policy_consent WHERE user_id = $1 AND policy_id = $2`, [u.id, policy.id]);
      if (!consent) {
        throw Conflict('The applicant has not accepted the current partner policy',
          'The policy changed after they applied. They must accept the current version.');
      }
      const held = await depositBalance(u.id);
      if (held < policy.amount_paise) {
        throw Conflict('The security deposit has not been received',
          `Required: ${policy.amount_paise} paise; recorded: ${held} paise. Record the transfer first.`);
      }
    }
    const status = { approve: 'approved', reject: 'rejected', suspend: 'suspended' }[decision];

    await tx(async (c) => {
      await c.query(
        `UPDATE partner_profile SET status=$2, decided_at=now(), decided_by=$3,
                online = CASE WHEN $2 = 'approved' THEN online ELSE false END
          WHERE user_id=$1`, [u.id, status, req.actor.id]);
      if (decision === 'approve') {
        await c.query(
          `INSERT INTO user_role (user_id, role, granted_by) VALUES ($1,'delivery_partner',$2)
           ON CONFLICT (user_id, role, COALESCE(vendor_id,'00000000-0000-0000-0000-000000000000'::uuid))
           DO UPDATE SET status='active', revoked_at=NULL`, [u.id, req.actor.id]);
      } else {
        await c.query(
          `UPDATE user_role SET status='revoked', revoked_at=now()
            WHERE user_id=$1 AND role='delivery_partner'`, [u.id]);
      }
    });
    notifyAsync(u.id, decision === 'approve' ? 'partner_approved' : 'partner_rejected',
                { body: req.body?.note || null });
    await audit(req, { action: 'partner.decide', resource: 'user', resourceId: u.id,
                       outcome: 'ok', detail: { decision, from: prior?.status || null, note: req.body?.note || null } });
    return { userId: u.id, status };
  });

  /* ---------- platform --------------------------------------------------- */
  app.get('/admin/flags', async (req) => {
    authorize(req.actor, 'platform.read');
    return { flags: await allFlags(), providers: providerStatus() };
  });

  /* What still stands between this deployment and real students. */
  app.get('/admin/readiness', async (req) => {
    authorize(req.actor, 'platform.read');
    return readiness();
  });

  app.put('/admin/flags/:key', async (req) => {
    authorize(req.actor, 'flags.update');
    assertRecentPasskey(req.actor, 'changing platform feature flags');
    const out = await setFlag(req.params.key, req.body?.enabled, req.actor.id);
    await audit(req, { action: 'flags.update', resource: 'feature_flag', resourceId: req.params.key,
                       outcome: 'ok', detail: out });
    return out;
  });

  app.put('/admin/config/:key', async (req) => {
    authorize(req.actor, 'config.update');
    assertRecentPasskey(req.actor, 'changing platform configuration');
    /* Commercial terms are NOT configuration keys. They are versioned rows
       in pricing_policy, because an order has to keep the terms it was
       priced under, and a mutable key/value pair cannot offer that. */
    const moved = {
      delivery_fee_paise: 'PUT /admin/pricing (deliveryFeePaise)',
      partner_payout_pct: 'PUT /admin/pricing (deliveryEarningPaise)',
    };
    if (moved[req.params.key]) {
      throw BadRequest(`"${req.params.key}" is no longer a configuration key`,
        `Pricing is versioned so that historical orders keep their terms. Use ` +
        `${moved[req.params.key]} instead.`);
    }
    const allowed = ['support_phone', 'support_email', 'refund_delivery_policy'];
    if (!allowed.includes(req.params.key)) throw BadRequest(`Unknown configuration key`);
    await q(
      `INSERT INTO platform_config (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
      [req.params.key, JSON.stringify(req.body?.value)]);
    await audit(req, { action: 'config.update', resource: 'platform_config',
                       resourceId: req.params.key, outcome: 'ok', detail: { value: req.body?.value } });
    return { key: req.params.key, value: req.body?.value };
  });

  app.get('/admin/audit', async (req) => {
    authorize(req.actor, 'audit.read');
    const { rows } = await q(
      `SELECT a.at, a.action, a.resource, a.resource_id, a.outcome, a.detail,
              a.actor_role, u.name AS actor_name, u.phone AS actor_phone
         FROM audit_log a LEFT JOIN app_user u ON u.id = a.actor_id
        WHERE ($1 = '' OR a.action ILIKE $2)
        ORDER BY a.at DESC LIMIT 200`,
      [String(req.query?.action || ''), `%${req.query?.action || ''}%`]);
    return { entries: rows };
  });
}
