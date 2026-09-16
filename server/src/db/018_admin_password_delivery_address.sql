-- ===========================================================================
-- ECHO ECHO - migration 018
--
-- Three unrelated-looking changes that all come from the same decision: the
-- product now has ONE way in per audience, and an order now carries a
-- complete delivery address.
--
--   1. admin_credential  - administrators sign in with an email, a password
--                          and a Microsoft-Authenticator-compatible TOTP
--                          code. Replaces the passkey-first admin login.
--   2. food_order         - the structured campus destination, the delivery
--                          contact number, and a frozen snapshot of where
--                          the partner is actually going.
--   3. pricing_policy     - a configurable two-tier delivery earning, so
--                          "10 rupees normally, 15 on a bigger order" is a
--                          setting rather than a hard-coded number.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Administrator credentials
--
-- Password and TOTP live in their own table, not on app_user: an ordinary
-- student account has no password at all, and nothing about the student
-- sign-in path can read or write these columns.
--
-- The TOTP secret is stored encrypted (AES-256-GCM, key from
-- ADMIN_TOTP_KEY/COOKIE_SECRET) - see services/admin-auth.js. It is written
-- once at enrolment and never returned by any API.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_credential (
  user_id             uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,

  -- scrypt. `password_params` records the cost parameters the hash was made
  -- with, so they can be raised later without invalidating existing hashes.
  password_hash       text,
  password_salt       text,
  password_algo       text NOT NULL DEFAULT 'scrypt',
  password_params     jsonb,
  password_updated_at timestamptz,

  -- Encrypted TOTP shared secret. NULL until the administrator enrols an
  -- authenticator app; `totp_confirmed_at` is set only after they have
  -- proved they can produce a code from it.
  totp_secret_enc     text,
  totp_confirmed_at   timestamptz,
  -- The last accepted time step. A code is single-use: replaying the same
  -- six digits inside its own 30-second window is refused.
  totp_last_step      bigint,

  -- Throttling lives with the credential, so rotating IP addresses does not
  -- dilute it.
  failed_attempts     int NOT NULL DEFAULT 0,
  last_failed_at      timestamptz,
  locked_until        timestamptz,
  last_login_at       timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- A credential row is only meaningful for an account that holds a platform
-- role; this index is what the sign-in path looks the account up by.
CREATE INDEX ON admin_credential (totp_confirmed_at);

-- The session's auth_method gains the administrator method. 'passkey' stays
-- in the list: deployments with credentials already registered keep working,
-- and the column is a historical record of how each session was opened.
ALTER TABLE session DROP CONSTRAINT IF EXISTS session_auth_method_check;
ALTER TABLE session ADD CONSTRAINT session_auth_method_check
  CHECK (auth_method IN ('code','passkey','recovery','admin_totp'));

-- ---------------------------------------------------------------------------
-- 2. The delivery address on an order
--
-- destination_id already pins the order to one campus_node, and that stays
-- the only thing the boundary gate trusts. What was missing is everything a
-- delivery partner actually needs at the door: which floor, which room, what
-- to look for, and a number to ring.
--
-- `destination_snapshot` is frozen at draft time, exactly like the item
-- names and prices in order_item: renaming a building next term must not
-- rewrite where last term's order went.
-- ---------------------------------------------------------------------------
ALTER TABLE food_order
  ADD COLUMN delivery_contact_phone text,
  ADD COLUMN delivery_landmark      text,
  ADD COLUMN delivery_instructions  text,
  ADD COLUMN destination_snapshot   jsonb;

-- A delivery order placed from now on must carry a contact number. Existing
-- rows are left alone: the constraint is NOT VALID so it applies to new and
-- updated rows only, and no historical order is retro-invalidated.
ALTER TABLE food_order
  ADD CONSTRAINT delivery_needs_contact_phone CHECK (
    fulfilment <> 'delivery' OR delivery_contact_phone IS NOT NULL
  ) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2b. Live location, recorded on the session
--
-- A student confirms they are physically on campus once per session, before
-- the ordering screens open. The verdict is written HERE rather than kept in
-- the browser, because a value the client holds is a value the client can
-- set: with it on the session, a request that skipped the location step is
-- refused by the server whatever the browser believes.
--
-- Only the fix that PASSED is stored, and only as a coarse record of what
-- was checked. It is not a location history: one row per session, overwritten
-- if the student confirms again.
-- ---------------------------------------------------------------------------
ALTER TABLE session
  ADD COLUMN campus_presence_at        timestamptz,
  ADD COLUMN campus_presence_lat       double precision,
  ADD COLUMN campus_presence_lng       double precision,
  ADD COLUMN campus_presence_accuracy_m double precision,
  ADD COLUMN campus_presence_site_id   uuid REFERENCES campus_site(id);

-- ---------------------------------------------------------------------------
-- 3. Two-tier delivery earning
--
-- delivery_earning_paise stays the base. When a threshold is set and the
-- order's food subtotal reaches it, the partner earns the higher amount
-- instead. NULL threshold = no tier, which is exactly the old behaviour, so
-- every existing policy row keeps pricing orders the way it always did.
-- ---------------------------------------------------------------------------
ALTER TABLE pricing_policy
  ADD COLUMN delivery_earning_high_paise int
    CHECK (delivery_earning_high_paise IS NULL OR delivery_earning_high_paise >= 0),
  ADD COLUMN delivery_earning_threshold_paise int
    CHECK (delivery_earning_threshold_paise IS NULL OR delivery_earning_threshold_paise >= 0);

-- Both or neither: a threshold with no higher amount, or a higher amount
-- with no threshold, is a half-configured rule that would silently do
-- nothing.
ALTER TABLE pricing_policy
  ADD CONSTRAINT delivery_tier_complete CHECK (
    (delivery_earning_high_paise IS NULL) = (delivery_earning_threshold_paise IS NULL)
  );

-- ---------------------------------------------------------------------------
-- The live platform default gains the fees this product actually charges.
-- Done as a new VERSION rather than an UPDATE, because order_financials pins
-- the policy id it was priced under and those rows are immutable: every
-- order already placed keeps its own terms, and only new orders see these.
--
--   platform fee      10.00  flat, on every order regardless of basket
--   delivery fee      15.00  charged to the customer on a delivery order
--   delivery earning  10.00  to the partner, or 15.00 once the food
--                            subtotal reaches 300.00
-- ---------------------------------------------------------------------------
UPDATE pricing_policy SET effective_to = now()
 WHERE vendor_id IS NULL AND effective_to IS NULL;

INSERT INTO pricing_policy (
  vendor_id, commission_bps, commission_mode,
  platform_fee_flat_paise, platform_fee_bps,
  delivery_fee_paise, delivery_earning_paise,
  delivery_earning_high_paise, delivery_earning_threshold_paise,
  tax_bps, discount_funded_by, note)
VALUES (
  NULL, 0, 'deduct_from_cafeteria',
  1000, 0,
  1500, 1000,
  1500, 30000,
  0, 'platform',
  'Migration 018: platform fee 10.00 on every order; delivery earning 10.00, or 15.00 from a 300.00 subtotal.');
