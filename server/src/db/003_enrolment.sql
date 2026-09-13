-- ===========================================================================
-- QUAD — migration 003: enrolment codes
--
-- A second, fully self-contained way into the platform, so Quad can be
-- installed, administered and operated with no external service at all.
--
-- The code is delivered OUT OF BAND by a person: an administrator reads it
-- to the new cafeteria owner, or the platform owner runs a CLI command on
-- the server they control. Nothing is faked — the code is real, hashed,
-- single-use and expiring, exactly like an OTP challenge. What differs is
-- only the delivery channel, which is a human instead of an SMS gateway.
--
-- Two escalation risks are designed out rather than checked in code:
--   * a code is bound to ONE user_id by foreign key, so it cannot be
--     redeemed into a different account;
--   * only one live code can exist per user (partial unique index), so an
--     admin cannot quietly mint a second one behind the first.
-- The platform_owner exclusion is enforced in the route, since it depends
-- on role state that changes over time.
-- ===========================================================================

CREATE TABLE enrolment_code (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  code_hash    text NOT NULL,
  salt         text NOT NULL,
  -- who issued it; NULL means the server-side bootstrap CLI, which requires
  -- shell access to the host and therefore needs no in-app actor
  issued_by    uuid REFERENCES app_user(id),
  issued_via   text NOT NULL DEFAULT 'admin'
                 CHECK (issued_via IN ('admin', 'bootstrap')),
  attempts     int  NOT NULL DEFAULT 0,
  max_attempts int  NOT NULL DEFAULT 5,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  revoked_at   timestamptz
);

CREATE INDEX ON enrolment_code (user_id, created_at DESC);

-- At most one live code per user. A superseding issue must revoke first,
-- which the route does inside a transaction.
CREATE UNIQUE INDEX one_live_enrolment_code_per_user ON enrolment_code (user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
