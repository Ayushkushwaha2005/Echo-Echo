-- ============================================================================
-- ECHO ECHO - migration 030: the Tulips Cafe menu
--
-- Transcribed from the owner's three photos of the Tulips counter boards
-- ("tulips menu/IMG_20261001_1511*.jpg", taken 1 Oct 2026, supplied 3 Oct
-- 2026). Every name and price below is legible on the boards; nothing was
-- inferred. Transcription notes: docs/cafes/tulips-menu-2026-10-03.md.
--
-- Prices are the board prices exactly. The ECHO ECHO platform fee (Rs 10) is
-- an order-level fee charged by pricing_policy, never folded into an item.
--
-- Where one board price covers several flavours ("Chocolate / Vanilla /
-- Choco Vanilla 55/-"), each flavour is its own item at that price. Items
-- the board marks "Veg" or "Chicken"/"Non veg" carry that flag; drinks and
-- desserts carry no mark on the board, so their veg flag is left NULL.
-- The board's own short name is kept as an alias ("Chilly Paneer" for the
-- Chilly Paneer Hot Dog), so a student can ask for it either way.
--
-- Runs once: a Tulips that already has a menu is left alone.
-- ============================================================================

DO $$
DECLARE v uuid; c uuid; r record; cat text; n int := 0;
BEGIN
  SELECT id INTO v FROM vendor WHERE slug = 'tulips' AND active;
  IF v IS NULL THEN RETURN; END IF;             -- a database without Tulips
  IF EXISTS (SELECT 1 FROM menu_item WHERE vendor_id = v) THEN RETURN; END IF;

  FOR r IN SELECT * FROM (VALUES
    -- category, sort, name, board rupees, veg, alias, description
    ('Speciality Drinks', 1, 'Peach Ice Tea', 45, NULL::boolean, NULL, NULL),
    ('Speciality Drinks', 1, 'Lemon Ice Tea', 45, NULL, NULL, NULL),
    ('Speciality Drinks', 1, 'Nimbupani Masala', 35, NULL, 'Masala Lemonade', NULL),
    ('Speciality Drinks', 1, 'Blueberry Lassi', 45, NULL, NULL, NULL),
    ('Speciality Drinks', 1, 'Cold Coffee', 55, NULL, NULL, NULL),
    ('Speciality Drinks', 1, 'Hazelnut Coffee', 55, NULL, NULL, NULL),
    ('Softy', 2, 'Chocolate Softy', 55, NULL, NULL, 'Full cream soft serve'),
    ('Softy', 2, 'Vanilla Softy', 55, NULL, NULL, 'Full cream soft serve'),
    ('Softy', 2, 'Choco Vanilla Softy', 55, NULL, NULL, 'Full cream soft serve'),
    ('Sundae', 3, 'Chocolate Sundae', 59, NULL, NULL, NULL),
    ('Sundae', 3, 'Mango Sundae', 59, NULL, NULL, NULL),
    ('Sundae', 3, 'Strawberry Sundae', 59, NULL, NULL, NULL),
    ('Slush', 4, 'Blue Lagoon Slush', 49, NULL, 'Blue Lagoon', NULL),
    ('Slush', 4, 'Mojito Green Slush', 49, NULL, 'Mojito Green', NULL),
    ('Hot Dog', 5, 'Chilly Paneer Hot Dog', 69, true, 'Chilly Paneer', 'Fresh milk bun'),
    ('Hot Dog', 5, 'Pasta Bun Hot Dog', 79, true, 'Pasta Bun', 'Fresh milk bun'),
    ('Hot Dog', 5, 'Chicken Salami Salad Hot Dog', 89, false, 'Chicken Salami Salad', 'Fresh milk bun'),
    ('Hot Dog', 5, 'Chicken Seekh Kebab Hot Dog', 99, false, 'Chicken Seekh Kebab', 'Fresh milk bun'),
    ('Sandwich', 6, 'Batata Vada Sandwich', 55, true, 'Batata Vada', 'Multigrain bread, no maida'),
    ('Sandwich', 6, 'Cheese Salad Sandwich', 65, true, 'Cheese Salad', 'Multigrain bread, no maida'),
    ('Sandwich', 6, 'Chicken Afghani Spread Sandwich', 89, false, 'Chicken Afghani Spread', 'Multigrain bread, no maida'),
    ('Sandwich', 6, 'Chicken Ham n Cheese Sandwich', 99, false, 'Chicken Ham n Cheese', 'Multigrain bread, no maida'),
    ('Rice Bowl', 7, 'Chicken Keema Rice Bowl', 120, false, 'Chicken Keema',
     'Amritsari chicken keema masala with boiled egg, basmati rice, green chutney and onion salad'),
    ('Rice Bowl', 7, 'Rajma Masala Rice Bowl', 80, true, 'Rajma Masala',
     'Jammu Chitra rajma masala with a shot of curd, basmati rice, green chutney, pickle and salad')
  ) AS t(category, sort, name, board_rupees, veg, alias, description)
  LOOP
    IF cat IS DISTINCT FROM r.category THEN
      SELECT id INTO c FROM category WHERE vendor_id = v AND name = r.category;
      IF c IS NULL THEN
        INSERT INTO category (vendor_id, name, sort) VALUES (v, r.category, r.sort) RETURNING id INTO c;
      END IF;
      cat := r.category;
    END IF;
    INSERT INTO menu_item (vendor_id, category_id, name, price_paise, veg, available, active, aliases, description)
    VALUES (v, c, r.name, r.board_rupees * 100, r.veg, true, true,
            CASE WHEN r.alias IS NULL THEN '{}'::text[] ELSE ARRAY[r.alias] END, r.description);
    n := n + 1;
  END LOOP;

  INSERT INTO audit_log (action, outcome, detail)
  VALUES ('vendor.menu.import', 'ok', jsonb_build_object('vendor', 'tulips', 'items', n,
    'source', 'owner photos of Tulips counter boards, 1 Oct 2026', 'pricing', 'board price, unchanged'));
END $$;
