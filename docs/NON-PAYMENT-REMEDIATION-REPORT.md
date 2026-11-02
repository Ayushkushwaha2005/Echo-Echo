# Non-payment remediation report

Branch `non-payment-remediation` (PR #27), based on production `main` at `8880959`. See the PR for whether it has been merged or deployed.

COMPLETE means implemented and verified by the tests named, locally and in CI. **It does not mean proven on production or on a real phone.** Where a remainder exists only because payments are frozen, the row says so.

## Audit matrix

| Audit finding | Status | Evidence | Remaining, and who acts |
|---|---|---|---|
| 1A Partner approval | COMPLETE | `partner-policy-consent` (5), browser | A stuck applicant accepts the new policy after release |
| 1B Admin portal, all pages | COMPLETE | `modules.spec`: every page signed in, read from the app's own list: no server error, no blocked script, no crash, accessibility rules, 390 px | Finance pages are opened, not exercised (frozen). Owner runs the signed-in production check |
| 1C Café and menu conflicts | COMPLETE | Revisions and 409s, bulk preview and all-or-nothing apply, restore from history (`audit-completion`, `flows.spec`) | Scheduled publish, optional in the audit, is not built |
| 1D Live sync | COMPLETE | Change feed; `live-resilience.spec`: polling updates an open admin page, café list and menu; a real stream reconnects | Under 5 s needs an always-on API (see 4F) |
| 1E Team Chat | COMPLETE | `team-chat`, `chat-loading`, browser | |
| 2A Invitations | COMPLETE | `admin-invitation` (21), browser end to end | Real inbox delivery only provable on production |
| 2B Permissions | COMPLETE, non-payment | `route-permissions` over every route, upgrade test: nobody loses access, nobody gains coordinates | Finance split frozen |
| 2C Sessions | COMPLETE | `remediation`, browser | |
| 2D Owner recovery | COMPLETE | Codes, ticket, alerts (`remediation`); browser: lost authenticator to normal sign-in, old code dead | Owner's own mailbox is S4 |
| 3 Approvals | COMPLETE, non-payment | Café archive and website publish, the audit's non-payment actions; self-decision refused by route and database; expiry, double execution, moved draft | Payment actions frozen. Second approver doesn't exist |
| 4A Partner sharing | COMPLETE | `position-share` (16), browser | See 4H |
| 4B GPS integrity | COMPLETE | `remediation` | |
| 4C Admin map | COMPLETE | Browser, `remediation` | |
| 4D Café view | COMPLETE | Browser, `remediation` | |
| 4E Customer tracking | COMPLETE | `tracking-privacy`, browser, emulated phones | |
| 4F Streaming | COMPLETE, off by decision | Real browser reconnects and catches up; polling proved as the fallback; shutdown bug fixed. The free Render instance sleeps, so streams stay off | Turn on only with an always-on API, after testing through the Vercel proxy |
| 4G Routes and ETA | COMPLETE | Browser | Calibration needs real deliveries |
| 4H Real devices | BLOCKED | Emulated Pixel and iPhone engines pass moving, network drop and hidden screen. That found the clock and lost-fix bugs. Not run on a phone | Owner: two phones, `DELIVERY-TRACKING.md` checklist |
| S1 | COMPLETE | As 2A | |
| S2 Admin host | BLOCKED | Cookie confirmed host-only; steps written | Owner: DNS and Vercel, `STAGING-AND-DEPLOYMENT.md` |
| S3 CSP | PARTIAL | Enforced on admin and Counter, browser | Student site loads checkout, which can't be tested while frozen |
| S4 | PARTIAL | As 2D | Owner: non-student owner address and second alert address |
| S5 Exposed secret | BLOCKED | Can't be checked from outside | Owner: My Profile, steps in `SECURITY-HARDENING.md` |
| S6 | PARTIAL | As 3 | Audit's main examples are payout actions: frozen |
| S7 Branch protection | BLOCKED | `main` confirmed unprotected; file ready | Owner runs the command, because a security setting is not something this work may change |
| S8 Transactional audit | PARTIAL | 44 privileged routes commit with their audit row, proved by failing the audit log | Finance, wallet, payment, refund and deposit routes are frozen |
| S9 | COMPLETE | As 4C | |
| S10 DB roles | PARTIAL | `deploy/db-roles.sql`, `db-roles` (3) | Owner: changes the production connection string |
| S11 Secrets | BLOCKED | Inventory, gitignored, history scan | Owner: password manager; `server/.env` must not point at production |
| S12 Rate limiting | COMPLETE | `remediation`, `edge-limit`; `EDGE_CLIENT_IP_HEADER` confirmed set on Render | |
| S13 Passkey path | PARTIAL | Gone from the invitation flow | Removal is the release after this, once production is confirmed to hold no passkey in use |
| S14 `/ready` | COMPLETE | `api`, `remediation`; migration gate still reads what it needs | Address stays in Git history |
| S15 Dependencies | COMPLETE | `npm audit` 0 | |
| S16 Uploads | COMPLETE | `remediation`, `trust`, `storage`; `sharp` proved inside the production image in CI | |
| S17 Request IDs | COMPLETE | `remediation` | |
| S18 Timeout | COMPLETE | As 2C | |
| S19 Auto-deploy | BLOCKED | Read 2 Nov 2026: `autoDeploy: yes`, trigger `commit`; last 5 deploys `api`. The change was refused by session permission controls | Owner: Render dashboard, Settings, Auto-Deploy |
| 6A Image attribution | BLOCKED | 78 of 80 licences match their source page; 2 rawpixel pages refuse automated reads. No credit invented | Owner: replace photos, or `git revert 849d485`, which undoes their earlier removal of the credits |
| 6B Logo | BLOCKED | `LOGO-ASSESSMENT.md`: no provenance in the file; hourglass symbol and character closely resemble *Ben 10* | Owner: new artwork; trademark lawyer |
| 6C Privacy and DPDP | PARTIAL | Fuller export; request lifecycle, admin screen and retention list, `audit-completion`, browser | Lawyer: notice and retention periods. Nothing is erased until then |
| 7A Staging | BLOCKED | No usable environment exists (previews use the production API). CI `rehearsal` covers release mechanics for free | Owner: accounts, per `STAGING-AND-DEPLOYMENT.md` |
| 7B Performance | PARTIAL | `tools/perf-peak.mjs`, `TEST-RESULTS.md` | Real numbers need real hosting |
| 7C Reliability | PARTIAL | Server-error alert and health check, connections cut mid-load, shutdown fixed | Owner: free external uptime monitor; always-on instance |
| 7D Database recovery | COMPLETE | CI: upgrade, timed dump and restore, app starts on the restored database, previous release runs on the new schema. Nightly drill now starts the app too | Point-in-time restore has never been drilled |
| 7E Browser tests | COMPLETE | Journeys in CI on every push, listed in `TEST-RESULTS.md` | |

**Totals: 45 findings. 27 complete (2 of them for the non-payment part only), 9 partial, 9 blocked, 0 not started.** Of the 9 partial, S3, S6 and S8 wait only on the payment freeze; S4, S10, S13, 6C, 7B and 7C need the owner, a lawyer or real hosting.

## Migrations

All additive: `036_admin_invitation_lifecycle`, `037_tracking_consent`, `038_sessions_and_recovery`, `039_change_feed_and_catalog_revisions`, `040_approvals`, `041_data_requests`, `042_rollback_and_privacy_lifecycle`. `migration-upgrade` proves it from a populated 035: nothing removed or retyped, money tables unchanged, and the only rule changed is two invitation columns that may now be empty.

## Payments

No file in the payment, finance, wallet, settlement, payout, ledger, marketplace, reconciliation, refund, pricing or webhook modules changed: checked with `git diff --name-only` by name. A test fails if any such route enters the atomic list. The payment test suites still pass.

Shared things that payment code can reach:

- `db/index.js`: `q`, `one` and `tx` check for an `atomic()` block. No payment route runs in one, so they behave as before there.
- `audit.js`: outside `atomic()` it behaves as before.
- `order.transition`'s `forgetForOrder` also closes the location consent, in the same transaction.
- `sharp` re-encodes every upload, including ID images.
- The `menu_item` and `vendor` triggers run on any change to those rows. Menu price edits, bulk changes and restores write the same price history. Pricing calculations are untouched.
- `PUT /admin/flags/:key` and `PUT /admin/config/:key` are atomic routes. What they change is unchanged; they now refuse to change it if the audit row can't be written.

## See also

`SECURITY-HARDENING.md`, `INVITATION-FLOW.md`, `DELIVERY-TRACKING.md`, `STAGING-AND-DEPLOYMENT.md`, `PRIVACY-AND-DATA-RETENTION.md`, `IMAGE-ATTRIBUTION.md`, `LOGO-ASSESSMENT.md`, `TEST-RESULTS.md`, `ADMIN-ACCESS.md`.
