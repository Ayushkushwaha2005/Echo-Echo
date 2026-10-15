/* ==========================================================================
   THE DELIVERY PIN, STEP BY STEP (packages/ui/picker-state.js)

   What the picker holds as the student uses their location, drags the pin,
   or picks a saved place - and what it would send. Pure state, no browser:
   the server's verdicts are fed in exactly as /campus/locate and /campus/pin
   return them (their real behaviour is tested in delivery-anywhere.test.mjs).
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPointChosen, mapPointAnswered, gpsPointPlaced, spotFromPick, pickerCta, destinationChosen }
  from '../../packages/ui/picker-state.js';

const FIX = { lat: 30.4168071, lng: 77.9679063, accuracy: 9, timestamp: 1 };   // field reading 2, as a phone reports it
const INSIDE = { inside: true, candidates: [], note: null };
const S0 = () => ({ pick: null, destination: { id: 'earlier', name: 'Earlier choice' } });

test('location granted and confident: the pin goes exactly on the reading, and is sent as a live-location spot', () => {
  const S = S0();
  Object.assign(S, gpsPointPlaced(FIX, { ...INSIDE, boundaryName: 'x' }));
  assert.deepEqual(S.pick.pin, { lat: 30.416807, lng: 77.967906 }, 'the reading at 6 dp - not the campus centre');
  assert.equal(S.destination, null, 'an earlier choice does not survive a new reading');
  assert.deepEqual([pickerCta(S).enabled, pickerCta(S).act], [true, 'useSpot']);
  const chosen = spotFromPick(S.pick);
  assert.deepEqual(chosen.destination.spot, { lat: 30.416807, lng: 77.967906, source: 'gps', accuracy: 9 });
  assert.equal(chosen.destination.kind, 'live_gps_spot');
});

test('the student drags the pin after GPS: it becomes their map spot at the new point', () => {
  const S = S0();
  Object.assign(S, gpsPointPlaced(FIX, INSIDE));
  Object.assign(S, mapPointChosen(30.4171234, 77.9681234));          // dragend
  assert.equal(S.pick.pending, true);
  assert.equal(pickerCta(S).enabled, false, 'not choosable until the server has checked it');
  assert.equal(spotFromPick(S.pick), null);
  Object.assign(S, mapPointAnswered(S, S.pick.pin, INSIDE));
  const chosen = spotFromPick(S.pick);
  assert.deepEqual(chosen.destination.spot, { lat: 30.417123, lng: 77.968123, source: 'map' },
    'a moved pin is no longer the reading, so it is not sent as one');
  /* The marker, the coordinates and what the screen shows are one value. */
  assert.equal(chosen.destination.path, '30.41712, 77.96812');
});

test('a poor or uncertain reading: pin on the reading, checked like a tap, never certified', () => {
  for (const reason of ['low_accuracy', 'near_boundary', 'accuracy_unknown']) {
    const S = S0();
    Object.assign(S, gpsPointPlaced({ ...FIX, accuracy: 140 }, { inside: false, reason }));
    assert.deepEqual(S.pick.pin, { lat: 30.416807, lng: 77.967906 }, reason);
    assert.equal(S.pick.certified, false);
    assert.equal(pickerCta(S).enabled, false, `${reason}: must be checked first`);
    Object.assign(S, mapPointAnswered(S, S.pick.pin, INSIDE));
    assert.equal(spotFromPick(S.pick).destination.spot.source, 'map', `${reason}: confirmed as a map spot, not GPS`);
    /* ...and when the server refuses the point, nothing is choosable. */
    const T = S0();
    Object.assign(T, gpsPointPlaced({ ...FIX, accuracy: 140 }, { inside: false, reason }));
    Object.assign(T, mapPointAnswered(T, T.pick.pin, { error: 'This spot is outside the campus delivery area.' }));
    assert.equal(spotFromPick(T.pick), null);
    assert.equal(pickerCta(T).enabled, false);
  }
});

test('outside the outline, no outline, or no reading: no pin is placed anywhere', () => {
  for (const verdict of [{ inside: false, reason: 'outside_campus' }, { inside: false, reason: 'no_boundary_configured' }]) {
    assert.deepEqual(gpsPointPlaced(FIX, verdict), { pick: null }, verdict.reason);
  }
  assert.deepEqual(gpsPointPlaced(null, INSIDE), { pick: null });
  assert.deepEqual(gpsPointPlaced({ lat: NaN, lng: 77.9, accuracy: 5 }, INSIDE), { pick: null });
  const S = { pick: null, destination: null };
  assert.equal(pickerCta(S).enabled, false);
  assert.match(pickerCta(S).reason, /current location|tap the map/);
});

test('an answer for a pin that has since moved is dropped', () => {
  const S = S0();
  Object.assign(S, mapPointChosen(30.4165, 77.968));
  const old = S.pick.pin;
  Object.assign(S, mapPointChosen(30.4166, 77.9681));
  assert.equal(mapPointAnswered(S, old, INSIDE), null);
  assert.equal(S.pick.pending, true);
});

test('a saved place: checked like any pin, chosen under its own name, remembered by id', () => {
  const S = S0();
  Object.assign(S, mapPointChosen(30.417310, 77.967787, { from: 'saved', placeId: 'p-1', label: 'Sitting area' }));
  Object.assign(S, mapPointAnswered(S, S.pick.pin, INSIDE));
  assert.equal(pickerCta(S).label, 'Deliver to Sitting area');
  const chosen = spotFromPick(S.pick);
  assert.deepEqual(chosen.destination.spot, { lat: 30.41731, lng: 77.967787, source: 'map' });
  assert.deepEqual([chosen.destination.name, chosen.destination.placeId], ['Sitting area', 'p-1']);
  assert.equal(pickerCta(chosen).label, 'Deliver to this spot');
});

test('a named delivery point still works beside the pin flow', () => {
  const S = S0();
  Object.assign(S, destinationChosen({ id: 'n-1', name: 'Enrollment Office' }));
  assert.deepEqual([S.destination.id, S.pick], ['n-1', null]);
  assert.equal(pickerCta(S).label, 'Deliver to Enrollment Office');
});
