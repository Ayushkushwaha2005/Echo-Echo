-- ===========================================================================
-- ECHO ECHO - migration 025: Blocks 1-10 in the saved-address list
--
-- Migration 023 listed only the block numbers the field photos showed
-- (1, 2, 3, 4, 8, 9, 11). The platform owner directed on 26 Sep 2026 that a
-- student can choose any of Blocks 1-10 in their address. This adds 5, 6, 7
-- and 10 as address LABELS only:
--
-- - campus_node_id stays NULL: which building each number is has still not
--   been established, and no position is recorded or inferred;
-- - a block is never a delivery destination. Where an order goes is still a
--   confirmed campus_node inside the active boundary, checked server-side.
--
-- Existing rows (including Block 11) are left exactly as they are.
-- ===========================================================================

INSERT INTO campus_block (campus_site_id, number, label, evidence)
SELECT c.id, v.number, 'Block ' || v.number,
       'Address label only: Blocks 1-10 listed by platform owner direction, 26 Sep 2026. '
       || 'No field photo identifies this block''s building; no position is recorded.'
  FROM campus_site c, (VALUES (5), (6), (7), (10)) AS v(number)
 WHERE c.slug = 'upes-bidholi'
ON CONFLICT (campus_site_id, number) DO NOTHING;

INSERT INTO audit_log (actor_id, actor_role, action, resource, outcome, detail)
VALUES (NULL, 'migration', 'migration.025', 'campus', 'ok',
        '{"added_blocks":[5,6,7,10],"geometry":"none","destination":"never","why":"platform owner direction 26 Sep 2026: Blocks 1-10 selectable in the saved address"}');
