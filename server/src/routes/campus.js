/* Campus locations: read for everyone, write for admins only.

   Every read is scoped to one campus - the student's own when signed in,
   otherwise the one named in the request, otherwise the single campus in
   service. Boundaries are proposed, then confirmed by an administrator; only
   a confirmed boundary is ever used. */
import { q, one, tx } from '../db/index.js';
import { authorize, can, BadRequest, NotFound, Conflict, Forbidden, Unauthenticated } from '../auth/rbac.js';
import * as campus from '../services/campus.js';
import { audit } from '../audit.js';

/* What a student is told when the location check refuses them. One place,
   so the gate and the screen can never disagree about why. */
const PRESENCE_COPY = {
  no_boundary_configured: {
    title: 'Campus delivery is not switched on yet',
    detail: 'An administrator still has to confirm the campus outline. Nothing can be ordered until they do.' },
  accuracy_unknown: {
    title: 'Your device did not report how accurate its location is',
    detail: 'Turn on precise location for your browser and try again, ideally outdoors.' },
  low_accuracy: {
    title: 'Your location is not precise enough',
    detail: 'Move outdoors or somewhere with a clearer view of the sky and try again.' },
  outside_campus: {
    title: 'You are not on campus',
    detail: 'ECHO ECHO only takes orders from students who are physically on campus.' },
  near_boundary: {
    title: 'You are right on the edge of campus',
    detail: 'Your location is not precise enough to tell which side of the boundary you are on. Move further inside and try again.' },
};
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { PLACE_TYPES, VERIFICATION_METHODS } from '../services/geo-import.js';

const KINDS = ['campus', 'zone', 'building', 'floor', 'room', 'spot'];

/* Which campus a read is about. A signed-in student cannot browse another
   campus's delivery points by passing an id. */
async function campusFor(req) {
  if (req.actor?.campusId && !can(req.actor, 'location.read')) {
    return req.actor.campusId;
  }
  if (req.query?.campusId) return req.query.campusId;
  const live = (await q(`SELECT id FROM campus_site WHERE service_status = 'active'`)).rows;
  return live.length === 1 ? live[0].id : null;
}

export default async function campusRoutes(app) {
  app.get('/campus/tree', async (req) => ({ nodes: await campus.tree(await campusFor(req)) }));

  /* Children of a node (or the top level) on one campus. With `vendorId`,
     each destination carries a walking estimate from that outlet when both
     have a recorded position. */
  app.get('/campus/destinations', async (req) => {
    const campusId = await campusFor(req);
    if (!campusId) return { nodes: [], deliveryAvailable: false };
    const parent = req.query?.parent || null;
    const { rows } = await q(
      `SELECT id,parent_id,kind,name,detail,instructions,deliverable,delivery_enabled,lat,lng
         FROM campus_node
        WHERE active AND campus_site_id = $1
          AND (($2::uuid IS NULL AND parent_id IS NULL) OR parent_id = $2)
        ORDER BY sort,name`, [campusId, parent]);
    const b = await campus.boundary(campusId);
    let from = null;
    if (req.query?.vendorId) {
      from = await one(
        `SELECT n.lat, n.lng FROM vendor v JOIN campus_node n ON n.id = v.campus_node_id
          WHERE v.id = $1 AND v.campus_site_id = $2`, [req.query.vendorId, campusId]);
    }
    const available = await campus.deliveryAvailable(campusId, b);
    return {
      deliveryAvailable: available,
      note: available ? null
        : b ? 'Campus delivery is not available yet: no delivery point has been confirmed. Self pickup still works.'
        : 'Campus delivery is not available yet: the delivery area has not been confirmed. Self pickup still works.',
      nodes: rows.map(({ lat, lng, ...n }) => ({
        ...n,
        estimate: n.deliverable && b && lat != null && campus.pointInPolygon(Number(lat), Number(lng), b.polygon)
          ? campus.walkEstimate(from, { lat, lng }) : null,
      })),
    };
  });

  /* Type-ahead over names and aliases. Returns the full path so the student
     can tell Academic Block B from Hostel Block B. */
  app.get('/campus/search', async (req) => {
    const term = String(req.query?.q || '').trim();
    const campusId = await campusFor(req);
    if (term.length < 2 || !campusId) return { results: [] };
    const { rows } = await q(
      `SELECT id, name, kind, deliverable, delivery_enabled FROM campus_node
        WHERE active AND campus_site_id = $2 AND (name ILIKE $1 OR EXISTS (
          SELECT 1 FROM unnest(aliases) a WHERE a ILIKE $1))
        ORDER BY deliverable DESC, name LIMIT 20`, [`%${term}%`, campusId]);
    const results = [];
    for (const r of rows) results.push({ ...r, path: await campus.pathLabel(r.id) });
    return { results };
  });

  app.post('/campus/resolve', async (req) =>
    campus.resolvePhrase(req.body?.text, { campusId: await campusFor(req) }));

  /* Live location. The coordinate is validated against the boundary here;
     the response is candidates to confirm, never a chosen destination. */
  app.post('/campus/locate', async (req) => {
    const { lat, lng, accuracy } = req.body || {};
    /* Coerce only from an actual number or a numeric string. `Number(null)`
       is 0, and 0,0 is a real place in the Gulf of Guinea — a missing
       coordinate must be an error, never a silent position. */
    const coord = (v) => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return NaN;
    };
    const out = await campus.resolveFix(coord(lat), coord(lng), { accuracy, campusId: await campusFor(req) });
    await audit(req, { action: 'campus.locate', outcome: 'ok',
                       detail: { inside: out.inside, reason: out.reason } });
    return out;
  });

  /* ---------- the live-location gate --------------------------------------
     Required once per session, after the student proves their mailbox and
     before the ordering screens open.

     Every refusal below is a refusal: there is no branch that shrugs and
     lets the student through. Permission denied, no fix, an unknown or poor
     accuracy, no confirmed campus boundary, outside the boundary, or so
     close to the edge that the reading cannot tell which side they are on —
     all of them end here, and the session stays without presence.

     The verdict is written onto the session row, so a client that simply
     never calls this is refused by the ordering gate rather than trusted. */
  app.post('/campus/presence', async (req) => {
    if (!req.actor) throw Unauthenticated('Sign in required');
    const { lat, lng, accuracy } = req.body || {};
    const coord = (v) => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return NaN;
    };
    const campusId = await campusFor(req);
    const out = await campus.resolveFix(coord(lat), coord(lng), { accuracy, campusId });

    if (!out.inside) {
      await audit(req, { action: 'campus.presence', outcome: 'denied',
                         detail: { reason: out.reason, accuracy: out.accuracy ?? null } });
      /* resolveFix's `note` is written for the delivery-spot picker ("choose
         your spot from the list"); this screen has no list, so it says what
         this gate means instead. */
      const copy = PRESENCE_COPY[out.reason];
      const detail = out.reason === 'low_accuracy'
        ? `Your location is only accurate to about ${Math.round(out.accuracy)} m. ${copy.detail}`
        : copy?.detail || 'Ordering on ECHO ECHO is only open to students who are physically on campus.';
      throw Forbidden(copy?.title || 'We could not confirm you are on campus', detail);
    }

    await q(`UPDATE session SET campus_presence_at = now(), campus_presence_lat = $2,
                    campus_presence_lng = $3, campus_presence_accuracy_m = $4,
                    campus_presence_site_id = $5
              WHERE token_hash = $1`,
      [req.actor.tokenHash, coord(lat), coord(lng),
       Number.isFinite(Number(accuracy)) ? Number(accuracy) : null, campusId]);
    await audit(req, { action: 'campus.presence', outcome: 'ok',
                       detail: { accuracy: out.accuracy ?? null, boundary: out.boundaryName } });

    return { confirmed: true, boundaryName: out.boundaryName, accuracy: out.accuracy ?? null,
             candidates: out.candidates, confirmedAt: new Date().toISOString() };
  });

  /* ---------- admin: locations -------------------------------------------- */
  const validCoords = (b) => {
    if (b.lat === undefined && b.lng === undefined) return;
    if (b.lat === null && b.lng === null) return;
    if (!Number.isFinite(Number(b.lat)) || !Number.isFinite(Number(b.lng))) {
      throw BadRequest('Coordinates need both a latitude and a longitude');
    }
  };

  const geoFields = (b) => {
    if (b.placeType !== undefined && b.placeType !== null && !PLACE_TYPES.includes(b.placeType)) {
      throw BadRequest(`Type must be one of: ${PLACE_TYPES.join(', ')}`);
    }
    if (b.verificationMethod !== undefined && b.verificationMethod !== null && !VERIFICATION_METHODS.includes(b.verificationMethod)) {
      throw BadRequest(`Verification method must be one of: ${VERIFICATION_METHODS.join(', ')}`);
    }
    if (b.gpsAccuracyM !== undefined && b.gpsAccuracyM !== null && !(Number(b.gpsAccuracyM) >= 0)) {
      throw BadRequest('GPS accuracy must be a number of metres');
    }
  };

  app.post('/campus/nodes', async (req) => {
    authorize(req.actor, 'campus.create');
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) throw BadRequest('Give the location a name');
    if (!KINDS.includes(b.kind)) throw BadRequest(`Kind must be one of: ${KINDS.join(', ')}`);
    validCoords(b);
    geoFields(b);
    /* The campus comes from the parent when there is one. */
    let campusId = b.campusSiteId || null;
    if (b.parentId) {
      const p = await one(`SELECT campus_site_id FROM campus_node WHERE id = $1`, [b.parentId]);
      if (!p) throw BadRequest('The parent location does not exist');
      campusId = p.campus_site_id;
    }
    if (!campusId) {
      const live = (await q(`SELECT id FROM campus_site WHERE service_status = 'active'`)).rows;
      if (live.length !== 1) throw BadRequest('Choose the campus this location belongs to');
      campusId = live[0].id;
    }
    const row = await one(
      `INSERT INTO campus_node (parent_id, kind, name, detail, aliases, deliverable,
                                delivery_enabled, lat, lng, radius_m, source, source_note, sort,
                                campus_site_id, instructions, place_type, verification_method, gps_accuracy_m)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'admin',$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [b.parentId || null, b.kind, String(b.name).trim().slice(0, 120), b.detail || null,
       b.aliases || [], !!b.deliverable, b.deliveryEnabled !== false,
       b.lat ?? null, b.lng ?? null, b.radiusM ?? null, b.sourceNote || null, b.sort || 0,
       campusId, b.instructions ? String(b.instructions).slice(0, 300) : null,
       b.placeType ?? null, b.verificationMethod ?? (b.lat != null ? 'admin_entry' : null), b.gpsAccuracyM ?? null]);
    await audit(req, { action: 'campus.create', resource: 'campus_node', resourceId: row.id,
                       outcome: 'ok', detail: { name: row.name } });
    return row;
  });

  app.patch('/campus/nodes/:id', async (req) => {
    authorize(req.actor, 'campus.update');
    const b = req.body || {};
    if (b.kind !== undefined && !KINDS.includes(b.kind)) throw BadRequest('Unknown location kind');
    validCoords(b);
    geoFields(b);
    const fields = { parent_id: b.parentId, name: b.name, detail: b.detail, aliases: b.aliases,
                     deliverable: b.deliverable, delivery_enabled: b.deliveryEnabled, kind: b.kind,
                     lat: b.lat, lng: b.lng, radius_m: b.radiusM, sort: b.sort, active: b.active,
                     instructions: b.instructions, source_note: b.sourceNote,
                     place_type: b.placeType, verification_method: b.verificationMethod, gps_accuracy_m: b.gpsAccuracyM };
    const set = [], vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) { vals.push(v); set.push(`${k} = $${vals.length}`); }
    }
    if (!set.length) throw BadRequest('Nothing to update');
    const before = await one(`SELECT * FROM campus_node WHERE id = $1`, [req.params.id]);
    if (!before) throw NotFound('No such location');
    if (b.deliverable === true && before.verification === 'pending') {
      throw Conflict('Confirm this location before enabling delivery to it',
        'It came from a public map and has not been checked on the ground. Use Confirm location.');
    }
    /* Moving a confirmed point changes where deliveries go and which side of
       the boundary it is on: a fresh passkey and the evidence are required. */
    const moved = (b.lat !== undefined && Number(b.lat) !== Number(before.lat)) ||
                  (b.lng !== undefined && Number(b.lng) !== Number(before.lng));
    if (moved && before.verification === 'confirmed' && before.lat != null) {
      assertRecentPasskey(req.actor, 'moving a confirmed location');
      if (!b.verificationMethod) {
        throw BadRequest('Say how the new position was established', 'Choose a verification method, e.g. GPS on site.');
      }
    }
    vals.push(req.params.id);
    const row = await one(
      `UPDATE campus_node SET ${set.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    const changed = Object.keys(fields).filter((k) => fields[k] !== undefined);
    await audit(req, { action: 'campus.update', resource: 'campus_node', resourceId: row.id, outcome: 'ok',
                       detail: { changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])),
                                 after: Object.fromEntries(changed.map((k) => [k, row[k]])) } });
    return row;
  });

  /* A pending location (e.g. from a public map) becomes usable only when an
     administrator records how it was checked on the ground. */
  app.post('/campus/nodes/:id/confirm', async (req) => {
    authorize(req.actor, 'campus.update');
    assertRecentPasskey(req.actor, 'confirming a delivery location');
    const note = String(req.body?.confirmation || '').trim();
    if (note.length < 10) throw BadRequest('Record how you confirmed this location', 'For example: visited 20 Sep, hand-over at the main entrance.');
    const method = req.body?.verificationMethod || null;
    if (method && !VERIFICATION_METHODS.includes(method)) throw BadRequest('Unknown verification method');
    const row = await one(
      `UPDATE campus_node SET verification = 'confirmed', verified_by = $2, verified_at = now(),
              source_note = coalesce(source_note, '') || E'\nConfirmed: ' || $3,
              verification_method = coalesce($4, verification_method,
                                             CASE WHEN lat IS NOT NULL THEN 'admin_entry' END)
        WHERE id = $1 AND verification = 'pending' RETURNING *`, [req.params.id, req.actor.id, note.slice(0, 500), method]);
    if (!row) throw Conflict('No pending location with that id');
    await audit(req, { action: 'campus.location.confirm', resource: 'campus_node', resourceId: row.id, outcome: 'ok',
                       detail: { name: row.name, confirmation: note } });
    return row;
  });

  /* Archive, never delete — historical orders must still resolve. */
  app.post('/campus/nodes/:id/archive', async (req) => {
    authorize(req.actor, 'campus.archive');
    const row = await one(`UPDATE campus_node SET active = false WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!row) throw NotFound('No such location');
    await audit(req, { action: 'campus.archive', resource: 'campus_node', resourceId: row.id, outcome: 'ok' });
    return row;
  });

  /* Zone view with the counts the brief asks for. */
  app.get('/campus/zones', async (req) => {
    authorize(req.actor, 'location.read');
    const { rows } = await q(
      `SELECT z.id, z.name, z.delivery_enabled, z.active, z.campus_site_id,
              (SELECT count(*) FROM campus_node c
                WHERE c.parent_id = z.id AND c.active AND c.deliverable)::int AS locations,
              (SELECT count(*) FROM food_order o
                 JOIN campus_node d ON d.id = o.destination_id
                WHERE d.parent_id = z.id
                  AND o.state IN ('confirmed','preparing','ready','assigned','picked_up'))::int AS active_deliveries
         FROM campus_node z WHERE z.parent_id IS NULL
          AND ($1::uuid IS NULL OR z.campus_site_id = $1)
        ORDER BY z.sort, z.name`, [req.query?.campusId || null]);
    return { zones: rows };
  });

  /* ---------- boundaries ---------------------------------------------------- */
  app.get('/campus/boundary', async (req) => ({ boundary: await campus.boundary(await campusFor(req)) }));

  app.get('/admin/campuses/:id/boundaries', async (req) => {
    authorize(req.actor, 'boundary.read');
    const { rows } = await q(
      `SELECT b.id, b.name, b.polygon, b.status, b.source, b.source_note, b.created_at, b.verified_at,
              cu.name AS created_by_name, vu.name AS verified_by_name
         FROM campus_boundary b LEFT JOIN app_user cu ON cu.id = b.created_by
         LEFT JOIN app_user vu ON vu.id = b.verified_by
        WHERE b.campus_site_id = $1 ORDER BY (b.status = 'active') DESC, b.created_at DESC`, [req.params.id]);
    return { boundaries: rows.map((r) => ({ ...r, metrics: campus.validatePolygon(r.polygon).metrics || null })) };
  });

  /* A new outline is always a proposal. Nothing changes for students until an
     administrator confirms it. */
  const propose = async (req, campusId) => {
    authorize(req.actor, 'boundary.propose');
    const { name, polygon, source, sourceNote } = req.body || {};
    if (!campusId || !(await one(`SELECT 1 FROM campus_site WHERE id = $1`, [campusId]))) {
      throw BadRequest('Choose the campus this boundary is for');
    }
    /* Validated hard, because an administrator types these in by hand and a
       subtly wrong geofence is worse than none: it silently approves
       students in the wrong place or rejects them where they are standing. */
    const check = campus.validatePolygon(polygon);
    if (!check.ok) throw BadRequest('That boundary is not usable', check.problems.join(' '));
    if (!sourceNote || String(sourceNote).trim().length < 10) {
      throw BadRequest('Say where this outline comes from', 'For example: surveyed on foot, traced from the official campus map.');
    }
    const row = await one(
      `INSERT INTO campus_boundary (name, polygon, source, source_note, campus_site_id, status, active, created_by)
       VALUES ($1,$2,$3,$4,$5,'proposed',false,$6) RETURNING *`,
      [name || 'Campus boundary', JSON.stringify(polygon), source || 'admin', String(sourceNote).trim(), campusId, req.actor.id]);
    await audit(req, { action: 'campus.boundary.propose', resourceId: row.id, outcome: 'ok', detail: check.metrics });
    return { ...row, metrics: check.metrics, warnings: check.warnings };
  };
  app.post('/admin/campuses/:id/boundaries', async (req) => propose(req, req.params.id));
  /* Kept for the existing admin screen and API clients: now creates a proposal. */
  app.put('/campus/boundary', async (req) => propose(req, req.body?.campusId || await campusFor(req)));

  /* Confirming makes an outline the one delivery is checked against. It
     retires the previous one, is audited with who confirmed it, and needs a
     recent passkey confirmation from an administrator. */
  app.post('/admin/boundaries/:id/activate', async (req) => {
    authorize(req.actor, 'boundary.confirm');
    assertRecentPasskey(req.actor, 'confirming a campus delivery boundary');
    const note = String(req.body?.confirmation || '').trim();
    const out = await tx((c) => campus.activateBoundary(c,
      { boundaryId: req.params.id, verifiedBy: req.actor.id, confirmation: note }));
    await audit(req, { action: 'campus.boundary.activate', resourceId: out.id, outcome: 'ok',
                       detail: { campus: out.campus_site_id, confirmation: note } });
    return out;
  });

  app.post('/admin/boundaries/:id/retire', async (req) => {
    authorize(req.actor, 'boundary.confirm');
    assertRecentPasskey(req.actor, 'retiring a campus delivery boundary');
    const row = await one(
      `UPDATE campus_boundary SET status = 'retired', active = false, updated_at = now()
        WHERE id = $1 AND status <> 'retired' RETURNING *`, [req.params.id]);
    if (!row) throw NotFound('No such boundary, or it is already retired');
    await audit(req, { action: 'campus.boundary.retire', resourceId: row.id, outcome: 'ok' });
    return row;
  });

  /* Lets an admin check an outline before committing to it. */
  app.post('/campus/boundary/validate', async (req) => {
    authorize(req.actor, 'boundary.read');
    return campus.validatePolygon(req.body?.polygon);
  });
}
