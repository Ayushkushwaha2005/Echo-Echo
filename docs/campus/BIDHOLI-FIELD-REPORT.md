# UPES Bidholi — field photo survey, 14 and 16 September 2026

**Status: nothing in this report has been imported.** No database was mutated,
no boundary was confirmed, no location was made deliverable, no image was
published. The campus geofence remains fail-closed.

Code *was* written this round — the room-plate parser, its migration and its
tests, plus offline tooling (§9). None of it puts a row in a database.

This is the reconciliation of the photo archive Ayush supplied against what
ECHO ECHO already holds (`CAMPUS-UPES-BIDHOLI.md`, migrations 013 and 016).

---

## 1. What the archive actually is

The folder is **not** Google Maps data, screenshots, or exported map tiles. It
is a set of **geotagged field photographs**.

| | |
|---|---|
| Path | `Google map-20260916T214219Z-1-001/Google map/` (kept as supplied) |
| Files | **114**, all `.jpg`, one flat folder, no sub-folders |
| Size | **814 MB** |
| Camera | `motorola edge 50 fusion :: Captured by - GPS Map Camera` (all 114) |
| Dimensions | 4096×3072, 3072×4096, 3280×2460 |
| Dates | **3 photos** 14 Sep 2026 (14:39–15:10), **111 photos** 16 Sep 2026 (15:42–17:24) |
| PDFs, documents, map exports, coordinate screenshots | **none** |

No ZIP file is present — the archive arrived already extracted. The original
folder has not been modified, renamed or deleted.

**It is now git-ignored** (`.gitignore`: `Google map*/`), so it cannot be
committed by accident.

### Where the coordinates live

`getexif()` on all 114 files returns **no GPS IFD** — latitude, longitude and
altitude are all absent from EXIF. GPS Map Camera does not write standard EXIF
GPS; it **burns the position into the image as a caption bar**:

```
Misraspatti, Uttarakhand, India 🇮🇳
Cx89+q53 Aditya Block, Misraspatti, Uttarakhand 248007, India
Lat 30.416895° Long 77.968128°
Wednesday, 16/09/2026 05:16 PM GMT +05:30
```

So the coordinates could only be obtained by **reading the caption**. All 114
were transcribed by eye from the rendered caption bars. Each reading carries
its source filename and the file's SHA-256 as evidence:

- `docs/campus/bidholi-field-2026-09-readings.csv` — all 114 readings
- `docs/campus/bidholi-observed-room-codes.csv` — every room plate seen
- `docs/campus/bidholi-candidate-points.csv` — importer-format candidates

**This transcription is not machine-verified.** No OCR engine was run; there is
no second independent pass. Treat every coordinate as *one careful human
reading* until somebody re-checks it. That is why nothing here is proposed for
confirmation.

---

## 2. Is this Bidholi?

Yes, and it cross-checks against three independent things ECHO ECHO already had.

| Check | Result |
|---|---|
| Extent of all 114 readings | lat 30.414623–30.418429, lng 77.966459–77.970043 — about **424 m N–S × 344 m E–W** |
| Inside the proposed OSM outline (migration 013, way 321638232) | **113 of 114** |
| Outside it | **1** — reading #098, and see below |
| Distance from the official UPES map pin S2 (30.415937, 77.9668366) | closest reading is **9 m** away |
| Caption place names | "University Of Petroleum And Energy Studies", "Bidoli Dunga Rd", "Energy Block", "Placement Block", "Management Block" |

Nothing in the archive belongs to **Kandoli**. The Kandoli campus pin (S3) is
30.3835258, 77.9697669, about 3.6 km south; **no reading is anywhere near it.**
There is no unrelated-Dehradun material and no other campus mixed in.

### The one reading outside the outline

| # | File | Lat, Lng | Caption |
|---|---|---|---|
| 098 | `20260916_50500PMByGPSMapCamera.jpg` | 30.414623, 77.970043 | `Cx7c+j5r, **Bidholi**, Uttarakhand 248007` |

It sits just south of the OSM outline. It is the only reading whose caption
names the locality **Bidholi** rather than **Misraspatti**. The photo itself is
an indoor ceiling/skylight shot and identifies nothing. This is exactly the
south-of-the-outline area where `CAMPUS-UPES-BIDHOLI.md` already noted OSM has
features (D2, SAI HOSTEL) that are *not* recorded as UPES.

**Unresolved.** It is either a real part of campus the OSM outline excludes, or
a point just off campus. One reading cannot settle it.

### What this does and does not prove about the boundary

113 of 114 readings falling inside the outline is **corroboration, not
confirmation**. Every one of these is an *interior* point. A perimeter is
confirmed by walking the fence line, and **nobody walked the fence line.**

> The OSM boundary stays a **proposal**. Delivery stays refused. Do not
> activate it on the strength of this archive.

`CAMPUS-FIELD-COLLECTION.md` §"The perimeter" already describes exactly what is
still needed: a GPS logger at 1-second interval, one full lap, exported as GPX.

---

## 3. What the caption place names give us

Google's reverse geocoder attached a place name to most photos. Grouping the
readings by that name:

| Caption place | Readings | Centroid (lat, lng) | Spread |
|---|---|---|---|
| Main Block | 11 | 30.416435, 77.967165 | 39 m |
| Upes, Management Block | 8 | 30.418247, 77.969222 | 20 m |
| Placement Block | 7 | 30.418071, 77.967798 | 36 m |
| Chitrakoot | 6 | 30.415766, 77.969714 | 25 m |
| R & D Block | 4 | 30.416390, 77.969771 | 7 m |
| New Porta | 4 | 30.415984, 77.969231 | 14 m |
| 3rd And 4th Block | 2 | 30.416425, 77.968014 | 2 m |
| Energy Block | 2 | 30.416033, 77.966778 | 8 m |
| Aditya Block | 2 | 30.416895, 77.968128 | 0 m |
| 8th Block | 1 | 30.416234, 77.968741 | — |
| Sods | 1 | 30.417041, 77.968368 | — |
| Upes, Campus Food Court | 1 | 30.416454, 77.968390 | — |
| Porta | 1 | 30.416536, 77.969117 | — |

**These names are Google's, not UPES's.** They are a useful hint about which
building a photo was taken beside. They are **not** official signage, and
`CAMPUS-FIELD-COLLECTION.md` requires "names exactly as on official signage".
They should enter ECHO ECHO only as a `note`, never as a location's name.

One caption is plainly wrong: reading #112 geocodes to *"138/1new, Smith Nagar,
Prem Nagar, Dehradun"*, yet its coordinate sits in the middle of the campus
cluster and its photo shows a UPES building. The coordinate is trustworthy; the
label is not. That is the general rule here.

`Energy Block` is the one caption with independent support: OSM way 536452676
"Energy block, UPES" has centre 30.415935, 77.966974, about 30 m from this
cluster's centroid, and migration 016 already holds it as a pending location.

---

## 4. Names read off actual signage

These came from the photographs themselves — a signboard in frame, not a
geocoder guess. This is the only naming evidence that meets the standard in
`CAMPUS-FIELD-COLLECTION.md`.

| Sign as photographed | Photo | Lat, Lng |
|---|---|---|
| **Café Frisco** | `20260916_34420PM…` | 30.416223, 77.968012 |
| **Tulips CAFE** | `20260916_45232PM…` | 30.416383, 77.969702 |
| **MANAGEMENT DEVELOPMENT CENTRE** | `20260916_44011PM…` | 30.418251, 77.969181 |
| **GIRLS HOSTEL** | `20260916_44210PM…` | 30.418098, 77.969246 |
| **BOYS HOSTEL** | `20260916_45209PM…` | 30.416366, 77.969827 |
| **ENROLLMENT OFFICE** | `20260916_41027PM…` | 30.416529, 77.966459 |
| **THE HUDDLE** | `20260916_41105PM…` | 30.416423, 77.966492 |
| **Career Services** / *UPES 100% PLACEMENT* | `20260916_43138PM…` | 30.418386, 77.967602 |
| **DR. … CHOPRA CENTRE FOR LEARNING** | `20260916_52329PM…` | 30.417127, 77.968071 |
| **IT. DEP** (corridor sign) | `20260916_35929PM…` | 30.416305, 77.967379 |

Unnamed but identifiable: an auditorium interior (#036, #037), basketball and
volleyball courts and a large sports ground (#047–#068), a glass pyramid
building (#080), and shipping-container "Porta" cabins (#038, #039).

### The systematic caveat on every one of these

GPS Map Camera records **where the phone was**, not where the subject was. For
a door plate or a café counter shot from a few metres away that hardly matters.
For a building photographed across a lawn it matters a great deal — the Boys
Hostel gate in #089 is *far* from the camera, so 30.416366, 77.969827 is the
photographer's spot, not the gate.

`CAMPUS-FIELD-COLLECTION.md` is explicit: stand **at the place a partner would
hand food over**. None of these readings was taken that way. So every candidate
below is a *starting position to go back and re-measure*, not a delivery point.

---

## 5. The cafeterias

| Cafeteria | Found? | Evidence |
|---|---|---|
| **Frisco** | **Yes** | `20260916_34420PM…` — storefront, "Café Frisco" sign, menu boards, counter, staff and customers. 30.416223, 77.968012 |
| **Tulips** | **Yes** | `20260916_45232PM…` — storefront, "Tulips CAFE" sign with tulip-and-cup logo, full menu boards. 30.416383, 77.969702 |
| **Chai Garam** | **NOT CONFIRMED** | see below |

`20260916_35824PM…` (30.416359, 77.967536) shows a café storefront whose
illuminated sign begins **"CHA…"** — the remaining letters are hidden behind an
awning and foliage in every frame. Re-cropped at full resolution twice; still
not legible. Another word, "…VALLO", appears on a lower board.

**This is not enough to call it Chai Garam, so it is not being called Chai
Garam.** It is marked unresolved and excluded from the candidate file. One
clear photograph of that signboard settles it.

`Upes, Campus Food Court` (30.416454, 77.968390) appears only as a geocoder
label on a blurred ground shot — no storefront is visible, so it identifies no
cafeteria.

**No cafeteria pickup point can be set from this archive** to the standard the
product requires. Frisco and Tulips have a real image and a position within a
few metres; that is enough to *stage* them, not to make them deliverable.

---

## 6. Room numbering — the rule, implemented

**Resolved.** The convention is confirmed as three-part, read from the right:

```
<block><floor><room>
                └──── the last two digits are the room
         └─────────── the digit before them is the floor
└──────────────────── everything before that is the block
```

This is now implemented in `server/src/services/room-code.js`, with
`server/test/room-code.test.mjs` covering every worked example and a long list
of malformed inputs. Migration 021 adds `source_code`, `block_number`,
`floor_number` and `room_number` to `campus_node`.

A floor digit of `0` is stored as 0 and **deliberately not given a name**. The
observed ground-level plates all carry it, but nothing in the evidence says
what "0" is called, so the label omits it rather than inventing "Ground Floor".

### Every plate read, and what it parses to

| Code | Parses to | Photo | Status |
|---|---|---|---|
| `1001` | Block 1, Room 01 | `20260916_40045PM…` | confirmed |
| `1006` | Block 1, Room 06 | `20260916_35936PM…` | confirmed |
| `1104` | Block 1, Floor 1, Room 04 | `20260916_40428PM…` | confirmed |
| `2002` | Block 2, Room 02 | `20260916_34252PM…` | confirmed |
| `9204` | Block 9, Floor 2, Room 04 | `20260916_51117PM…` | confirmed |
| `11011` | Block 11, Room 11 | `20260916_45547PM…` | confirmed |
| `11012` | Block 11, Room 12 | `20260916_45543PM…` | confirmed |
| `11217` | Block 11, Floor 2, Room 17 | `20260916_50149PM…` | **confirmed** (upgraded) |
| `200?` | — refused, `not_digits` | `20260916_34241PM…` | **unresolved** |

`11217` was previously recorded as *probable*, read once at reduced
resolution. Cropping the caption band off that frame (§10) made the blue plate
legible: it reads **11217**. It is now confirmed. The same frame turned out to
show a laboratory notice bearing a staff member's **name, email address and
phone number**, which is recorded against that photo as a redaction
requirement.

The `200?` plate is on a roller shutter and its last digit is not legible. The
parser refuses it outright rather than picking a digit, and it stays out of
every derived file.

### What parsing still does not settle

Parsing is not verification. The parser turns a string into parts; it has no
opinion on whether the plate was read correctly, which building block 9 is, or
whether anybody may have food delivered there. Migration 016 already holds the
line that matters — `verification = 'confirmed' OR deliverable = false` — so a
room stays undeliverable until an administrator confirms it on site.


## 7. Block ↔ number mapping — not established

| Caption name | Room codes seen nearby | Implied block | Confirmed? |
|---|---|---|---|
| Main Block | 1001, 1006, 1104 | 1 | **No** — inferred from proximity only |
| Cx89+h43 (near 3rd/4th Block) | 2002 | 2 | **No** |
| New Porta | 9204 | 9 | **No** |
| Chitrakoot | 11011, 11012, 11217 | 11 | **No** |

Every one of these is "a plate was photographed a few metres from where the
caption said X". That is suggestive, not a mapping. No photograph shows a block
*name* and a block *number* together.

**Nothing here is strong enough to build the Campus → Zone → Block → Floor →
Room hierarchy.** What would settle it: the UPES estates or academic office's
block list, or photographs of the block identification boards at each entrance.

---

## 8. Data quality notes

- **Duplicate coordinates.** Four pairs share an identical fix — (40, 41),
  (64, 65), (75, 76), (109, 110). Consecutive shots seconds apart, so the
  receiver had not updated. Harmless, but they are not independent readings.
- **No accuracy figure.** GPS Map Camera stamps no horizontal accuracy, so
  `accuracy_m` is empty for every candidate. The importer will warn "no GPS
  accuracy recorded" on all of them — correctly. `assertDeliverable()` refuses
  live-location suggestions with no reported accuracy, and that protection must
  stay.
- **Many photos identify nothing.** A substantial share are blurred, or are
  shots of the ground, a ceiling, a wall or a shoe — accidental captures during
  the walk. They still carry a valid coordinate.
- **Privacy.** Numerous photos show **identifiable students and staff**,
  including close-up faces. Several show vehicle number plates. **None of these
  images may be published as campus artwork as-is.** Only crops with no
  identifiable person may be used, or fresh photographs taken for the purpose.
  This applies to the Frisco, Tulips and hostel images, all of which contain
  people.

---

## 9. What has NOT been done, deliberately

- No database mutation of any kind.
- No campus boundary confirmed, activated, replaced or proposed.
- No location created, and none made deliverable.
- **No room imported.** The parser now exists (§6), but parsing a plate and
  creating a destination are different things and only the first has happened.
- No cafeteria pickup point set.
- No image uploaded to storage (storage is not configured yet), and no
  derivative published.
- The archive was not modified, moved or committed.
- The catalog seed was not run.

### What was built

| | |
|---|---|
| `server/src/services/room-code.js` | the room-plate parser (§6) |
| `server/test/room-code.test.mjs` | 33 tests: every worked example, and every malformed form refused |
| `server/src/db/021_room_codes.sql` | `source_code`, `block_number`, `floor_number`, `room_number` on `campus_node`. Adds no rows |
| `docs/campus/bidholi-field-2026-09-evidence.csv` | all 114 frames with signage, status, confidence and publish-safety |
| `docs/campus/bidholi-campus-layer.draft.geojson` | the owned campus layer — every feature `DRAFT`, every one `deliverable: false` |
| `tools/campus-build-layer.mjs` | regenerates that layer from the committed CSVs |
| `tools/campus-import-dryrun.mjs` | offline dry run through the **existing** importer's parser |
| `tools/campus-photo-derivatives.py` | caption-band crop, metadata strip, resize |
| `tools/campus-field-verify.mjs` | re-checks all 114 SHA-256 against the archive |

No second importer was written. The existing admin importer
(`server/src/routes/geodata.js`) remains the only way anything reaches the
database, with its dry-run preview, duplicate detection, passkey requirement
and audit trail intact.

### Photo derivatives

44 frames that actually show something — signage, a door plate or an
identifiable subject — were processed into `campus-field/derivatives/`
(git-ignored): caption band cropped off, **all metadata stripped**, long edge
1600 px, JPEG q82. 814 MB becomes 10.4 MB.

Cropping the band is not cosmetic. Every original carries a Google Maps
thumbnail and a "Google" watermark, and publishing that as ECHO ECHO artwork
would be passing off someone else's branding.

**Every derivative is `publishable=no` and `needs_redaction_review=yes`.** No
face or number-plate detection was run — claiming otherwise would be the
dangerous kind of wrong, because somebody would publish believing the image had
been cleaned. The Frisco and Tulips frames both show identifiable customers;
frame 96 shows a staff member's name, email and phone on a lab notice.

---

## 10. What would actually unblock this

In the order that removes the most doubt per trip:

1. **Walk the perimeter** with a GPS logger, 1 s interval, one lap, export GPX.
   This is the only thing that can confirm the boundary and lift the
   fail-closed geofence. Everything else is cosmetic until this exists.
2. **Stand at each counter** — Frisco, Tulips, and whatever "CHA…" is — and
   record the position from Campus Control → *Use this phone's GPS here*, which
   stores accuracy and method properly.
3. **One clear photograph of the "CHA…" signboard** from an angle the awning
   does not block.
4. **The official block list** from the estates or academic office, so block
   numbers stop being inferred from proximity.
5. **The official UPES room list**, to check the parser against more than the
   nine plates photographed so far.
6. **Confirm the hostel delivery policy** before either hostel gate is made
   deliverable.
