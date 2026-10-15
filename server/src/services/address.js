/* ==========================================================================
   ECHO ECHO - THE STUDENT'S CAMPUS ADDRESS

   How a student DESCRIBES where they are: block, floor, room, a landmark,
   instructions for the partner. It is text they typed, validated for shape
   and length and nothing else. It is never a coordinate and never evidence
   of being on campus: where a delivery may go is decided only by
   destination_id (a confirmed campus_node inside the active boundary), and
   whether the student is on campus only by the live-location check.

   The block is either one of the campus's known blocks (campus_block, each
   with the evidence that it exists) or, when theirs is not listed, a short
   label they type.
   ========================================================================== */
import { q, one } from '../db/index.js';
import { BadRequest, NotFound, Conflict, Forbidden } from '../auth/rbac.js';
import { boundary, pointInPolygon } from './campus.js';

const clean = (v, max) => {
  const t = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t.length > max) throw BadRequest('That is too long', `Keep it under ${max} characters.`);
  /* Printable text only: no markup, no control characters. */
  if (/[<>\u0000-\u001f]/.test(t)) throw BadRequest('Use plain text', 'Letters, numbers and simple punctuation only.');
  return t;
};

export async function blocksFor(campusId) {
  if (!campusId) return [];
  const { rows } = await q(
    `SELECT id, number, label, evidence, campus_node_id IS NOT NULL AS located
       FROM campus_block WHERE campus_site_id = $1 AND active ORDER BY number`, [campusId]);
  return rows;
}

/* Validates an address for a campus and returns it normalised. Throws on
   anything that does not fit; returns null when every field is empty. */
export async function normaliseAddress(input, campusId) {
  const b = input || {};
  let block = null;
  if (b.blockId) {
    block = await one(`SELECT id, label FROM campus_block WHERE id = $1 AND campus_site_id = $2 AND active`,
      [b.blockId, campusId]).catch(() => null);
    if (!block) throw BadRequest('Choose a block from the list', 'Or pick "My block is not listed" and type it.');
  }
  const blockText = block ? null : clean(b.blockText, 40);
  const out = {
    /* What the student calls the spot: "Ground", "Sitting area", "Library". */
    label: clean(b.label, 40),
    blockId: block?.id || null,
    block: block?.label || blockText || null,
    blockListed: !!block,
    floor: clean(b.floor, 20),
    room: clean(b.room, 20),
    landmark: clean(b.landmark, 120),
    instructions: clean(b.instructions, 300),
  };
  return Object.entries(out).some(([k, v]) => k !== 'blockListed' && v) ? out : null;
}

const shape = (r) => r && ({
  campusId: r.campus_site_id, campus: r.campus_name,
  blockId: r.block_id, block: r.block_label || r.block_text || null, blockListed: !!r.block_id,
  floor: r.floor, room: r.room, landmark: r.landmark, instructions: r.instructions,
  updatedAt: r.updated_at,
});

export async function addressOf(userId) {
  return shape(await one(
    `SELECT a.*, b.label AS block_label, c.name AS campus_name
       FROM student_address a
       JOIN campus_site c ON c.id = a.campus_site_id
       LEFT JOIN campus_block b ON b.id = a.block_id
      WHERE a.user_id = $1`, [userId]));
}

export async function saveAddress(userId, campusId, input) {
  /* The one-row saved address has no name of its own; places do. */
  const { label, ...rest } = input || {};
  const a = await normaliseAddress(rest, campusId);
  if (!a) throw BadRequest('Add at least one detail', 'For example your block and room.');
  await q(
    `INSERT INTO student_address (user_id, campus_site_id, block_id, block_text, floor, room, landmark, instructions, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (user_id) DO UPDATE SET campus_site_id = EXCLUDED.campus_site_id, block_id = EXCLUDED.block_id,
       block_text = EXCLUDED.block_text, floor = EXCLUDED.floor, room = EXCLUDED.room,
       landmark = EXCLUDED.landmark, instructions = EXCLUDED.instructions, updated_at = now()`,
    [userId, campusId, a.blockId, a.blockListed ? null : a.block, a.floor, a.room, a.landmark, a.instructions]);
  return addressOf(userId);
}

/* ==========================================================================
   SAVED PLACES (migration 031)

   A place is a map pin plus the words that help a partner find it. The pin
   is the location and is checked against the campus's ACTIVE boundary here,
   when it is saved; the order checks it again, because an outline can be
   redrawn after a place was saved. Coordinates are taken only as JSON
   numbers - "30.41" as a string is not a coordinate - and stored at 6 dp.
   Nothing is required beyond the pin and a short name: no floor, no room.
   ========================================================================== */
export const MAX_PLACES = 8;

const placeShape = (r) => r && ({
  id: r.id, label: r.label, lat: Number(r.lat), lng: Number(r.lng),
  landmark: r.landmark, instructions: r.instructions,
  blockId: r.block_id, block: r.block_label || r.block_text || null, blockListed: !!r.block_id,
  floor: r.floor, room: r.room, updatedAt: r.updated_at, lastUsedAt: r.last_used_at,
});

async function insidePin(input, campusId) {
  const lat = typeof input?.lat === 'number' ? input.lat : NaN;
  const lng = typeof input?.lng === 'number' ? input.lng : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw BadRequest('Put a pin on the map', 'A saved place needs its spot on the campus map.');
  }
  const b = await boundary(campusId);
  if (!b) {
    throw Forbidden('Campus delivery area is currently unavailable.',
      'Places can be saved once the campus delivery area is confirmed.');
  }
  if (!pointInPolygon(lat, lng, b.polygon)) {
    throw Forbidden('This spot is outside the campus delivery area.', 'Move the pin inside the campus outline.');
  }
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

async function placeFields(input, campusId) {
  const pin = await insidePin(input, campusId);
  const d = (await normaliseAddress(input, campusId)) || {};
  if (!d.label) throw BadRequest('Name this place', 'For example: Ground, Sitting area, Library.');
  return { ...pin, ...d };
}

export async function placesOf(userId, campusId) {
  const { rows } = await q(
    `SELECT p.*, b.label AS block_label FROM saved_place p LEFT JOIN campus_block b ON b.id = p.block_id
      WHERE p.user_id = $1 AND p.campus_site_id = $2
      ORDER BY p.last_used_at DESC NULLS LAST, p.updated_at DESC`, [userId, campusId]);
  return rows.map(placeShape);
}

async function placeOf(userId, id) {
  const r = await one(
    `SELECT p.*, b.label AS block_label FROM saved_place p LEFT JOIN campus_block b ON b.id = p.block_id
      WHERE p.id = $1 AND p.user_id = $2`, [id, userId]).catch((e) => { if (e.code === '22P02') return null; throw e; });
  if (!r) throw NotFound('No such saved place');
  return placeShape(r);
}

export async function createPlace(userId, campusId, input) {
  const f = await placeFields(input, campusId);
  const n = (await one(`SELECT count(*)::int n FROM saved_place WHERE user_id = $1`, [userId])).n;
  if (n >= MAX_PLACES) throw Conflict(`You can save up to ${MAX_PLACES} places`, 'Remove one you no longer use first.');
  const r = await one(
    `INSERT INTO saved_place (user_id, campus_site_id, label, lat, lng, landmark, instructions, block_id, block_text, floor, room)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [userId, campusId, f.label, f.lat, f.lng, f.landmark, f.instructions, f.blockId,
     f.blockListed ? null : f.block, f.floor, f.room]);
  return placeOf(userId, r.id);
}

export async function updatePlace(userId, campusId, id, input) {
  await placeOf(userId, id);                       // theirs, or 404
  const f = await placeFields(input, campusId);
  await q(
    `UPDATE saved_place SET campus_site_id = $3, label = $4, lat = $5, lng = $6, landmark = $7, instructions = $8,
            block_id = $9, block_text = $10, floor = $11, room = $12, updated_at = now()
      WHERE id = $1 AND user_id = $2`,
    [id, userId, campusId, f.label, f.lat, f.lng, f.landmark, f.instructions, f.blockId,
     f.blockListed ? null : f.block, f.floor, f.room]);
  return placeOf(userId, id);
}

export async function deletePlace(userId, id) {
  await placeOf(userId, id);
  await q(`DELETE FROM saved_place WHERE id = $1 AND user_id = $2`, [id, userId]);
}

export async function touchPlace(userId, id) {
  await q(`UPDATE saved_place SET last_used_at = now() WHERE id = $1 AND user_id = $2`, [id, userId]).catch(() => {});
}
