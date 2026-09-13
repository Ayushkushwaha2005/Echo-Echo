-- ===========================================================================
-- QUAD - migration 014: administrator passkeys (WebAuthn)
--
-- The server stores public keys only. A fingerprint, face or device PIN
-- never leaves the administrator's device; the authenticator uses it to
-- unlock a private key that also never leaves the device.
-- ===========================================================================

CREATE TABLE webauthn_credential (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  credential_id   text NOT NULL UNIQUE,            -- base64url
  public_key_jwk  jsonb NOT NULL,
  algorithm       int  NOT NULL CHECK (algorithm IN (-7, -257)),
  sign_count      bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  aaguid          text,
  transports      text[] NOT NULL DEFAULT '{}',
  backed_up       boolean NOT NULL DEFAULT false,
  label           text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES app_user(id)
);
CREATE INDEX ON webauthn_credential (user_id) WHERE revoked_at IS NULL;

-- One-time ceremony challenges. Single use, short-lived, bound to a purpose
-- and (except for sign-in) to one account.
CREATE TABLE webauthn_challenge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge    text NOT NULL UNIQUE,               -- base64url, 32 random bytes
  purpose      text NOT NULL CHECK (purpose IN ('register','login','reauth')),
  user_id      uuid REFERENCES app_user(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  CONSTRAINT bound_to_user CHECK ((purpose = 'login') = (user_id IS NULL))
);
CREATE INDEX ON webauthn_challenge (expires_at);

-- The one-time permission to register the FIRST passkey on an admin
-- account. Issued from the server's shell (proof of control of the
-- deployment) or by the platform owner for another administrator.
CREATE TABLE admin_passkey_invite (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  salt        text NOT NULL,
  issued_by   uuid REFERENCES app_user(id),         -- NULL: server CLI
  attempts    int  NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX one_live_passkey_invite ON admin_passkey_invite (user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- Recovery codes: shown once, stored hashed, each usable once, and good only
-- for registering a replacement passkey - never for acting as an admin.
CREATE TABLE admin_recovery_code (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  salt        text NOT NULL,
  batch       uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  revoked_at  timestamptz
);
CREATE INDEX ON admin_recovery_code (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

ALTER TABLE session
  ADD COLUMN auth_method text NOT NULL DEFAULT 'code'
    CHECK (auth_method IN ('code','passkey','recovery')),
  ADD COLUMN passkey_verified_at timestamptz,
  ADD COLUMN passkey_credential_id uuid REFERENCES webauthn_credential(id);

-- Administrators identified by institutional email rather than phone.
-- Grants from configuration are recorded as such.
ALTER TABLE user_role ADD COLUMN granted_via text NOT NULL DEFAULT 'api'
  CHECK (granted_via IN ('api','bootstrap_config','migration'));
