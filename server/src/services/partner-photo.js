/* ==========================================================================
   QUAD - DELIVERY PARTNER PROFILE PHOTO

   The photo a customer uses to recognise who is arriving with their order.

   What is checked on the bytes, without any paid service:
     · real JPEG or PNG (magic number, not the filename)
     · readable dimensions, at least 320px on the short edge, portrait-ish
       or square framing (a wide banner or a thin strip is refused)
     · enough image detail for its size - a blank, single-colour or
       near-empty image compresses to almost nothing and is refused
     · not byte-identical to any other image on the platform (a food photo,
       a cafeteria photo, or another partner's face)

   What is NOT and cannot be checked here: that the image shows a face, and
   that it is this person's face. That is decided by the administrator who
   approves the partner, who sees this photo on the approval screen. The API
   says so rather than implying an automated identity check exists.
   ========================================================================== */
import { BadRequest, Conflict } from '../auth/rbac.js';
import { one } from '../db/index.js';
import { putImage, removeImage } from './storage.js';
import { sha256 } from './verification.js';

const MIN_EDGE = 320;
const MIN_BYTES = 12_000;
/* Bytes per pixel below which an image is essentially flat. A real
   photograph of a person is far above this at any sane quality; a solid
   colour or a simple logo on a flat background is far below it. */
const MIN_BYTES_PER_PIXEL = 0.04;

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  return null;
}

export function inspectPartnerPhoto(buf, { width, height }) {
  if (!sniff(buf)) throw BadRequest('Upload a JPEG or PNG photo of yourself');
  if (!width || !height) throw BadRequest('That image could not be read', 'Try taking the photo again.');
  if (Math.min(width, height) < MIN_EDGE) {
    throw BadRequest('That photo is too small', `Use a photo at least ${MIN_EDGE}px on its shorter side.`);
  }
  const ratio = width / height;
  if (ratio < 0.5 || ratio > 1.6) {
    throw BadRequest('Use a head-and-shoulders photo', 'The image is cropped too wide or too tall to show a face clearly.');
  }
  if (buf.length < MIN_BYTES || buf.length / (width * height) < MIN_BYTES_PER_PIXEL) {
    throw BadRequest('That image looks blank or like a graphic',
      'Upload a clear, well-lit photo of your face. Logos, blank images and screenshots are not accepted.');
  }
}

/* Replaces the user's partner photo. Refused once the partner is approved:
   the photo is what an administrator approved, and swapping it afterwards
   would defeat the point of identification. */
export async function setPartnerPhoto(userId, buf) {
  const profile = await one(`SELECT status FROM partner_profile WHERE user_id = $1`, [userId]);
  if (profile && ['approved', 'suspended'].includes(profile.status)) {
    throw Conflict('Your photo is locked while you are a delivery partner',
      'Contact campus admin to change it; the new photo is approved like the first.');
  }
  if (!buf?.length) throw BadRequest('No photo received');
  const dup = await one(`SELECT 1 FROM asset WHERE sha256 = $1 AND owner_id IS DISTINCT FROM $2 LIMIT 1`,
    [sha256(buf), userId]);
  if (dup) throw BadRequest('That image is already used on ECHO ECHO', 'Upload a new photo of yourself.');

  /* putImage re-validates format and size and reads dimensions from the
     header; the partner-specific checks run on what it read. */
  const asset = await putImage(buf, { ownerId: userId, kind: 'partner_photo' });
  try {
    inspectPartnerPhoto(buf, asset);
  } catch (e) {
    await removeImage(asset.id);
    throw e;
  }
  const prev = await one(`SELECT partner_photo_asset FROM app_user WHERE id = $1`, [userId]);
  await one(`UPDATE app_user SET partner_photo_asset = $2 WHERE id = $1 RETURNING id`, [userId, asset.id]);
  if (prev?.partner_photo_asset) await removeImage(prev.partner_photo_asset).catch(() => {});
  return asset;
}
