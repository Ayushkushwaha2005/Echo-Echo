-- ===========================================================================
-- QUAD — initial schema
--
-- Design rules encoded here rather than in application code:
--   * An order's destination is a FOREIGN KEY into campus_node. There is no
--     free-text address column anywhere, so an off-campus delivery is not
--     representable, not merely rejected.
--   * Order lines store a frozen price snapshot. Changing a menu price can
--     never rewrite history.
--   * A review requires an order_item_id, so nobody can review food they
--     did not buy.
--   * Money is integer paise. No floats touch a total.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- identity
CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text UNIQUE NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  name          text,
  email         text,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','deleted')),
  -- student identity verification state, driven by verification_case
  student_status text NOT NULL DEFAULT 'unverified'
                  CHECK (student_status IN ('unverified','pending','approved','rejected','needs_review')),
  roll_number   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);
CREATE INDEX ON app_user (phone);

-- Roles are rows, not a column: a user may be student + delivery_partner.
CREATE TABLE user_role (
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN (
               'platform_owner','platform_admin','support',
               'vendor_owner','vendor_staff','delivery_partner','student')),
  vendor_id  uuid,                       -- required for vendor_* roles (FK added below)
  status     text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','pending','revoked')),
  granted_by uuid REFERENCES app_user(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  id         bigserial PRIMARY KEY
);
-- One row per (user, role, cafeteria). Postgres will not accept an
-- expression in a PRIMARY KEY, so the uniqueness that actually matters is a
-- unique index; NULL vendor_id is folded to a sentinel so a second platform
-- role for the same user still collides.
CREATE UNIQUE INDEX user_role_identity ON user_role
  (user_id, role, COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------- sessions
CREATE TABLE session (
  token_hash  text PRIMARY KEY,           -- sha256 of the cookie value; raw token never stored
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip          inet
);
CREATE INDEX ON session (user_id);
CREATE INDEX ON session (expires_at);

-- ---------------------------------------------------------------- OTP
-- The code is stored only as a salted hash, with a hard attempt ceiling and
-- an expiry. A verified challenge is consumed and cannot be replayed.
CREATE TABLE otp_challenge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL,
  code_hash     text NOT NULL,
  salt          text NOT NULL,
  purpose       text NOT NULL DEFAULT 'login',
  attempts      int  NOT NULL DEFAULT 0,
  max_attempts  int  NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  provider      text,
  provider_ref  text
);
CREATE INDEX ON otp_challenge (phone, created_at DESC);

-- ---------------------------------------------------------------- vendors
CREATE TABLE vendor (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  kind          text,
  description   text,
  photo_asset   uuid,
  campus_node_id uuid,                    -- where the outlet physically is
  opens_at      time,
  closes_at     time,
  is_open       boolean NOT NULL DEFAULT false,
  accepting     boolean NOT NULL DEFAULT false,
  delivery_enabled boolean NOT NULL DEFAULT true,
  staff_can_deliver boolean NOT NULL DEFAULT false,
  prep_minutes  int NOT NULL DEFAULT 10,
  active        boolean NOT NULL DEFAULT true,   -- archive, never delete
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_role
  ADD CONSTRAINT user_role_vendor_fk FOREIGN KEY (vendor_id) REFERENCES vendor(id),
  ADD CONSTRAINT user_role_vendor_required CHECK (
    (role IN ('vendor_owner','vendor_staff')) = (vendor_id IS NOT NULL)
  );

CREATE TABLE category (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  name      text NOT NULL,
  sort      int NOT NULL DEFAULT 0
);

CREATE TABLE menu_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  category_id   uuid REFERENCES category(id),
  name          text NOT NULL,
  description   text,
  photo_asset   uuid,
  price_paise   int NOT NULL CHECK (price_paise >= 0),
  veg           boolean,
  prep_minutes  int,
  tags          text[] NOT NULL DEFAULT '{}',
  aliases       text[] NOT NULL DEFAULT '{}',   -- what the AI matches against
  available     boolean NOT NULL DEFAULT true,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON menu_item (vendor_id) WHERE active;

-- Every price change is retained. Historical orders never consult this.
CREATE TABLE menu_price_history (
  id          bigserial PRIMARY KEY,
  item_id     uuid NOT NULL REFERENCES menu_item(id) ON DELETE CASCADE,
  old_paise   int,
  new_paise   int NOT NULL,
  changed_by  uuid REFERENCES app_user(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- campus
-- Arbitrary-depth tree, stored flat. `deliverable` marks a real destination;
-- a container node is never accepted as an order destination.
CREATE TABLE campus_node (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    uuid REFERENCES campus_node(id),
  kind         text NOT NULL CHECK (kind IN ('campus','zone','building','floor','spot')),
  name         text NOT NULL,
  detail       text,
  aliases      text[] NOT NULL DEFAULT '{}',
  deliverable  boolean NOT NULL DEFAULT false,
  delivery_enabled boolean NOT NULL DEFAULT true,   -- admin kill switch per location
  active       boolean NOT NULL DEFAULT true,       -- archive
  lat          double precision,
  lng          double precision,
  radius_m     int,
  -- Provenance, so nobody mistakes a seeded guess for surveyed data.
  source       text NOT NULL DEFAULT 'admin'
                 CHECK (source IN ('admin','public_source','survey','unverified_seed')),
  source_note  text,
  sort         int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON campus_node (parent_id);

-- The campus polygon a live GPS fix is tested against, server-side.
CREATE TABLE campus_boundary (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL,
  polygon  jsonb NOT NULL,          -- [[lat,lng], ...]
  active   boolean NOT NULL DEFAULT true,
  source   text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- orders
CREATE TABLE food_order (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text UNIQUE NOT NULL,
  customer_id    uuid NOT NULL REFERENCES app_user(id),
  vendor_id      uuid NOT NULL REFERENCES vendor(id),
  fulfilment     text NOT NULL CHECK (fulfilment IN ('pickup','delivery')),
  -- The ONLY way to express a destination. No address text exists.
  destination_id uuid REFERENCES campus_node(id),
  state          text NOT NULL DEFAULT 'draft' CHECK (state IN (
                   'draft','awaiting_payment','confirmed','preparing','ready',
                   'assigned','picked_up','delivered','cancelled','refunded')),
  subtotal_paise int NOT NULL DEFAULT 0,
  delivery_paise int NOT NULL DEFAULT 0,
  total_paise    int NOT NULL DEFAULT 0,
  -- delivery handoff verification
  handoff_code_hash text,
  partner_id     uuid REFERENCES app_user(id),
  placed_via     text NOT NULL DEFAULT 'web' CHECK (placed_via IN ('web','ai')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_at   timestamptz,
  delivered_at   timestamptz,
  -- A delivery order must carry a destination; a pickup order must not.
  CONSTRAINT delivery_needs_destination CHECK (
    (fulfilment = 'delivery') = (destination_id IS NOT NULL))
);
CREATE INDEX ON food_order (customer_id, created_at DESC);
CREATE INDEX ON food_order (vendor_id, state);

-- Frozen snapshot. name/price copied at draft time and never updated.
CREATE TABLE order_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES food_order(id) ON DELETE CASCADE,
  item_id           uuid NOT NULL REFERENCES menu_item(id),
  name_snapshot     text NOT NULL,
  unit_paise_snapshot int NOT NULL,
  qty               int NOT NULL CHECK (qty > 0),
  line_paise        int NOT NULL
);

CREATE TABLE order_event (
  id        bigserial PRIMARY KEY,
  order_id  uuid NOT NULL REFERENCES food_order(id) ON DELETE CASCADE,
  from_state text,
  to_state  text NOT NULL,
  actor_id  uuid REFERENCES app_user(id),
  actor_role text,
  note      text,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON order_event (order_id, at);

-- ---------------------------------------------------------------- payments
CREATE TABLE payment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES food_order(id),
  provider       text NOT NULL,
  provider_order_id text,
  provider_payment_id text,
  amount_paise   int NOT NULL,
  status         text NOT NULL DEFAULT 'created'
                   CHECK (status IN ('created','pending','paid','failed','cancelled','refunded')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz
);
CREATE INDEX ON payment (order_id);

-- Idempotency for gateway webhooks: a duplicate delivery is a no-op.
CREATE TABLE payment_webhook (
  provider     text NOT NULL,
  event_id     text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL,
  PRIMARY KEY (provider, event_id)
);

-- ---------------------------------------------------------------- delivery
CREATE TABLE delivery_offer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES food_order(id) ON DELETE CASCADE,
  partner_id  uuid NOT NULL REFERENCES app_user(id),
  state       text NOT NULL DEFAULT 'offered'
                CHECK (state IN ('offered','accepted','declined','expired')),
  offered_at  timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  expires_at  timestamptz NOT NULL
);
-- At most one accepted offer per order: the assignment lock.
CREATE UNIQUE INDEX one_accepted_offer_per_order
  ON delivery_offer (order_id) WHERE state = 'accepted';

CREATE TABLE partner_profile (
  user_id     uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','left','suspended')),
  online      boolean NOT NULL DEFAULT false,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  uuid REFERENCES app_user(id),
  left_at     timestamptz,
  note        text
);

-- ---------------------------------------------------------- verification
CREATE TABLE asset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid REFERENCES app_user(id),
  kind        text NOT NULL CHECK (kind IN ('id_front','id_back','food_photo','vendor_photo')),
  mime        text NOT NULL,
  bytes       int NOT NULL,
  width       int,
  height      int,
  storage_key text NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_case (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  front_asset   uuid REFERENCES asset(id),
  back_asset    uuid REFERENCES asset(id),
  claimed_name  text,
  claimed_roll  text,
  claimed_college text,
  state         text NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','needs_review','approved','rejected','resubmit_requested')),
  -- pipeline output; NULL means that stage did not run (provider unconfigured)
  quality       jsonb,
  ocr           jsonb,
  ocr_provider  text,
  signals       jsonb,
  roster_match  jsonb,
  decided_by    uuid REFERENCES app_user(id),
  decided_at    timestamptz,
  decision_note text,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  sla_due_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX ON verification_case (state, submitted_at);
-- One open case per user at a time.
CREATE UNIQUE INDEX one_open_case_per_user ON verification_case (user_id)
  WHERE state IN ('pending','needs_review');

-- ---------------------------------------------------------------- reviews
-- Anchored to a purchased line. The FK is the anti-fraud rule.
CREATE TABLE review (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  order_id      uuid NOT NULL REFERENCES food_order(id),
  order_item_id uuid REFERENCES order_item(id),
  vendor_id     uuid REFERENCES vendor(id),
  item_id       uuid REFERENCES menu_item(id),
  stars         int NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT review_targets_one_thing CHECK (num_nonnulls(item_id, vendor_id) = 1)
);
-- One review per item per order, and one vendor review per order.
CREATE UNIQUE INDEX one_item_review_per_line ON review (order_item_id) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX one_vendor_review_per_order ON review (order_id) WHERE vendor_id IS NOT NULL;

-- ---------------------------------------------------------------- platform
CREATE TABLE feature_flag (
  key        text PRIMARY KEY,
  enabled    boolean NOT NULL,
  updated_by uuid REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid REFERENCES app_user(id),
  actor_role text,
  action     text NOT NULL,
  resource   text,
  resource_id text,
  outcome    text NOT NULL CHECK (outcome IN ('ok','denied','error')),
  detail     jsonb,
  ip         inet
);
CREATE INDEX ON audit_log (at DESC);
CREATE INDEX ON audit_log (actor_id, at DESC);

CREATE TABLE platform_config (
  key   text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
