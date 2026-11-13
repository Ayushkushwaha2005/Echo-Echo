/* ==========================================================================
   ECHO ECHO — CONTINUE WITH MICROSOFT

   The whole flow runs through the real Fastify stack and the real database.
   Only Microsoft is replaced: its token and key endpoints are answered by a
   local stand-in that signs ID tokens with a key generated here, exactly as
   Entra signs them with its own. Nothing in the server has a test path; the
   signature, issuer, tenant, audience, expiry and nonce checks below are the
   production checks.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, randomUUID } from 'node:crypto';
import { startDb, stopDb, truncateAll } from './helpers/db.mjs';
import { makeApp } from './helpers/api.mjs';

const TENANT = '0b5e1f9a-7c3d-4e2a-9f10-1234567890ab';   // a test tenant, not a real one
const CLIENT = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const CONSUMER = '9188040d-6c67-4c5b-b112-36a304b66dad';
const ISS = `https://login.microsoftonline.com/${TENANT}/v2.0`;

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig' };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(claims, { key = privateKey, kid = KID, alg = 'RS256' } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const sig = cryptoSign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

let pool, app, oidc, realFetch;
/* What the stand-in token endpoint answers next. */
let tokenReply;

test.before(async () => {
  await startDb();
  Object.assign(process.env, {
    COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long',
    MICROSOFT_TENANT_ID: TENANT,
    MICROSOFT_CLIENT_ID: CLIENT,
    MICROSOFT_CLIENT_SECRET: 'test-only-secret',
    MICROSOFT_REDIRECT_URI: 'http://localhost:3000/api/auth/microsoft/callback',
    STUDENT_EMAIL_DOMAINS: 'stu.upes.ac.in',
    RL_EMAIL_SEND: '100000',
    PLATFORM_OWNER_EMAIL: 'owner@stu.upes.ac.in',
  });
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`) {
      return new Response(JSON.stringify({ keys: [JWK] }), { status: 200 });
    }
    if (u === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('client_secret'), 'test-only-secret');
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.ok(form.get('code_verifier')?.length >= 43, 'PKCE verifier is sent');
      return tokenReply(form);
    }
    if (u.startsWith('https://login.microsoftonline.com/')) throw new Error(`unexpected Microsoft call ${u}`);
    return realFetch(url, init);
  };
  ({ pool } = await import('../src/db/index.js'));
  oidc = await import('../src/services/microsoft-oidc.js');
  app = await makeApp();
});
test.after(async () => { globalThis.fetch = realFetch; await app?.close(); await pool?.end(); await stopDb(); });
test.beforeEach(async () => { await truncateAll(pool); await pool.query('TRUNCATE oauth_login_attempt'); });

const cookieFrom = (res, name) => {
  const all = [].concat(res.headers['set-cookie'] || []);
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0].slice(name.length + 1) : null;
};
const msReason = (res) => new URL(res.headers.location).searchParams.get('ms');

/* Presses the button and returns what the browser would carry back. */
async function start() {
  const res = await app.inject({ method: 'GET', url: '/auth/microsoft/start' });
  assert.equal(res.statusCode, 302);
  const to = new URL(res.headers.location);
  return { res, to, state: to.searchParams.get('state'), nonce: to.searchParams.get('nonce'),
           bind: cookieFrom(res, 'quad_ms_bind') };
}

function claimsFor(nonce, over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { ver: '2.0', iss: ISS, tid: TENANT, aud: CLIENT, iat: now, nbf: now, exp: now + 3600,
           nonce, oid: randomUUID(), preferred_username: 'ayush.17551@stu.upes.ac.in', name: 'Test Student', ...over };
}

/* Start, have Microsoft "issue" a token for `claims(nonce)`, and come back. */
async function signIn(claims = (n) => claimsFor(n), { tokenOpts, keepBind = true, mutateState } = {}) {
  const s = await start();
  tokenReply = () => new Response(JSON.stringify({ id_token: idToken(claims(s.nonce), tokenOpts) }), { status: 200 });
  const state = mutateState ? mutateState(s.state) : s.state;
  const res = await app.inject({
    method: 'GET', url: `/auth/microsoft/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: keepBind && s.bind ? { cookie: `quad_ms_bind=${s.bind}` } : {},
  });
  return { ...s, cb: res, reason: msReason(res), session: cookieFrom(res, 'quad_session') };
}

const users = async () => (await pool.query('SELECT * FROM app_user ORDER BY created_at')).rows;

/* ---------------------------------------------------------------------- */

test('start: tenant-pinned authorize URL with state, nonce and S256 PKCE; nothing secret in it', async () => {
  const { to, state, nonce, bind } = await start();
  assert.equal(to.origin + to.pathname, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
  assert.equal(to.searchParams.get('client_id'), CLIENT);
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(to.searchParams.get('code_challenge'));
  assert.equal(to.searchParams.get('response_type'), 'code');
  assert.ok(state && nonce && bind);
  assert.ok(!to.toString().includes('test-only-secret'));
  const row = (await pool.query('SELECT * FROM oauth_login_attempt')).rows[0];
  assert.notEqual(row.state_hash, state, 'state is stored hashed');
});

test('1. a valid @stu.upes.ac.in member signs in, gets a verified student account and a session', async () => {
  const r = await signIn();
  assert.equal(r.reason, 'ok');
  assert.ok(r.session);
  const [u] = await users();
  assert.equal(u.student_email, 'ayush.17551@stu.upes.ac.in');
  assert.equal(u.student_status, 'approved');
  assert.equal(u.microsoft_tid, TENANT);
  const s = (await pool.query('SELECT auth_method FROM session WHERE user_id = $1', [u.id])).rows[0];
  assert.equal(s.auth_method, 'microsoft');
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: `quad_session=${r.session}` } });
  assert.equal(me.json().authenticated, true);
  assert.deepEqual(me.json().roles, ['student']);
  const ok = (await pool.query(`SELECT detail FROM audit_log WHERE action = 'auth.login' AND outcome = 'ok'`)).rows[0];
  assert.equal(ok.detail.via, 'microsoft');
});

test('upper-case UPN is normalised to the same account', async () => {
  await signIn((n) => claimsFor(n, { preferred_username: 'Ayush.17551@STU.UPES.AC.IN' }));
  const [u] = await users();
  assert.equal(u.student_email, 'ayush.17551@stu.upes.ac.in');
});

for (const [label, upn] of [
  ['2. Gmail', 'student@gmail.com'],
  ['3. Outlook', 'student@outlook.com'],
  ['3. Hotmail', 'student@hotmail.com'],
  ['4. staff domain upes.ac.in', 'student@upes.ac.in'],
  ['4. lookalike suffix', 'student@stu.upes.ac.in.attacker.com'],
  ['4. lookalike subdomain', 'student@evil.stu.upes.ac.in'],
  ['4. lookalike prefix', 'student@xstu.upes.ac.in'],
]) {
  test(`${label} is refused: no account, no session`, async () => {
    const r = await signIn((n) => claimsFor(n, { preferred_username: upn }));
    assert.equal(r.reason, 'not_student');
    assert.equal(r.session, null);
    assert.equal((await users()).length, 0);
  });
}

test('a verified-looking `email` claim is ignored: only the tenant UPN counts', async () => {
  const r = await signIn((n) => claimsFor(n, { preferred_username: 'someone@gmail.com',
    email: 'ayush.17551@stu.upes.ac.in', xms_edov: true }));
  assert.equal(r.reason, 'not_student');
  assert.equal((await users()).length, 0);
});

test('3. a personal Microsoft account (consumer tenant) is refused', async () => {
  const r = await signIn((n) => claimsFor(n, { tid: CONSUMER,
    iss: `https://login.microsoftonline.com/${CONSUMER}/v2.0` }));
  assert.equal(r.reason, 'not_student');
  assert.equal((await users()).length, 0);
});

test('4. another organisation\'s tenant is refused even with a @stu.upes.ac.in name', async () => {
  const r = await signIn((n) => claimsFor(n, { tid: OTHER_TENANT,
    iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }));
  assert.equal(r.reason, 'not_student');
  const r2 = await signIn((n) => claimsFor(n, { tid: OTHER_TENANT }));   // tid alone mismatched
  assert.equal(r2.reason, 'not_student');
  assert.equal((await users()).length, 0);
});

test('a guest / external identity in the tenant is refused', async () => {
  const r = await signIn((n) => claimsFor(n, { idp: 'live.com' }));
  assert.equal(r.reason, 'not_student');
  const r2 = await signIn((n) => claimsFor(n, { acct: 1 }));
  assert.equal(r2.reason, 'not_student');
  assert.equal((await users()).length, 0);
});

test('5. a token with no sign-in name, or no object id, is refused as unverified', async () => {
  const r = await signIn((n) => { const c = claimsFor(n); delete c.preferred_username; return c; });
  assert.equal(r.reason, 'not_verified');
  const r2 = await signIn((n) => { const c = claimsFor(n); delete c.oid; return c; });
  assert.equal(r2.reason, 'not_verified');
  assert.equal((await users()).length, 0);
});

test('6. an existing email-code account is signed into, not duplicated; roles and history kept', async () => {
  const u = (await pool.query(
    `INSERT INTO app_user (student_email, student_email_verified_at, student_status, name)
     VALUES ('ayush.17551@stu.upes.ac.in', now() - interval '3 days', 'approved', 'Ayush') RETURNING *`)).rows[0];
  await pool.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'student'), ($1,'delivery_partner')`, [u.id]);
  const r = await signIn();
  assert.equal(r.reason, 'ok');
  const all = await users();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, u.id);
  assert.equal(all[0].name, 'Ayush');
  assert.ok(all[0].microsoft_oid, 'bound on first Microsoft sign-in');
  const roles = (await pool.query(`SELECT role FROM user_role WHERE user_id = $1 ORDER BY role`, [u.id])).rows.map((x) => x.role);
  assert.deepEqual(roles, ['delivery_partner', 'student']);
  const link = (await pool.query(`SELECT detail FROM audit_log WHERE action = 'auth.login' AND outcome = 'ok'`)).rows[0];
  assert.equal(link.detail.linked, true);
});

test('6. the same Microsoft identity signs in again to the same account', async () => {
  const oid = randomUUID();
  await signIn((n) => claimsFor(n, { oid }));
  const again = await signIn((n) => claimsFor(n, { oid }));
  assert.equal(again.reason, 'ok');
  assert.equal((await users()).length, 1);
});

test('6. a different Microsoft object for an already-bound mailbox is refused, not re-linked', async () => {
  const first = randomUUID();
  await signIn((n) => claimsFor(n, { oid: first }));
  const r = await signIn((n) => claimsFor(n, { oid: randomUUID() }));
  assert.equal(r.reason, 'conflict');
  assert.equal(r.session, null);
  assert.equal((await users())[0].microsoft_oid, first);
});

test('a suspended account gets no session from Microsoft', async () => {
  await pool.query(`INSERT INTO app_user (student_email, student_email_verified_at, status) VALUES ('ayush.17551@stu.upes.ac.in', now(), 'suspended')`);
  const r = await signIn();
  assert.equal(r.reason, 'suspended');
  assert.equal(r.session, null);
});

test('7. a cancelled sign-in returns to the email screen and burns the state', async () => {
  const s = await start();
  const res = await app.inject({ method: 'GET', headers: { cookie: `quad_ms_bind=${s.bind}` },
    url: `/auth/microsoft/callback?error=access_denied&error_description=AADSTS65004&state=${s.state}` });
  assert.equal(msReason(res), 'cancelled');
  assert.match(new URL(res.headers.location).hash, /ob-email/);
  tokenReply = () => new Response(JSON.stringify({ id_token: idToken(claimsFor(s.nonce)) }));
  const replay = await app.inject({ method: 'GET', headers: { cookie: `quad_ms_bind=${s.bind}` },
    url: `/auth/microsoft/callback?code=abc&state=${s.state}` });
  assert.equal(msReason(replay), 'expired');
  assert.equal((await users()).length, 0);
});

test('8. an expired ID token is refused', async () => {
  const past = Math.floor(Date.now() / 1000) - 7200;
  const r = await signIn((n) => claimsFor(n, { iat: past, nbf: past, exp: past + 600 }));
  assert.equal(r.reason, 'expired');
  assert.equal((await users()).length, 0);
});

test('8. a token signed by another key, with the wrong audience, nonce or algorithm is refused', async () => {
  assert.equal((await signIn(undefined, { tokenOpts: { key: other.privateKey } })).reason, 'failed');
  assert.equal((await signIn((n) => claimsFor(n, { aud: randomUUID() }))).reason, 'failed');
  assert.equal((await signIn(() => claimsFor('some-other-nonce'))).reason, 'failed');
  assert.equal((await signIn(undefined, { tokenOpts: { alg: 'none' } })).reason, 'failed');
  assert.equal((await signIn(undefined, { tokenOpts: { kid: 'unknown' } })).reason, 'failed');
  assert.equal((await users()).length, 0);
});

test('8. a code Microsoft no longer accepts, or an unreachable Microsoft, ends cleanly', async () => {
  const s = await start();
  tokenReply = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  let res = await app.inject({ method: 'GET', headers: { cookie: `quad_ms_bind=${s.bind}` },
    url: `/auth/microsoft/callback?code=old&state=${s.state}` });
  assert.equal(msReason(res), 'expired');
  const s2 = await start();
  tokenReply = () => { throw new TypeError('fetch failed'); };
  res = await app.inject({ method: 'GET', headers: { cookie: `quad_ms_bind=${s2.bind}` },
    url: `/auth/microsoft/callback?code=abc&state=${s2.state}` });
  assert.equal(msReason(res), 'network');
});

test('CSRF: a callback without this browser\'s binding cookie, or with a forged state, is refused', async () => {
  assert.equal((await signIn(undefined, { keepBind: false })).reason, 'expired');
  assert.equal((await signIn(undefined, { mutateState: (s) => `${s}x` })).reason, 'expired');
  assert.equal((await users()).length, 0);
  const denied = (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.microsoft.callback' AND outcome = 'denied'`)).rows[0];
  assert.equal(denied.n, 2);
});

test('9. the email code still signs in to the account Microsoft created', async () => {
  await signIn();
  const { sendStudentEmailCode } = await import('../src/services/student-email.js');
  assert.equal(typeof sendStudentEmailCode, 'function');
  const auth = await import('../src/routes/auth.js');
  const r = await auth.signInStudentMailbox('ayush.17551@stu.upes.ac.in');
  assert.equal(r.created, false);
  assert.equal((await users()).length, 1);
});

test('/auth/status reports Microsoft sign-in as configured', async () => {
  const res = await app.inject({ method: 'GET', url: '/auth/status' });
  assert.equal(res.json().microsoft.configured, true);
  assert.equal(res.json().providers.microsoft_signin.configured, true);
});

test('studentIdentity refuses the consumer tenant directly', () => {
  assert.throws(() => oidc.studentIdentity({ tid: CONSUMER, oid: randomUUID(), preferred_username: 'a@stu.upes.ac.in' }),
    (e) => e.code === 'not_student');
});
