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
import { BadRequest } from '../auth/rbac.js';

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
  const a = await normaliseAddress(input, campusId);
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
