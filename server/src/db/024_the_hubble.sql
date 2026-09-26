-- ===========================================================================
-- ECHO ECHO - migration 024: "The Huddle" is The HUBBLE
--
-- Migration 022 transcribed the signboard in field photo #23
-- (20260916_41105PMByGPSMapCamera.jpg, 16 Sep 2026 16:11) as "THE HUDDLE".
-- The sign reads "THE HUBBLE" (red fascia over the entrance; re-read from
-- campus-field/derivatives/bidholi-023.jpg on 25 Sep 2026), and the platform
-- owner named it "The HUBBLE". This is a transcription correction, not a new
-- place: same row, same id, same position, same confirmation.
--
-- Orders already placed to it carry the name in destination_snapshot. The
-- snapshot records WHERE the order went, and the place did not change - only
-- the misreading of its name - so the snapshot's name is corrected too. The
-- destination_id, the pin, the address and every financial record are left
-- exactly as they were.
-- ===========================================================================

UPDATE campus_node
   SET name = 'The HUBBLE',
       aliases = ARRAY(SELECT DISTINCT a FROM unnest(array_append(
                   array_remove(coalesce(aliases, '{}'), 'The Huddle'), 'Hubble')) a),
       source_note = replace(coalesce(source_note, ''), '("THE HUDDLE")', '("THE HUBBLE")') ||
         E'\n25 Sep 2026: name corrected from "The Huddle" (a misreading of the signboard in photo #23) to "The HUBBLE" (migration 024).'
 WHERE name = 'The Huddle'
   AND campus_site_id = (SELECT id FROM campus_site WHERE slug = 'upes-bidholi');

UPDATE food_order o
   SET destination_snapshot = replace(o.destination_snapshot::text, 'The Huddle', 'The HUBBLE')::jsonb
  FROM campus_node n
 WHERE o.destination_id = n.id
   AND n.name = 'The HUBBLE'
   AND o.destination_snapshot::text LIKE '%The Huddle%';

INSERT INTO audit_log (actor_id, actor_role, action, resource, outcome, detail)
VALUES (NULL, 'migration', 'migration.024', 'campus', 'ok',
        '{"renamed":"The Huddle -> The HUBBLE","why":"signboard in field photo #23 reads THE HUBBLE; platform owner direction 25 Sep 2026","position":"unchanged","orders":"destination_snapshot name corrected"}');
