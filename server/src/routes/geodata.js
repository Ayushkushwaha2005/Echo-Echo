/* ==========================================================================
   ECHO ECHO - FIELD GEODATA (admin)

   POST /admin/campuses/:id/points/preview      locations.manage  parse + check, stores nothing
   POST /admin/campuses/:id/points/import       locations.manage  store as pending, or confirmed (passkey + note)
   POST /admin/campuses/:id/points/confirm      locations.manage  confirm a whole pending import batch
   GET  /admin/campuses/:id/distances           locations.view    pickup point -> delivery point matrix
   POST /admin/campuses/:id/boundaries/import   boundary.view     perimeter track -> PROPOSED outline
   GET  /admin/boundaries/:id/compare?with=     boundary.view     difference between two outlines

   Coordinates enter the system only from an uploaded GPS export or an
   administrator's form. A boundary import is always a proposal; activating
   it remains the separate, passkey-confirmed step in routes/campus.js.
   ========================================================================== */
import { randomUUID } from 'node:crypto';
import { q, one, tx } from '../db/index.js';
import { authorize, BadRequest, NotFound, Conflict } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import * as campus from '../services/campus.js';
import { parsePoints, parseTrack, comparePolygons } from '../services/geo-import.js';
import { audit } from '../audit.js';

const MAX_ACCURACY_M = Number(process.env.GEO_IMPORT_MAX_ACCURACY_M || 25);
const DUPLICATE_RADIUS_M = 15;
const CONFIRMABLE_METHODS = ['gps_on_site', 'survey_track', 'official_map'];
/* GPS exports are larger than the global 1 MB JSON limit; these admin-only
   routes accept up to 6 MB, and the parsers cap point counts. */
const UPLOAD = { bodyLimit: 6 * 1024 * 1024, config: { rateLimit: { max: 30, timeWindow: 60_000 } } };

async function campusOr404(id) {
  const c = await one(`SELECT id, name FROM campus_site WHERE id = $1`, [id]);
  if (!c) throw NotFound('No such campus');
  return c;
}

async function outlines(campusId) {
  const { rows } = await q(
    `SELECT id, name, status, polygon, source, collection_method, created_at FROM campus_boundary
      WHERE campus_site_id = $1 AND status <> 'retired' ORDER BY created_at DESC`, [campusId]);
  return { active: rows.find((r) => r.status === 'active') || null, proposed: rows.filter((r) => r.status === 'proposed') };
}

/* Where a point sits relative to every live outline - reported, not decided. */
const placement = (p, o) => ({
  insideActiveBoundary: o.active ? campus.pointInPolygon(p.lat, p.lng, o.active.polygon) : null,
  metresFromActiveEdge: o.active ? Math.round(campus.metresToEdge(p.lat, p.lng, o.active.polygon)) : null,
  proposals: o.proposed.map((b) => ({ id: b.id, name: b.name, inside: campus.pointInPolygon(p.lat, p.lng, b.polygon) })),
});

async function review(campusId, body) {
  const parsed = parsePoints({ format: body?.format, text: body?.text,
                               defaultMethod: body?.defaultMethod || 'gps_on_site', maxAccuracyM: MAX_ACCURACY_M });
  if (!parsed.ok) return parsed;
  const o = await outlines(campusId);
  const existing = (await q(
    `SELECT id, name, lat, lng, verification FROM campus_node WHERE campus_site_id = $1 AND active`, [campusId])).rows;
  for (const p of parsed.points) {
    Object.assign(p, placement(p, o));
    p.sameNameAs = existing.find((e) => e.name.toLowerCase() === p.name.toLowerCase())?.id || null;
    const near = existing.filter((e) => e.lat != null)
      .map((e) => ({ id: e.id, name: e.name, metres: Math.round(campus.metresBetween([p.lat, p.lng], [e.lat, e.lng])) }))
      .filter((e) => e.metres <= DUPLICATE_RADIUS_M).sort((a, b) => a.metres - b.metres);
    p.nearbyExisting = near.slice(0, 3);
    if (p.sameNameAs) p.warnings.push('a location with this name already exists on this campus');
    if (near.length) p.warnings.push(`within ${DUPLICATE_RADIUS_M} m of "${near[0].name}"`);
    if (o.active && !p.insideActiveBoundary) p.warnings.push('outside the confirmed boundary - delivery there will be refused');
    if (!o.active) p.warnings.push('no confirmed boundary yet - inside/outside cannot be decided');
  }
  return { ...parsed, boundaries: { active: o.active && { id: o.active.id, name: o.active.name },
                                    proposed: o.proposed.map((b) => ({ id: b.id, name: b.name })) } };
}

export default async function geodataRoutes(app) {
  app.post('/admin/campuses/:id/points/preview', UPLOAD, async (req) => {
    authorize(req.actor, 'campus.create');
    const c = await campusOr404(req.params.id);
    const out = await review(c.id, req.body);
    if (!out.ok) throw BadRequest('That file could not be read', out.problems.join(' '));
    return { ...out, maxAccuracyM: MAX_ACCURACY_M, stored: false };
  });

  app.post('/admin/campuses/:id/points/import', UPLOAD, async (req) => {
    authorize(req.actor, 'campus.create');
    const c = await campusOr404(req.params.id);
    const b = req.body || {};
    const confirm = b.confirm === true;
    const note = String(b.confirmation || '').trim();
    if (confirm) {
      authorize(req.actor, 'campus.update');
      assertRecentPasskey(req.actor, 'confirming field-collected locations');
      if (note.length < 10) throw BadRequest('Record how these points were collected', 'For example: walked campus 21 Sep with GPS Logger on a Pixel 7, standing at each entrance.');
    }
    const out = await review(c.id, b);
    if (!out.ok) throw BadRequest('That file could not be read', out.problems.join(' '));
    if (out.rejected.length) {
      throw BadRequest(`${out.rejected.length} row(s) are invalid; nothing was imported`,
        out.rejected.slice(0, 10).map((r) => `line ${r.line}: ${r.problems.join(', ')}`).join('; '));
    }
    const clashes = out.points.filter((p) => p.sameNameAs);
    if (clashes.length) {
      throw Conflict('Some names already exist on this campus; nothing was imported',
        `${clashes.map((p) => p.name).join(', ')}. Rename them in the file, or edit the existing locations instead.`);
    }
    if (confirm) {
      const weak = out.points.filter((p) => !CONFIRMABLE_METHODS.includes(p.method));
      if (weak.length) {
        throw BadRequest('Only on-site GPS, a survey track or an official map can be confirmed on import',
          `${weak.map((p) => `${p.name} (${p.method})`).join(', ')}: import these as pending and confirm them after checking on site.`);
      }
      if (out.boundaries.active) {
        const outside = out.points.filter((p) => !p.insideActiveBoundary && p.deliverable);
        if (outside.length) throw Conflict('Deliverable points outside the confirmed boundary', outside.map((p) => p.name).join(', '));
      }
    }
    const parent = b.parentId ? await one(`SELECT id FROM campus_node WHERE id = $1 AND campus_site_id = $2`, [b.parentId, c.id]) : null;
    if (b.parentId && !parent) throw BadRequest('The parent location is not on this campus');

    const batch = randomUUID();
    const created = await tx(async (cl) => {
      const ids = [];
      for (const p of out.points) {
        const sourceNote = [`Imported ${new Date().toISOString().slice(0, 10)} from ${out.format.toUpperCase()}`,
          p.recordedAt ? `recorded ${p.recordedAt}` : null, p.accuracyM != null ? `accuracy ${p.accuracyM} m` : null,
          p.note, confirm ? `Confirmed: ${note}` : null].filter(Boolean).join('; ');
        const row = (await cl.query(
          `INSERT INTO campus_node (campus_site_id, parent_id, kind, name, lat, lng, deliverable, delivery_enabled,
                                    source, source_note, verification, verified_by, verified_at, place_type,
                                    verification_method, gps_accuracy_m, recorded_at, import_batch)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'survey',$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, name, verification`,
          [c.id, parent?.id || null, p.kind, p.name, p.lat, p.lng, confirm && p.deliverable, true,
           sourceNote.slice(0, 1000), confirm ? 'confirmed' : 'pending', confirm ? req.actor.id : null,
           confirm ? new Date() : null, p.type, p.method, p.accuracyM, p.recordedAt, batch])).rows[0];
        ids.push(row);
      }
      return ids;
    });
    await audit(req, { action: 'campus.points.import', resource: 'campus_site', resourceId: c.id, outcome: 'ok',
                       detail: { batch, count: created.length, confirmed: confirm, format: out.format, confirmation: note || null } });
    return { batch, created, confirmed: confirm,
             next: confirm ? null : 'Imported as pending. Review them, then confirm the batch (or each location) after checking on site.' };
  });

  app.post('/admin/campuses/:id/points/confirm', async (req) => {
    authorize(req.actor, 'campus.update');
    assertRecentPasskey(req.actor, 'confirming field-collected locations');
    const c = await campusOr404(req.params.id);
    const note = String(req.body?.confirmation || '').trim();
    if (note.length < 10) throw BadRequest('Record how these points were checked');
    if (!req.body?.batch) throw BadRequest('Choose the import batch to confirm');
    const rows = (await q(
      `UPDATE campus_node SET verification = 'confirmed', verified_by = $3, verified_at = now(),
              source_note = coalesce(source_note,'') || E'\nConfirmed: ' || $4
        WHERE campus_site_id = $1 AND import_batch = $2 AND verification = 'pending'
          AND verification_method = ANY($5) RETURNING id, name`,
      [c.id, req.body.batch, req.actor.id, note.slice(0, 500), CONFIRMABLE_METHODS])).rows;
    if (!rows.length) throw Conflict('Nothing to confirm in that batch', 'Already confirmed, or collected from a public map (confirm those one by one after checking).');
    await audit(req, { action: 'campus.points.confirm', resource: 'campus_site', resourceId: c.id, outcome: 'ok',
                       detail: { batch: req.body.batch, count: rows.length, confirmation: note } });
    return { confirmed: rows };
  });

  /* Every cafeteria pickup point against every confirmed delivery point. */
  app.get('/admin/campuses/:id/distances', async (req) => {
    authorize(req.actor, 'location.read');
    const c = await campusOr404(req.params.id);
    const o = await outlines(c.id);
    const vendors = (await q(
      `SELECT v.id, v.name, v.active, n.id AS pickup_id, n.name AS pickup_name, n.lat, n.lng, n.verification
         FROM vendor v LEFT JOIN campus_node n ON n.id = v.campus_node_id
        WHERE v.campus_site_id = $1 ORDER BY v.name`, [c.id])).rows;
    const points = (await q(
      `SELECT id, name, place_type, kind, lat, lng, deliverable, delivery_enabled, verification
         FROM campus_node WHERE campus_site_id = $1 AND active AND lat IS NOT NULL
          AND place_type IS DISTINCT FROM 'cafeteria_pickup' ORDER BY name`, [c.id])).rows;
    const rows = [];
    for (const v of vendors) {
      const usable = v.lat != null && v.verification === 'confirmed';
      for (const p of points) {
        const est = usable && p.verification === 'confirmed' ? campus.walkEstimate(v, p) : null;
        rows.push({ vendorId: v.id, vendor: v.name, pointId: p.id, point: p.name, placeType: p.place_type,
                    deliverable: p.deliverable && p.delivery_enabled, pointVerification: p.verification,
                    insideActiveBoundary: o.active ? campus.pointInPolygon(Number(p.lat), Number(p.lng), o.active.polygon) : null,
                    metres: est?.metres ?? null, estimate: est?.label ?? null,
                    unavailableBecause: est ? null : !v.pickup_id ? 'cafeteria has no pickup point'
                      : v.lat == null ? 'pickup point has no position' : v.verification !== 'confirmed'
                      ? 'pickup point not confirmed' : 'delivery point not confirmed' });
      }
    }
    return {
      campus: c, boundaryConfirmed: !!o.active,
      vendors: vendors.map((v) => ({ id: v.id, name: v.name, pickupId: v.pickup_id, pickupName: v.pickup_name,
                                     pickupReady: v.lat != null && v.verification === 'confirmed' })),
      pointCount: points.length, rows,
      basis: 'straight-line distance between recorded points, ×1.25–1.6 for paths, 65–80 m/min, +2–4 min hand-over. An estimate, not navigation.',
    };
  });

  /* ---------- perimeter ------------------------------------------------------ */
  app.post('/admin/campuses/:id/boundaries/import', UPLOAD, async (req) => {
    authorize(req.actor, 'boundary.propose');
    const c = await campusOr404(req.params.id);
    const b = req.body || {};
    const sourceNote = String(b.sourceNote || '').trim();
    if (sourceNote.length < 10) throw BadRequest('Say how this perimeter was collected', 'For example: walked the fence line 21 Sep with GPS Logger, 1 s interval.');
    const method = b.collectionMethod || 'gps_walk';
    if (!['gps_walk', 'survey', 'official_map', 'public_map', 'admin_entry'].includes(method)) throw BadRequest('Unknown collection method');
    const track = parseTrack({ format: b.format, text: b.text });
    if (!track.ok) throw BadRequest('That perimeter could not be read', track.problems.join(' '));
    const check = campus.validatePolygon(track.polygon);
    if (!check.ok) throw BadRequest('That perimeter is not a usable outline', check.problems.join(' '));
    const o = await outlines(c.id);
    if (b.dryRun === true) {
      return { stored: false, polygon: track.polygon, stats: track.stats, warnings: [...track.warnings, ...check.warnings],
               metrics: check.metrics, comparisons: compareAll(track.polygon, o) };
    }
    const row = await one(
      `INSERT INTO campus_boundary (name, polygon, source, source_note, campus_site_id, status, active, created_by,
                                    collection_method, track_stats)
       VALUES ($1,$2,'field_import',$3,$4,'proposed',false,$5,$6,$7) RETURNING id, name, status, created_at`,
      [String(b.name || 'Walked perimeter').slice(0, 120), JSON.stringify(track.polygon), sourceNote, c.id, req.actor.id,
       method, JSON.stringify(track.stats)]);
    await audit(req, { action: 'campus.boundary.propose', resource: 'campus_boundary', resourceId: row.id, outcome: 'ok',
                       detail: { ...check.metrics, import: track.stats, method } });
    return { ...row, stored: true, polygon: track.polygon, stats: track.stats, metrics: check.metrics,
             warnings: [...track.warnings, ...check.warnings], comparisons: compareAll(track.polygon, o),
             next: 'This is a proposal. Compare it, then confirm it (Confirm and activate) only if it matches the ground.' };
  });

  app.get('/admin/boundaries/:id/compare', async (req) => {
    authorize(req.actor, 'boundary.read');
    const a = await one(`SELECT * FROM campus_boundary WHERE id = $1`, [req.params.id]);
    if (!a) throw NotFound('No such boundary');
    const w = String(req.query?.with || 'active');
    const other = w === 'active'
      ? await one(`SELECT * FROM campus_boundary WHERE campus_site_id = $1 AND status = 'active'`, [a.campus_site_id])
      : await one(`SELECT * FROM campus_boundary WHERE id = $1 AND campus_site_id = $2`, [w, a.campus_site_id]);
    if (!other) throw NotFound(w === 'active' ? 'This campus has no confirmed boundary to compare with' : 'No such boundary on this campus');
    if (other.id === a.id) throw BadRequest('Choose a different outline to compare with');
    const cmp = comparePolygons(a.polygon, other.polygon);
    /* The consequence that matters: which recorded locations change sides. */
    const nodes = (await q(`SELECT id, name, lat, lng, deliverable FROM campus_node
                             WHERE campus_site_id = $1 AND active AND lat IS NOT NULL`, [a.campus_site_id])).rows;
    const changes = nodes.map((n) => ({ id: n.id, name: n.name, deliverable: n.deliverable,
      inA: campus.pointInPolygon(Number(n.lat), Number(n.lng), a.polygon),
      inB: campus.pointInPolygon(Number(n.lat), Number(n.lng), other.polygon) })).filter((n) => n.inA !== n.inB);
    return { a: { id: a.id, name: a.name, status: a.status, polygon: a.polygon },
             b: { id: other.id, name: other.name, status: other.status, polygon: other.polygon },
             ...cmp, locationsThatChangeSides: changes };
  });
}

function compareAll(polygon, o) {
  return [o.active, ...o.proposed].filter(Boolean).map((b) => {
    const cmp = comparePolygons(polygon, b.polygon);
    return { withId: b.id, withName: b.name, withStatus: b.status, areaM2: cmp.areaM2, overlapPct: cmp.overlapPct,
             maxDeviationM: cmp.maxDeviationM, newVerticesOutsideIt: cmp.verticesOfAOutsideB.length,
             itsVerticesOutsideNew: cmp.verticesOfBOutsideA.length };
  });
}
