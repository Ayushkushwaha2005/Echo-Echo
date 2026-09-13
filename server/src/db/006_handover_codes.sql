-- ==========================================================================
-- QUAD — HANDOVER VERIFICATION CODES  (migration 006)
--
-- Two different codes protect two different physical handovers, and they are
-- deliberately separate secrets held by different people:
--
--   pickup    issued to the CAFETERIA. The counter reads it to the delivery
--             partner, who types it in. Proves the partner who collected the
--             food is the partner this order was assigned to.
--   delivery  issued to the CUSTOMER. The customer reads it to the partner,
--             who types it in. Proves the food reached the person who
--             ordered it.
--
-- Neither is an SMS. Both are shown in-app to a party who is already
-- authenticated and already authorised to see that order, so an SMS would
-- add cost and a delivery-failure mode without adding proof.
--
-- The security properties are the same ones otp_challenge has, for the same
-- reasons, and they are enforced here rather than trusted to a route:
--
--   * the code is generated server-side with crypto.randomInt and is never
--     stored in the clear — only a per-row-salted SHA-256
--   * it expires
--   * it carries an attempt ceiling, so a 6-digit code cannot be walked
--   * it is consumed on first success and can never be replayed
--   * exactly one live code exists per (order, kind)
--   * the delivery partner cannot issue, read or change either code: the
--     issuing routes authorise the cafeteria and the customer respectively
--
-- Attempts are recorded as audit rows by the service, so a partner probing
-- codes is visible rather than merely rate-limited.
-- ==========================================================================

CREATE TABLE order_handover_code (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES food_order(id) ON DELETE CASCADE,
  -- Which handover this code authorises.
  kind         text NOT NULL CHECK (kind IN ('pickup','delivery')),

  -- Salted SHA-256 of the code. The code itself is returned exactly once,
  -- to the issuing party, and exists nowhere else.
  code_hash    text NOT NULL,
  salt         text NOT NULL,

  attempts     int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int  NOT NULL CHECK (max_attempts > 0),

  -- Who the code was shown to, for the audit trail. NOT who may verify it.
  issued_to    uuid REFERENCES app_user(id),
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  -- Set the moment a correct code is accepted. A consumed row is dead: it
  -- cannot be verified again, and it cannot be reissued.
  consumed_at  timestamptz,
  consumed_by  uuid REFERENCES app_user(id),

  CONSTRAINT expiry_after_issue CHECK (expires_at > issued_at)
);

-- One live code per handover. A reissue must first expire or consume the
-- previous one, so two valid pickup codes for the same order cannot exist.
CREATE UNIQUE INDEX one_live_handover_code
  ON order_handover_code (order_id, kind)
  WHERE consumed_at IS NULL;

CREATE INDEX ON order_handover_code (order_id, kind, issued_at DESC);

-- A handover code is evidence. It is never edited after it is consumed, and
-- it is never deleted while the order exists: `attempts` and `consumed_at`
-- are the only fields that may move, and only forwards.
CREATE FUNCTION handover_code_append_only() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'handover codes are not deleted (order %, %)', OLD.order_id, OLD.kind;
  END IF;
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'handover code for order % (%) is already used', OLD.order_id, OLD.kind;
  END IF;
  IF (NEW.order_id, NEW.kind, NEW.code_hash, NEW.salt, NEW.max_attempts,
      NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.order_id, OLD.kind, OLD.code_hash, OLD.salt, OLD.max_attempts,
      OLD.issued_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'a handover code cannot be rewritten; issue a new one';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'the attempt counter cannot be wound back';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER handover_code_append_only
  BEFORE UPDATE OR DELETE ON order_handover_code
  FOR EACH ROW EXECUTE FUNCTION handover_code_append_only();

-- ---------------------------------------------------------------- config
-- Lifetimes are configurable because they are an operational trade-off, not
-- a security constant: a code that expires while a partner is climbing four
-- flights of stairs is a support ticket, and one that lives all day is not
-- proof of anything. The defaults suit a campus where every handover is
-- minutes, not hours, from the one before it.
INSERT INTO platform_config (key, value) VALUES
  ('handover_pickup_ttl_seconds',   '1800'),   -- 30 min: ready to collected
  ('handover_delivery_ttl_seconds', '5400'),   -- 90 min: collected to delivered
  ('handover_max_attempts',         '5')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------- retiring the old
-- food_order.handoff_code_hash was the previous delivery code: unsalted, with
-- no expiry and no attempt ceiling, issued once on first read. Any order
-- still carrying one is mid-flight right now, so the column is left in place
-- and simply stops being read — routes/partner.js now goes through
-- order_handover_code. Dropping it is a later migration, once no in-flight
-- order predates this one.
COMMENT ON COLUMN food_order.handoff_code_hash IS
  'Superseded by order_handover_code (migration 006). No longer read or written.';
