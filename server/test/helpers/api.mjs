/* ==========================================================================
   API test harness.

   Requests go through the real Fastify stack via app.inject() — every hook
   runs, including the CSRF origin check, the session lookup, the error
   handler and rate limiting. Nothing is stubbed except the external
   providers, which have no credentials here.

   Sessions are minted by writing a session row directly, because there is
   no OTP provider in the test environment and there is deliberately no
   bypass in the OTP service. That is the honest way to test an
   authenticated route: exercise the session mechanism, not a fake login.
   ========================================================================== */
import { randomBytes, createHash } from 'node:crypto';

const ORIGIN = 'http://localhost:3000';

export async function makeApp() {
  process.env.WEB_ORIGIN = ORIGIN;
  process.env.SWEEPER = 'off';
  process.env.NODE_ENV = 'test';
  const { build } = await import('../../src/index.js');
  return build();
}

/* Issues a real session for a user, exactly as auth/session.js does. */
/**
 * A signed-in session.
 *
 * `onCampus` defaults to true because the live-location check is part of
 * signing in: a real session that reached the ordering screens has passed
 * it, so that is what a fixture session should look like. Tests that are
 * ABOUT the location gate pass `onCampus: false` to get a session that has
 * not confirmed one, which is exactly the state a browser that refused
 * permission leaves behind.
 */
export async function sessionFor(pool, userId, { ttlMinutes = 720, onCampus = true, method = 'code' } = {}) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO session (token_hash, user_id, expires_at, auth_method, passkey_verified_at,
                          campus_presence_at, campus_presence_site_id)
     VALUES ($1,$2, now() + ($3 || ' minutes')::interval, $4,
             CASE WHEN $4 IN ('passkey','admin_totp') THEN now() END,
             CASE WHEN $5 THEN now() END,
             CASE WHEN $5 THEN (SELECT campus_site_id FROM app_user WHERE id = $2) END)`,
    [createHash('sha256').update(token).digest('hex'), userId, String(ttlMinutes), method, onCampus]);
  return token;
}

export async function expiredSessionFor(pool, userId) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO session (token_hash, user_id, expires_at)
     VALUES ($1,$2, now() - interval '1 minute')`,
    [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}

/* A caller bound to one session, so tests read like the surface would. */
export function client(app, token) {
  const headers = { origin: ORIGIN, 'content-type': 'application/json' };
  if (token) headers.cookie = `quad_session=${token}`;
  const call = async (method, url, payload) => {
    const res = await app.inject({ method, url, headers, payload });
    let body = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
    return { status: res.statusCode, body, headers: res.headers };
  };
  return {
    get: (u) => call('GET', u),
    post: (u, p) => call('POST', u, p),
    patch: (u, p) => call('PATCH', u, p),
    put: (u, p) => call('PUT', u, p),
    /* For the CSRF test: same session, different origin. */
    postFrom: async (origin, u, p) => {
      const res = await app.inject({ method: 'POST', url: u, payload: p,
        headers: { origin, 'content-type': 'application/json',
                   cookie: token ? `quad_session=${token}` : undefined } });
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    },
  };
}
