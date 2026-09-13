-- ===========================================================================
-- QUAD - migration 010: institutional email verification
--
-- A student proves they are a student by proving control of a mailbox on the
-- university's own student domain (for the UPES launch: stu.upes.ac.in). The
-- university issues and withdraws those mailboxes, so receiving a code there
-- is evidence of current enrolment that no screenshot can offer - and it
-- needs no SMS gateway, so it is also the zero-cost student sign-in path.
--
-- What the database enforces rather than the application remembering:
--   * one institutional mailbox verifies at most ONE account (unique index);
--   * an account must carry at least one proven identity (phone or mailbox);
--   * the code is stored only as a keyed hash, with expiry, attempt ceiling
--     and single-use consumption, exactly like otp_challenge;
--   * a challenge issued to link a mailbox to a signed-in account is bound to
--     that account by foreign key, so it cannot be redeemed into another.
-- ===========================================================================

-- A student who signs in by institutional email has no proven phone number.
ALTER TABLE app_user ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE app_user
  -- Normalised (lower-case) address whose mailbox control was proven.
  ADD COLUMN student_email             text,
  ADD COLUMN student_email_verified_at timestamptz,
  -- Self-declared contact number. NOT an identity: it never signs anyone in,
  -- is not unique, and exists only because some payment gateways require a
  -- customer phone on the order. Keeping it out of `phone` is what stops a
  -- student typing someone else's number and inheriting their OTP login.
  ADD COLUMN contact_phone             text
    CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE app_user
  ADD CONSTRAINT app_user_has_identity
    CHECK (phone IS NOT NULL OR student_email IS NOT NULL),
  ADD CONSTRAINT app_user_student_email_proven
    CHECK ((student_email IS NULL) = (student_email_verified_at IS NULL)),
  ADD CONSTRAINT app_user_student_email_normalised
    CHECK (student_email IS NULL OR student_email = lower(student_email));

CREATE UNIQUE INDEX app_user_student_email_unique ON app_user (student_email)
  WHERE student_email IS NOT NULL;

-- Verification states. Stored values keep their original names so every
-- existing gate (`student_status = 'approved'`) is untouched; the API maps
-- them to the canonical vocabulary:
--   unverified -> UNVERIFIED            email_verified -> EMAIL_VERIFIED
--   pending, needs_review -> PENDING_ADMIN_REVIEW
--   approved -> VERIFIED   rejected -> REJECTED   suspended -> SUSPENDED
ALTER TABLE app_user DROP CONSTRAINT app_user_student_status_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_student_status_check
  CHECK (student_status IN ('unverified','email_verified','pending','needs_review',
                            'approved','rejected','suspended'));

-- How a case was raised. An institutional-email case carries no images; a
-- manual case carries no images and no mailbox proof, and may only be
-- approved with a recorded note of the evidence the administrator relied on.
ALTER TABLE verification_case
  ADD COLUMN method text NOT NULL DEFAULT 'id_card'
    CHECK (method IN ('id_card','institutional_email','manual')),
  ADD COLUMN student_email text,
  ADD COLUMN request_note  text;

ALTER TABLE verification_case
  ADD CONSTRAINT manual_approval_needs_evidence
    CHECK (NOT (method = 'manual' AND state = 'approved')
           OR length(coalesce(decision_note, '')) >= 10);

CREATE TABLE email_challenge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (email = lower(email)),
  purpose       text NOT NULL CHECK (purpose IN ('login','link')),
  -- set only for purpose='link': the signed-in account the mailbox will join
  user_id       uuid REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash     text NOT NULL,
  salt          text NOT NULL,
  attempts      int  NOT NULL DEFAULT 0,
  max_attempts  int  NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  provider      text,
  provider_ref  text,
  ip            inet,
  CONSTRAINT email_challenge_link_bound CHECK ((purpose = 'link') = (user_id IS NOT NULL))
);
CREATE INDEX ON email_challenge (email, created_at DESC);
