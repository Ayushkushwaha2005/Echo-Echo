-- ============================================================================
-- ECHO ECHO - migration 032: the café is called "Tulips"
--
-- Platform owner direction, 24 Oct 2026: the customer-facing name of the
-- Tulips outlet is exactly "Tulips". Migration 022 created it as
-- "Tulips Cafe" (after the "Tulips CAFE" signboard).
--
-- Renames the ONE existing record in place. Its id and slug ('tulips') are
-- unchanged, so its menu, orders, payments, payouts and ledger entries - all
-- of which refer to the id, never to the name - stay exactly as they are,
-- and every screen that shows the name (listings, menu, checkout, receipts,
-- order history, dashboards, reports, notifications) reads it from here.
-- The campus place the outlet is attached to is renamed with it, only while
-- it still carries the 022 name. Order destination snapshots and the field
-- survey evidence are history and are not touched. Chai Garam is not touched.
--
-- Runs once in effect: re-running it, or running it on a database without
-- Tulips, changes nothing.
-- ============================================================================

DO $$
DECLARE v record;
BEGIN
  SELECT id, name, campus_node_id INTO v FROM vendor WHERE slug = 'tulips';
  IF v.id IS NULL OR v.name = 'Tulips' THEN RETURN; END IF;

  UPDATE vendor SET name = 'Tulips' WHERE id = v.id;
  UPDATE campus_node SET name = 'Tulips' WHERE id = v.campus_node_id AND name = 'Tulips Cafe';

  INSERT INTO audit_log (action, outcome, resource, resource_id, detail)
  VALUES ('vendor.rename', 'ok', 'vendor', v.id::text,
          jsonb_build_object('from', v.name, 'to', 'Tulips', 'slug', 'tulips',
                             'source', 'platform owner direction, 24 Oct 2026'));
END $$;
