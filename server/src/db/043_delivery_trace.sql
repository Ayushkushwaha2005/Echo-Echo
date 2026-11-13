-- ===========================================================================
-- ECHO ECHO - migration 043: what a finished delivery leaves behind. Additive.
--
-- partner_location (019) is the LIVE position: one row, deleted the moment a
-- delivery ends. That stays exactly as it is. This table is the separate,
-- time-limited RECORD of a delivery, for Campus Control to look back at:
-- where it was picked up, where it went, the partner's last recorded position
-- and a thinned trail of the walk.
--
--   * Points are added only while the order is being carried, only after the
--     partner chose to share for that delivery, and only under the notice
--     version that says a record is kept (services/delivery-trace.js).
--   * The trail is thinned (a point per 25 m or 2 minutes) and capped.
--   * Each row is deleted DELIVERY_TRACE_RETENTION_DAYS after the delivery
--     ends (sweeper). Nothing is recorded after the end.
--   * No Google route geometry is stored: Google's terms allow only
--     temporary caching. The trail is ECHO ECHO's own data.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS delivery_trace (
  order_id         uuid PRIMARY KEY REFERENCES food_order(id) ON DELETE CASCADE,
  partner_id       uuid REFERENCES app_user(id) ON DELETE SET NULL,
  pickup_name      text,
  pickup_lat       double precision,
  pickup_lng       double precision,
  dest_name        text,
  dest_lat         double precision,
  dest_lng         double precision,
  -- [[lat, lng, unix seconds, accuracy m], ...], oldest first
  points           jsonb NOT NULL DEFAULT '[]'::jsonb,
  final_lat        double precision,
  final_lng        double precision,
  final_accuracy_m double precision,
  final_at         timestamptz,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  purge_after      timestamptz,
  CHECK (jsonb_typeof(points) = 'array')
);
CREATE INDEX IF NOT EXISTS delivery_trace_purge_idx ON delivery_trace (purge_after);
CREATE INDEX IF NOT EXISTS delivery_trace_partner_idx ON delivery_trace (partner_id);
