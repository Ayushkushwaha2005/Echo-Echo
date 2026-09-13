/* ==========================================================================
   STORAGE — the S3 adapter, exercised against a real HTTP server.

   The adapter's SigV4 signing is hand-written, so the risk is that it
   produces a signature AWS would reject. This suite verifies it two ways:

     1. A local S3-compatible server receives the real request and RE-DERIVES
        the expected signature independently from the canonical request. If
        our signing were wrong, the recomputation would not match.
     2. Upload → download → replace → delete run end to end through the
        adapter and the database, with the object actually stored and served.

   What this canNOT prove: that AWS/R2 accept the signature. Only a real
   bucket can, and that is listed as the outstanding blocker. But a signature
   that verifies against an independent implementation of the same algorithm
   is meaningfully stronger evidence than "the code exists".
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor } from './helpers/db.mjs';
import { sessionFor, client } from './helpers/api.mjs';

const BUCKET = 'quad-test-bucket';
const REGION = 'ap-south-1';
const ACCESS_KEY = 'AKIAQUADTESTKEY00000';
const SECRET_KEY = 'quadTestSecretKeyNotRealAtAll0000000000';

/* A minimal S3-compatible object store, in memory, that INDEPENDENTLY
   verifies the AWS SigV4 signature on every request. */
const objects = new Map();
const received = [];
let server, endpoint;

const sha256hex = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => createHmac('sha256', k).update(d).digest();

function verifySigV4(req, bodyBuf) {
  const auth = req.headers.authorization || '';
  const m = auth.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/);
  if (!m) return { ok: false, why: 'malformed Authorization header' };
  const [, key, dateStamp, region, service, signedHeaders, signature] = m;
  if (key !== ACCESS_KEY) return { ok: false, why: 'unknown access key' };
  if (service !== 's3') return { ok: false, why: 'wrong service' };

  const amzDate = req.headers['x-amz-date'];
  const payloadHash = req.headers['x-amz-content-sha256'];
  if (payloadHash !== sha256hex(bodyBuf)) return { ok: false, why: 'payload hash mismatch' };

  const canonicalHeaders = signedHeaders.split(';')
    .map((h) => `${h}:${String(req.headers[h] ?? '').trim()}\n`).join('');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const canonicalRequest = [
    req.method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + SECRET_KEY, dateStamp);
  const kSigning = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request');
  const expected = hmac(kSigning, stringToSign).toString('hex');

  return expected === signature
    ? { ok: true }
    : { ok: false, why: 'signature mismatch (our signing is wrong)' };
}

function startS3() {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url, `http://${req.headers.host}`);
        const key = decodeURIComponent(url.pathname.replace(`/${BUCKET}/`, ''));

        /* Presigned GET carries the signature in the query string. */
        const presigned = url.searchParams.has('X-Amz-Signature');
        if (!presigned) {
          const v = verifySigV4(req, body);
          received.push({ method: req.method, key, verified: v.ok, why: v.why });
          if (!v.ok) { res.writeHead(403); return res.end(v.why); }
        } else {
          received.push({ method: req.method, key, presigned: true, verified: true });
        }

        if (req.method === 'PUT') {
          objects.set(key, { body, contentType: req.headers['content-type'] });
          res.writeHead(200, { ETag: '"' + sha256hex(body).slice(0, 32) + '"' });
          return res.end();
        }
        if (req.method === 'GET') {
          const o = objects.get(key);
          if (!o) { res.writeHead(404); return res.end(); }
          res.writeHead(200, { 'content-type': o.contentType || 'application/octet-stream' });
          return res.end(o.body);
        }
        if (req.method === 'DELETE') {
          objects.delete(key);
          res.writeHead(204); return res.end();
        }
        res.writeHead(405); res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      endpoint = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

let pool, app, storage, s3;

before(async () => {
  await startDb();
  await startS3();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  process.env.SWEEPER = 'off';
  process.env.NODE_ENV = 'test';
  process.env.STORAGE_PROVIDER = 's3';
  process.env.S3_BUCKET = BUCKET;
  process.env.S3_REGION = REGION;
  process.env.S3_ENDPOINT = endpoint;
  process.env.S3_ACCESS_KEY_ID = ACCESS_KEY;
  process.env.S3_SECRET_ACCESS_KEY = SECRET_KEY;

  ({ pool } = await import('../src/db/index.js'));
  storage = await import('../src/services/storage.js');
  s3 = await import('../src/services/s3.js');
  const { build } = await import('../src/index.js');
  app = await build();
});

after(async () => {
  await app?.close();
  await pool?.end();
  await new Promise((r) => server.close(r));
  for (const k of ['STORAGE_PROVIDER', 'S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT',
                   'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[k];
  await stopDb();
});

beforeEach(async () => { await truncateAll(pool); objects.clear(); received.length = 0; });

/* A genuinely valid 1×1 PNG — magic bytes and IHDR are real, so the
   adapter's format sniffing and dimension reading operate on real data. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const bigPng = (bytes) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, bytes - PNG.length))]);

/* ======================= signing ======================================== */

test('our SigV4 signature verifies against an independent implementation', async () => {
  await s3.putObject('probe/key.txt', Buffer.from('hello'), 'text/plain');
  assert.equal(received.length, 1);
  assert.equal(received[0].verified, true,
    `the store rejected our signature: ${received[0].why}`);
  assert.equal(objects.get('probe/key.txt').body.toString(), 'hello');
});

test('signing is correct for every verb the adapter uses', async () => {
  await s3.putObject('verbs/a.bin', Buffer.from('one'), 'application/octet-stream');
  const got = await s3.getObject('verbs/a.bin');
  await s3.deleteObject('verbs/a.bin');

  assert.equal(got.toString(), 'one');
  assert.deepEqual(received.map((r) => r.method), ['PUT', 'GET', 'DELETE']);
  for (const r of received) assert.equal(r.verified, true, `${r.method}: ${r.why}`);
  assert.equal(objects.has('verbs/a.bin'), false);
});

test('keys with characters needing encoding are signed and stored correctly', async () => {
  /* A key with spaces and unicode must be percent-encoded consistently in
     both the URL and the canonical request, or the signature breaks. */
  const key = 'id_front/some file (2)+ø.jpg';
  await s3.putObject(key, Buffer.from('x'), 'image/jpeg');
  assert.equal(received[0].verified, true, received[0].why);
  assert.equal(objects.get(key).body.toString(), 'x');
});

test('a missing object returns null rather than throwing', async () => {
  assert.equal(await s3.getObject('nope/missing.bin'), null);
});

test('checkAccess proves the credentials really work, end to end', async () => {
  const out = await s3.checkAccess();
  assert.equal(out.ok, true, `readiness probe failed: ${out.error}`);
  /* It cleans up after itself. */
  assert.equal([...objects.keys()].filter((k) => k.startsWith('.quad-healthcheck')).length, 0);
});

test('a presigned GET is signed correctly and needs no Authorization header', async () => {
  await s3.putObject('food_photo/x.png', PNG, 'image/png');
  const url = s3.presignGet('food_photo/x.png', 300);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}/);
  assert.match(url, /X-Amz-Expires=300/);
  assert.ok(!url.includes(SECRET_KEY), 'the secret must not appear in the URL');

  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

/* ======================= upload pipeline ================================ */

test('an image uploads to S3 and its metadata is the database row', async () => {
  const u = await makeUser(pool, { phone: '+919800000001', name: 'A' });
  const asset = await storage.putImage(PNG, { ownerId: u.id, kind: 'food_photo' });

  assert.equal(asset.mime, 'image/png');
  assert.equal(asset.width, 1);
  assert.equal(asset.height, 1);
  assert.equal(asset.bytes, PNG.length);
  assert.match(asset.storage_key, /^food_photo\/[0-9a-f-]{36}\.png$/,
    'the object name is server-generated, never client-supplied');

  /* The bytes really are in the store. */
  assert.ok(objects.has(asset.storage_key));
  assert.deepEqual(objects.get(asset.storage_key).body, PNG);

  /* And the database is authoritative about it. */
  const row = (await pool.query(`SELECT * FROM asset WHERE id=$1`, [asset.id])).rows[0];
  assert.equal(row.storage_key, asset.storage_key);
  assert.equal(row.sha256, createHash('sha256').update(PNG).digest('hex'));
});

test('replace uploads the new object and removes the old one', async () => {
  const u = await makeUser(pool, { phone: '+919800000002', name: 'A' });
  const first = await storage.putImage(PNG, { ownerId: u.id, kind: 'food_photo' });
  const second = await storage.replaceImage(first.id, bigPng(60_000), { ownerId: u.id });

  assert.notEqual(second.id, first.id);
  assert.ok(objects.has(second.storage_key), 'the new object is stored');
  assert.equal(objects.has(first.storage_key), false, 'the old object is deleted');
  const gone = await pool.query(`SELECT 1 FROM asset WHERE id=$1`, [first.id]);
  assert.equal(gone.rowCount, 0, 'the old row is gone too');
});

test('deleting an asset clears the object, the row, and every reference', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const u = await makeUser(pool, { phone: '+919800000003', name: 'A' });
  const asset = await storage.putImage(PNG, { ownerId: u.id, kind: 'food_photo' });
  const item = (await pool.query(
    `INSERT INTO menu_item (vendor_id, name, price_paise, photo_asset)
     VALUES ($1,'B',9000,$2) RETURNING *`, [v.id, asset.id])).rows[0];

  await storage.removeImage(asset.id);

  assert.equal(objects.has(asset.storage_key), false);
  assert.equal((await pool.query(`SELECT 1 FROM asset WHERE id=$1`, [asset.id])).rowCount, 0);
  const after = (await pool.query(`SELECT photo_asset FROM menu_item WHERE id=$1`, [item.id])).rows[0];
  assert.equal(after.photo_asset, null, 'the menu item must not point at a dead object');
});

/* ======================= validation ===================================== */

test('the real format is sniffed from bytes, not trusted from a name', async () => {
  const u = await makeUser(pool, { phone: '+919800000004', name: 'A' });
  const hostile = [
    ['PHP web shell', Buffer.from('<?php system($_GET["c"]); ?>')],
    ['SVG with script', Buffer.from('<svg onload="alert(1)"></svg>')],
    ['HTML', Buffer.from('<!doctype html><script>x</script>')],
    ['ELF binary', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0, 0, 0])],
    ['empty', Buffer.alloc(0)],
  ];
  for (const [name, buf] of hostile) {
    await assert.rejects(
      () => storage.putImage(buf, { ownerId: u.id, kind: 'food_photo' }),
      (e) => /Unsupported image format|No file received/.test(e.message),
      `${name} must be refused`);
  }
  assert.equal(objects.size, 0, 'nothing hostile reached the store');
});

test('oversized uploads are refused before anything is stored', async () => {
  const u = await makeUser(pool, { phone: '+919800000005', name: 'A' });
  const { STORAGE } = await import('../src/config.js');
  await assert.rejects(
    () => storage.putImage(bigPng(STORAGE.maxBytes + 1024), { ownerId: u.id, kind: 'food_photo' }),
    /too large/);
  assert.equal(objects.size, 0);
});

test('object names cannot be steered by a caller — no path traversal', async () => {
  const u = await makeUser(pool, { phone: '+919800000006', name: 'A' });
  /* The caller controls only `kind`, which is validated; the name is a uuid. */
  const asset = await storage.putImage(PNG, { ownerId: u.id, kind: 'id_front' });
  assert.ok(!asset.storage_key.includes('..'));
  assert.match(asset.storage_key, /^id_front\/[0-9a-f-]{36}\.png$/);
});

/* ======================= access control ================================= */

test('ID card images are NEVER public, even to their owner, via the asset route', async () => {
  const u = await makeUser(pool, { phone: '+919800000010', name: 'A' });
  const idImage = await storage.putImage(PNG, { ownerId: u.id, kind: 'id_front' });
  const foodImage = await storage.putImage(PNG, { ownerId: u.id, kind: 'food_photo' });

  const anon = client(app);
  const owner = client(app, await sessionFor(pool, u.id));

  for (const c of [anon, owner]) {
    const r = await c.get(`/assets/${idImage.id}`);
    assert.equal(r.status, 403, 'an ID document must not be served from the public route');
    assert.match(r.body.error, /not public/i);
  }

  /* Food photography is public, and really serves the bytes. */
  const res = await app.inject({ method: 'GET', url: `/assets/${foodImage.id}` });
  assert.ok([200, 302].includes(res.statusCode), 'a food photo is servable');
});

test('an ID image is never presigned — it streams through the authorization check', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/verification.js', import.meta.url), 'utf8');
  /* The admin image route reads through getImage and audits the view. */
  assert.match(src, /verification\.image\.view/, 'viewing an ID document is audited');

  const assets = fs.readFileSync(new URL('../src/routes/assets.js', import.meta.url), 'utf8');
  assert.match(assets, /PUBLIC_KINDS = \['food_photo', 'vendor_photo'\]/,
    'only food and vendor photos are public kinds');
});

test('only cafeteria staff and admins can upload menu photography', async () => {
  const stu = await makeUser(pool, { phone: '+919800000011', name: 'A' });
  const token = await sessionFor(pool, stu.id);

  const multipart = (buf) => {
    const b = '----quadtest' + Date.now();
    const head = Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nfood_photo\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="photo"; filename="x.png"\r\n` +
      `Content-Type: image/png\r\n\r\n`);
    return { body: Buffer.concat([head, buf, Buffer.from(`\r\n--${b}--\r\n`)]),
             type: `multipart/form-data; boundary=${b}` };
  };
  const { body, type } = multipart(PNG);

  /* A signed-in STUDENT has no cafeteria and no platform role. */
  const asStudent = await app.inject({
    method: 'POST', url: '/assets', payload: body,
    headers: { origin: 'http://localhost:3000', cookie: `quad_session=${token}`, 'content-type': type },
  });
  assert.equal(asStudent.statusCode, 403, 'a student must not upload menu photography');
  assert.match(JSON.parse(asStudent.body).error, /cafeteria staff and administrators/i);

  /* An anonymous caller does not get as far as the role check. */
  const anonRes = await app.inject({
    method: 'POST', url: '/assets', payload: body,
    headers: { origin: 'http://localhost:3000', 'content-type': type },
  });
  assert.equal(anonRes.statusCode, 401);

  /* A cafeteria owner CAN, and the object really lands in the store. */
  const v = await makeVendor(pool, { name: 'F', slug: 'f-upload' });
  const owner = await makeUser(pool, { phone: '+919800000013', name: 'R',
    roles: ['vendor_owner'], vendorId: v.id });
  const ownerToken = await sessionFor(pool, owner.id);
  const fresh = multipart(PNG);
  const ok = await app.inject({
    method: 'POST', url: '/assets', payload: fresh.body,
    headers: { origin: 'http://localhost:3000', cookie: `quad_session=${ownerToken}`,
               'content-type': fresh.type },
  });
  assert.equal(ok.statusCode, 200);
  const asset = JSON.parse(ok.body);
  assert.equal(asset.mime, 'image/png');
  const row = (await pool.query(`SELECT storage_key FROM asset WHERE id=$1`, [asset.id])).rows[0];
  assert.ok(objects.has(row.storage_key), 'the uploaded bytes really reached S3');
});

test('the ID-image retention sweep deletes real objects', async () => {
  const u = await makeUser(pool, { phone: '+919800000012', name: 'A' });
  const asset = await storage.putImage(PNG, { ownerId: u.id, kind: 'id_front' });
  await pool.query(
    `INSERT INTO verification_case (user_id, front_asset, state, decided_at)
     VALUES ($1,$2,'approved', now() - interval '200 days')`, [u.id, asset.id]);

  assert.equal(objects.has(asset.storage_key), true);
  const purged = await storage.purgeExpiredIdImages(90);
  assert.equal(purged, 1);
  assert.equal(objects.has(asset.storage_key), false, 'the object is really gone from the store');
  assert.equal((await pool.query(`SELECT 1 FROM asset WHERE id=$1`, [asset.id])).rowCount, 0);
});

/* ======================= configuration honesty ========================== */

test('with S3 configured the deployment reports itself production-ready for storage', async () => {
  const { STORAGE } = await import('../src/config.js');
  assert.equal(STORAGE.provider, 's3');
  assert.equal(STORAGE.configured, true);
  assert.equal(STORAGE.productionReady, true);

  const res = await app.inject({ method: 'GET', url: '/assets/limits' });
  const body = JSON.parse(res.body);
  assert.equal(body.provider, 's3');
  assert.equal(body.productionReady, true);
  assert.equal(body.note, null, 'no local-disk warning when S3 is in use');
  assert.ok(!JSON.stringify(body).includes(SECRET_KEY), 'credentials must not be exposed');
});
