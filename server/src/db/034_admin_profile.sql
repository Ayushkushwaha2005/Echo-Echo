-- ============================================================================
-- ECHO ECHO - migration 034: an administrator's own profile, and replacing an
-- authenticator without a gap
--
--   admin_profile          the name and photo an administrator chooses for
--                          Campus Control. Separate from app_user.name, which
--                          is the student account's name and stays as it is.
--                          Editing it never touches the login email, the
--                          owner role or any permission.
--   admin_credential       gains a PENDING authenticator secret. Replacing a
--                          working authenticator stores the new secret here;
--                          the old one keeps signing in until a code from the
--                          new one is confirmed, and only then is swapped.
--   asset kind admin_photo a profile photo. Not public: it is served only to
--                          signed-in administrators.
--
-- Additive only; the code before this migration keeps working against it.
-- ============================================================================

CREATE TABLE admin_profile (
  user_id      uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 2 AND 40),
  photo_asset  uuid REFERENCES asset(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_credential ADD COLUMN totp_pending_enc text;
ALTER TABLE admin_credential ADD COLUMN totp_pending_at timestamptz;

ALTER TABLE asset DROP CONSTRAINT asset_kind_check;
ALTER TABLE asset ADD CONSTRAINT asset_kind_check
  CHECK (kind IN ('id_front','id_back','food_photo','vendor_photo','partner_photo','site_image','admin_photo'));
