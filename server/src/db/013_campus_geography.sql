-- ===========================================================================
-- QUAD - migration 013: campus geography belongs to a campus
--
--  * Every location node and every boundary is tied to a campus_site.
--  * A boundary is 'proposed' until an administrator confirms it; only an
--    'active' boundary is used, and a campus with no active boundary accepts
--    NO delivery orders (pickup is unaffected). Fail closed.
--  * Destinations carry optional delivery instructions.
--  * The UPES Bidholi outline from OpenStreetMap is recorded as PROPOSED,
--    with its provenance. It does nothing until a person confirms it.
-- ===========================================================================

ALTER TABLE campus_node ADD COLUMN campus_site_id uuid REFERENCES campus_site(id);
-- Every node that exists before this migration was built for Bidholi, the
-- only campus in service.
UPDATE campus_node SET campus_site_id = (SELECT id FROM campus_site WHERE slug = 'upes-bidholi')
 WHERE campus_site_id IS NULL;
ALTER TABLE campus_node ALTER COLUMN campus_site_id SET NOT NULL;
CREATE INDEX ON campus_node (campus_site_id, parent_id) WHERE active;

-- A child always sits on its parent's campus.
CREATE FUNCTION campus_node_same_campus() RETURNS trigger AS $fn$
BEGIN
  IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM campus_node p WHERE p.id = NEW.parent_id AND p.campus_site_id = NEW.campus_site_id) THEN
    RAISE EXCEPTION 'a location must be on the same campus as its parent';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER campus_node_same_campus BEFORE INSERT OR UPDATE OF parent_id, campus_site_id ON campus_node
  FOR EACH ROW EXECUTE FUNCTION campus_node_same_campus();

ALTER TABLE campus_node DROP CONSTRAINT campus_node_kind_check;
ALTER TABLE campus_node ADD CONSTRAINT campus_node_kind_check
  CHECK (kind IN ('campus','zone','building','floor','room','spot'));
-- Shown to the delivery partner, e.g. "hand over at the main reception".
ALTER TABLE campus_node ADD COLUMN instructions text CHECK (length(instructions) <= 300);

-- Coordinates come in pairs or not at all.
ALTER TABLE campus_node ADD CONSTRAINT campus_node_coordinates_paired
  CHECK ((lat IS NULL) = (lng IS NULL));
ALTER TABLE campus_node ADD CONSTRAINT campus_node_coordinates_range
  CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180));

-- ------------------------------------------------------------------ boundary
ALTER TABLE campus_boundary
  ADD COLUMN campus_site_id uuid REFERENCES campus_site(id),
  ADD COLUMN status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','retired')),
  ADD COLUMN source_note text,
  ADD COLUMN created_by  uuid REFERENCES app_user(id),
  ADD COLUMN created_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN verified_by uuid REFERENCES app_user(id),
  ADD COLUMN verified_at timestamptz;
UPDATE campus_boundary
   SET campus_site_id = (SELECT id FROM campus_site WHERE slug = 'upes-bidholi'),
       status = CASE WHEN active THEN 'active' ELSE 'retired' END;
ALTER TABLE campus_boundary ALTER COLUMN campus_site_id SET NOT NULL;
-- A boundary set before this migration was entered by an administrator;
-- it is kept active and labelled as such.
UPDATE campus_boundary SET source = 'legacy_admin_entry' WHERE status = 'active' AND verified_at IS NULL;
ALTER TABLE campus_boundary ALTER COLUMN active SET DEFAULT false;
-- `active` is kept in step with status for the code paths that read it.
ALTER TABLE campus_boundary ADD CONSTRAINT campus_boundary_active_matches_status
  CHECK (active = (status = 'active'));
ALTER TABLE campus_boundary ADD CONSTRAINT campus_boundary_active_is_verified
  CHECK (status <> 'active' OR verified_at IS NOT NULL OR source = 'legacy_admin_entry');
CREATE UNIQUE INDEX one_active_boundary_per_campus ON campus_boundary (campus_site_id) WHERE status = 'active';

-- Proposed outline for UPES Bidholi (Energy Acres).
--   Source: OpenStreetMap way 321638232, "University Of Petroleum and Energy
--   Studies - UPES", amenity=university, wikidata Q3633126, read on
--   2026-09-13 via Overpass (data (c) OpenStreetMap contributors, ODbL).
--   Cross-checks: enclosed area computes to 30.0 acres, matching the ~30 acres
--   published for the Bidholi campus; the official UPES contact-page map pin
--   for Bidholi (30.415937, 77.966837) lies inside it, on the OSM "Energy
--   block, UPES" building. Not an official UPES survey - an administrator must
--   confirm it against the ground before it is activated.
INSERT INTO campus_boundary (name, polygon, active, status, source, source_note, campus_site_id)
SELECT 'UPES Bidholi (proposed from OpenStreetMap)',
       '[[30.4156492,77.9660971],[30.4156873,77.9664503],[30.415408,77.9671567],[30.4157126,77.9673628],[30.4152811,77.9687903],[30.4155223,77.9689375],[30.4151415,77.9701149],[30.4160046,77.9704828],[30.4163472,77.970262],[30.4166772,77.9698647],[30.4185428,77.9696292],[30.4192028,77.9676718],[30.4159919,77.9658911],[30.415852,77.9659752]]'::jsonb,
       false, 'proposed', 'openstreetmap:way/321638232',
       'OpenStreetMap way 321638232 (amenity=university, wikidata Q3633126), retrieved 2026-09-13, ODbL. Area 30.0 acres, matching the published ~30-acre Bidholi campus. Official UPES map pin 30.415937,77.966837 lies inside. Confirm on the ground before activating: hostels or gates outside this outline would be excluded.',
       (SELECT id FROM campus_site WHERE slug = 'upes-bidholi')
 WHERE EXISTS (SELECT 1 FROM campus_site WHERE slug = 'upes-bidholi');

-- Where each outlet is collected from, for distance estimates. Uses the
-- existing vendor.campus_node_id; nothing new is stored about the outlet.
CREATE INDEX IF NOT EXISTS vendor_campus_node ON vendor (campus_node_id);
