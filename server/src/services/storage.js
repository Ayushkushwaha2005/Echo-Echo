/* Image intake. Validation is done on the bytes we received, not on the
   filename or the client-declared content type: a .jpg that is really a
   script is rejected by its magic number. */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { STORAGE } from '../config.js';
import { BadRequest, NotFound } from '../auth/rbac.js';
import { q, one } from '../db/index.js';
import { sha256 } from './verification.js';
import * as s3 from './s3.js';

/* Magic numbers, so the real format is known before anything is stored. */
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/* Dimensions read from the header — enough for the quality gate without
   pulling in an image library. */
function dimensions(buf, mime) {
  try {
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/webp' && buf.toString('ascii', 12, 16) === 'VP8X') {
      return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* fall through */ }
  return { width: null, height: null };
}

export async function putImage(buf, { ownerId, kind }) {
  if (!buf?.length) throw BadRequest('No file received');
  if (buf.length > STORAGE.maxBytes) {
    throw BadRequest(`That image is too large`,
      `Maximum ${(STORAGE.maxBytes / 1024 / 1024).toFixed(0)} MB.`);
  }
  const mime = sniff(buf);
  if (!mime || !STORAGE.allowedMime.includes(mime)) {
    throw BadRequest('Unsupported image format', 'Upload a JPEG, PNG or WebP photo.');
  }
  const { width, height } = dimensions(buf, mime);
  const key = `${kind}/${randomUUID()}.${mime.split('/')[1]}`;

  if (STORAGE.provider === 's3') {
    await putS3(key, buf, mime);
  } else {
    const path = join(STORAGE.localDir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buf);
  }

  return one(
    `INSERT INTO asset (owner_id, kind, mime, bytes, width, height, storage_key, sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [ownerId, kind, mime, buf.length, width, height, key, sha256(buf)]);
}

export async function getImage(assetId) {
  const a = await one(`SELECT * FROM asset WHERE id = $1`, [assetId]);
  if (!a) return null;
  if (STORAGE.provider === 's3') return { asset: a, url: await signedS3Url(a.storage_key) };
  return { asset: a, bytes: await readFile(join(STORAGE.localDir, a.storage_key)) };
}

const putS3 = (key, buf, mime) => s3.putObject(key, buf, mime);
const signedS3Url = (key) => s3.presignGet(key, 300);

/* Replace the bytes behind an asset, keeping the row (and therefore every
   reference to it) intact. Used when a shopkeeper swaps a food photo. */
export async function replaceImage(assetId, buf, { ownerId }) {
  const old = await one(`SELECT * FROM asset WHERE id = $1`, [assetId]);
  if (!old) throw NotFound('No such image');
  const fresh = await putImage(buf, { ownerId, kind: old.kind });
  await removeImage(assetId);
  return fresh;
}

/* Archive an asset: delete the bytes, keep nothing dangling. Historical
   orders reference order_item snapshots, not assets, so removing a photo
   cannot corrupt an old order. */
export async function removeImage(assetId) {
  const a = await one(`SELECT * FROM asset WHERE id = $1`, [assetId]);
  if (!a) return false;
  try {
    if (STORAGE.provider === 's3') await s3.deleteObject(a.storage_key);
    else await (await import('node:fs/promises')).unlink(join(STORAGE.localDir, a.storage_key)).catch(() => {});
  } catch { /* the row goes regardless; an orphaned object is swept later */ }
  /* Clear every reference before deleting the row. verification_case has a
     real foreign key to asset, so without this the retention sweep raises
     23503 and no ID image is ever purged — the deletion policy would look
     configured and quietly do nothing.

     The case itself is kept: it is the record of a decision about a person's
     identity, and that history must outlive the document it was based on. */
  await q(`UPDATE menu_item SET photo_asset = NULL WHERE photo_asset = $1`, [assetId]);
  await q(`UPDATE vendor SET photo_asset = NULL WHERE photo_asset = $1`, [assetId]);
  await q(`UPDATE app_user SET partner_photo_asset = NULL WHERE partner_photo_asset = $1`, [assetId]);
  await q(`UPDATE verification_case SET front_asset = NULL WHERE front_asset = $1`, [assetId]);
  await q(`UPDATE verification_case SET back_asset  = NULL WHERE back_asset  = $1`, [assetId]);
  await q(`DELETE FROM asset WHERE id = $1`, [assetId]);
  return true;
}

/* Retention: ID images are deleted once a case has been decided and the
   retention window has passed. Called by the sweeper. */
export async function purgeExpiredIdImages(retentionDays) {
  const { rows } = await q(
    `SELECT a.id FROM asset a
       JOIN verification_case k ON k.front_asset = a.id OR k.back_asset = a.id
      WHERE a.kind IN ('id_front','id_back')
        AND k.state IN ('approved','rejected')
        AND k.decided_at < now() - ($1 || ' days')::interval`, [String(retentionDays)]);
  for (const r of rows) await removeImage(r.id);
  return rows.length;
}
