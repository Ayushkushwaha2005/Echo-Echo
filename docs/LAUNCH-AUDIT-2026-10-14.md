# Launch-readiness audit — 14 Oct 2026

Branch `launch-audit`, cut from `main` at 8f0bf1a (the commit live on Render at the time of
the audit, per `/api/health`). Nothing here was deployed, no production setting was
changed, and no money moved.

## How it was checked

- Code read: order drafting, payment intent, webhook, partner offers, café hours, counter
  scoping, cookie/session config, OTP limits, logger redaction, build audit.
- Live, read-only (anonymous GETs only): `/api/health`, `/campuses`, `/vendors`, both menus,
  `/pricing/current`, `/partner/policy`, redirects and headers on `echoecho.tech`.
- The changed site in headless Chrome at 390×844 (iPhone, touch) and 1280×900, against
  the **production API through a read-only proxy** (writes refused by the proxy):
  38/38 checks (`scratchpad uicheck.mjs`: landing, prices, partner page, Back/Forward,
  deep links, overflow, console errors, 404).
- Not done: anything signed in on production (no test student account in prod, and
  signing in as a real student was out of scope), the Chrome extension was not connected,
  no payment was made, no physical QR print was scanned.

## Findings

### P0 — critical
None found.

### P1 — launch blockers
| # | Finding | State |
|---|---|---|
| 1 | `/payments/intent` did not re-check the café. A draft made at 5:59 PM, or before the counter's emergency stop, or before an item sold out, could still be paid and confirmed. | **Fixed** (`routes/payments.js`), 3 regression tests. |
| 2 | Browser Back left the site entirely (no history entries). On a phone this is the main way people navigate. | **Fixed**: every screen has a `#/…` URL; Back/Forward work; menus are linkable. |
| 3 | Partner payouts are not activated in Cashfree production (Request Activation pending). A partner earns but cannot withdraw. | **Owner** — activate Payouts, or decide a manual payout process before recruiting. |
| 4 | No database backups run: `db-backup.yml` has no B2 bucket/keys/passphrase. | **Owner** — create bucket + restricted key + passphrase; rely on Neon PITR until then and know its retention. |
| 5 | Someone must staff the counters and approve people: counter enrolment for Chai Garam and Tulips, and an admin who approves student verifications, partner applications and refunds. Admin setup was paused by the owner. | **Owner** — confirm both cafés have an enrolled counter device and an admin can sign in, before the first paid order. |

### P2 — important
| # | Finding | State |
|---|---|---|
| 6 | The ₹10 platform fee was a bare line in the bill. | **Fixed**: explained in the bill; landing page shows live fees from `/pricing/current` (₹10/order, ₹15 delivery, pickup no delivery fee, no COD). |
| 7 | Delivery offers showed the order total, not what the partner earns. | **Fixed**: offer carries `earning_paise` from the frozen order snapshot; shown as "You earn ₹X". |
| 8 | "Deliver with ECHO ECHO" was reachable only from the signed-in profile. | **Fixed**: public `#/deliver` page (live partner policy, real joining steps, "Sign in to apply"), plus entries on landing, home and footer. |
| 9 | `TRUST_PROXY=true` makes Fastify trust the left-most `X-Forwarded-For`. Calling the Render URL directly with a forged header gives a fresh IP per request, so per-IP limits (OTP send/verify) can be bypassed. Per-address and per-challenge limits in the database still hold. | **Open** — set a hop count that matches Vercel → Render, verified against real requests, rather than `true`. Not changed blind: a wrong count would put every student behind one IP and lock them all out. |
| 10 | Chai Garam items are board price + ₹10 (owner instruction, 27 Sep); Tulips items are board price. Both also pay the ₹10 platform fee. A student who knows the counter price will see the difference. | **Owner decision** — keep, disclose, or align. |
| 11 | No `robots.txt`, generic host 404, no description/canonical/social tags. | **Fixed** (build writes `robots.txt` and a branded `404.html`; `web/index.html` has description, canonical, Open Graph). |
| 12 | No Content-Security-Policy header. | Open — worth adding once the Cashfree SDK origins are confirmed. |

### P3 — polish
- No dish photos; tiles show monograms. Needs real photos from the cafés (none invented).
- Tulips drinks/desserts have `veg = unknown` (board doesn't say). Confirm with the café.
- The customer site uses an "E." mark; Counter/Campus Control use the `brand/logo.js` quad mark.
  No owner-approved logo file is in the repo. **Owner**: supply the final logo file; nothing
  was redesigned or replaced here.
- No Open Graph image (needs the approved logo/poster art).
- Payment confirmation uses the browser's native `confirm()` dialog. It works, but looks out of place.
- Draft orders accept any number of lines (each ≤ 20 qty). Worth a cap.

## Verified as sound (no change needed)
- Server prices every order from `menu_item`; client prices ignored; financial snapshot immutable (trigger).
- Webhook: HMAC over raw bytes, timestamp inside the signature with a skew window, idempotent on event id, amount and currency must equal the pinned amount.
- Only the webhook/status pull can confirm an order; state machine refuses illegal transitions.
- Order reads: customer, assigned partner, the café's own staff, or an auditing role, otherwise 403.
- Counter actions are scoped to the session's café ids server-side.
- Session cookie `httpOnly`, `SameSite=Lax`, `Secure` in production; state-changing requests must carry an allowed Origin.
- OTP: hashed codes, atomic attempt ceilings, resend cooldown, hourly/daily per-address caps; logger redacts codes, cookies, tokens, bank details.
- Live: HTTPS with HSTS (2 years), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`; `http://echoecho.tech` → `https://www.echoecho.tech/web/`.
- Café status comes from the server clock in IST; both cafés showed "Closed · opens tomorrow 8 AM" at 20:25 IST on a Wednesday, matching Mon–Sat 8–6.
- Menus live: Chai Garam 67 items / 10 sections; Tulips 24 items / 7 sections; all available, no photos.

## QR code
`brand/qr/` — encodes exactly `https://www.echoecho.tech/web/` (200, no redirect), error
correction H, 4-module quiet zone, SVG for print and PNG. Decoded by OpenCV at full size,
80 px, and as a rotated, blurred, low-contrast copy. **Not tested on a physical print.**
