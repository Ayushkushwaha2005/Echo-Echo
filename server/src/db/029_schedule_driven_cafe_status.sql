-- ============================================================================
-- ECHO ECHO - migration 029: café status follows the schedule
--
-- Owner direction 3 Oct 2026: a café's open/closed status is computed from
-- its weekly schedule and the current time in Asia/Kolkata, on the server.
-- Nobody switches Chai Garam or Tulips on at 8 AM and off at 6 PM.
--
-- From this release (src/services/hours.js):
--   * a scheduled café is open exactly inside its hours; `is_open` is no
--     longer read for it;
--   * `accepting` is the café's emergency stop, which closes it whatever the
--     hour until it is switched back on.
--
-- Both cafés were created with `accepting = false` ("created closed"), which
-- under the new rule would read as an emergency stop that nobody set. It is
-- cleared here for these two cafés only, and their schedule is re-stated so
-- the rule they now run under is visible in one place:
--   Monday-Saturday 08:00-18:00 IST, Sunday closed.
-- No other café, price or menu row is touched.
-- ============================================================================

UPDATE vendor
   SET open_days = '{1,2,3,4,5,6}', opens_at = '08:00', closes_at = '18:00',
       accepting = true
 WHERE slug IN ('chai-garam', 'tulips') AND active;
