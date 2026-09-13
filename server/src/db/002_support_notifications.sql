-- ===========================================================================
-- QUAD — migration 002
-- Support cases, notifications, refunds, review moderation, vendor contact,
-- delivery re-offer bookkeeping, and the indexes the admin tables need.
-- ===========================================================================

-- ---------------------------------------------------------------- support
CREATE TABLE support_case (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  user_id     uuid NOT NULL REFERENCES app_user(id),
  order_id    uuid REFERENCES food_order(id),
  category    text NOT NULL CHECK (category IN
                ('payment','delivery','food_quality','wrong_order','account','other')),
  subject     text NOT NULL,
  state       text NOT NULL DEFAULT 'open'
                CHECK (state IN ('open','awaiting_customer','resolved','closed')),
  assigned_to uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX ON support_case (state, created_at DESC);
CREATE INDEX ON support_case (user_id, created_at DESC);

CREATE TABLE support_message (
  id         bigserial PRIMARY KEY,
  case_id    uuid NOT NULL REFERENCES support_case(id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES app_user(id),
  author_role text NOT NULL,
  body       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON support_message (case_id, at);

-- Business contact per outlet, set by an admin. Personal numbers never
-- reach a customer: the student site reads only these columns.
ALTER TABLE vendor
  ADD COLUMN contact_phone text,
  ADD COLUMN contact_email text,
  ADD COLUMN contact_public boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------- notifications
-- A row is the intent to notify. `state` records what actually happened, so
-- an unconfigured provider leaves 'unsent' rather than a fake 'delivered'.
CREATE TABLE notification (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('sms','email','push','inapp')),
  title      text NOT NULL,
  body       text,
  data       jsonb,
  state      text NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued','sent','failed','unsent_no_provider')),
  provider   text,
  provider_ref text,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  read_at    timestamptz
);
CREATE INDEX ON notification (user_id, created_at DESC);
CREATE INDEX ON notification (state) WHERE state = 'queued';

-- ---------------------------------------------------------------- refunds
CREATE TABLE refund (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES food_order(id),
  payment_id     uuid NOT NULL REFERENCES payment(id),
  amount_paise   int NOT NULL CHECK (amount_paise > 0),
  reason         text NOT NULL,
  state          text NOT NULL DEFAULT 'requested'
                   CHECK (state IN ('requested','processing','completed','failed')),
  requested_by   uuid NOT NULL REFERENCES app_user(id),
  provider_refund_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz,
  error          text
);
CREATE INDEX ON refund (order_id);
-- One live refund per payment; a completed one blocks a second.
CREATE UNIQUE INDEX one_open_refund_per_payment ON refund (payment_id)
  WHERE state IN ('requested','processing','completed');

-- ------------------------------------------------------- review moderation
ALTER TABLE review
  ADD COLUMN hidden boolean NOT NULL DEFAULT false,
  ADD COLUMN hidden_by uuid REFERENCES app_user(id),
  ADD COLUMN hidden_reason text,
  ADD COLUMN hidden_at timestamptz;

-- ------------------------------------------------------- delivery re-offer
ALTER TABLE delivery_offer ADD COLUMN round int NOT NULL DEFAULT 1;
CREATE INDEX ON delivery_offer (partner_id, state) WHERE state = 'offered';
CREATE INDEX ON delivery_offer (order_id, state);

-- Partner presence. Coordinates are optional and overwritten in place —
-- there is deliberately no location history table.
ALTER TABLE partner_profile
  ADD COLUMN last_lat double precision,
  ADD COLUMN last_lng double precision,
  ADD COLUMN last_seen_at timestamptz;

-- --------------------------------------------------------------- indexes
CREATE INDEX ON food_order (state, created_at DESC);
CREATE INDEX ON food_order (partner_id, state);
CREATE INDEX ON menu_item (vendor_id, available) WHERE active;
CREATE INDEX ON review (item_id) WHERE NOT hidden;
CREATE INDEX ON review (vendor_id) WHERE NOT hidden;
CREATE INDEX ON app_user (student_status);
-- Trigram-free prefix search support for the admin user table.
CREATE INDEX ON app_user (lower(name));
CREATE INDEX ON campus_node (lower(name));
