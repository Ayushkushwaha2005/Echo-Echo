-- ============================================================================
-- ECHO ECHO - migration 031: saved delivery places (a map pin plus words)
--
-- Platform owner direction, Oct 2026: a student can order to ANY spot inside
-- the campus delivery area - the ground, a lawn, a sitting area, outside a
-- block - not only to a building with a floor and a room. The map pin is the
-- location; the words ("Ground", "near the main pathway") only help the
-- partner find it. A student can save such places, edit them and reuse them.
--
-- Additive only. Nothing existing is changed or removed:
--   - student_address (migration 023, one row per student: block / floor /
--     room / landmark / notes, no coordinates) stays exactly as it is, and
--     the app keeps using it to prefill the description;
--   - a saved place always has a pin. The pin is re-tested against the
--     ACTIVE boundary when it is saved and again on every order (it is sent
--     as an ordinary map spot), so a place saved under an outline that is
--     later redrawn is refused rather than trusted.
-- No floor or room is ever required: an outdoor place has none.
-- ============================================================================

CREATE TABLE saved_place (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  campus_site_id uuid NOT NULL REFERENCES campus_site(id),
  label          text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  lat            numeric(9,6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng            numeric(9,6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
  landmark       text CHECK (length(landmark) <= 120),
  instructions   text CHECK (length(instructions) <= 300),
  block_id       uuid REFERENCES campus_block(id),
  block_text     text CHECK (length(block_text) BETWEEN 1 AND 40),
  floor          text CHECK (length(floor) BETWEEN 1 AND 20),
  room           text CHECK (length(room) BETWEEN 1 AND 20),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  CHECK (block_id IS NULL OR block_text IS NULL)
);
CREATE INDEX saved_place_user ON saved_place (user_id, campus_site_id);
