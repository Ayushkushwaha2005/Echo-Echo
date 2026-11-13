/* ==========================================================================
   QUAD — MICROSOFT (ENTRA ID) OPENID CONNECT

   Authorization-code flow with PKCE, run entirely on the server: the browser
   never sees a token, and the client secret never leaves this process.

   Who may get in is decided here, from the signed ID token only:
     1. the signature verifies against the pinned tenant's published keys;
     2. iss, tid, aud, exp/nbf/iat, nonce and ver are what we asked for;
     3. the person is a MEMBER of the pinned tenant (no guest, no external
        identity provider);
     4. their sign-in name (UPN) - which Entra only lets a tenant use on a
        domain that tenant has proven it owns - ends in exactly one of
        STUDENT_EMAIL.domains, after the same normalisation the email code
        uses.
   The `email` claim is never used: Entra does not verify it.
   ========================================================================== */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { MICROSOFT, STUDENT_EMAIL } from '../config.js';
import { normaliseStudentEmail } from './student-email.js';

/* A refusal the callback turns into a user-facing reason. `code` is what
   the browser is told; `detail` is for the audit log only. */
export class MicrosoftSignInError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; this.detail = detail || code; }
}
const refuse = (code, detail) => new MicrosoftSignInError(code, detail);

export const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const SKEW_SECONDS = 120;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const pkceChallenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');
export function sameHash(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const expectedIssuer = (tenantId) => `${MICROSOFT.authorityHost}/${tenantId}/v2.0`;

export function authorizeUrl({ state, nonce, codeVerifier }) {
  const u = new URL(`${MICROSOFT.authorityHost}/${MICROSOFT.tenantId}/oauth2/v2.0/authorize`);
  u.search = new URLSearchParams({
    client_id: MICROSOFT.clientId,
    response_type: 'code',
    redirect_uri: MICROSOFT.redirectUri,
    response_mode: 'query',
    scope: 'openid profile',
    state, nonce,
    code_challenge: pkceChallenge(codeVerifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return u.toString();
}

/* ---------- keys --------------------------------------------------------- */
let jwksCache = { at: 0, keys: [] };
export function _resetKeyCache() { jwksCache = { at: 0, keys: [] }; }

async function loadKeys(fetchImpl, force = false) {
  if (!force && jwksCache.keys.length && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  /* The keys URL is fixed for the pinned tenant; discovery is not trusted to
     move it somewhere else. */
  const r = await fetchImpl(`${MICROSOFT.authorityHost}/${MICROSOFT.tenantId}/discovery/v2.0/keys`,
    { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw refuse('failed', `jwks_http_${r.status}`);
  const body = await r.json();
  jwksCache = { at: Date.now(), keys: Array.isArray(body?.keys) ? body.keys : [] };
  return jwksCache.keys;
}

const b64json = (part) => {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
  catch { throw refuse('failed', 'id_token_malformed'); }
};

/* Verifies an ID token and returns its claims. `keys` may be passed
   directly (tests); otherwise they are fetched from the pinned tenant. */
export async function verifyIdToken(idToken, { nonce, now = Date.now(), keys, fetchImpl = fetch } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw refuse('failed', 'id_token_malformed');
  const header = b64json(parts[0]);
  const claims = b64json(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw refuse('failed', `id_token_alg_${header.alg}`);

  let set = keys || await loadKeys(fetchImpl);
  let jwk = set.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk && !keys) { set = await loadKeys(fetchImpl, true); jwk = set.find((k) => k.kid === header.kid && k.kty === 'RSA'); }
  if (!jwk) throw refuse('failed', 'id_token_unknown_key');

  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'));
  if (!ok) throw refuse('failed', 'id_token_bad_signature');

  const t = Math.floor(now / 1000);
  if (claims.ver !== '2.0') throw refuse('failed', 'id_token_version');
  if (claims.iss !== expectedIssuer(MICROSOFT.tenantId)) throw refuse('not_student', 'id_token_issuer');
  if (String(claims.tid || '').toLowerCase() !== MICROSOFT.tenantId) throw refuse('not_student', 'id_token_tenant');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud.length !== 1 || aud[0] !== MICROSOFT.clientId) throw refuse('failed', 'id_token_audience');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < t) throw refuse('expired', 'id_token_expired');
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > t) throw refuse('failed', 'id_token_not_yet_valid');
  if (typeof claims.iat !== 'number' || claims.iat - SKEW_SECONDS > t) throw refuse('failed', 'id_token_iat');
  if (!nonce || !sameHash(sha256(claims.nonce || ''), sha256(nonce))) throw refuse('failed', 'id_token_nonce');
  return claims;
}

/* The verified student behind a set of verified claims, or a refusal. */
export function studentIdentity(claims) {
  if (claims.tid === CONSUMER_TENANT) throw refuse('not_student', 'consumer_account');
  /* A guest or B2B user carries the identity provider that really signed
     them in; a member of the tenant does not (or names the tenant itself). */
  if (claims.idp && claims.idp !== claims.iss) throw refuse('not_student', 'external_identity');
  if (claims.acct !== undefined && Number(claims.acct) !== 0) throw refuse('not_student', 'guest_account');
  if (!GUID.test(String(claims.oid || ''))) throw refuse('not_verified', 'no_object_id');

  /* v2 tokens put the UPN in preferred_username for members; `upn` is
     preferred when the registration adds it as an optional claim. */
  const name = claims.upn || claims.preferred_username;
  if (!name) throw refuse('not_verified', 'no_sign_in_name');
  let email;
  try { email = normaliseStudentEmail(name); }
  catch {
    const at = String(name).lastIndexOf('@');
    throw refuse('not_student', `domain:${at >= 0 ? String(name).slice(at + 1).toLowerCase().slice(0, 80) : 'none'}`);
  }
  /* normaliseStudentEmail already demands an exact match against the list;
     asserted again so a future change there cannot quietly widen this. */
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (!STUDENT_EMAIL.domains.includes(domain)) throw refuse('not_student', `domain:${domain}`);
  return { email, tid: String(claims.tid).toLowerCase(), oid: String(claims.oid).toLowerCase() };
}

/* Redeems the authorization code. Returns the raw ID token. */
export async function redeemCode(code, codeVerifier, { fetchImpl = fetch } = {}) {
  if (!code || String(code).length > 4096) throw refuse('failed', 'no_code');
  let r;
  try {
    r = await fetchImpl(`${MICROSOFT.authorityHost}/${MICROSOFT.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: MICROSOFT.clientId,
        client_secret: MICROSOFT.clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: MICROSOFT.redirectUri,
        code_verifier: codeVerifier,
        scope: 'openid profile',
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { throw refuse('network', `token_fetch:${e.name}`); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    /* invalid_grant = code expired, already used, or verifier mismatch. */
    throw refuse(body.error === 'invalid_grant' ? 'expired' : 'failed', `token_${body.error || r.status}`);
  }
  if (!body.id_token) throw refuse('failed', 'no_id_token');
  return body.id_token;
}
