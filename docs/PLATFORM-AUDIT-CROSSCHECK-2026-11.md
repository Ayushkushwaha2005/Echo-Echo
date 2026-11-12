# Platform audit cross-check, November 2026

**Date:** 12 November 2026. **Repository:** `Ayushkushwaha2005/Echo-Echo`, production `main` = `29553ef`, work on branch `cashfree-retirement`.
**Scope:** every topic of the 31 October 2026 "Platform Audit & Production Readiness" report, re-checked against the code, the tests that actually ran today, and read-only observations of production. The active payment provider (its adapter, configuration, credentials, dashboard and tests) was **out of scope by instruction** and was not inspected, run or changed; where a topic touches it, the row says so and is marked NOT APPLICABLE or NOT VERIFIED.

## How to read this

**Source of the previous claims.** The 31 October report itself is not in the repository, and the text supplied with this task did not include its body. Its findings survive as the per-finding matrix in `docs/NON-PAYMENT-REMEDIATION-REPORT.md` (45 findings: 1A to 7E and S1 to S19, with the statuses the remediation branch claimed on 2 and 3 November) and `docs/SECURITY-HARDENING.md`. Those are the "previous audit status" columns below. Where a topic in the task's list of 19 has no finding in that matrix, the previous status is given as "not stated".

**Evidence labels**, one per claim:

| Label | Meaning |
|---|---|
| **Prod (read-only)** | Observed today on `www.echoecho.tech`, the public API or the Render/GitHub APIs, without changing anything |
| **Test (ran today)** | The named test file ran on this machine today, against the embedded PostgreSQL, and passed unless stated |
| **CI (main)** | GitHub Actions on `main` at `29553ef` on 11 November 2026: jobs `build`, `test`, `browser`, `rehearsal`, `workflows` all succeeded |
| **Code** | Read in source today; not executed |
| **Not verified** | Could not be checked from here; the reason is given |

A passing suite is not a working feature. A row says VERIFIED WORKING only when the complete journey has run, in a real browser or in production, and the evidence is named.

**Statuses used:** VERIFIED WORKING · IMPLEMENTED BUT NOT VERIFIED · PARTIALLY WORKING · NOT IMPLEMENTED · FAILED · BLOCKED · NOT APPLICABLE.

---

## 1. Current architecture

| Previous claim | Current evidence | Status |
|---|---|---|
| Fastify API on Render, Vercel static front ends (student `/web/`, Campus Control `/admin/`, Counter), Neon PostgreSQL, same-origin `/api` rewrite | **Prod:** `GET /health` → `{ok:true, commit:"29553ef…"}` in 0.95 s; `GET /ready` → `ready:true, migrations applied 42, latest 042_rollback_and_privacy_lifecycle.sql, pending []`; apex `308 → https://www.echoecho.tech/`, root `307 → /web/`. **Prod:** Render service `echo-echo-api`, plan `free`, region `virginia`, branch `main`, **autoDeploy `no`**. **Code:** 32 route modules, 46 services, 42 forward-only migrations. | VERIFIED WORKING |
| Payment architecture: one shared pipeline, independent provider adapters, `applyOutcome()` the only writer of `paid` | **Code:** `providers/index.js` registry; `routes/payments.js` resolves adapters by payment row. After today's change the registry holds one retired adapter and one active one. The active adapter was not inspected. | IMPLEMENTED BUT NOT VERIFIED (active provider out of scope) |
| Free Render instance sleeps; keep-warm cron | **Prod:** `keep-warm` workflow ran 02:29 UTC today, success; cold `/health` 0.95 s, warm `/ready` 0.37 s. The instance is still the free plan. | PARTIALLY WORKING (sleeps between runs, by design of the plan) |

## 2. Feature implementation status

Totals from the remediation matrix claimed 27 complete, 9 partial, 9 blocked of 45. Re-checked per topic in sections 3 to 19; the roll-up is in section 20.

## 3. Admin portal (Campus Control)

| Previous claim | Current evidence | Status |
|---|---|---|
| 1B: every page opens signed in, no server error, accessible, 390 px | **CI (main):** `modules.spec` ("every page: opens signed in, its API calls succeed, nothing is blocked, fits a phone, accessible", driven from the app's own page list), `admin.spec` (invitation, sessions, permissions, audit log, live map, approvals, stale form, no sideways scroll, axe). **Prod:** `/admin/` serves with an **enforced** CSP header. Signed-in production check: **not verified** (no administrator session is available to this work, by design). | VERIFIED WORKING in CI; IMPLEMENTED BUT NOT VERIFIED on production |
| Admin sign-in: email, password, authenticator; passkeys legacy | **Prod:** `/auth/status` → `admin_passkeys.required true, configured true, rpId "echo-echo-nu.vercel.app"`. **Code:** `routes/admin-signin.js`, `passkeys.js` (routes still registered: S13 remains PARTIAL). **Test (ran today):** `auth` group (`admin-login`, `passkeys`, `admin-access`, `admin-invitation` 21). | VERIFIED WORKING (tests); rpId still the Vercel alias, see S2 |
| Finance screens: payments, settlement centre, reports | **Test (ran today):** `admin-ops` 10 (payments filters, masked phone, fee, settlement CSV), `finance` group, `settlement.test` 34. **Prod:** not exercised (needs a signed-in administrator). The Payments filter now labels historical rows "Cashfree (retired)". | IMPLEMENTED BUT NOT VERIFIED on production |

## 4. Live data synchronisation

| Previous claim | Current evidence | Status |
|---|---|---|
| 1D: change feed, polling fallback, stream reconnect; streams off on the free instance | **CI (main):** `live-resilience.spec` (polling updates an open admin page, café list and menu; a cut stream reconnects and is told what it missed). **Test (ran today):** `live-sync` 3, `api` 39. **Code:** `routes/live.js`, `live-stream.js`, `services/live.js`. **Prod:** streams remain off (free instance), so the sub-5-second claim depends on polling intervals. | VERIFIED WORKING (polling); PARTIALLY WORKING (streaming off by decision) |

## 5. Employee invitation and access management

| Previous claim | Current evidence | Status |
|---|---|---|
| 2A COMPLETE, S1 COMPLETE: invitation link + code + review + password + authenticator, revoke, resend, expiry | **Test (ran today):** `admin-invitation.test` 21, `admin-access.test`. **CI (main):** `admin.spec` "employee invitation, in a browser: link, code, review, password, authenticator, then real sign-in"; "a used invitation link says so plainly". **Prod:** real inbox delivery not provable from here; the owner's own test invitation is the only proof and is not on record. | VERIFIED WORKING in CI; real-inbox delivery NOT VERIFIED |
| 2B permissions: route-permission matrix | **Test (ran today):** `route-permissions` 4 (asks Fastify for every route; passes with the two Easy Split routes still registered). | VERIFIED WORKING |
| 2C sessions, idle timeout (S18) | **Test (ran today):** `remediation` ("sessions show last activity…", "an idle administrator session ends…"). **CI (main):** `admin.spec` sessions journey. | VERIFIED WORKING |
| 2D owner recovery (S4 partial) | **Test (ran today):** `remediation` recovery tests; **CI (main):** "a lost authenticator…" journey. **Prod:** `PLATFORM_OWNER_EMAIL` is set; whether it is still a student mailbox was not read. | VERIFIED WORKING (mechanism); S4 owner-address question NOT VERIFIED |

## 6. High-risk approval system

| Previous claim | Current evidence | Status |
|---|---|---|
| 3 / S6 PARTIAL: café archive and website publish wired, off by default; self-decision refused by route and DB; payment actions excluded | **Test (ran today):** `remediation` approval tests (queued archive runs once; self-decision refused by route and database; payload frozen; expiry; precondition re-check; duplicate key and simultaneous approvals execute once; owner-only policy). **CI (main):** `admin.spec` approvals screen. **Code:** no payout, refund or pricing action is behind an approval; a second approver for the owner does not exist. | PARTIALLY WORKING (as previously stated; nothing changed) |

## 7. Payment gateway architecture — Cashfree retirement only

| Item | Evidence | Status |
|---|---|---|
| Cashfree retired from active operation | `docs/CASHFREE-RETIREMENT.md`. **Test (ran today):** `cashfree-retirement` 13/13, `providers-isolation` 8/8, `config-safety` 10/10, `settlement.test` 34/34. Production build: `cashfree` occurs 0 times in the student bundle; `frontend-qa`, `bundle-smoke`, `asset-version`, `media-paths` pass. | VERIFIED WORKING (locally and in the build; deploys with the branch) |
| Historical Cashfree data preserved | No migration, no delete, no rewrite; fixtures with `provider='cashfree'` rows pass (`admin-ops`, `alerts`, `tulips-name`); `/admin/payments?provider=cashfree` lists them (test). | VERIFIED WORKING |
| Production still carries Cashfree variables | **Prod (Render API, names only):** `CASHFREE_EASY_SPLIT`, `CASHFREE_PG_APP_ID`, `CASHFREE_PG_NOTIFY_URL`, `CASHFREE_PG_RETURN_URL`, `CASHFREE_PG_SECRET_KEY` are set. The retired build ignores them and warns at boot. Live Vercel CSP still allows `sdk.cashfree.com` until deploy. | BLOCKED on owner (delete the variables; deploy the branch) |
| Anything about the active provider | Not inspected, not run, not changed. | NOT APPLICABLE (out of scope) |

## 8. Chai Garam integration

| Previous claim | Current evidence | Status |
|---|---|---|
| Chai Garam onboarded as a café with its menu and photo | **Prod (public API):** `/vendors` lists `Chai Garam` (`chai-garam`, accepting, hours **00:00–23:59**) and `Tulips` (`tulips`, accepting, 08:00–18:00). `/vendors/:id/menu`: Chai Garam 67 items, all available; Tulips 24. **CI (main):** `home-cafes.spec` "the real Chai Garam slug shows its campus photograph". **Code/docs:** `docs/cafes/chai-garam-menu-2026-09-27.md`. Dish photos: the public menu payload exposes no photo field for either café in the fields checked. | VERIFIED WORKING (listing and menu); photos NOT VERIFIED |
| Hours | Chai Garam's 00:00–23:59 is the temporary all-day override the owner asked for during live payment testing (11 Nov). It has **not been restored** to its normal hours; a third café, Frisco, is not in the public listing (archived or inactive). | PARTIALLY WORKING — owner to restore hours |
| Counter (café) app for Chai Garam | **CI (main):** `public.spec` "Counter shows a first name and status for an order on its way, and no coordinates". Café staff sign-in on production: not verified. | IMPLEMENTED BUT NOT VERIFIED on production |

## 9. Payment allocation and settlement architecture

| Previous claim | Current evidence | Status |
|---|---|---|
| Double-entry ledger, frozen per-order pricing snapshot, café payable, partner earning on verified handoff, platform revenue, gateway fee only from provider data | **Test (ran today):** `settlement.test` 34, `finance` group, `handover.test` ("the customer code delivers the order and earns the partner their money"), `trust.test` (deposit is its own ledger account; ledger balances). **Code:** `services/ledger.js`, `pricing.js`, `settlement.js`, `payouts.js`. | VERIFIED WORKING (tests) |
| Settlement reconciliation importer (fees from the provider's report, exceptions, scheduled window) | **Code:** `services/reconciliation.js` unchanged. **Tests:** the suite that exercised it end to end (`reconciliation.test`, 38) was Cashfree-driven and was **deleted** with the retirement. Remaining coverage: `providers-isolation` (a scheduled run completes, one import row) and the active provider's suite, which was not run or read. | IMPLEMENTED BUT NOT VERIFIED — **coverage regression, HIGH** |
| Payout rails: manual bank transfer recorded by reference; provider payouts | **Prod:** `payouts.provider null, configured false, manualAvailable true`. **Test (ran today):** `settlement.test` (manual record, batches, approve/release, retry; a retired provider sends nothing). Partner withdrawal through a payout provider and destination-change hold were covered only by the deleted `marketplace.test`. | PARTIALLY WORKING (manual rail tested; provider rail untested and unconfigured) |
| Daily settlement centre | **Test (ran today):** `admin-ops` 10 (settlement CSV), `finance` group. | IMPLEMENTED BUT NOT VERIFIED on production |

## 10. GST and tax compliance

| Previous claim | Current evidence | Status |
|---|---|---|
| not stated as complete | **Code:** `pricing_policy.tax_bps` exists (`004_finance_ledger.sql`, default 0); `pricing.js` computes `tax_payable_paise` into the snapshot and `ledger.js` posts it to `tax_payable`. **No** GSTIN capture, HSN/SAC codes, tax invoice generation, GST return export or café-wise GST reporting exists anywhere in `server/src` (grep for `gstin`, `hsn`, `invoice`: none). `docs/FINANCE.md` mentions tax only as a ledger line. The live policy rate was not read from production. | NOT IMPLEMENTED (beyond a configurable tax line in the ledger) — needs an accountant's decision before any build |

## 11. Live delivery tracking

| Previous claim | Current evidence | Status |
|---|---|---|
| 4A–4E COMPLETE: consent to share, position only while carrying, customer sees it from `picked_up`, deleted with the state change, age on the server clock | **Test (ran today):** `tracking-privacy` 14, `position-share` 16, `remediation` location tests. **CI (main):** `devices.spec` (emulated Pixel and iPhone: sharing starts, moving position followed, network drop recovers, hidden screen keeps one watch), `flows.spec` "a delivery from offer to handoff… the position is gone", `public.spec` partner consent and GPS-denied journeys. **Code:** `routes/tracking.js`, `services/partner-location.js`. | VERIFIED WORKING in CI with emulated devices |
| 4H real devices | `docs/DELIVERY-TRACKING.md` checklist is still "NOT DONE". No physical phone run is on record. | BLOCKED on the owner (two phones) |
| 4F streaming | Off on the free instance; polling proved. | PARTIALLY WORKING by decision |

## 12. Delivery privacy and security

| Previous claim | Current evidence | Status |
|---|---|---|
| S9 COMPLETE: coordinates need `delivery.track`; views audited; café sees status and first name only; no trail | **Test (ran today):** `remediation` ("orders.view alone gets no coordinates; delivery.track does, and that view is audited", "cafe staff get status and a first name, never a position", "data export holds… no other person, secret or position"). **CI (main):** `admin.spec` live map with and without `delivery.track`. **Code:** `partner_location` is one row per partner, replaced in place, deleted at the end of carrying; audit of position views throttled to one row per 5 minutes per administrator and order. | VERIFIED WORKING |
| Stale GPS, spoofing | **Code/Test:** fixes older than 120 s or more than 60 s ahead refused; accuracy over 2000 m refused; more than 15 km from the pickup refused; out-of-order fix refused (409); 20 reports per minute per partner. No cross-check against movement speed or device attestation exists, so a plausible fabricated position inside those bounds is accepted. | PARTIALLY WORKING (bounds, not spoof-proof; see delivery report) |

## 13. Route and ETA

| Previous claim | Current evidence | Status |
|---|---|---|
| 4G "COMPLETE: browser; calibration needs real deliveries" | **Docs/Code:** `DELIVERY-TRACKING.md` §"Routes and arrival times": the map draws a **direct line and says it is not a route**; **no arrival time is shown**. No routing engine, path graph or ETA model exists in `server/src` or `web/src`. The previous "COMPLETE" described the honest placeholder, not a route or an ETA. | NOT IMPLEMENTED (route and ETA); the placeholder and its wording are VERIFIED WORKING in CI (`public.spec` "the page says it is not a live promise") |

## 14. Security audit, S1 to S19

| ID | Previous | Today | Status |
|---|---|---|---|
| S1 invitation code enforced | COMPLETE | `admin-invitation` 21 ran today; browser journey in CI | VERIFIED WORKING |
| S2 admin on its own host | BLOCKED | **Prod:** `rpId` is still `echo-echo-nu.vercel.app`; Campus Control is still a path of the student origin | BLOCKED on owner (DNS, Vercel) |
| S3 CSP enforced | PARTIAL | **Prod:** `/admin/` sends an enforced `Content-Security-Policy`; `/web/` sends **Report-Only** only. Live headers still allow `sdk.cashfree.com` until this branch deploys. The student-site enforcement was deferred "until checkout can be tested"; checkout has since been exercised live by the owner (11 Nov) | PARTIALLY WORKING — enforcing the student policy is now unblocked and not done |
| S4 owner recovery address | PARTIAL | Mechanism tested; whether the owner identity is still a student mailbox was not read | NOT VERIFIED |
| S5 exposed authenticator secret | BLOCKED | Owner action in My Profile; no record it was done | BLOCKED on owner |
| S6 high-risk approvals | PARTIAL | §6 | PARTIALLY WORKING |
| S7 branch protection | BLOCKED | **Prod (GitHub API):** `main` is **not protected** | BLOCKED on owner |
| S8 transactional audit | PARTIAL | 44 non-payment routes atomic (`audit-completion` 14, `remediation` ran today); finance, wallet, payment, refund routes still best-effort | PARTIALLY WORKING |
| S9 coordinates via `orders.view` | COMPLETE | §12 | VERIFIED WORKING |
| S10 database roles | PARTIAL | `db-roles` 3 ran today against a throwaway database; whether production's `DATABASE_URL` uses the reduced role cannot be told from here | NOT VERIFIED |
| S11 plaintext secrets on the PC | BLOCKED | Still present: `server/.env.production` and `server/.env.sandbox` hold Cashfree credentials in plain text (git-ignored; contents not reproduced). `deploy/.env.providers` holds a Render API key used read-only today | BLOCKED on owner (delete / password manager) |
| S12 forged X-Forwarded-For | COMPLETE | `edge-limit` 10 ran today; **Prod:** `EDGE_CLIENT_IP_HEADER` and `TRUST_PROXY` are set on the service | VERIFIED WORKING |
| S13 legacy passkey path | PARTIAL | Routes `/auth/passkey/*` still registered; `WEBAUTHN_*` set in production | PARTIALLY WORKING (unchanged) |
| S14 public `/ready` | COMPLETE | **Prod:** `/ready` shows database, migration and data booleans and the latest migration name; no provider or pool detail | VERIFIED WORKING |
| S15 dependencies | COMPLETE | `npm audit --omit=dev`: 0 vulnerabilities; GitHub Dependabot open alerts: 0; **Dependabot PR #35** (fastify group) is open and unmerged | VERIFIED WORKING, one routine update pending |
| S16 upload re-encoding | COMPLETE | `remediation` upload tests ran today; `rehearsal` job proves `sharp` in the production image (CI main) | VERIFIED WORKING |
| S17 request ids | COMPLETE | `remediation` ran today | VERIFIED WORKING |
| S18 session timeout | COMPLETE | `remediation` ran today | VERIFIED WORKING |
| S19 auto-deploy mismatch | BLOCKED | **Prod (Render API):** `autoDeploy: no`, trigger `off`; deploys come from the `deploy` workflow after CI (last 11 Nov 17:44 UTC, success) | VERIFIED WORKING — **resolved since the previous audit** |

Additional security observations today: the Cashfree retirement removed a live-credential-bearing code path (PG secret used for both API and webhook verification) from the server; the production Cashfree secret remains set on the Render service and should be deleted; the staging service was left without any payment credentials.

## 15. Testing and test coverage

| Item | Evidence |
|---|---|
| Server suite, this branch, run today one group at a time (`TEST_PG_PORT=56432`), excluding the active provider's own test file by instruction | **See the run record below** |
| CI on `main` at `29553ef` | `build`, `test`, `browser`, `rehearsal`, `workflows`: all success (11 Nov 2026) |
| Browser journeys | 10 spec files, 48 journeys listed in §"Browser journeys" of `docs/TEST-RESULTS.md`; run in CI only (not run locally today) |
| Deleted today | `payments-cashfree` (37), `marketplace` (27), `reconciliation` (38): Cashfree-driven. Added: `cashfree-retirement` (13). Net change in test count: −89 |
| Not run today | `payments-razorpay.test.mjs` (instruction); browser journeys (CI only); release rehearsal (CI only) |

Run record (this branch, 12 November 2026):

```
Groups run in sequence: unit integration api e2e security enrolment auth handover trust finance settlement storage campus config schema persistence, then payments.test, cashfree-retirement, providers-isolation.
69 distinct test files, 946 tests passed, 0 failed (four files matched two group selectors and ran twice; their repeat runs also passed: 1021 passes in 73 file runs).
Not run: test/payments-razorpay.test.mjs (instruction). Exit code 0.
Earlier the same day, one suite at a time: cashfree-retirement 13/13, providers-isolation 8/8, config 59/59, settlement.test 34/34, security 61/61, admin-ops 10/10, tulips-name 4/4, route-permissions 4/4.
Front end: QUAD_API_BASE=/api node build.mjs --production (built), tools/frontend-qa.mjs passed (257 files), tests/bundle-smoke.mjs, tests/asset-version.mjs, tests/media-paths.mjs passed; 'cashfree' occurs 0 times in the built student bundle.
npm audit --omit=dev (server): 0 vulnerabilities.
```

## 16. Performance and load testing

| Previous claim | Current evidence | Status |
|---|---|---|
| 7B PARTIAL: local peak figures only | `docs/TEST-RESULTS.md`: 500 pages / 60 s p95 3.9 ms locally; 100 kitchen moves p95 14.5 ms; nothing measured on real hosting. Nothing new ran today. **Prod:** cold `/health` 0.95 s, warm `/ready` 0.37 s from this machine, single requests. | PARTIALLY WORKING — no production load figure exists |

## 17. Implementation roadmap

The previous roadmap items that remain open, in priority order, are collected in §21. No roadmap item was closed today other than S19 (owner) and the Cashfree retirement.

## 18. Production blockers and risks

See §21. New since the previous audit: the finance-engine coverage regression (§9), the still-open student-site CSP (§14 S3), the unrestored Chai Garam hours (§8), and the Cashfree variables and files left on the production service and the owner's PC (§7, S11).

## 19. Deployment and rollback strategy

| Previous claim | Current evidence | Status |
|---|---|---|
| Deploy by GitHub workflow after CI on `main`; Render auto-deploy off; rollback = redeploy previous Render deploy; migrations forward-only | **Prod:** `deploy` workflow (`workflow_run` after `ci`, or manual) succeeded 11 Nov; Render `autoDeploy: no`. **Docs:** `DEPLOY.md` §Rollback, `RUNBOOK.md` §Rollback. **CI (main):** `rehearsal` job upgrades from the previous release's schema, dumps and restores, starts the image on the restored database, and starts the previous release on the new schema. **Prod:** `db-backup` workflow succeeded 10, 11 and 12 Nov. A rollback has never been performed on production, and a Neon point-in-time restore has never been drilled. One operational lesson from 11 Nov: a Render environment-variable change does **not** restart the running instance; a redeploy is required for it to take effect (`docs/RUNBOOK.md` should say so; it does not yet). | VERIFIED WORKING (mechanics, in CI); rollback on production NOT VERIFIED |
| Staging | 7A was BLOCKED. A staging API service (`echo-echo-api-staging`, own Render PostgreSQL, synthetic data) now exists since 11 Nov; it holds no payment credentials today. No staging front end exists. | PARTIALLY WORKING |

## 20. Roll-up

Of the 19 topics, all 19 were checked. Counting the feature rows above (49 rows):

| Status | Rows |
|---|---|
| VERIFIED WORKING | 21 |
| IMPLEMENTED BUT NOT VERIFIED | 7 |
| PARTIALLY WORKING | 12 |
| NOT IMPLEMENTED | 2 (GST compliance; route and ETA) |
| FAILED | 0 |
| BLOCKED | 6 (S2, S5, S7, S11, real-device tracking, production Cashfree variables) |
| NOT VERIFIED (sub-status of the above where production could not be read) | 5 (S4, S10, admin finance on production, real inbox delivery, café photos) |
| NOT APPLICABLE | 1 (active provider, by instruction) |

Failed tests today: **0** in the suites that ran. Tests not run, by instruction or environment: the active provider's file (18 at last count, not opened), 48 browser journeys (CI only), the release rehearsal (CI only).

## 21. Remaining work, by priority

**Critical**
1. Deploy the Cashfree retirement (merge after review), then delete the five `CASHFREE_*` variables from the production service and the two local credential files. Until deploy, the live CSP still allows `sdk.cashfree.com`.
2. Rebuild reconciliation and marketplace coverage against the active provider's stub (owner authorisation needed; out of scope today). Until then, do not change `services/reconciliation.js`, `wallet.js` or `payouts.js` without adding tests first.

**High**
3. Enforce the student-site CSP (S3): checkout has now run live, so the stated reason for report-only is gone.
4. Restore Chai Garam's normal hours (the 00:00–23:59 override from 11 Nov is still live) and confirm whether Frisco is meant to be hidden.
5. Branch protection on `main` (S7) and the admin host split (S2): owner settings.
6. Real-device tracking checklist (4H): two phones, `DELIVERY-TRACKING.md`.
7. Resolve PR #37 against this branch's `render.yaml`.

**Medium**
8. Record in `RUNBOOK.md` that a Render env change needs a redeploy; add the gateway-rejection message improvement noted on 11 Nov (out of scope today because it touches the shared payment route).
9. Merge Dependabot PR #35 after CI.
10. Decide, with an accountant, what GST compliance ECHO ECHO needs (§10) before building anything.
11. Route and ETA: only after campus paths are mapped and real deliveries measured (§13).

**Low**
12. Delete the four inert Cashfree sandbox scripts; reword the Cashfree mentions left in shared payment-route comments in a separately reviewed change.
