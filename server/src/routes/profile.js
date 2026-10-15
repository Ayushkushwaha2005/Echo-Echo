/* ==========================================================================
   QUAD - PROFILE AND CAMPUS ROUTES

   The student's own profile, and the campus list. Campus service status is
   administered here too, by platform roles only.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { authorize, BadRequest, NotFound, Forbidden, Conflict, HttpError } from '../auth/rbac.js';
import { audit } from '../audit.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { campuses, profileOf, validateName, validateMobile, shapeCampus } from '../services/profile.js';
import { blocksFor, addressOf, saveAddress, placesOf, createPlace, updatePlace, deletePlace, touchPlace } from '../services/address.js';

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

  /* ---------- the saved campus address --------------------------------------
     Always on the student's own campus, read from their profile row - a
     request cannot name another campus. Describes a place; never locates one. */
  const myCampus = async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    const u = await one(`SELECT campus_site_id FROM app_user WHERE id = $1`, [req.actor.id]);
    if (!u?.campus_site_id) throw BadRequest('Choose your campus first', 'Set your campus in your profile.');
    return u.campus_site_id;
  };
  app.get('/campus/blocks', async (req) => ({ blocks: await blocksFor(await myCampus(req)) }));
  app.get('/me/address', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    return { address: await addressOf(req.actor.id) };
  });
  app.put('/me/address', async (req) => {
    const campusId = await myCampus(req);
    const address = await saveAddress(req.actor.id, campusId, req.body || {});
    await audit(req, { action: 'address.save', resource: 'user', resourceId: req.actor.id, outcome: 'ok' });
    return { address };
  });
  app.delete('/me/address', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');
    await q(`DELETE FROM student_address WHERE user_id = $1`, [req.actor.id]);
    await audit(req, { action: 'address.delete', resource: 'user', resourceId: req.actor.id, outcome: 'ok' });
    return { address: null };
  });

  /* ---------- saved places (migration 031) ---------------------------------
     A map pin inside the campus delivery area plus the words that help a
     partner find it. Always the student's own, on their own campus. */
  /* Until migration 031 is applied the table does not exist: say so plainly
     (503) rather than fail with a 500. Checkout never depends on it. */
  const placesReady = async (fn) => {
    try { return await fn(); } catch (e) {
      if (e?.code === '42P01') throw new HttpError(503, 'not_ready', 'Saved places are not available yet', 'You can still choose your spot on the map at checkout.');
      throw e;
    }
  };
  app.get('/me/places', async (req) => ({ places: await placesReady(async () => placesOf(req.actor?.id, await myCampus(req))) }));
  app.post('/me/places', async (req) => {
    const place = await placesReady(async () => createPlace(req.actor.id, await myCampus(req), req.body || {}));
    await audit(req, { action: 'place.create', resource: 'saved_place', resourceId: place.id, outcome: 'ok' });
    return { place };
  });
  app.put('/me/places/:id', async (req) => {
    const place = await placesReady(async () => updatePlace(req.actor.id, await myCampus(req), req.params.id, req.body || {}));
    await audit(req, { action: 'place.update', resource: 'saved_place', resourceId: place.id, outcome: 'ok' });
    return { place };
  });
  app.delete('/me/places/:id', async (req) => {
    await myCampus(req);
    await placesReady(() => deletePlace(req.actor.id, req.params.id));
    await audit(req, { action: 'place.delete', resource: 'saved_place', resourceId: req.params.id, outcome: 'ok' });
    return { deleted: true };
  });
  /* Most recently used first in the picker. Records nothing else. */
  app.post('/me/places/:id/used', async (req) => {
    await myCampus(req);
    await touchPlace(req.actor.id, req.params.id);
    return { ok: true };
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
