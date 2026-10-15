# Deliver to any campus spot — live-location fix (16 Oct 2026)

## What was failing

Students standing inside UPES Bidholi were refused, or never got a reading at all.
These are the confirmed causes, each covered by a regression test.

### 1. The server's location check refused most of the campus (measured)

`POST /campus/presence` (the on-campus check that used to gate **all** ordering at
sign-in) refuses a reading whose accuracy circle reaches the campus edge
(`near_boundary`, `distance-to-edge < accuracy`). That rule is correct for
certifying a *person*. But the active outline (OSM way 321638232, boundary
`5414c945`) is small: about 441 × 452 m, and no point inside it is more than 155 m
from its edge. Measured over a 2 m grid inside the live outline:

| reported accuracy | share of campus refused as "near the edge" |
|---|---|
| ±20 m | 23 % |
| ±30 m | 34 % |
| ±50 m | 53 % |
| ±75 m | 73 % |

Phones indoors usually report 20–65 m. So "inside campus but refused" was the
normal outcome, not an edge case, and there was no map-pin alternative.

### 2. The browser reading code dropped good readings (`packages/data/geofix.js`)

* **A transient error ended the attempt.** The first `POSITION_UNAVAILABLE` (code 2)
  was a final refusal. iPhones report it routinely while the GPS is still acquiring
  (Core Location's "location unknown, keep trying").
* **Readings were thrown away as "cached".** Any reading stamped more than 1 s
  before the request was ignored. On a device whose location clock lags the page
  clock (GNSS time against a drifting system clock), every reading was ignored and
  the result was "took too long".
* **The timeout counted the permission prompt.** The 12 s timer started before
  the student answered the browser's permission prompt.

### 3. No way to correct a reading

The tapped pin could not be dragged. A reading the server would not certify only
produced an error, with no "place the pin and correct it" path.

## What changed

* **Delivery is located by its pin.** A delivery order needs a destination the
  server places inside the active boundary, either a confirmed named point or an
  exact map spot. It no longer *also* needs the session presence check (owner
  direction: a student whose phone cannot locate them may choose a validated map
  point). Nothing about the student is certified by this. Every order records
  `destination_snapshot.locationBasis = { destination: campus_point | map_pin |
  live_gps_spot, studentPresence: live_location_confirmed | not_confirmed }`.
* **Self pickup still requires the live on-campus check** when the
  `live_location` flag is on (unchanged rule). The check is now asked at checkout,
  not forced at sign-in.
* **"Use my current location"** (only on tap) shows progress and drops the pin on
  the reading:
  * confident reading inside the outline: sent as a live-location spot;
  * poor, uncertain or edge reading: pin placed on the reading, checked like any
    tap, confirmed by the student as a *map* spot (never certified as GPS);
  * reading outside the outline, or no outline: **no pin is placed**, and the
    student is told why.
* **The pin can be dragged**, tapped elsewhere, or placed with **"Pin the
  centre"** (keyboard / screen-reader path).
* **Payment re-checks the destination** against the boundary in force at payment
  time (`assertOrderDestination`). A spot that has since fallen outside is refused
  before any money is asked for.
* **An active boundary with unusable geometry** is treated as no boundary: every
  location path fails closed.
* **Spot details:** a name (chips: Ground, Sitting area, Lawn, Library…),
  landmark and instructions, plus block/floor/room only when the spot is inside a
  building. None of these are required. They reach the partner's brief, the
  student's tracking card and the partner's offer list.
* **Saved places** (migration `031_saved_places.sql`, additive): pin + name +
  words, up to 8 per student. Each pin is checked against the active boundary on
  save and again on every order. The earlier one-row saved address
  (`student_address`) is untouched and still prefills checkout.

## Owner-only follow-ups

* **The boundary itself.** The OSM outline may be tighter than the real campus:
  field reading #098 was taken on campus but lies 58 m outside it. If students
  are refused on genuine campus ground, the fix is a better outline confirmed on
  the ground (Campus Control → Boundaries → propose → activate). Do not widen it
  without that survey.
* **Pickup presence.** Self pickup still needs a confident live reading. If that
  proves too strict, it is a product decision (flag `live_location`), not a code
  fix.
