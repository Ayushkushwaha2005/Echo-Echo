-- ==========================================================================
-- QUAD — SCHEDULED SETTLEMENT  (migration 005)
--
-- Cafeterias settle daily, delivery partners weekly. The amounts are never
-- typed in by a human: a scheduled run reads each payee's ledger balance and
-- builds a batch of pending payouts. What the run does NOT do is move money.
-- A batch is built, then reviewed, then approved, then released, and only the
-- release actually transfers anything — and only through a configured
-- provider or an administrator's own recorded bank transfer.
--
-- Idempotency is the whole problem with a scheduled money job, so it is
-- solved structurally: every scheduled batch carries the period it settles
-- (`period_key`), and (kind, period_key) is UNIQUE. A server that restarts
-- five times between 20:00 and 20:05, or two instances running side by side,
-- produce exactly one batch for the evening of 2026-09-07.
-- ==========================================================================

ALTER TABLE payout_batch
  -- 'cafeteria:2026-09-07' or 'partner:2026-W36'. NULL for a batch an
  -- administrator built by hand, which is deliberately unconstrained.
  ADD COLUMN period_key  text,
  ADD COLUMN origin      text NOT NULL DEFAULT 'manual'
               CHECK (origin IN ('manual','scheduled')),
  ADD COLUMN approved_by uuid REFERENCES app_user(id),
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN released_at timestamptz;

-- The lock that makes a scheduled run safe to attempt as often as it likes.
CREATE UNIQUE INDEX one_batch_per_period ON payout_batch (kind, period_key)
  WHERE period_key IS NOT NULL;

-- The batch lifecycle is a review workflow, so name its states after it.
-- 'locked' was a placeholder and no row has ever held it.
ALTER TABLE payout_batch DROP CONSTRAINT payout_batch_state_check;
ALTER TABLE payout_batch ADD CONSTRAINT payout_batch_state_check
  CHECK (state IN ('open','approved','completed','cancelled'));

-- A batch cannot claim approval without saying who approved it and when.
ALTER TABLE payout_batch ADD CONSTRAINT approved_has_approver CHECK (
  state = 'open' OR state = 'cancelled'
  OR (approved_by IS NOT NULL AND approved_at IS NOT NULL));

-- --------------------------------------------------------------- schedule
-- Held in platform_config so an administrator can change the evening
-- settlement time without a deploy. Times are wall-clock in
-- `settlement_timezone`, because "8 PM" means 8 PM on campus, not 8 PM UTC.
INSERT INTO platform_config (key, value) VALUES
  ('settlement_timezone', '"Asia/Kolkata"'),
  -- Every evening at 20:00.
  ('settlement_cafeteria_schedule',
   '{"enabled": true, "hour": 20, "minute": 0, "min_paise": 100}'),
  -- Every Monday at 20:00, covering the week that just ended.
  ('settlement_partner_schedule',
   '{"enabled": true, "weekday": 1, "hour": 20, "minute": 0, "min_paise": 100}'),
  -- Releasing money is a separate decision from calculating it. This stays
  -- false until a payout provider is connected AND the business decides to
  -- let it run unattended; the release route refuses to honour it otherwise.
  ('settlement_auto_release', 'false')
ON CONFLICT (key) DO NOTHING;
