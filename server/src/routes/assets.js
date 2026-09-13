/* ==========================================================================
   QUAD — IMAGE UPLOAD AND DELIVERY

   Two classes of image with deliberately different access rules:

     food/vendor photos — readable by anyone who can see the menu
     ID card images     — never public, never presigned; they stream through
                          the server behind an authorization check, and every
                          view is written to the audit log

   Validation happens on the received bytes: magic number, size and decoded
   dimensions. A filename extension is not evidence of anything.
   ========================================================================== */
import { authorize, can, BadRequest, NotFound, Forbidden } from '../auth/rbac.js';
import { putImage, getImage, removeImage } from '../services/storage.js';
import { STORAGE } from '../config.js';
import { one } from '../db/index.js';
import { audit } from '../audit.js';

const PUBLIC_KINDS = ['food_photo', 'vendor_photo'];

export default async function assetRoutes(app) {
  app.post('/assets', async (req) => {
    if (!req.actor) throw Forbidden('Sign in required');

    let kind = 'food_photo';
    let buf = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') buf = await part.toBuffer();
      else if (part.fieldname === 'kind') kind = String(part.value);
    }
    if (!buf) throw BadRequest('No image received');
    if (!['food_photo', 'vendor_photo'].includes(kind)) {
      throw BadRequest('Unsupported image kind',
        'ID card images are uploaded through /verification/submit, not here.');
    }
    /* Only someone who can edit a menu may add a menu photo. */
    if (!req.actor.vendorIds.length && !can(req.actor, 'menu.photo')) {
      throw Forbidden('Only cafeteria staff and administrators can upload menu photos');
    }

    const asset = await putImage(buf, { ownerId: req.actor.id, kind });
    await audit(req, { action: 'asset.upload', resource: 'asset', resourceId: asset.id,
                       outcome: 'ok', detail: { kind, bytes: asset.bytes, mime: asset.mime } });
    return { id: asset.id, mime: asset.mime, width: asset.width, height: asset.height,
             bytes: asset.bytes };
  });

  /* Public-ish read for menu photography. Still not a bucket URL: the
     server decides, so a kind can be reclassified without re-uploading. */
  app.get('/assets/:id', async (req, reply) => {
    const a = await one(`SELECT * FROM asset WHERE id = $1`, [req.params.id]);
    if (!a) throw NotFound('No such image');
    if (!PUBLIC_KINDS.includes(a.kind)) {
      throw Forbidden('That image is not public',
        'ID documents are only available to reviewing administrators.');
    }
    const got = await getImage(a.id);
    if (!got) throw NotFound('No such image');
    reply.header('Cache-Control', 'public, max-age=86400, immutable');
    if (got.url) return reply.redirect(got.url);
    return reply.type(got.asset.mime).send(got.bytes);
  });

  app.delete('/assets/:id', async (req) => {
    const a = await one(`SELECT * FROM asset WHERE id = $1`, [req.params.id]);
    if (!a) throw NotFound('No such image');
    /* A photo belongs to whoever can edit the row that points at it. */
    const item = await one(`SELECT vendor_id FROM menu_item WHERE photo_asset = $1`, [a.id]);
    const vend = await one(`SELECT id FROM vendor WHERE photo_asset = $1`, [a.id]);
    const vendorId = item?.vendor_id || vend?.id;
    if (vendorId) authorize(req.actor, 'menu.photo', { vendorId });
    else if (a.owner_id !== req.actor.id) authorize(req.actor, 'menu.photo', {});

    await removeImage(a.id);
    await audit(req, { action: 'asset.delete', resource: 'asset', resourceId: a.id, outcome: 'ok' });
    return { ok: true };
  });

  app.get('/assets/limits', async () => ({
    maxBytes: STORAGE.maxBytes,
    allowedMime: STORAGE.allowedMime,
    provider: STORAGE.provider,
    productionReady: STORAGE.productionReady,
    note: STORAGE.productionReady ? null
      : 'Images are being written to local disk. Configure STORAGE_PROVIDER=s3 for production.',
  }));
}
