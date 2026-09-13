-- ==========================================================================
-- QUAD — PROVIDER-AGNOSTIC COLLECTION  (migration 008)
--
-- The mirror of 007, for money coming in. Three changes, each closing a
-- gap that only becomes visible once a second gateway exists.
--
-- 1. A payment attempt needs somewhere to keep the provider's checkout
--    handle. Razorpay's browser SDK is opened with the gateway ORDER id, so
--    provider_order_id was enough; Cashfree's is opened with a
--    payment_session_id, which is a different value with a different
--    lifetime. Storing it means a customer who reloads the checkout page
--    resumes the SAME attempt instead of creating a second one.
--
-- 2. An amount mismatch must be RECORDED, not merely refused. Before this,
--    a webhook reporting an amount that disagreed with the order's frozen
--    snapshot marked the payment failed and returned — correct, but it left
--    no durable trace of the most financially interesting event the system
--    can witness. `flagged_reason` and `flagged_at` make it a fact somebody
--    can query, and the finance surfaces list them for investigation.
--
-- 3. Webhook deliveries are timestamped by the provider that signed them.
--    Keeping that timestamp alongside our own received_at is what turns
--    "this looks like a replay" into something provable after the fact.
--
-- What is deliberately NOT changed: payment.status stays a closed set, and
-- there is still no status meaning "the browser said it worked". The only
-- writer of 'paid' is the webhook/reconcile path in routes/payments.js.
-- ==========================================================================

ALTER TABLE payment ADD COLUMN IF NOT EXISTS provider_session_id text;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS flagged_reason text;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS flagged_at timestamptz;

COMMENT ON COLUMN payment.provider_session_id IS
  'The provider''s checkout handle for THIS attempt (Cashfree payment_session_id). '
  'Not a secret and not proof of anything: it opens a checkout, it does not settle one.';
COMMENT ON COLUMN payment.flagged_reason IS
  'Set when the provider reported something that must never be auto-confirmed — an '
  'amount or currency disagreeing with the order''s frozen snapshot, or a payment '
  'belonging to another order. A flagged payment is never settlement eligible.';

-- A flag must carry its reason and its time together; half a flag is worse
-- than none, because it is a warning nobody can date.
ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_flag_complete;
ALTER TABLE payment ADD CONSTRAINT payment_flag_complete CHECK (
  (flagged_reason IS NULL) = (flagged_at IS NULL));

-- A flagged payment must never sit in the one status that makes an order
-- real. This is the database refusing what the application already refuses:
-- belt and braces, on the single constraint where being wrong costs money.
ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_flagged_not_paid;
ALTER TABLE payment ADD CONSTRAINT payment_flagged_not_paid CHECK (
  flagged_reason IS NULL OR status <> 'paid');

CREATE INDEX IF NOT EXISTS payment_flagged_idx ON payment (flagged_at)
  WHERE flagged_reason IS NOT NULL;

-- One provider order id maps to exactly one payment attempt. The webhook
-- handler looks a payment up by this value, so a duplicate would make that
-- lookup ambiguous at the worst possible moment.
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_order_uniq
  ON payment (provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

-- ---------------------------------------------------------------- webhooks
ALTER TABLE payment_webhook ADD COLUMN IF NOT EXISTS provider_ts timestamptz;
ALTER TABLE payment_webhook ADD COLUMN IF NOT EXISTS event_type text;

COMMENT ON COLUMN payment_webhook.provider_ts IS
  'The timestamp the PROVIDER signed into the delivery, as distinct from received_at, '
  'which is when we saw it. A wide gap between the two is the signature of a replay.';

-- The idempotency key was already the primary key (provider, event_id).
-- Recording the type as well makes the table readable during an incident
-- without parsing every payload.
