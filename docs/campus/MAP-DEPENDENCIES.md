# Map and Google dependencies — audit, 18 September 2026

Result of grepping the whole repository (excluding `node_modules` and build
output) for `google`, `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_PLATFORM_KEY`,
`mapbox`, `leaflet`, `openstreetmap`, `geocod`, Places and Directions.

## There is no Google Maps dependency, and there never was

| Looked for | Found |
|---|---|
| `GOOGLE_MAPS_API_KEY` / `GOOGLE_MAPS_PLATFORM_KEY` | **none** — not in any source file, config, env template or migration |
| Google Maps JS SDK, Maps Embed, Static Maps | **none** |
| Google Geocoding / Places / Directions / Distance Matrix | **none** |
| Any map-related key on the production boot guard | **none** — `assertBootable()` in `server/src/config.js` has no map requirement |

**Nothing needs to be removed.** There is no Google Maps API key to strip out,
no SDK to unload and no boot requirement to relax. Part 12 of the brief is
satisfied by the code as it already stands.

## What the campus map actually is

`packages/ui/map.js` — **Leaflet 1.9.4 + OpenStreetMap raster tiles**. No API
key, no billing account, no account of any kind. OSM tiles are used under the
Open Database Licence with the required attribution rendered on the map.

Its design already matches what Part 11 asks for:

- The map draws **only what the server sent**. It holds no coordinates of its
  own and never invents one.
- A cafeteria or destination with **no surveyed position is absent from the
  map**, and the screen says so in words rather than dropping a fake pin.
- If the CDN is unreachable the map **degrades to a plain list** of the same
  places.
- It is a **destination-selection map, not navigation.** Walking times come
  from `walkEstimate` — straight-line distance × 1.25–1.6, at 65–80 m/min,
  plus 2–4 min hand-over — and are shown as a range ("Approx. 5–8 min"). No
  routing service is called and none is implied.

Only one screen uses it: `web/src/app.js:1072`, dynamically imported for order
tracking.

## Google services that ARE present, and are unrelated to maps

| Where | What | Keep? |
|---|---|---|
| `web/`, `admin/`, `shop/`, `prototype/` `index.html` | **Google Fonts** stylesheet (`fonts.googleapis.com`) for Bricolage Grotesque, Manrope, DM Mono | **Keep** — typography, nothing to do with maps |
| `server/src/services/admin-auth.js` | A code comment naming **Google Authenticator** as one of the TOTP apps that work | **Keep** — a comment |
| `server/src/services/verification.js` | **Google Cloud Vision** as an optional OCR provider for student-ID review (`OCR_PROVIDER=gcv`, `GCV_API_KEY`) | **Keep** — genuinely used, and optional |

Google Cloud Vision is worth being precise about, because it is the one real
Google *API* in the product: it is **not** required to boot. With no OCR
provider configured, `runOcr()` returns `status: 'skipped'`, the pipeline
records the skip, and the case is pushed toward manual admin review. Boot
emits a warning only:

> No OCR provider — ID submissions go straight to manual admin review.

That is a safe default and it is unrelated to campus mapping, so it stays.

## The two real dependencies the campus map does have

Neither is Google, and neither blocks anything today, but both should be
understood before the map is called "owned":

1. **Leaflet is fetched from `cdnjs.cloudflare.com` at runtime**, not bundled.
   If that CDN is blocked the map falls back to a list. Self-hosting Leaflet
   would remove the third party entirely.
2. **Tiles come from `tile.openstreetmap.org`.** The OSM Foundation's tile
   usage policy is not intended to carry production application traffic. At
   ECHO ECHO's current scale this is not a problem; before any real volume it
   should move to self-hosted or licensed tiles, or to a locally drawn campus
   vector layer.

Doing either of those is a deliberate change to a frontend that is already
approved and live, so neither was touched.

## One thing to be careful of

The photo archive's caption bars were produced by **GPS Map Camera**, which
composites a small **Google Maps thumbnail with a "Google" watermark** into the
bottom-left of every image (see `BIDHOLI-FIELD-REPORT.md`). Those photographs
are therefore **not usable as campus map artwork**, independently of the
privacy problem that they show identifiable people. They are evidence for
coordinates, nothing more.
