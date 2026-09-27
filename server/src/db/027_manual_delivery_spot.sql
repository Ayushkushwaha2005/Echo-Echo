-- ============================================================================
-- ECHO ECHO - migration 027: an exact delivery spot inside the campus boundary
--
-- Platform owner direction, 27 Sep 2026: a student may deliver to an exact
-- spot they choose on the campus map (or their accepted live location)
-- anywhere INSIDE the active campus boundary. The spot itself is the
-- destination; it does not have to be near a named delivery point.
--
-- The server validates every spot (active boundary, point-in-polygon; for a
-- live reading also accuracy <= 100 m and not closer to the edge than its own
-- uncertainty) before an order can carry it. No campus_node is created for a
-- spot: the named points stay exactly as they are.
--
-- Columns, smallest change that keeps the rule in the database:
--   destination_kind  'campus_node' | 'manual_map_spot' | 'live_gps_spot'
--   spot_lat/spot_lng the exact spot (6 dp, ~0.1 m), only for the spot kinds
-- A delivery order still needs a destination: a node OR a spot, never both.
-- ============================================================================

ALTER TABLE food_order
  ADD COLUMN destination_kind text CHECK (destination_kind IN ('campus_node', 'manual_map_spot', 'live_gps_spot')),
  ADD COLUMN spot_lat numeric(9,6) CHECK (spot_lat BETWEEN -90 AND 90),
  ADD COLUMN spot_lng numeric(9,6) CHECK (spot_lng BETWEEN -180 AND 180);

UPDATE food_order SET destination_kind = 'campus_node' WHERE destination_id IS NOT NULL;

ALTER TABLE food_order DROP CONSTRAINT delivery_needs_destination;
ALTER TABLE food_order ADD CONSTRAINT delivery_needs_destination CHECK (
  CASE
    WHEN fulfilment = 'pickup' THEN destination_id IS NULL AND spot_lat IS NULL AND spot_lng IS NULL
                                    AND destination_kind IS NULL
    -- a named point (older writers leave the kind unset; it can only mean this)
    WHEN fulfilment = 'delivery' AND destination_id IS NOT NULL THEN coalesce(destination_kind, 'campus_node') = 'campus_node'
                                         AND spot_lat IS NULL AND spot_lng IS NULL
    -- an exact spot
    WHEN fulfilment = 'delivery' THEN destination_kind IN ('manual_map_spot', 'live_gps_spot')
                                      AND spot_lat IS NOT NULL AND spot_lng IS NOT NULL
    ELSE false
  END);

-- Once an order leaves draft, where it goes is history: the destination, the
-- spot and the snapshot the partner reads can no longer change. A deliberate,
-- owner-directed data correction (like migration 024's rename) sets
-- `SET LOCAL echo.destination_correction = 'on'` in its transaction.
CREATE FUNCTION food_order_destination_frozen() RETURNS trigger AS $fn$
BEGIN
  IF OLD.state <> 'draft'
     AND coalesce(current_setting('echo.destination_correction', true), '') <> 'on'
     AND (NEW.destination_kind, NEW.destination_id, NEW.spot_lat, NEW.spot_lng, NEW.destination_snapshot)
       IS DISTINCT FROM (OLD.destination_kind, OLD.destination_id, OLD.spot_lat, OLD.spot_lng, OLD.destination_snapshot) THEN
    RAISE EXCEPTION 'the destination of order % is frozen once it leaves draft', OLD.id;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER food_order_destination_frozen BEFORE UPDATE ON food_order
  FOR EACH ROW EXECUTE FUNCTION food_order_destination_frozen();
