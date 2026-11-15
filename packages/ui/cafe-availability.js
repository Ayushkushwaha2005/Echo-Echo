/* ==========================================================================
   ECHO ECHO — CAFÉ AVAILABILITY, AS THE SCREENS SEND AND SHOW IT

   Two small rules shared by Campus Control and the student site, kept here
   so they are tested once (server/test/cafe-availability-followup.test.mjs).
   The server's statusOf() (server/src/services/hours.js) stays the only
   judge of whether a café is open; nothing here decides that.
   ========================================================================== */

/**
 * The PATCH /vendors/:id body for an availability choice.
 *
 * Manual Closed sets only is_open. It never touches `accepting`, the
 * separate emergency pause: otherwise turning the override off later would
 * leave the café paused instead of back on its schedule. Manual Open also
 * resumes orders, because "Open" is an explicit instruction to trade.
 */
export function availabilityUpdate({ manual, open }) {
  if (!manual) return { manualAvailability: false };
  return open ? { manualAvailability: true, isOpen: true, accepting: true }
              : { manualAvailability: true, isOpen: false };
}

/**
 * What the cart and checkout say about the café whose items are in the cart.
 * `vendor` is the server's live answer (GET /vendors/:id/menu → vendor), or
 * null while it is being asked. Until it answers nothing is blocked: the
 * server refuses a closed café's order anyway (409), so this is the honest
 * early warning, not the safeguard.
 */
export function cartAvailability(vendor) {
  if (!vendor) return { blocked: false, checking: true, title: null, detail: null };
  if (vendor.open_now) return { blocked: false, checking: false, title: null, detail: null };
  const name = vendor.name || 'This café';
  const line = vendor.status?.line;
  const paused = vendor.status?.state === 'paused';
  return {
    blocked: true, checking: false,
    title: paused ? `${name} is not taking orders right now` : `${name} is closed right now`,
    detail: `${line && !/^Closed right now$|^Not taking orders right now$/.test(line) ? `${line}. ` : ''}`
      + 'Ordering is unavailable until it opens again. Your cart is kept.',
  };
}
