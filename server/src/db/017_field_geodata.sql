-- ===========================================================================
-- ECHO ECHO - migration 017: field-collected campus geodata
--
-- What a location IS (place_type) and HOW its position was established
-- (verification_method, GPS accuracy, when it was recorded) are stored with
-- the point, so a confirmed coordinate always carries its evidence.
-- Confirmation itself (verified_by, verified_at, verification) came in 016.
-- ===========================================================================

ALTER TABLE campus_node
  ADD COLUMN place_type text CHECK (place_type IN (
    'academic_block','administrative','library','hostel','residence','student_facility',
    'cafeteria_pickup','entrance','delivery_point','other')),
  ADD COLUMN verification_method text CHECK (verification_method IN (
    'gps_on_site','survey_track','official_map','public_map','admin_entry')),
  ADD COLUMN gps_accuracy_m numeric(7,1) CHECK (gps_accuracy_m IS NULL OR gps_accuracy_m >= 0),
  ADD COLUMN recorded_at text,               -- as reported by the GPS app; informational
  ADD COLUMN import_batch uuid;

-- A confirmed location whose position was typed in must say how it was known.
ALTER TABLE campus_node ADD CONSTRAINT campus_node_confirmed_position_has_method
  CHECK (verification <> 'confirmed' OR lat IS NULL OR verification_method IS NOT NULL
         OR source IN ('admin','unverified_seed'));

-- The OSM candidates from 016 were read off a public map.
UPDATE campus_node SET verification_method = 'public_map', place_type =
       CASE name WHEN 'Energy Block' THEN 'academic_block' WHEN 'Infirmary' THEN 'student_facility' END
 WHERE source = 'public_source' AND verification = 'pending';

ALTER TABLE campus_boundary
  ADD COLUMN collection_method text CHECK (collection_method IN ('gps_walk','survey','official_map','public_map','admin_entry')),
  ADD COLUMN track_stats jsonb;
UPDATE campus_boundary SET collection_method = 'public_map' WHERE source = 'openstreetmap:way/321638232';

CREATE INDEX IF NOT EXISTS campus_node_import_batch ON campus_node (import_batch) WHERE import_batch IS NOT NULL;
