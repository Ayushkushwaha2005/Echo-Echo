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
export async function sessionFor(pool, userId, { ttlMinutes = 720 } = {}) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO session (token_hash, user_id, expires_at)
     VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`,
    [createHash('sha256').update(token).digest('hex'), userId, String(ttlMinutes)]);
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
