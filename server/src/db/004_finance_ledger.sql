-- ==========================================================================
-- QUAD — FINANCIAL LEDGER, SETTLEMENT AND PAYOUTS  (migration 004)
--
-- Money in this product is integer paise, and every rupee a customer pays
-- is allocated the moment it is captured. Three questions have to be
-- answerable from the database alone, for any order, at any later date:
--
--   where did the money go, who is still owed it, and has it been paid?
--
-- Nothing here recalculates an old order from today's configuration. The
-- commercial terms that applied are pinned to the order by
-- order_financials.pricing_policy_id, and the resulting amounts are frozen
-- in order_financials, which a trigger makes physically immutable.
--
-- The ledger is double entry in the debit-positive convention: every
-- transaction is a set of ledger_entry rows whose amount_paise sums to
-- exactly zero, enforced by a deferred constraint trigger. Assets
-- (gateway_clearing) and expenses (gateway_fee) are positive when they
-- increase; liabilities (payables, tax) and revenue are negative when they
-- increase. v_account_balance flips the sign so a payable reads as a
-- positive amount owed.
-- ==========================================================================

-- ---------------------------------------------------------- pricing policy
-- Versioned commercial terms. A change NEVER updates a row: it closes the
-- current version and inserts a new one, so an order placed last month can
-- still resolve the terms it was priced under.
CREATE TABLE pricing_policy (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL vendor_id is the platform default; a row with a vendor overrides it.
  vendor_id        uuid REFERENCES vendor(id),

  -- Cafeteria commission, in basis points of the food subtotal. 200 = 2%.
  commission_bps   int  NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  -- How the commission is treated commercially. This is the two-rupee
  -- question, and it is a configured choice rather than an assumption:
  --   deduct_from_cafeteria — the customer pays 100 rupees of food and the
  --     cafeteria is paid 98. Commission is Quad revenue taken out of the
  --     cafeteria's share.
  --   charge_to_customer    — the customer pays 102, the cafeteria is paid
  --     100, and the 2 rupees is Quad revenue collected on top.
  commission_mode  text NOT NULL DEFAULT 'deduct_from_cafeteria'
                     CHECK (commission_mode IN ('deduct_from_cafeteria','charge_to_customer')),

  -- Platform fee charged to the customer: a flat amount plus an optional
  -- proportion of the food subtotal.
  platform_fee_flat_paise int NOT NULL DEFAULT 0 CHECK (platform_fee_flat_paise >= 0),
  platform_fee_bps        int NOT NULL DEFAULT 0 CHECK (platform_fee_bps BETWEEN 0 AND 10000),

  -- What the customer is charged for delivery, and what the partner earns
  -- for it. They are separate numbers on purpose: the difference is Quad's
  -- delivery margin (or, when negative, its subsidy), and it is recorded.
  delivery_fee_paise      int NOT NULL DEFAULT 0 CHECK (delivery_fee_paise >= 0),
  delivery_earning_paise  int NOT NULL DEFAULT 0 CHECK (delivery_earning_paise >= 0),

  -- Tax charged to the customer on the food subtotal. Tax is not Quad
  -- revenue; it lands in its own payable account.
  tax_bps          int NOT NULL DEFAULT 0 CHECK (tax_bps BETWEEN 0 AND 10000),

  -- Who funds a discount, when one is applied.
  discount_funded_by text NOT NULL DEFAULT 'platform'
                     CHECK (discount_funded_by IN ('platform','cafeteria')),

  note             text,
  effective_from   timestamptz NOT NULL DEFAULT now(),
  effective_to     timestamptz,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
-- Exactly one live policy per scope. The platform default and a vendor
-- override are different scopes; a second live row in either is a bug.
CREATE UNIQUE INDEX one_live_platform_policy ON pricing_policy ((1))
  WHERE vendor_id IS NULL AND effective_to IS NULL;
CREATE UNIQUE INDEX one_live_vendor_policy ON pricing_policy (vendor_id)
  WHERE vendor_id IS NOT NULL AND effective_to IS NULL;
CREATE INDEX ON pricing_policy (vendor_id, effective_from DESC);

-- A policy that has priced an order can never be edited or removed: the
-- order's snapshot cites it, and an audit has to be able to read it back.
CREATE FUNCTION pricing_policy_immutable() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pricing_policy rows are never deleted (id=%)', OLD.id;
  END IF;
  -- Closing a version is the one permitted change.
  IF (NEW.vendor_id, NEW.commission_bps, NEW.commission_mode,
      NEW.platform_fee_flat_paise, NEW.platform_fee_bps, NEW.delivery_fee_paise,
      NEW.delivery_earning_paise, NEW.tax_bps, NEW.discount_funded_by,
      NEW.effective_from)
     IS DISTINCT FROM
     (OLD.vendor_id, OLD.commission_bps, OLD.commission_mode,
      OLD.platform_fee_flat_paise, OLD.platform_fee_bps, OLD.delivery_fee_paise,
      OLD.delivery_earning_paise, OLD.tax_bps, OLD.discount_funded_by,
      OLD.effective_from) THEN
    RAISE EXCEPTION 'pricing_policy % is immutable; supersede it with a new version', OLD.id;
  END IF;
  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'pricing_policy % is already closed', OLD.id;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER pricing_policy_immutable
  BEFORE UPDATE OR DELETE ON pricing_policy
  FOR EACH ROW EXECUTE FUNCTION pricing_policy_immutable();

-- ------------------------------------------------------- order financials
-- The immutable snapshot. One row per order, written inside the same
-- transaction that creates the order, never touched again.
CREATE TABLE order_financials (
  order_id          uuid PRIMARY KEY REFERENCES food_order(id) ON DELETE RESTRICT,
  pricing_policy_id uuid NOT NULL REFERENCES pricing_policy(id),
  currency          text NOT NULL DEFAULT 'INR',

  -- what the customer was charged, component by component
  food_subtotal_paise int NOT NULL CHECK (food_subtotal_paise >= 0),
  discount_paise      int NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  tax_paise           int NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  delivery_fee_paise  int NOT NULL DEFAULT 0 CHECK (delivery_fee_paise >= 0),
  platform_fee_paise  int NOT NULL DEFAULT 0 CHECK (platform_fee_paise >= 0),
  commission_paise    int NOT NULL DEFAULT 0 CHECK (commission_paise >= 0),
  customer_total_paise int NOT NULL CHECK (customer_total_paise >= 0),

  -- where that money belongs
  cafeteria_payable_paise int NOT NULL CHECK (cafeteria_payable_paise >= 0),
  delivery_earning_paise  int NOT NULL DEFAULT 0 CHECK (delivery_earning_paise >= 0),
  tax_payable_paise       int NOT NULL DEFAULT 0 CHECK (tax_payable_paise >= 0),
  -- Gross platform take: platform fee + commission + delivery margin, less
  -- any platform-funded discount. May be negative if Quad subsidises.
  platform_gross_paise    int NOT NULL,
  -- Charged by the payment gateway out of the collected amount. Recorded
  -- only when the provider actually reports it; 0 until then.
  gateway_fee_paise       int NOT NULL DEFAULT 0 CHECK (gateway_fee_paise >= 0),

  -- the terms as they were, copied so a reader never has to join
  commission_mode    text NOT NULL,
  discount_funded_by text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- THE identity. Every paisa the customer pays belongs to exactly one of
  -- these four parties. If this ever fails, the order is not created.
  CONSTRAINT allocation_balances CHECK (
    customer_total_paise = cafeteria_payable_paise + delivery_earning_paise
                         + tax_payable_paise + platform_gross_paise),
  -- and the customer-facing total is the sum of what was quoted
  CONSTRAINT total_is_the_quote CHECK (
    customer_total_paise = food_subtotal_paise - discount_paise + tax_paise
                         + delivery_fee_paise + platform_fee_paise
                         + CASE WHEN commission_mode = 'charge_to_customer'
                                THEN commission_paise ELSE 0 END)
);

CREATE FUNCTION order_financials_immutable() RETURNS trigger AS $fn$
BEGIN
  -- The gateway fee is the single field a provider may report late, and it
  -- may be written exactly once, from zero.
  IF TG_OP = 'UPDATE'
     AND OLD.gateway_fee_paise = 0
     AND NEW.gateway_fee_paise >= 0
     AND (to_jsonb(NEW) - 'gateway_fee_paise') = (to_jsonb(OLD) - 'gateway_fee_paise') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'order_financials for order % is immutable', COALESCE(NEW.order_id, OLD.order_id);
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER order_financials_immutable
  BEFORE UPDATE OR DELETE ON order_financials
  FOR EACH ROW EXECUTE FUNCTION order_financials_immutable();

-- ------------------------------------------------------- ledger accounts
CREATE TABLE ledger_account (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN (
               'gateway_clearing',      -- asset: collected, not yet disbursed
               'gateway_fee',           -- expense: what the gateway kept
               'platform_revenue',      -- revenue: Quad's own money
               'cafeteria_payable',     -- liability: owed to one cafeteria
               'delivery_clearing',     -- liability: delivery money not yet earned
               'delivery_payable',      -- liability: owed to one partner
               'tax_payable')),         -- liability: owed to the tax authority
  -- Set for the per-party accounts, NULL for the platform-wide ones.
  vendor_id  uuid REFERENCES vendor(id),
  partner_id uuid REFERENCES app_user(id),
  -- Which way the account's balance naturally runs, so a reader never has
  -- to remember the sign convention.
  normal     text NOT NULL CHECK (normal IN ('debit','credit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT party_matches_kind CHECK (
    (kind = 'cafeteria_payable') = (vendor_id IS NOT NULL) AND
    (kind = 'delivery_payable')  = (partner_id IS NOT NULL))
);
-- One account per party per kind. COALESCE rather than NULLS NOT DISTINCT so
-- this works on PostgreSQL before 15 as well.
CREATE UNIQUE INDEX one_account_per_party ON ledger_account (
  kind,
  COALESCE(vendor_id,  '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(partner_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- --------------------------------------------------------- ledger entries
-- A transaction is a group of entries sharing a txn id. ledger_txn carries
-- the idempotency key: a webhook retry, a replayed refund or a double payout
-- click inserts nothing here and therefore allocates no money twice.
CREATE TABLE ledger_txn (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN (
               'order_capture','delivery_earned','refund','payout','adjustment')),
  -- The external fact this transaction records: a payment id, a refund id,
  -- a payout id, an order id. Unique with the kind, and that uniqueness IS
  -- the idempotency guarantee.
  ref        text NOT NULL,
  order_id   uuid REFERENCES food_order(id),
  memo       text,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref)
);
CREATE INDEX ON ledger_txn (order_id);
CREATE INDEX ON ledger_txn (created_at DESC);

CREATE TABLE ledger_entry (
  id           bigserial PRIMARY KEY,
  txn_id       uuid NOT NULL REFERENCES ledger_txn(id) ON DELETE RESTRICT,
  account_id   uuid NOT NULL REFERENCES ledger_account(id),
  -- Debit-positive. Sums to zero across a txn.
  amount_paise bigint NOT NULL CHECK (amount_paise <> 0),
  order_id     uuid REFERENCES food_order(id),
  payment_id   uuid REFERENCES payment(id),
  refund_id    uuid REFERENCES refund(id),
  payout_id    uuid,                       -- FK added below, once payout exists
  memo         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entry (account_id, created_at);
CREATE INDEX ON ledger_entry (txn_id);
CREATE INDEX ON ledger_entry (order_id);

-- A ledger entry is never edited or deleted. Corrections are new entries.
CREATE FUNCTION ledger_append_only() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'the ledger is append-only; post a correcting entry instead';
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_entry_append_only
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_txn_append_only
  BEFORE UPDATE OR DELETE ON ledger_txn
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- Double entry, enforced by the database rather than by convention. The
-- check is deferred to commit, so a transaction may post its legs in any
-- order, but it cannot commit unbalanced.
CREATE FUNCTION ledger_txn_balances() RETURNS trigger AS $fn$
DECLARE s bigint;
BEGIN
  SELECT COALESCE(sum(amount_paise), 0) INTO s FROM ledger_entry WHERE txn_id = NEW.txn_id;
  IF s <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % does not balance (off by % paise)', NEW.txn_id, s;
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_entry_balances
  AFTER INSERT ON ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_txn_balances();

-- ---------------------------------------------------------------- payouts
CREATE TABLE payout_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('cafeteria','partner')),
  period_start timestamptz,
  period_end   timestamptz,
  state        text NOT NULL DEFAULT 'open'
                 CHECK (state IN ('open','locked','completed','cancelled')),
  note         text,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  completed_at timestamptz
);
CREATE INDEX ON payout_batch (kind, created_at DESC);

-- Where a payee's money actually goes. Quad does not store bank account
-- numbers: the beneficiary is provisioned in the payout provider's console
-- and only the provider's opaque ids are kept here. A payee with no
-- destination cannot be paid through a provider, and the batch says so
-- rather than pretending.
CREATE TABLE payout_destination (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id  uuid REFERENCES vendor(id),
  partner_id uuid REFERENCES app_user(id),
  provider   text NOT NULL,
  provider_contact_id      text,
  provider_fund_account_id text,
  label      text,
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exactly_one_payee CHECK ((vendor_id IS NULL) <> (partner_id IS NULL))
);
CREATE UNIQUE INDEX one_active_destination_per_payee ON payout_destination (
  provider,
  COALESCE(vendor_id,  '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(partner_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE active;

CREATE TABLE payout (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id     uuid REFERENCES payout_batch(id),
  vendor_id    uuid REFERENCES vendor(id),
  partner_id   uuid REFERENCES app_user(id),
  amount_paise int NOT NULL CHECK (amount_paise > 0),
  state        text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','processing','paid','failed','cancelled')),
  -- 'razorpayx' for a provider transfer; 'manual_bank_transfer' for one an
  -- administrator performed themselves and is recording, with the bank's own
  -- reference. Nothing here is ever marked paid without one or the other
  -- actually existing — see the paid_has_evidence constraint.
  method       text CHECK (method IN ('razorpayx','manual_bank_transfer')),
  provider_payout_id text,
  external_reference text,                 -- UTR / NEFT reference for a manual transfer
  destination_id uuid REFERENCES payout_destination(id),
  failure_reason text,
  initiated_by uuid REFERENCES app_user(id),
  recorded_by  uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  CONSTRAINT exactly_one_payee CHECK ((vendor_id IS NULL) <> (partner_id IS NULL)),
  -- A paid payout must be able to point at the money movement that made it
  -- true. This is what stops a "settled" state that never left a bank.
  CONSTRAINT paid_has_evidence CHECK (
    state <> 'paid' OR (paid_at IS NOT NULL AND method IS NOT NULL AND
      (provider_payout_id IS NOT NULL OR external_reference IS NOT NULL)))
);
-- No second attempt while one is live: the duplicate-payout guard.
CREATE UNIQUE INDEX one_live_payout_per_payee ON payout (
  COALESCE(vendor_id,  '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(partner_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE state IN ('pending','processing');
CREATE UNIQUE INDEX one_provider_payout_id ON payout (provider_payout_id)
  WHERE provider_payout_id IS NOT NULL;
CREATE INDEX ON payout (batch_id);
CREATE INDEX ON payout (vendor_id, created_at DESC);
CREATE INDEX ON payout (partner_id, created_at DESC);

ALTER TABLE ledger_entry
  ADD CONSTRAINT ledger_entry_payout_fk FOREIGN KEY (payout_id) REFERENCES payout(id);

-- --------------------------------------------------------------- refunds
-- How a refund was split back across the parties. One row per refund,
-- written in the same transaction as the refund's ledger posting.
CREATE TABLE refund_allocation (
  refund_id             uuid PRIMARY KEY REFERENCES refund(id) ON DELETE RESTRICT,
  order_id              uuid NOT NULL REFERENCES food_order(id),
  from_cafeteria_paise  int NOT NULL DEFAULT 0 CHECK (from_cafeteria_paise >= 0),
  from_platform_paise   int NOT NULL DEFAULT 0,
  from_delivery_paise   int NOT NULL DEFAULT 0 CHECK (from_delivery_paise >= 0),
  from_tax_paise        int NOT NULL DEFAULT 0 CHECK (from_tax_paise >= 0),
  total_paise           int NOT NULL CHECK (total_paise > 0),
  delivery_policy       text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allocation_sums CHECK (
    total_paise = from_cafeteria_paise + from_platform_paise
                + from_delivery_paise + from_tax_paise)
);
CREATE INDEX ON refund_allocation (order_id);

-- The old index allowed exactly one refund per payment ever, which made a
-- partial refund followed by a second partial refund impossible. It is
-- replaced with an in-flight guard: one refund may be open at a time, while
-- any number of completed refunds may exist, capped in total by the amount
-- captured (checked under a row lock in routes/support.js).
DROP INDEX IF EXISTS one_open_refund_per_payment;
CREATE UNIQUE INDEX one_inflight_refund_per_payment ON refund (payment_id)
  WHERE state IN ('requested','processing');
-- An idempotency key makes a retried refund request a no-op rather than a
-- second refund.
ALTER TABLE refund ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX one_refund_per_idempotency_key ON refund (payment_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- -------------------------------------------------------------- reporting
-- Natural-sign balances: a payable reads positive when money is owed.
CREATE VIEW v_account_balance AS
  SELECT a.id AS account_id, a.kind, a.vendor_id, a.partner_id, a.normal,
         COALESCE(sum(e.amount_paise), 0)::bigint AS debit_balance_paise,
         (CASE WHEN a.normal = 'credit' THEN -COALESCE(sum(e.amount_paise), 0)
               ELSE COALESCE(sum(e.amount_paise), 0) END)::bigint AS balance_paise
    FROM ledger_account a
    LEFT JOIN ledger_entry e ON e.account_id = a.id
   GROUP BY a.id;

-- Per-cafeteria statement, entirely from the ledger and the snapshots.
-- outstanding is the live payable balance; settled is what has actually been
-- paid out; net payable is the two together, i.e. everything ever earned.
CREATE VIEW v_cafeteria_statement AS
  SELECT v.id AS vendor_id, v.name,
         COALESCE(s.gross_food_sales_paise, 0) AS gross_food_sales_paise,
         COALESCE(s.commission_paise, 0)       AS commission_paise,
         COALESCE(r.refunds_paise, 0)          AS refunds_paise,
         COALESCE(adj.adjustments_paise, 0)    AS adjustments_paise,
         (COALESCE(b.balance_paise, 0) + COALESCE(p.paid_paise, 0))::bigint AS net_payable_paise,
         COALESCE(p.paid_paise, 0)             AS settled_paise,
         COALESCE(b.balance_paise, 0)          AS outstanding_paise
    FROM vendor v
    LEFT JOIN (
      SELECT o.vendor_id,
             sum(f.food_subtotal_paise)::bigint AS gross_food_sales_paise,
             sum(f.commission_paise)::bigint    AS commission_paise
        FROM order_financials f
        JOIN food_order o ON o.id = f.order_id
        JOIN ledger_txn t ON t.order_id = o.id AND t.kind = 'order_capture'
       GROUP BY o.vendor_id) s ON s.vendor_id = v.id
    LEFT JOIN (
      SELECT o.vendor_id, sum(ra.from_cafeteria_paise)::bigint AS refunds_paise
        FROM refund_allocation ra JOIN food_order o ON o.id = ra.order_id
       GROUP BY o.vendor_id) r ON r.vendor_id = v.id
    LEFT JOIN (
      SELECT a.vendor_id, (-sum(e.amount_paise))::bigint AS adjustments_paise
        FROM ledger_entry e
        JOIN ledger_account a ON a.id = e.account_id
        JOIN ledger_txn t ON t.id = e.txn_id
       WHERE a.kind = 'cafeteria_payable' AND t.kind = 'adjustment'
       GROUP BY a.vendor_id) adj ON adj.vendor_id = v.id
    LEFT JOIN (
      SELECT vendor_id, balance_paise FROM v_account_balance
       WHERE kind = 'cafeteria_payable') b ON b.vendor_id = v.id
    LEFT JOIN (
      SELECT vendor_id, sum(amount_paise)::bigint AS paid_paise FROM payout
       WHERE state = 'paid' AND vendor_id IS NOT NULL GROUP BY vendor_id) p ON p.vendor_id = v.id;

-- Per-partner statement.
CREATE VIEW v_partner_statement AS
  SELECT pp.user_id AS partner_id, u.name,
         COALESCE(d.deliveries, 0)              AS completed_deliveries,
         COALESCE(d.earned_paise, 0)            AS total_earned_paise,
         COALESCE(p.paid_paise, 0)              AS paid_out_paise,
         COALESCE(b.balance_paise, 0)           AS pending_payout_paise
    FROM partner_profile pp
    JOIN app_user u ON u.id = pp.user_id
    LEFT JOIN (
      SELECT o.partner_id, count(*)::int AS deliveries,
             sum(f.delivery_earning_paise)::bigint AS earned_paise
        FROM food_order o
        JOIN order_financials f ON f.order_id = o.id
        JOIN ledger_txn t ON t.order_id = o.id AND t.kind = 'delivery_earned'
       GROUP BY o.partner_id) d ON d.partner_id = pp.user_id
    LEFT JOIN (
      SELECT partner_id, balance_paise FROM v_account_balance
       WHERE kind = 'delivery_payable') b ON b.partner_id = pp.user_id
    LEFT JOIN (
      SELECT partner_id, sum(amount_paise)::bigint AS paid_paise FROM payout
       WHERE state = 'paid' AND partner_id IS NOT NULL GROUP BY partner_id) p
      ON p.partner_id = pp.user_id;

-- --------------------------------------------------- the platform default
-- Zero-rated except for what the platform had already configured. A
-- platform with no configured terms takes nothing rather than guessing a
-- commission, and Campus Control shows the terms as unconfigured.
--
-- The two settings that existed before this migration are carried across so
-- the change is not a silent repricing:
--   delivery_fee_paise  — what the customer was already charged for delivery
--   partner_payout_pct  — the share of that fee a partner was told they earn
INSERT INTO pricing_policy (vendor_id, commission_bps, commission_mode,
                            platform_fee_flat_paise, platform_fee_bps,
                            delivery_fee_paise, delivery_earning_paise, tax_bps, note)
SELECT NULL, 0, 'deduct_from_cafeteria', 0, 0,
       fee,
       CASE WHEN pct IS NULL THEN fee ELSE round(fee * pct / 100.0)::int END,
       0,
       'Carried over from platform_config at migration 004. '
       || 'Commission and platform fee are zero until set in Campus Control, Finance.'
  FROM (SELECT
          COALESCE((SELECT (value #>> '{}')::int FROM platform_config
                     WHERE key = 'delivery_fee_paise'), 0) AS fee,
          (SELECT (value #>> '{}')::numeric FROM platform_config
            WHERE key = 'partner_payout_pct') AS pct) AS prior;

-- The platform-wide accounts. Per-party accounts are created on demand.
INSERT INTO ledger_account (kind, normal) VALUES
  ('gateway_clearing','debit'), ('gateway_fee','debit'),
  ('platform_revenue','credit'), ('delivery_clearing','credit'),
  ('tax_payable','credit');

-- How a completed delivery's earning is treated when the order is later
-- refunded. Configurable, because it is a commercial decision:
--   platform_absorbs  — the partner keeps what they earned, Quad absorbs it
--   clawback_partner  — the earning is reversed off the partner's balance
INSERT INTO platform_config (key, value)
VALUES ('refund_delivery_policy', '"platform_absorbs"')
ON CONFLICT (key) DO NOTHING;
