-- ============================================================================
-- ECHO ECHO - migration 046: a weekly schedule with its own hours per day
--
-- Until now a café had one pair of hours (opens_at / closes_at) shared by
-- every day in open_days. vendor.weekly_hours holds seven entries instead,
-- Monday (1) to Sunday (7):
--
--   [{"day":1,"open":true,"opens":"08:00","closes":"18:00"}, ...]
--
-- A closed day keeps its hours, so switching it back on restores them.
-- NULL means "no weekly schedule": the café's own Open/Closed switches decide,
-- exactly as a café without open_days does today.
--
-- vendor.timezone is the zone the hours are read in. Every café today is read
-- in Asia/Kolkata, so that is the default and nothing moves.
--
-- Backfill: every café that has a schedule today gets the same schedule,
-- day for day: its open_days are open with its current opens_at/closes_at,
-- the other days are closed (carrying the same hours for later). A café
-- without a schedule stays without one. No hours, days or switches change,
-- and open_days / opens_at / closes_at are kept (the server keeps them in
-- step on every change, for anything that still reads them).
-- ============================================================================

ALTER TABLE vendor ADD COLUMN IF NOT EXISTS weekly_hours jsonb
  CHECK (weekly_hours IS NULL OR (jsonb_typeof(weekly_hours) = 'array' AND jsonb_array_length(weekly_hours) = 7));
ALTER TABLE vendor ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Kolkata';

UPDATE vendor v
   SET weekly_hours = (
         SELECT jsonb_agg(jsonb_build_object(
                  'day', d,
                  'open', d = ANY (v.open_days),
                  'opens', to_char(v.opens_at, 'HH24:MI'),
                  'closes', to_char(v.closes_at, 'HH24:MI')) ORDER BY d)
           FROM generate_series(1, 7) AS d)
 WHERE v.weekly_hours IS NULL
   AND v.open_days IS NOT NULL AND cardinality(v.open_days) > 0
   AND v.opens_at IS NOT NULL AND v.closes_at IS NOT NULL;
