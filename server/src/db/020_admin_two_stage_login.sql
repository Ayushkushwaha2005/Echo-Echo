-- ===========================================================================
-- ECHO ECHO - migration 020: two-stage Campus Control sign-in, and a way back
-- in for an administrator who has forgotten their password.
--
-- Signing in becomes two screens: email + password, then the authenticator
-- code. That is a presentation change, but it cannot be done in the browser
-- alone - something has to remember, between the two requests, that the
-- password was already proven, and that something must not be the client.
-- Hence admin_login_challenge: a short-lived, single-use, server-side record
-- that stage two redeems.
--
-- It is deliberately NOT a session. It carries no roles, opens no surface and
-- authorises nothing; the only thing it can be exchanged for is the right to
-- have an authenticator code checked. A stolen one is worth nothing without
-- the second factor, which is the entire point of having a second factor.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Stage one: "this password was proven, a moment ago, from this browser"
-- ---------------------------------------------------------------------------
CREATE TABLE admin_login_challenge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,

  -- Only the HMAC of the token is stored, exactly as for an email code: a
  -- database leak must not hand anyone a usable half-finished sign-in.
  token_hash  text NOT NULL,

  -- Wrong authenticator codes are counted HERE as well as on the credential,
  -- so a single proven password cannot be used to grind the TOTP space.
  attempts    int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,

  ip          text,
  user_agent  text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX ON admin_login_challenge (user_id);
CREATE INDEX ON admin_login_challenge (expires_at);

-- ---------------------------------------------------------------------------
-- 2. Password reset, proven by the institutional mailbox
--
-- The reset is issued only AFTER an email code has been verified, and it is
-- single-use and short-lived. Resetting a password does not touch
-- totp_secret_enc: whoever comes back with the new password still has to
-- produce an authenticator code, so a compromised mailbox alone never opens
-- Campus Control.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_password_reset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX ON admin_password_reset (user_id);
CREATE INDEX ON admin_password_reset (expires_at);

-- ---------------------------------------------------------------------------
-- 3. The email code gains a purpose
--
-- Reusing email_challenge rather than inventing a second code table: the
-- rate limits, the attempt counting, the HMAC storage and the atomic
-- single-use consumption are already there and already tested.
--
-- user_id stays NULL for a reset, so the existing link-binding constraint is
-- unaffected. The address itself identifies the account - student_email is
-- unique - and the route re-checks that it belongs to an administrator.
-- ---------------------------------------------------------------------------
ALTER TABLE email_challenge DROP CONSTRAINT IF EXISTS email_challenge_purpose_check;
ALTER TABLE email_challenge ADD CONSTRAINT email_challenge_purpose_check
  CHECK (purpose IN ('login','link','admin_reset'));
