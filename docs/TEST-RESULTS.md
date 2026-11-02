# Test results

The record is CI on the PR: GitHub's runners, Ubuntu, Node 22, disposable PostgreSQL, synthetic data. Nothing here ran against production. The peak-load figures come from this Windows PC.

## Totals

| Suite | Result |
|---|---|
| Server suite | See the PR's `test` job. 1011 passed, 0 failed locally on 2 Nov 2026, before the last two tests were added |
| Browser journeys | See the PR's `browser` job: Chromium, plus emulated Pixel and iPhone engines, real bundle and API, enforced CSP |
| Release rehearsal | See the PR's `rehearsal` job: image, `sharp` in the image, upgrade from `8880959`, dump and restore, start on the restored database, previous release on the new schema |
| Static frontend QA, bundle smoke, asset version, media paths | Passed |
| `npm audit` in `server` | 0 vulnerabilities |

Local runs were spoiled twice. On 2 Nov 2026 a second checkout's test suite shared this machine's test port, so the two dropped each other's database: the test helper now checks whose cluster it has reached, and local runs use `TEST_PG_PORT=56432`. A later local full run was stopped by the machine's memory guard and not restarted, which is why CI is the record.

One journey (lost authenticator) failed in two CI runs and passed in one. The cause was the test: the recovery screen loads on demand, so it sometimes filled in the sign-in form underneath and then sent a blank email and password. It now waits for the recovery screen.

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
| 18 | SSE reconnection | Run | `live-resilience.spec`: a real browser, a real server process stopped and restarted, automatic reconnect, and the missed change delivered |
| 19 | Network interruption | Emulated | `devices.spec`: real browser offline on Pixel and iPhone engines. A real signal loss is on the device checklist |
| 20 | Concurrent orders | Partly | `perf-peak`: 100 orders moving through kitchen states with 500 pages polling. Concurrent order creation is not run, because it goes through checkout |
| 21 | Database failure and recovery | Run, locally | Every connection cut mid-load (`perf-peak`), audit failure rolls back the action, restore rehearsal. No managed-database outage test |
| 22 | CSP and XSS | Run | Injected and remote scripts blocked; stored payloads across every admin page and six student pages. Not a penetration test |
| 23 | Upload security | Run | `remediation`: EXIF, trailing data, truncation, disguise, pixel bomb |
| 24 | Rate-limit spoofing | Run | `remediation`, `edge-limit` |
| 25 | Responsive and accessibility | Partly | Every Campus Control page at 390 px with axe at 1440 px. Student site: widths via emulated phones, axe not run |
| 26 | Admin browser journeys | Run | Below |

## Browser journeys

**Covered:** every Campus Control page signed in; employee invitation end to end with real sign-in; lost authenticator; sessions; permission restrictions; audit log; live map with and without `delivery.track`; approvals; stale form; bulk prices with a conflict; restoring a menu item; website draft and preview; Team Chat; partner applicant and refused approval. Student sign-in by mailbox through profile setup to a cart with no payment call; applying to deliver with a real photo upload; delivery from offer to handoff; customer tracking; menu; data download; deletion request end to end. Counter's delivery status. CSP and script injection. Polling fallback on admin, café list and open menu; a cut stream reconnecting.

**Not covered in a browser:** paying and anything after it (frozen), finance actions (frozen), and the two-person approval of a website publish (API tests only).

## Measured performance

From `tools/perf-peak.mjs` and `tools/perf-local.mjs`. API and database on one Windows PC with no network, so **these numbers say nothing about production capacity**.

| Measurement | Result |
|---|---|
| 500 open pages at their real poll intervals, 60 s, 3811 requests | p95 3.9 ms, p99 7.5 ms, 0% errors |
| 100 orders through kitchen states in 60 s (15 times the audit's rate) | p95 14.5 ms, 0 server errors. 200 moves succeeded; the 100 refused were an illegal step, sent on purpose |
| Every database connection cut during that load (10 connections) | Serving again in 213 ms, 0 failed requests of 553 |
| Cold start, process to first answer, 3 runs | 582 to 646 ms, excluding the instance waking: Render took about 13 s on 26 Oct 2026 |
| Earlier: café list and menu, warm | p95 about 13 ms |
| Earlier: change stamp, 320 items | 0.9 ms hashing, 0.1 ms with the feed |
| Earlier: menu edit to a connected stream | About 1.8 s |

**Not measured, so not claimed:** p95 under 500 ms from India on real hosting, and error rate under load through Render, Vercel and Neon. These need real hosting.

## Backup and restore

Not run locally, because this machine has no `pg_dump`. GitHub Actions' nightly job does restore each encrypted backup
into a throwaway database and compares row counts. The last three runs (30 Oct to 1 Nov 2026) succeeded. In the 1 Nov run,
the dump took 12 s and the decrypt and restore check took 1 s.

CI's `rehearsal` job also upgrades, dumps, restores, starts the production image on the restored database and starts the previous release on the new schema, with synthetic data. The nightly drill now starts the application on the restored copy of real data once this workflow is on `main`.

**Not done:** a Neon point-in-time restore, and a written recovery time from a real incident. The recovery point is about a day, because the backup runs daily at 03:00 IST.

## Physical devices

**Not tested.** No phone was available. Emulated engines pass, but they don't exercise real GPS, a locked screen or battery. See the checklist in `DELIVERY-TRACKING.md`.
