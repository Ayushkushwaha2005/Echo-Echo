-- ===========================================================================
-- ECHO ECHO - migration 016: location verification state
--
-- A location can exist as a PENDING candidate (from a public map, awaiting
-- ground confirmation) without being usable for delivery. The delivery gate
-- refuses pending locations and locations with no recorded position.
-- ===========================================================================

ALTER TABLE campus_node
  ADD COLUMN verification text NOT NULL DEFAULT 'confirmed'
    CHECK (verification IN ('pending','confirmed')),
  ADD COLUMN confidence text CHECK (confidence IN ('low','medium','high')),
  ADD COLUMN verified_by uuid REFERENCES app_user(id),
  ADD COLUMN verified_at timestamptz;

-- A pending location can never be a delivery point.
ALTER TABLE campus_node ADD CONSTRAINT campus_node_pending_not_deliverable
  CHECK (verification = 'confirmed' OR deliverable = false);

-- ---------------------------------------------------------------------------
-- UPES Bidholi candidates. Only features that are (a) named in OpenStreetMap
-- and (b) inside the proposed Bidholi outline (migration 013). Retrieved via
-- Overpass on 2026-09-13 (OSM base 2026-09-13T16:54:51Z), ODbL.
-- No official UPES list of buildings, hostels or blocks is published; see
-- docs/CAMPUS-UPES-BIDHOLI.md. Both are PENDING and NOT deliverable.
-- ---------------------------------------------------------------------------
INSERT INTO campus_node (campus_site_id, kind, name, deliverable, delivery_enabled, lat, lng, source, source_note,
                         verification, confidence)
SELECT c.id, v.kind, v.name, false, false, v.lat, v.lng, 'public_source', v.note, 'pending', v.confidence
  FROM campus_site c,
       (VALUES
         ('building', 'Energy Block', 30.415934, 77.966974, 'high',
          'OpenStreetMap way 536452676 "Energy block, UPES" (building=college, 2 levels), retrieved 2026-09-13. The official UPES contact-page map pin for Bidholi (30.415937, 77.966837) lies on this building. Confirm the official name, the hand-over point and delivery permission on site.'),
         ('building', 'Infirmary', 30.416965, 77.967669, 'medium',
          'OpenStreetMap node 4165237313 "INFIRMARY" (amenity=hospital), retrieved 2026-09-13. Not confirmed by an official UPES source. Confirm it exists at this position and whether food hand-over is appropriate there.')
       ) AS v(kind, name, lat, lng, confidence, note)
 WHERE c.slug = 'upes-bidholi'
   AND NOT EXISTS (SELECT 1 FROM campus_node n WHERE n.campus_site_id = c.id AND lower(n.name) = lower(v.name));
