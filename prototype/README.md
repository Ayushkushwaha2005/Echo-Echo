# Frisco — UI/UX System

The interface layer for the campus ordering roadmap. Four surfaces, one design
system, one data source.

## Run it

No build step, no dependencies. Serve the folder:

```
npx serve prototype          # or: python -m http.server 8000
```

Then open `index.html`. ES modules need a server — opening the file directly
from disk will fail on the import.

To rebuild the single-file version (`dist/frisco.html`, used for the shared
artifact) after changing any source file:

```
bash build.sh
```

## Structure

```
styles/tokens.css   colour, type, space, radius, elevation, motion — light + dark
styles/app.css      base + component library, reads tokens only
src/data.js         seed data shaped like the roadmap's tables
src/app.js          store, router, screens, the agent's parser
dist/frisco.html    generated single-file bundle
```

**The token rule:** `app.css` contains no raw colour values. Every component
reads `var(--…)`. Dark mode is a separate designed palette (warm charcoal,
surfaces climbing toward the rose, desaturated accent) — not an inversion. It
resolves in all three viewer states: explicit light, explicit dark, and the
unstamped system default.

**The data rule:** no screen hardcodes a cafeteria, item, location, price, fee
or payout. Adding a fourth outlet is a row in `CAFETERIAS` plus its menu rows.
No component changes.

## Identity

- **Display** — Bricolage Grotesque. Oversized, tight-tracked, used on poster
  surfaces and for money.
- **UI** — Manrope.
- **Labels/codes** — DM Mono, uppercase, wide-tracked.
- **Colour** — warm blush rose accent on cream, with warm near-black ink.
  Coral is the second accent and never appears beside rose. Semantic
  green/amber/red are separate from the brand and never double as the accent.
- **Campus motif** — a dotted survey grid behind poster surfaces, location
  glyphs, zone badges. Restrained: functional screens stay plain.

Poster treatment is confined to welcome, home hero, AI entry, café discovery
and empty states. Cart, checkout and tracking are deliberately quiet.

## Surfaces

| Surface | Routes | Character |
|---|---|---|
| Student | `welcome → ob-email → ob-otp → ob-profile → home → cafes → menu → cart → checkout → tracking` | Warm, poster-led, mobile-first |
| AI agent | `ai` | Native ordering surface, not a chat product |
| Partner | `p-home → p-offer → p-active → p-earnings / p-history` | Dark hero, huge targets, glanceable while walking |
| Counter | `staff` | Dense KOT cards, 4 tabs, two taps per state change |
| Admin | `admin` (5 tabs) | Same system, no enterprise template |

Everything connects. The role switcher in the top strip is demo scaffolding,
not product chrome.

## The agent

`parseOrder()` in `src/app.js` is a real parser, not a canned script:

- **Quantities** — digits and Hindi number words (`ek`, `do`, `teen`, `char`).
- **Items** — matched against `name` + `aliases[]` from the menu rows
  (`cc`, `thandi coffee`, `maggi`, `samose`). Longest match wins, so
  "cold coffee" beats "coffee".
- **Location** — resolved from the campus whitelist only.
- **Budget + mood** — `"₹150 ke andar kuch spicy"` → recommendation over items
  that are actually available right now.
- **Ambiguity** — the same dish on two counters asks exactly one question.
- **Off-campus** — refused before anything else runs.

### The payment boundary

The parser returns **item ids and quantities only**. `buildDraft()` — standing
in for the server — computes every rupee. `DraftCard()` is rendered by the app
from that draft, so the total the student sees is never text the model wrote.
Nothing is charged without a tap on `Online Pay` or `Cash`.

This mirrors roadmap §12–13: there is no `place_order` or `charge_payment` path
reachable from the agent.

## Campus boundary in the UI

There is no free-text address input anywhere in this codebase. Delivery
destinations come only from `LOCATIONS`. That matches the schema constraint in
roadmap §4 — off-campus delivery isn't hidden from the UI, it's unrepresentable
in the data model the UI speaks to.

## Not yet done

- Ported to React/Next components (this is framework-free by choice, so the
  system is portable and reviewable today).
- Real API calls — `data.js` stands in for the endpoints.
- Photography — items use glyph placeholders.
- Accessibility pass beyond focus states, roles, labels and reduced-motion.
