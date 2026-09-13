/* ==========================================================================
   QUAD - DELIVERY TRUST: partner identity, incidents, security deposit,
   review reporting

   The rules this file enforces, stated once:

   1. A report is a claim. Filing one changes nothing about anybody's money
      or status. An administrator investigates and records an outcome.

   2. Deposit money moves only in three ways, each a ledger transaction:
        received  - an administrator records a real bank transfer + reference
        deducted  - an authorised, evidenced, disputable decision tied to a
                    resolved incident that found the partner responsible
        refunded  - an administrator records the bank transfer back
      There is no other write path to the partner_deposit account.

   3. A deduction is never silent and never immediate. The partner is
      notified when it is proposed and may dispute it within the policy's
      window. Money moves only when an administrator applies it, and only
      after the window has passed undisputed or a dispute was upheld by an
      administrator other than the one who proposed it (the platform owner
      excepted, for a one-person operation).

   4. A deposit is not returned while the partner has a delivery in progress,
      an open incident, or a deduction that is not finished.
   ========================================================================== */
import { randomBytes } from 'node:crypto';
import { q, one, tx } from '../db/index.js';
import { authorize, can, BadRequest, NotFound, Forbidden, Conflict } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { audit } from '../audit.js';
import { notifyAsync } from '../services/notify.js';
import { getImage } from '../services/storage.js';
import { setPartnerPhoto } from '../services/partner-photo.js';
import { balance, postDepositReceived, postDepositDeduction, postDepositRefund } from '../services/ledger.js';

const code = (p) => p + randomBytes(3).toString('hex').toUpperCase();
const text = (v, max = 2000) => String(v ?? '').trim().slice(0, max);

export const INCIDENT_CATEGORIES = {
  damaged: 'Order damaged',
  tampered: 'Packaging tampered with',
  missing: 'Order or items missing',
  partner_not_received: 'Partner says they never received the order',
  not_delivered: 'Order was not delivered',
  wrong_order: 'Wrong order',
  spilled: 'Food significantly damaged or spilled',
};
const ALLOWED_BY_ROLE = {
  customer: ['damaged', 'tampered', 'missing', 'not_delivered', 'wrong_order', 'spilled'],
  partner:  ['partner_not_received', 'damaged', 'tampered', 'missing', 'wrong_order', 'spilled'],
  vendor:   ['partner_not_received', 'damaged', 'tampered', 'missing', 'wrong_order'],
  admin:    Object.keys(INCIDENT_CATEGORIES),
};

export async function livePolicy(c = { query: q }) {
  return (await c.query(
    `SELECT * FROM partner_deposit_policy WHERE effective_to IS NULL LIMIT 1`)).rows[0] || null;
}
const shapePolicy = (p) => p && ({
  id: p.id, amountPaise: p.amount_paise, disputeWindowHours: p.dispute_window_hours,
  terms: p.terms, effectiveFrom: p.effective_from,
});

export const depositBalance = (partnerId) => balance(q, 'partner_deposit', { partnerId });

/* Every reason a deposit cannot be returned right now. Empty means eligible. */
export async function refundBlockers(partnerId) {
  const blockers = [];
  const p = await one(`SELECT status FROM partner_profile WHERE user_id = $1`, [partnerId]);
  if (p && ['pending', 'approved', 'suspended'].includes(p.status)) {
    blockers.push(p.status === 'approved'
      ? 'You are still an active delivery partner. Leave the programme first.'
      : p.status === 'pending' ? 'Your partner application is still under review.'
      : 'Your partner account is suspended pending review.');
  }
  const active = await one(
    `SELECT code FROM food_order WHERE partner_id = $1 AND state IN ('assigned','picked_up') LIMIT 1`, [partnerId]);
  if (active) blockers.push(`Order ${active.code} is still in your care.`);
  const inc = await one(
    `SELECT count(*)::int n FROM delivery_incident WHERE partner_id = $1 AND state <> 'resolved'`, [partnerId]);
  if (inc.n) blockers.push(`${inc.n} delivery incident${inc.n === 1 ? ' is' : 's are'} still being investigated.`);
  const ded = await one(
    `SELECT count(*)::int n FROM deposit_deduction WHERE partner_id = $1 AND state IN ('proposed','disputed','upheld')`,
    [partnerId]);
  if (ded.n) blockers.push(`${ded.n} deduction${ded.n === 1 ? ' is' : 's are'} not yet finished.`);
  if ((await depositBalance(partnerId)) <= 0) blockers.push('There is no deposit balance to return.');
  return blockers;
}

async function depositView(partnerId) {
  const policy = await livePolicy();
  const consent = policy && await one(
    `SELECT accepted_at FROM partner_policy_consent WHERE user_id = $1 AND policy_id = $2`, [partnerId, policy.id]);
  const movements = (await q(
    `SELECT id, kind, amount_paise, method, external_reference, note, created_at
       FROM deposit_movement WHERE partner_id = $1 ORDER BY created_at DESC`, [partnerId])).rows;
  const deductions = (await q(
    `SELECT d.id, d.amount_paise, d.reason, d.evidence, d.state, d.proposed_at, d.dispute_deadline,
            d.dispute_text, d.disputed_at, d.review_note, d.reviewed_at, d.applied_at,
            o.code AS order_code, i.code AS incident_code, i.category AS incident_category
       FROM deposit_deduction d JOIN food_order o ON o.id = d.order_id
       JOIN delivery_incident i ON i.id = d.incident_id
      WHERE d.partner_id = $1 ORDER BY d.proposed_at DESC`, [partnerId])).rows;
  const refundRequest = await one(
    `SELECT id, state, requested_at, decided_at, note FROM deposit_refund_request
      WHERE partner_id = $1 ORDER BY requested_at DESC LIMIT 1`, [partnerId]);
  const bal = await depositBalance(partnerId);
  const blockers = await refundBlockers(partnerId);
  return {
    policy: shapePolicy(policy),
    consentedToLivePolicy: !!consent, consentedAt: consent?.accepted_at || null,
    requiredPaise: policy?.amount_paise || 0,
    balancePaise: bal,
    shortfallPaise: Math.max(0, (policy?.amount_paise || 0) - bal),
    movements, deductions, refundRequest,
    refund: { eligible: blockers.length === 0 && refundRequest?.state !== 'requested', blockers },
    collection: {
      online: false,
      note: 'Deposits are paid by bank transfer or UPI to ECHO ECHO and recorded by campus admin with the ' +
            'transfer reference. No card or bank account is ever charged automatically.',
    },
  };
}

/* The delivery rating of a partner, from visible reviews only. */
export async function partnerRating(partnerId) {
  return one(
    `SELECT round(avg(stars)::numeric, 2)::float AS average, count(*)::int AS count
       FROM review WHERE partner_id = $1 AND NOT hidden`, [partnerId]);
}

export default async function trustRoutes(app) {
  /* ======================= partner photo ================================== */
  app.post('/partner/photo', async (req) => {
    authorize(req.actor, 'partner.apply', { ownerId: req.actor.id });
    if (req.actor.studentStatus !== 'approved') {
      throw Forbidden('Verify your student identity first');
    }
    let buf = null;
    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'photo') buf = await part.toBuffer();
      else if (part.type === 'file') part.file.resume();
    }
    const asset = await setPartnerPhoto(req.actor.id, buf);
    await audit(req, { action: 'partner.photo', resource: 'asset', resourceId: asset.id, outcome: 'ok' });
    return {
      ok: true, width: asset.width, height: asset.height,
      note: 'Your photo passed the automatic checks. Campus admin confirms it shows you before approving your application.',
    };
  });

  const streamPhoto = async (reply, assetId) => {
    if (!assetId) throw NotFound('No photo');
    const got = await getImage(assetId);
    if (!got) throw NotFound('No photo');
    reply.header('Cache-Control', 'private, max-age=300');
    if (got.url) return reply.redirect(got.url);
    return reply.type(got.asset.mime).send(got.bytes);
  };

  app.get('/partner/photo/me', async (req, reply) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const u = await one(`SELECT partner_photo_asset FROM app_user WHERE id = $1`, [req.actor.id]);
    return streamPhoto(reply, u?.partner_photo_asset);
  });

  /* Only the customer of this order (once a partner is on it), the partner,
     and platform staff. The photo is not a public asset. */
  app.get('/orders/:id/partner-photo', async (req, reply) => {
    const o = await one(`SELECT customer_id, partner_id, state FROM food_order WHERE id = $1`, [req.params.id]);
    if (!o || !o.partner_id) throw NotFound('No partner on this order');
    const customer = o.customer_id === req.actor?.id &&
      ['assigned', 'picked_up', 'delivered'].includes(o.state);
    if (!customer && o.partner_id !== req.actor?.id && !can(req.actor, 'order.read_all')) {
      throw Forbidden('That photo is not available to you');
    }
    const u = await one(`SELECT partner_photo_asset FROM app_user WHERE id = $1`, [o.partner_id]);
    return streamPhoto(reply, u?.partner_photo_asset);
  });

  app.get('/admin/partners/:userId/photo', async (req, reply) => {
    authorize(req.actor, 'partner.read');
    const u = await one(`SELECT partner_photo_asset FROM app_user WHERE id = $1`, [req.params.userId]);
    await audit(req, { action: 'partner.photo.view', resource: 'user', resourceId: req.params.userId, outcome: 'ok' });
    return streamPhoto(reply, u?.partner_photo_asset);
  });

  /* ======================= deposit policy ================================= */
  app.get('/partner/policy', async () => ({
    policy: shapePolicy(await livePolicy()),
    incidentCategories: INCIDENT_CATEGORIES,
  }));

  app.put('/admin/partner-deposit-policy', async (req) => {
    authorize(req.actor, 'deposit.policy');
    assertRecentPasskey(req.actor, 'changing commercial terms');
    const b = req.body || {};
    const amount = Number(b.amountPaise);
    const window = Number(b.disputeWindowHours);
    const terms = text(b.terms, 8000);
    if (!Number.isInteger(amount) || amount < 0 || amount > 10_000_00) {
      throw BadRequest('Deposit must be a whole number of paise between 0 and Rs 10,000');
    }
    if (!Number.isInteger(window) || window < 24 || window > 720) {
      throw BadRequest('The dispute window must be between 24 and 720 hours');
    }
    if (terms.length < 50) throw BadRequest('Write out the terms partners will agree to (at least 50 characters)');
    const row = await tx(async (c) => {
      await c.query(`UPDATE partner_deposit_policy SET effective_to = now() WHERE effective_to IS NULL`);
      return (await c.query(
        `INSERT INTO partner_deposit_policy (amount_paise, dispute_window_hours, terms, created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`, [amount, window, terms, req.actor.id])).rows[0];
    });
    await audit(req, { action: 'deposit.policy.publish', resource: 'partner_deposit_policy', resourceId: row.id,
                       outcome: 'ok', detail: { amountPaise: amount, disputeWindowHours: window } });
    return shapePolicy(row);
  });

  /* ======================= deposit: partner side ========================== */
  app.get('/partner/deposit', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    return depositView(req.actor.id);
  });

  app.post('/partner/deductions/:id/dispute', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const d = await one(`SELECT * FROM deposit_deduction WHERE id = $1`, [req.params.id]);
    if (!d || d.partner_id !== req.actor.id) throw NotFound('No such deduction');
    if (d.state !== 'proposed') throw Conflict(`This deduction is already ${d.state}`);
    if (new Date(d.dispute_deadline) < new Date()) throw Conflict('The dispute window for this deduction has closed');
    const why = text(req.body?.text, 4000);
    if (why.length < 20) throw BadRequest('Explain what happened (at least 20 characters)');
    const row = await one(
      `UPDATE deposit_deduction SET state = 'disputed', dispute_text = $2, disputed_at = now()
        WHERE id = $1 AND state = 'proposed' RETURNING id, state`, [d.id, why]);
    if (!row) throw Conflict('This deduction changed; reload and try again');
    await audit(req, { action: 'deposit.deduction.dispute', resource: 'deposit_deduction', resourceId: d.id, outcome: 'ok' });
    return { ...row, message: 'Dispute recorded. No money moves until an administrator decides.' };
  });

  app.post('/partner/deposit/refund-request', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const blockers = await refundBlockers(req.actor.id);
    if (blockers.length) throw Conflict('Your deposit cannot be returned yet', blockers.join(' '));
    const row = await one(
      `INSERT INTO deposit_refund_request (partner_id) VALUES ($1)
       ON CONFLICT (partner_id) WHERE state = 'requested' DO NOTHING RETURNING *`, [req.actor.id]);
    if (!row) throw Conflict('You already have a refund request open');
    await audit(req, { action: 'deposit.refund.request', resource: 'deposit_refund_request', resourceId: row.id, outcome: 'ok' });
    return { ...row, message: 'Request received. Campus admin transfers the balance and records the bank reference.' };
  });

  /* ======================= deposit: admin side ============================ */
  app.get('/admin/partners/:userId/deposit', async (req) => {
    authorize(req.actor, 'deposit.read');
    return depositView(req.params.userId);
  });

  app.post('/admin/partners/:userId/deposit/receipts', async (req) => {
    authorize(req.actor, 'deposit.record');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const b = req.body || {};
    const amount = Number(b.amountPaise);
    const ref = text(b.externalReference, 80);
    if (!Number.isInteger(amount) || amount <= 0) throw BadRequest('Enter the amount received, in paise');
    if (!['manual_bank_transfer', 'manual_upi'].includes(b.method)) throw BadRequest('Method must be manual_bank_transfer or manual_upi');
    if (ref.length < 6) throw BadRequest('Enter the bank or UPI transaction reference', 'Nothing is recorded as received without one.');
    const partner = await one(`SELECT user_id FROM partner_profile WHERE user_id = $1`, [req.params.userId]);
    if (!partner) throw NotFound('This person has not applied to be a delivery partner');

    const movement = await tx(async (c) => {
      const m = (await c.query(
        `INSERT INTO deposit_movement (partner_id, kind, amount_paise, method, external_reference, note, recorded_by)
         VALUES ($1,'received',$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.userId, amount, b.method, ref, text(b.note, 500) || null, req.actor.id])).rows[0];
      await postDepositReceived(c, { movement: m, actorId: req.actor.id });
      return m;
    });
    await audit(req, { action: 'deposit.receipt', resource: 'user', resourceId: req.params.userId, outcome: 'ok',
                       detail: { amountPaise: amount, method: b.method, reference: ref } });
    return { movement, deposit: await depositView(req.params.userId) };
  });

  app.get('/admin/deposit-refunds', async (req) => {
    authorize(req.actor, 'deposit.read');
    const { rows } = await q(
      `SELECT r.*, u.name AS partner_name FROM deposit_refund_request r JOIN app_user u ON u.id = r.partner_id
        WHERE ($1 = 'all' OR r.state = $1) ORDER BY r.requested_at DESC LIMIT 100`,
      [req.query?.state || 'requested']);
    for (const r of rows) r.balance_paise = await depositBalance(r.partner_id);
    return { requests: rows };
  });

  app.post('/admin/deposit-refunds/:id/pay', async (req) => {
    authorize(req.actor, 'deposit.refund');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const b = req.body || {};
    const ref = text(b.externalReference, 80);
    if (!['manual_bank_transfer', 'manual_upi'].includes(b.method)) throw BadRequest('Method must be manual_bank_transfer or manual_upi');
    if (ref.length < 6) throw BadRequest('Enter the reference of the transfer you made');
    const r = await one(`SELECT * FROM deposit_refund_request WHERE id = $1`, [req.params.id]);
    if (!r) throw NotFound('No such refund request');
    if (r.state !== 'requested') throw Conflict(`This request is already ${r.state}`);
    /* Re-checked at the moment of payment: an incident filed after the
       request blocks the refund just the same. */
    const blockers = await refundBlockers(r.partner_id);
    if (blockers.length) throw Conflict('This deposit cannot be returned yet', blockers.join(' '));

    const out = await tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('deposit:' || $1))`, [r.partner_id]);
      const bal = await balance((s, p) => c.query(s, p), 'partner_deposit', { partnerId: r.partner_id });
      if (bal <= 0) throw Conflict('There is no deposit balance to return');
      const m = (await c.query(
        `INSERT INTO deposit_movement (partner_id, kind, amount_paise, method, external_reference, note, recorded_by)
         VALUES ($1,'refunded',$2,$3,$4,$5,$6) RETURNING *`,
        [r.partner_id, bal, b.method, ref, text(b.note, 500) || null, req.actor.id])).rows[0];
      await postDepositRefund(c, { movement: m, actorId: req.actor.id });
      await c.query(
        `UPDATE deposit_refund_request SET state = 'paid', movement_id = $2, decided_by = $3, decided_at = now()
          WHERE id = $1`, [r.id, m.id, req.actor.id]);
      return m;
    });
    await audit(req, { action: 'deposit.refund.pay', resource: 'deposit_refund_request', resourceId: r.id, outcome: 'ok',
                       detail: { amountPaise: out.amount_paise, reference: ref } });
    notifyAsync(r.partner_id, 'deposit_refunded', { body: `Your security deposit was returned. Reference ${ref}.` });
    return { movement: out };
  });

  app.post('/admin/deposit-refunds/:id/reject', async (req) => {
    authorize(req.actor, 'deposit.refund');
    assertRecentPasskey(req.actor, 'moving or recording money');
    const note = text(req.body?.note, 1000);
    if (note.length < 10) throw BadRequest('Say why (at least 10 characters). The partner sees this.');
    const row = await one(
      `UPDATE deposit_refund_request SET state = 'rejected', decided_by = $2, decided_at = now(), note = $3
        WHERE id = $1 AND state = 'requested' RETURNING *`, [req.params.id, req.actor.id, note]);
    if (!row) throw Conflict('No open request with that id');
    await audit(req, { action: 'deposit.refund.reject', resource: 'deposit_refund_request', resourceId: row.id, outcome: 'ok' });
    return row;
  });

  /* ======================= incidents ====================================== */
  app.post('/orders/:id/incidents', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const o = await one(`SELECT * FROM food_order WHERE id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');
    const role = o.customer_id === req.actor.id ? 'customer'
      : o.partner_id && o.partner_id === req.actor.id ? 'partner'
      : req.actor.vendorIds.includes(o.vendor_id) ? 'vendor'
      : can(req.actor, 'incident.manage') ? 'admin' : null;
    if (!role) throw Forbidden('That order is not yours');
    if (o.fulfilment !== 'delivery' || !o.partner_id) {
      throw Conflict('Delivery incidents apply to delivery orders with a partner',
        'For a collection order, use Report an issue.');
    }
    if (!['assigned', 'picked_up', 'delivered', 'refunded'].includes(o.state)) {
      throw Conflict(`This order is ${o.state}`, 'An incident can be reported once a partner has the order.');
    }
    const category = req.body?.category;
    if (!ALLOWED_BY_ROLE[role].includes(category)) {
      throw BadRequest('Choose what happened from the list');
    }
    const description = text(req.body?.description, 2000);
    if (description.length < 10) throw BadRequest('Describe what happened (at least 10 characters)');

    const row = await one(
      `INSERT INTO delivery_incident (code, order_id, partner_id, reported_by, reporter_role, category, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (order_id, reported_by) WHERE state <> 'resolved' DO NOTHING RETURNING *`,
      [code('I'), o.id, o.partner_id, req.actor.id, role, category, description]);
    if (!row) throw Conflict('You already have an open report on this order', 'Campus admin is looking into it.');
    await audit(req, { action: 'incident.report', resource: 'delivery_incident', resourceId: row.id, outcome: 'ok',
                       detail: { order: o.code, category, role } });
    return {
      id: row.id, code: row.code, state: row.state,
      message: 'Reported to campus admin. Nobody is penalised on a report alone: it is investigated first.',
    };
  });

  app.get('/orders/:id/incidents', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const o = await one(`SELECT customer_id, partner_id, vendor_id FROM food_order WHERE id = $1`, [req.params.id]);
    if (!o) throw NotFound('No such order');
    const platform = can(req.actor, 'incident.read');
    if (!platform && ![o.customer_id, o.partner_id].includes(req.actor.id) && !req.actor.vendorIds.includes(o.vendor_id)) {
      throw Forbidden('That order is not yours');
    }
    const { rows } = await q(
      `SELECT id, code, category, description, state, outcome, resolution_note, reporter_role, created_at, resolved_at
         FROM delivery_incident WHERE order_id = $1 AND ($2::boolean OR reported_by = $3)
        ORDER BY created_at DESC`, [req.params.id, platform, req.actor.id]);
    return { incidents: rows };
  });

  app.get('/admin/incidents', async (req) => {
    authorize(req.actor, 'incident.read');
    const { rows } = await q(
      `SELECT i.*, o.code AS order_code, o.state AS order_state, o.total_paise,
              r.name AS reporter_name, p.name AS partner_name, v.name AS vendor_name,
              (SELECT json_agg(json_build_object('id', d.id, 'state', d.state, 'amount_paise', d.amount_paise))
                 FROM deposit_deduction d WHERE d.incident_id = i.id) AS deductions
         FROM delivery_incident i
         JOIN food_order o ON o.id = i.order_id JOIN vendor v ON v.id = o.vendor_id
         JOIN app_user r ON r.id = i.reported_by LEFT JOIN app_user p ON p.id = i.partner_id
        WHERE ($1 = 'all' OR i.state = $1 OR ($1 = 'unresolved' AND i.state <> 'resolved'))
        ORDER BY i.created_at DESC LIMIT 200`, [req.query?.state || 'unresolved']);
    return { incidents: rows, categories: INCIDENT_CATEGORIES };
  });

  app.post('/admin/incidents/:id/investigate', async (req) => {
    authorize(req.actor, 'incident.manage');
    const row = await one(
      `UPDATE delivery_incident SET state = 'investigating' WHERE id = $1 AND state = 'open' RETURNING *`, [req.params.id]);
    if (!row) throw Conflict('Only an open incident can move to investigating');
    await audit(req, { action: 'incident.investigate', resource: 'delivery_incident', resourceId: row.id, outcome: 'ok' });
    return row;
  });

  app.post('/admin/incidents/:id/resolve', async (req) => {
    authorize(req.actor, 'incident.resolve');
    const outcome = req.body?.outcome;
    const note = text(req.body?.note, 4000);
    if (!['no_fault_found', 'partner_responsible', 'cafeteria_responsible',
          'customer_claim_not_supported', 'other'].includes(outcome)) {
      throw BadRequest('Choose an outcome');
    }
    if (note.length < 10) throw BadRequest('Record what the investigation found (at least 10 characters)');
    const row = await one(
      `UPDATE delivery_incident SET state = 'resolved', outcome = $2, resolution_note = $3,
              resolved_by = $4, resolved_at = now()
        WHERE id = $1 AND state <> 'resolved' RETURNING *`, [req.params.id, outcome, note, req.actor.id]);
    if (!row) throw Conflict('This incident is already resolved');
    await audit(req, { action: 'incident.resolve', resource: 'delivery_incident', resourceId: row.id, outcome: 'ok',
                       detail: { outcome } });
    return row;
  });

  /* ======================= deductions ===================================== */
  app.get('/admin/deductions', async (req) => {
    authorize(req.actor, 'deposit.read');
    const { rows } = await q(
      `SELECT d.*, u.name AS partner_name, o.code AS order_code, i.code AS incident_code,
              pb.name AS proposed_by_name, rb.name AS reviewed_by_name
         FROM deposit_deduction d JOIN app_user u ON u.id = d.partner_id
         JOIN food_order o ON o.id = d.order_id JOIN delivery_incident i ON i.id = d.incident_id
         JOIN app_user pb ON pb.id = d.proposed_by LEFT JOIN app_user rb ON rb.id = d.reviewed_by
        WHERE ($1 = 'all' OR d.state = $1 OR ($1 = 'open' AND d.state IN ('proposed','disputed','upheld')))
        ORDER BY d.proposed_at DESC LIMIT 200`, [req.query?.state || 'open']);
    return { deductions: rows.map((d) => ({ ...d, applicable: canApply(d) })) };
  });

  app.post('/admin/deductions', async (req) => {
    authorize(req.actor, 'deposit.deduction.propose');
    assertRecentPasskey(req.actor, 'a financial adjustment or deposit deduction');
    const b = req.body || {};
    const amount = Number(b.amountPaise);
    const reason = text(b.reason, 500);
    const evidence = text(b.evidence, 8000);
    if (!Number.isInteger(amount) || amount <= 0) throw BadRequest('Enter the deduction amount in paise');
    if (reason.length < 10) throw BadRequest('Give a reason (at least 10 characters)');
    if (evidence.length < 20) throw BadRequest('Describe the evidence (at least 20 characters)',
      'What was checked: counter confirmation, handover codes, photos provided, statements.');
    const inc = await one(`SELECT * FROM delivery_incident WHERE id = $1`, [b.incidentId]);
    if (!inc) throw NotFound('No such incident');
    if (inc.state !== 'resolved' || inc.outcome !== 'partner_responsible') {
      throw Conflict('A deduction needs an incident resolved as the partner\'s responsibility',
        'Investigate and resolve the incident first. A complaint on its own is not grounds for a deduction.');
    }
    if (!inc.partner_id) throw Conflict('This incident names no delivery partner');

    const policy = await livePolicy();
    const row = await tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('deposit:' || $1))`, [inc.partner_id]);
      const bal = await balance((s, p) => c.query(s, p), 'partner_deposit', { partnerId: inc.partner_id });
      const pending = (await c.query(
        `SELECT coalesce(sum(amount_paise),0)::int n FROM deposit_deduction
          WHERE partner_id = $1 AND state IN ('proposed','disputed','upheld')`, [inc.partner_id])).rows[0].n;
      if (amount > bal - pending) {
        throw Conflict('That is more than the partner\'s available deposit',
          `Held: ${bal} paise; already proposed: ${pending} paise.`);
      }
      return (await c.query(
        `INSERT INTO deposit_deduction (partner_id, incident_id, order_id, amount_paise, reason, evidence,
                                        proposed_by, dispute_deadline)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' hours')::interval) RETURNING *`,
        [inc.partner_id, inc.id, inc.order_id, amount, reason, evidence, req.actor.id,
         String(policy?.dispute_window_hours || 72)])).rows[0];
    });
    notifyAsync(row.partner_id, 'deposit_deduction_proposed', {
      body: `A deduction of Rs ${(amount / 100).toFixed(2)} from your security deposit has been proposed: ${reason}. ` +
            `You can dispute it in the ECHO ECHO app until ${new Date(row.dispute_deadline).toUTCString()}.`,
      data: { deductionId: row.id } });
    await audit(req, { action: 'deposit.deduction.propose', resource: 'deposit_deduction', resourceId: row.id,
                       outcome: 'ok', detail: { amountPaise: amount, incident: inc.code, partner: inc.partner_id } });
    return row;
  });

  app.post('/admin/deductions/:id/review', async (req) => {
    authorize(req.actor, 'deposit.deduction.approve');
    assertRecentPasskey(req.actor, 'a financial adjustment or deposit deduction');
    const decision = req.body?.decision;
    const note = text(req.body?.note, 4000);
    if (!['uphold', 'dismiss'].includes(decision)) throw BadRequest('Decision must be uphold or dismiss');
    if (note.length < 10) throw BadRequest('Record the reasoning (at least 10 characters)');
    const d = await one(`SELECT * FROM deposit_deduction WHERE id = $1`, [req.params.id]);
    if (!d) throw NotFound('No such deduction');
    if (decision === 'uphold' && d.state !== 'disputed') {
      throw Conflict('Only a disputed deduction is upheld', 'An undisputed one is applied after its window closes.');
    }
    if (decision === 'dismiss' && !['proposed', 'disputed'].includes(d.state)) {
      throw Conflict(`This deduction is already ${d.state}`);
    }
    if (d.proposed_by === req.actor.id) {
      /* The proposer does not judge the dispute. The platform owner may do so
         only when there is genuinely nobody else: no other active
         administrator holding a registered passkey. */
      const other = await one(
        `SELECT 1 FROM user_role r
          WHERE r.status = 'active' AND r.role IN ('platform_owner','platform_admin') AND r.user_id <> $1
            AND EXISTS (SELECT 1 FROM webauthn_credential w WHERE w.user_id = r.user_id AND w.revoked_at IS NULL)
          LIMIT 1`, [req.actor.id]);
      if (!req.actor.roles.includes('platform_owner') || other) {
        throw Forbidden('A different administrator must decide this dispute',
          'The person who proposed a deduction does not also judge the dispute against it.');
      }
    }
    const row = await one(
      `UPDATE deposit_deduction SET state = $2, review_note = $3, reviewed_by = $4, reviewed_at = now()
        WHERE id = $1 AND state = $5 RETURNING *`,
      [d.id, decision === 'uphold' ? 'upheld' : 'dismissed', note, req.actor.id, d.state]);
    if (!row) throw Conflict('This deduction changed; reload and try again');
    notifyAsync(d.partner_id, 'deposit_deduction_decided', {
      body: decision === 'uphold'
        ? `Your dispute was reviewed and the deduction was upheld: ${note}`
        : `The proposed deduction was dismissed. Nothing will be taken from your deposit.` });
    await audit(req, { action: `deposit.deduction.${decision}`, resource: 'deposit_deduction', resourceId: d.id, outcome: 'ok' });
    return row;
  });

  app.post('/admin/deductions/:id/withdraw', async (req) => {
    authorize(req.actor, 'deposit.deduction.propose');
    assertRecentPasskey(req.actor, 'a financial adjustment or deposit deduction');
    const note = text(req.body?.note, 1000);
    if (note.length < 10) throw BadRequest('Say why the deduction is withdrawn');
    const row = await one(
      `UPDATE deposit_deduction SET state = 'withdrawn', review_note = $2
        WHERE id = $1 AND state IN ('proposed','disputed','upheld') RETURNING *`, [req.params.id, note]);
    if (!row) throw Conflict('Only an unapplied deduction can be withdrawn');
    notifyAsync(row.partner_id, 'deposit_deduction_decided', { body: 'A proposed deduction from your deposit was withdrawn.' });
    await audit(req, { action: 'deposit.deduction.withdraw', resource: 'deposit_deduction', resourceId: row.id, outcome: 'ok' });
    return row;
  });

  app.post('/admin/deductions/:id/apply', async (req) => {
    authorize(req.actor, 'deposit.deduction.approve');
    assertRecentPasskey(req.actor, 'a financial adjustment or deposit deduction');
    const applied = await tx(async (c) => {
      const d = (await c.query(`SELECT * FROM deposit_deduction WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!d) throw NotFound('No such deduction');
      if (!canApply(d)) {
        throw Conflict(d.state === 'proposed'
          ? 'The partner can still dispute this deduction'
          : `A ${d.state} deduction cannot be applied`,
          d.state === 'proposed' ? `The dispute window closes ${new Date(d.dispute_deadline).toISOString()}.` : undefined);
      }
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('deposit:' || $1))`, [d.partner_id]);
      const bal = await balance((s, p) => c.query(s, p), 'partner_deposit', { partnerId: d.partner_id });
      if (d.amount_paise > bal) throw Conflict('The deposit no longer covers this deduction', `Held: ${bal} paise.`);
      const posted = await postDepositDeduction(c, { deduction: d, actorId: req.actor.id });
      if (posted.duplicate) throw Conflict('This deduction was already posted');
      return (await c.query(
        `UPDATE deposit_deduction SET state = 'applied', applied_by = $2, applied_at = now()
          WHERE id = $1 RETURNING *`, [d.id, req.actor.id])).rows[0];
    });
    notifyAsync(applied.partner_id, 'deposit_deduction_decided', {
      body: `Rs ${(applied.amount_paise / 100).toFixed(2)} was deducted from your security deposit: ${applied.reason}` });
    await audit(req, { action: 'deposit.deduction.apply', resource: 'deposit_deduction', resourceId: applied.id,
                       outcome: 'ok', detail: { amountPaise: applied.amount_paise } });
    return applied;
  });

  /* ======================= reviews: reporting & ratings =================== */
  app.post('/reviews/:id/report', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const reason = text(req.body?.reason, 1000);
    if (reason.length < 5) throw BadRequest('Say what is wrong with this review');
    const r = await one(`SELECT id, user_id, hidden FROM review WHERE id = $1`, [req.params.id]);
    if (!r || r.hidden) throw NotFound('No such review');
    if (r.user_id === req.actor.id) throw BadRequest('You cannot report your own review');
    const row = await one(
      `INSERT INTO review_report (review_id, reported_by, reason) VALUES ($1,$2,$3)
       ON CONFLICT (review_id, reported_by) DO NOTHING RETURNING id, state`, [r.id, req.actor.id, reason]);
    if (!row) throw Conflict('You have already reported this review');
    await audit(req, { action: 'review.report', resource: 'review', resourceId: r.id, outcome: 'ok' });
    return { ...row, message: 'Thanks. Campus admin will look at it.' };
  });

  app.get('/admin/reviews', async (req) => {
    authorize(req.actor, 'review.read');
    const reported = req.query?.filter !== 'all';
    const { rows } = await q(
      `SELECT r.id, r.stars, r.body, r.created_at, r.hidden, r.hidden_reason,
              CASE WHEN r.partner_id IS NOT NULL THEN 'delivery' WHEN r.vendor_id IS NOT NULL THEN 'cafeteria' ELSE 'item' END AS target,
              o.code AS order_code, v.name AS vendor_name, p.name AS partner_name, u.name AS author_name,
              (SELECT json_agg(json_build_object('id', rr.id, 'reason', rr.reason, 'state', rr.state, 'at', rr.created_at))
                 FROM review_report rr WHERE rr.review_id = r.id) AS reports
         FROM review r JOIN food_order o ON o.id = r.order_id JOIN vendor v ON v.id = o.vendor_id
         JOIN app_user u ON u.id = r.user_id LEFT JOIN app_user p ON p.id = r.partner_id
        WHERE (NOT $1::boolean OR EXISTS (SELECT 1 FROM review_report rr WHERE rr.review_id = r.id AND rr.state = 'open'))
        ORDER BY r.created_at DESC LIMIT 200`, [reported]);
    return { reviews: rows };
  });

  app.post('/admin/review-reports/:id/resolve', async (req) => {
    authorize(req.actor, 'review.report.resolve');
    const note = text(req.body?.resolution, 1000);
    if (note.length < 5) throw BadRequest('Record the outcome');
    const row = await one(
      `UPDATE review_report SET state = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now()
        WHERE id = $1 AND state = 'open' RETURNING *`, [req.params.id, note, req.actor.id]);
    if (!row) throw Conflict('No open report with that id');
    await audit(req, { action: 'review.report.resolve', resource: 'review_report', resourceId: row.id, outcome: 'ok' });
    return row;
  });

  /* The partner's own delivery rating: the number and the words, never who
     wrote them. */
  app.get('/partner/rating', async (req) => {
    authorize(req.actor, 'delivery.read', { ownerId: req.actor.id });
    const recent = (await q(
      `SELECT stars, body, created_at FROM review WHERE partner_id = $1 AND NOT hidden
        ORDER BY created_at DESC LIMIT 20`, [req.actor.id])).rows;
    return { rating: await partnerRating(req.actor.id), recent };
  });
}

function canApply(d) {
  return d.state === 'upheld' || (d.state === 'proposed' && new Date(d.dispute_deadline) < new Date());
}
