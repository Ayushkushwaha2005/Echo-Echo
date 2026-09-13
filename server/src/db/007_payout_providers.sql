-- ==========================================================================
-- QUAD — PROVIDER-AGNOSTIC PAYOUTS  (migration 007)
--
-- payout.method was CHECK-constrained to ('razorpayx','manual_bank_transfer'),
-- which quietly made the schema itself Razorpay-specific: adding a provider
-- meant a migration, and the "adapter" above it could only ever have one
-- real implementation.
--
-- The constraint is widened rather than dropped. A free-text method would
-- let a typo become a settled payout nobody can reconcile, so the set is
-- still closed — it just now names every provider Quad has an adapter for.
--
-- What is NOT relaxed: `paid_has_evidence`. Whatever the method, a payout
-- cannot be `paid` without a paid_at, a method, and either a provider payout
-- id or a bank reference. That is the constraint that stops a settlement
-- state which never corresponded to money leaving a bank, and it applies to
-- every provider added here and every provider added later.
-- ==========================================================================

ALTER TABLE payout DROP CONSTRAINT IF EXISTS payout_method_check;
ALTER TABLE payout ADD CONSTRAINT payout_method_check CHECK (
  method IN (
    'razorpayx',              -- RazorpayX Payouts
    'cashfree_payouts',       -- Cashfree Payouts
    'manual_bank_transfer'    -- an administrator's own transfer, recorded with its UTR
  ));

-- payout_destination.provider is deliberately left free-text: it records
-- which provider an opaque payee id belongs to, and a destination may
-- legitimately exist for a provider this deployment is not currently using
-- (during a migration between providers, both sets are held at once). The
-- index below keeps at most one ACTIVE destination per payee per provider,
-- which is the property that actually matters.
COMMENT ON COLUMN payout_destination.provider IS
  'Which payout provider the opaque payee ids belong to (razorpayx, cashfree, ...). '
  'A payee may hold destinations for several providers; only one per provider may be active.';

COMMENT ON COLUMN payout.method IS
  'How this payout actually moved. Set when it is sent or recorded, never in advance.';
