# UPES Bidholi — campus data and its sources

Research date: **13 September 2026**. Everything ECHO ECHO holds about the
real campus is listed here with where it came from. Nothing else about the
campus is in the product, and nothing here is guessed.

## Sources used

| # | Source | Kind | What it gave |
|---|---|---|---|
| S1 | UPES contact page, <https://www.upes.ac.in/contact> | **Official UPES** | Bidholi campus is "Energy Acres", P.O. Bidholi Via-Prem Nagar, Dehradun 248007; Kandoli campus is "Knowledge Acres"; a map link for each |
| S2 | The Bidholi map link on S1 (`goo.gl/maps/6CMRdetkKW9HRx4h9`), resolved | **Official UPES** (UPES's own pin) | Bidholi place pin **30.415937, 77.9668366** |
| S3 | The Kandoli map link on S1 (`goo.gl/maps/YHGVBkJA7GU77Xmi9`), resolved | **Official UPES** | Kandoli place pin **30.3835258, 77.9697669** — a separate site about 3.6 km south |
| S4 | OpenStreetMap way **321638232**, via Overpass, data timestamp 2026-09-13 | Reliable map data (ODbL) | `amenity=university`, "University Of Petroleum and Energy Studies - UPES", Wikidata Q3633126; a 14-point closed outline |
| S5 | OpenStreetMap features inside S4 | Reliable map data (ODbL) | way 536452676 "Energy block, UPES" (`building=college`, 2 levels, centre 30.415935, 77.966974); node 4165237313 "INFIRMARY" (`amenity=hospital`); node 4165131646 "D1" (`amenity=restaurant`); way 1427743659 "Cafe De Bistro" (`amenity=cafe`) |
| S6 | Secondary education portals (Shiksha, Careers360, CollegeDekho, GetMyUni, Leverage Edu) | Third-party | Bidholi about **30 acres**, Kandoli about 14; separate on-campus boys' and girls' hostels at Bidholi; schools such as SoE, SoCS, SoD, SoHST; a Multi-Activity Centre with gym, student lounge and a 650-seat auditorium |

The official UPES site did not provide a downloadable campus map, a list of
buildings, hostel names or a boundary. A facilities page linked from search
(`admission.upes.ac.in/portal/facilities-at-upes`) returned HTTP 404.

## What was cross-checked

- **Boundary (S4):** its enclosed area computes to **30.0 acres**, matching the
  ~30 acres reported for Bidholi (S6).
- **The official UPES pin (S2)** lies inside the S4 outline, and sits on the
  OSM "Energy block, UPES" building (S5), 13 m from its centre.
- **Kandoli (S3)** is well outside the outline, so the outline is not a
  combined polygon of both campuses.

## What ECHO ECHO now contains

| Item | Where | State | Why |
|---|---|---|---|
| Campus "UPES — University of Petroleum and Energy Studies · Bidholi Campus" | migration 011 | in service | the brief |
| Campus "… · Kandholi Campus" | migration 011 | coming soon; all orders refused | the brief |
| Bidholi boundary from S4 | migration 013 | **proposed, inactive** | S4, cross-checked with S2 and S6. Not an official survey: it must be confirmed on the ground (Campus Control → Locations → Confirm and activate) |
| "Energy Block" (30.415934, 77.966974) | migration 016 | **pending confirmation, not deliverable**, confidence high | S5 way 536452676; the official UPES pin (S2) sits on it |
| "Infirmary" (30.416965, 77.967669) | migration 016 | **pending confirmation, not deliverable**, confidence medium | S5 node 4165237313 only; no official UPES confirmation |
| Any other delivery location | — | **none** | no official building, hostel or room list exists in any source found |
| Chai Garam, Frisco, Tulips pickup points | — | **not set** | no public source gives their on-campus position |

### Second research pass — 13 September 2026 (later the same day)

- **OpenStreetMap re-queried** via Overpass (data base 2026-09-13T16:54:51Z):
  every named feature inside way 321638232, plus named amenities within 400 m.
  Found only: Energy block (way 536452676), INFIRMARY (node 4165237313), D1
  (node 4165131646, restaurant), Cafe De Bistro (way 1427743659, cafe) inside
  the outline; **D2** (node 4165140656, restaurant, 30.413902, 77.966917) and
  **SAI HOSTEL** (way 415438425, `building=residential`, 30.413841, 77.969943)
  south of it. SAI HOSTEL lies outside the outline and nothing identifies it as
  UPES accommodation, so it is not recorded. D1/D2/Cafe De Bistro are not among
  the three supported cafeterias and are not recorded.
- **Official UPES sources checked:** `upes.ac.in/campus-life` and
  `hostel.upes.ac.in` name no hostel or academic block;
  `admission.upes.ac.in/portal/feel-home/modern-on-campus-hostels` returned
  HTTP 404. They confirm only that separate boys' and girls' on-campus hostels
  exist at Bidholi.
- **Chai Garam, Frisco, Tulips:** no official or map source gives a position
  for any of them. Their pickup point stays unset; set it in Campus Control
  (Cafeterias → Edit → pickup point) after measuring on site.

**Distance/ETA:** no estimate can honestly be produced yet, because no
cafeteria pickup point has a verified position. Once one is set, Campus Control
and the student site show "Approx. X–Y min" for every destination that has a
recorded position (formula below). For scale only: the two pending candidates
are about 130 m apart in a straight line, which the formula gives as
"Approx. 4–8 min" (computed with `walkEstimate`) — this is not presented anywhere in the product.

**Delivery stays disabled on Bidholi until an administrator confirms the
boundary.** That is intentional: the server refuses delivery orders on a
campus without a confirmed boundary, refuses locations whose recorded position
is outside it, and refuses live-location suggestions that are unsure (no
accuracy reported, accuracy over 100 m, or nearer the edge than the reported
accuracy).

## What is missing, and who can supply it

| Missing | Why it matters | How to get it |
|---|---|---|
| Ground confirmation of the S4 outline | hostels, gates or blocks outside it would be refused | walk the perimeter with a phone GPS, or compare with a UPES estates/security map |
| Official names of academic blocks | delivery destinations | UPES campus signage / student handbook / estates office |
| Hostel names, blocks and whether delivery to them is allowed | the largest delivery area | UPES hostel office; confirm the delivery policy (many campuses restrict riders at hostel gates) |
| Where Chai Garam, Frisco and Tulips are on campus | pickup points for walking-time estimates | stand at each counter and record its position, or the vendors' agreements |
| Entrances/gates | where partners enter; whether outsiders are allowed | UPES security office |

OSM also lists "D1" and "Cafe De Bistro" as food places inside the outline.
They are not in ECHO ECHO: they are not among the three supported cafeterias,
and their current operation is unverified.

## How to add a verified location

Campus Control → Locations → Add location. Fill **Source of this
information** (for example "UPES hostel office list, Sep 2026" or "measured on
site 20 Sep"). Enter coordinates only when measured on site or taken from a
reliable map. Mark "Orders can be delivered here" only for places a partner
may actually hand food over.

## Walking-time estimates

Shown only when both the cafeteria's pickup point and the destination have a
recorded position inside the confirmed boundary:

- straight-line distance between the two points
- multiplied by 1.25–1.6 for paths that are not straight
- walked at 65–80 m/min
- plus 2–4 minutes to hand over

The result is shown as a range in whole minutes ("Approx. 5–8 min"). It is an
estimate, not live navigation, and no routing service is used.
