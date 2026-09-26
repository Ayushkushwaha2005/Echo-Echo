/* ==========================================================================
   ECHO ECHO — WHAT THE DELIVERY PICKER HAS SELECTED

   Two different things, kept apart:

   - the student's MAP POINT (`pick`): wherever they tapped. It is only a
     point. It is never a delivery destination, never written anywhere as
     one, and never turned into one behind the student's back;
   - the DESTINATION (`destination`): a confirmed campus delivery point the
     student chose themselves - by tapping its marker, or by choosing it from
     a list the server offered.

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
  return answer.error
    ? { pick: { pin, candidates: [], error: answer.error } }
    : { pick: { pin, candidates: answer.candidates || [], note: answer.note || null } };
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

/** The student pressed "Use this spot": their exact point is kept as the spot. */
export function mapPointConfirmed(state) {
  const p = state.pick;
  if (!p || p.pending || p.error || !p.candidates?.length) return null;
  return { pick: { ...p, confirmed: true } };
}

/**
 * The picker's bottom button, with the reason whenever it cannot be pressed.
 * "I selected this point" and "this point can be delivered to" are separate:
 * a point is kept and shown whatever the answer, but an order must name a
 * confirmed delivery point (the server re-checks the spot is within reach of
 * it), so the student - never this code - chooses one for their spot.
 *   { label, enabled, act, reason }
 */
export function pickerCta({ pick = null, destination = null } = {}) {
  if (destination) {
    return { label: destination.pin ? `Deliver to your spot near ${destination.name}` : `Deliver to ${destination.name}`,
             enabled: true, act: 'closeSheet', reason: null };
  }
  const off = (label, reason) => ({ label, enabled: false, act: null, reason });
  if (!pick) return off('Choose a spot', 'Tap the map, or choose a delivery point from the list.');
  if (pick.pending) return off('Checking your spot…', null);
  if (pick.error) return off('Choose a spot', `This spot is outside the supported delivery area. ${pick.error}`);
  if (!pick.candidates?.length) {
    return off('Choose a spot', 'This spot is inside campus but is not currently supported for delivery: no delivery point is within reach of it.');
  }
  if (!pick.confirmed) return { label: 'Use this spot', enabled: true, act: 'useSpot', reason: null };
  return off('Choose a handover point', 'Your spot is saved. Choose which delivery point near it the rider should come to.');
}
