# Non-payment remediation report

Branch `non-payment-remediation`, based on production `main` at `8880959`, with the partner policy fix (`2178883`) and
Team Chat fix (`d670ccd`, PR #26) merged in. **Nothing is merged to `main` or deployed. No production data or
setting was changed.**

COMPLETE below means implemented and verified locally by the tests named. It does not mean proven on production.

## Audit matrix

| Audit finding | Status | Implementation evidence | Test evidence | Remaining blocker |
|---|---|---|---|---|
| 1A Partner approval | COMPLETE | `trust.js`, `admin.js`, `2178883`; old-policy applicants accept the new version themselves | `partner-policy-consent` (5), browser | Stuck applicant must accept after release |
| 1B Admin portal, 23 modules | PARTIAL | Role instructions fixed, wrong-person bug fixed, confirmations added, more pages auto-refresh | Matrix, 25 journeys | Not every CRUD action on every page verified in a browser |
| 1C Café and menu conflicts | PARTIAL | Revisions, 409, history, bulk preview and all-or-nothing apply | `remediation` | Bulk screens not browser-tested; no scheduled publish |
| 1D Live sync | PARTIAL | `change_event`, triggers, SSE, polling kept, hashing replaced | `remediation`, `live-sync` | Streams off until an always-on API and a proxy test exist |
| 1E Team Chat | COMPLETE | PR #26 commit merged; paging and membership checks exist | `team-chat`, `chat-loading`, browser | None in code |
| 2A Invitations | COMPLETE | `admin-invitation.js`, migration 036, invite screen | 21 tests, browser end to end | Real inbox delivery unproven |
| 2B Permissions | PARTIAL | `delivery.track`, `sessions.read`, `reports.export`, generated matrix | `route-permissions` | Finance split deliberately not done (frozen) |
| 2C Sessions | COMPLETE | Last activity, device, one-session revoke, idle timeout | `remediation`, browser | None |
| 2D Owner recovery | PARTIAL | Codes, ticket, alerts, alert address | `remediation` | Owner identity still a student mailbox |
| 3 Approvals | PARTIAL | `approvals.js`, migration 040, DB rules, screen | 7 tests, browser | Only café archive wired; second approver doesn't exist |
| 4A Partner sharing | COMPLETE | `position-share.js`, consent, indicator | `position-share` (14), browser | See 4H |
| 4B GPS integrity | COMPLETE | Conditional upsert refuses older fixes | `remediation` | None |
| 4C Admin map | COMPLETE | Live map, `delivery.track`, audited views | Browser, `remediation` | None |
| 4D Café view | COMPLETE | `/orders/:id/delivery-status`, Counter status line | Browser, `remediation` | None |
| 4E Customer tracking | COMPLETE | Rules kept and retested | `tracking-privacy`, browser | None |
| 4F Streaming | PARTIAL | Tickets, re-checks, no coordinates, 204 when off | `remediation` | Same as 1D |
| 4G Routes and ETA | COMPLETE | Direct line, labelled; no ETA | Browser | Calibration needs real deliveries |
| 4H Real devices | BLOCKED | Checklist written | Not run | Two phones and consenting people |
| S1 | COMPLETE | As 2A | As 2A | |
| S2 Admin host | BLOCKED | Cookie checked; steps written | Not run | DNS and Vercel setup |
| S3 CSP | PARTIAL | Enforced on admin and Counter | Browser | Student site waits on checkout testing |
| S4 | PARTIAL | As 2D | As 2D | As 2D |
| S5 Exposed secret | BLOCKED | Steps written | Cannot be tested | Owner replaces it |
| S6 | PARTIAL | As 3 | As 3 | Finance actions excluded |
| S7 Branch protection | BLOCKED | Command prepared | Confirmed unprotected | Owner's decision |
| S8 Transactional audit | PARTIAL | `auditTx` on new privileged actions | `remediation`, `admin-invitation` | Older routes not converted |
| S9 | COMPLETE | As 4C | As 4C | |
| S10 DB roles | PARTIAL | `deploy/db-roles.sql` | `db-roles` (3) | Production decision |
| S11 Secrets | BLOCKED | Inventory and history scan | Scan results in `STAGING-AND-DEPLOYMENT.md` | Owner moves them; check `server/.env` |
| S12 Rate limiting | COMPLETE | Edge limit on all IP-keyed routes | `remediation`, `edge-limit` | Needs the header set in production |
| S13 Passkey path | PARTIAL | Gone from invitation flow | `admin-invitation` | Removal needs reading production |
| S14 `/ready` | COMPLETE | Trimmed; owner email out of `render.yaml` | `api`, `remediation` | Address stays in Git history |
| S15 Dependencies | COMPLETE | `fast-uri` updated; `sharp` pinned safe | `npm audit` 0 | |
| S16 Uploads | COMPLETE | `storage.js`, `sharp` | `remediation`, `trust`, `storage` | Check the image build |
| S17 Request IDs | COMPLETE | Strict format | `remediation` | |
| S18 Timeout | COMPLETE | As 2C | As 2C | |
| S19 Auto-deploy | BLOCKED | `render.yaml` correct | Not read | Owner checks dashboard |
| 6A Image attribution | BLOCKED | Register of all 80 | Generated from the record | Authorised images, or restored credits |
| 6B Logo | BLOCKED | Assessment written | Not applicable | Source files, trademark lawyer |
| 6C Privacy and DPDP | PARTIAL | Export, deletion request, gap report | `remediation`, browser | Notice and retention decisions; legal review |
| 7A Staging | BLOCKED | Blueprint and steps | Not created | Accounts, possibly cost |
| 7B Performance | PARTIAL | `tools/perf-local.mjs` | Local numbers | Load test on staging |
| 7C Reliability | PARTIAL | Health, readiness, alerts, keep-warm exist | Existing tests | No external uptime monitor or error tracker set up |
| 7D Database recovery | PARTIAL | Nightly restore drill runs | GitHub Actions | App start after restore not tested |
| 7E Browser tests | PARTIAL | 25 journeys, CI job | Passing locally | Journeys listed in `TEST-RESULTS.md` still missing |

**Totals: 45 findings. 18 complete, 18 partial, 9 blocked, 0 not started.**

## Migrations

All additive, none applied anywhere but test databases: `036_admin_invitation_lifecycle`, `037_tracking_consent`,
`038_sessions_and_recovery`, `039_change_feed_and_catalog_revisions`, `040_approvals`, `041_data_requests`.

## Payments

No file in the payment, finance, wallet, settlement, payout, ledger, marketplace, reconciliation, refund, pricing or webhook
modules changed: checked with `git diff --name-only` by name. Payment tests still pass (54 payments, 37 finance, 74
settlement, 27 marketplace).

Three shared things do touch paths payment code can reach:

- `order.transition`'s `forgetForOrder` now also closes the location consent, in the same transaction.
- `sharp` re-encodes every upload, including ID images.
- The `menu_item` and `vendor` triggers run on any change to those rows. Menu price edits behave the same, and a
  bulk price change writes the same price history. Pricing calculations are untouched.

## See also

`SECURITY-HARDENING.md`, `INVITATION-FLOW.md`, `DELIVERY-TRACKING.md`, `STAGING-AND-DEPLOYMENT.md`,
`PRIVACY-AND-DATA-RETENTION.md`, `IMAGE-ATTRIBUTION.md`, `TEST-RESULTS.md`, `ADMIN-ACCESS.md`.
