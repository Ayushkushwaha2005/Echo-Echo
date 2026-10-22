# Operations report — 2026-10-21/22

Reliability, Cashfree, payouts and Campus Control. Everything below was observed;
where something could not be verified, it says so and names the next action.

## 1. The recurring `keep-warm / ping` failure

**Root cause (observed, run 39605893655 and every scheduled run since 15 Oct 17:53 UTC):**
the `/ready` step got **HTTP 503** with `migrations.pending: ["031_saved_places.sql"]`.
PR #14 shipped migration 031 in code on 15 Oct; migrations are applied by hand with
the owner's approval and nobody applied it, so readiness was correctly red for six
days. The two red `deploy` runs (38796828877, 38887431949) failed on the same check.

**A second, hidden defect:** the `/health` step asked the apex `https://echoecho.tech/api/health/`,
which answers **308** to `www`. `curl -f` only fails on ≥ 400, so the step "passed"
without reaching the API — the job was not keeping Render warm at all.

**Fixed:**
- Migration 031 applied to production at the owner's direction (2026-10-21 17:03 UTC),
  after a read-only snapshot (`server/var/backups/*-pre-031`); money-table
  fingerprints identical before and after; 31/31 applied; `/ready` 200.
- `tools/keep-warm.mjs` replaces the curl steps: liveness and readiness are separate
  probes against the canonical host, redirects are failures, only transient failures
  (network, timeout, 429/502/503/504 without a verdict, database unreachable) are
  retried (4 attempts, 5/15/30 s backoff, 60 s per attempt), a pending migration or
  seed data fails at once with the next action, and a summary table is written to
  the run summary. The job now has `concurrency` so late runs do not pile up.
- `tools/migration-gate.mjs` runs in `deploy.yml` **before** the Render deploy and
  stops a commit whose migrations production lacks, naming the files. `/ready` now
  reports `migrations.latest` for it.
- Regression tests: `server/test/keep-warm.test.mjs` (14).
- Verified: keep-warm dispatched on main (run 39641043035) **succeeded** after the
  migration; the new probe reports healthy against production.

Other recurring workflows: `db-backup` succeeds daily; the only other red runs were
the two deploys above and PR-branch CI runs that were fixed before merge.

## 2. Location modal (PR #15)

Merged and live since 16 Oct (main 883bea0, Render reports that commit). Re-verified
2026-10-22: `live-check` all pass; CORS returns the exact origin for the 4 approved
origins and none for `evil.example`, `www.echoecho.tech.evil.example` and `null`;
page, `version.json` and the modulepreloaded `map.js` agree on build `70f4e4499edb`
and `map.js` is 200. **Not done:** a signed-in production run of pin selection/dragging
— the Chrome extension is not connected and there is no authorised student session
for this agent. Server-side geofence enforcement is covered by
`delivery-anywhere.test.mjs` (16) and `campus-address.test.mjs` (26).

## 3. Cashfree: what is built and what was verified

The integration is **Payment Gateway (collection) + Payouts (disbursement)**, with
Easy Split coded but **off**. Verified today:

| Capability | Evidence | State |
|---|---|---|
| PG production credentials | authenticated `GET /pg/orders/<probe>` → 404 `order_not_found` | **valid** |
| PG sandbox order creation | `cashfree-sandbox-check.mjs`: ₹115 order created and read back | works |
| Payouts sandbox | `sandbox-payouts-e2e.mjs`: 21 pass, 1 not resolved (below) | works |
| Payouts production | no production Payouts client id/secret exists; `/ready` → payouts not configured | **not activated** (owner: Cashfree dashboard → Payouts → Request Activation) |
| Easy Split | vendor API reachable with PG keys ("vendor does not exist"); no vendors | not enabled for settlement; `CASHFREE_EASY_SPLIT` off |
| Settlement account for collections | not visible to this agent (dashboard needs the owner's browser session) | **owner to confirm** in Cashfree → Settlements → bank account |

Sandbox payouts: the one unresolved case is Cashfree's "timeout, later success" test
account, still `PENDING` at Cashfree after 4 minutes. The safety properties held (no
second transfer, money not counted as paid); the success leg was not observed.

## 4. Money flows

- **Customer → ECHO ECHO collection:** online prepaid only; orders and sessions are
  created server-side; payment is confirmed by signed webhook (raw-body HMAC,
  timestamp window, idempotent on event id, duplicates counted) or by a server-side
  status pull — never by the browser. Refused webhooks are audited.
- **Platform earnings:** live terms verified: platform fee **₹10** (pickup and
  delivery), delivery fee **₹15** (₹0 pickup), commission 0. The ledger keeps
  `platform_revenue` separate; gateway fees come only from Cashfree's settlement report.
  Money reaches the owner's bank by Cashfree's own settlement of collections; no
  payout to the owner is built or needed, and none was assumed.
- **Cafés:** daily 20:00 IST batch from `cafeteria_payable`, only to a Cashfree-verified
  account, one live payout per payee, auto-release **off** (an administrator releases).
- **Partners:** ₹10, ₹15 at subtotal ≥ ₹300; weekly; ₹100 minimum; 24 h earning hold
  (all verified in production config). Bank/UPI details go to Cashfree and are dropped;
  only the beneficiary id, a masked hint and an HMAC fingerprint are stored.
  **New:** a *changed* payout destination is held 24 h (`destination_change_hold_hours`)
  for withdrawals and batch releases alike, and the partner is notified in-app and by
  email with masked details. Covered by `marketplace.test.mjs` and the sandbox e2e.
- No real money moved in any of this work.

## 5. Campus Control (admin portal)

New, on real APIs with server-side permission checks (`src/routes/admin-ops.js`):
Orders (server search/filters/pagination, timeline per order), Payments (Cashfree
references, refunds, reconciliation state, webhook deliveries and refusals — no
payloads), Reliability (database, migrations, ledger balance, failed/flagged payments,
refused webhooks, stale/failed payouts, stuck refunds, reconciliation, settlement
import, notifications — each with its next step), Reports (orders/payments/payouts/
ledger CSV, ≤ 366 days, formula-injection safe, masked destinations, audited),
Overview money tiles and alerts, partner payout readiness. Indian digit grouping in
`rupees()`. Tests: `admin-ops.test.mjs` (8). Rendered headless against a local
stack at 1280 px light and 390 px dark: no console errors, no page overflow.

Existing modules kept: cafés and menus, locations/boundary, verification, incidents
and deposits, finance/settlements, administrators (owner-granted permissions,
passkey/TOTP sign-in), audit, platform flags.

EduSentinel reference (read-only, `PROJECT/apps/web/src`): one capability-driven
shell, nav as UX only with guards on every route; MFA gate for privileged roles;
URL-driven server paging; client CSV export with formula escaping; read-only
audit; a read-only permission matrix. Adopted: server-checked routes, server paging,
formula-safe CSV (server-side here, audited), "no match" vs "none" empty states.
Not copied: code, branding, the violet/azure accents, glass or meteor effects.

## 6. Café QR

Waiting for the image. Procedure and verifier ready: `docs/QR-CAFE-READINESS.md`,
`tools/qr-verify.py`.

## 7. Open items

| Blocker | Next action | Who |
|---|---|---|
| Cashfree Payouts production | Request Activation; then put production Payouts keys on Render | owner |
| Collection settlement account | Confirm the bank account in Cashfree → Settlements | owner |
| Signed-in production checks (pin, drag, checkout) | Connect the Claude Chrome extension, or run them with a student account | owner |
| Café QR | Send the image; then the print test on iPhone and Android | owner |
| Sandbox "timeout, later success" leg | Re-run `sandbox-payouts-e2e.mjs`; Cashfree sandbox did not resolve it in 4 min | Claude, on re-run |
