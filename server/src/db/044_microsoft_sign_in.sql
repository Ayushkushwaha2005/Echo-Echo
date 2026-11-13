-- Microsoft (Entra ID) sign-in for students, alongside the email code.
--
-- Numbered 044 because 043 is taken by the Campus Control upgrade branch.
-- The runner applies files by name, so either order works.

-- A session opened by Microsoft sign-in says so. It is a student-strength
-- session exactly like 'code': it carries no platform role.
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_auth_method_check;
ALTER TABLE session ADD CONSTRAINT session_auth_method_check
  CHECK (auth_method IN ('code','passkey','recovery','admin_totp','microsoft'));

-- The Entra object id (oid) within the pinned tenant is the immutable
-- identifier of the person; the UPN can be renamed by the university. Once an
-- account has signed in with Microsoft it is bound to that oid, so a mailbox
-- name later reissued to someone else cannot reach the earlier owner's account.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS microsoft_tid text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS microsoft_oid text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS microsoft_linked_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS app_user_microsoft_identity
  ON app_user (microsoft_tid, microsoft_oid) WHERE microsoft_oid IS NOT NULL;

-- One row per "Continue with Microsoft" press. Only hashes of the state and
-- of the browser-binding cookie are stored. The PKCE verifier and nonce must be
-- usable at the callback, so they are stored as issued; a row is good for ten
-- minutes and for one callback.
CREATE TABLE IF NOT EXISTS oauth_login_attempt (
  state_hash    text PRIMARY KEY,
  browser_hash  text NOT NULL,
  provider      text NOT NULL CHECK (provider IN ('microsoft')),
  code_verifier text NOT NULL,
  nonce         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_login_attempt_expiry ON oauth_login_attempt (expires_at);
