-- ===========================================================================
-- ECHO ECHO - migration 019: live delivery tracking
--
-- Where the delivery partner is, while they are carrying one particular
-- order. Not a location history and not a movement log: ONE row per partner,
-- overwritten as they move, and deleted the moment the delivery ends.
--
-- The order id on the row is what makes this narrow. A position is only ever
-- recorded against an active delivery, and the read side (routes/partner.js)
-- only ever discloses it to the customer of THAT order, only while it is in
-- flight. A partner who is online but carrying nothing has no row at all.
-- ===========================================================================

CREATE TABLE partner_location (
  partner_id  uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  -- The delivery this position belongs to. When it ends, the row goes.
  order_id    uuid NOT NULL REFERENCES food_order(id) ON DELETE CASCADE,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  accuracy_m  double precision,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON partner_location (order_id);

-- A cafeteria's pickup point is campus_node_id, which has existed since
-- migration 001 but was never constrained. Making it a real reference means
-- an outlet cannot point at a location that has been deleted, and the map can
-- read a pickup coordinate without a second guess about what it is.
ALTER TABLE vendor
  ADD CONSTRAINT vendor_campus_node_fk
  FOREIGN KEY (campus_node_id) REFERENCES campus_node(id) NOT VALID;
