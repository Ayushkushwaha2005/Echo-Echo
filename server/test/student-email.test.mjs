/* ==========================================================================
   STUDENT VERIFICATION BY INSTITUTIONAL EMAIL — end to end.

   The only thing replaced is the email provider: RESEND_BASE_URL points at a
   stub HTTP server in this process that records what would have been mailed,
   so the test reads the code out of the "mailbox" exactly as a student would.
   Routes, service, session cookie and database are all production code.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startDb, stopDb, truncateAll, makeVendor, makeItem, makeUser, makeCampus } from './helpers/db.mjs';
import { makeApp, client, sessionFor } from './helpers/api.mjs';

let app, pool, stub, stubMode = 'ok';
const mailbox = [];

before(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      mailbox.push({ ...body, auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (stubMode === 'echo500') { res.statusCode = 500; return res.end(`bad: ${raw}`); }
      res.end(JSON.stringify({ id: `msg-${mailbox.length}` }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));

  await startDb();
  Object.assign(process.env, {
    PLATFORM_OWNER_PHONE: '+919000000000',
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    OTP_PROVIDER: '',
    EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'ECHO ECHO <verify@echo.test>',
    RESEND_BASE_URL: `http://127.0.0.1:${stub.address().port}`,
  });
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); stub?.close(); });
beforeEach(async () => { await truncateAll(pool); mailbox.length = 0; stubMode = 'ok'; });

const anon = () => client(app);
const codeMailedTo = (email) => {
  const m = [...mailbox].reverse().find((b) => b.to?.[0] === email);
  return m?.text.match(/code is: (\d{6})/)?.[1];
};
const cookieOf = (res) => {
  const raw = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('quad_session='));
  return raw ? raw.split(';')[0].split('=')[1] : null;
};
const age = (email, seconds) => pool.query(
  `UPDATE email_challenge SET created_at = created_at - ($2 || ' seconds')::interval WHERE email = $1`,
  [email, String(seconds)]);
const signIn = async (email) => {
  assert.equal((await anon().post('/auth/email/send', { email })).status, 200);
  const r = await anon().post('/auth/email/verify', { email, code: codeMailedTo(email.toLowerCase()) });
  return { r, token: cookieOf(r) };
};

/* The live-location step that follows sign-in. Uses the real endpoint against
   the fixture boundary, so it exercises the same check the browser does. */
const confirmOnCampus = async (token) => {
  const r = await client(app, token).post('/campus/presence',
    { lat: 30.42, lng: 77.97, accuracy: 8 });
  assert.equal(r.status, 200, `presence check failed: ${JSON.stringify(r.body)}`);
  return r;
};

test('without SMS: a student signs in by proving control of their @stu.upes.ac.in mailbox', async () => {
  const email = 'ayush.17551@stu.upes.ac.in';
  const sent = await anon().post('/auth/email/send', { email: '  Ayush.17551@STU.UPES.AC.IN ' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.email, email, 'normalised to lower case');
  assert.ok(!JSON.stringify(sent.body).match(/\b\d{6}\b/), 'the code is never returned to the browser');
  assert.equal(mailbox.length, 1);
  assert.deepEqual(mailbox[0].to, [email], 'sent to exactly that address');

  const code = codeMailedTo(email);
  assert.match(code, /^\d{6}$/);
  const ok = await anon().post('/auth/email/verify', { email, code });
  assert.equal(ok.status, 200);
  const token = cookieOf(ok);
  assert.ok(token, 'session only after verification');
  assert.equal(ok.body.verification.state, 'VERIFIED');

  const me = await client(app, token).get('/auth/me');
  assert.deepEqual(me.body.roles, ['student']);
  assert.equal(me.body.user.studentEmail, email);
  assert.equal(me.body.user.phone, null);
  assert.equal(me.body.verificationStatus.state, 'VERIFIED');

  const row = (await pool.query(`SELECT * FROM verification_case WHERE user_id = $1`, [me.body.user.id])).rows[0];
  assert.equal(row.method, 'institutional_email');
  assert.equal(row.state, 'approved');
});

test('only the exact institutional domain is accepted — nothing is sent anywhere else', async () => {
  for (const email of [
    'a.1@gmail.com', 'a.1@outlook.com', 'a.1@upes.ac.in', 'a.1@stu.upes.ac.in.evil.com',
    'a.1@x.stu.upes.ac.in', 'a.1@stu-upes.ac.in', 'a.1@stu.upes.ac.in.', 'a.1@stu.upes.ac',
    'a+tag@stu.upes.ac.in', '"a"@stu.upes.ac.in', 'a@b@stu.upes.ac.in', 'а.1@stu.upes.ac.in' /* Cyrillic a */,
    'a..b@stu.upes.ac.in', '.a@stu.upes.ac.in', '@stu.upes.ac.in', 'a.1@[127.0.0.1]', '', null,
    'a.1@mailinator.com',
  ]) {
    const r = await anon().post('/auth/email/send', { email });
    assert.equal(r.status, 400, `must refuse ${JSON.stringify(email)}`);
  }
  assert.equal(mailbox.length, 0, 'no email was sent for any refused address');
});

test('the code is stored only as a keyed hash, and cannot be replayed', async () => {
  const email = 'r.1@stu.upes.ac.in';
  await anon().post('/auth/email/send', { email });
  const code = codeMailedTo(email);
  const row = (await pool.query(`SELECT * FROM email_challenge WHERE email = $1`, [email])).rows[0];
  assert.ok(!JSON.stringify(row).includes(`"${code}"`));
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);

  assert.equal((await anon().post('/auth/email/verify', { email, code })).status, 200);
  const again = await anon().post('/auth/email/verify', { email, code });
  assert.notEqual(again.status, 200);
  assert.equal(cookieOf(again), null);
});

test('an expired code signs nobody in', async () => {
  const email = 'e.1@stu.upes.ac.in';
  await anon().post('/auth/email/send', { email });
  await pool.query(`UPDATE email_challenge SET expires_at = now() - interval '1 second' WHERE email = $1`, [email]);
  const r = await anon().post('/auth/email/verify', { email, code: codeMailedTo(email) });
  assert.equal(r.status, 400);
  assert.equal(cookieOf(r), null);
});

test('brute force: five wrong guesses kill the code, and a parallel burst cannot exceed the ceiling', async () => {
  const email = 'b.1@stu.upes.ac.in';
  await anon().post('/auth/email/send', { email });
  const code = codeMailedTo(email);
  const guesses = Array.from({ length: 50 }, (_, k) => String((Number(code) + 1 + k) % 1e6).padStart(6, '0'));
  const results = await Promise.all(guesses.map((g) => anon().post('/auth/email/verify', { email, code: g })));
  assert.ok(results.every((r) => r.status !== 200));
  const row = (await pool.query(`SELECT attempts, max_attempts FROM email_challenge WHERE email = $1`, [email])).rows[0];
  assert.ok(row.attempts <= row.max_attempts);
  assert.notEqual((await anon().post('/auth/email/verify', { email, code })).status, 200, 'the right code is dead too');
});

test('resend cooldown, hourly cap, and a parallel burst sends exactly one email', async () => {
  const email = 'c.1@stu.upes.ac.in';
  const burst = await Promise.all(Array.from({ length: 10 }, () => anon().post('/auth/email/send', { email })));
  assert.equal(burst.filter((r) => r.status === 200).length, 1);
  assert.equal(mailbox.length, 1);
  assert.equal((await anon().post('/auth/email/send', { email })).status, 429, 'cooldown');
  for (let k = 0; k < 4; k++) { await age(email, 70); assert.equal((await anon().post('/auth/email/send', { email })).status, 200); }
  await age(email, 70);
  assert.equal((await anon().post('/auth/email/send', { email })).status, 429, 'hourly cap of 5');
});

test('a new code supersedes the previous one', async () => {
  const email = 's.1@stu.upes.ac.in';
  await anon().post('/auth/email/send', { email });
  const first = codeMailedTo(email);
  await age(email, 70);
  await anon().post('/auth/email/send', { email });
  const second = codeMailedTo(email);
  if (first !== second) {
    assert.notEqual((await anon().post('/auth/email/verify', { email, code: first })).status, 200);
  }
  assert.equal((await anon().post('/auth/email/verify', { email, code: second })).status, 200);
});

test("one mailbox's code does not open another mailbox's account", async () => {
  const a = 'x.1@stu.upes.ac.in', b = 'y.1@stu.upes.ac.in';
  await anon().post('/auth/email/send', { email: a });
  await anon().post('/auth/email/send', { email: b });
  const cross = await anon().post('/auth/email/verify', { email: b, code: codeMailedTo(a) });
  if (codeMailedTo(a) !== codeMailedTo(b)) assert.notEqual(cross.status, 200);
});

test('signing in again with the same mailbox reaches the same account', async () => {
  const email = 'same.1@stu.upes.ac.in';
  const one = await signIn(email);
  await age(email, 70);
  const two = await signIn(email);
  assert.equal(one.r.body.user.id, two.r.body.user.id);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM app_user WHERE student_email=$1`, [email])).rows[0].n, 1);
});

test('the database refuses a second account for the same mailbox', async () => {
  await signIn('dup.1@stu.upes.ac.in');
  await assert.rejects(pool.query(
    `INSERT INTO app_user (student_email, student_email_verified_at) VALUES ('dup.1@stu.upes.ac.in', now())`));
  await assert.rejects(pool.query(`INSERT INTO app_user (name) VALUES ('no identity')`),
    'an account with neither phone nor proven mailbox is unrepresentable');
});

test('a phone-login account links its mailbox; the code is bound to that account', async () => {
  const u = await makeUser(pool, { phone: '+919811100001', name: 'P', studentStatus: 'unverified' });
  const other = await makeUser(pool, { phone: '+919811100002', name: 'Q', studentStatus: 'unverified' });
  const c = client(app, await sessionFor(pool, u.id));
  const o = client(app, await sessionFor(pool, other.id));
  const email = 'link.1@stu.upes.ac.in';

  assert.equal((await c.post('/verification/email/send', { email })).status, 200);
  const code = codeMailedTo(email);
  const stolen = await o.post('/verification/email/verify', { email, code });
  assert.notEqual(stolen.status, 200, "another account cannot redeem this account's code");

  const ok = await c.post('/verification/email/verify', { email, code });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verification.state, 'VERIFIED');

  await age(email, 70);
  const again = await o.post('/verification/email/send', { email });
  assert.equal(again.status, 409, 'a mailbox already verified elsewhere cannot be linked again');
});

test('a verified-by-email student can order; admin decisions are never overridden by a code', async () => {
  const { token } = await signIn('order.1@stu.upes.ac.in');
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco' });
  const i = await makeItem(pool, v.id, { name: 'Tea', paise: 2000 });
  const s = client(app, token);
  const body = { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'delivery', destinationId: n.blockB.id };
  /* Signing in is not the same as being on campus. A brand-new session has
     not passed the live-location check, and ordering says so first. */
  const noLocation = await s.post('/orders/draft', body);
  assert.equal(noLocation.status, 403);
  assert.equal(noLocation.body.code, 'location_required');
  await confirmOnCampus(token);

  /* Verified and on campus, but the profile is not complete yet: the server
     says what is missing. */
  const early = await s.post('/orders/draft', body);
  assert.equal(early.status, 403);
  assert.match(early.body.error, /Complete your profile/);
  assert.match(early.body.detail, /full name.*campus/);
  const bidholi = (await s.get('/campuses')).body.campuses.find((c) => c.name === 'Bidholi Campus');
  assert.equal((await s.put('/me/profile', { name: 'Order Student', contactPhone: '9812345670', campusId: bidholi.id })).status, 200);
  const draft = await s.post('/orders/draft', body);
  assert.equal(draft.status, 200, 'campus-bound ordering works for an email-verified student');

  for (const [status, expect] of [['rejected', 'REJECTED'], ['suspended', 'SUSPENDED']]) {
    const email = `${status}.1@stu.upes.ac.in`;
    await pool.query(
      `INSERT INTO app_user (student_email, student_email_verified_at, student_status) VALUES ($1, now(), $2)`,
      [email, status]);
    const { r } = await signIn(email);
    assert.equal(r.body.verification.state, expect, `${status} stays ${status}`);
  }
});

test('typing a student address proves nothing: no code, no session, no verification', async () => {
  const email = 'typed.only@stu.upes.ac.in';
  assert.equal((await anon().post('/auth/email/send', { email })).status, 200);
  /* Someone who does not read that mailbox has no code to give back. */
  for (const code of ['000000', '123456', '999999']) {
    const r = await anon().post('/auth/email/verify', { email, code });
    assert.equal(r.status, 400);
    assert.equal(cookieOf(r), null);
  }
  const u = await pool.query(`SELECT count(*)::int n FROM app_user WHERE student_email = $1`, [email]);
  assert.equal(u.rows[0].n, 0, 'no account exists until the mailbox is proven');
  /* The code went to that exact address and nowhere else. */
  assert.deepEqual(mailbox.map((m) => m.to), [[email]]);
});

test('optional re-proof window: stale mailbox proof blocks ordering until the mailbox is proven again', async () => {
  const cfg = await import('../src/config.js');
  cfg.STUDENT_EMAIL.reverifyDays = 30;
  try {
    const email = 'fresh.1@stu.upes.ac.in';
    const { token } = await signIn(email);
    const n = await makeCampus(pool);
    const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco' });
    const i = await makeItem(pool, v.id, { name: 'Tea', paise: 2000 });
    const s = client(app, token);
    const bidholi = (await s.get('/campuses')).body.campuses.find((c) => c.name === 'Bidholi Campus');
    await s.put('/me/profile', { name: 'Fresh Student', contactPhone: '9812345671', campusId: bidholi.id });
    await confirmOnCampus(token);
    const body = { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'delivery', destinationId: n.blockB.id };
    assert.equal((await s.post('/orders/draft', body)).status, 200, 'fresh proof orders');

    await pool.query(`UPDATE app_user SET student_email_verified_at = now() - interval '40 days' WHERE student_email = $1`, [email]);
    const stale = await s.post('/orders/draft', body);
    assert.equal(stale.status, 403);
    assert.equal(stale.body.code, 'reverify_email');

    await age(email, 120);
    const again = await signIn(email);
    await confirmOnCampus(again.token);
    assert.equal((await client(app, again.token).post('/orders/draft', body)).status, 200, 'a new mailbox proof renews it');
  } finally {
    cfg.STUDENT_EMAIL.reverifyDays = 0;
  }
});

test('an account-suspended user gets no session and no status change from a code', async () => {
  const email = 'banned.1@stu.upes.ac.in';
  await pool.query(
    `INSERT INTO app_user (student_email, student_email_verified_at, status) VALUES ($1, now(), 'suspended')`, [email]);
  const { r, token } = await signIn(email);
  assert.equal(r.status, 403);
  assert.equal(token, null);
  const row = (await pool.query(`SELECT student_status FROM app_user WHERE student_email=$1`, [email])).rows[0];
  assert.equal(row.student_status, 'unverified');
});

test('no ID card: a manual request carries no document and cannot be approved without recorded evidence', async () => {
  const stu = await makeUser(pool, { phone: '+919811100010', name: 'NoCard', studentStatus: 'unverified' });
  const admin = await makeUser(pool, { phone: '+919811100011', name: 'Admin', roles: ['platform_admin'] });
  const s = client(app, await sessionFor(pool, stu.id));
  const a = client(app, await sessionFor(pool, admin.id));

  assert.equal((await s.post('/verification/manual', { name: 'No Card', roll: '500012345' })).status, 400,
    'a reason is required');
  const req = await s.post('/verification/manual',
    { name: 'No Card', roll: '500012345', note: 'Lost my card and my mailbox is locked' });
  assert.equal(req.status, 200);
  assert.equal(req.body.verification.state, 'PENDING_ADMIN_REVIEW');

  const self = await s.post(`/admin/verification/${req.body.id}/decide`, { decision: 'approve', note: 'I am a student really' });
  assert.equal(self.status, 403, 'a student cannot decide their own case');

  const bare = await a.post(`/admin/verification/${req.body.id}/decide`, { decision: 'approve' });
  assert.equal(bare.status, 400, 'approval without evidence is refused');
  await assert.rejects(pool.query(
    `UPDATE verification_case SET state='approved', decision_note=NULL WHERE id=$1`, [req.body.id]),
    'and the database refuses it too');

  const ok = await a.post(`/admin/verification/${req.body.id}/decide`,
    { decision: 'approve', note: 'Confirmed enrolment with the programme office by phone' });
  assert.equal(ok.status, 200);
  const me = await s.get('/auth/me');
  assert.equal(me.body.verificationStatus.state, 'VERIFIED');
});

test('admin can suspend and reinstate verification; suspension blocks ordering immediately', async () => {
  const { token, r } = await signIn('susp.1@stu.upes.ac.in');
  const admin = await makeUser(pool, { phone: '+919811100021', name: 'Admin', roles: ['platform_admin'] });
  const a = client(app, await sessionFor(pool, admin.id));
  const s = client(app, token);

  const sus = await a.post(`/admin/users/${r.body.user.id}/student-verification`, { action: 'suspend', note: 'Reported misuse' });
  assert.equal(sus.status, 200);
  assert.equal(sus.body.verification.state, 'SUSPENDED');

  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'Tea', paise: 2000 });
  const draft = await s.post('/orders/draft', { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' });
  assert.equal(draft.status, 403);

  assert.equal((await s.post('/verification/manual', { name: 'X Y', roll: '12345', note: 'please reinstate me' })).status, 403);

  const back = await a.post(`/admin/users/${r.body.user.id}/student-verification`, { action: 'reinstate', note: 'Resolved' });
  assert.equal(back.body.verification.state, 'VERIFIED', 'reinstated to what the mailbox proof supports');
});

test('admin-review policy: mailbox proof opens a review case instead of verifying', async () => {
  const { STUDENT_EMAIL } = await import('../src/config.js');
  STUDENT_EMAIL.emailRequiresAdminReview = true;
  try {
    const { r, token } = await signIn('review.1@stu.upes.ac.in');
    assert.equal(r.body.verification.state, 'PENDING_ADMIN_REVIEW');
    const v = await makeVendor(pool, { name: 'F', slug: 'f2' });
    const i = await makeItem(pool, v.id, { name: 'Tea', paise: 2000 });
    const d = await client(app, token).post('/orders/draft', { vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' });
    assert.equal(d.status, 403);
    const k = (await pool.query(`SELECT method, state FROM verification_case WHERE user_id=$1`, [r.body.user.id])).rows[0];
    assert.deepEqual(k, { method: 'institutional_email', state: 'pending' });
  } finally {
    STUDENT_EMAIL.emailRequiresAdminReview = false;
  }
});

test('a provider error never carries the code into an error, and leaves no live code', async () => {
  stubMode = 'echo500';
  const email = 'err.1@stu.upes.ac.in';
  const r = await anon().post('/auth/email/send', { email });
  /* A generic, retryable 503 - never the provider's status or body. */
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'email_unavailable');
  assert.ok(!JSON.stringify(r.body).match(/\b\d{6}\b/));
  assert.ok(!JSON.stringify(r.body).match(/bad:|resend/i));
  assert.equal((await pool.query(`SELECT count(*)::int n FROM email_challenge`)).rows[0].n, 0);
});

test('contact phone is contact data only — it never becomes a login identity', async () => {
  const { token, r } = await signIn('phone.1@stu.upes.ac.in');
  const s = client(app, token);
  assert.equal((await s.post('/auth/me/contact-phone', { phone: '9812345678' })).status, 200);
  const row = (await pool.query(`SELECT phone, contact_phone FROM app_user WHERE id=$1`, [r.body.user.id])).rows[0];
  assert.equal(row.phone, null);
  assert.equal(row.contact_phone, '+919812345678');
});
