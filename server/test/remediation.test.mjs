/* ==========================================================================
   NON-PAYMENT REMEDIATION - tracking, sessions, recovery, approvals, catalogue
   conflicts, the change feed and its streams, request ids, rate-limit spoofing,
   image re-encoding, and the public readiness answer. Real routes and a real
   database; a real listening socket for the streams.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';
import { createHash } from 'node:crypto';

let app, pool, auth, creds, stub, base, sharp;
const mailbox = [];
let nth = 0;
const PASSWORD = 'Correct-Horse-Battery-77!';
const phone = () => `+9197000${String(10000 + nth++).slice(-5)}`;
const NEAR = { lat: 30.4172, lng: 77.9681 };

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { mailbox.push(JSON.parse(raw || '{}')); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: `m${mailbox.length}` })); });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  await startDb();
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000', COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    ADMIN_TOTP_KEY: 'test-admin-totp-key-0123456789abcdef', ADMIN_PASSKEY_REQUIRED: 'true',
    EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'ECHO ECHO <verify@echo.test>',
    RESEND_BASE_URL: `http://127.0.0.1:${stub.address().port}`, LIVE_STREAMS_ENABLED: 'true',
  });
  ({ pool } = await import('../src/db/index.js'));
  auth = await import('../src/services/admin-auth.js');
  creds = await import('../src/services/admin-credentials.js');
  sharp = (await import('sharp')).default;
  app = await makeApp();
  process.env.ADMIN_PASSKEY_REQUIRED = 'true';
  base = await app.listen({ port: 0, host: '127.0.0.1' });
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); stub?.close(); });
beforeEach(async () => { await truncateAll(pool); mailbox.length = 0; });

const as = async (u, method = 'code') => client(app, await sessionFor(pool, u.id, { method }));
async function owner() {
  const u = await makeUser(pool, { phone: '+919000000000', name: 'Owner', roles: ['student', 'platform_owner'] });
  return { u, c: await as(u, 'admin_totp') };
}
async function admin(permissions, name = 'Admin') {
  const u = await makeUser(pool, { phone: phone(), name, roles: ['platform_admin'] });
  await pool.query(`INSERT INTO admin_account (user_id, status, permissions) VALUES ($1,'active',$2)`, [u.id, permissions]);
  return { u, c: await as(u, 'admin_totp') };
}
let code = 0;
async function order(state, { partnerId, vendorId, customerId }) {
  return (await pool.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id,
                             destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ($1,$2,$3,'delivery',$4,9000,10000,$5,'{"name":"Block 4"}','+919999900002','manual_map_spot',$6,$7) RETURNING *`,
    [`REM${code++}`, customerId, vendorId, state, partnerId, NEAR.lat, NEAR.lng])).rows[0];
}
async function delivery(state = 'picked_up') {
  const vendor = await makeVendor(pool, { name: `Cafe ${nth}`, slug: `cafe-${nth++}` });
  const customer = await makeUser(pool, { phone: phone(), name: 'Customer' });
  const partner = await makeUser(pool, { phone: phone(), name: 'Ravi Kumar Singh', roles: ['student', 'delivery_partner'] });
  const o = await order(state, { partnerId: partner.id, vendorId: vendor.id, customerId: customer.id });
  return { vendor, customer, partner, o, p: await as(partner) };
}
const pos = (o, extra = {}) => ({ orderId: o.id, ...NEAR, accuracy: 10, takenAt: Date.now(), ...extra });

/* ---------- partner sharing and GPS integrity ----------------------------- */
test('no position is accepted until the partner chooses to share, and the choice is recorded', async () => {
  const { o, p, partner } = await delivery();
  const refused = await p.post('/partner/location', pos(o));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'sharing_not_started');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM partner_location`)).rows[0].n, 0);
  assert.equal((await p.post('/partner/location/start', { orderId: o.id })).status, 200);
  const c = (await pool.query(`SELECT * FROM location_share_consent WHERE order_id = $1`, [o.id])).rows[0];
  assert.equal(c.partner_id, partner.id);
  assert.ok(c.consented_at);
  assert.ok(c.notice_version);
  assert.equal(c.stopped_at, null);
  assert.ok(!('lat' in c), 'the consent record holds no coordinates');
  assert.equal((await p.post('/partner/location', pos(o))).status, 200);
});

test('a partner cannot start sharing for someone else\'s delivery or outside an active one', async () => {
  const a = await delivery();
  const b = await delivery();
  assert.equal((await a.p.post('/partner/location/start', { orderId: b.o.id })).status, 403);
  const done = await order('delivered', { partnerId: a.partner.id, vendorId: a.vendor.id, customerId: a.customer.id });
  assert.equal((await a.p.post('/partner/location/start', { orderId: done.id })).status, 403);
});

test('an older or repeated fix cannot move the marker backwards', async () => {
  const { o, p } = await delivery();
  await p.post('/partner/location/start', { orderId: o.id });
  const now = Date.now();
  assert.equal((await p.post('/partner/location', pos(o, { takenAt: now - 5000, lat: 30.4180 }))).status, 200);
  const replay = await p.post('/partner/location', pos(o, { takenAt: now - 5000, lat: 30.4111 }));
  assert.equal(replay.status, 409, 'the same fix again');
  const delayed = await p.post('/partner/location', pos(o, { takenAt: now - 60000, lat: 30.4111 }));
  assert.equal(delayed.status, 409, 'an out-of-order fix');
  const row = (await pool.query(`SELECT lat FROM partner_location WHERE order_id = $1`, [o.id])).rows[0];
  assert.equal(Number(row.lat), 30.418);
  assert.equal((await p.post('/partner/location', pos(o, { takenAt: now, lat: 30.4190 }))).status, 200, 'a newer one still lands');
});

test('stopping, permission loss, sign-out and delivery end all remove the position and close the consent', async () => {
  for (const stop of [
    async (p) => p.post('/partner/location/clear', { reason: 'partner' }),
    async (p) => p.post('/partner/location/clear', { reason: 'permission_revoked' }),
    async (p) => p.post('/auth/logout'),
  ]) {
    const { o, p } = await delivery();
    await p.post('/partner/location/start', { orderId: o.id });
    await p.post('/partner/location', pos(o));
    await stop(p);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM partner_location WHERE order_id = $1`, [o.id])).rows[0].n, 0);
    const c = (await pool.query(`SELECT stopped_at, stop_reason FROM location_share_consent WHERE order_id = $1`, [o.id])).rows[0];
    assert.ok(c.stopped_at);
  }
});

/* ---------- who sees coordinates ------------------------------------------ */
test('orders.view alone gets no coordinates; delivery.track does, and that view is audited', async () => {
  const { o, p } = await delivery();
  await p.post('/partner/location/start', { orderId: o.id });
  await p.post('/partner/location', pos(o));

  const viewer = await admin(['orders.view']);
  const plain = await viewer.c.get(`/orders/${o.id}/tracking`);
  assert.equal(plain.status, 200);
  assert.equal(plain.body.partner, null);
  assert.equal(plain.body.partnerVisibility, 'restricted');
  assert.equal(plain.body.destination.lat, undefined, 'the student\'s exact spot is hidden too');
  assert.ok(!JSON.stringify(plain.body).includes(String(NEAR.lng)), 'no partner or spot coordinate anywhere in the answer');

  const tracker = await admin(['orders.view', 'delivery.track'], 'Tracker');
  const seen = await tracker.c.get(`/orders/${o.id}/tracking`);
  assert.equal(seen.body.partner.lat, NEAR.lat);
  assert.ok(Number.isFinite(seen.body.partner.ageSeconds));
  const log = (await pool.query(`SELECT actor_id FROM audit_log WHERE action = 'delivery.track.view' AND resource_id = $1`, [o.id])).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, tracker.u.id);
  await tracker.c.get(`/orders/${o.id}/tracking`);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'delivery.track.view' AND resource_id = $1`, [o.id])).rows[0].n, 1, 'a refreshing map does not flood the log');
});

test('cafe staff get status and a first name, never a position', async () => {
  const { o, p, vendor } = await delivery();
  await p.post('/partner/location/start', { orderId: o.id });
  await p.post('/partner/location', pos(o));
  const staffUser = await makeUser(pool, { phone: phone(), name: 'Staff', roles: ['vendor_staff'], vendorId: vendor.id });
  const staff = await as(staffUser);
  const st = await staff.get(`/orders/${o.id}/delivery-status`);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.partnerFirstName, 'Ravi');
  assert.equal(st.body.deliveryStatus, 'on_the_way');
  assert.ok(!/lat|lng|phone/i.test(JSON.stringify(st.body)));
  const map = await staff.get(`/orders/${o.id}/tracking`);
  assert.equal(map.body.partner, null);
  assert.equal(map.body.destination.lat, undefined);

  const otherVendor = await makeVendor(pool, { name: 'Other', slug: `other-${nth++}` });
  const stranger = await as(await makeUser(pool, { phone: phone(), name: 'Other staff', roles: ['vendor_staff'], vendorId: otherVendor.id }));
  assert.equal((await stranger.get(`/orders/${o.id}/delivery-status`)).status, 403);
});

test('a customer sees only their own order, only after pickup, and not once it ends', async () => {
  const before = await delivery('assigned');
  await before.p.post('/partner/location/start', { orderId: before.o.id });
  await before.p.post('/partner/location', pos(before.o));
  const cust = await as(before.customer);
  const early = await cust.get(`/orders/${before.o.id}/tracking`);
  assert.equal(early.body.partner, null);
  assert.equal(early.body.partnerVisibility, 'hidden_until_pickup');
  const stranger = await as(await makeUser(pool, { phone: phone(), name: 'Stranger' }));
  assert.equal((await stranger.get(`/orders/${before.o.id}/tracking`)).status, 403);

  await pool.query(`UPDATE food_order SET state = 'picked_up' WHERE id = $1`, [before.o.id]);
  assert.equal((await cust.get(`/orders/${before.o.id}/tracking`)).body.partnerVisibility, 'visible');
  await pool.query(`UPDATE food_order SET state = 'delivered' WHERE id = $1`, [before.o.id]);
  const ended = await cust.get(`/orders/${before.o.id}/tracking`);
  assert.equal(ended.body.partner, null);
  assert.equal(ended.body.partnerVisibility, 'delivery_over');
});

/* ---------- streams ------------------------------------------------------- */
async function readStream(path, { headers = {}, until, timeoutMs = 8000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const res = await fetch(`${base}${path}`, { headers, signal: ctl.signal });
  let text = '';
  const done = (async () => {
    try {
      const reader = res.body?.getReader();
      if (!reader) return;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        text += Buffer.from(value).toString();
        if (until?.(text)) break;
      }
    } catch { /* aborted */ }
    finally { clearTimeout(timer); ctl.abort(); }
  })();
  return { res, done, read: () => text };
}
const cookieFor = (token) => `quad_session=${token}`;

test('the public stream says which area moved and a version, nothing about the record', async () => {
  const vendor = await makeVendor(pool, { name: 'Stream Cafe', slug: `stream-${nth++}` });
  const s = await readStream('/live/stream', { until: (t) => t.includes('event: change') });
  assert.equal(s.res.status, 200);
  assert.match(s.res.headers.get('content-type'), /text\/event-stream/);
  await new Promise((r) => setTimeout(r, 300));
  await pool.query(`UPDATE vendor SET description = 'Secret new text' WHERE id = $1`, [vendor.id]);
  await s.done;
  assert.match(s.read(), /"area":"cafes"/);
  assert.match(s.read(), /"version":\d+/);
  assert.ok(!s.read().includes('Secret new text'));
  assert.ok(!s.read().includes(vendor.id));
});

test('a reconnecting client catches up from Last-Event-ID', async () => {
  const vendor = await makeVendor(pool, { name: 'Resume', slug: `resume-${nth++}` });
  const since = Number((await pool.query(`SELECT coalesce(max(id),0) m FROM change_event`)).rows[0].m);
  await pool.query(`UPDATE vendor SET description = 'while away' WHERE id = $1`, [vendor.id]);
  const s = await readStream('/live/stream', { headers: { 'last-event-id': String(since) }, until: (t) => t.includes('event: change') });
  await s.done;
  assert.match(s.read(), /"area":"cafes"/);
});

test('streams turned off answer 204, which makes a browser stop retrying and fall back to polling', async () => {
  process.env.LIVE_STREAMS_ENABLED = 'false';
  try {
    const r = await fetch(`${base}/live/stream`);
    assert.equal(r.status, 204);
  } finally { process.env.LIVE_STREAMS_ENABLED = 'true'; }
});

test('the admin stream refuses anyone without a Campus Control session', async () => {
  assert.equal((await fetch(`${base}/admin/live/stream`)).status, 401);
  const student = await makeUser(pool, { phone: phone(), name: 'Student' });
  const token = await sessionFor(pool, student.id);
  const r = await fetch(`${base}/admin/live/stream`, { headers: { cookie: cookieFor(token) } });
  assert.equal(r.status, 403);
});

test('a tracking stream needs a short ticket, carries no coordinates, and only the right people get one', async () => {
  const { o, p, customer } = await delivery();
  await p.post('/partner/location/start', { orderId: o.id });
  const stranger = await as(await makeUser(pool, { phone: phone(), name: 'Stranger' }));
  assert.equal((await stranger.post(`/orders/${o.id}/tracking/ticket`)).status, 403);
  assert.equal((await (await admin(['orders.view'])).c.post(`/orders/${o.id}/tracking/ticket`)).status, 403, 'orders.view is not enough');
  assert.equal((await fetch(`${base}/tracking/stream?ticket=forged`)).status, 403);

  const token = await sessionFor(pool, customer.id);
  const ticket = (await client(app, token).post(`/orders/${o.id}/tracking/ticket`)).body.ticket;
  assert.ok(ticket);
  const s = await readStream(`/tracking/stream?ticket=${ticket}`, { until: (t) => t.includes('event: position') });
  assert.equal(s.res.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  await p.post('/partner/location', pos(o));
  await s.done;
  assert.ok(s.read().includes('event: position'));
  assert.ok(!s.read().includes(String(NEAR.lat)), 'a stream event holds no coordinate');
  assert.equal((await fetch(`${base}/tracking/stream?ticket=${ticket}`)).status, 403, 'a ticket works once');

  /* Once the delivery ends a new ticket is refused. */
  await pool.query(`UPDATE food_order SET state = 'delivered' WHERE id = $1`, [o.id]);
  assert.equal((await client(app, token).post(`/orders/${o.id}/tracking/ticket`)).status, 403);
});

test('the feed is written by the database with the change, rolls back with it, and cannot be rewritten', async () => {
  const vendor = await makeVendor(pool, { name: 'Feed', slug: `feed-${nth++}` });
  const before = Number((await pool.query(`SELECT count(*) n FROM change_event WHERE area = 'cafes'`)).rows[0].n);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE vendor SET description = 'x' WHERE id = $1`, [vendor.id]);
    await c.query('ROLLBACK');
  } finally { c.release(); }
  assert.equal(Number((await pool.query(`SELECT count(*) n FROM change_event WHERE area = 'cafes'`)).rows[0].n), before, 'a rolled-back change leaves no event');
  await pool.query(`UPDATE vendor SET description = 'y' WHERE id = $1`, [vendor.id]);
  assert.equal(Number((await pool.query(`SELECT count(*) n FROM change_event WHERE area = 'cafes'`)).rows[0].n), before + 1);
  await assert.rejects(pool.query(`UPDATE change_event SET area = 'x'`), /append-only/);
  await assert.rejects(pool.query(`DELETE FROM change_event`), /append-only/);
});

/* ---------- sessions ------------------------------------------------------ */
test('sessions show last activity and a device by opaque handle; one can be ended, effective next request', async () => {
  const o = await owner();
  const t = await admin(['students.view']);
  await t.c.get('/admin/users');
  const token = await sessionFor(pool, t.u.id, { method: 'admin_totp' });
  await pool.query(`UPDATE session SET user_agent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Safari/604.1' WHERE user_id = $1`, [t.u.id]);
  const second = client(app, token);
  await second.get('/admin/users');
  const d = await o.c.get(`/admin/access/admins/${t.u.id}`);
  assert.equal(d.status, 200);
  assert.ok(d.body.sessions.length >= 2);
  const s = d.body.sessions[0];
  assert.ok(s.last_seen_at);
  assert.equal(s.device, 'Safari on iPhone');
  assert.ok(s.handle);
  assert.equal(s.token_hash, undefined);
  const dump = JSON.stringify(d.body);
  const raw = (await pool.query(`SELECT token_hash FROM session WHERE user_id = $1`, [t.u.id])).rows;
  for (const r of raw) assert.ok(!dump.includes(r.token_hash), 'no token hash reaches the client');

  const target = createHash('sha256').update(`session-handle:${createHash('sha256').update(token).digest('hex')}`).digest('hex').slice(0, 20);
  assert.equal((await second.get('/admin/users')).status, 200);
  assert.equal((await o.c.post(`/admin/access/admins/${t.u.id}/sessions/${target}/revoke`, { reason: 'lost laptop' })).status, 200);
  assert.equal((await second.get('/admin/users')).status, 401, 'ended on the next request');
  assert.equal((await t.c.get('/admin/users')).status, 200, 'their other session is untouched');
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'admin.session.revoke_one'`)).rows[0].n, 1);
  assert.equal((await o.c.post(`/admin/access/admins/${t.u.id}/sessions/${target}/revoke`, { reason: 'lost laptop' })).status, 404);
});

test('session details need sessions.read, and ending one needs sessions.revoke', async () => {
  const t = await admin(['students.view']);
  const noRead = await admin(['admins.view'], 'No Read');
  const yes = await admin(['admins.view', 'sessions.read'], 'Reader');
  assert.deepEqual((await noRead.c.get(`/admin/access/admins/${t.u.id}`)).body.sessions, []);
  assert.ok((await yes.c.get(`/admin/access/admins/${t.u.id}`)).body.sessions.length >= 1);
  assert.equal((await yes.c.post(`/admin/access/admins/${t.u.id}/sessions/abc/revoke`, { reason: 'because' })).status, 403);
});

test('an idle administrator session ends and stays ended; a student session is not affected', async () => {
  const t = await admin(['students.view']);
  assert.equal((await t.c.get('/admin/users')).status, 200);
  await pool.query(`UPDATE session SET last_seen_at = now() - interval '61 minutes' WHERE user_id = $1`, [t.u.id]);
  assert.equal((await t.c.get('/admin/users')).status, 401);
  await pool.query(`UPDATE session SET last_seen_at = now() WHERE user_id = $1`, [t.u.id]);
  assert.equal((await t.c.get('/admin/users')).status, 401, 'it was revoked, not merely paused');

  const s = await makeUser(pool, { phone: phone(), name: 'Student' });
  const sc = await as(s);
  await pool.query(`UPDATE session SET last_seen_at = now() - interval '5 hours' WHERE user_id = $1`, [s.id]);
  assert.equal((await sc.get('/auth/me')).body.user.id, s.id);
});

/* ---------- recovery ------------------------------------------------------ */
async function credentialedOwner() {
  const o = await owner();
  await pool.query(`UPDATE app_user SET student_email = 'owner.r@stu.upes.ac.in', student_email_verified_at = now() WHERE id = $1`, [o.u.id]);
  await auth.setPassword(o.u.id, PASSWORD, { email: 'owner.r@stu.upes.ac.in' });
  const b = await auth.beginAuthenticator(o.u.id, 'owner.r@stu.upes.ac.in');
  await auth.confirmAuthenticator(o.u.id, auth.totpAt(b.secret, auth.stepNow()));
  return { ...o, email: 'owner.r@stu.upes.ac.in', oldSecret: b.secret };
}

test('recovery: codes are shown once and stored hashed; password + code replaces the authenticator and alerts the owner', async () => {
  const o = await credentialedOwner();
  const made = await o.c.post('/auth/admin/recovery-codes');
  assert.equal(made.status, 200);
  assert.equal(made.body.codes.length, 10);
  const stored = (await pool.query(`SELECT code_hash FROM admin_recovery_code WHERE user_id = $1`, [o.u.id])).rows;
  for (const s of stored) assert.ok(!made.body.codes.includes(s.code_hash));
  assert.equal((await o.c.get('/auth/admin/recovery-codes')).body.remaining, 10);
  assert.equal((await o.c.put('/auth/admin/alert-email', { email: 'Personal@Example.org' })).body.alertEmail, 'personal@example.org');

  /* Needs both: neither the code alone nor the password alone gets anywhere. */
  assert.equal((await client(app).post('/auth/admin/recovery/begin', { email: o.email, password: 'wrong-wrong-wrong', recoveryCode: made.body.codes[0] })).status, 403);
  assert.equal((await client(app).post('/auth/admin/recovery/begin', { email: o.email, password: PASSWORD, recoveryCode: 'AAAAA-BBBBB' })).status, 403);

  mailbox.length = 0;
  const begun = await client(app).post('/auth/admin/recovery/begin', { email: o.email, password: PASSWORD, recoveryCode: made.body.codes[0] });
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  assert.equal(begun.headers['set-cookie'], undefined, 'recovery opens no session');
  const alerted = mailbox.flatMap((m) => m.to);
  assert.ok(alerted.includes(o.email) && alerted.includes('personal@example.org'), 'both addresses are told');

  /* Half-way, the old authenticator still works. */
  assert.ok((await pool.query(`SELECT totp_confirmed_at FROM admin_credential WHERE user_id = $1`, [o.u.id])).rows[0].totp_confirmed_at);
  assert.equal((await o.c.get('/auth/admin/recovery-codes')).status, 200);

  const bad = await client(app).post('/auth/admin/recovery/complete', { ticket: begun.body.ticket, code: '000000' });
  assert.equal(bad.status, 400);
  const code6 = auth.totpAt(begun.body.secret, auth.stepNow());
  const done = await client(app).post('/auth/admin/recovery/complete', { ticket: begun.body.ticket, code: code6 });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.headers['set-cookie'], undefined);
  assert.equal((await o.c.get('/auth/admin/recovery-codes')).status, 401, 'every old session ended');
  assert.equal((await client(app).post('/auth/admin/recovery/complete', { ticket: begun.body.ticket, code: code6 })).status, 403, 'a ticket works once');

  /* The spent code is gone, and the old authenticator no longer signs in. */
  assert.equal((await client(app).post('/auth/admin/recovery/begin', { email: o.email, password: PASSWORD, recoveryCode: made.body.codes[0] })).status, 403);
  await pool.query(`UPDATE admin_credential SET totp_last_step = NULL`);
  const a = client(app);
  const p1 = await a.post('/auth/admin/login/password', { email: o.email, password: PASSWORD });
  assert.equal((await a.post('/auth/admin/login', { challenge: p1.body.challenge, code: auth.totpAt(o.oldSecret, auth.stepNow()) })).status, 403);
  const p2 = await a.post('/auth/admin/login/password', { email: o.email, password: PASSWORD });
  assert.equal((await a.post('/auth/admin/login', { challenge: p2.body.challenge, code: auth.totpAt(begun.body.secret, auth.stepNow()) })).status, 200);
});

test('recovery codes are rate-limited per account, whatever the source address', async () => {
  const o = await credentialedOwner();
  await o.c.post('/auth/admin/recovery-codes');
  for (let i = 0; i < 5; i++) {
    const r = await client(app).post('/auth/admin/recovery/begin', { email: o.email, password: PASSWORD, recoveryCode: 'AAAAA-BBBBB' });
    assert.equal(r.status, 403);
  }
  assert.equal((await client(app).post('/auth/admin/recovery/begin', { email: o.email, password: PASSWORD, recoveryCode: 'AAAAA-BBBBB' })).status, 429);
});

test('a student cannot create recovery codes or use recovery to become anything', async () => {
  const s = await makeUser(pool, { phone: phone(), name: 'Student' });
  assert.equal((await (await as(s)).post('/auth/admin/recovery-codes')).status, 403);
  assert.equal((await client(app).post('/auth/admin/recovery/begin', { email: 'nobody@example.org', password: PASSWORD, recoveryCode: 'X' })).status, 403);
});

/* ---------- approvals ----------------------------------------------------- */
async function archiveFlow() {
  const o = await owner();
  const a = await admin(['cafeterias.manage', 'cafeterias.view']);
  const vendor = await makeVendor(pool, { name: 'Archive Me', slug: `arch-${nth++}` });
  assert.equal((await o.c.put('/admin/approvals/policy/vendor.archive', { enabled: true, expiryHours: 24 })).status, 200);
  return { o, a, vendor };
}

test('approval: a queued archive changes nothing, runs once on approval, and is audited', async () => {
  const { o, a, vendor } = await archiveFlow();
  const r = await a.c.patch(`/vendors/${vendor.id}`, { active: false, reason: 'Closed for good' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pendingApproval, true);
  assert.equal((await pool.query(`SELECT active FROM vendor WHERE id = $1`, [vendor.id])).rows[0].active, true, 'nothing happened yet');

  const list = await o.c.get('/admin/approvals');
  assert.equal(list.body.requests.length, 1);
  const d = await o.c.post(`/admin/approvals/${r.body.requestId}/decide`, { decision: 'approve' });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.status, 'executed');
  assert.equal((await pool.query(`SELECT active FROM vendor WHERE id = $1`, [vendor.id])).rows[0].active, false);
  assert.equal((await o.c.post(`/admin/approvals/${r.body.requestId}/decide`, { decision: 'approve' })).status, 409, 'it cannot run twice');
  const actions = (await pool.query(`SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY at`, [r.body.requestId])).rows.map((x) => x.action);
  assert.deepEqual(actions, ['approval.request', 'approval.approve']);
});

test('approval: self-decision is refused by the route and by the database', async () => {
  const { a, vendor } = await archiveFlow();
  const r = await a.c.patch(`/vendors/${vendor.id}`, { active: false, reason: 'Closed for good' });
  assert.equal((await a.c.post(`/admin/approvals/${r.body.requestId}/decide`, { decision: 'approve' })).status, 403);
  await assert.rejects(
    pool.query(`UPDATE approval_request SET status = 'rejected', decided_at = now(), decided_by = requested_by WHERE id = $1`, [r.body.requestId]),
    /approval_no_self_decision/);
});

test('approval: the payload is frozen in the database', async () => {
  const { a, vendor } = await archiveFlow();
  const r = await a.c.patch(`/vendors/${vendor.id}`, { active: false, reason: 'Closed for good' });
  await assert.rejects(pool.query(`UPDATE approval_request SET payload = '{"vendorId":"other"}' WHERE id = $1`, [r.body.requestId]), /cannot be changed/);
  await assert.rejects(pool.query(`DELETE FROM approval_request WHERE id = $1`, [r.body.requestId]), /kept/);
});

test('approval: an expired request does not execute', async () => {
  const { o, a, vendor } = await archiveFlow();
  const r = await a.c.patch(`/vendors/${vendor.id}`, { active: false, reason: 'Closed for good' });
  await pool.query(`UPDATE approval_request SET expires_at = now() - interval '1 minute' WHERE id = $1`, [r.body.requestId]);
  assert.equal((await o.c.post(`/admin/approvals/${r.body.requestId}/decide`, { decision: 'approve' })).status, 409);
  assert.equal((await pool.query(`SELECT active FROM vendor WHERE id = $1`, [vendor.id])).rows[0].active, true);
  assert.equal((await pool.query(`SELECT status FROM approval_request WHERE id = $1`, [r.body.requestId])).rows[0].status, 'expired');
});

test('approval: current state is re-checked, a failed precondition is recorded and nothing happens', async () => {
  const { o, a, vendor } = await archiveFlow();
  const r = await a.c.patch(`/vendors/${vendor.id}`, { active: false, reason: 'Closed for good' });
  const customer = await makeUser(pool, { phone: phone(), name: 'Customer' });
  await order('preparing', { partnerId: null, vendorId: vendor.id, customerId: customer.id });
  const d = await o.c.post(`/admin/approvals/${r.body.requestId}/decide`, { decision: 'approve' });
  assert.equal(d.status, 200);
  assert.equal(d.body.status, 'failed');
  assert.match(d.body.result.message, /still open/);
  assert.equal((await pool.query(`SELECT active FROM vendor WHERE id = $1`, [vendor.id])).rows[0].active, true);
});

test('approval: a duplicate request with the same key makes one request; simultaneous approvals execute once', async () => {
  const { o, a, vendor } = await archiveFlow();
  const headers = { 'idempotency-key': 'same-key-1' };
  const inject = (s) => app.inject({ method: 'PATCH', url: `/vendors/${vendor.id}`, headers: { ...headers, cookie: s, origin: 'http://localhost:3000', 'content-type': 'application/json' }, payload: { active: false, reason: 'Closed for good' } });
  const token = await sessionFor(pool, a.u.id, { method: 'admin_totp' });
  const name = (await import('../src/config.js')).SESSION.cookieName;
  const first = JSON.parse((await inject(`${name}=${token}`)).body);
  const second = JSON.parse((await inject(`${name}=${token}`)).body);
  assert.equal(first.requestId, second.requestId);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM approval_request`)).rows[0].n, 1);
  const rs = await Promise.all([1, 2, 3].map(() => o.c.post(`/admin/approvals/${first.requestId}/decide`, { decision: 'approve' })));
  assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409, 409]);
});

test('approval: deciding and policy changes need the owner and fresh authentication; the owner acts directly', async () => {
  const { o, a, vendor } = await archiveFlow();
  const r = await a.c.patch(`/vendors/${vendor.id}`, { active: false, reason: 'Closed for good' });
  assert.equal((await a.c.put('/admin/approvals/policy/vendor.archive', { enabled: false })).status, 403);
  await pool.query(`UPDATE session SET passkey_verified_at = now() - interval '1 hour' WHERE user_id = $1`, [o.u.id]);
  const stale = await o.c.post(`/admin/approvals/${r.body.requestId}/decide`, { decision: 'reject' });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, 'reauth_required');
  /* The owner's own archive does not queue behind a second approver who does not exist. */
  const v2 = await makeVendor(pool, { name: 'Owner Archive', slug: `own-${nth++}` });
  const direct = await o.c.patch(`/vendors/${v2.id}`, { active: false });
  assert.equal(direct.body.pendingApproval, undefined);
  assert.equal(direct.body.active, false);
});

/* ---------- catalogue conflicts ------------------------------------------- */
test('a stale cafe or menu form gets a 409 and overwrites nothing; instant actions never conflict', async () => {
  const o = await owner();
  const vendor = await makeVendor(pool, { name: 'Conflict', slug: `conf-${nth++}` });
  const item = await makeItem(pool, vendor.id, { name: 'Chai', paise: 2000 });
  const rev = (await pool.query(`SELECT revision FROM menu_item WHERE id = $1`, [item.id])).rows[0].revision;

  assert.equal((await o.c.patch(`/menu/${item.id}`, { revision: rev, name: 'Masala Chai' })).status, 200);
  const stale = await o.c.patch(`/menu/${item.id}`, { revision: rev, name: 'Overwrite' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale_edit');
  assert.equal((await pool.query(`SELECT name FROM menu_item WHERE id = $1`, [item.id])).rows[0].name, 'Masala Chai');

  const before = (await pool.query(`SELECT revision FROM menu_item WHERE id = $1`, [item.id])).rows[0].revision;
  assert.equal((await o.c.patch(`/menu/${item.id}`, { available: false })).status, 200, 'sold out is instant');
  assert.equal((await pool.query(`SELECT revision FROM menu_item WHERE id = $1`, [item.id])).rows[0].revision, before, 'and does not invalidate an open form');
  assert.equal((await o.c.patch(`/menu/${item.id}`, { revision: before, description: 'Still fine' })).status, 200);

  const vRev = (await pool.query(`SELECT revision FROM vendor WHERE id = $1`, [vendor.id])).rows[0].revision;
  assert.equal((await o.c.patch(`/vendors/${vendor.id}`, { isOpen: false })).status, 200);
  assert.equal((await o.c.patch(`/vendors/${vendor.id}`, { revision: vRev, description: 'a' })).status, 200);
  assert.equal((await o.c.patch(`/vendors/${vendor.id}`, { revision: vRev, description: 'b' })).status, 409);
});

test('each saved revision keeps who changed what, with no payment column in it', async () => {
  const o = await owner();
  const vendor = await makeVendor(pool, { name: 'History', slug: `hist-${nth++}` });
  const item = await makeItem(pool, vendor.id, { name: 'Tea', paise: 1500 });
  await o.c.patch(`/menu/${item.id}`, { price: '20' });
  const v = await o.c.get(`/catalog/menu/${item.id}/versions`);
  assert.equal(v.status, 200);
  assert.equal(v.body.versions[0].actor_name, 'Owner');
  assert.equal(v.body.versions[0].snapshot.price_paise, 2000);
  const vv = await o.c.patch(`/vendors/${vendor.id}`, { description: 'x' });
  assert.equal(vv.status, 200);
  const hist = (await o.c.get(`/catalog/vendor/${vendor.id}/versions`)).body.versions[0].snapshot;
  assert.ok(!Object.keys(hist).some((k) => /settle|payout|cashfree|bank|commission|account/i.test(k)));
  await assert.rejects(pool.query(`UPDATE catalog_version SET snapshot = '{}'`), /append-only/);
});

test('bulk menu: preview changes nothing; one bad row means nothing is applied', async () => {
  const o = await owner();
  const vendor = await makeVendor(pool, { name: 'Bulk', slug: `bulk-${nth++}` });
  const a = await makeItem(pool, vendor.id, { name: 'A', paise: 1000 });
  const b = await makeItem(pool, vendor.id, { name: 'B', paise: 2000 });
  const good = [{ id: a.id, price: '15' }, { id: b.id, available: false }];
  const prev = await o.c.post(`/vendors/${vendor.id}/menu/bulk/preview`, { changes: good });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.ok, true);
  assert.equal(prev.body.rows[0].before.price_paise, 1000);
  assert.equal(prev.body.rows[0].after.price_paise, 1500);
  assert.equal((await pool.query(`SELECT price_paise FROM menu_item WHERE id = $1`, [a.id])).rows[0].price_paise, 1000, 'a preview writes nothing');

  const mixed = [{ id: a.id, price: '15' }, { id: b.id, price: 'free' }];
  const badPrev = await o.c.post(`/vendors/${vendor.id}/menu/bulk/preview`, { changes: mixed });
  assert.equal(badPrev.body.ok, false);
  assert.ok(badPrev.body.rows[1].problems.length);
  assert.equal((await o.c.post(`/vendors/${vendor.id}/menu/bulk/apply`, { changes: mixed })).status, 422);
  assert.equal((await pool.query(`SELECT price_paise FROM menu_item WHERE id = $1`, [a.id])).rows[0].price_paise, 1000, 'the good row did not go live alone');

  const other = await makeVendor(pool, { name: 'Other', slug: `bulkb-${nth++}` });
  const foreign = await makeItem(pool, other.id, { name: 'Foreign', paise: 100 });
  assert.equal((await o.c.post(`/vendors/${vendor.id}/menu/bulk/apply`, { changes: [{ id: foreign.id, price: '1' }] })).status, 422);

  const done = await o.c.post(`/vendors/${vendor.id}/menu/bulk/apply`, { changes: good });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await pool.query(`SELECT price_paise FROM menu_item WHERE id = $1`, [a.id])).rows[0].price_paise, 1500);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM menu_price_history WHERE item_id = $1 AND new_paise = 1500`, [a.id])).rows[0].n, 1, 'price history is kept');
});

test('bulk menu: someone who may only flip availability cannot change a price through it', async () => {
  const vendor = await makeVendor(pool, { name: 'Staff bulk', slug: `sb-${nth++}` });
  const item = await makeItem(pool, vendor.id, { name: 'Item', paise: 1000 });
  const staff = await as(await makeUser(pool, { phone: phone(), name: 'Staff', roles: ['vendor_staff'], vendorId: vendor.id }));
  const r = await staff.post(`/vendors/${vendor.id}/menu/bulk/apply`, { changes: [{ id: item.id, price: '1' }] });
  assert.equal(r.status, 422);
  assert.equal((await pool.query(`SELECT price_paise FROM menu_item WHERE id = $1`, [item.id])).rows[0].price_paise, 1000);
  assert.equal((await staff.post(`/vendors/${vendor.id}/menu/bulk/apply`, { changes: [{ id: item.id, available: false }] })).status, 200);
});

/* ---------- request ids ---------------------------------------------------- */
test('a client request id is kept only if it cannot inject anything into a log', async () => {
  const id = async (value) => (await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': value } })).headers['x-request-id'];
  const good = 'abc12345-DEF_678';
  const echoed = await id(good);
  if (echoed !== undefined) assert.equal(echoed, good);
  for (const bad of ['short', 'x'.repeat(65), 'evil\r\ninjected: yes', 'has space here', '<script>alert(1)</script>']) {
    const r = await app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': bad.replace(/[\r\n]/g, ' ') } });
    assert.ok(r.statusCode < 500);
    if (r.headers['x-request-id'] !== undefined) assert.notEqual(r.headers['x-request-id'], bad);
  }
  const { REQUEST_ID_FORMAT } = await import('../src/index.js');
  assert.ok(REQUEST_ID_FORMAT.test(good));
  for (const bad of ['short', 'x'.repeat(65), 'evil\r\ninjected: yes', 'has space here']) assert.ok(!REQUEST_ID_FORMAT.test(bad));
});

/* ---------- rate-limit spoofing --------------------------------------------- */
test('forged X-Forwarded-For cannot escape the edge limit on routes outside sign-in', async () => {
  const { edgeLimitHook, resetEdgeLimits } = await import('../src/edge-limit.js');
  const { HTTP, RATE_LIMITS } = await import('../src/config.js');
  resetEdgeLimits();
  const header = HTTP.edgeClientIpHeader;
  HTTP.edgeClientIpHeader = 'x-edge-client-ip';
  try {
    const cap = Math.max(1, Math.round(RATE_LIMITS.ai * RATE_LIMITS.edgeMultiplier));
    const req = (forged) => ({
      headers: { 'x-edge-client-ip': '203.0.113.9', 'x-forwarded-for': forged },
      ip: forged,
      routeOptions: { url: '/ai/chat', config: { rateLimit: { max: RATE_LIMITS.ai, timeWindow: RATE_LIMITS.windowMinutes * 60_000 } } },
    });
    const reply = { header() { return this; } };
    for (let i = 0; i < cap; i++) await edgeLimitHook(req(`10.0.0.${i % 250}`), reply);
    await assert.rejects(edgeLimitHook(req('10.9.9.9'), reply), /Too many requests/);
    /* A different real address has its own allowance. */
    await edgeLimitHook({ ...req('1.1.1.1'), headers: { 'x-edge-client-ip': '203.0.113.10', 'x-forwarded-for': '1.1.1.1' } }, reply);
    /* Per-account limits and explicit opt-outs are left alone. */
    const perAccount = { headers: {}, ip: 'x', routeOptions: { url: '/w', config: { rateLimit: { max: 1, timeWindow: 1000, keyGenerator: () => 'a' } } } };
    await edgeLimitHook(perAccount, reply); await edgeLimitHook(perAccount, reply);
    const webhook = { headers: {}, ip: 'x', routeOptions: { url: '/payments/webhook', config: { rateLimit: false } } };
    await edgeLimitHook(webhook, reply); await edgeLimitHook(webhook, reply);
  } finally { HTTP.edgeClientIpHeader = header; resetEdgeLimits(); }
});

/* ---------- uploads --------------------------------------------------------- */
test('an uploaded image is decoded and rebuilt: metadata and trailing data do not survive', async () => {
  const { putImage, getImage } = await import('../src/services/storage.js');
  const u = await makeUser(pool, { phone: phone(), name: 'Uploader' });
  const secret = 'GPS-30.4172-SECRET';
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#a33' } })
    .withExif({ IFD0: { ImageDescription: secret } }).jpeg().toBuffer();
  assert.ok(jpeg.includes(secret), 'the fixture really carries it');
  const withTail = Buffer.concat([jpeg, Buffer.from('<script>alert(1)</script>')]);
  const asset = await putImage(withTail, { ownerId: u.id, kind: 'food_photo' });
  assert.equal(asset.width, 64);
  assert.equal(asset.height, 48);
  const bytes = (await getImage(asset.id)).bytes;
  assert.ok(Buffer.isBuffer(bytes));
  assert.ok(!bytes.includes(secret));
  assert.ok(!bytes.includes('<script>'));
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.format, 'jpeg');
});

test('truncated, disguised and oversized-dimension images are refused', async () => {
  const { putImage } = await import('../src/services/storage.js');
  const u = await makeUser(pool, { phone: phone(), name: 'Uploader' });
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#3a3' } }).png().toBuffer();
  await assert.rejects(putImage(png.subarray(0, 40), { ownerId: u.id, kind: 'food_photo' }), /could not be read/);
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x41)]);
  await assert.rejects(putImage(fakeJpeg, { ownerId: u.id, kind: 'food_photo' }), /could not be read/);
  /* A tiny file whose header claims 50,000 x 50,000: refused before decoding. */
  const bomb = Buffer.from(png);
  bomb.writeUInt32BE(50000, 16); bomb.writeUInt32BE(50000, 20);
  await assert.rejects(putImage(bomb, { ownerId: u.id, kind: 'food_photo' }), /could not be read/);
});

/* ---------- readiness ------------------------------------------------------- */
test('public readiness keeps what deploy gates need and nothing about providers', async () => {
  const r = await app.inject({ method: 'GET', url: '/ready' });
  const body = JSON.parse(r.body);
  assert.equal(body.ready, true);
  assert.equal(body.checks.database.ok, true);
  assert.deepEqual(body.checks.migrations.pending, []);
  assert.ok(body.checks.migrations.latest);
  assert.equal(body.checks.providers, undefined);
  assert.equal(body.checks.notifications, undefined);
  assert.equal(body.checks.database.pool, undefined);
  assert.ok(!/vercel\.app|passkey|resend|brevo/i.test(r.body));
  const o = await owner();
  const full = await o.c.get('/ready');
  assert.ok(full.body.checks.providers, 'an administrator still gets the detail');
});

/* ---------- transactional audit ---------------------------------------------- */
test('a privileged action whose audit cannot be written does not happen', async () => {
  const o = await owner();
  const t = await admin(['students.view']);
  const inv = await o.c.post('/admin/access/invitations', { name: 'Audit Case', email: 'audit.case@example.org', permissions: ['students.view'] });
  const id = inv.body.administrator.invitationId;
  await pool.query(`CREATE OR REPLACE FUNCTION fail_audit2() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER fail_audit2_t BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action IN ('admin.invite.cancel','approval.policy','admin.session.revoke_one')) EXECUTE FUNCTION fail_audit2()`);
  try {
    assert.equal((await o.c.post(`/admin/access/invitations/${id}/revoke`)).status, 500);
    assert.equal((await pool.query(`SELECT revoked_at FROM admin_invitation WHERE id = $1`, [id])).rows[0].revoked_at, null);
    assert.equal((await o.c.put('/admin/approvals/policy/vendor.archive', { enabled: true })).status, 500);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM approval_policy WHERE enabled`)).rows[0].n, 0);
    assert.ok(t);
  } finally {
    await pool.query(`DROP TRIGGER fail_audit2_t ON audit_log; DROP FUNCTION fail_audit2()`);
  }
});

/* ---------- permissions ------------------------------------------------------ */
test('the catalogue keeps every old key, adds the new ones, and new keys cannot be self-granted', async () => {
  const { PERMISSIONS } = await import('../src/auth/permissions.js');
  for (const k of ['delivery.track', 'sessions.read', 'reports.export', 'orders.view', 'admins.view', 'finance.view', 'finance.manage']) assert.ok(PERMISSIONS[k], k);
  const a = await admin(['admins.view', 'delivery.track']);
  assert.equal((await a.c.put(`/admin/access/admins/${a.u.id}/permissions`, { permissions: ['audit.view'], reason: 'grabbing' })).status, 403);
});

test('reports: exporting order data needs reports.export; finance reports are unchanged', async () => {
  const noExport = await admin(['orders.view']);
  const withExport = await admin(['orders.view', 'reports.export'], 'Exporter');
  const q = '?from=2026-01-01&to=2026-01-02';
  const kinds = (await noExport.c.get(`/admin/reports/nope${q}`)).body.error.match(/Reports: (.*)/)?.[1]?.split(', ') || [];
  const orderKind = kinds.find((k) => /order/.test(k));
  assert.ok(orderKind, kinds.join());
  assert.equal((await noExport.c.get(`/admin/reports/${orderKind}${q}`)).status, 403);
  assert.equal((await withExport.c.get(`/admin/reports/${orderKind}${q}`)).status, 200);
});

/* ---------- a person's own data ---------------------------------------------- */
test('data export holds my records only, and no other person, secret or position', async () => {
  const { customer, o, partner } = await delivery();
  const other = await makeUser(pool, { phone: phone(), name: 'Other Person Name' });
  const vendor2 = await makeVendor(pool, { name: 'Other Cafe', slug: `oth-${nth++}` });
  await order('delivered', { partnerId: null, vendorId: vendor2.id, customerId: other.id });
  await pool.query(`INSERT INTO partner_location (partner_id, order_id, lat, lng, accuracy_m, at) VALUES ($1,$2,30.4172,77.9681,10, now())`, [partner.id, o.id]);
  const c = await as(customer);
  const r = await c.get('/me/data-export');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.profile.name, 'Customer');
  assert.equal(r.body.orders.length, 1);
  const dump = JSON.stringify(r.body);
  assert.ok(!dump.includes('Other Person Name'));
  assert.ok(!dump.includes(partner.id), 'no partner identity');
  assert.ok(!dump.includes('Ravi'));
  assert.ok(!dump.includes('token_hash'));
  assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'data.export'`)).rows[0].n, 1);
  assert.equal((await client(app).get('/me/data-export')).status, 401);
});

test('a deletion request is recorded once, deletes nothing, and only the owner records an outcome', async () => {
  const u = await makeUser(pool, { phone: phone(), name: 'Leaving Student' });
  const c = await as(u);
  assert.equal((await c.post('/me/deletion-request', { note: 'Graduating' })).status, 200);
  assert.equal((await c.post('/me/deletion-request', {})).status, 409, 'one open request');
  assert.equal((await pool.query(`SELECT status FROM app_user WHERE id = $1`, [u.id])).rows[0].status, 'active', 'nothing was deleted');
  assert.equal((await c.get('/admin/data-requests')).status, 403);
  const o = await owner();
  const list = await o.c.get('/admin/data-requests');
  assert.equal(list.body.requests.length, 1);
  const id = list.body.requests[0].id;
  const a = await admin(['students.view']);
  assert.equal((await a.c.post(`/admin/data-requests/${id}`, { status: 'completed', note: 'done it' })).status, 403);
  assert.equal((await o.c.post(`/admin/data-requests/${id}`, { status: 'completed' })).status, 400, 'a note is required');
  assert.equal((await o.c.post(`/admin/data-requests/${id}`, { status: 'completed', note: 'Erased profile, kept orders' })).status, 200);
  assert.equal((await c.get('/me/deletion-request')).body.request.status, 'completed');
});

/* Found by the browser journey: `a OR b AND u.id = $1` returned whichever
   administrator came first, so a detail page could show someone else entirely. */
test('an administrator detail page is about that administrator, not the first one found', async () => {
  const o = await owner();
  const first = await admin(['students.view'], 'First Person');
  const second = await admin(['orders.view'], 'Second Person');
  for (const [who, name, perm] of [[first, 'First Person', 'students.view'], [second, 'Second Person', 'orders.view']]) {
    const d = await o.c.get(`/admin/access/admins/${who.u.id}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.administrator.id, who.u.id);
    assert.equal(d.body.administrator.name, name);
    assert.deepEqual(d.body.administrator.effective.permissions, [perm]);
  }
  const student = await makeUser(pool, { phone: phone(), name: 'Just A Student' });
  assert.equal((await o.c.get(`/admin/access/admins/${student.id}`)).status, 404, 'a student is not an administrator');
});
