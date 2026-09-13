-- ===========================================================================
-- QUAD - migration 011: campuses, student profile, partner identity,
--        delivery incidents, partner security deposit, delivery reviews
--
-- Everything here is additive. No existing column changes meaning, and the
-- order, payment, handover and ledger rules from earlier migrations stand.
-- The ledger gains two account kinds and three transaction kinds; it stays
-- double-entry, append-only and idempotent exactly as 004 defined it.
-- ===========================================================================

-- ------------------------------------------------------------------ campus
-- A campus a student can belong to and a cafeteria can operate on. Service
-- status is data an administrator changes, not code: a campus that is
-- 'coming_soon' can be selected but cannot be ordered from, and the server
-- enforces that at draft time.
CREATE TABLE campus_site (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE NOT NULL,
  college_name    text NOT NULL,
  name            text NOT NULL,
  service_status  text NOT NULL DEFAULT 'coming_soon'
                    CHECK (service_status IN ('active','coming_soon','paused')),
  status_message  text,
  sort            int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO campus_site (slug, college_name, name, service_status, status_message, sort) VALUES
  ('upes-bidholi',  'UPES - University of Petroleum and Energy Studies', 'Bidholi Campus',
   'active', NULL, 1),
  ('upes-kandholi', 'UPES - University of Petroleum and Energy Studies', 'Kandholi Campus',
   'coming_soon', 'Service coming soon for Kandholi Campus.', 2);

ALTER TABLE vendor ADD COLUMN campus_site_id uuid REFERENCES campus_site(id);
-- Every outlet that exists before this migration was set up for Bidholi,
-- the only campus ECHO ECHO has operated on.
UPDATE vendor SET campus_site_id = (SELECT id FROM campus_site WHERE slug = 'upes-bidholi')
 WHERE campus_site_id IS NULL;
CREATE INDEX ON vendor (campus_site_id);

-- ----------------------------------------------------------------- profile
-- Profile completeness is COMPUTED by the server from these columns on every
-- request. There is no "profile_complete" flag a client could set.
ALTER TABLE app_user ADD COLUMN campus_site_id uuid REFERENCES campus_site(id);
ALTER TABLE app_user ADD COLUMN profile_updated_at timestamptz;

-- ------------------------------------------------------- partner identity
ALTER TABLE asset DROP CONSTRAINT asset_kind_check;
ALTER TABLE asset ADD CONSTRAINT asset_kind_check
  CHECK (kind IN ('id_front','id_back','food_photo','vendor_photo','partner_photo'));

-- The photo a customer sees when this person arrives with their order.
ALTER TABLE app_user ADD COLUMN partner_photo_asset uuid REFERENCES asset(id);

-- ------------------------------------------------------ delivery incidents
-- A report is a claim, not a finding. Nothing about a partner changes when a
-- report is filed; an administrator investigates and records an outcome.
CREATE TABLE delivery_incident (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text UNIQUE NOT NULL,
  order_id      uuid NOT NULL REFERENCES food_order(id),
  -- the partner the order was tied to when the report was filed
  partner_id    uuid REFERENCES app_user(id),
  reported_by   uuid NOT NULL REFERENCES app_user(id),
  reporter_role text NOT NULL CHECK (reporter_role IN ('customer','partner','vendor','admin')),
  category      text NOT NULL CHECK (category IN (
                  'damaged','tampered','missing','partner_not_received',
                  'not_delivered','wrong_order','spilled')),
  description   text NOT NULL CHECK (length(description) >= 10),
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open','investigating','resolved')),
  outcome       text CHECK (outcome IN ('no_fault_found','partner_responsible',
                  'cafeteria_responsible','customer_claim_not_supported','other')),
  resolution_note text,
  resolved_by   uuid REFERENCES app_user(id),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resolution_is_complete CHECK (
    state <> 'resolved' OR (outcome IS NOT NULL AND resolved_by IS NOT NULL
      AND resolved_at IS NOT NULL AND length(coalesce(resolution_note,'')) >= 10))
);
CREATE INDEX ON delivery_incident (state, created_at DESC);
CREATE INDEX ON delivery_incident (partner_id, state);
CREATE INDEX ON delivery_incident (order_id);
-- One open report per person per order: a second complaint is a message on
-- the first, not a pile-on.
CREATE UNIQUE INDEX one_open_incident_per_reporter ON delivery_incident (order_id, reported_by)
  WHERE state <> 'resolved';

-- ----------------------------------------------------------- deposit policy
-- Versioned like pricing_policy: a change closes the live version and opens a
-- new one, so a partner's consent always points at the exact terms they saw.
CREATE TABLE partner_deposit_policy (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_paise         int  NOT NULL CHECK (amount_paise >= 0),
  dispute_window_hours int  NOT NULL CHECK (dispute_window_hours BETWEEN 24 AND 720),
  terms                text NOT NULL CHECK (length(terms) >= 50),
  effective_from       timestamptz NOT NULL DEFAULT now(),
  effective_to         timestamptz,
  created_by           uuid REFERENCES app_user(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_live_deposit_policy ON partner_deposit_policy ((1))
  WHERE effective_to IS NULL;

CREATE FUNCTION partner_deposit_policy_immutable() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'partner_deposit_policy rows are never deleted';
  END IF;
  IF (NEW.amount_paise, NEW.dispute_window_hours, NEW.terms, NEW.effective_from)
     IS DISTINCT FROM (OLD.amount_paise, OLD.dispute_window_hours, OLD.terms, OLD.effective_from)
     OR (OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to) THEN
    RAISE EXCEPTION 'partner_deposit_policy % is immutable; publish a new version', OLD.id;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER partner_deposit_policy_immutable
  BEFORE UPDATE OR DELETE ON partner_deposit_policy
  FOR EACH ROW EXECUTE FUNCTION partner_deposit_policy_immutable();

-- The first version requires no deposit. The amount is a business decision
-- for an administrator to make in Campus Control; it is not assumed here.
INSERT INTO partner_deposit_policy (amount_paise, dispute_window_hours, terms) VALUES (0, 72,
'ECHO ECHO delivery partner security deposit. The deposit protects customers, cafeterias and ECHO ECHO against proven serious misconduct, loss, deliberate misuse or damage of an order in your care. It is held separately from your delivery earnings and is never mixed with them. Nothing is deducted automatically and nothing is deducted because of a complaint alone: a deduction requires a delivery incident that an administrator has investigated and resolved as your responsibility, a written reason and evidence, and a recorded administrator decision. You are notified of every proposed deduction and may dispute it within the dispute window; a disputed deduction is decided by an administrator before any money moves. Every deduction is recorded permanently in the ledger. When you leave the programme with no delivery in progress, no open incident and no pending deduction, the remaining balance is returned to you by bank transfer and recorded with its bank reference.');

CREATE TABLE partner_policy_consent (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  policy_id   uuid NOT NULL REFERENCES partner_deposit_policy(id),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip          inet,
  user_agent  text,
  UNIQUE (user_id, policy_id)
);

-- ------------------------------------------------------------ ledger kinds
-- partner_deposit  liability, per partner: deposit money held for them
-- deposit_bank     asset, platform-wide: the bank money that backs deposits
ALTER TABLE ledger_account DROP CONSTRAINT ledger_account_kind_check;
ALTER TABLE ledger_account ADD CONSTRAINT ledger_account_kind_check CHECK (kind IN (
  'gateway_clearing','gateway_fee','platform_revenue','cafeteria_payable',
  'delivery_clearing','delivery_payable','tax_payable',
  'partner_deposit','deposit_bank'));
ALTER TABLE ledger_account DROP CONSTRAINT party_matches_kind;
ALTER TABLE ledger_account ADD CONSTRAINT party_matches_kind CHECK (
  (kind = 'cafeteria_payable') = (vendor_id IS NOT NULL) AND
  (kind IN ('delivery_payable','partner_deposit')) = (partner_id IS NOT NULL));

ALTER TABLE ledger_txn DROP CONSTRAINT ledger_txn_kind_check;
ALTER TABLE ledger_txn ADD CONSTRAINT ledger_txn_kind_check CHECK (kind IN (
  'order_capture','delivery_earned','refund','payout','adjustment',
  'deposit_received','deposit_deduction','deposit_refund'));

INSERT INTO ledger_account (kind, normal) VALUES ('deposit_bank','debit');

-- ------------------------------------------------------- deposit movements
-- Real money in and out, each carrying the bank's own reference. No payment
-- provider collects deposits in this deployment, so a receipt is recorded by
-- an administrator who has seen the transfer arrive.
CREATE TABLE deposit_movement (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id         uuid NOT NULL REFERENCES app_user(id),
  kind               text NOT NULL CHECK (kind IN ('received','refunded')),
  amount_paise       int  NOT NULL CHECK (amount_paise > 0),
  method             text NOT NULL CHECK (method IN ('manual_bank_transfer','manual_upi')),
  external_reference text NOT NULL CHECK (length(external_reference) >= 6),
  note               text,
  recorded_by        uuid NOT NULL REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, external_reference)
);
CREATE INDEX ON deposit_movement (partner_id, created_at DESC);

-- ------------------------------------------------------ deposit deductions
CREATE TABLE deposit_deduction (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id       uuid NOT NULL REFERENCES app_user(id),
  incident_id      uuid NOT NULL REFERENCES delivery_incident(id),
  order_id         uuid NOT NULL REFERENCES food_order(id),
  amount_paise     int  NOT NULL CHECK (amount_paise > 0),
  reason           text NOT NULL CHECK (length(reason) >= 10),
  evidence         text NOT NULL CHECK (length(evidence) >= 20),
  state            text NOT NULL DEFAULT 'proposed' CHECK (state IN (
                     'proposed','disputed','upheld','dismissed','withdrawn','applied')),
  proposed_by      uuid NOT NULL REFERENCES app_user(id),
  proposed_at      timestamptz NOT NULL DEFAULT now(),
  dispute_deadline timestamptz NOT NULL,
  dispute_text     text,
  disputed_at      timestamptz,
  review_note      text,
  reviewed_by      uuid REFERENCES app_user(id),
  reviewed_at      timestamptz,
  applied_by       uuid REFERENCES app_user(id),
  applied_at       timestamptz,
  CONSTRAINT dispute_is_written CHECK (
    disputed_at IS NULL OR length(coalesce(dispute_text,'')) >= 20),
  CONSTRAINT review_is_recorded CHECK (
    state NOT IN ('upheld','dismissed') OR
    (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(coalesce(review_note,'')) >= 10)),
  CONSTRAINT applied_is_attributed CHECK (
    state <> 'applied' OR (applied_by IS NOT NULL AND applied_at IS NOT NULL))
);
CREATE INDEX ON deposit_deduction (partner_id, state);
CREATE UNIQUE INDEX one_live_deduction_per_incident ON deposit_deduction (incident_id)
  WHERE state NOT IN ('dismissed','withdrawn');

CREATE TABLE deposit_refund_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   uuid NOT NULL REFERENCES app_user(id),
  state        text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','paid','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  movement_id  uuid REFERENCES deposit_movement(id),
  decided_by   uuid REFERENCES app_user(id),
  decided_at   timestamptz,
  note         text,
  CONSTRAINT paid_has_movement CHECK (state <> 'paid' OR movement_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_open_deposit_refund ON deposit_refund_request (partner_id)
  WHERE state = 'requested';

-- ----------------------------------------------------------------- reviews
-- A third review target: the delivery. One per order, like the cafeteria.
ALTER TABLE review ADD COLUMN partner_id uuid REFERENCES app_user(id);
ALTER TABLE review DROP CONSTRAINT review_targets_one_thing;
ALTER TABLE review ADD CONSTRAINT review_targets_one_thing
  CHECK (num_nonnulls(item_id, vendor_id, partner_id) = 1);
CREATE UNIQUE INDEX one_delivery_review_per_order ON review (order_id) WHERE partner_id IS NOT NULL;
CREATE INDEX ON review (partner_id) WHERE NOT hidden;

-- A published rating is never edited or deleted. Moderation hides a review;
-- it does not rewrite what the customer said.
CREATE FUNCTION review_immutable() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reviews are never deleted; hide them instead';
  END IF;
  IF (NEW.user_id, NEW.order_id, NEW.order_item_id, NEW.item_id, NEW.vendor_id,
      NEW.partner_id, NEW.stars, NEW.body, NEW.created_at)
     IS DISTINCT FROM
     (OLD.user_id, OLD.order_id, OLD.order_item_id, OLD.item_id, OLD.vendor_id,
      OLD.partner_id, OLD.stars, OLD.body, OLD.created_at) THEN
    RAISE EXCEPTION 'review % is immutable; only moderation fields may change', OLD.id;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER review_immutable BEFORE UPDATE OR DELETE ON review
  FOR EACH ROW EXECUTE FUNCTION review_immutable();

CREATE TABLE review_report (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   uuid NOT NULL REFERENCES review(id),
  reported_by uuid NOT NULL REFERENCES app_user(id),
  reason      text NOT NULL CHECK (length(reason) >= 5),
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
  resolution  text,
  resolved_by uuid REFERENCES app_user(id),
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, reported_by)
);
CREATE INDEX ON review_report (state, created_at DESC);
