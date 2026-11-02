/* ==========================================================================
   ECHO ECHO - A PERSON'S OWN DATA

     GET    /me/data-export                 everything held about me that I may see
     GET    /me/deletion-request            the state of my request
     POST   /me/deletion-request            ask for my account to be deleted
     DELETE /me/deletion-request            withdraw a request nobody has started on
     GET    /admin/data-requests            students.view
     GET    /admin/data-requests/:id/retention  students.view, what is held, read only
     POST   /admin/data-requests/:id        owner only, review or record the outcome

   open -> in_review -> completed | declined, or open -> cancelled by the person.

   The export is my own records and never another person's: a partner's name on
   my order is left out, and no ID image, session token or internal note is here.
   A decision records what a person did; it deletes nothing by itself, because
   what must be kept is a legal question (docs/PRIVACY-AND-DATA-RETENTION.md).
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { authorize, BadRequest, Conflict, Forbidden, NotFound, Unauthenticated } from '../auth/rbac.js';
import { audit, auditTx } from '../audit.js';
import { notifyAsync } from '../services/notify.js';

const signedIn = (req) => { if (!req.actor) throw Unauthenticated('Sign in required'); };

/* What is held about one person, as counts. Money tables are only counted. */
const HELD = [
  ['Orders', `SELECT count(*)::int n FROM food_order WHERE customer_id = $1`, 'Includes payment and tax records that may have to be kept'],
  ['Orders still open', `SELECT count(*)::int n FROM food_order WHERE customer_id = $1 AND state NOT IN ('delivered','collected','cancelled','refunded','failed','expired')`, 'Finish these first'],
  ['Deliveries carried', `SELECT count(*)::int n FROM food_order WHERE partner_id = $1`, 'Part of other people\'s order records'],
  ['Deposit movements', `SELECT count(*)::int n FROM deposit_movement WHERE partner_id = $1`, 'Financial record'],
  ['Support cases', `SELECT count(*)::int n FROM support_case WHERE user_id = $1`, null],
  ['Reviews', `SELECT count(*)::int n FROM review WHERE user_id = $1`, null],
  ['Incidents involving them', `SELECT count(*)::int n FROM delivery_incident WHERE partner_id = $1 OR reported_by = $1`, null],
  ['Identity documents', `SELECT count(*)::int n FROM verification_case WHERE user_id = $1`, 'Images of a student ID'],
  ['Saved places and addresses', `SELECT (SELECT count(*) FROM saved_place WHERE user_id = $1) + (SELECT count(*) FROM student_address WHERE user_id = $1) AS n`, null],
  ['Notifications', `SELECT count(*)::int n FROM notification WHERE user_id = $1`, null],
  ['Team Chat messages', `SELECT count(*)::int n FROM chat_message WHERE sender_id = $1`, 'Others in the conversation can see these'],
  ['Audit log entries', `SELECT count(*)::int n FROM audit_log WHERE actor_id = $1`, 'Append-only by design'],
];

export default async function dataRequestRoutes(app) {
  app.get('/me/data-export', { config: { rateLimit: { max: 5, timeWindow: '1 hour', keyGenerator: (req) => `actor:${req.actor?.id || req.ip}`, hook: 'preHandler' } } }, async (req, reply) => {
    signedIn(req);
    const id = req.actor.id;
    const [profile, orders, cases, messages, reviews, consents, partnerConsents, requests, places, address, partner, verification, notifications] = await Promise.all([
      one(`SELECT name, email, phone, contact_phone, student_email, student_email_verified_at, student_status, roll_number, created_at, last_seen_at FROM app_user WHERE id = $1`, [id]),
      q(`SELECT o.code, o.state, o.fulfilment, o.subtotal_paise, o.total_paise, o.destination_snapshot, o.created_at, v.name AS cafe
           FROM food_order o JOIN vendor v ON v.id = o.vendor_id WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 2000`, [id]),
      q(`SELECT code, subject, state, created_at FROM support_case WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`, [id]),
      q(`SELECT c.code AS "case", m.body, m.at FROM support_message m JOIN support_case c ON c.id = m.case_id WHERE m.author_id = $1 ORDER BY m.at DESC LIMIT 2000`, [id]),
      q(`SELECT stars, body, created_at FROM review WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000`, [id]),
      q(`SELECT order_id, notice_version, consented_at, stopped_at, stop_reason FROM location_share_consent WHERE partner_id = $1 ORDER BY consented_at DESC LIMIT 2000`, [id]),
      q(`SELECT accepted_at FROM partner_policy_consent WHERE user_id = $1`, [id]),
      q(`SELECT kind, status, requested_at, decided_at, decision_note FROM data_request WHERE user_id = $1`, [id]),
      q(`SELECT label, lat, lng, landmark, instructions, block_text, floor, room, created_at FROM saved_place WHERE user_id = $1`, [id]),
      q(`SELECT block_text, floor, room, landmark, instructions, updated_at FROM student_address WHERE user_id = $1`, [id]),
      one(`SELECT status, applied_at, decided_at, left_at FROM partner_profile WHERE user_id = $1`, [id]),
      q(`SELECT claimed_name, claimed_roll, claimed_college, state, submitted_at, decided_at FROM verification_case WHERE user_id = $1`, [id]),
      q(`SELECT kind, title, body, created_at, read_at FROM notification WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000`, [id]),
    ]);
    await audit(req, { action: 'data.export', resource: 'user', resourceId: id, outcome: 'ok' });
    reply.header('cache-control', 'private, no-store');
    reply.header('content-disposition', 'attachment; filename="echoecho-my-data.json"');
    return {
      generatedAt: new Date().toISOString(), profile,
      orders: orders.rows, supportCases: cases.rows, supportMessages: messages.rows, reviews: reviews.rows,
      savedPlaces: places.rows, address: address.rows, partner, verification: verification.rows, notifications: notifications.rows,
      locationSharing: consents.rows, partnerPolicyAcceptances: partnerConsents.rows, dataRequests: requests.rows,
      notIncluded: 'Position history is not kept, so there is none to include. Identity document images are not copied into an export; ask support about them.',
    };
  });

  app.get('/me/deletion-request', async (req) => {
    signedIn(req);
    return { request: await one(`SELECT status, requested_at, decided_at, decision_note FROM data_request WHERE user_id = $1 AND kind = 'deletion' ORDER BY requested_at DESC LIMIT 1`, [req.actor.id]) };
  });

  app.post('/me/deletion-request', async (req) => {
    signedIn(req);
    const note = String(req.body?.note ?? '').trim().slice(0, 500) || null;
    return tx(async (c) => {
      const open = (await c.query(`SELECT 1 FROM data_request WHERE user_id = $1 AND kind = 'deletion' AND status IN ('open','in_review')`, [req.actor.id])).rows[0];
      if (open) throw Conflict('Your request is already with us');
      const row = (await c.query(
        `INSERT INTO data_request (user_id, kind, note) VALUES ($1,'deletion',$2) RETURNING status, requested_at`, [req.actor.id, note])).rows[0];
      await auditTx(c, req, { action: 'data.deletion.request', resource: 'user', resourceId: req.actor.id });
      return { request: row, note: 'Your account is unchanged for now. A person reviews this and tells you what was deleted and what must be kept.' };
    });
  });

  app.delete('/me/deletion-request', async (req) => {
    signedIn(req);
    return tx(async (c) => {
      const row = (await c.query(
        `UPDATE data_request SET status = 'cancelled', decided_at = now() WHERE user_id = $1 AND kind = 'deletion' AND status = 'open' RETURNING id`, [req.actor.id])).rows[0];
      if (!row) throw Conflict('There is no request you can cancel', 'Once a person has started on it, ask support.');
      await auditTx(c, req, { action: 'data.deletion.cancel', resource: 'user', resourceId: req.actor.id });
      return { cancelled: true };
    });
  });

  app.get('/admin/data-requests', async (req) => {
    authorize(req.actor, 'user.read');
    const { rows } = await q(
      `SELECT d.id, d.kind, d.status, d.note, d.requested_at, d.review_started_at, d.decided_at, d.decision_note,
              u.name, coalesce(u.staff_email, u.student_email) AS email
         FROM data_request d JOIN app_user u ON u.id = d.user_id ORDER BY d.requested_at DESC LIMIT 200`);
    return { requests: rows };
  });

  app.get('/admin/data-requests/:id/retention', async (req) => {
    authorize(req.actor, 'user.read');
    const d = await one(`SELECT user_id, status FROM data_request WHERE id = $1`, [req.params.id]);
    if (!d) throw NotFound('No such request');
    const held = await Promise.all(HELD.map(async ([label, sql, note]) => ({ label, count: Number((await one(sql, [d.user_id])).n), note })));
    await audit(req, { action: 'data.retention.view', resource: 'user', resourceId: d.user_id, outcome: 'ok' });
    return { status: d.status, held, canDecide: !!req.actor.isOwner };
  });

  app.post('/admin/data-requests/:id', async (req) => {
    authorize(req.actor, 'user.read');
    if (!req.actor.isOwner) throw Forbidden('Only the platform owner can do this');
    const status = req.body?.status;
    if (!['in_review', 'completed', 'declined'].includes(status)) throw BadRequest('Status must be in_review, completed or declined');
    const note = String(req.body?.note ?? '').trim();
    if (status !== 'in_review' && note.length < 5) throw BadRequest('Record what was done', 'The person sees this, and it is kept with the request.');
    const out = await tx(async (c) => {
      const row = (await c.query(status === 'in_review'
        ? `UPDATE data_request SET status = 'in_review', review_started_at = now(), reviewed_by = $2 WHERE id = $1 AND status = 'open' RETURNING id, user_id`
        : `UPDATE data_request SET status = $3, decided_at = now(), decided_by = $2, decision_note = $4
            WHERE id = $1 AND status IN ('open','in_review') RETURNING id, user_id`,
      status === 'in_review' ? [req.params.id, req.actor.id] : [req.params.id, req.actor.id, status, note.slice(0, 1000)])).rows[0];
      if (!row) throw NotFound('No open request with that id');
      await auditTx(c, req, { action: 'data.deletion.decide', resource: 'user', resourceId: row.user_id, detail: { status } });
      return row;
    });
    if (status !== 'in_review') {
      notifyAsync(out.user_id, 'data_deletion_decided', { title: `Your deletion request was ${status}`, body: note.slice(0, 1000) });
    }
    return { id: out.id, status };
  });
}
