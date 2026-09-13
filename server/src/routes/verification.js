/* ==========================================================================
   Student verification: submit, track, and the admin review queue.

   Three ways a student can establish status, strongest first:
     1. institutional email  — proves control of a university-issued mailbox
                               (POST /auth/email/verify, or /verification/email/*
                               for an account that signed in another way)
     2. college ID card      — OPTIONAL; photographed, reviewed by a person
     3. manual request       — for a student with neither card nor mailbox
                               access; carries no document at all, and an
                               administrator may approve it only with a written
                               record of the evidence they checked

   Nothing a student submits approves them except (1), and (1) only because
   the server itself verified a code it sent to the university's mail domain.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { authorize, BadRequest, NotFound, Forbidden, Conflict, verificationView } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { putImage, getImage } from '../services/storage.js';
import * as vp from '../services/verification.js';
import { flag } from '../services/flags.js';
import { audit } from '../audit.js';
import { notifyAsync } from '../services/notify.js';
import {
  normaliseStudentEmail, sendStudentEmailCode, verifyStudentEmailCode, recordMailboxProof,
} from '../services/student-email.js';

/* Submissions a student may not make from their current state. */
function assertMaySubmit(actor) {
  if (actor.studentStatus === 'approved') throw Conflict('You are already a verified student');
  if (actor.studentStatus === 'suspended') {
    throw Forbidden('Your student verification is suspended', 'Contact campus support.');
  }
}

export default async function verificationRoutes(app) {
  /* ---------- institutional email, for an already signed-in account ------
     e.g. a student who first signed in by phone. The challenge is bound to
     this account id, so a code cannot be redeemed into a different one. */
  app.post('/verification/email/send', async (req) => {
    authorize(req.actor, 'verification.submit', { ownerId: req.actor.id });
    if (!(await flag('student_verification'))) throw Conflict('Verification is temporarily closed');
    if (req.actor.studentStatus === 'suspended') {
      throw Forbidden('Your student verification is suspended', 'Contact campus support.');
    }
    const email = normaliseStudentEmail(req.body?.email);
    const out = await sendStudentEmailCode(email, { purpose: 'link', userId: req.actor.id, ip: req.ip });
    await audit(req, { action: 'verification.email.send', resource: 'student_email', resourceId: email, outcome: 'ok' });
    return { sent: true, email, expiresAt: out.expiresAt, resendAfterSeconds: out.resendAfterSeconds, length: out.length };
  });

  app.post('/verification/email/verify', async (req) => {
    authorize(req.actor, 'verification.submit', { ownerId: req.actor.id });
    const email = normaliseStudentEmail(req.body?.email);
    try {
      await verifyStudentEmailCode(email, req.body?.code, { purpose: 'link', userId: req.actor.id });
    } catch (e) {
      await audit(req, { action: 'verification.email.verify', resource: 'student_email', resourceId: email,
                         outcome: 'denied', detail: { message: e.message } });
      throw e;
    }
    const proof = await tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('student-email:' || $1))`, [email]);
      return recordMailboxProof(c, req.actor.id, email);
    });
    await audit(req, { action: 'verification.email', resource: 'user', resourceId: req.actor.id, outcome: 'ok',
                       detail: { from: proof.before, to: proof.after, email } });
    return { email, verification: verificationView(proof.after, req.actor.status) };
  });

  /* ---------- manual request: no ID card, no mailbox access ---------------
     No document is accepted here on purpose — a screenshot or an uploaded
     file would be exactly the unverifiable evidence this path must not rely
     on. It only opens a case; an administrator establishes status through a
     channel they trust and records what they checked. */
  app.post('/verification/manual', async (req) => {
    authorize(req.actor, 'verification.submit', { ownerId: req.actor.id });
    if (!(await flag('student_verification'))) throw Conflict('Verification is temporarily closed');
    assertMaySubmit(req.actor);
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const roll = String(req.body?.roll || '').trim().slice(0, 40);
    const note = String(req.body?.note || '').trim().slice(0, 1000);
    if (name.length < 2) throw BadRequest('Enter your full name as the university records it');
    if (roll.length < 3) throw BadRequest('Enter your SAP ID or enrolment number');
    if (note.length < 10) throw BadRequest('Tell the verification team why you cannot use your student email');

    const open = await one(
      `SELECT id FROM verification_case WHERE user_id = $1 AND state IN ('pending','needs_review')`, [req.actor.id]);
    if (open) throw Conflict('You already have a verification under review');

    const kase = await tx(async (c) => {
      const k = (await c.query(
        `INSERT INTO verification_case (user_id, method, claimed_name, claimed_roll, request_note, state)
         VALUES ($1,'manual',$2,$3,$4,'pending') RETURNING *`,
        [req.actor.id, name, roll, note])).rows[0];
      await c.query(
        `UPDATE app_user SET student_status = 'pending', name = coalesce(name, $2),
                roll_number = coalesce(roll_number, $3) WHERE id = $1`, [req.actor.id, name, roll]);
      return k;
    });
    await audit(req, { action: 'verification.manual.request', resource: 'verification_case',
                       resourceId: kase.id, outcome: 'ok' });
    return {
      id: kase.id, state: kase.state, slaDueAt: kase.sla_due_at,
      verification: verificationView('pending', req.actor.status),
      message: 'Request received. The verification team will confirm your student status through an ' +
               'official channel before approving it. Nothing you upload is needed or accepted here.',
    };
  });

  /* Multipart: front (required), back (optional), plus claimed fields.
     Camera capture on mobile is a client concern — <input capture> posts to
     exactly this endpoint. The ID card is OPTIONAL evidence: institutional
     email verification does not require it. */
  app.post('/verification/submit', async (req) => {
    authorize(req.actor, 'verification.submit', { ownerId: req.actor.id });
    if (!(await flag('student_verification'))) throw Conflict('Verification is temporarily closed');
    assertMaySubmit(req.actor);

    const open = await one(
      `SELECT id, state FROM verification_case
        WHERE user_id = $1 AND state IN ('pending','needs_review')`, [req.actor.id]);
    if (open) throw Conflict('You already have a submission under review');

    const claimed = { name: null, roll: null, college: null };
    const files = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (!['front', 'back'].includes(part.fieldname)) { part.file.resume(); continue; }
        files[part.fieldname] = await part.toBuffer();
      } else if (part.fieldname in claimed) {
        claimed[part.fieldname] = String(part.value).slice(0, 120);
      }
    }
    if (!files.front) throw BadRequest('A photo of the front of your ID card is required');

    const front = await putImage(files.front, { ownerId: req.actor.id, kind: 'id_front' });
    const back = files.back ? await putImage(files.back, { ownerId: req.actor.id, kind: 'id_back' }) : null;

    /* ---- pipeline ---- */
    const quality = vp.assessQuality(front);
    const ocr = await vp.runOcr(files.front);
    const fields = ocr.status === 'ok' ? vp.extractFields(ocr.text) : {};
    const signals = await vp.computeSignals({
      userId: req.actor.id, fields, claimed, quality, assets: [front, back].filter(Boolean) });
    const roster = await vp.rosterCheck(fields, claimed);
    const { state, reason } = vp.triage(signals, roster);

    const kase = await tx(async (c) => {
      const k = (await c.query(
        `INSERT INTO verification_case
           (user_id, front_asset, back_asset, claimed_name, claimed_roll, claimed_college,
            state, quality, ocr, ocr_provider, signals, roster_match)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [req.actor.id, front.id, back?.id || null, claimed.name, claimed.roll, claimed.college,
         state, JSON.stringify(quality), JSON.stringify({ ...ocr, fields }), ocr.provider || null,
         JSON.stringify(signals), JSON.stringify(roster)])).rows[0];
      await c.query(
        `UPDATE app_user SET student_status = 'pending', roll_number = coalesce($2, roll_number)
          WHERE id = $1`, [req.actor.id, claimed.roll]);
      return k;
    });

    await audit(req, { action: 'verification.submit', resource: 'verification_case',
                       resourceId: kase.id, outcome: 'ok',
                       detail: { state, ocr: ocr.status, roster: roster.status } });

    return {
      id: kase.id,
      state: kase.state,
      slaDueAt: kase.sla_due_at,
      message: reason,
      /* Truthful about what actually ran. */
      pipeline: {
        quality: quality.ok ? 'passed' : 'flagged',
        ocr: ocr.status,
        rosterCheck: roster.status,
        automaticApproval: 'not_available',
        note: 'No submission is approved automatically. An administrator reviews every case.',
      },
    };
  });

  app.get('/verification/me', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const k = await one(
      `SELECT id, state, method, submitted_at, sla_due_at, decision_note, decided_at
         FROM verification_case WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
      [req.actor.id]);
    const u = await one(`SELECT student_email, student_email_verified_at FROM app_user WHERE id = $1`, [req.actor.id]);
    const view = verificationView(req.actor.studentStatus, req.actor.status);
    const base = {
      verification: view,
      studentEmail: u?.student_email || null,
      studentEmailVerifiedAt: u?.student_email_verified_at || null,
      /* Which paths are open to this student right now. */
      options: {
        institutionalEmail: !u?.student_email && !['approved', 'suspended', 'rejected'].includes(req.actor.studentStatus),
        idCard: !['approved', 'suspended', 'pending', 'needs_review'].includes(req.actor.studentStatus),
        manualRequest: !['approved', 'suspended', 'pending', 'needs_review'].includes(req.actor.studentStatus),
      },
    };
    if (!k) return { ...base, state: 'unverified', message: view.nextStep };
    const copy = {
      pending: k.method === 'id_card' ? 'Your ID is under review.' : 'Your verification is under review.',
      needs_review: 'An administrator needs to take a closer look at your submission.',
      approved: 'Your student identity has been verified.',
      rejected: 'Verification could not be completed.',
      resubmit_requested: 'The verification team needs more information from you.',
    };
    return { ...base, ...k, message: copy[k.state] };
  });

  /* ---------- admin review queue ----------------------------------------- */
  app.get('/admin/verification', async (req) => {
    authorize(req.actor, 'verification.read');
    const state = req.query?.state || 'pending';
    const { rows } = await q(
      `SELECT k.*, u.name AS user_name, u.phone, u.student_email AS verified_student_email,
              u.student_email_verified_at, u.student_status,
              (SELECT count(*)::int FROM verification_case p
                WHERE p.user_id = k.user_id AND p.submitted_at < k.submitted_at) AS previous_attempts
         FROM verification_case k JOIN app_user u ON u.id = k.user_id
        WHERE ($1 = 'all' OR k.state = $1)
        ORDER BY k.sla_due_at LIMIT 100`, [state]);
    return { cases: rows };
  });

  app.get('/admin/verification/:id/image/:which', async (req, reply) => {
    authorize(req.actor, 'verification.read');
    const k = await one(`SELECT * FROM verification_case WHERE id = $1`, [req.params.id]);
    if (!k) throw NotFound('No such case');
    const assetId = req.params.which === 'back' ? k.back_asset : k.front_asset;
    if (!assetId) throw NotFound('No image');
    const got = await getImage(assetId);
    await audit(req, { action: 'verification.image.view', resource: 'verification_case',
                       resourceId: k.id, outcome: 'ok' });
    if (got.url) return reply.redirect(got.url);
    return reply.type(got.asset.mime).send(got.bytes);
  });

  app.post('/admin/verification/:id/decide', async (req) => {
    authorize(req.actor, 'verification.decide');
    assertRecentPasskey(req.actor, 'a student verification decision');
    const decision = req.body?.decision;
    if (!['approve', 'reject', 'request_resubmission'].includes(decision)) {
      throw BadRequest('Decision must be approve, reject or request_resubmission');
    }
    const k = await one(`SELECT * FROM verification_case WHERE id = $1`, [req.params.id]);
    if (!k) throw NotFound('No such case');
    if (['approved', 'rejected'].includes(k.state)) throw Conflict('This case is already decided');

    const note = String(req.body?.note || '').trim() || null;
    /* A manual case has no document and no mailbox proof. Approving it is
       only legitimate on evidence the administrator checked themselves, so
       that evidence must be written down. The database enforces this too. */
    if (decision === 'approve' && k.method === 'manual' && (note || '').length < 10) {
      throw BadRequest('Record how you confirmed this student',
        'A manual request has no document attached. Describe the evidence you checked ' +
        '(for example, who at the university confirmed it) in at least 10 characters.');
    }
    const subject = await one(
      `SELECT student_status, student_email_verified_at FROM app_user WHERE id = $1`, [k.user_id]);
    if (subject?.student_status === 'suspended') {
      throw Conflict('This student is suspended', 'Reinstate the student before deciding their case.');
    }

    const caseState = { approve: 'approved', reject: 'rejected',
                        request_resubmission: 'resubmit_requested' }[decision];
    const userState = { approve: 'approved', reject: 'rejected',
                        request_resubmission: subject?.student_email_verified_at ? 'email_verified' : 'unverified' }[decision];
    req.body = { ...req.body, note };

    await tx(async (c) => {
      await c.query(
        `UPDATE verification_case SET state=$2, decided_by=$3, decided_at=now(), decision_note=$4
          WHERE id=$1`, [k.id, caseState, req.actor.id, req.body?.note || null]);
      await c.query(`UPDATE app_user SET student_status=$2 WHERE id=$1`, [k.user_id, userState]);
    });
    notifyAsync(k.user_id,
      decision === 'approve' ? 'verification_approved'
      : decision === 'reject' ? 'verification_rejected' : 'verification_resubmit',
      { body: req.body?.note || null });
    await audit(req, { action: 'verification.decide', resource: 'verification_case',
                       resourceId: k.id, outcome: 'ok',
                       detail: { decision, subject: k.user_id, note: req.body?.note } });
    return { id: k.id, state: caseState };
  });

  /* ---------- suspend / reinstate a student's verification ----------------
     Distinct from suspending the whole account: a suspended verification
     keeps the person able to sign in and read their history, but they can
     neither order nor deliver. Reinstating restores exactly what the
     evidence supports — VERIFIED only if a mailbox proof or an approved case
     exists — never a blanket approval. */
  app.post('/admin/users/:id/student-verification', async (req) => {
    authorize(req.actor, 'verification.decide');
    assertRecentPasskey(req.actor, 'a student verification decision');
    const action = req.body?.action;
    if (!['suspend', 'reinstate'].includes(action)) throw BadRequest('Action must be suspend or reinstate');
    const note = String(req.body?.note || '').trim();
    if (note.length < 5) throw BadRequest('Give a reason', 'It is recorded in the audit log.');

    const u = await one(`SELECT * FROM app_user WHERE id = $1`, [req.params.id]);
    if (!u) throw NotFound('No such user');

    let next;
    if (action === 'suspend') {
      if (u.student_status === 'suspended') throw Conflict('Already suspended');
      next = 'suspended';
    } else {
      if (u.student_status !== 'suspended') throw Conflict('This verification is not suspended');
      const approvedCase = await one(
        `SELECT 1 FROM verification_case WHERE user_id = $1 AND state = 'approved' LIMIT 1`, [u.id]);
      next = u.student_email_verified_at || approvedCase ? 'approved' : 'unverified';
    }

    await tx(async (c) => {
      await c.query(`UPDATE app_user SET student_status = $2 WHERE id = $1`, [u.id, next]);
      if (next === 'suspended') {
        /* Stop live delivery offers immediately; the partner role itself is
           left for the partner-approval flow to decide. */
        await c.query(`UPDATE partner_profile SET online = false WHERE user_id = $1`, [u.id]);
      }
    });
    if (next === 'suspended') notifyAsync(u.id, 'verification_suspended', { body: note });
    await audit(req, { action: `verification.${action}`, resource: 'user', resourceId: u.id,
                       outcome: 'ok', detail: { from: u.student_status, to: next, note } });
    return { userId: u.id, studentStatus: next, verification: verificationView(next, u.status) };
  });
}
