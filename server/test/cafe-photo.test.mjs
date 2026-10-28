/* ==========================================================================
   CAFÉ PHOTOS (PATCH /vendors/:id { photoAsset })

   * The café's owner sets and removes its photo; another café's owner
     cannot, and cannot point their café at someone else's upload.
   * Only an uploaded vendor_photo is accepted, never a dish photo or an ID.
   * A replaced photo is deleted from storage; the public café list carries
     the photo id the student site and Campus Control both show.
   Synthetic accounts only.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { startDb, stopDb, truncateAll, makeUser, makeVendor } from './helpers/db.mjs';
import { makeApp, client, sessionFor } from './helpers/api.mjs';

let app, pool;
let nth = 0;
const phone = () => `+9196800${String(10000 + nth++).slice(-5)}`;

before(async () => {
  await startDb();
  Object.assign(process.env, { COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long', PLATFORM_OWNER_EMAIL: 'owner.cafe@stu.upes.ac.in' });
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(() => truncateAll(pool));

function png(w, h) {
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x7f); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
async function upload(token, kind) {
  const b = '----cafe' + Date.now() + Math.random();
  const payload = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`),
    png(640, 360), Buffer.from(`\r\n--${b}--\r\n`)]);
  const r = await app.inject({ method: 'POST', url: '/assets', payload,
    headers: { origin: 'http://localhost:3000', cookie: `quad_session=${token}`, 'content-type': `multipart/form-data; boundary=${b}` } });
  return JSON.parse(r.body);
}

test('a café owner sets, replaces and removes their own café photo, and nobody else can', async () => {
  const a = await makeVendor(pool, { name: 'Tulips', slug: 'tulips' });
  const b = await makeVendor(pool, { name: 'Chai Garam', slug: 'chai-garam' });
  const ownerA = await makeUser(pool, { phone: phone(), name: 'Owner A', roles: ['vendor_owner'], vendorId: a.id });
  const ownerB = await makeUser(pool, { phone: phone(), name: 'Owner B', roles: ['vendor_owner'], vendorId: b.id });
  const tA = await sessionFor(pool, ownerA.id), tB = await sessionFor(pool, ownerB.id);
  const cA = client(app, tA), cB = client(app, tB);

  const first = await upload(tA, 'vendor_photo');
  assert.equal((await cB.patch(`/vendors/${a.id}`, { photoAsset: first.id })).status, 403, 'not their café');
  assert.equal((await cB.patch(`/vendors/${b.id}`, { photoAsset: first.id })).status, 400, 'not their upload');
  const dish = await upload(tA, 'food_photo');
  assert.equal((await cA.patch(`/vendors/${a.id}`, { photoAsset: dish.id })).status, 400, 'a dish photo is not a café photo');
  assert.equal((await cA.patch(`/vendors/${a.id}`, { photoAsset: 'nope' })).status, 400);

  assert.equal((await cA.patch(`/vendors/${a.id}`, { photoAsset: first.id })).status, 200);
  const listed = (await client(app).get('/vendors')).body.vendors.find((v) => v.id === a.id);
  assert.equal(listed.photo_asset, first.id, 'the public list carries it');

  const second = await upload(tA, 'vendor_photo');
  assert.equal((await cA.patch(`/vendors/${a.id}`, { photoAsset: second.id })).status, 200);
  assert.equal((await pool.query(`SELECT 1 FROM asset WHERE id = $1`, [first.id])).rowCount, 0, 'the replaced photo is deleted');
  assert.equal((await cA.patch(`/vendors/${a.id}`, { photoAsset: null })).status, 200);
  assert.equal((await pool.query(`SELECT photo_asset FROM vendor WHERE id = $1`, [a.id])).rows[0].photo_asset, null);
  assert.equal((await pool.query(`SELECT 1 FROM asset WHERE id = $1`, [second.id])).rowCount, 0, 'the removed photo is deleted');
});
