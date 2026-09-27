-- ============================================================================
-- ECHO ECHO - migration 026: cafe weekly hours, and the Chai Garam menu
--
-- 1. A weekly schedule on vendor: `open_days` (ISO weekday 1=Mon .. 7=Sun)
--    with the existing opens_at/closes_at, read in Asia/Kolkata. NULL
--    open_days = no schedule (the café's own open/accepting switch alone, as
--    before). With a schedule, an order also needs today to be an open day
--    and the time to be inside the hours. There is no separate delivery-hours
--    rule: delivery runs whenever the café can take the order.
--
--    Owner direction 27 Sep 2026: Chai Garam and Tulips Cafe open Monday to
--    Saturday 08:00-18:00; Sunday closed.
--
-- 2. Chai Garam's menu, transcribed from the owner's photo of the counter
--    boards ("chai garam menu.jpeg", 27 Sep 2026). Selling price = source
--    price + Rs 10 (owner authorised +5..10; +10 used throughout). Only items
--    whose name AND price are legible are added; the rest are listed in
--    docs/cafes/chai-garam-menu-2026-09-27.md as unresolved, never guessed.
--    The café's own is_open / accepting switch is not changed here.
-- ============================================================================

ALTER TABLE vendor ADD COLUMN open_days smallint[]
  CHECK (open_days IS NULL OR (open_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[] AND cardinality(open_days) > 0));

UPDATE vendor SET open_days = '{1,2,3,4,5,6}', opens_at = '08:00', closes_at = '18:00'
 WHERE slug IN ('chai-garam', 'tulips') AND active;

DO $$
DECLARE v uuid; c uuid; r record; cat text; n int := 0;
BEGIN
  SELECT id INTO v FROM vendor WHERE slug = 'chai-garam' AND active;
  IF v IS NULL THEN RETURN; END IF;             -- a database without Chai Garam
  IF EXISTS (SELECT 1 FROM menu_item WHERE vendor_id = v) THEN RETURN; END IF;

  FOR r IN SELECT * FROM (VALUES
    -- category, sort, name, source rupees, veg
    ('Cold Coffee', 1, 'Cold Coffee', 65, true),
    ('Cold Coffee', 1, 'Extra Strong Cold Coffee', 75, true),
    ('Cold Coffee', 1, 'Cold Mocha Coffee', 75, true),
    ('Q-Tea (150 ml)', 2, 'Adrak Chai', 25, true),
    ('Q-Tea (150 ml)', 2, 'Tulsi Chai', 25, true),
    ('Q-Tea (150 ml)', 2, 'Elaichi Chai', 35, true),
    ('Q-Tea (150 ml)', 2, 'Haldi Chai', 35, true),
    ('Q-Tea (150 ml)', 2, 'Kali Mirch Chai', 35, true),
    ('Q-Tea (150 ml)', 2, 'Mini Kulhad', 30, true),
    ('Q-Tea (150 ml)', 2, 'Kulhad Tea', 40, true),
    ('Q-Tea (150 ml)', 2, 'Chai Garam Special', 60, true),
    ('Double Q-Tea (150 ml)', 3, 'Adrak Elaichi', 30, true),
    ('Double Q-Tea (150 ml)', 3, 'Adrak Tulsi', 30, true),
    ('Double Q-Tea (150 ml)', 3, 'Gur Elaichi', 35, true),
    ('Double Q-Tea (150 ml)', 3, 'Saunf Elaichi', 30, true),
    ('Double Q-Tea (150 ml)', 3, 'Dalchini Adrak', 30, true),
    ('Double Q-Tea (150 ml)', 3, 'Kulhad Double Flavour', 45, true),
    ('Premium Tea (250 ml)', 4, 'Green Tea', 50, true),
    ('Premium Tea (250 ml)', 4, 'Green Tea with Lemon Honey', 60, true),
    ('Premium Tea (250 ml)', 4, 'Jasmine Green Tea', 70, true),
    ('Premium Tea (250 ml)', 4, 'Black Darjeeling', 50, true),
    ('Premium Tea (250 ml)', 4, 'Black Darjeeling with Lemon Honey', 70, true),
    ('Premium Tea (250 ml)', 4, 'Chamomile', 80, true),
    ('Pasta', 5, 'Veg Pasta (White/Red)', 75, true),
    ('Pasta', 5, 'Tandoori Sauce Pasta', 85, true),
    ('Pasta', 5, 'Mix Sauce Pasta', 85, true),
    ('Pasta', 5, 'Pink Pasta', 85, true),
    ('Pasta', 5, 'Veg Corn Pasta', 90, true),
    ('Pasta', 5, 'Cheese Corn Pasta', 100, true),
    ('Pasta', 5, 'Chicken Pasta', 90, false),
    ('Pasta', 5, 'Chicken Tandoori Pasta', 100, false),
    ('Pasta', 5, 'Chicken Mix Pasta', 110, false),
    ('Pasta', 5, 'Punjabi Pasta', 100, true),
    ('Wraps', 6, 'Veg Wrap', 70, true),
    ('Wraps', 6, 'Paneer Wrap', 90, true),
    ('Wraps', 6, 'Tandoori Veg Wrap', 80, true),
    ('Wraps', 6, 'Egg Wrap', 90, false),
    ('Wraps', 6, 'Chicken Wrap', 110, false),
    ('Wraps', 6, 'Tandoori Chicken Wrap', 120, false),
    ('Wraps', 6, 'Veg Corn Wrap', 80, true),
    ('Maggi', 7, 'Plain Maggi', 30, true),
    ('Maggi', 7, 'Veg Maggi', 40, true),
    ('Maggi', 7, 'Tandoori Maggi', 75, true),
    ('Maggi', 7, 'Chicken Maggi', 80, false),
    ('Maggi', 7, 'Chilli Garlic Maggi', 70, true),
    ('Sandwiches', 8, 'Veg Sandwich', 40, true),
    ('Sandwiches', 8, 'Cheese Garlic Sandwich', 55, true),
    ('Sandwiches', 8, 'American Corn Sandwich', 60, true),
    ('Sandwiches', 8, 'Paneer Sandwich', 65, true),
    ('Sandwiches', 8, 'Tandoori Paneer Sandwich', 70, true),
    ('Sandwiches', 8, 'Chicken Sandwich', 80, false),
    ('Sandwiches', 8, 'Tandoori Sandwich', 90, NULL),
    ('Sandwiches', 8, 'Peanut Butter Sandwich', 70, true),
    ('Sandwiches', 8, 'Paneer Twister', 90, true),
    ('Sandwiches', 8, 'Tomato Cheese Sandwich', 90, true),
    ('Light Diet', 9, 'Veg Oats', 45, true),
    ('Light Diet', 9, 'Masala Oats', 45, true),
    ('Light Diet', 9, 'Hot and Sour Soup', 30, true),
    ('Light Diet', 9, 'Sweet Corn Soup', 30, true),
    ('Light Diet', 9, 'Thick Tomato Soup', 30, true),
    ('Light Diet', 9, 'Corn Chaat', 60, true),
    ('Fries and Sides', 10, 'Classic Fries', 60, true),
    ('Fries and Sides', 10, 'Peri Peri Fries', 70, true),
    ('Fries and Sides', 10, 'Cheese Fries', 80, true),
    ('Fries and Sides', 10, 'Veg Nuggets (5 pcs)', 80, true),
    ('Fries and Sides', 10, 'Chicken Nuggets (5 pcs)', 110, false),
    ('Fries and Sides', 10, 'Veg Fingers (5 pcs)', 70, true)
  ) AS t(category, sort, name, source_rupees, veg)
  LOOP
    IF cat IS DISTINCT FROM r.category THEN
      INSERT INTO category (vendor_id, name, sort) VALUES (v, r.category, r.sort) RETURNING id INTO c;
      cat := r.category;
    END IF;
    INSERT INTO menu_item (vendor_id, category_id, name, price_paise, veg, available, active)
    VALUES (v, c, r.name, (r.source_rupees + 10) * 100, r.veg, true, true);
    n := n + 1;
  END LOOP;

  INSERT INTO audit_log (action, outcome, detail)
  VALUES ('vendor.menu.import', 'ok', jsonb_build_object('vendor', 'chai-garam', 'items', n,
    'source', 'owner photo of counter menu boards, 27 Sep 2026', 'pricing', 'source + Rs 10'));
END $$;
