-- ===========================================================================
-- ECHO ECHO - migration 022: Bidholi field-collected candidates
--
-- The 16-feature layer in docs/campus/bidholi-campus-layer.draft.geojson,
-- collected on site on 16 September 2026 and reasoned about in
-- docs/campus/BIDHOLI-FIELD-REPORT.md. Every row below is a CANDIDATE:
-- `verification = 'pending'`, `deliverable = false`, `delivery_enabled =
-- false`. The constraint added in migration 016 makes the first two
-- inseparable, so nothing here can become a delivery target by accident.
--
-- Why a migration and not the admin importer: the importer
-- (POST /admin/campuses/:id/points/preview) is the only way in for an
-- operator, and it stays that way. It needs an administrator session, which
-- needs a passkey, which needs an emailed code — and student email delivery
-- is blocked on a verified sending domain. Migration 016 already established
-- this shape for the two OpenStreetMap candidates; this is the same thing
-- with better evidence. Confirmation still happens exactly where it did:
-- Campus Control, by an administrator with a fresh passkey.
--
-- WHAT IS DELIBERATELY ABSENT
--
--   · Chai Garam. The signboard could not be read in any frame
--     (BIDHOLI-FIELD-REPORT.md §"...VALLO"). It is not in the candidate
--     file and it is not invented here. One clear photograph settles it.
--   · The unresolved reading south of the OSM outline. One fix cannot
--     decide whether it is campus, so it stays out of the layer entirely
--     and therefore out of this migration.
--   · `Upes, Campus Food Court` - a geocoder label on a blurred ground
--     shot. It identifies no cafeteria.
--   · Every room's position. The readings are corridor positions of the
--     photographer, not rooms, so lat/lng are NULL. A delivery point with
--     no recorded position is refused by the delivery gate; that is the
--     intended outcome, not a gap to fill in later with a guess.
--   · Which named building each block number refers to. Not established.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Named places, photographed signboard by signboard. Each position is where
-- the photographer stood, NOT the hand-over point, which is why every one of
-- them is pending: the counter has to be re-recorded on site before an
-- administrator can confirm it.
-- ---------------------------------------------------------------------------
INSERT INTO campus_node (campus_site_id, kind, name, deliverable, delivery_enabled,
                         lat, lng, source, source_note, verification, confidence)
SELECT c.id, v.kind, v.name, false, false, v.lat, v.lng, 'survey', v.note, 'pending', 'medium'
  FROM campus_site c,
       (VALUES
         ('spot', 'Café Frisco', 30.416223, 77.968012,
          'Field survey 16 Sep 2026. Name from the shop''s own signboard ("Café Frisco"). Photo 20260916_34420PMByGPSMapCamera.jpg, 15:44. The reading is the photographer''s position ~10 m in front of the counter, not the counter itself: stand at the counter and re-record before making this deliverable.'),
         ('spot', 'Tulips Cafe', 30.416383, 77.969702,
          'Field survey 16 Sep 2026. Name from the shop''s own signboard ("Tulips CAFE", tulip-and-cup logo, menu boards). Photo 20260916_45232PMByGPSMapCamera.jpg, 16:52. The reading is the photographer''s position ~10 m in front of the counter: re-record at the counter before making this deliverable.'),
         ('building', 'Management Development Centre', 30.418251, 77.969181,
          'Field survey 16 Sep 2026. Name from the building''s own signboard ("MANAGEMENT DEVELOPMENT CENTRE"). Photo 20260916_44011PMByGPSMapCamera.jpg, 16:40. Reading taken from the forecourt, ~20 m from the entrance steps.'),
         ('building', 'Girls Hostel gate', 30.418098, 77.969246,
          'Field survey 16 Sep 2026. Name from the gate signboard ("GIRLS HOSTEL"). Photo 20260916_44210PMByGPSMapCamera.jpg, 16:42. Whether UPES permits delivery hand-over at this gate is NOT established - confirm with the hostel office before making this deliverable.'),
         ('building', 'Enrollment Office', 30.416529, 77.966459,
          'Field survey 16 Sep 2026. Name from the building''s own signboard ("ENROLLMENT OFFICE"). Photo 20260916_41027PMByGPSMapCamera.jpg, 16:10.'),
         ('building', 'The Huddle', 30.416423, 77.966492,
          'Field survey 16 Sep 2026. Name from the building''s own signboard ("THE HUDDLE"). Photo 20260916_41105PMByGPSMapCamera.jpg, 16:11. Reading taken from the approach path, ~30 m from the entrance.'),
         ('building', 'Career Services / Placement Block', 30.418386, 77.967602,
          'Field survey 16 Sep 2026. Signboards "Career Services" and "UPES 100% PLACEMENT" on the building. Photo 20260916_43138PMByGPSMapCamera.jpg, 16:31. Google''s reverse geocoder independently names this area "Placement Block, University Of Petroleum And Energy Studies, Bidoli Dunga Rd".')
       ) AS v(kind, name, lat, lng, note)
 WHERE c.slug = 'upes-bidholi'
   AND NOT EXISTS (SELECT 1 FROM campus_node n
                    WHERE n.campus_site_id = c.id AND lower(n.name) = lower(v.name));

-- ---------------------------------------------------------------------------
-- Room plates, read off doors. The label is derived from the plate by the
-- convention in services/room-code.js (block, floor, room, read from the
-- right); the plate itself is kept as an alias so a student can search the
-- number they can see. A floor digit of 0 is not written into the label,
-- because nothing in the evidence says what that level is called.
--
-- lat/lng are NULL on purpose. These rooms have no supported geometry.
-- ---------------------------------------------------------------------------
INSERT INTO campus_node (campus_site_id, kind, name, aliases, deliverable, delivery_enabled,
                         lat, lng, source, source_note, verification, confidence)
SELECT c.id, 'spot', v.name, ARRAY[v.plate], false, false, NULL, NULL, 'survey',
       'Field survey 16 Sep 2026. Door plate "' || v.plate || '" photographed in ' || v.photo ||
       '. No geometry: the GPS reading is the photographer''s corridor position, not the room. '
       'Which named building block ' || v.block || ' refers to is NOT established.',
       'pending', 'medium'
  FROM campus_site c,
       (VALUES
         ('1001',  'Block 1, Room 01',           '1',  '20260916_40045PMByGPSMapCamera.jpg'),
         ('1006',  'Block 1, Room 06',           '1',  '20260916_35936PMByGPSMapCamera.jpg'),
         ('1104',  'Block 1, Floor 1, Room 04',  '1',  '20260916_40428PMByGPSMapCamera.jpg'),
         ('2002',  'Block 2, Room 02',           '2',  '20260916_34252PMByGPSMapCamera.jpg'),
         ('9204',  'Block 9, Floor 2, Room 04',  '9',  '20260916_51117PMByGPSMapCamera.jpg'),
         ('11011', 'Block 11, Room 11',          '11', '20260916_45547PMByGPSMapCamera.jpg'),
         ('11012', 'Block 11, Room 12',          '11', '20260916_45543PMByGPSMapCamera.jpg'),
         ('11217', 'Block 11, Floor 2, Room 17', '11', '20260916_50149PMByGPSMapCamera.jpg')
       ) AS v(plate, name, block, photo)
 WHERE c.slug = 'upes-bidholi'
   AND NOT EXISTS (SELECT 1 FROM campus_node n
                    WHERE n.campus_site_id = c.id AND lower(n.name) = lower(v.name));

-- ---------------------------------------------------------------------------
-- The two cafeterias whose signboards were photographed and read.
--
-- They open CLOSED: `is_open = false`, `accepting = false`. An outlet starts
-- shut and a person opens it, because only a person at the counter knows
-- whether it is serving. No menu, no prices, no opening hours and no cuisine
-- descriptor are written here - none of that is in the evidence, and a price
-- nobody charged is worse than an empty menu.
--
-- `campus_node_id` points at the pending candidate above, so the outlet is
-- attached to the place it was photographed at while that place is still
-- unconfirmed. It cannot be delivered to until an administrator confirms the
-- location AND the boundary.
-- ---------------------------------------------------------------------------
INSERT INTO vendor (slug, name, campus_site_id, campus_node_id, is_open, accepting, active)
SELECT v.slug, v.name, c.id, n.id, false, false, true
  FROM campus_site c
  JOIN campus_node n ON n.campus_site_id = c.id
  JOIN (VALUES ('frisco', 'Café Frisco'),
               ('tulips', 'Tulips Cafe')) AS v(slug, name) ON lower(n.name) = lower(v.name)
 WHERE c.slug = 'upes-bidholi'
   AND NOT EXISTS (SELECT 1 FROM vendor x WHERE x.slug = v.slug);
