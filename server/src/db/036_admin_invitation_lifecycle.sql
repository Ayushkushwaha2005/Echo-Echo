-- ===========================================================================
-- ECHO ECHO - migration 036: administrator invitation lifecycle
--
-- An invitation becomes a link, not a code that sign-in quietly honours. The
-- link token is stored only as a SHA-256, and holding it grants nothing: the
-- employee proves the invited mailbox with a fresh code, reads who invited
-- them and exactly what they would hold, accepts, sets a password, confirms
-- an authenticator. One transaction then activates the account and consumes
-- the invitation.
--
-- Additive. Rows from the older code-based flow keep their code_hash, have no
-- token_hash, can never be opened through the new routes, and stay visible so
-- the owner can resend them. Accounts stuck in 'invited' are not changed here:
-- the owner resends, and completing that invitation activates them.
-- ===========================================================================

-- Employees need not hold a university mailbox. student_email keeps its
-- meaning; staff_email is the address an administrator proved through an
-- invitation, and is what they sign in with when they have no student_email.
ALTER TABLE app_user
  ADD COLUMN staff_email text,
  ADD COLUMN staff_email_verified_at timestamptz,
  ADD CONSTRAINT app_user_staff_email_proven
    CHECK ((staff_email IS NULL) = (staff_email_verified_at IS NULL)),
  ADD CONSTRAINT app_user_staff_email_normalised
    CHECK (staff_email IS NULL OR staff_email = lower(staff_email));

CREATE UNIQUE INDEX app_user_staff_email_unique ON app_user (staff_email)
  WHERE staff_email IS NOT NULL;

ALTER TABLE app_user DROP CONSTRAINT app_user_has_identity;
ALTER TABLE app_user ADD CONSTRAINT app_user_has_identity
  CHECK (phone IS NOT NULL OR student_email IS NOT NULL OR staff_email IS NOT NULL);

ALTER TABLE admin_invitation
  ALTER COLUMN code_hash DROP NOT NULL,
  ALTER COLUMN salt DROP NOT NULL,
  ADD COLUMN token_hash        text UNIQUE,
  ADD COLUMN send_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN last_sent_at      timestamptz,
  ADD COLUMN revoked_by        uuid REFERENCES app_user(id),
  -- the fresh mailbox proof
  ADD COLUMN otp_hash          text,
  ADD COLUMN otp_salt          text,
  ADD COLUMN otp_expires_at    timestamptz,
  ADD COLUMN otp_attempts      integer NOT NULL DEFAULT 0,
  ADD COLUMN otp_sent_at       timestamptz,
  ADD COLUMN email_verified_at timestamptz,
  -- short-lived second secret, issued only after the mailbox is proven
  ADD COLUMN setup_hash        text,
  ADD COLUMN setup_expires_at  timestamptz,
  -- explicit acceptance, separate from completion (accepted_at)
  ADD COLUMN terms_accepted_at timestamptz,
  -- held only until activation, then cleared
  ADD COLUMN password_hash     text,
  ADD COLUMN password_salt     text,
  ADD COLUMN password_params   jsonb,
  ADD COLUMN totp_secret_enc   text;

-- A row may not be both finished and cancelled.
ALTER TABLE admin_invitation ADD CONSTRAINT admin_invitation_one_outcome
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL));

-- A finished or cancelled invitation keeps no credential material.
ALTER TABLE admin_invitation ADD CONSTRAINT admin_invitation_no_secrets_after_close
  CHECK ((accepted_at IS NULL AND revoked_at IS NULL)
      OR (password_hash IS NULL AND password_salt IS NULL AND totp_secret_enc IS NULL
          AND otp_hash IS NULL AND setup_hash IS NULL));
