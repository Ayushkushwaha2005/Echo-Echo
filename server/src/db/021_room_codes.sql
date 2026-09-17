-- ===========================================================================
-- ECHO ECHO - migration 021: UPES Bidholi room plate codes
--
-- A Bidholi room plate encodes <block><floor><room>, read from the right:
-- the last two digits are the room, the digit before them is the floor, and
-- everything before that is the block.
--
--     1001  -> block 1,  floor 0, room 01
--     1104  -> block 1,  floor 1, room 04
--     9204  -> block 9,  floor 2, room 04
--     11011 -> block 11, floor 0, room 11
--
-- The plate as painted on the wall is kept VERBATIM in source_code. The three
-- derived columns exist so a destination can be found by block or by floor
-- without re-parsing a string in SQL. The parser is the single authority:
-- server/src/services/room-code.js, with server/test/room-code.test.mjs.
--
-- Nothing here makes anything deliverable. Migration 016 already holds the
-- line that matters -- verification = 'confirmed' OR deliverable = false -- so
-- a room whose plate was doubtful stays unconfirmed and undeliverable no
-- matter what is written in these columns.
-- ===========================================================================

ALTER TABLE campus_node
  -- The plate exactly as read, e.g. '11011'. Kept even when the derived
  -- columns are null, because the raw evidence outlives our reading of it.
  ADD COLUMN source_code   text CHECK (source_code IS NULL OR length(source_code) <= 32),
  ADD COLUMN block_number  int  CHECK (block_number IS NULL OR block_number >= 1),
  -- 0 is the floor digit on every ground-level plate observed. It is stored as
  -- 0 and deliberately NOT given a name: no source states what "0" is called,
  -- so the label omits it rather than inventing "Ground Floor".
  ADD COLUMN floor_number  int  CHECK (floor_number IS NULL OR floor_number >= 0),
  -- Text, not int: '01' must not become 1. The leading zero is part of the plate.
  ADD COLUMN room_number   text CHECK (room_number IS NULL OR room_number ~ '^[0-9]{2}$');

-- A derived room number without its block is meaningless, and a room number
-- that did not come from a plate we actually read has no business existing.
ALTER TABLE campus_node ADD CONSTRAINT campus_node_room_number_has_block
  CHECK (room_number IS NULL OR block_number IS NOT NULL);
ALTER TABLE campus_node ADD CONSTRAINT campus_node_room_parts_have_source_code
  CHECK ((block_number IS NULL AND floor_number IS NULL AND room_number IS NULL)
         OR source_code IS NOT NULL);

-- Two nodes must not claim the same plate on the same campus. Partial, so the
-- overwhelming majority of nodes (which have no plate) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS campus_node_source_code_unique
  ON campus_node (campus_site_id, source_code)
  WHERE source_code IS NOT NULL AND active;

CREATE INDEX IF NOT EXISTS campus_node_block_floor
  ON campus_node (campus_site_id, block_number, floor_number)
  WHERE block_number IS NOT NULL;

-- No data is inserted here. Every Bidholi room known at the time of this
-- migration comes from photographs of door plates and is recorded as evidence
-- in docs/campus/bidholi-observed-room-codes.csv, NOT as production rows.
-- Rooms enter the database only through the existing admin import, reviewed
-- and confirmed by an administrator.
