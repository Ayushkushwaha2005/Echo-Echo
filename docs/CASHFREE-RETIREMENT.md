# Cashfree retirement

**Decision:** Cashfree (Payment Gateway, Payouts and Easy Split) is permanently retired from ECHO ECHO as of 12 November 2026. Cashfree closed the merchant account on 3 November 2026 and it cannot be reopened; a second application was filed on 11 November 2026 and is not relied upon. The platform collects through the one remaining adapter in `server/src/services/providers/`, which this document deliberately does not describe: the retirement was carried out without inspecting, testing or changing that adapter, its configuration or its tests.

Branch: `cashfree-retirement`, based on production `main` at `29553ef`. Nothing here is deployed until the owner merges and releases it.

## 1. What was retired

| Component | Where it lived | What happened to it |
|---|---|---|
| Cashfree PG adapter (order creation, webhook verification, status pull, refunds, settlement pull, Easy Split vendor lookup) | `server/src/services/providers/cashfree.js` (415 lines) | Replaced by a 60-line **retired stub**: same id `cashfree`, `configured` is always `false`, `retired: true`, every method throws a 503 `configuration_required` naming the retirement. No `fetch`, no HMAC, no Cashfree host remains in the file. |
| Cashfree Payouts adapter (transfers, beneficiaries, transfer lookup, payout webhook, X-Cf-Signature 2FA) | `server/src/services/payout-providers.js` | The Cashfree block (about 225 lines) replaced by a retired stub with the same id `cashfree_payouts`; `configured` always `false`; `send`, `createBeneficiary`, `fetchBeneficiary`, `fetchTransfer`, `readWebhook` throw; `verifyWebhook` returns `provider_retired`. The `node:fs` and RSA imports it alone used are gone. |
| Configuration | `server/src/config.js` | Every `CASHFREE_*` read removed: `PAYMENTS.cashfreeBase`, `PAYMENTS.cashfree.{appId,secretKey,apiVersion,returnUrl,paymentMethods,notifyUrl}`, `PAYOUTS.cashfreeBase`, `PAYOUTS.cashfree.{clientId,clientSecret,mode,apiVersion,publicKey,publicKeyPath,timeoutMs}`. `PAYMENTS.cashfree` is now the frozen constant `{ retired: true, easySplit: false }` for the two call sites that still ask about Easy Split. `providerConfigured('cashfree')` returns `false` unconditionally; `configuredProviders` no longer lists it; `publicConfig` has no Cashfree branch; `PAYOUTS.configured` and `PAYOUTS.method` have no Cashfree branch. |
| Production boot guard | `server/src/config.js` `assertBootable()` | `PAYMENT_PROVIDER=cashfree` and `PAYOUT_PROVIDER=cashfree` are **fatal** in production (the server refuses to start rather than collect through a closed account). Leftover `CASHFREE_*` variables are **reported as a warning** and ignored, so a service that still carries them deploys and runs. The Cashfree sandbox-URL, TEST-app-id and notify-URL guards were removed with the variables they checked. |
| Checkout (student site) | `web/src/app.js` | The Cashfree SDK entry, `openCashfree()` and the `provider === 'cashfree'` branch are gone. An intent naming an unknown provider is refused by the existing `Unknown payment provider` path. The shipped bundle contains the string `cashfree` zero times (checked after a production build). |
| Content Security Policy | `vercel.json` | `https://sdk.cashfree.com` and `https://*.cashfree.com` removed from `script-src`, `img-src`, `connect-src`, `frame-src` and `form-action` in both the enforced and report-only headers (ten host entries). |
| Render Blueprint | `render.yaml` | The Cashfree block removed: `CASHFREE_PG_APP_ID`, `CASHFREE_PG_SECRET_KEY`, `CASHFREE_PG_NOTIFY_URL`, `CASHFREE_PG_RETURN_URL`, `CASHFREE_EASY_SPLIT`. `PAYMENT_PROVIDER` changed from `value: cashfree` to `sync: false`, so the active provider is set only in the Render dashboard and a Blueprint sync can neither select Cashfree nor switch the gateway. |
| Env template | `server/.env.example` | All Cashfree variables and the Cashfree sections removed; `PAYMENT_PROVIDER` and `PAYOUT_PROVIDER` comments state the retirement. |
| Easy Split admin routes | `server/src/routes/wallet.js` | `PUT /admin/vendors/:id/easy-split` and `POST /admin/vendors/:id/easy-split/settled` stay registered (so the permission matrix and old Campus Control builds get a truthful answer) but refuse with 503 `Easy Split is retired` before touching any row. `GET /admin/finance/settlement-accounts` reports `easySplitEnabled: false`. |
| Payout-detail registration | `server/src/routes/wallet.js` `registerDestination()` | The Cashfree beneficiary registration body (create/fetch beneficiary, store `provider='cashfree'` destination) removed. The route still validates the input and then refuses with 503, storing nothing; the unused masking helpers and the `cashfree` import went with it. |
| Campus Control labels | `admin/src/app.js`, `server/src/routes/admin-ops.js` | Provider filter and column show `Cashfree (retired)` for historical rows; the three reliability-check hints that said "check Cashfree" now say "the gateway". |
| Tests, mocks and fixtures | `server/test/` | `payments-cashfree.test.mjs` (37 tests driving the live adapter against a Cashfree wire-format stub), `marketplace.test.mjs` (27 tests, Cashfree PG + Payouts stubs) and `reconciliation.test.mjs` (38 tests, Cashfree settlement-recon stub) **deleted**; their stubs were Cashfree's wire format and cannot run against a retired adapter. `providers-isolation.test.mjs`: the six Cashfree assertions rewritten to prove the retirement while the active provider runs; the active-provider stub and its test are byte-for-byte unchanged. `settlement.test.mjs`: three Cashfree Payouts tests replaced by one retirement test. `config-safety.test.mjs`: the Cashfree boot-guard and Blueprint assertions replaced by retirement assertions. New: `cashfree-retirement.test.mjs` (13 tests, below). |
| Scripts | `server/scripts/cashfree-sandbox-check.mjs`, `sandbox-checkout.mjs`, `sandbox-e2e.mjs`, `sandbox-payouts-e2e.mjs` | **Left in place, inert.** They are developer scripts that read `CASHFREE_*` from their own environment and talk to Cashfree's sandbox directly; none is imported by the server or run by CI. They no longer work (the adapter they import refuses) and are listed under remaining references for the owner to delete. |
| Documentation | `deploy/GO-LIVE.md`, `deploy/server.env.example`, `tools/qr-verify.py` | Text that named Cashfree as the gateway made provider-neutral. |

## 2. Active functionality removed, in the customer's and operator's terms

- A student can no longer be sent to a Cashfree checkout. The intent route returns 503 `configuration_required` if Cashfree is the selected provider, and never returns `provider: 'cashfree'` otherwise.
- `POST /payments/webhook/cashfree` answers 503 and records nothing, whatever the signature. `POST /payments/webhook` (the active provider's endpoint) does not accept a Cashfree signature either.
- A pending historical Cashfree attempt is never pulled from Cashfree: `/payments/status` reports what the database holds, confirms nothing, and makes no outbound call.
- A refund on a historical Cashfree payment is refused. With another provider active, the route resolves the row to the retired adapter and refuses with the retirement message, recording the attempt as a `failed` refund with no ledger movement; with Cashfree selected (a configuration production now refuses to boot), it refuses at the door and writes nothing. Money still owed on such a payment is returned by bank transfer and recorded by an administrator.
- Scheduled reconciliation runs for the active provider only; `others` is empty and no Cashfree settlement report is requested.
- No settlement can be sent through Cashfree Payouts: with `PAYOUT_PROVIDER=cashfree` the scheduler sends nothing and the café's payable stays owed; production refuses to boot with that setting.
- No bank or UPI detail can be sent to Cashfree for beneficiary verification.
- Easy Split cannot be enabled, queried or recorded.

## 3. Retirement enforcement mechanisms

1. **No code path.** The live adapter bodies are gone from the tree. There is no HTTP call to any `*.cashfree.com` host anywhere under `server/src`, and `cashfree-retirement.test.mjs` fails if one is added back or if any `env('CASHFREE_…')` read returns.
2. **No configuration path.** No `CASHFREE_*` variable is read. The retired adapters' `configured` getters return `false` regardless of the environment, so the shared registry (`activeAdapter`, `configuredAdapter`, `configuredAdapters`, `requireAdapter`, `adapterFor`) can never hand out a working Cashfree adapter. This is enforced inside the Cashfree files and `config.js` only; the registry and the payment routes were not changed.
3. **Fail closed at boot.** In production, `PAYMENT_PROVIDER=cashfree` or `PAYOUT_PROVIDER=cashfree` is fatal. A deployment that asks for Cashfree gets no server, not a server that silently falls back to something else.
4. **No Blueprint path.** `render.yaml` carries no Cashfree key and no provider value; `config-safety.test.mjs` fails CI if either returns.
5. **No browser path.** The student bundle has no Cashfree SDK loader and the CSP does not allow a Cashfree host, so even a stale intent could not open a Cashfree checkout.
6. **Tests.** `server/test/cashfree-retirement.test.mjs` (13 tests) configures the server with every Cashfree variable set and pointed at a live local stub, then proves: the variables are ignored; no intent, webhook, status pull, refund, Easy Split call or payout-detail registration reaches the stub (zero requests across the file); historical rows stay readable; the source tree, bundle, CSP, Blueprint and env template carry no Cashfree. `providers-isolation.test.mjs` proves the same while the active provider is collecting. `config-safety.test.mjs` proves the boot refusals.

## 4. Historical data preservation

Nothing was deleted or rewritten, and **no migration was added**. The provider ids `cashfree` and `cashfree_payouts` remain valid values because the retired stubs keep them, so:

- `payment` rows with `provider = 'cashfree'` are listed in Campus Control → Payments (filter "Cashfree (retired)") with their gateway order and payment ids, amounts, fees and refund states; the `/admin/payments` totals include them.
- `refund`, `refund_allocation`, `ledger_txn`, `order_financials`, `payment_webhook` (`provider = 'cashfree'`), `provider_settlement_import` / `provider_settlement_line`, `reconciliation_exception`, `payout` (`method = 'cashfree_payouts'` or `'cashfree_easy_split'`), `payout_destination` (`provider = 'cashfree'`), `payment_split`, `vendor_split_account` and `audit_log` rows are untouched and remain queryable.
- The order history, café statements and partner statements that those rows feed are unchanged: the ledger is append-only and nothing here posts to it.
- Test fixtures that insert historical `cashfree` rows (`admin-ops`, `alerts`, `tulips-name`, `helpers/db.mjs`) still pass, which is the regression check that history keeps resolving.

## 5. Remaining Cashfree references

| Reference | Kind | Action |
|---|---|---|
| `server/src/services/providers/cashfree.js`, `payout-providers.js` (retired stubs), `config.js` comments and boot guard, `providers/index.js` capability table and comments, `payment-providers.js` re-export | **Active, intentional** | Keep: these are the retirement itself and the id that history resolves to. |
| `server/src/routes/payments.js` (comments and two operator hints mentioning "the Cashfree dashboard"), `routes/support.js` comment, `services/reconciliation.js`, `services/sweeper.js`, `services/payouts.js`, `services/wallet.js` comments, `routes/admin.js` comment, `routes/finance.js` hint text | **Text only, in shared payment code** | Not changed, deliberately: these files carry the shared pipeline and the active provider. Reword in a later, separately reviewed change. |
| `server/src/services/prepaid.js` (`'cashfree'` in a set of online method names) | Historical classification of past orders | Keep. |
| `server/src/db/007`, `008`, `009`, `028` migration comments | Historical, immutable | Keep; migrations are never edited. |
| `server/scripts/cashfree-sandbox-check.mjs`, `sandbox-checkout.mjs`, `sandbox-e2e.mjs`, `sandbox-payouts-e2e.mjs` | Inert developer scripts | Owner may delete; they no longer function. |
| `admin/src/app.js` (filter/label "Cashfree (retired)"), `server/src/routes/admin-ops.js` (`provider` filter accepts `cashfree`), `test/helpers/db.mjs`, `test/admin-ops.test.mjs`, `test/alerts.test.mjs`, `test/tulips-name.test.mjs` | Historical display and fixtures | Keep. |
| `docs/CASHFREE-MARKETPLACE.md`, `docs/PAYMENTS-PROVIDER.md`, `docs/FINANCE.md`, `docs/TULIPS-PAYMENTS-2026-10-24.md`, `docs/OPERATIONS-2026-10-22.md`, `docs/QR-CAFE-READINESS.md`, `docs/LAUNCH-*.md`, `docs/PRODUCTION-CHECKLIST.md`, `docs/STAGING-AND-DEPLOYMENT.md`, `AUDIT-REPORT.md`, `brand/logo/geometric/README.md` | Documentation, historical record | `PAYMENTS-PROVIDER.md` carries a superseded notice pointing here. `CASHFREE-MARKETPLACE.md` has uncommitted line-ending-only changes in the owner's working tree and was not touched. The dated reports are records of their day. |
| `tests/browser/journeys/flows.spec.mjs` (a request-URL regex `cashfree|razorpay` used to assert that a cart journey makes no payment call) | Test instrumentation | Keep: it still proves nothing payment-related is called. |
| `.gitignore` comment about Cashfree Payouts key material | Protective | Keep: it keeps any leftover PEM out of Git. |
| **Production Render service** `echo-echo-api`: `CASHFREE_EASY_SPLIT`, `CASHFREE_PG_APP_ID`, `CASHFREE_PG_NOTIFY_URL`, `CASHFREE_PG_RETURN_URL`, `CASHFREE_PG_SECRET_KEY` are still set (names read over the Render API on 12 Nov 2026; values not read). | **Live configuration** | Owner: delete the five variables in the Render dashboard. Until then the new build ignores them and logs one warning at boot. |
| **Local, untracked, git-ignored** `server/.env.production` and `server/.env.sandbox` hold Cashfree production and sandbox credentials in plain text. | Secret material on the owner's PC | Owner: delete both files (and rotate nothing, since the account is closed). They were not read beyond confirming they exist and match `.gitignore`, and their contents are not reproduced anywhere. |
| **Vercel production** still serves the previous `vercel.json`, so the live CSP allows `sdk.cashfree.com` until this branch is deployed. | Live configuration | Resolves on deploy. |

## 6. What this change does not do, and why

- It does not remove the `cashfree` / `cashfree_payouts` ids from the registries, the `/payments/webhook/:provider` whitelist or the admin provider filter. Removing them would make every historical row an "unknown provider", which is worse than a known provider that refuses.
- It does not change `server/src/routes/payments.js`, `providers/index.js`, `services/reconciliation.js` or `refund-status.js`. The retirement is complete without them, and they are shared with the active provider, which was out of scope.
- It does not add a `410 Gone` for the Cashfree webhook path. The existing "known provider, not configured" answer (503, nothing recorded) is the shared route's behaviour and is sufficient; changing the status would mean editing the shared route.
- It does not re-point the deleted reconciliation and marketplace suites at the active provider. That is active-provider test work, explicitly out of scope, and is the one material cost of this retirement: see the blocker below.

## 7. Unresolved blockers

1. **Coverage lost on shared financial engines (HIGH).** `reconciliation.test.mjs` was the only suite exercising `services/reconciliation.js` end to end (fee application, duplicate import, amount and mapping mismatches, unsettled sweep, scheduled window) and `marketplace.test.mjs` the only one exercising partner withdrawal through a payout provider, destination holds and beneficiary reuse. Both drove the engines through Cashfree stubs and were deleted with the adapter. The engines themselves are unchanged; what remains is `settlement.test.mjs` (34), `finance.test.mjs`, `providers-isolation.test.mjs` (scheduled reconciliation runs, one import row) and the active provider's own suite, which this work did not run or read. **The owner should authorise a follow-up that rebuilds those scenarios against the active provider's stub before the next finance-engine change.**
2. **PR #37 conflict.** `razorpay-live` (open, awaiting the owner) also edits the `render.yaml` payments block and `config-safety.test.mjs`. Whichever merges second will need a small conflict resolution. This branch's version (provider `sync: false`, no provider value in the Blueprint) is the stricter of the two and is what the retirement test expects.
3. **Owner actions:** delete the five `CASHFREE_*` variables from the production service; delete `server/.env.production` and `server/.env.sandbox`; optionally delete the four sandbox scripts.

## 8. Verification record

Run locally on 12 November 2026, Windows, embedded PostgreSQL on `TEST_PG_PORT=56432`, one suite at a time:

```
node runtests.mjs cashfree-retirement    ok  13 pass 0 fail
node runtests.mjs providers-isolation    ok   8 pass 0 fail
node runtests.mjs config                 ok  59 pass 0 fail (config-safety 10)
node runtests.mjs settlement.test        ok  34 pass 0 fail
node runtests.mjs security               ok  61 pass 0 fail
node runtests.mjs admin-ops              ok  10 pass 0 fail
node runtests.mjs tulips-name            ok   4 pass 0 fail
node runtests.mjs route-permissions      ok   4 pass 0 fail
QUAD_API_BASE=/api node build.mjs --production      built; "cashfree" occurs 0 times in dist/_v/*/web/src/app.js
node tools/frontend-qa.mjs               passed (257 files)
node tests/bundle-smoke.mjs              all surfaces execute cleanly
node tests/asset-version.mjs             passed
node tests/media-paths.mjs               passed
```

The full server suite result is recorded in `docs/PLATFORM-AUDIT-CROSSCHECK-2026-11.md`, section 15.
