# Launch readiness — final pass, 14 Oct 2026 (night)

**Deployed.** PR #6 (`fe89fed`) and PR #7 (`b747055`) are on `main` and live: Render
`/health` reports `b7470550…`, `/ready` is ready with 30/30 migrations applied, and the
Vercel site serves the new build. Earlier passes: `LAUNCH-AUDIT-2026-10-14.md`,
`LAUNCH-READINESS-2026-10-14-FOLLOWUP.md`.

**Decision: READY FOR CONTROLLED CAMPUS PILOT — after the five owner items in section 5
marked (pilot gate).** The engineering side is done and verified in production; what
remains is physical (counters, admin sign-in domain), provider (Payouts activation) and
spending (instance plan) decisions, plus custody of the backup passphrase.

Statuses: FIXED & VERIFIED · BLOCKED BY OWNER/PROVIDER · NOT FIXED.

## 0. Production evidence (after deploy)
- `/health/client` on both hosts: `cfConnectingIpPresent: true`; after setting
  `EDGE_CLIENT_IP_HEADER=cf-connecting-ip` on Render (owner-approved), `edgeKeySource: "edge"`.
- Live probe, direct to Render, 640 sign-in-code requests each with a different forged
  `X-Forwarded-For` (non-student address, refused before any email or write): 600 × 400,
  then 429 from request 600; a brand-new forged address afterwards: 429. The site path
  (`www.echoecho.tech/api`) stayed 400. Before this deploy every forged header got a fresh bucket.
- Headless Chrome on **production** at 390×844 and 1280×900: site checks 42/42, logo checks
  36/36, **0 CSP violations** under the live report-only policy (Leaflet, OSM/EOX tiles and
  the Cashfree SDK load), 0 exceptions, favicons and `og-image.jpg` served as images.
- Live data: Chai Garam and Tulips, Mon–Sat 8 AM–6 PM, status from the server clock;
  pricing ₹10 platform fee, ₹15 delivery.
- Render logs, last 40 min after the deploys: 0 error-level lines.
- **Backups (owner-approved):** private B2 bucket `echo-echo-db-backups-c3f304` (SSE-B2,
  lifecycle 30 days then delete), key restricted to that bucket with list/read/write and no
  delete (a delete attempt was refused, 401); 7 repository secrets set from stdin. First run
  ([38604872460](https://github.com/Ayushkushwaha2005/Echo-Echo/actions/runs/38604872460)):
  dump of 77 tables, **restore drill into a throwaway PostgreSQL 18 matched**
  (schema_migration 30, app_user 6, food_order/payment/ledger_txn/order_financials 0),
  encrypted object `echoecho-2026-10-14T1714Z.dump.gpg` 75,352 bytes uploaded and verified.
  Locally, the passphrase in `deploy/.env.backup` decrypts it back to a valid 307,875-byte
  dump (`PGDMP`). The first attempt failed honestly on `pg_dump 17` vs **server 18.6**;
  fixed by PR #7.

## 1. Logo (FIXED & VERIFIED)
- Source: `C:\Users\ayush\Downloads\6.jpeg`, 1254×1254 JPEG, copied byte-for-byte to
  `brand/logo/echoecho-logo-original.jpeg` (sha256 `3bc55edaacc877a0…`, same as the source).
- `tools/logo-assets.py` derives every web file: resizes of the whole logo (320 / 640 WebP,
  1200×630 social image on the artwork's own cream), and resizes of one square crop (the
  chef's head and hat) for sizes where the whole logo is illegible: favicon.ico 16/32/48,
  favicon-32.png, icon-192.png, apple-touch-icon.png, 96 / 192 WebP marks. Nothing redrawn
  or recoloured; the original does not ship.
- Surfaces: student site header (mark + name), landing hero (whole logo), sign-in first step,
  footer, Ask ECHO ECHO avatar (replaced every "E."); Counter and Campus Control sign-in
  cards (whole logo) and rails (mark + name); branded 404; favicons; `og:image` /
  `twitter:image` (large card).
- Evidence: headless Chrome against the production build with the CSP **enforced**, at
  390×844 and 1280×900: 36/36 logo checks (every image loads, is square, has alt text, no
  overflow, no "E." left, icons served as images, 0 CSP violations, 0 exceptions) and the
  42/42 site checks. Screenshots were reviewed.
- Found on the way: staff sign-in email/password fields were invisible (FIXED & VERIFIED,
  borders ≥ 3:1 contrast); the runtime's "Try again" used an inline `onclick` the CSP would
  block (FIXED & VERIFIED; `frontend-qa` now checks markup generated in JS too).
- **Owner/legal decision:** the name "Echo Echo", the white robot and the green
  hourglass-in-a-circle emblem closely resemble Cartoon Network's *Ben 10* alien "Echo Echo"
  and its Omnitrix symbol. Implemented as approved; whether to use it publicly is a legal
  judgement for the owner. The poster QR stays plain on purpose: a logo over it lowers the
  scan margin.

## 2. Previous findings

| Finding | Status | Evidence |
|---|---|---|
| Café closed/paused or item sold out could still be paid | FIXED & VERIFIED | 3 tests (`payments.test.mjs`) |
| Back button left the site; no deep links | FIXED & VERIFIED | browser checks |
| Fee disclosure, partner discovery, SEO, robots, 404 | FIXED & VERIFIED | browser checks |
| Offers did not show the partner's earning | FIXED & VERIFIED | `e2e.test.mjs`; offer card "You earn ₹10" in the role journey |
| Forged `X-Forwarded-For` bypasses per-IP OTP limits | FIXED & VERIFIED | 10 tests; live probe in section 0 |
| Backups | FIXED & VERIFIED | real backup + restore drill, section 0; passphrase custody is the owner's (section 5) |
| fastify advisory | FIXED & VERIFIED | `npm audit`: 0 |
| No CSP | FIXED (report-only), enforcement **NOT FIXED** by design | 0 violations enforced in headless Chrome; needs real reports, incl. a production Cashfree checkout, before enforcing |
| Payout stuck in processing raised nothing | FIXED & VERIFIED | test; now also emails the owner |
| Owner email exposed on a public endpoint | FIXED & VERIFIED | test |
| No alerting | FIXED & VERIFIED for money, payout, reconciliation and scheduler events (owner email, 5 tests); backup failures alert via GitHub's failed-run email; uptime BLOCKED BY OWNER | an external monitor needs an account |
| Dependabot off | FIXED & VERIFIED | config file + alerts enabled (API 204) |
| Payouts not activated in Cashfree production | BLOCKED BY OWNER/PROVIDER | no production payout credentials exist; `PAYOUT_PROVIDER` unset on Render |
| Counter/admin staffing | BLOCKED BY OWNER | physical |
| Chai Garam +₹10 vs Tulips counter prices | BLOCKED BY OWNER (decision) | not changed; not disclosed in the UI |

## 3. New findings this pass

| Finding | Severity | Status |
|---|---|---|
| Admin passkeys are bound to `echo-echo-nu.vercel.app` (`WEBAUTHN_RP_ID`), but the site is `www.echoecho.tech`; `ADMIN_PASSKEY_REQUIRED=true`. Passkey steps cannot complete on www.echoecho.tech. | P1 | BLOCKED BY OWNER: use `https://echo-echo-nu.vercel.app/admin/` for Campus Control, or move the RP ID to `echoecho.tech` and re-enrol passkeys |
| Render free plan, one instance: sleeps after 15 min idle (cold start), in-memory rate limits reset on sleep, and the settlement / reconciliation / payout-sync scheduler only runs while awake | P1 for real money | BLOCKED BY OWNER (paid instance is a spending decision) |
| `keep-warm` is scheduled every 10 min but runs every few hours | P2 | Documented; now also checks `/ready` |

## 4. Tests run
- Server suite: **726/726** (`npm test`, real PostgreSQL).
- Production builds (`/api`, `https://api.example.invalid`), unset base rejected; `frontend-qa` passed (39 files); `bundle-smoke` 3/3; all workflows, `dependabot.yml` and `render.yaml` parse; `npm audit` 0.
- Browser, production build + read-only proxy to the live API: 42/42 site checks, 36/36 logo checks.
- Browser, **local** stack (local DB, Cashfree **sandbox**):
  - student journey 22/22 (earlier pass): menu → cart → pickup ₹50 / delivery ₹65 bills → checkout → sandbox payment → server-confirmed → tracking;
  - role journey 24/25: partner applies → **admin signs in with password + TOTP** → approves → partner online → order paid (sandbox) → counter A prepares → counter B cannot see or move it (403s) → offer shows "You earn ₹10" → counter pickup code → student delivery code → delivered → earning pending → admin refunds from the order. The failing check expected the refund to complete instantly; Cashfree's sandbox returned PENDING. The refund status sync then completed it (payment `refunded`, one ledger refund transaction). The script's duplicate-refund probe used a wrong URL and proves nothing; duplicate refunds are covered by `finance.test.mjs`.
  - Not exercised in a browser: student email OTP delivery (needs a real mailbox), admin passkeys, ID-card upload.
- Cashfree Payouts sandbox (earlier pass): 20/21. The "timeout, later success" account stayed PENDING; nothing was resent or marked paid.

## 5. Owner actions, in order
1. **(pilot gate) Move `BACKUP_PASSPHRASE` from `deploy/.env.backup` into your password manager**, then keep a second copy offline. Without it no backup can be decrypted.
2. **(pilot gate) Campus Control access:** sign in at `https://echo-echo-nu.vercel.app/admin/` (the passkey domain), or move `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGINS` to `echoecho.tech` and re-enrol passkeys. Confirm you can approve a partner and issue a refund.
3. **(pilot gate) Counters:** enrol one device at Chai Garam and one at Tulips; walk each through accept → ready → pickup code once.
4. **(pilot gate) Render instance:** the free plan sleeps after 15 min (cold starts, Cashfree webhooks arriving during a cold start, scheduler paused while asleep). A paid instance is a spending decision.
5. **(pilot gate) One small real order** on your own account, refunded from Campus Control.
6. Cashfree Payouts production activation, or a written manual payout process (`PAYOUT_PROVIDER` is unset; earnings are recorded and owed).
7. External uptime monitor on `https://www.echoecho.tech/api/health/` (a free account suffices).
8. After a week of `csp violation` logs including one real Cashfree checkout, switch `vercel.json` to the enforcing header.
9. Logo legal decision (section 1); Chai Garam +₹10 pricing decision; confirm Tulips veg marks.
10. Print one QR proof at real size and scan it with an iPhone and an Android phone.

## 6. Rollback
No schema change. Vercel: promote the previous production deployment. Render: redeploy
`8f0bf1a`. Unsetting `EDGE_CLIENT_IP_HEADER` on Render restores the old rate-limit keys.
Backups: the B2 bucket and key can be removed from the B2 console; the GitHub secrets from
Settings > Secrets.
