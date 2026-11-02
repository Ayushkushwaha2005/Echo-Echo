-- ===========================================================================
-- ECHO ECHO - migration 040: approvals for high-risk, non-payment actions
--
-- Payment and finance actions are deliberately absent. Adding them needs its
-- own change, once payment work is unfrozen.
--
-- Only actions with a fixed server-side handler can exist (services/approvals.js).
-- The frozen payload cannot change, the decider can never be the requester, and
-- a request executes at most once. The database enforces all three, so a bug
-- in a route cannot.
-- ===========================================================================
CREATE TABLE approval_policy (
  action_type   text PRIMARY KEY,
  enabled       boolean NOT NULL DEFAULT false,
  expiry_hours  integer NOT NULL DEFAULT 24 CHECK (expiry_hours BETWEEN 1 AND 168),
  updated_by    uuid REFERENCES app_user(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_request (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type     text NOT NULL REFERENCES approval_policy(action_type),
  payload         jsonb NOT NULL,
  payload_hash    text NOT NULL,
  summary         text NOT NULL,
  reason          text NOT NULL CHECK (length(reason) >= 5),
  idempotency_key text NOT NULL UNIQUE,
  requested_by    uuid NOT NULL REFERENCES app_user(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','rejected','expired','executed','failed')),
  decided_by      uuid REFERENCES app_user(id),
  decided_at      timestamptz,
  decision_note   text,
  executed_at     timestamptz,
  result          jsonb,
  CONSTRAINT approval_no_self_decision CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CONSTRAINT approval_decision_recorded CHECK ((status = 'pending') = (decided_at IS NULL) OR status = 'expired')
);
CREATE INDEX approval_request_status ON approval_request (status, requested_at DESC);

CREATE FUNCTION approval_request_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'approval_request rows are kept'; END IF;
  IF NEW.action_type <> OLD.action_type OR NEW.payload::text <> OLD.payload::text OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.requested_by <> OLD.requested_by OR NEW.reason <> OLD.reason OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'an approval request cannot be changed after it is made';
  END IF;
  IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'this approval request is already closed'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER approval_request_guard BEFORE UPDATE OR DELETE ON approval_request
  FOR EACH ROW EXECUTE FUNCTION approval_request_guard();

-- Off by default: nothing queues until the owner turns it on.
INSERT INTO approval_policy (action_type, enabled) VALUES ('vendor.archive', false);
