-- ==========================================================================
-- QUAD -- SETTLEMENT RECONCILIATION  (migration 009)
--
-- Closes the last financial gap: until now, Quad's gateway-charge figure was
-- whatever the payment webhook happened to mention. Razorpay mentions it;
-- Cashfree does not. So under Cashfree, `gateway_fee_paise` stayed 0 and net
-- revenue was really gross revenue wearing a different label.
--
-- The fix is not to estimate the fee. It is to import the provider's own
-- settlement reconciliation -- the authoritative record of what was actually
-- deducted -- and to treat everything else, including the payment webhook, as
-- non-authoritative for money the gateway kept.
--
-- -- Four tables, and why each exists --------------------------------------
--
-- provider_settlement_import   one row per run of the importer. Records what
--                              was asked for and what came back, so "did we
--                              reconcile Tuesday?" is a query rather than an
--                              archaeology exercise.
--
-- provider_settlement_entry    one row per line in the provider's report.
--                              This is the RAW provider fact, stored before
--                              it is interpreted and kept forever. Its unique
--                              index is what makes re-running the importer a
--                              no-op instead of a double-count.
--
-- reconciliation_exception     every difference the importer found. An
--                              importer that silently skips what it cannot
--                              explain is worse than no importer, because it
--                              produces a number that looks reconciled.
--
-- payment.reconciled_at        the marker that a payment HAS been reconciled,
-- payment.settlement_id        as distinct from having a zero fee.
--
-- -- The zero-fee trap ----------------------------------------------------
--
-- It would be tempting to infer "reconciled" from `gateway_fee_paise > 0`.
-- That is wrong here in the most expensive possible way: Cashfree's launch
-- offer is 0% platform fee, so for the entire pilot the CORRECT reconciled
-- fee is genuinely zero. Inferring from the amount would mark every properly
-- reconciled order as still outstanding, and the missing-transaction sweep
-- would raise an exception for every order Quad ever took.
--
-- So reconciliation state is recorded explicitly, on its own column, and the
-- fee is just a number.
--
-- -- What this migration does NOT do ---------------------------------------
--
-- It does not relax `order_financials_immutable`. The allocation values --
-- what the cafeteria is owed, what the partner earned, what Quad's gross take
-- was -- remain untouchable, and reconciliation never writes them. The single
-- write-once-from-zero exemption for `gateway_fee_paise` already existed and
-- is exactly what the importer uses; a fee that disagrees with one already
-- recorded raises an exception rather than overwriting it.
-- ==========================================================================

-- ------------------------------------------------------------- import runs
CREATE TABLE provider_settlement_import (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  -- What was requested. A window, a settlement id, or a UTR.
  filter_kind   text NOT NULL CHECK (filter_kind IN ('date_range','settlement_id','utr')),
  window_start  timestamptz,
  window_end    timestamptz,
  settlement_ref text,

  -- 'running' is a real state, not a formality: an importer that dies
  -- halfway must not leave behind something that reads as a finished run.
  state         text NOT NULL DEFAULT 'running'
                  CHECK (state IN ('running','completed','completed_with_exceptions','failed')),
  entries_seen      int NOT NULL DEFAULT 0,
  entries_new       int NOT NULL DEFAULT 0,
  entries_duplicate int NOT NULL DEFAULT 0,
  entries_matched   int NOT NULL DEFAULT 0,
  exceptions_raised int NOT NULL DEFAULT 0,
  fees_recorded_paise bigint NOT NULL DEFAULT 0,

  started_by    uuid REFERENCES app_user(id),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  error         text,

  -- A finished run must say when it finished. A run that claims a terminal
  -- state with no finish time is the shape of a crash being reported as a
  -- success.
  CONSTRAINT finished_states_have_a_time CHECK (
    (state = 'running') = (finished_at IS NULL))
);
CREATE INDEX ON provider_settlement_import (provider, started_at DESC);

-- --------------------------------------------------------- provider lines
-- The provider's own words, stored verbatim alongside the parsed figures.
-- Amounts are integer paise here even though the provider sends rupee
-- decimals: the conversion is exact (see services/payment-providers.js) and
-- refuses anything it cannot represent, so a value in this table has already
-- survived that gate.
CREATE TABLE provider_settlement_entry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id     uuid NOT NULL REFERENCES provider_settlement_import(id),
  provider      text NOT NULL,

  -- The immutable provider identifiers. These, and ONLY these, are what a
  -- Quad payment is matched on. Matching on amount and time would find a
  -- plausible row rather than the right one, and two orders for the same
  -- coffee at the same minute are not a hypothetical on a campus.
  provider_payment_id text NOT NULL,
  provider_order_id   text,
  settlement_id       text,
  settlement_utr      text,

  -- PAYMENT settles money in; REFUND and ADJUSTMENT take money back out.
  -- They are kept in one table because the provider reports them in one
  -- report, and separating them here would mean reconciling two things that
  -- must add up against each other.
  event_type    text NOT NULL,

  payment_amount_paise    bigint,
  service_charge_paise    bigint,
  service_tax_paise       bigint,
  settlement_amount_paise bigint,

  -- Resolved by the importer, NULL when nothing matched.
  payment_id    uuid REFERENCES payment(id),
  order_id      uuid REFERENCES food_order(id),
  match_state   text NOT NULL DEFAULT 'unmatched'
                  CHECK (match_state IN ('matched','unmatched','conflicted')),
  -- Whether this line's fee was actually applied to the order's financials.
  applied       boolean NOT NULL DEFAULT false,

  raw           jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- An unmatched line must not claim a payment, and an applied line must
  -- have one. Without this, a partially-written import could produce a fee
  -- applied to nothing.
  CONSTRAINT applied_lines_are_matched CHECK (
    NOT applied OR (payment_id IS NOT NULL AND match_state = 'matched'))
);

-- THE idempotency guarantee. One line per (provider, event, payment,
-- settlement). Re-running the importer over the same window re-reads the
-- same lines, inserts none of them, and does no work -- which is what makes
-- the job safe to run on a cron, safe to retry after a timeout, and safe to
-- run twice by hand during an incident.
--
-- Note `settlement_id` is in the key rather than excluded from it. That is
-- deliberate and is the duplicate-settlement detector: the same payment
-- appearing under a SECOND settlement id is a genuinely different line, so
-- it inserts, and the importer then sees two settled lines for one payment
-- and raises `duplicate_provider_txn` instead of silently double-counting.
CREATE UNIQUE INDEX provider_settlement_entry_uniq ON provider_settlement_entry (
  provider, event_type, provider_payment_id,
  COALESCE(settlement_id, ''));

CREATE INDEX ON provider_settlement_entry (payment_id);
CREATE INDEX ON provider_settlement_entry (import_id);
CREATE INDEX ON provider_settlement_entry (provider_payment_id);

-- ------------------------------------------------------------- exceptions
-- Every difference, as a durable row somebody can work through. The set is
-- closed so a typo cannot invent a category nobody triages.
CREATE TABLE reconciliation_exception (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id   uuid REFERENCES provider_settlement_import(id),
  entry_id    uuid REFERENCES provider_settlement_entry(id),
  payment_id  uuid REFERENCES payment(id),
  order_id    uuid REFERENCES food_order(id),

  kind        text NOT NULL CHECK (kind IN (
    'missing_payment',        -- the provider settled something Quad has no payment for
    'unsettled_payment',      -- Quad holds a paid payment the provider never settled
    'order_mismatch',         -- provider ids point at two different Quad records
    'amount_mismatch',        -- the settled payment amount is not the amount charged
    'fee_mismatch',           -- a fee was already recorded, and this one differs
    'unexpected_deduction',   -- settlement != amount - charge - tax
    'duplicate_provider_txn', -- one payment settled under two settlement ids
    'partial_settlement',     -- the provider settled less than the full payment
    'refund_unmatched',       -- a refund line with no Quad refund behind it
    'payout_already_executed' -- reconciled after the money was already paid out
  )),
  -- Whether this needs a human before the money can be trusted, or is a
  -- note. Nothing is auto-resolved either way.
  severity    text NOT NULL DEFAULT 'blocking'
                CHECK (severity IN ('blocking','informational')),
  detail      jsonb NOT NULL,

  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
  resolved_by uuid REFERENCES app_user(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- Resolving is a human act with a name on it. A resolved exception with no
  -- actor and no note is an exception that was hidden, not handled.
  CONSTRAINT resolution_is_attributed CHECK (
    state = 'open' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL
                       AND resolution_note IS NOT NULL))
);
CREATE INDEX ON reconciliation_exception (state, created_at DESC);
CREATE INDEX ON reconciliation_exception (kind);
CREATE INDEX ON reconciliation_exception (payment_id);

-- Raising the SAME exception for the same fact on every re-run would turn a
-- daily cron into a queue nobody can clear. One open exception per
-- (kind, payment) is enough to tell somebody there is a problem.
CREATE UNIQUE INDEX one_open_exception_per_fact ON reconciliation_exception (
  kind, COALESCE(payment_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(entry_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE state = 'open';

-- ------------------------------------------------- reconciliation markers
-- See the header: "the fee is zero" and "we have not checked" must never be
-- the same state, because under a 0% offer the correct answer IS zero.
ALTER TABLE payment ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS settlement_id text;

COMMENT ON COLUMN payment.reconciled_at IS
  'When the provider''s settlement report was successfully applied to this payment. '
  'Explicit because a reconciled fee of zero is a real and expected outcome under a '
  '0%-fee offer, and must not read as unreconciled.';
COMMENT ON COLUMN payment.settlement_id IS
  'The provider settlement this payment was paid out to Quad in. Evidence, not a status.';

CREATE INDEX IF NOT EXISTS payment_unreconciled_idx ON payment (settled_at)
  WHERE status = 'paid' AND reconciled_at IS NULL;
