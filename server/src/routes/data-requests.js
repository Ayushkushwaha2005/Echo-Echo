/* ==========================================================================
   ECHO ECHO - A PERSON'S OWN DATA

     GET  /me/data-export              everything held about me that I may see
     GET  /me/deletion-request         the state of my request
     POST /me/deletion-request         ask for my account to be deleted
     GET  /admin/data-requests         students.view
     POST /admin/data-requests/:id     owner only, record the outcome

   The export is my own records and never another person's: a partner's name on
   my order is left out, and no ID image, session token or internal note is here.
   A decision records what a person did; it deletes nothing by itself, because
   what must be kept is a legal question (docs/PRIVACY-AND-DATA-RETENTION.md).
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { authorize, BadRequest, Conflict, Forbidden, NotFound, Unauthenticated } from '../auth/rbac.js';
import { audit, auditTx } from '../audit.js';

const signedIn = (req) => { if (!req.actor) throw Unauthenticated('Sign in required'); };

export default async function dataRequestRoutes(app) {
  app.get('/me/data-export', { config: { rateLimit: { max: 5, timeWindow: '1 hour', keyGenerator: (req) => `actor:${req.actor?.id || req.ip}`, hook: 'preHandler' } } }, async (req, reply) => {
    signedIn(req);
    const id = req.actor.id;
    const [profile, orders, cases, reviews, consents, partnerConsents, requests] = await Promise.all([
      one(`SELECT name, email, phone, contact_phone, student_email, student_email_verified_at, student_status, roll_number, created_at, last_seen_at FROM app_user WHERE id = $1`, [id]),
      q(`SELECT o.code, o.state, o.fulfilment, o.subtotal_paise, o.total_paise, o.destination_snapshot, o.created_at, v.name AS cafe
           FROM food_order o JOIN vendor v ON v.id = o.vendor_id WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 2000`, [id]),
      q(`SELECT code, subject, state, created_at FROM support_case WHERE user_id = $1 ORDER BY created_at DESC LIMIT 500`, [id]),
      q(`SELECT stars, body, created_at FROM review WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000`, [id]),
      q(`SELECT order_id, notice_version, consented_at, stopped_at, stop_reason FROM location_share_consent WHERE partner_id = $1 ORDER BY consented_at DESC LIMIT 2000`, [id]),
      q(`SELECT accepted_at FROM partner_policy_consent WHERE user_id = $1`, [id]),
      q(`SELECT kind, status, requested_at, decided_at FROM data_request WHERE user_id = $1`, [id]),
    ]);
    await audit(req, { action: 'data.export', resource: 'user', resourceId: id, outcome: 'ok' });
    reply.header('cache-control', 'private, no-store');
    reply.header('content-disposition', 'attachment; filename="echoecho-my-data.json"');
    return {
      generatedAt: new Date().toISOString(), profile,
      orders: orders.rows, supportCases: cases.rows, reviews: reviews.rows,
      locationSharing: consents.rows, partnerPolicyAcceptances: partnerConsents.rows, dataRequests: requests.rows,
      notIncluded: 'Position history is not kept, so there is none to include. Identity documents are not copied into an export; ask support about them.',
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
      const open = (await c.query(`SELECT 1 FROM data_request WHERE user_id = $1 AND kind = 'deletion' AND status = 'open'`, [req.actor.id])).rows[0];
      if (open) throw Conflict('Your request is already with us');
      const row = (await c.query(
        `INSERT INTO data_request (user_id, kind, note) VALUES ($1,'deletion',$2) RETURNING status, requested_at`, [req.actor.id, note])).rows[0];
      await auditTx(c, req, { action: 'data.deletion.request', resource: 'user', resourceId: req.actor.id });
      return { request: row, note: 'Your account is unchanged for now. A person reviews this and tells you what was deleted and what must be kept.' };
    });
  });

  app.get('/admin/data-requests', async (req) => {
    authorize(req.actor, 'user.read');
    const { rows } = await q(
      `SELECT d.id, d.kind, d.status, d.note, d.requested_at, d.decided_at, d.decision_note,
              u.name, coalesce(u.staff_email, u.student_email) AS email
         FROM data_request d JOIN app_user u ON u.id = d.user_id ORDER BY d.requested_at DESC LIMIT 200`);
    return { requests: rows };
  });

  app.post('/admin/data-requests/:id', async (req) => {
    authorize(req.actor, 'user.read');
    if (!req.actor.isOwner) throw Forbidden('Only the platform owner can do this');
    const status = req.body?.status;
    if (!['completed', 'declined'].includes(status)) throw BadRequest('Status must be completed or declined');
    const note = String(req.body?.note ?? '').trim();
    if (note.length < 5) throw BadRequest('Record what was done', 'It is kept with the request.');
    return tx(async (c) => {
      const row = (await c.query(
        `UPDATE data_request SET status = $2, decided_at = now(), decided_by = $3, decision_note = $4
          WHERE id = $1 AND status = 'open' RETURNING id, user_id`, [req.params.id, status, req.actor.id, note.slice(0, 1000)])).rows[0];
      if (!row) throw NotFound('No open request with that id');
      await auditTx(c, req, { action: 'data.deletion.decide', resource: 'user', resourceId: row.user_id, detail: { status } });
      return { id: row.id, status };
    });
  });
}
