/* ==========================================================================
   FRISCO — RUNTIME CONFIGURATION
   The single switch that turns authentication on. Nothing else in the
   codebase reads an env var directly.

   ┌──────────────────────────────────────────────────────────────────────┐
   │  AUTH_ENABLED is FALSE. Authentication is fully implemented but is   │
   │  NOT enforced. The prototype behaves exactly as it did before.       │
   └──────────────────────────────────────────────────────────────────────┘

   Resolution order (first hit wins):
     1. process.env            — Node: tests, SSR, the real server
     2. globalThis.FRISCO_CONFIG — injected by the server into the page
     3. the defaults below

   Nothing secret is ever read from, or written into, client code. The
   primary admin identity is configured server-side; see PRIMARY_ADMIN below.
   ========================================================================== */

const fromEnv = (key) => {
  try {
    if (typeof process !== 'undefined' && process.env && process.env[key] !== undefined) {
      return process.env[key];
    }
  } catch { /* not Node */ }
  try {
    if (typeof globalThis !== 'undefined' && globalThis.FRISCO_CONFIG &&
        globalThis.FRISCO_CONFIG[key] !== undefined) {
      return globalThis.FRISCO_CONFIG[key];
    }
  } catch { /* no injected config */ }
  return undefined;
};

const bool = (v, fallback) => {
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true' || String(v) === '1';
};

export const CONFIG_FLAGS = {
  /* ---- THE SWITCH -------------------------------------------------------
     false → no login required anywhere; every surface works as it does today.
     true  → Campus Control and Counter require authentication, role
             verification and (for shopkeepers) cafeteria-ownership
             verification. Unauthorized calls are rejected with 403.
     Set via env `AUTH_ENABLED=true`, or `globalThis.FRISCO_CONFIG` from the
     server. Do not edit this default to enable it in production.          */
  AUTH_ENABLED: bool(fromEnv('AUTH_ENABLED'), false),

  /* Session lifetime once auth is on. */
  SESSION_TTL_MINUTES: Number(fromEnv('SESSION_TTL_MINUTES') || 720),

  /* Failed-login lockout. */
  MAX_LOGIN_ATTEMPTS: Number(fromEnv('MAX_LOGIN_ATTEMPTS') || 5),
  LOCKOUT_MINUTES: Number(fromEnv('LOCKOUT_MINUTES') || 15),

  /* When true the login screen lists demo accounts. Must be false in
     production — it is derived from AUTH_ENABLED so it cannot be left on
     by accident once real auth is switched in. */
  get SHOW_DEMO_ACCOUNTS() { return !bool(fromEnv('AUTH_ENABLED'), false); },

  /* Local-testing password for the seeded demo accounts.
     This is NOT a secret: `seedDemoCredentials()` refuses to run whenever
     AUTH_ENABLED is true, so this value can only ever apply in the mode
     where no password is required at all. It is named here rather than
     buried as a literal in a surface file so there is one obvious place to
     see it, and one obvious thing to delete when the real backend lands. */
  DEV_DEMO_PASSWORD: fromEnv('DEV_DEMO_PASSWORD') || 'frisco-dev',
};

/* ==========================================================================
   PRIMARY ADMIN / PLATFORM OWNER

   Your account. Configured entirely outside the client bundle.

   To claim primary-admin access when you switch authentication on, set these
   on the SERVER (a .env file, your host's env panel, or your auth provider):

       AUTH_ENABLED=true
       PRIMARY_ADMIN_EMAIL=you@campus.edu.in
       PRIMARY_ADMIN_NAME="Your Name"

   The password is never an env var and never reaches this file. On first
   boot with AUTH_ENABLED=true the server issues a one-time enrolment link to
   PRIMARY_ADMIN_EMAIL; you set the password there, and it is stored only as
   an Argon2id/bcrypt hash. See docs/AUTH.md for the full procedure.

   `platform_owner` is the highest role. It is the only role that can grant
   or revoke `platform_admin`, and it cannot be archived by anyone.
   ========================================================================== */
export const PRIMARY_ADMIN = {
  email: fromEnv('PRIMARY_ADMIN_EMAIL') || null,
  name: fromEnv('PRIMARY_ADMIN_NAME') || null,
  role: 'platform_owner',
  /* True only when the deployment has actually been configured. With
     AUTH_ENABLED=false this stays false and nothing depends on it. */
  get configured() { return !!(this.email); },
};

/* A guard the server calls at boot. Refuses to run enforced-auth without a
   configured owner, so nobody can enable auth and lock everyone out. */
export function assertConfigured() {
  if (!CONFIG_FLAGS.AUTH_ENABLED) return { ok: true, note: 'auth disabled — no configuration required' };
  if (!PRIMARY_ADMIN.configured) {
    return { ok: false, note: 'AUTH_ENABLED=true but PRIMARY_ADMIN_EMAIL is not set. Refusing to start.' };
  }
  return { ok: true, note: `auth enforced · primary admin ${PRIMARY_ADMIN.email}` };
}
