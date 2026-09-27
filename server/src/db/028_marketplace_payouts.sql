-- ==========================================================================
-- ECHO ECHO — MARKETPLACE PAYOUTS  (migration 028)
--
-- What this adds on top of the ledger (004), settlement (005), provider
-- payouts (007) and reconciliation (009):
--
--   1. Verified settlement accounts. A payee (café or delivery partner) is
--      paid only into a destination whose verification_status is 'verified'.
--      Until then the café's settlement status reads PENDING, its earnings
--      keep accruing in the ledger, and no payout is attempted.
--      Only masked hints are stored (last four digits, masked UPI id, IFSC).
--      The full account number goes to the payout provider and nowhere else.
--
--   2. Partner-initiated withdrawals. A withdrawal is a `payout` row with
--      origin 'withdrawal', so it inherits paid_has_evidence, the one-live-
--      payout-per-payee index and the ledger's (kind, ref) uniqueness. The
--      partner's Idempotency-Key is unique per partner.
--
--   3. Payout provider status: the last status the provider reported and
--      when, so a transfer that was accepted but not yet settled can be
--      re-checked instead of guessed at.
--
--   4. Easy Split readiness: the Cashfree vendor id per café and the split
--      requested on each payment. Off unless CASHFREE_EASY_SPLIT=on AND the
--      café's split account is 'active' — which only Cashfree can make true.
--
--   5. Delivery incidents: two more categories (lost, suspected theft), an
--      append-only event trail, and the recorded actions of a resolution.
--
--   6. Reconciliation: four more exception kinds, and a duplicate counter on
--      payment webhooks so duplicates are measured, not merely absorbed.
-- ==========================================================================

-- ---------------------------------------------------------------- 1. accounts
ALTER TABLE payout_destination
  ADD COLUMN instrument text CHECK (instrument IN ('bank','upi')),
  ADD COLUMN masked text,                    -- 'XXXXXX1234' or 'as***@okhdfc'
  ADD COLUMN ifsc text,                      -- public branch code, not a secret
  ADD COLUMN holder_name text,
  -- HMAC of the normalised account/UPI id under a server secret: lets a
  -- re-entered instrument find its existing provider beneficiary (Cashfree
  -- refuses duplicates) without storing the instrument itself.
  ADD COLUMN instrument_fingerprint text,
  ADD COLUMN verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','failed')),
  ADD COLUMN verification_note text,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verified_by uuid REFERENCES app_user(id);

-- Destinations that existed before this migration were provisioned by an
-- administrator directly at the provider; they keep working.
UPDATE payout_destination SET verification_status = 'verified', verified_at = created_at
 WHERE verification_status = 'pending';

ALTER TABLE payout_destination ADD CONSTRAINT verified_is_attributed CHECK (
  verification_status <> 'verified' OR verified_at IS NOT NULL);

CREATE INDEX ON payout_destination (provider, instrument_fingerprint);

COMMENT ON COLUMN payout_destination.masked IS
  'A masked hint for humans. The full account number / UPI id is held only by the payout provider.';

-- The café settlement status, derived — never typed in.
CREATE VIEW v_vendor_settlement_account AS
SELECT v.id AS vendor_id, v.name,
       d.id AS destination_id, d.provider, d.instrument, d.masked, d.ifsc,
       d.verification_status, d.verified_at,
       CASE WHEN d.id IS NULL THEN 'PENDING'
            WHEN d.verification_status = 'verified' THEN 'VERIFIED'
            WHEN d.verification_status = 'failed' THEN 'FAILED'
            ELSE 'PENDING_VERIFICATION' END AS settlement_status
  FROM vendor v
  LEFT JOIN LATERAL (
    SELECT * FROM payout_destination x
     WHERE x.vendor_id = v.id AND x.active
     ORDER BY (x.verification_status = 'verified') DESC, x.created_at DESC LIMIT 1) d ON true;

-- ---------------------------------------------------------------- 2. withdrawals
ALTER TABLE payout
  ADD COLUMN origin text NOT NULL DEFAULT 'batch' CHECK (origin IN ('batch','withdrawal')),
  ADD COLUMN idempotency_key text,
  ADD COLUMN provider_status text,
  ADD COLUMN provider_synced_at timestamptz,
  ADD COLUMN failed_at timestamptz,
  ADD COLUMN retry_of uuid REFERENCES payout(id);

CREATE UNIQUE INDEX payout_withdrawal_idempotency
  ON payout (partner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE payout DROP CONSTRAINT IF EXISTS payout_method_check;
ALTER TABLE payout ADD CONSTRAINT payout_method_check CHECK (
  method IN ('razorpayx','cashfree_payouts','manual_bank_transfer','cashfree_easy_split'));

-- Payout configuration. Read at request time, so changing a number here is a
-- configuration change and never a deploy.
INSERT INTO platform_config (key, value) VALUES
  ('partner_payout_config', jsonb_build_object(
     'frequency', 'weekly',            -- weekly | daily | on_request
     'min_withdrawal_paise', 10000,    -- 100.00: below this a partner cannot withdraw
     'min_balance_paise', 10000,       -- the scheduled weekly run's floor
     'method', 'bank_or_upi',          -- bank | upi | bank_or_upi
     'earning_hold_hours', 24          -- an earning is 'pending' this long after delivery
  ))
ON CONFLICT (key) DO NOTHING;

-- Cashfree Payouts webhooks, idempotent like payment_webhook.
CREATE TABLE payout_webhook (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL,
  duplicate_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, event_id)
);

-- ---------------------------------------------------------------- 4. easy split
CREATE TABLE vendor_split_account (
  vendor_id    uuid PRIMARY KEY REFERENCES vendor(id),
  provider     text NOT NULL DEFAULT 'cashfree',
  provider_vendor_id text NOT NULL,
  -- 'active' is set only from the provider's own answer, never by hand.
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','active','blocked','rejected')),
  provider_status text,
  checked_at   timestamptz,
  created_by   uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_split (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payment(id),
  vendor_id    uuid NOT NULL REFERENCES vendor(id),
  provider_vendor_id text NOT NULL,
  amount_paise int NOT NULL CHECK (amount_paise > 0),
  state        text NOT NULL DEFAULT 'requested'
                 CHECK (state IN ('requested','settled','reversed','void')),
  payout_id    uuid REFERENCES payout(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, vendor_id)
);

-- ---------------------------------------------------------------- 5. incidents
ALTER TABLE delivery_incident DROP CONSTRAINT IF EXISTS delivery_incident_category_check;
ALTER TABLE delivery_incident ADD CONSTRAINT delivery_incident_category_check CHECK (category IN (
  'damaged','tampered','missing','partner_not_received','not_delivered','wrong_order','spilled',
  'lost','suspected_theft'));
ALTER TABLE delivery_incident
  ADD COLUMN evidence text,
  ADD COLUMN actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN earning_adjustment_paise int CHECK (earning_adjustment_paise IS NULL OR earning_adjustment_paise > 0);

CREATE TABLE delivery_incident_event (
  id          bigserial PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES delivery_incident(id),
  actor_id    uuid REFERENCES app_user(id),
  event       text NOT NULL,         -- reported | under_review | resolved | action:<name>
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON delivery_incident_event (incident_id, id);

CREATE FUNCTION incident_event_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'delivery_incident_event is append-only';
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER incident_event_append_only BEFORE UPDATE OR DELETE ON delivery_incident_event
  FOR EACH ROW EXECUTE FUNCTION incident_event_append_only();

-- Existing incidents get their first event so every trail starts at "reported".
INSERT INTO delivery_incident_event (incident_id, actor_id, event, detail, created_at)
SELECT id, reported_by, 'reported', jsonb_build_object('category', category), created_at
  FROM delivery_incident;

-- ---------------------------------------------------------------- 6. reconciliation
ALTER TABLE reconciliation_exception DROP CONSTRAINT IF EXISTS reconciliation_exception_kind_check;
ALTER TABLE reconciliation_exception ADD CONSTRAINT reconciliation_exception_kind_check CHECK (kind IN (
  'missing_payment','unsettled_payment','order_mismatch','amount_mismatch','fee_mismatch',
  'unexpected_deduction','duplicate_provider_txn','partial_settlement','refund_unmatched',
  'payout_already_executed',
  'missing_webhook',     -- a payment was confirmed only by a status pull; its webhook never came
  'refund_mismatch',     -- the provider's refund status disagrees with Quad's refund row
  'refund_stuck',        -- a refund accepted by the provider has not completed in time
  'payout_mismatch'));   -- the provider's transfer status disagrees with Quad's payout row

ALTER TABLE payment_webhook ADD COLUMN duplicate_count int NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------- 7. partner terms
-- A new version of the partner terms, published the way the table requires:
-- close the live version, open a new one. The deposit amount and dispute
-- window are carried over unchanged; only the text grows. Partners consent
-- to the exact version they were shown (partner_policy_consent).
WITH live AS (
  UPDATE partner_deposit_policy SET effective_to = now()
   WHERE effective_to IS NULL
  RETURNING amount_paise, dispute_window_hours)
INSERT INTO partner_deposit_policy (amount_paise, dispute_window_hours, terms)
SELECT amount_paise, dispute_window_hours,
'ECHO ECHO DELIVERY PARTNER TERMS

1. Handling orders. You must carry every order sealed, directly and promptly from the café counter to the customer. You must not open, consume, tamper with, swap or intentionally damage any order, or hand it to anyone other than the customer who gives you their delivery code.

2. Earnings. You earn the delivery earning recorded on each order when the customer''s delivery code is verified (currently Rs 10 per delivery, or Rs 15 when the food subtotal is Rs 300 or more; the rate in force when an order is placed is the rate paid for it). You are not paid for an order that is cancelled or never delivered. A new earning is shown as pending for a short hold period, and while a report about that order is under review; it then becomes available.

3. Payouts. You are paid to a bank account or UPI ID in your own name, which must be verified before a withdrawal is possible. You can withdraw your available balance once it reaches the published minimum (currently Rs 100), on the published cycle (currently weekly). A payout that fails is not lost: the amount stays in your balance and can be retried.

4. Incidents. If an order is damaged, spilled, lost or you suspect tampering, report it in the app straight away. Reports by customers, cafés or partners are investigated by ECHO ECHO before any decision; nothing is deducted and no action is taken on an accusation alone. Every step is recorded.

5. Outcomes. Where an investigation, based on evidence, finds you responsible for loss or damage, ECHO ECHO may apply an adjustment to your earnings (never more than the value of the order), and you are told the reason. Suspected theft or misconduct can lead to suspension while it is investigated. Repeated confirmed incidents can lead to suspension or removal from the delivery programme. Fraudulent complaints and false reports, by anyone, are also investigated.

6. Security deposit. The deposit protects customers, cafeterias and ECHO ECHO against proven serious misconduct, loss, deliberate misuse or damage of an order in your care. It is held separately from your delivery earnings and is never mixed with them. Nothing is deducted automatically and nothing is deducted because of a complaint alone: a deduction requires a delivery incident that an administrator has investigated and resolved as your responsibility, a written reason and evidence, and a recorded administrator decision. You are notified of every proposed deduction and may dispute it within the dispute window; a disputed deduction is decided by an administrator before any money moves. Every deduction is recorded permanently in the ledger. When you leave the programme with no delivery in progress, no open incident and no pending deduction, the remaining balance is returned to you by bank transfer and recorded with its bank reference.

7. These terms apply subject to applicable law. They are changed only by publishing a new version, which you are asked to accept.'
FROM live;
