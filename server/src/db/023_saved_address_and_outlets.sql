-- ===========================================================================
-- ECHO ECHO - migration 023: saved campus address, and the owner's outlet and
-- destination corrections
--
-- Two ideas are kept apart on purpose:
--
--   WHERE on campus a delivery goes   -> food_order.destination_id, a
--                                        confirmed campus_node inside the
--                                        active boundary. The geofence.
--   HOW the student describes it      -> block / floor / room / landmark /
--                                        instructions. Text the student
--                                        typed. Never a coordinate, never
--                                        proof of anything.
--
-- A room number cannot open delivery anywhere: nothing here has a lat/lng.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Blocks a student can name in their address
--
-- Only numbers the field evidence establishes exist. `campus_node_id` stays
-- NULL until a block's building is identified on the ground: which named
-- building each number is has NOT been established
-- (docs/campus/BIDHOLI-FIELD-REPORT.md §6, BIDHOLI-BOUNDARY-ASSESSMENT.md §7).
-- A block therefore describes an address; it is never a delivery destination.
-- ---------------------------------------------------------------------------
CREATE TABLE campus_block (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campus_site_id uuid NOT NULL REFERENCES campus_site(id),
  number         int  NOT NULL CHECK (number BETWEEN 1 AND 99),
  label          text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  evidence       text NOT NULL CHECK (length(evidence) >= 10),
  campus_node_id uuid REFERENCES campus_node(id),
  active         boolean NOT NULL DEFAULT true,
  UNIQUE (campus_site_id, number)
);

INSERT INTO campus_block (campus_site_id, number, label, evidence)
SELECT c.id, v.number, 'Block ' || v.number, v.evidence
  FROM campus_site c,
       (VALUES
         (1,  'Door plates 1001, 1006 and 1104 (field photos #12-#18, 16 Sep 2026); captions name the area "Main Block".'),
         (2,  'Door plate 2002 (field photo #7, 16 Sep 2026).'),
         (3,  'Caption place name "3rd And 4th Block, University Of Petroleum And Energy Studies" (field photos #4, #5).'),
         (4,  'Caption place name "3rd And 4th Block, University Of Petroleum And Energy Studies" (field photos #4, #5).'),
         (8,  'Caption place name "8th Block, University Of Petroleum And Energy Studies" (field photo #105).'),
         (9,  'Door plate 9204 (field photo #103, 16 Sep 2026); captions name the area "New Porta".'),
         (11, 'Door plates 11011, 11012 and 11217 (field photos #94-#96, 16 Sep 2026); captions name the area "Chitrakoot".')
       ) AS v(number, evidence)
 WHERE c.slug = 'upes-bidholi';

-- ---------------------------------------------------------------------------
-- 2. The student's saved address - one per student, on their own campus
-- ---------------------------------------------------------------------------
CREATE TABLE student_address (
  user_id        uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  campus_site_id uuid NOT NULL REFERENCES campus_site(id),
  block_id       uuid REFERENCES campus_block(id),
  -- Used only when the student's block is not in the list above.
  block_text     text CHECK (length(block_text) BETWEEN 1 AND 40),
  floor          text CHECK (length(floor) BETWEEN 1 AND 20),
  room           text CHECK (length(room) BETWEEN 1 AND 20),
  landmark       text CHECK (length(landmark) <= 120),
  instructions   text CHECK (length(instructions) <= 300),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (block_id IS NULL OR block_text IS NULL)
);

-- ---------------------------------------------------------------------------
-- 3. The address on an order, frozen at draft time like everything else.
--    Editing the saved address later cannot reach back into this column.
-- ---------------------------------------------------------------------------
ALTER TABLE food_order ADD COLUMN delivery_address jsonb;

-- ---------------------------------------------------------------------------
-- 4. The owner's corrections, 25 Sep 2026
--
-- Nothing is deleted. Each change is a state change on an existing row (or a
-- new row), noted in the row's own source_note and in audit_log.
-- ---------------------------------------------------------------------------

-- 4a. Café Frisco leaves the student-facing list. The storefront was real
--     (signboard, photo #8); it is retired, not renamed: the "CHA…" sign is
--     a DIFFERENT storefront ~48 m west (photo #9), so nothing supports
--     turning Frisco's record into Chai Garam's.
UPDATE vendor SET active = false, is_open = false, accepting = false
 WHERE slug = 'frisco' AND active;

-- 4b. Chai Garam, named by the platform owner. No position: the only
--     candidate is the illegible "CHA…" sign (photo #9), which does not
--     establish the name. campus_node_id stays NULL, so no walking estimate
--     or map pin is shown for it. It opens CLOSED with no menu, like every
--     outlet: a person at the counter opens it.
INSERT INTO vendor (slug, name, campus_site_id, campus_node_id, is_open, accepting, active)
SELECT 'chai-garam', 'Chai Garam', c.id, NULL, false, false, true
  FROM campus_site c
 WHERE c.slug = 'upes-bidholi'
   AND NOT EXISTS (SELECT 1 FROM vendor WHERE slug = 'chai-garam');

-- 4c. Energy Block is no longer a student destination. Its position is well
--     evidenced, so the row and its confirmation stay; only delivery to it
--     is switched off.
UPDATE campus_node
   SET deliverable = false, delivery_enabled = false,
       source_note = coalesce(source_note, '') ||
         E'\n25 Sep 2026: removed from student delivery destinations at the platform owner''s direction (migration 023). Position and confirmation kept as evidence.'
 WHERE name = 'Energy Block' AND source = 'public_source'
   AND campus_site_id = (SELECT id FROM campus_site WHERE slug = 'upes-bidholi');

-- 4d. MAC, named by the platform owner. A secondary source (docs/
--     CAMPUS-UPES-BIDHOLI.md S6) describes a Multi-Activity Centre at
--     Bidholi, but no evidence places it, and nothing shows it is the Energy
--     Block. So it exists as a PENDING place with no position: not
--     deliverable, not on any map, not in the student's list.
INSERT INTO campus_node (campus_site_id, kind, name, deliverable, delivery_enabled,
                         lat, lng, source, source_note, verification, confidence, place_type)
SELECT c.id, 'building', 'MAC', false, false, NULL, NULL, 'admin',
       'Named by the platform owner, 25 Sep 2026, to replace "Energy Block" in the student list. '
       'A Multi-Activity Centre (gym, student lounge, 650-seat auditorium) is described for Bidholi by '
       'secondary sources (CAMPUS-UPES-BIDHOLI.md S6); its position is NOT established and it is NOT the '
       'Energy Block coordinate. Record its position on site before confirming it.',
       'pending', 'low', 'student_facility'
  FROM campus_site c
 WHERE c.slug = 'upes-bidholi'
   AND NOT EXISTS (SELECT 1 FROM campus_node n WHERE n.campus_site_id = c.id AND n.name = 'MAC');

-- 4e. Room plates stay as evidence and are never destinations. They already
--     are not deliverable; this makes the intent explicit on the rows.
UPDATE campus_node
   SET deliverable = false, delivery_enabled = false
 WHERE source = 'survey' AND lat IS NULL AND kind = 'spot'
   AND campus_site_id = (SELECT id FROM campus_site WHERE slug = 'upes-bidholi');

INSERT INTO audit_log (actor_id, actor_role, action, resource, outcome, detail)
VALUES (NULL, 'migration', 'migration.023', 'campus', 'ok',
        '{"frisco":"retired (vendor.active=false)","chai_garam":"created, no position, closed",
          "energy_block":"delivery switched off, record kept","mac":"created pending, no position",
          "rooms":"never deliverable","why":"platform owner direction 25 Sep 2026"}');
