# Launch readiness — final pass, 14 Oct 2026 (night)

Branch `launch-audit`, on top of `origin/main` `8f0bf1a` (still the live commit on Render
and Vercel). Earlier passes: `LAUNCH-AUDIT-2026-10-14.md`, `LAUNCH-READINESS-2026-10-14-FOLLOWUP.md`.

**Decision: READY FOR INTERNAL TESTING.** Not yet a controlled campus pilot. The code is
ready to deploy; the remaining blockers are approvals and owner-held resources, listed at
the end.

Statuses: FIXED & VERIFIED · BLOCKED BY OWNER/PROVIDER · NOT FIXED.

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
| Forged `X-Forwarded-For` bypasses per-IP OTP limits | FIXED (code), **BLOCKED BY OWNER** for production | edge limit + 10 tests; `render.yaml` declares `EDGE_CLIENT_IP_HEADER`. Live Render does **not** have it yet, and the code is not deployed: not active in production. |
| Backup workflow green with no backup | FIXED & VERIFIED (it now fails while unconfigured); backups themselves **BLOCKED BY OWNER** | no backup or restore has happened |
| fastify advisory | FIXED & VERIFIED | `npm audit`: 0 |
| No CSP | FIXED (report-only), enforcement **NOT FIXED** by design | 0 violations enforced in headless Chrome; needs real reports, incl. a production Cashfree checkout, before enforcing |
| Payout stuck in processing raised nothing | FIXED & VERIFIED | test; now also emails the owner |
| Owner email exposed on a public endpoint | FIXED & VERIFIED | test |
| No alerting | FIXED & VERIFIED for money and scheduler events (owner email); uptime **BLOCKED BY OWNER** | 5 tests; uptime needs an external monitor account |
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
1. **Approve the merge** of the PR for `launch-audit` (a merge to `main` auto-deploys Render and Vercel). No migration.
2. After the deploy: check `/health` (commit), `/ready`, and `/health/client` on both hosts (`cfConnectingIpPresent: true`).
3. **Set `EDGE_CLIENT_IP_HEADER=cf-connecting-ip` on Render**, then re-probe: forged `X-Forwarded-For` must hit 429 at the edge cap.
4. **Backups:** approve creating a private B2 bucket with a key restricted to it and a 30-day lifecycle, the 7 GitHub secrets, a first backup run and a restore drill into a throwaway database. The encryption passphrase must go into your password manager.
5. Admin passkey domain decision (section 3) and confirm you can sign in to Campus Control.
6. Render paid instance decision.
7. An external uptime monitor (free accounts exist) on `https://www.echoecho.tech/api/health/`.
8. Cashfree Payouts production activation (or a written manual payout process).
9. Enrol and train counter devices at both cafés.
10. Logo legal decision; Chai Garam pricing decision; print and scan one QR proof.
11. One small real order on your own account, refunded.

## 6. Rollback
No schema change. Vercel: promote the previous production deployment. Render: redeploy
`8f0bf1a`. Unsetting `EDGE_CLIENT_IP_HEADER` restores today's rate-limit keys without a deploy.
