# UPES Bidholi — boundary assessment, 25 September 2026

The question: is the proposed OpenStreetMap outline (production boundary
`5414c945-9a18-4f0f-9961-fa7425c5cec8`) the right geofence for the student
location check, or does the field evidence call for a different one?

**Answer: the existing OSM outline is the best-supported boundary the evidence
allows. No revised polygon is proposed.** Its one weak spot is the Boys Hostel.
Nothing was activated; the geofence stays fail-closed until the owner runs the
command in §8.

Everything here is reproducible from committed files:

```bash
node tools/campus-boundary-audit.mjs   # rebuilds the audit CSV and the review map
node tools/campus-field-verify.mjs "<path to the 'Google map' folder>"   # SHA-256 + outline checks
```

| File | What it is |
|---|---|
| `bidholi-boundary-audit.csv` | one row per photograph: file, SHA-256, coordinate, how it was checked, inside/outside, metres to edge, area, status |
| `bidholi-boundary-review.html` | open in a browser: Leaflet + OSM map of everything below |
| `bidholi-caption-check-2026-09-25.csv` | the independent re-read of every caption |
| `osm-bidholi-extract.geojson` | the OSM data used (ODbL), snapshot 2026-07-15 |
| `prod-campus-tree-2026-09-25.json` | the 17 production locations, from the public API |

---

## 1. Evidence audit — all 114 photographs

| Check | Result |
|---|---|
| Photos in the archive | 114 JPEGs, all named in the transcription |
| SHA-256 vs `bidholi-field-2026-09-readings.csv` | **114 / 114 match** |
| EXIF GPS | every photo has a GPS block, **all 114 are empty** (0/0 rationals). No XMP packet in any photo. The burned-in caption is the only coordinate source |
| Caption re-read by Windows OCR (`tools/caption-ocr.ps1`) | **107 / 114** identical to the transcription, to the last digit |
| The other 7 (#40, 58, 70, 80, 87, 88, 92) | OCR misread `°` as a digit or `3` as `8`. Read by eye at full resolution: **all 7 identical to the transcription.** #87 is `77.968528` as transcribed (OCR said `77.968448`) |
| Readings changed | **none** — the transcription is confirmed, not altered |
| Stale fixes | #40=#41, #64=#65, #75=#76, #109=#110 share identical coordinates: kept, marked non-independent |
| Receiver accuracy | not recorded by the app for any photo |

## 2. The observed campus footprint

114 readings, **~424 m N–S × 344 m E–W**, in these areas (labels come from each
photo's own signage, plate or caption place name):

| Area (from the photo's signage/plate/place name, else the nearest labelled reading ≤ 60 m) | Readings | Nearest the edge |
|---|---|---|
| Sports courts / ground | 20 | **16 m** (#47, basketball court) |
| Main Block (Block 1), plates 1001/1006/1104 | 16 | 59 m |
| Management Development Centre / Management Block | 10 | 38 m |
| Aditya Block / Chopra Centre | 8 | 101 m |
| Porta cabins | 8 | **16 m** (#34) |
| Placement Block / Career Services | 8 | 25 m |
| Auditorium | 7 | **14 m** (#45) |
| Block 11 (Chitrakoot), plates 11011/11012/11217, Food Technology Lab | 6 | 42 m |
| 3rd/4th Block (Block 2), plate 2002 | 4 | 95 m |
| Glass pyramid building | 4 | 56 m |
| New Porta (Block 9), plate 9204 | 4 | 47 m |
| Enrollment Office / The Huddle | 3 | **23 m** (#22) |
| R&D Block, **BOYS HOSTEL sign**, Tulips Cafe | 5 | 24 m (#90) |
| Food court, Café Frisco, "CHA…" café | 5 | 68 m |
| Energy Block | 2 | 46 m |
| 8th Block | 2 | 81 m |
| **GIRLS HOSTEL gate** | 1 | 42 m |
| #98 (no label; rejected fix) | 1 | 58 m *outside* |

- **Inside the OSM outline: 113.** 101 are more than 25 m from the edge; **12 are
  within 25 m** (#22, 34, 35, 36, 37, 42, 43, 44, 45, 47, 48, 90) — all on the
  west/north-west side (auditorium, porta cabins, basketball court, Enrollment
  Office) plus #90 at R&D Block.
- **Outside: 1 (#98).**
- **Gates:** no gate is mapped in OSM and none was photographed as a campus gate.
  OSM roads cross the outline at 4 points (south-west service road near Energy
  Block; the public road skirting the north-east edge, twice; one service road
  at the north-east). These are *candidate access points*, not confirmed gates.
- **Hostels:** the Girls Hostel gate (#79) and a Boys Hostel sign (#89) are the
  only hostel evidence. See §3.
- **Outside the outline in OSM:** SAI HOSTEL (147 m), D2 (169 m), D3 (295 m),
  RAVI FOOD CORNER (277 m), Scholars Paradise (310 m) — all south, in Bidholi
  village, none tagged as UPES. The outline correctly leaves them out: the
  product serves students on campus, not in private accommodation.

### Reading #098 — rejected as a position

`20260916_50500PMByGPSMapCamera.jpg`, 30.414623, 77.970043, 58 m south of the edge.

- The photo is an **indoor ceiling** with clerestory windows — the same white
  panel ceiling as the Block 11 corridor in #97.
- Timeline: #97 Food Technology Lab, Block 11, **17:01:55** → #98 **17:04:59** →
  #99 Block 11 balcony **17:08:12**.
- The caption's own map thumbnail (rendered by the camera app at capture time)
  puts the pin on **open farmland at a tree line, with no building**. An indoor
  photograph cannot have been taken there.

It is a drifted indoor fix, not evidence that campus extends south. It does not
justify moving the edge.

## 3. The OSM outline — assessment

**Supported:**
- 113/114 readings inside; the one outside is a bad fix.
- Every named UPES place photographed — both cafés, both hostel signs, every
  academic block, the sports ground — lies inside it.
- It is the only UPES-attributed polygon in OSM (way 321638232,
  `amenity=university`, wikidata Q3633126), about 30 acres (30.1 by this audit), matching the published
  ~30-acre Bidholi campus; the official UPES map pin is inside, 9 m from reading #26.
- No OSM feature tagged as UPES lies outside it.

**Not supported by any evidence (the limits of what can be claimed):**
- Nobody walked the perimeter. Every reading is interior, so the edge itself is
  OSM's, not ours.
- **The Boys Hostel.** Photo #89 (27 m inside the north-east edge) looks
  north-north-west (the caption thumbnail's view cone) at a "BOYS HOSTEL"
  gatehouse 40–60 m away; the hostel is beyond that gate. That lands on or just
  past the north-east edge. No photograph was taken at or in the Boys Hostel, so
  its position cannot be established.
- **The Girls Hostel building** stands directly behind its gate (#79, looking
  north, 42 m from the edge). Probably inside; its footprint is not recorded.

## 4. Revised boundary — not proposed, and why

A revision would have to add area the outline currently leaves out. The only
candidate is the Boys Hostel, and **no reading gives a coordinate for it**.
Drawing a polygon around it would mean choosing coordinates by eye — exactly
what the rules forbid. A convex hull of the 113 valid readings is 18.4 acres against the
outline's 30.1 and lies entirely inside it: using it would shrink the campus
and put the 12 near-edge readings on or over the edge, so it is worse, not
better.

Therefore: **the existing outline is kept as the proposal.**

## 5. What each option excludes

| Option | Excluded | Effect on students |
|---|---|---|
| **Activate the OSM outline** | village land to the south (private hostels, D2/D3, food corners); the public road on the east; possibly part of the **Boys Hostel** | Anyone outside, or within their own GPS error of the edge, is refused with a reason. A Boys Hostel resident may be told "You are not on campus" or "right on the edge" — fail-closed, never a false admit. The west side (auditorium, courts, Enrollment Office) is 14–24 m from the edge, so a phone fix worse than ~15–20 m there is refused as `near_boundary` and the student is told to move further in. |
| **Do not activate** | everything | Every student is refused ("not switched on yet"), as today. |

A larger outline cannot be justified from the evidence, so it is not an option here.

## 6. Destination reconciliation — the 17 production locations

None can be made deliverable by this assessment: every one is `pending`, and
confirming a delivery point is an on-the-ground decision (Campus Control →
Confirm location). Positions below are the photographer's, not a counter or door.

| Location | Evidence | Coordinate | vs outline | Deliverable? / why not |
|---|---|---|---|---|
| Café Frisco | #8 signboard "Café Frisco" | 30.416223, 77.968012 | inside, 74 m | pickup point, not a delivery destination; reading is ~10 m in front of the counter — pending |
| Tulips Cafe | #91 signboard "Tulips CAFE" | 30.416383, 77.969702 | inside, 34 m | pickup point; ~10 m in front of the counter — pending |
| Enrollment Office | #22 signboard | 30.416529, 77.966459 | inside, **23 m** | pending |
| The Huddle | #23 signboard | 30.416423, 77.966492 | inside, 31 m | pending |
| Career Services / Placement Block | #61 signboards | 30.418386, 77.967602 | inside, 33 m | pending |
| Management Development Centre | #72 signboard | 30.418251, 77.969181 | inside, 46 m | pending |
| Girls Hostel gate | #79 gate signboard | 30.418098, 77.969246 | inside, 42 m | pending; whether UPES allows hand-over at this gate is not established |
| Energy Block | OSM way 536452676 (public map) | 30.415934, 77.966974 | inside, 45 m | pending; public-map position |
| Infirmary | OSM node 4165237313 (public map) | 30.416965, 77.967669 | inside, 107 m | pending; public-map position |
| Block 11, Floor 2, Room 17 (`11217`) | #96 door plate | **none** | — | the reading (30.415753, 77.969675, 49 m inside) is the corridor, not the room — no room coordinate |
| Block 11, Room 11 (`11011`), Room 12 (`11012`) | #95, #94 plates | none | — | same: corridor readings, 42 m inside |
| Block 1, Room 01 / 06, Floor 1 Room 04 (`1001`, `1006`, `1104`) | #13/14, #12, #18 plates | none | — | corridor readings, 65–86 m inside |
| Block 2, Room 02 (`2002`) | #7 plate | none | — | corridor reading, 98 m inside |
| Block 9, Floor 2, Room 04 (`9204`) | #103 plate | none | — | corridor reading, 70 m inside |

Not in production:

| Place | Evidence | Status |
|---|---|---|
| **Chai Garam** | #9: a café sign beginning "CHA…", rest hidden, at 30.416359, 77.967536 (74 m inside, beside Café Frisco) | the owner names Chai Garam as a cafeteria; this is the only photographed café that could be it. The position is the photographer's; the name on the sign is not legible. Treat #9 as its *probable* location until someone at the counter confirms it |
| Boys Hostel | #89 sign seen 40–60 m away | no position |
| Campus gates | none photographed; 4 road crossings in OSM | no position |

## 7. Unresolved

1. Boys Hostel position — possibly on or beyond the north-east edge.
2. The edge itself — OSM's line, not walked.
3. #98 — rejected as a position (indoor drift); nothing further needed unless a
   south-side campus area is ever claimed.
4. Chai Garam — the sign at #9 is not legible; the owner's naming is the only link.
5. Café counters — both readings are ~10 m in front of the counter.
6. Room plates — building/corridor evidence only; no room coordinates.
7. Which named building each block number is.
8. Whether hostel gates may be hand-over points.

## 8. Production changes

**Required: none in code or schema.** The boundary is already in production as
proposed. Activation is the owner's attestation, run from a checkout whose
`server/.env` points at production:

```bash
npm --prefix server run boundary:confirm:local        # read-only: shows the outline and this evidence
npm --prefix server run boundary:confirm:local -- --activate 5414c945-9a18-4f0f-9961-fa7425c5cec8 \
  --confirmation "Reviewed 114 field photos (113 inside; #98 rejected as indoor drift) against OSM way 321638232 on 25 Sep 2026. Boys Hostel position unresolved."
```

After it, `GET /api/campus/boundary` returns the outline; `/campus/presence`
tests every student against it server-side (accuracy ≤ 100 m, inside, and
further from the edge than the reported accuracy); `deliveryAvailable` stays
`false` because no delivery point is confirmed. The undo, also the owner's,
puts it back to *proposed* (it can be confirmed again later):

```bash
npm --prefix server run boundary:confirm:local -- --deactivate 5414c945-9a18-4f0f-9961-fa7425c5cec8 \
  --confirmation "why it is being switched off"
```
