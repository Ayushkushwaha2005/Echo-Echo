# Test results

Run on 2 Nov 2026, on Windows with Node 24, against a disposable PostgreSQL with synthetic data. Nothing here
ran against production.

## Totals

| Suite | Result |
|---|---|
| Baseline: merged base `1331bbd`, before any remediation | 917 passed, 0 failed |
| Server suite: remediation branch | 999 passed, 0 failed |
| Browser journeys: Playwright, Chromium, real bundle and API, enforced CSP | 25 passed, 0 failed |
| Static frontend QA, bundle smoke, asset version | Passed |
| `npm audit` in `server` | 0 vulnerabilities |

Two earlier baseline runs were thrown away: one overlapped with my edits, the other with a second run. The 917
figure is the third run, with nothing else using a database. Browser-suite failures along the way were mostly
wrong test assumptions, but they also found the two real bugs in `SECURITY-HARDENING.md`.

The journeys were run from a stack started by hand. CI's browser job is new, and its first run is what the PR
shows, so check that result rather than this file.

## Requested coverage

| # | Requested | Status | Where |
|---|---|---|---|
| 1 | Unit | Run | `npm test` unit group, 135 |
| 2 | Integration | Run | 35, real PostgreSQL |
| 3 | End to end | Run | e2e group, 25 browser journeys |
| 4 | API contract | Partly | `schema-contract`, plus route tests. No generated contract from a spec |
| 5 | Generated permission matrix | Run | `route-permissions`, asks Fastify for every route |
| 6 | Invitation expiry and reuse | Run | `admin-invitation` |
| 7 | Wrong email | Run | Code only goes to the invited address; a ticket is bound to its invitation |
| 8 | Cancel and revoke | Run | `admin-invitation` |
| 9 | Session revocation | Run | `remediation`, browser |
| 10 | Idle timeout | Run | `remediation` |
| 11 | Owner recovery | Run | `remediation` |
| 12 | Self-approval | Run | Route and database |
| 13 | Approval expiry | Run | `remediation` |
| 14 | Duplicate execution | Run | Three simultaneous approvals, one executes |
| 15 | Stale GPS replay | Run | `remediation` |
| 16 | GPS denial | Run | `position-share`, browser with a stubbed denial |
| 17 | Tracking privacy | Run | `tracking-privacy`, `remediation`, browser |
| 18 | SSE reconnection | Partly | Last-Event-ID catch-up is tested. A browser's automatic reconnect is not |
| 19 | Network interruption | Simulated | `position-share` only. A real network drop is on the device checklist |
| 20 | Concurrent orders | Partly | Partner-accept race only. Concurrent order creation is not run, because it would go through checkout |
| 21 | Database failure and recovery | Partly | Audit-failure and transaction rollback, the nightly restore drill. No live outage test |
| 22 | CSP and XSS | Partly | Injected and remote scripts blocked in a real browser. The 52 `innerHTML` uses are not reviewed |
| 23 | Upload security | Run | `remediation`: EXIF, trailing data, truncation, disguise, pixel bomb |
| 24 | Rate-limit spoofing | Run | `remediation`, `edge-limit` |
| 25 | Responsive and accessibility | Partly | 6 Campus Control pages at 3 widths; axe on 3 screens. Not all 23 pages, and not the student site |
| 26 | Admin browser journeys | Partly | Below |

## Browser journeys

**Covered:** employee invitation end to end with real sign-in, used link, sessions, permission restrictions, audit
log, live map with and without `delivery.track`, approvals, stale form, widths, accessibility, café discovery, partner
sharing, GPS denial, Counter's delivery status, CSP on sign-in, CSP report-only on the student site, script injection,
customer tracking, menu, Team Chat, website draft and preview, partner applicant and refused approval, data download.

**Not covered in a browser** (most have API-level tests): student sign-in through the location gate, cart and order
draft, full partner onboarding, delivery assignment, handoff code, and the bulk-price screens.

## Measured performance

From `tools/perf-local.mjs`. API and database on one Windows PC with no network, so **these numbers say nothing about
production capacity**.

| Measurement | Result |
|---|---|
| Café list, 1000 requests at 20 concurrent, warm | p95 12.5 ms, 0% errors |
| Menu, 1000 requests at 20 concurrent, warm | p95 13.2 ms, 0% errors |
| `/admin/changes`, 500 at 10 concurrent | p95 11.1 ms |
| Admin order history, 200 at 5 concurrent | p95 9.3 ms |
| Change stamp cost, 320 menu items | 0.9 ms hashing the table, 0.1 ms with the feed |
| Menu edit to a connected stream | About 1.8 s median, 2 s poll interval |
| GPS report, including all checks | p95 9.6 ms |
| Streams from one address | Exactly 20 of 40 accepted: the per-address cap works |
| Memory after the run | 97 MB |

**Not measured, so not claimed:** p95 under 500 ms on real infrastructure, 100 orders in 15 minutes, 500 open pages,
0.5% errors under load, and cold-start behaviour. These need the staging environment. The measured sub-5-second figure
excludes the Vercel proxy and the client's refetch.

## Backup and restore

Not run locally, because this machine has no `pg_dump`. GitHub Actions' nightly job does restore each encrypted backup
into a throwaway database and compares row counts. The last three runs (30 Oct to 1 Nov 2026) succeeded. In the 1 Nov run,
the dump took 12 s and the decrypt and restore check took 1 s.

**Not done:** starting the application against a restored database, and a written recovery time from a real
incident. The recovery point is about a day, because the backup runs daily at 03:00 IST.

## Physical devices

**Not tested.** No phone was available. See the checklist in `DELIVERY-TRACKING.md`.
