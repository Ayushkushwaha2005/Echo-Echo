/* Campus locations: read for everyone, write for admins only.

   Every read is scoped to one campus - the student's own when signed in,
   otherwise the one named in the request, otherwise the single campus in
   service. Boundaries are proposed, then confirmed by an administrator; only
   a confirmed boundary is ever used. */
import { q, one, tx } from '../db/index.js';
import { authorize, can, BadRequest, NotFound, Conflict } from '../auth/rbac.js';
import * as campus from '../services/campus.js';
import { audit } from '../audit.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';

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
    return {
      deliveryAvailable: !!b,
      note: b ? null : 'Campus delivery is not available yet: the delivery area has not been confirmed. Self pickup still works.',
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

  /* ---------- admin: locations -------------------------------------------- */
  const validCoords = (b) => {
    if (b.lat === undefined && b.lng === undefined) return;
    if (b.lat === null && b.lng === null) return;
    if (!Number.isFinite(Number(b.lat)) || !Number.isFinite(Number(b.lng))) {
      throw BadRequest('Coordinates need both a latitude and a longitude');
    }
  };

  app.post('/campus/nodes', async (req) => {
    authorize(req.actor, 'campus.create');
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) throw BadRequest('Give the location a name');
    if (!KINDS.includes(b.kind)) throw BadRequest(`Kind must be one of: ${KINDS.join(', ')}`);
    validCoords(b);
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
                                campus_site_id, instructions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'admin',$11,$12,$13,$14) RETURNING *`,
      [b.parentId || null, b.kind, String(b.name).trim().slice(0, 120), b.detail || null,
       b.aliases || [], !!b.deliverable, b.deliveryEnabled !== false,
       b.lat ?? null, b.lng ?? null, b.radiusM ?? null, b.sourceNote || null, b.sort || 0,
       campusId, b.instructions ? String(b.instructions).slice(0, 300) : null]);
    await audit(req, { action: 'campus.create', resource: 'campus_node', resourceId: row.id,
                       outcome: 'ok', detail: { name: row.name } });
    return row;
  });

  app.patch('/campus/nodes/:id', async (req) => {
    authorize(req.actor, 'campus.update');
    const b = req.body || {};
    if (b.kind !== undefined && !KINDS.includes(b.kind)) throw BadRequest('Unknown location kind');
    validCoords(b);
    const fields = { parent_id: b.parentId, name: b.name, detail: b.detail, aliases: b.aliases,
                     deliverable: b.deliverable, delivery_enabled: b.deliveryEnabled, kind: b.kind,
                     lat: b.lat, lng: b.lng, radius_m: b.radiusM, sort: b.sort, active: b.active,
                     instructions: b.instructions, source_note: b.sourceNote };
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
    const row = await one(
      `UPDATE campus_node SET verification = 'confirmed', verified_by = $2, verified_at = now(),
              source_note = coalesce(source_note, '') || E'\nConfirmed: ' || $3
        WHERE id = $1 AND verification = 'pending' RETURNING *`, [req.params.id, req.actor.id, note.slice(0, 500)]);
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
    if (note.length < 10) {
      throw BadRequest('Record how you confirmed this outline',
        'For example: walked the perimeter on 20 Sep and checked both gates are inside.');
    }
    const out = await tx(async (c) => {
      const b = (await c.query(`SELECT * FROM campus_boundary WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!b) throw NotFound('No such boundary');
      if (b.status !== 'proposed') throw Conflict(`This boundary is already ${b.status}`);
      await c.query(`UPDATE campus_boundary SET status = 'retired', active = false, updated_at = now()
                      WHERE campus_site_id = $1 AND status = 'active'`, [b.campus_site_id]);
      return (await c.query(
        `UPDATE campus_boundary SET status = 'active', active = true, verified_by = $2, verified_at = now(),
                source_note = coalesce(source_note, '') || E'\nConfirmed: ' || $3, updated_at = now()
          WHERE id = $1 RETURNING *`, [b.id, req.actor.id, note])).rows[0];
    });
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
