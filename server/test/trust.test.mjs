/* ==========================================================================
   CAMPUS, PROFILE, PARTNER IDENTITY, DELIVERY POLICY, DEPOSIT, REVIEWS

   Real HTTP through the full Fastify stack against real PostgreSQL. Images
   are real PNG bytes generated here - random pixels for a photo, a single
   colour for a blank - so the photo checks run on the same bytes a browser
   would send.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus, campusId, makePartnerReady }
  from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool;
before(async () => {
  await startDb();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const as = async (u) => client(app, await sessionFor(pool, u.id));
let seq = 0;
const phone = () => `+9198${String(70000000 + (seq++)).padStart(8, '0')}`;

/* ---------- a real PNG encoder, enough for tests ------------------------ */
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y); const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const noise = randomBytes(1_000_000);
const photoPng = (w = 400, h = 480, salt = 0) => png(w, h, (x, y) => {
  const i = (x * 7 + y * 13 * w + salt * 31) % (noise.length - 3); return [noise[i], noise[i + 1], noise[i + 2]];
});
const blankPng = (w = 400, h = 480) => png(w, h, () => [240, 240, 240]);

async function upload(c, token, url, field, buf, mime = 'image/png') {
  const boundary = '----echo' + randomBytes(8).toString('hex');
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="me.png"\r\nContent-Type: ${mime}\r\n\r\n`),
    buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const res = await app.inject({ method: 'POST', url, payload,
    headers: { origin: 'http://localhost:3000', cookie: `quad_session=${token}`,
               'content-type': `multipart/form-data; boundary=${boundary}` } });
  return { status: res.statusCode, body: JSON.parse(res.body || 'null') };
}

async function world() {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco-' + seq++ });
  const i = await makeItem(pool, v.id, { name: 'Veg Burger', paise: 9000 });
  const admin = await makeUser(pool, { phone: phone(), name: 'Asha Admin', roles: ['platform_admin'] });
  const admin2 = await makeUser(pool, { phone: phone(), name: 'Ravi Admin', roles: ['platform_admin'] });
  return { n, v, i, admin, admin2, ca: await as(admin), ca2: await as(admin2) };
}

/* A delivery order in a given state, carried by a partner, written directly:
   the payment and handover paths are covered by their own suites. */
async function deliveredOrder(pool, { customer, partner, v, i, n, state = 'delivered' }) {
  const o = (await pool.query(
    /* A delivery order carries the contact number the partner rings; the
       table refuses one without it, the same as the checkout route does. */
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, destination_id, state,
                             subtotal_paise, total_paise, partner_id, delivered_at,
                             delivery_contact_phone)
     VALUES ($1,$2,$3,'delivery',$4,$5,9000,9000,$6, CASE WHEN $5='delivered' THEN now() END,
             coalesce((SELECT contact_phone FROM app_user WHERE id = $2), '+919810000999')) RETURNING *`,
    ['T' + randomBytes(3).toString('hex').toUpperCase(), customer.id, v.id, n.blockB.id, state, partner.id])).rows[0];
  const line = (await pool.query(
    `INSERT INTO order_item (order_id, item_id, name_snapshot, unit_paise_snapshot, qty, line_paise)
     VALUES ($1,$2,'Veg Burger',9000,1,9000) RETURNING *`, [o.id, i.id])).rows[0];
  return { o, line };
}

async function approvedPartner(pool, name = 'Kabir Singh') {
  const p = await makeUser(pool, { phone: phone(), name, roles: ['student', 'delivery_partner'] });
  await makePartnerReady(pool, p.id);
  await pool.query(`INSERT INTO partner_profile (user_id, status, online) VALUES ($1,'approved',true)`, [p.id]);
  return p;
}

/* ======================= 1-2. profile & campus =========================== */

test('profile: server-validated name and mobile; the verified email cannot be edited here', async () => {
  const u = await makeUser(pool, { phone: phone(), name: 'Meera Joshi', campus: null });
  const c = await as(u);
  for (const bad of ['', 'A', '12345', 'Meera<script>', 'x'.repeat(90)]) {
    assert.equal((await c.put('/me/profile', { name: bad })).status, 400, `name ${JSON.stringify(bad)}`);
  }
  for (const bad of ['12345', '9999999999', '5812345678', '+14155552671', 'abcdefghij', '98123456789']) {
    assert.equal((await c.put('/me/profile', { contactPhone: bad })).status, 400, `phone ${bad}`);
  }
  const r = await c.put('/me/profile', { name: '  Meera   Joshi ', contactPhone: '098123 45678' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Meera Joshi');
  assert.equal(r.body.contactPhone, '+919812345678');
  assert.equal((await c.put('/me/profile', { studentEmail: 'someone@stu.upes.ac.in' })).status, 400);
  assert.deepEqual(r.body.missing, ['campus']);
  assert.equal(r.body.complete, false, 'complete is computed, never claimed');
  assert.equal((await c.put('/me/profile', { complete: true })).status, 400);
});

test('campus list: UPES Bidholi available, Kandholi coming soon; a made-up campus id is refused', async () => {
  const c = await as(await makeUser(pool, { phone: phone(), name: 'Nisha Rao', campus: null }));
  const list = (await c.get('/campuses')).body.campuses;
  assert.deepEqual(list.map((x) => [x.collegeName, x.name, x.available]), [
    ['UPES — University of Petroleum and Energy Studies', 'Bidholi Campus', true],
    ['UPES — University of Petroleum and Energy Studies', 'Kandholi Campus', false],
  ]);
  assert.equal(list[1].message, 'Service coming soon for Kandholi Campus.');
  assert.equal((await c.put('/me/profile', { campusId: '00000000-0000-0000-0000-000000000000' })).status, 400);
});

test('an incomplete profile cannot order; completing it through the API unlocks Bidholi ordering', async () => {
  const w = await world();
  const u = await makeUser(pool, { phone: phone(), name: 'Tara Das', campus: null });
  const c = await as(u);
  const body = { vendorId: w.v.id, lines: [{ itemId: w.i.id, qty: 1 }], fulfilment: 'delivery', destinationId: w.n.blockB.id };
  const r1 = await c.post('/orders/draft', body);
  assert.equal(r1.status, 403);
  assert.match(r1.body.detail, /campus/);
  await c.put('/me/profile', { campusId: await campusId(pool, 'upes-bidholi') });
  assert.equal((await c.post('/orders/draft', body)).status, 200);
});

test('Kandholi: selectable, but ordering is refused server-side - from any outlet, through any path', async () => {
  const w = await world();
  const kan = await campusId(pool, 'upes-kandholi');
  const u = await makeUser(pool, { phone: phone(), name: 'Dev Kapoor', campus: 'upes-kandholi' });
  const c = await as(u);
  const body = { vendorId: w.v.id, lines: [{ itemId: w.i.id, qty: 1 }], fulfilment: 'pickup' };
  const r = await c.post('/orders/draft', body);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /not available at Kandholi Campus/);

  /* Even an outlet placed on Kandholi cannot trade while the campus is not in service. */
  const kv = await makeVendor(pool, { name: 'Kandholi Cafe', slug: 'kan-cafe', campus: 'upes-kandholi' });
  const ki = await makeItem(pool, kv.id, { name: 'Tea', paise: 2000 });
  assert.equal((await c.post('/orders/draft', { vendorId: kv.id, lines: [{ itemId: ki.id, qty: 1 }], fulfilment: 'pickup' })).status, 403);

  /* A Bidholi student cannot order from an outlet on another campus either. */
  const b = await as(await makeUser(pool, { phone: phone(), name: 'Ira Sen' }));
  const cross = await b.post('/orders/draft', { vendorId: kv.id, lines: [{ itemId: ki.id, qty: 1 }], fulfilment: 'pickup' });
  assert.equal(cross.status, 403);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM food_order`)).rows[0].n, 0);

  /* Outlets are listed per campus. */
  const listed = (await b.get(`/vendors?campusId=${kan}`)).body.vendors.map((x) => x.name);
  assert.deepEqual(listed, ['Kandholi Cafe']);
});

test('Kandholi: the AI assistant cannot draft an order or offer a delivery point either', async () => {
  const w = await world();
  const u = await makeUser(pool, { phone: phone(), name: 'Dev Kapoor', campus: 'upes-kandholi' });
  const { actorFromToken } = await import('../src/auth/session.js');
  const actor = await actorFromToken(await sessionFor(pool, u.id));
  const { TOOLS } = await import('../src/services/ai-tools.js');
  await assert.rejects(() => TOOLS.create_order_draft(actor,
    { vendor_id: w.v.id, items: [{ item_id: w.i.id, qty: 1 }], fulfilment: 'pickup' }), /not available at Kandholi/);
  assert.deepEqual((await TOOLS.resolve_location(actor, { text: 'block b' })).matches, []);
  assert.deepEqual((await TOOLS.get_campus_locations(actor, {})).locations, []);
  assert.deepEqual((await TOOLS.search_cafeterias(actor, {})).cafeterias, [], 'no Bidholi outlets are offered to a Kandholi student');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM food_order`)).rows[0].n, 0);
});

test('the AI assistant can revise a draft: the old draft is cancelled, never deleted', async () => {
  const w = await world();
  const u = await makeUser(pool, { phone: phone(), name: 'Rhea Nair' });
  const { actorFromToken } = await import('../src/auth/session.js');
  const actor = await actorFromToken(await sessionFor(pool, u.id));
  const { TOOLS } = await import('../src/services/ai-tools.js');
  const first = await TOOLS.create_order_draft(actor, { vendor_id: w.v.id, items: [{ item_id: w.i.id, qty: 1 }], fulfilment: 'pickup' });
  const second = await TOOLS.update_order_draft(actor, { order_id: first.order_id, items: [{ item_id: w.i.id, qty: 2 }] });
  assert.ok(second.order_id && second.order_id !== first.order_id, JSON.stringify(second));
  assert.equal(second.total, '₹180');
  const old = (await pool.query(`SELECT state FROM food_order WHERE id = $1`, [first.order_id])).rows[0];
  assert.equal(old.state, 'cancelled', 'the replaced draft and its frozen financials remain on record');
});

test('campus service status is an admin decision, audited, and not a student one', async () => {
  const w = await world();
  const kan = await campusId(pool, 'upes-kandholi');
  const stu = await as(await makeUser(pool, { phone: phone(), name: 'Om Prakash' }));
  assert.equal((await stu.patch(`/admin/campuses/${kan}`, { serviceStatus: 'active' })).status, 403);
  const r = await w.ca.patch(`/admin/campuses/${kan}`, { serviceStatus: 'paused', statusMessage: 'Paused for exams.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.message, 'Paused for exams.');
  const a = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'campus_site.update'`);
  assert.equal(a.rowCount, 1);
});

/* ======================= 3. partner photo ================================ */

test('partner photo: a real photo passes; blank, tiny, wide, non-image and duplicate uploads are refused', async () => {
  const u = await makeUser(pool, { phone: phone(), name: 'Arjun Mehta' });
  const token = await sessionFor(pool, u.id);
  const c = client(app, token);
  const up = (buf, mime) => upload(c, token, '/partner/photo', 'photo', buf, mime);

  assert.equal((await up(blankPng())).status, 400, 'a blank image');
  assert.equal((await up(photoPng(200, 240))).status, 400, 'too small');
  assert.equal((await up(photoPng(900, 360))).status, 400, 'a banner, not a face');
  assert.equal((await up(Buffer.from('GIF89a' + 'x'.repeat(50000)), 'image/gif')).status, 400, 'not a JPEG/PNG');

  const ok = await up(photoPng());
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.note, /admin confirms/);

  const other = await makeUser(pool, { phone: phone(), name: 'Zoya Khan' });
  const t2 = await sessionFor(pool, other.id);
  const again = await upload(client(app, t2), t2, '/partner/photo', 'photo', photoPng());
  assert.equal(again.status, 400, "someone else's photo cannot be reused");

  /* Not public: the generic asset route refuses it. */
  const asset = (await pool.query(`SELECT partner_photo_asset FROM app_user WHERE id = $1`, [u.id])).rows[0];
  assert.equal((await client(app).get(`/assets/${asset.partner_photo_asset}`)).status, 403);
});

test('applying requires a photo and explicit consent to the current policy; approval requires the deposit', async () => {
  const w = await world();
  const u = await makeUser(pool, { phone: phone(), name: 'Rohan Verma' });
  const token = await sessionFor(pool, u.id);
  const c = client(app, token);
  const policy = (await c.get('/partner/policy')).body.policy;

  assert.equal((await c.post('/partner/apply', { acceptPolicyId: policy.id })).status, 409, 'no photo');
  assert.equal((await upload(c, token, '/partner/photo', 'photo', photoPng(400, 480, 7))).status, 200);
  assert.equal((await c.post('/partner/apply', {})).status, 400, 'no consent');
  assert.equal((await c.post('/partner/apply', { acceptPolicyId: '00000000-0000-0000-0000-000000000000' })).status, 400);

  /* Admin publishes a Rs 500 deposit before this person applies. */
  const pub = await w.ca.put('/admin/partner-deposit-policy',
    { amountPaise: 50000, disputeWindowHours: 72, terms: 'A Rs 500 refundable security deposit held separately from earnings under the ECHO ECHO partner policy.' });
  assert.equal(pub.status, 200);
  assert.equal((await c.post('/partner/apply', { acceptPolicyId: policy.id })).status, 400, 'consent to a superseded policy');
  const applied = await c.post('/partner/apply', { acceptPolicyId: pub.body.id });
  assert.equal(applied.status, 200);
  assert.match(applied.body.message, /Rs 500 security deposit/);

  const blocked = await w.ca.post(`/admin/partners/${u.id}/decide`, { decision: 'approve' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /deposit has not been received/);

  assert.equal((await w.ca.post(`/admin/partners/${u.id}/deposit/receipts`,
    { amountPaise: 50000, method: 'manual_upi', externalReference: '' })).status, 400, 'no reference, no receipt');
  assert.equal((await w.ca.post(`/admin/partners/${u.id}/deposit/receipts`,
    { amountPaise: 50000, method: 'manual_upi', externalReference: 'UPI412345678901' })).status, 200);
  assert.equal((await w.ca.post(`/admin/partners/${u.id}/decide`, { decision: 'approve' })).status, 200);

  /* Once approved, the photo an admin approved cannot be swapped. */
  assert.equal((await upload(c, token, '/partner/photo', 'photo', photoPng(400, 480, 9))).status, 409);
});

test('the customer recognises their partner: first name, photo and rating - never phone, email or surname', async () => {
  const w = await world();
  const p = await approvedPartner(pool, 'Kabir Singh Rathore');
  await pool.query(`UPDATE app_user SET student_email = 'kabir.1@stu.upes.ac.in', student_email_verified_at = now() WHERE id = $1`, [p.id]);
  const cust = await makeUser(pool, { phone: phone(), name: 'Anaya Gupta' });
  const { o } = await deliveredOrder(pool, { customer: cust, partner: p, ...w, state: 'picked_up' });

  const r = await (await as(cust)).get(`/orders/${o.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.partner.firstName, 'Kabir');
  assert.equal(r.body.partner.photoUrl, `/orders/${o.id}/partner-photo`);
  const text = JSON.stringify(r.body);
  for (const leak of [p.phone, 'kabir.1@stu.upes.ac.in', 'Rathore']) {
    assert.ok(!text.includes(leak), `must not expose ${leak}`);
  }
  /* Somebody else's order: no photo. */
  const stranger = await as(await makeUser(pool, { phone: phone(), name: 'Other Person' }));
  assert.equal((await stranger.get(`/orders/${o.id}/partner-photo`)).status, 403);
});

/* ======================= 4. delivery handling policy ===================== */

test('a partner cannot take, cancel, move or complete an order outside the handover path', async () => {
  const w = await world();
  const p = await approvedPartner(pool);
  const p2 = await approvedPartner(pool, 'Second Partner');
  const cust = await makeUser(pool, { phone: phone(), name: 'Anaya Gupta' });
  const { o } = await deliveredOrder(pool, { customer: cust, partner: p, ...w, state: 'assigned' });
  const cp = await as(p);
  const cp2 = await as(p2);

  for (const to of ['cancelled', 'ready', 'picked_up', 'delivered', 'refunded']) {
    const r = await cp.post(`/orders/${o.id}/transition`, { to, note: 'partner trying' });
    assert.ok([403, 409].includes(r.status), `partner -> ${to} refused (got ${r.status})`);
  }
  assert.equal((await cp2.post(`/orders/${o.id}/pickup`, { code: '000000' })).status, 403, "another partner's order");
  assert.ok([400, 409].includes((await cp.post(`/orders/${o.id}/pickup`, { code: '000000' })).status), 'no valid counter code');
  assert.equal((await cp.post(`/orders/${o.id}/handoff`, { code: '000000' })).status, 409, 'cannot deliver before pickup');
  assert.equal((await cp.post('/partner/leave')).status, 409, 'cannot walk away with an order');

  /* One order in a partner's care at a time. */
  const other = await deliveredOrder(pool, { customer: cust, partner: p2, ...w, state: 'ready' });
  await pool.query(`UPDATE food_order SET partner_id = NULL WHERE id = $1`, [other.o.id]);
  const offer = (await pool.query(
    `INSERT INTO delivery_offer (order_id, partner_id, expires_at) VALUES ($1,$2, now() + interval '1 minute') RETURNING id`,
    [other.o.id, p.id])).rows[0];
  const busy = await cp.post(`/partner/offers/${offer.id}/accept`);
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /Finish your current delivery/);

  const row = (await pool.query(`SELECT state, partner_id FROM food_order WHERE id = $1`, [o.id])).rows[0];
  assert.deepEqual(row, { state: 'assigned', partner_id: p.id }, 'the order stays tied to its partner, untouched');
});

test('a suspended or un-verified partner cannot accept an offer made before the change', async () => {
  const w = await world();
  const p = await approvedPartner(pool);
  const cust = await makeUser(pool, { phone: phone(), name: 'Anaya Gupta' });
  const { o } = await deliveredOrder(pool, { customer: cust, partner: p, ...w, state: 'ready' });
  await pool.query(`UPDATE food_order SET partner_id = NULL WHERE id = $1`, [o.id]);
  const offer = async () => (await pool.query(
    `INSERT INTO delivery_offer (order_id, partner_id, expires_at) VALUES ($1,$2, now() + interval '1 minute') RETURNING id`,
    [o.id, p.id])).rows[0].id;
  const cp = await as(p);

  await pool.query(`UPDATE partner_profile SET status = 'suspended' WHERE user_id = $1`, [p.id]);
  assert.equal((await cp.post(`/partner/offers/${await offer()}/accept`)).status, 403);
  await pool.query(`UPDATE partner_profile SET status = 'approved' WHERE user_id = $1`, [p.id]);
  await pool.query(`UPDATE app_user SET student_status = 'suspended' WHERE id = $1`, [p.id]);
  assert.equal((await cp.post(`/partner/offers/${await offer()}/accept`)).status, 403);
  const row = (await pool.query(`SELECT partner_id FROM food_order WHERE id = $1`, [o.id])).rows[0];
  assert.equal(row.partner_id, null, 'the order was not assigned');
});

test('an oversized upload is refused over HTTP with a plain message', async () => {
  const u = await makeUser(pool, { phone: phone(), name: 'Big File' });
  const token = await sessionFor(pool, u.id);
  const r = await upload(client(app, token), token, '/partner/photo', 'photo', Buffer.alloc(9 * 1024 * 1024, 7));
  assert.equal(r.status, 413);
  assert.match(r.body.error, /too large/i);
  assert.ok(!JSON.stringify(r.body).match(/stack|at \w+ \(/), 'no internal detail');
});

test('incident reports: parties only, categories by role, no automatic penalty', async () => {
  const w = await world();
  const p = await approvedPartner(pool);
  const cust = await makeUser(pool, { phone: phone(), name: 'Anaya Gupta' });
  const { o } = await deliveredOrder(pool, { customer: cust, partner: p, ...w, state: 'picked_up' });
  const cc = await as(cust);
  const stranger = await as(await makeUser(pool, { phone: phone(), name: 'Nosy Person' }));

  assert.equal((await stranger.post(`/orders/${o.id}/incidents`, { category: 'missing', description: 'not mine but reporting' })).status, 403);
  assert.equal((await cc.post(`/orders/${o.id}/incidents`, { category: 'partner_not_received', description: 'wrong category for me' })).status, 400);
  const r = await cc.post(`/orders/${o.id}/incidents`, { category: 'not_delivered', description: 'The partner never arrived at Block B.' });
  assert.equal(r.status, 200);
  assert.match(r.body.message, /Nobody is penalised on a report alone/);
  assert.equal((await cc.post(`/orders/${o.id}/incidents`, { category: 'spilled', description: 'second report on the same order' })).status, 409);

  const pr = await (await as(p)).post(`/orders/${o.id}/incidents`, { category: 'partner_not_received', description: 'Counter handed it to someone else.' });
  assert.equal(pr.status, 200, 'the partner can report their side');

  /* A complaint does not touch the partner: no deduction, status unchanged. */
  const pp = (await pool.query(`SELECT status FROM partner_profile WHERE user_id = $1`, [p.id])).rows[0];
  assert.equal(pp.status, 'approved');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM deposit_deduction`)).rows[0].n, 0);
});

/* ======================= 5. security deposit ============================= */

async function depositWorld() {
  const w = await world();
  const p = await approvedPartner(pool);
  await w.ca.post(`/admin/partners/${p.id}/deposit/receipts`, { amountPaise: 100000, method: 'manual_bank_transfer', externalReference: 'NEFT0001234' });
  const cust = await makeUser(pool, { phone: phone(), name: 'Anaya Gupta' });
  const { o } = await deliveredOrder(pool, { customer: cust, partner: p, ...w });
  const inc = (await (await as(cust)).post(`/orders/${o.id}/incidents`,
    { category: 'tampered', description: 'Seal on the bag was broken and a burger was missing.' })).body;
  return { ...w, p, cp: await as(p), cust, o, inc };
}

test('deposit is its own ledger account, never mixed with earnings, and the ledger balances', async () => {
  const d = await depositWorld();
  const view = (await d.cp.get('/partner/deposit')).body;
  assert.equal(view.balancePaise, 100000);
  assert.equal(view.movements[0].external_reference, 'NEFT0001234');
  assert.equal(view.collection.online, false, 'honest: no online deposit collection');

  const earn = (await d.cp.get('/partner/earnings')).body;
  assert.equal(earn.pendingPayoutPaise, 0, 'deposit is not earnings');
  const kinds = (await pool.query(
    `SELECT a.kind, sum(e.amount_paise)::int s FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id GROUP BY a.kind`)).rows;
  assert.deepEqual(Object.fromEntries(kinds.map((k) => [k.kind, k.s])), { deposit_bank: 100000, partner_deposit: -100000 });
  assert.equal((await pool.query(`SELECT coalesce(sum(amount_paise),0)::int s FROM ledger_entry`)).rows[0].s, 0);

  /* The same bank reference cannot be recorded twice. */
  const dup = await d.ca.post(`/admin/partners/${d.p.id}/deposit/receipts`, { amountPaise: 100000, method: 'manual_bank_transfer', externalReference: 'NEFT0001234' });
  assert.equal(dup.status, 409);
});

test('deduction authorization: no deduction on a complaint alone, only by finance admins, never above the deposit', async () => {
  const d = await depositWorld();
  const body = { incidentId: d.inc.id, amountPaise: 20000, reason: 'Tampered packaging, item missing', evidence: 'Counter confirmed sealed handover by code; customer photo shows broken seal.' };

  assert.equal((await d.cp.post('/admin/deductions', body)).status, 403, 'a partner cannot deduct');
  assert.equal((await (await as(d.cust)).post('/admin/deductions', body)).status, 403, 'a customer cannot deduct');
  const sup = await as(await makeUser(pool, { phone: phone(), name: 'Sam Support', roles: ['support'] }));
  assert.equal((await sup.post('/admin/deductions', body)).status, 403, 'support investigates but cannot deduct');

  const early = await d.ca.post('/admin/deductions', body);
  assert.equal(early.status, 409, 'the incident is not resolved');
  assert.match(early.body.detail, /complaint on its own/);

  await d.ca.post(`/admin/incidents/${d.inc.id}/resolve`, { outcome: 'no_fault_found', note: 'Counter packed it open; not the partner.' });
  assert.equal((await d.ca.post('/admin/deductions', body)).status, 409, 'no fault found means no deduction');

  const { o } = await deliveredOrder(pool, { customer: d.cust, partner: d.p, ...d });
  const inc2 = (await (await as(d.cust)).post(`/orders/${o.id}/incidents`, { category: 'missing', description: 'Drinks missing from the bag.' })).body;
  await d.ca.post(`/admin/incidents/${inc2.id}/resolve`, { outcome: 'partner_responsible', note: 'Partner admitted drinking it.' });
  assert.equal((await d.ca.post('/admin/deductions', { ...body, incidentId: inc2.id, amountPaise: 100001 })).status, 409, 'above the deposit');
  assert.equal((await d.ca.post('/admin/deductions', { ...body, incidentId: inc2.id, evidence: 'short' })).status, 400, 'evidence required');
  const ok = await d.ca.post('/admin/deductions', { ...body, incidentId: inc2.id });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state, 'proposed');

  /* Proposing moves no money, and it cannot be applied inside the dispute window. */
  assert.equal((await d.cp.get('/partner/deposit')).body.balancePaise, 100000);
  const tooSoon = await d.ca.post(`/admin/deductions/${ok.body.id}/apply`);
  assert.equal(tooSoon.status, 409);
  assert.match(tooSoon.body.error, /can still dispute/);
  const n = await pool.query(`SELECT 1 FROM notification WHERE user_id = $1 AND kind = 'deposit_deduction_proposed'`, [d.p.id]);
  assert.equal(n.rowCount >= 1, true, 'the partner is told');
});

test('deposit dispute: partner disputes; the proposer cannot judge it; another admin decides; then money moves once', async () => {
  const d = await depositWorld();
  await d.ca.post(`/admin/incidents/${d.inc.id}/resolve`, { outcome: 'partner_responsible', note: 'Bag seal broken after pickup code verified.' });
  const ded = (await d.ca.post('/admin/deductions', { incidentId: d.inc.id, amountPaise: 30000,
    reason: 'Order tampered after pickup', evidence: 'Pickup code verified sealed; customer photo shows seal torn open.' })).body;

  const other = await approvedPartner(pool, 'Not Theirs');
  assert.equal((await (await as(other)).post(`/partner/deductions/${ded.id}/dispute`, { text: 'This is not my deduction at all really.' })).status, 404);
  assert.equal((await d.cp.post(`/partner/deductions/${ded.id}/dispute`, { text: 'short' })).status, 400);
  const disp = await d.cp.post(`/partner/deductions/${ded.id}/dispute`, { text: 'The seal was already loose at the counter; I reported it.' });
  assert.equal(disp.status, 200);

  assert.equal((await d.ca.post(`/admin/deductions/${ded.id}/apply`)).status, 409, 'a disputed deduction cannot be applied');
  const self = await d.ca.post(`/admin/deductions/${ded.id}/review`, { decision: 'uphold', note: 'I stand by my proposal.' });
  assert.equal(self.status, 403, 'the proposer does not judge the dispute');
  const up = await d.ca2.post(`/admin/deductions/${ded.id}/review`, { decision: 'uphold', note: 'Counter CCTV shows sealed bag at handover.' });
  assert.equal(up.status, 200);

  const applied = await d.ca2.post(`/admin/deductions/${ded.id}/apply`);
  assert.equal(applied.status, 200);
  assert.equal((await d.ca2.post(`/admin/deductions/${ded.id}/apply`)).status, 409, 'applied once');
  assert.equal((await d.cp.get('/partner/deposit')).body.balancePaise, 70000);

  /* Immutable record: a ledger transaction and an audit row, neither editable. */
  const txn = (await pool.query(`SELECT id FROM ledger_txn WHERE kind = 'deposit_deduction' AND ref = $1`, [ded.id])).rows;
  assert.equal(txn.length, 1);
  await assert.rejects(pool.query(`DELETE FROM ledger_txn WHERE id = $1`, [txn[0].id]));
  assert.ok((await pool.query(`SELECT 1 FROM audit_log WHERE action = 'deposit.deduction.apply'`)).rowCount);
});

test('an undisputed deduction applies only after its window closes; a dismissed one never does', async () => {
  const d = await depositWorld();
  await d.ca.post(`/admin/incidents/${d.inc.id}/resolve`, { outcome: 'partner_responsible', note: 'Confirmed after investigation.' });
  const ded = (await d.ca.post('/admin/deductions', { incidentId: d.inc.id, amountPaise: 10000,
    reason: 'Spilled through carelessness', evidence: 'Partner confirmed dropping the bag in writing to support.' })).body;
  await pool.query(`UPDATE deposit_deduction SET dispute_deadline = now() - interval '1 minute' WHERE id = $1`, [ded.id]);
  assert.equal((await d.cp.post(`/partner/deductions/${ded.id}/dispute`, { text: 'Too late to dispute this deduction now.' })).status, 409);
  assert.equal((await d.ca.post(`/admin/deductions/${ded.id}/apply`)).status, 200);
  assert.equal((await d.cp.get('/partner/deposit')).body.balancePaise, 90000);

  const { o } = await deliveredOrder(pool, { customer: d.cust, partner: d.p, ...d });
  const inc2 = (await (await as(d.cust)).post(`/orders/${o.id}/incidents`, { category: 'damaged', description: 'Box crushed on arrival.' })).body;
  await d.ca.post(`/admin/incidents/${inc2.id}/resolve`, { outcome: 'partner_responsible', note: 'Initially judged careless handling.' });
  const ded2 = (await d.ca.post('/admin/deductions', { incidentId: inc2.id, amountPaise: 5000,
    reason: 'Crushed box on delivery', evidence: 'Customer photo of crushed box after handover code.' })).body;
  await d.cp.post(`/partner/deductions/${ded2.id}/dispute`, { text: 'The counter packed it in a split box; I have their message.' });
  assert.equal((await d.ca2.post(`/admin/deductions/${ded2.id}/review`, { decision: 'dismiss', note: 'Counter confirms the box was split.' })).status, 200);
  await pool.query(`UPDATE deposit_deduction SET dispute_deadline = now() - interval '1 minute' WHERE id = $1`, [ded2.id]);
  assert.equal((await d.ca.post(`/admin/deductions/${ded2.id}/apply`)).status, 409, 'dismissed never applies');
  assert.equal((await d.cp.get('/partner/deposit')).body.balancePaise, 90000);
});

test('deposit refund: blocked while active or with open obligations; paid with a reference after leaving', async () => {
  const d = await depositWorld();
  const blocked = await d.cp.post('/partner/deposit/refund-request');
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.detail, /still an active delivery partner/);
  assert.match(blocked.body.detail, /being investigated/);

  assert.equal((await d.cp.post('/partner/leave')).status, 200);
  const stillOpen = await d.cp.post('/partner/deposit/refund-request');
  assert.equal(stillOpen.status, 409, 'the open incident still blocks it');

  await d.ca.post(`/admin/incidents/${d.inc.id}/resolve`, { outcome: 'customer_claim_not_supported', note: 'Codes and counter confirm a sealed handover.' });
  const req = await d.cp.post('/partner/deposit/refund-request');
  assert.equal(req.status, 200);
  assert.equal((await d.cp.post('/partner/deposit/refund-request')).status, 409, 'one open request');

  assert.equal((await d.ca.post(`/admin/deposit-refunds/${req.body.id}/pay`, { method: 'manual_bank_transfer', externalReference: '' })).status, 400);
  const paid = await d.ca.post(`/admin/deposit-refunds/${req.body.id}/pay`, { method: 'manual_bank_transfer', externalReference: 'NEFT9998887' });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.movement.amount_paise, 100000);
  const view = (await d.cp.get('/partner/deposit')).body;
  assert.equal(view.balancePaise, 0);
  assert.equal(view.refundRequest.state, 'paid');
  assert.equal((await pool.query(`SELECT coalesce(sum(amount_paise),0)::int s FROM ledger_entry`)).rows[0].s, 0);
});

/* ======================= 6-8. reviews ==================================== */

test('reviews: only the buyer, only after delivery, once per target; the partner cannot rate themselves', async () => {
  const w = await world();
  const p = await approvedPartner(pool);
  const cust = await makeUser(pool, { phone: phone(), name: 'Anaya Gupta' });
  const cc = await as(cust);
  const live = await deliveredOrder(pool, { customer: cust, partner: p, ...w, state: 'picked_up' });
  assert.equal((await cc.post('/reviews', { orderId: live.o.id, stars: 5 })).status, 409, 'not yet delivered');
  assert.equal((await cc.post('/reviews', { orderId: live.o.id, target: 'delivery', stars: 5 })).status, 409);

  const { o } = await deliveredOrder(pool, { customer: cust, partner: p, ...w });
  const stranger = await as(await makeUser(pool, { phone: phone(), name: 'Random User' }));
  assert.equal((await stranger.post('/reviews', { orderId: o.id, stars: 1 })).status, 403);
  assert.equal((await (await as(p)).post('/reviews', { orderId: o.id, target: 'delivery', stars: 5 })).status, 403);

  assert.equal((await cc.post('/reviews', { orderId: o.id, stars: 4, body: 'Hot and fresh.' })).status, 200);
  const dr = await cc.post('/reviews', { orderId: o.id, target: 'delivery', stars: 5, body: 'Quick and polite.' });
  assert.equal(dr.status, 200);
  assert.ok(!('partner_id' in dr.body), 'the partner id is not echoed back');
  assert.equal((await cc.post('/reviews', { orderId: o.id, stars: 1 })).status, 409, 'one cafeteria review per order');
  assert.equal((await cc.post('/reviews', { orderId: o.id, target: 'delivery', stars: 1 })).status, 409, 'one delivery review per order');
  assert.equal((await cc.post('/reviews', { orderId: o.id, target: 'delivery', stars: 6 })).status, 400);

  /* A rating cannot be edited or deleted, even directly in the database. */
  await assert.rejects(pool.query(`UPDATE review SET stars = 1 WHERE order_id = $1`, [o.id]));
  await assert.rejects(pool.query(`DELETE FROM review WHERE order_id = $1`, [o.id]));

  const mine = (await cc.get(`/orders/${o.id}`)).body.myReviews.map((r) => r.target).sort();
  assert.deepEqual(mine, ['delivery', 'vendor']);
});

test('cafeteria ratings come only from visible completed-order reviews; none shows as no rating', async () => {
  const w = await world();
  const empty = (await client(app).get('/vendors')).body.vendors.find((v) => v.id === w.v.id);
  assert.equal(empty.rating, null, 'no fabricated rating');

  const p = await approvedPartner(pool);
  const ids = [];
  for (const stars of [5, 3, 1]) {
    const cust = await makeUser(pool, { phone: phone(), name: 'Buyer Person' });
    const { o } = await deliveredOrder(pool, { customer: cust, partner: p, ...w });
    ids.push((await (await as(cust)).post('/reviews', { orderId: o.id, stars, body: `stars ${stars}` })).body.id);
  }
  let v = (await client(app).get('/vendors')).body.vendors.find((x) => x.id === w.v.id);
  assert.deepEqual([v.rating.average, v.rating.count], [3, 3]);

  /* Moderation hides; the aggregate follows. */
  assert.equal((await w.ca.post(`/admin/reviews/${ids[2]}/hide`, { reason: 'abusive language' })).status, 200);
  v = (await client(app).get('/vendors')).body.vendors.find((x) => x.id === w.v.id);
  assert.deepEqual([v.rating.average, v.rating.count], [4, 2]);
  const pub = (await client(app).get(`/reviews?vendorId=${w.v.id}`)).body.reviews;
  assert.equal(pub.length, 2);
  assert.ok(pub.every((r) => r.author === 'Buyer'), 'first name only');
});

test('delivery ratings: aggregated for the partner, never listed publicly, reportable and moderated by admins', async () => {
  const w = await world();
  const p = await approvedPartner(pool);
  let reviewId;
  for (const stars of [4, 2]) {
    const cust = await makeUser(pool, { phone: phone(), name: 'Buyer Person' });
    const { o } = await deliveredOrder(pool, { customer: cust, partner: p, ...w });
    reviewId = (await (await as(cust)).post('/reviews', { orderId: o.id, target: 'delivery', stars, body: 'late delivery' })).body.id;
  }
  const cp = await as(p);
  const mine = (await cp.get('/partner/rating')).body;
  assert.deepEqual([mine.rating.average, mine.rating.count], [3, 2]);
  assert.ok(mine.recent.every((r) => !('author' in r) && !('user_id' in r)), 'the partner never learns who rated them');

  const pub = await client(app).get(`/reviews?vendorId=${w.v.id}`);
  assert.equal(pub.body.reviews.length, 0, 'delivery reviews are not public listings');

  const rep = await cp.post(`/reviews/${reviewId}/report`, { reason: 'I delivered early; codes show it.' });
  assert.equal(rep.status, 200);
  assert.equal((await cp.post(`/reviews/${reviewId}/report`, { reason: 'again' })).status, 409);
  const queue = (await w.ca.get('/admin/reviews')).body.reviews;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].target, 'delivery');
  assert.equal((await cp.get('/admin/reviews')).status, 403, 'partners cannot moderate');
  const res = await w.ca.post(`/admin/review-reports/${queue[0].reports[0].id}/resolve`, { resolution: 'Handover code times confirm on-time; review hidden.' });
  assert.equal(res.status, 200);
});
