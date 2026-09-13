/* ==========================================================================
   QUAD - PROFILE AND CAMPUS ROUTES

   The student's own profile, and the campus list. Campus service status is
   administered here too, by platform roles only.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { authorize, BadRequest, NotFound, Forbidden, Conflict } from '../auth/rbac.js';
import { audit } from '../audit.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { campuses, profileOf, validateName, validateMobile, shapeCampus } from '../services/profile.js';

export default async function profileRoutes(app) {
  /* Public: the sign-up flow shows this before the student has chosen. */
  app.get('/campuses', async () => ({ campuses: await campuses() }));

  app.get('/me/profile', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    return profileOf(req.actor.id);
  });

  /* Partial update. Each supplied field is validated on its own; the student
     email is deliberately not a field here - it changes only through the
     email-code verification flow. */
  app.put('/me/profile', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const b = req.body || {};
    if ('studentEmail' in b || 'student_email' in b) {
      throw BadRequest('Your student email cannot be changed here',
        'It is set only by verifying a code sent to that mailbox.');
    }
    const sets = [];
    const vals = [req.actor.id];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if (b.name !== undefined) set('name', validateName(b.name));
    if (b.contactPhone !== undefined) set('contact_phone', validateMobile(b.contactPhone));
    if (b.campusId !== undefined) {
      const c = await one(`SELECT id FROM campus_site WHERE id = $1`, [b.campusId]);
      if (!c) throw BadRequest('Choose a campus from the list');
      /* Moving campus with a live order would strand it. */
      const live = await one(
        `SELECT code FROM food_order WHERE customer_id = $1
            AND state IN ('draft','awaiting_payment','confirmed','preparing','ready','assigned','picked_up')
            AND vendor_id IN (SELECT id FROM vendor WHERE campus_site_id IS DISTINCT FROM $2)
          LIMIT 1`, [req.actor.id, c.id]);
      if (live) throw Conflict('You have an order in progress on your current campus',
        `Change campus after order ${live.code} is finished.`);
      set('campus_site_id', c.id);
    }
    if (!sets.length) throw BadRequest('Nothing to update');
    sets.push('profile_updated_at = now()');
    await q(`UPDATE app_user SET ${sets.join(', ')} WHERE id = $1`, vals);
    await audit(req, { action: 'profile.update', resource: 'user', resourceId: req.actor.id, outcome: 'ok',
                       detail: { fields: Object.keys(b).filter((k) => ['name', 'contactPhone', 'campusId'].includes(k)) } });
    return profileOf(req.actor.id);
  });

  /* ---------- administration --------------------------------------------- */
  app.get('/admin/campuses', async (req) => {
    authorize(req.actor, 'campus.read');
    const { rows } = await q(
      `SELECT c.*, (SELECT count(*)::int FROM vendor v WHERE v.campus_site_id = c.id AND v.active) AS outlets,
              (SELECT count(*)::int FROM app_user u WHERE u.campus_site_id = c.id) AS students
         FROM campus_site c ORDER BY sort, name`);
    return { campuses: rows.map((r) => ({ ...shapeCampus(r), outlets: r.outlets, students: r.students })) };
  });

  app.patch('/admin/campuses/:id', async (req) => {
    authorize(req.actor, 'campus.manage');
    assertRecentPasskey(req.actor, 'changing where ECHO ECHO is in service');
    const b = req.body || {};
    const cur = await one(`SELECT * FROM campus_site WHERE id = $1`, [req.params.id]);
    if (!cur) throw NotFound('No such campus');
    const status = b.serviceStatus ?? cur.service_status;
    if (!['active', 'coming_soon', 'paused'].includes(status)) throw BadRequest('Invalid service status');
    const message = b.statusMessage === undefined ? cur.status_message
      : (String(b.statusMessage || '').trim().slice(0, 200) || null);
    const row = await one(
      `UPDATE campus_site SET service_status = $2, status_message = $3, updated_at = now()
        WHERE id = $1 RETURNING *`, [cur.id, status, message]);
    await audit(req, { action: 'campus_site.update', resource: 'campus_site', resourceId: cur.id, outcome: 'ok',
                       detail: { from: cur.service_status, to: status } });
    return shapeCampus(row);
  });
}
