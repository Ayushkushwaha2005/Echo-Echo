/* ==========================================================================
   QUAD — STUDENT ID VERIFICATION PIPELINE

   The AI is not the authority here and never returns "Valid ✓". The pipeline
   gathers evidence and produces SIGNALS; a human decides. Concretely:

     image quality → OCR → field extraction → consistency checks →
     duplicate/tamper signals → roster cross-check → case created →
     ADMIN REVIEW → approved | rejected | needs_review

   Every stage that has no provider configured records `skipped` with a
   reason, and a skipped stage always pushes the case toward review rather
   than toward approval. A case with a perfect OCR score and a roster match
   still lands in `pending` — automatic approval is not implemented, on
   purpose, because the consequence of a false accept is a stranger holding
   a verified student identity on a payments platform.
   ========================================================================== */
import { createHash } from 'node:crypto';
import { one } from '../db/index.js';
import { OCR, ROSTER } from '../config.js';

/* ---------- 1. image quality ---------------------------------------------
   Cheap structural checks on the bytes we hold. Not a model — a filter that
   stops obviously unusable submissions before a human wastes time on them. */
export function assessQuality(asset) {
  const notes = [];
  let ok = true;
  if (asset.bytes < 40_000) { notes.push('File is very small; the ID may be unreadable.'); ok = false; }
  if (asset.width && asset.height) {
    if (Math.min(asset.width, asset.height) < 480) { notes.push('Resolution below 480px on the short edge.'); ok = false; }
    const ratio = asset.width / asset.height;
    if (ratio < 0.4 || ratio > 2.6) notes.push('Unusual aspect ratio for an ID card; may be cropped.');
  } else {
    notes.push('Image dimensions could not be read.');
  }
  return { ok, notes, bytes: asset.bytes, width: asset.width, height: asset.height };
}

/* ---------- 2. OCR -------------------------------------------------------- */
export async function runOcr(imageBytes) {
  if (!OCR.configured) {
    return { status: 'skipped', reason: 'no_ocr_provider',
             note: 'No OCR provider configured. Set OCR_PROVIDER and its credentials to enable text extraction.' };
  }
  if (OCR.provider === 'gcv') {
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${OCR.gcv.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{ image: { content: imageBytes.toString('base64') },
                     features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }],
      }),
    });
    if (!res.ok) return { status: 'error', reason: `gcv_${res.status}` };
    const json = await res.json();
    const text = json.responses?.[0]?.fullTextAnnotation?.text || '';
    return { status: 'ok', provider: 'gcv', text };
  }
  return { status: 'skipped', reason: 'unknown_provider' };
}

/* ---------- 3. field extraction ------------------------------------------
   Deliberately conservative. A field we are not confident about comes back
   null, which is a weaker claim than a wrong value.                        */
export function extractFields(text) {
  if (!text) return { name: null, roll: null, college: null, validUntil: null };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const find = (re) => { for (const l of lines) { const m = l.match(re); if (m) return m[1].trim(); } return null; };
  return {
    name: find(/^(?:name|student\s*name)\s*[:\-]\s*(.+)$/i),
    roll: find(/^(?:roll|enrol(?:l)?ment|sap|student)\s*(?:no\.?|number|id)\s*[:\-]\s*([A-Za-z0-9\/\-]+)$/i)
       || find(/\b([0-9]{2}[A-Z]{2,4}[0-9]{3,6})\b/),
    college: find(/\b(university of petroleum and energy studies|upes)\b/i),
    validUntil: find(/valid\s*(?:up\s*to|till|until)\s*[:\-]?\s*(.+)$/i),
  };
}

/* ---------- 4/5. consistency, duplicate and tamper signals ---------------- */
export async function computeSignals({ userId, fields, claimed, quality, assets }) {
  const signals = [];
  const push = (level, code, message) => signals.push({ level, code, message });

  if (!quality.ok) push('warn', 'low_quality', 'Image quality checks failed.');
  quality.notes.forEach((n) => push('info', 'quality_note', n));

  if (fields.roll && claimed.roll) {
    const norm = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm(fields.roll) !== norm(claimed.roll)) {
      push('high', 'roll_mismatch',
        `The roll number typed (${claimed.roll}) does not match the one read from the card (${fields.roll}).`);
    } else push('good', 'roll_match', 'Typed roll number matches the card.');
  } else if (!fields.roll) {
    push('warn', 'roll_not_read', 'No roll number could be read from the card.');
  }

  if (fields.name && claimed.name) {
    const a = fields.name.toLowerCase().replace(/\s+/g, ' ');
    const b = claimed.name.toLowerCase().replace(/\s+/g, ' ');
    if (!a.includes(b) && !b.includes(a)) push('warn', 'name_mismatch', 'Typed name differs from the card.');
  }

  /* Byte-identical image already submitted by another account: the strongest
     automatic fraud signal we can produce without a face model. */
  for (const a of assets) {
    const dup = await one(
      `SELECT owner_id FROM asset WHERE sha256 = $1 AND owner_id <> $2 LIMIT 1`, [a.sha256, userId]);
    if (dup) push('high', 'duplicate_image', 'This exact image has been submitted by another account.');
  }
  const priorRoll = claimed.roll && await one(
    `SELECT user_id FROM verification_case
      WHERE claimed_roll = $1 AND user_id <> $2 AND state = 'approved' LIMIT 1`,
    [claimed.roll, userId]);
  if (priorRoll) push('high', 'roll_already_approved', 'This roll number is already approved on another account.');

  const attempts = await one(
    `SELECT count(*)::int AS n FROM verification_case WHERE user_id = $1`, [userId]);
  if (attempts.n >= 3) push('warn', 'repeat_attempts', `${attempts.n} previous submissions from this account.`);

  return signals;
}

/* ---------- 6. roster cross-check ---------------------------------------- */
export async function rosterCheck(fields, claimed) {
  if (!ROSTER.configured) {
    return { status: 'skipped', reason: 'no_roster_source',
             note: 'No college roster or SSO integration is connected. The strongest ' +
                   'verification path is unavailable, so this case requires manual review.' };
  }
  const roll = fields.roll || claimed.roll;
  if (!roll) return { status: 'inconclusive', reason: 'no_roll_number' };

  if (ROSTER.provider === 'api') {
    const res = await fetch(`${ROSTER.apiUrl}?roll=${encodeURIComponent(roll)}`, {
      headers: { Authorization: `Bearer ${ROSTER.apiKey}` },
    });
    if (!res.ok) return { status: 'error', reason: `roster_${res.status}` };
    const rec = await res.json();
    if (!rec || !rec.roll) return { status: 'no_match', roll };
    const nameOk = rec.name && claimed.name &&
      rec.name.toLowerCase().replace(/\s+/g, ' ') === claimed.name.toLowerCase().replace(/\s+/g, ' ');
    return { status: 'match', roll, record: rec, nameMatches: !!nameOk };
  }
  if (ROSTER.provider === 'csv') {
    const { readFile } = await import('node:fs/promises');
    const csv = await readFile(ROSTER.csvPath, 'utf8');
    const rows = csv.split('\n').slice(1).map((l) => l.split(','));
    const hit = rows.find((r) => (r[0] || '').trim().toUpperCase() === roll.toUpperCase());
    return hit ? { status: 'match', roll, record: { roll: hit[0], name: hit[1], programme: hit[2] } }
               : { status: 'no_match', roll };
  }
  return { status: 'skipped', reason: 'unknown_provider' };
}

/* ---------- orchestration ------------------------------------------------
   Returns a case state. Note what is NOT here: an 'approved' branch. Every
   path ends in pending or needs_review, and a human moves it from there. */
export function triage(signals, roster) {
  const high = signals.filter((s) => s.level === 'high');
  if (high.length) {
    return { state: 'needs_review',
             reason: `Flagged: ${high.map((s) => s.code).join(', ')}. An administrator must look at this.` };
  }
  if (roster.status === 'no_match') {
    return { state: 'needs_review', reason: 'The roll number was not found in the college roster.' };
  }
  return { state: 'pending',
           reason: 'Submitted for review. A decision is expected within 24 hours.' };
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
