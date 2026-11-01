-- ===========================================================================
-- ECHO ECHO - migration 037: consent to share a position, per delivery
--
-- A partner taps Start sharing once per delivery. This row is the record of
-- that choice: who, which order, when, under which notice. It holds no
-- coordinates, so it cannot become a location trail.
-- ===========================================================================
CREATE TABLE location_share_consent (
  id             bigserial PRIMARY KEY,
  order_id       uuid NOT NULL REFERENCES food_order(id),
  partner_id     uuid NOT NULL REFERENCES app_user(id),
  notice_version text NOT NULL,
  consented_at   timestamptz NOT NULL DEFAULT now(),
  stopped_at     timestamptz,
  stop_reason    text CHECK (stop_reason IN ('partner','delivery_ended','sign_out','permission_revoked')),
  UNIQUE (order_id, partner_id)
);
CREATE INDEX location_share_consent_partner ON location_share_consent (partner_id) WHERE stopped_at IS NULL;

-- Viewing an exact position is its own permission. Nobody is migrated into it:
-- orders.view stops carrying coordinates, and the owner grants delivery.track
-- to the people who need the map.
