-- ============================================================================
-- ECHO ECHO - migration 047: owner-attested offline historical records
--
-- Business that happened before (or outside) the system, recorded on paper,
-- is entered by the platform owner as AGGREGATE figures: "126 orders up to
-- 15 Nov 2026, from the order book". Each row is the owner's attestation,
-- with its source and the person and time that recorded it.
--
-- These rows are deliberately NOT part of the books:
--   * they post nothing to the ledger, create no order, payment, payout or
--     settlement, and no finance figure computed from transactions reads them;
--   * a payable recorded here is a claim from the paper books, shown so it can
--     be reconciled; it is not a balance the settlement process can pay out.
--
-- Append-only. A figure cannot be edited or deleted: a mistake is corrected by
-- withdrawing the row (who, when, why) and recording a corrected one. Every
-- record and withdrawal is also written to audit_log by the API.
--
-- Additive: one new table and its trigger. Nothing existing changes.
-- ============================================================================

CREATE TABLE offline_record (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric           text NOT NULL CHECK (metric IN
                     ('orders', 'gmv', 'platform_fees', 'net_revenue', 'cafe_payable', 'partner_payable')),
  -- 'orders' is a count; every other metric is an amount in paise.
  value            bigint NOT NULL CHECK (value >= 0),
  period_start     date,
  period_end       date NOT NULL,
  -- The café or delivery partner a payable is owed to, as written in the books.
  counterparty     text CHECK (counterparty IS NULL OR length(counterparty) BETWEEN 1 AND 120),
  source           text NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  source_reference text CHECK (source_reference IS NULL OR length(source_reference) <= 200),
  note             text CHECK (note IS NULL OR length(note) <= 500),
  attested_by      uuid NOT NULL REFERENCES app_user(id),
  attested_at      timestamptz NOT NULL DEFAULT now(),
  withdrawn_by     uuid REFERENCES app_user(id),
  withdrawn_at     timestamptz,
  withdraw_reason  text CHECK (withdraw_reason IS NULL OR length(withdraw_reason) BETWEEN 1 AND 500),
  CHECK (period_start IS NULL OR period_start <= period_end),
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL)
     AND (withdrawn_at IS NULL) = (withdraw_reason IS NULL))
);
CREATE INDEX offline_record_current ON offline_record (metric, period_end) WHERE withdrawn_at IS NULL;

CREATE FUNCTION offline_record_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'offline_record is append-only: withdraw a record instead of deleting it';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'a withdrawn offline record cannot change';
  END IF;
  IF (NEW.metric, NEW.value, NEW.period_start, NEW.period_end, NEW.counterparty, NEW.source,
      NEW.source_reference, NEW.note, NEW.attested_by, NEW.attested_at)
     IS DISTINCT FROM
     (OLD.metric, OLD.value, OLD.period_start, OLD.period_end, OLD.counterparty, OLD.source,
      OLD.source_reference, OLD.note, OLD.attested_by, OLD.attested_at) THEN
    RAISE EXCEPTION 'an offline record''s figures cannot be edited: withdraw it and record a corrected one';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER offline_record_append_only
  BEFORE UPDATE OR DELETE ON offline_record
  FOR EACH ROW EXECUTE FUNCTION offline_record_append_only();
