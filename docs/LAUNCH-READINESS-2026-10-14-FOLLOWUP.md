# Production readiness follow-up — 14 Oct 2026 (evening)

Follow-up to `docs/LAUNCH-AUDIT-2026-10-14.md`. Same branch, `launch-audit`.

## Decision: READY FOR INTERNAL TESTING — not yet a controlled campus pilot

The code on this branch is safe to deploy, and the full ordering journey works
end-to-end against Cashfree's sandbox. A pilot that takes real students' money
still depends on owner actions that no code can replace: backups, Payouts
activation, a staffed counter and admin, and a deploy. The list is under
"Owner actions", in order.

## 1. Verified state

| Fact | Evidence |
|---|---|
| Production API runs `8f0bf1a` | `GET https://www.echoecho.tech/api/health/` and `https://echo-echo-api.onrender.com/health` both return commit `8f0bf1a8…` |
| Production frontend is `8f0bf1a` | the live `/web/` page names asset folder `_v/ba2625472c1d`; a production build of `origin/main` produces the same folder |
| The brief's "live at 4dac720" is out of date | `4dac720` is an older `main`; `8f0bf1a` (#5) is live |
| `launch-audit` is `origin/main` + its own commits only | `git merge-base --is-ancestor origin/main launch-audit` succeeds; `main` has not moved since |
| Nothing pushed, merged or deployed | `git ls-remote origin launch-audit` is empty |

## 2. Findings (this pass)

### P1
| # | Finding | Evidence | Fix | Files |
|---|---|---|---|---|
| F1 | Per-IP limits on sign-in codes can be bypassed by forging `X-Forwarded-For`. | 14 Oct, live, non-student address (refused before any email or write): direct to Render, each forged `X-Forwarded-For` got a fresh bucket (`x-ratelimit-remaining` back to 119) while the unforged bucket kept counting down (117 → 116 → 115 → 114). Through Vercel, forged values sometimes reached the API (2 of 4 samples got fresh buckets), although Vercel documents that it overwrites the header. A forged `cf-connecting-ip` sent to Render was refused by Cloudflare with 403. | A second limit on the sign-in, OTP, enrolment, admin sign-in/reset and passkey routes, keyed on the address the edge vouches for (`EDGE_CLIENT_IP_HEADER`, i.e. `cf-connecting-ip`), at 5× each route's per-IP limit. With the header unset or absent it keys on `req.ip`, which is today's behaviour and never one shared bucket. **Not active in production until the owner sets the variable** (step 3 below). `TRUST_PROXY` was deliberately not changed: the hop count cannot be verified from outside, and a wrong count would put every student in one bucket. | `server/src/edge-limit.js`, `src/index.js`, `src/config.js`, the five route files, `test/edge-limit.test.mjs` |
| F2 | The nightly backup job is green every day and has never taken a backup. | `gh run list --workflow db-backup.yml`: daily "success" in 6–8 s; `gh secret list` shows only `RENDER_API_KEY`. The preflight skips with a warning when the 7 backup secrets are absent. | A **scheduled** run now fails while unconfigured, so GitHub's failure email is the alert. A manual run can still opt out. | `.github/workflows/db-backup.yml` |
| F3 | `fastify` 5.12.1 had a high-severity advisory (5 issues, including an auth bypass via malformed URLs reaching not-found handlers); `fast-uri` had a moderate one. | `npm audit --omit=dev` | Lockfile moved to `fastify` 5.12.7 and `fast-uri` 3.1.8 / 4.2.2, all within the declared semver ranges. `npm audit`: 0 vulnerabilities. | `server/package-lock.json` |

### P2
| # | Finding | Fix | Files |
|---|---|---|---|
| F4 | The site sent no Content-Security-Policy, and each page ran an inline script (the API base). | The API base moved to `config.js` beside each page; the policy is in `vercel.json` as **Report-Only**, with reports going to `POST /api/csp-report` (one log line: directive, blocked origin, page path). `tools/frontend-qa.mjs` now fails CI if shipped code uses an origin the policy does not allow, or has an inline script or unhashed inline handler. | `vercel.json`, `build.mjs`, `tests/helpers/surface-run.mjs`, `tools/frontend-qa.mjs`, `server/src/index.js` |
| F5 | A payout stuck in `processing` (an unknown provider outcome the status pull never resolved) raised nothing. | The operational detector raises it as a blocking `payout_mismatch` (existing kind, no migration) after 24 h, once, and never fails or resends it. | `server/src/services/reconciliation.js`, `test/marketplace.test.mjs` |
| F6 | `GET /auth/admin/status` (public) returned the owner's full email, which is the username of the most privileged account. | Now returns a hint (`a…@stu.upes.ac.in`). No UI used the full value. | `server/src/routes/admin-signin.js`, `test/admin-login.test.mjs` |
| F7 | `keep-warm` is scheduled every 10 min but GitHub runs it every few hours (latest gaps of about 4–6 h). It is the only uptime check, and there is no alerting on API errors, payment mismatches or stuck payouts beyond Render logs and the Campus Control exception list. | Open (owner): an external uptime monitor on `/api/health/` and a Render log alert for `csp violation`, `reconciliation differences`, `settlement scheduler failed`. | — |
| F8 | Dependabot alerts are disabled on the repository. | Open (owner): enable them in repo settings. | — |

Also added: a `Permissions-Policy` limited to what was verified (`geolocation=(self), microphone=(), usb=()`); `camera` is left alone because the photo and ID uploads use the phone camera and were not tested under a restriction.

## 3. Tests run (exact)

| What | Result |
|---|---|
| Server suite (`npm test`, real PostgreSQL) | see the commit message for the final count |
| New: `test/edge-limit.test.mjs` | 10/10. Proven to fail without the hook (the rotating-header test fails when the hook is unregistered). |
| Production builds (`/api` and `https://api.example.invalid`) | build audit passed |
| `tools/frontend-qa.mjs` | passed, including the new CSP check; a planted inline script, an inline handler and two unknown origins were all caught |
| `tests/bundle-smoke.mjs` | 3/3 surfaces execute |
| Headless Chrome, read-only proxy to the **production API**, policy **enforced** | 42/42: landing, prices, partner page, Back/Forward, deep links, overflow, 404; Leaflet + 12 map tiles (OSM, EOX) and the Cashfree SDK load; **0 CSP violations** |
| Headless Chrome, **local** API and DB, seeded test student, **Cashfree sandbox** | 22/22: home → café → menu → 2 items → cart; pickup bill ₹40 + ₹10 = ₹50; delivery bill ₹40 + ₹10 + ₹15 = ₹65; destination chosen; Back/Forward through checkout keeps the cart; the confirm dialog shows; the server creates a sandbox session for **its own** ₹65; the Cashfree sandbox checkout opens; paid with Cashfree's published test UPI; the server confirms from Cashfree's status (not the browser); tracking shows "Order confirmed". Ledger for that order: one `order_capture`, café ₹40, platform fee ₹10, delivery fee ₹15, partner earning ₹10. |
| Cashfree **Payouts sandbox** e2e | 20/21. The failing step: Cashfree's "timeout, later success" test account was still `PENDING` after 4 min. The payout correctly stayed `processing`, was not marked paid or failed, was not resent, and the balance stayed intact. It passed on 27 Sep; treated as sandbox timing and reported, not counted as a pass. |
| Cashfree **payments sandbox** e2e (`sandbox-e2e.mjs`) | **Not run**: needs a `cloudflared` tunnel for webhooks, not installed this session. The journey above covers success through the status pull; failure, retry and refund are covered by the suite and by the 27 Sep run (27/27). |
| Secret scan | tracked files and full history: no credential patterns (one match is a test fixture, `quadTestSecretKeyNotRealAtAll…`); every local secret file is gitignored; GitHub secret scanning: 0 alerts |

### Journeys covered by the API suite only (not driven in a browser this pass)
Café acceptance, preparation and handover codes; partner application, approval, offer acceptance, pickup and handoff (`e2e.test.mjs` FLOW A–D); counter isolation (`security.test.mjs`, `rbac.test.mjs`); admin verification and refunds (`trust.test.mjs`, `finance.test.mjs`); withdrawal states (`marketplace.test.mjs`). Nothing was signed in on production.

## 4. Money safety: where each rule is proven
- ₹10 once per order, pickup and delivery: `finance.test.mjs` ("a pickup order has no delivery money at all": food + platform fee only), `marketplace.test.mjs` ("₹100 food + ₹5 delivery + ₹10 platform fee charges exactly ₹115"), and the sandbox journey above.
- Delivery fee ≠ partner earning, both from the policy pinned to the order: `marketplace.test.mjs` ("₹15 earning from a ₹300 subtotal…"), and the offer now shows the earning (`e2e.test.mjs`).
- Duplicate or unknown outcomes: same event id, a fresh event id for the same payment, PENDING/FAILED/TERMINATED, an unreachable gateway, transfer timeouts, two refunds at once, double batch release, and payout retries under a new transfer id. Each is a named test in `payments*.test.mjs`, `finance.test.mjs`, `settlement.test.mjs`, `marketplace.test.mjs`.
- Payments off when unconfigured: `checkout returns 503 when no payment gateway is configured`; boot refuses partial production payment config.
- The café is re-checked at payment (earlier commit `6da3be5`).

## 5. Owner actions, in dependency order
1. **Approve the deploy** of `launch-audit` (push → PR → CI → merge; merge deploys). No migration is included.
2. Right after the deploy, check `https://echo-echo-api.onrender.com/health/client` and `https://www.echoecho.tech/api/health/client/`: both should show `cfConnectingIpPresent: true`.
3. **Set `EDGE_CLIENT_IP_HEADER=cf-connecting-ip` on Render** (a production config change). Trade-off: requests through Vercel carry Vercel's egress address in that header, so students arriving through the same egress share one edge bucket of 600 code sends per 10 min, ample for a pilot. Then add it to `render.yaml` (the config-safety test keeps that file equal to the live env).
4. **Backups**: create a private B2 bucket, a key restricted to it, a passphrase in your password manager, a 30-day lifecycle rule, and the 7 repository secrets named in `db-backup.yml`. Run the workflow by hand, see "Backup uploaded", then do the restore drill in `docs/BACKUP-RECOVERY.md` into a new Neon branch or a local database, never over production.
5. **Cashfree Payouts activation** in the production dashboard, or a written manual payout process, before recruiting partners.
6. **People**: confirm you can sign in to Campus Control (password + authenticator; recovery is `npm run admin:setup` from a machine with the production env, run by you); enrol one counter device at Chai Garam and one at Tulips, and walk each counter through accept → ready → pickup code once.
7. **Monitoring**: an uptime monitor on `/api/health/`, Render log alerts (see F7), and Dependabot alerts on.
8. **CSP**: after a week of `csp violation` logs, including one real Cashfree payment, change the header name in `vercel.json` from `Content-Security-Policy-Report-Only` to `Content-Security-Policy`.
9. **QR**: print one proof of `brand/qr/echoecho-web-qr.svg` at real size; scan it with an iPhone and an Android phone.
10. **Decisions**: Chai Garam's +₹10 menu prices; confirm Tulips' veg marks; supply the approved logo file.
11. **First real order**: one small real order on your own account, refunded through Campus Control. This is the step that moves real money, and it is yours.

## 6. Production verification and rollback

After deploying:
```
curl -s https://www.echoecho.tech/api/health/            # commit = the merged sha
curl -s https://www.echoecho.tech/api/health/client/      # no IPs; shows the header chain
curl -sI https://www.echoecho.tech/web/ | grep -i -e content-security -e permissions-policy
node tools/live-check.mjs https://www.echoecho.tech/api   # existing read-only checks
```
In a phone browser: landing → café → menu → Back (stays on the site) → a menu link opened directly.

Rollback: no schema change, so a code rollback is complete on its own. Vercel: promote the previous production deployment (Instant Rollback). Render: redeploy `8f0bf1a` from the Deploys list. Unsetting `EDGE_CLIENT_IP_HEADER` returns the limits to today's behaviour without a deploy.

## 7. Verified vs assumed vs owner-dependent
- **Verified here:** everything in sections 1, 3 and 4, and the live probe evidence in F1 and F2.
- **Assumed, not verified:** that Render keeps sending `cf-connecting-ip` to the app (step 2 verifies it); that the Cashfree production checkout modal needs only `*.cashfree.com` (hence report-only); Vercel's documented overwrite of `X-Forwarded-For` (contradicted by 2 of 4 samples; the fix does not rely on it).
- **Owner-dependent:** all of section 5.
