# Collecting UPES Bidholi geodata on site

**Status: pending — no field data has been collected yet.** Everything below
is ready; nothing in the database describes a real UPES point except the two
pending OpenStreetMap candidates and the proposed OSM boundary.

Nothing here is guessed. A point enters ECHO ECHO only from a GPS reading you
take, a track you walk, or an official document you name — and it stays
**pending** (never deliverable) until an administrator confirms it.

## What to bring

- A phone with GPS, location set to high accuracy, charged.
- One of (free, no account needed — check the app's own terms):
  - **Campus Control itself** — Locations → Add location → *Use this phone's GPS here*. Best for individual points: records position, accuracy and method directly.
  - A GPS logger app that exports **GPX** or **CSV** (for example "GPS Logger" on Android, or any app that exports GPX). Best for the perimeter walk.
- Permission to walk the perimeter and enter hostel/academic areas (ask campus security first).

## Points to record

For each, stand at the place a delivery partner would actually hand food over
(the door or reception, not the middle of the building). Wait until the phone
reports accuracy of **25 m or better** (ideally under 10 m, outdoors).

| Type (`type` column) | What to record |
|---|---|
| `cafeteria_pickup` | the counter where a partner collects: **Frisco, Tulips, Chai Garam** |
| `academic_block` | each block's main entrance, with its official name from signage |
| `administrative` | administrative buildings |
| `library` | library entrance |
| `hostel` / `residence` | the gate or reception where outsiders hand over — only if UPES allows delivery there |
| `student_facility` | infirmary, sports/MAC, other legitimate student destinations |
| `entrance` | campus gates and access points partners use |
| `delivery_point` | any other agreed hand-over spot |

Use **names exactly as on official signage**. Note in `note` where the name
came from ("signboard at entrance").

## Two ways to enter them

**A. One at a time, on site (recommended).** Campus Control → Locations →
Add location → fill name and type → *Use this phone's GPS here* → Save. The
position, accuracy and method `gps_on_site` are stored; the location is
created by an administrator and can be made deliverable once you are sure.

**B. Batch import after the walk.** Fill `docs/templates/campus-points-template.csv`
(one row per point) or export waypoints as GPX/GeoJSON, then Campus Control →
Locations → **Import GPS points** → *Preview*. The preview shows invalid rows,
weak accuracy, names that already exist, points within 15 m of an existing
one, and whether each point is inside the confirmed boundary. Import as
pending, or tick "I collected these on site myself" (passkey + a note) to
confirm them in one step.

CSV columns:

| Column | Required | Values |
|---|---|---|
| `name` | yes | official name |
| `type` | yes | see the table above |
| `lat`, `lng` | yes | decimal degrees, e.g. from the GPS app |
| `accuracy_m` | strongly recommended | the accuracy the phone reported |
| `method` | optional (default `gps_on_site`) | `gps_on_site`, `survey_track`, `official_map`, `public_map`, `admin_entry` |
| `deliverable` | optional (default no) | `yes` only where food may be handed over |
| `note` | optional | source of the name, hand-over instructions |

What is stored for each confirmed point: name, type, latitude, longitude,
campus, verification method, GPS accuracy, source note, confirmation time,
confirming administrator, active/inactive, and the import batch.

## Then set each cafeteria's pickup point

Campus Control → Cafeterias → Edit → pickup point → choose the confirmed
`cafeteria_pickup` location. Locations → **Distances** then shows, for every
cafeteria and every confirmed location: straight-line distance, an estimate
range ("Approx. 4–8 min"), and whether the point is inside the confirmed
boundary. Estimates use 1.25–1.6× the straight-line distance, 65–80 m/min and
2–4 min for hand-over. They are estimates, not navigation.

## The perimeter

1. Start the GPS logger (1-second interval), walk the whole boundary fence
   once, return to the start, stop, export **GPX**.
2. Campus Control → Locations → **Import walked perimeter** → *Preview and
   compare*. It shows vertex count, area, the gap between start and end, and
   for every existing outline (including the OpenStreetMap proposal): overlap
   %, largest deviation in metres, and area of each.
3. Save it — it is stored as a **proposal**. The OSM proposal is kept; nothing
   is replaced.
4. On the proposal, *Compare with …* shows both outlines on one to-scale
   drawing, the corners that differ with their distances, and **which recorded
   locations would change from inside to outside** (or back).
5. Only when it matches the ground: *Confirm and activate* (needs
   `boundary.confirm`, a fresh passkey and a written note). Until then,
   **every delivery order is refused**.

## Checks the server enforces regardless of the UI

- Pending locations are never deliverable (database constraint).
- A delivery destination with no recorded position is refused.
- A destination outside the confirmed boundary is refused.
- No confirmed boundary → no delivery.
- Moving a confirmed location needs a fresh passkey and the method of the new position.
- Public-map points cannot be confirmed in a batch import.
