/* ==========================================================================
   FRISCO — AUTHENTICATION
   Identity: who is calling. (Authorization — what they may do — lives in
   api.js and is unchanged by this file.)

   Everything here is inert while CONFIG_FLAGS.AUTH_ENABLED is false.
   With the flag off, `currentSession()` returns whatever the surface handed
   it and no credential is ever checked, so the prototype behaves exactly as
   before. With the flag on, every surface entry point demands a real session.

   ── HONEST LIMITATION ───────────────────────────────────────────────────
   This is a browser prototype. Authentication cannot be *enforced* in a
   client: anyone can edit the JS. What this module gives you is the correct
   SHAPE — one login path, one session object, one gate — written so the same
   file runs unchanged on a Node server, where it is enforceable. When you
   stand the backend up, `verifyCredential` and `issueSession` move behind an
   HTTP boundary and the call sites below do not change.
   ────────────────────────────────────────────────────────────────────────
   ========================================================================== */
import { CONFIG_FLAGS, PRIMARY_ADMIN } from './config.js';

/* ---------- roles -------------------------------------------------------- */
export const ROLES = {
  platform_owner:  { rank: 100, label: 'Platform owner', scope: 'platform', surfaces: ['admin', 'counter', 'web'] },
  platform_admin:  { rank: 90,  label: 'Admin',           scope: 'platform', surfaces: ['admin', 'counter', 'web'] },
  support:         { rank: 60,  label: 'Support',         scope: 'platform', surfaces: ['admin'] },
  vendor_owner:    { rank: 50,  label: 'Cafeteria owner', scope: 'vendor',   surfaces: ['counter'] },
  vendor_staff:    { rank: 40,  label: 'Cafeteria staff', scope: 'vendor',   surfaces: ['counter'] },
  delivery_partner:{ rank: 20,  label: 'Delivery partner',scope: 'self',     surfaces: ['web'] },
  student:         { rank: 10,  label: 'Student',         scope: 'self',     surfaces: ['web'] },
};

export const isPlatformRole = (r) => ROLES[r] && ROLES[r].scope === 'platform';
export const isVendorRole = (r) => ROLES[r] && ROLES[r].scope === 'vendor';

/* Which roles may open which application surface. Checked at the door,
   before any capability check runs. */
export const SURFACE_ROLES = {
  admin:   ['platform_owner', 'platform_admin', 'support'],
  counter: ['platform_owner', 'platform_admin', 'vendor_owner', 'vendor_staff'],
  web:     ['student', 'delivery_partner', 'platform_owner', 'platform_admin'],
};

/* ---------- errors ------------------------------------------------------- */
export class Unauthenticated extends Error {   // 401
  constructor(msg = 'Sign in required', detail = '') {
    super(msg); this.name = 'Unauthenticated'; this.status = 401; this.detail = detail;
  }
}
export class Forbidden extends Error {          // 403
  constructor(msg = 'Access denied', detail = '') {
    super(msg); this.name = 'Forbidden'; this.status = 403; this.detail = detail;
  }
}

/* ---------- password hashing --------------------------------------------
   SHA-256 + per-user salt. Adequate to prove the shape; NOT what you ship.
   On the server this becomes Argon2id (or bcrypt, cost ≥ 12). The function
   signature stays the same, so nothing above it changes.                   */
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');           // Node fallback
  return createHash('sha256').update(text).digest('hex');
}
export const hashPassword = (password, salt) => sha256Hex(`${salt}:${password}`);

/* ---------- credential store --------------------------------------------
   Hashes only — no plaintext password exists anywhere in this repo. In
   production this table lives in the database, never in a bundle.

   The demo hashes below are generated from a password that is documented in
   docs/AUTH.md for local testing only, and they are seeded ONLY when
   AUTH_ENABLED is false (i.e. never in an enforced deployment).            */
export const CREDENTIALS = new Map();   // userId → { salt, hash, mustReset }

export async function setCredential(userId, password, { mustReset = false } = {}) {
  const salt = Math.random().toString(36).slice(2, 12);
  CREDENTIALS.set(userId, { salt, hash: await hashPassword(password, salt), mustReset });
  return true;
}

export async function verifyCredential(userId, password) {
  const rec = CREDENTIALS.get(userId);
  if (!rec) return false;
  const attempt = await hashPassword(password, rec.salt);
  /* Length-constant comparison. */
  if (attempt.length !== rec.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < attempt.length; i++) diff |= attempt.charCodeAt(i) ^ rec.hash.charCodeAt(i);
  return diff === 0;
}

/* ---------- lockout ------------------------------------------------------ */
const ATTEMPTS = new Map();   // key → { n, until }
function noteFailure(key) {
  const rec = ATTEMPTS.get(key) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= CONFIG_FLAGS.MAX_LOGIN_ATTEMPTS) {
    rec.until = Date.now() + CONFIG_FLAGS.LOCKOUT_MINUTES * 60_000;
    rec.n = 0;
  }
  ATTEMPTS.set(key, rec);
}
function lockedOut(key) {
  const rec = ATTEMPTS.get(key);
  return !!(rec && rec.until > Date.now());
}
export const clearAttempts = (key) => ATTEMPTS.delete(key);

/* ---------- sessions ----------------------------------------------------- */
export const SESSIONS = new Map();   // token → session

function newToken() {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const a = new Uint8Array(24); crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* A session is the ONLY thing api.js trusts. It carries resolved roles and,
   for vendor roles, the one cafeteria this person is bound to. */
export function issueSession(user) {
  const token = newToken();
  const session = {
    token,
    id: user.id,
    name: user.name,
    initials: user.initials,
    email: user.email,
    role: user.role,                                   // primary role
    roles: user.roles || [user.role],                  // a user may hold several
    vendor: user.vendor || null,                       // vendor scope, if any
    roll: user.roll,
    partner: !!user.partner,
    issuedAt: Date.now(),
    expiresAt: Date.now() + CONFIG_FLAGS.SESSION_TTL_MINUTES * 60_000,
    authenticated: true,
  };
  SESSIONS.set(token, session);
  return session;
}

export function revokeSession(token) { return SESSIONS.delete(token); }

export function sessionFromToken(token) {
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { SESSIONS.delete(token); return null; }
  return s;
}

/* ---------- login -------------------------------------------------------
   The single entry point. Steps, in order:
     1. authenticate (credential)
     2. verify the role may open this surface
     3. for vendor roles, verify cafeteria ownership
   A failure at any step is a refusal, never a redirect.                    */
export async function login({ email, password, surface, users }) {
  const user = users.find((u) => u.email && u.email.toLowerCase() === String(email || '').toLowerCase());
  const key = String(email || '').toLowerCase();

  if (lockedOut(key)) {
    throw new Forbidden('Too many attempts',
      `Locked for ${CONFIG_FLAGS.LOCKOUT_MINUTES} minutes.`);
  }

  /* 1 — authenticate. Same message whether the account is missing or the
     password is wrong, so this cannot be used to enumerate accounts. */
  if (!user || !(await verifyCredential(user.id, password))) {
    noteFailure(key);
    throw new Unauthenticated('Incorrect email or password');
  }

  /* 2 — role verification */
  const allowed = SURFACE_ROLES[surface] || [];
  const roles = user.roles || [user.role];
  if (!roles.some((r) => allowed.includes(r))) {
    noteFailure(key);
    throw new Forbidden(`Your account cannot open ${surfaceLabel(surface)}`,
      `Role "${user.role}" is not permitted on the ${surface} surface.`);
  }

  /* 3 — cafeteria ownership verification */
  if (roles.some(isVendorRole) && !roles.some(isPlatformRole)) {
    if (!user.vendor) {
      throw new Forbidden('No cafeteria assigned',
        'This account holds a vendor role but is not attached to an outlet.');
    }
  }

  clearAttempts(key);
  return issueSession(user);
}

export const surfaceLabel = (s) =>
  s === 'admin' ? 'Campus Control' : s === 'counter' ? 'Frisco Counter' : 'the Frisco website';

/* ---------- the door ----------------------------------------------------
   Every surface calls this before rendering anything. With AUTH_ENABLED
   false it waves through whatever session the surface already had — which
   is exactly today's behaviour.                                            */
export function requireSurfaceAccess(session, surface) {
  if (!CONFIG_FLAGS.AUTH_ENABLED) return session || null;

  if (!session) throw new Unauthenticated('Sign in required', `${surfaceLabel(surface)} requires an account.`);
  if (!session.authenticated) throw new Unauthenticated('Session is not authenticated');
  if (session.expiresAt && session.expiresAt < Date.now()) {
    throw new Unauthenticated('Session expired', 'Sign in again.');
  }
  const roles = session.roles || [session.role];
  const allowed = SURFACE_ROLES[surface] || [];
  if (!roles.some((r) => allowed.includes(r))) {
    throw new Forbidden(`Access denied to ${surfaceLabel(surface)}`,
      `Role "${session.role}" is not permitted here.`);
  }
  return session;
}

/* Direct-resource guard: a shopkeeper hitting another outlet's URL by hand.
   Rejects — it does not redirect, because the resource must actually be
   inaccessible. Active even with AUTH_ENABLED false, because scoping is a
   data-integrity rule rather than an authentication one.                   */
export function requireVendorAccess(session, vendorId) {
  if (!session) {
    if (!CONFIG_FLAGS.AUTH_ENABLED) return true;
    throw new Unauthenticated('Sign in required');
  }
  const roles = session.roles || [session.role];
  if (roles.some(isPlatformRole)) return true;
  if (session.vendor && session.vendor === vendorId) return true;
  throw new Forbidden('403 — this cafeteria is not yours',
    `Session is scoped to ${session.vendor || 'no outlet'}; requested ${vendorId}.`);
}

/* ---------- primary admin bootstrap -------------------------------------
   Runs once, server-side, when auth is switched on. Never in the client. */
export function primaryAdminUser() {
  if (!PRIMARY_ADMIN.configured) return null;
  return {
    id: 'usr_owner_primary',
    name: PRIMARY_ADMIN.name || 'Platform Owner',
    initials: (PRIMARY_ADMIN.name || 'PO').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
    email: PRIMARY_ADMIN.email,
    role: 'platform_owner',
    roles: ['platform_owner'],
    title: 'Primary admin',
  };
}

/* Seeds demo passwords for local testing. Refuses to run when auth is
   enforced, so demo credentials can never exist in a real deployment. */
export async function seedDemoCredentials(users, password) {
  if (CONFIG_FLAGS.AUTH_ENABLED) {
    return { seeded: 0, note: 'refused — AUTH_ENABLED is true; use the real enrolment flow' };
  }
  let n = 0;
  for (const u of users) { await setCredential(u.id, password); n++; }
  return { seeded: n, note: 'local testing only' };
}
