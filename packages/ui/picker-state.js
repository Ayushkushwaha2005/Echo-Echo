/* ==========================================================================
   ECHO ECHO — WHAT THE DELIVERY PICKER HAS SELECTED

   Two different things, kept apart:

   - the student's MAP POINT (`pick`): wherever they tapped. The server says
     whether it is inside the active campus boundary; it is never moved,
     snapped or swapped for a named place;
   - the DESTINATION (`destination`): what the order goes to, chosen by the
     student - a confirmed delivery point (its marker, or a list row), OR,
     since migration 027, their own spot itself ("Choose this spot", or
     their accepted live location), which the server re-validates on the
     order.

   A tap on the map replaces the map point and CLEARS any destination: the
   student has just said "here", so an earlier choice (from the list, from
   live location, or near an earlier tap) no longer stands. Nothing here
   ever picks a destination for them: not the nearest, not the first, not
   the last one they had.

   Pure functions over plain objects, so the rules are tested without a
   browser. Each returns the fields to change.
   ========================================================================== */

const round6 = (n) => Number(Number(n).toFixed(6));

/** The student tapped the map (not a marker) at lat/lng. */
export function mapPointChosen(lat, lng) {
  return { pick: { pin: { lat: round6(lat), lng: round6(lng) }, pending: true }, destination: null };
}

/** The server answered the tap. `answer` is { candidates, note } or { error }. */
export function mapPointAnswered(state, pin, answer) {
  if (state.pick?.pin !== pin) return null;          // a newer tap superseded this one
  return answer.error || answer.inside === false
    ? { pick: { pin, candidates: [], inside: false, error: answer.error || 'This spot is outside the campus delivery area.' } }
    : { pick: { pin, candidates: answer.candidates || [], inside: true, note: answer.note || null } };
}

/**
 * The student chose a confirmed delivery point: its marker, or a row in a
 * list the server sent. `pin` is set only when the choice was made from the
 * points near their own map point; the order re-checks it server-side.
 */
export function destinationChosen(dest, { pin = null, path = '' } = {}) {
  return {
    destination: { id: dest.id, name: dest.name, path, pin },
    /* Choosing a marker directly replaces the map point; choosing from the
       points near it keeps the point visible beside its choice. */
    ...(pin ? {} : { pick: null }),
  };
}

/**
 * "Choose this spot": the student's exact point becomes the destination.
 * Only a point the server said is inside the boundary; the order checks it
 * again. `source` is 'map' or 'gps' (with the reading's accuracy).
 */
export function spotChosen(at, { source = 'map', accuracy = null } = {}) {
  if (!at || !Number.isFinite(at.lat) || !Number.isFinite(at.lng)) return null;
  const spot = { lat: round6(at.lat), lng: round6(at.lng), source, ...(source === 'gps' ? { accuracy } : {}) };
  return {
    destination: { id: null, kind: source === 'gps' ? 'live_gps_spot' : 'manual_map_spot',
                   name: source === 'gps' ? 'Your live location' : 'Your delivery spot',
                   path: `${spot.lat.toFixed(5)}, ${spot.lng.toFixed(5)}`, pin: null, spot },
    pick: null,
  };
}

/** The spot the picker has pending: the map point, if the server said inside. */
export const usableSpot = (state) => (state.pick && !state.pick.pending && state.pick.inside && !state.pick.error
  ? state.pick.pin : null);

/**
 * The picker's bottom button, with the reason whenever it cannot be pressed.
 *   { label, enabled, act, reason }
 */
export function pickerCta({ pick = null, destination = null } = {}) {
  if (destination) {
    const label = destination.spot
      ? (destination.spot.source === 'gps' ? 'Deliver to my live location' : 'Deliver to this spot')
      : destination.pin ? `Deliver to your spot near ${destination.name}` : `Deliver to ${destination.name}`;
    return { label,
             enabled: true, act: 'closeSheet', reason: null };
  }
  const off = (label, reason) => ({ label, enabled: false, act: null, reason });
  if (!pick) return off('Choose a spot', 'Tap the map where you want it, use your live location, or choose a delivery point.');
  if (pick.pending) return off('Checking your spot…', null);
  if (pick.error || !pick.inside) return off('Choose a spot', pick.error || 'This spot is outside the campus delivery area.');
  return { label: 'Choose this spot', enabled: true, act: 'useSpot', reason: null };
}
