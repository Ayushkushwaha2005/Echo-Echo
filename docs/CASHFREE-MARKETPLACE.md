# Cashfree marketplace: payments, settlement, payouts

What is built, what Cashfree has to switch on, and what only the owner can do.
Money rules live in `docs/FINANCE.md`; provider choice in `docs/PAYMENTS-PROVIDER.md`.

## Status (2026-09-27, evening)

| | State |
|---|---|
| Collection against the **real Cashfree sandbox** | Verified with `scripts/sandbox-e2e.mjs` (27 pass, 0 fail). Cashfree accepts our orders; payments made with Cashfree's official sandbox UPI instruments are confirmed by Cashfree's own signed webhook, delivered over HTTPS. |
| Failed attempt | Recorded as failed, never paid. The order stays retryable, and the replaced Cashfree order is TERMINATED. |
| Refunds | Accepted by Cashfree and reached SUCCESS through the status pull. Duplicate requests are no-ops. |
| Settlement report API | Reachable (it rejected millisecond timestamps; now fixed). |
| User-dropped | Only the hosted checkout UI emits it. Covered by signed-webhook tests; not driven live. |
| Payouts | Code is complete, including the X-Cf-Signature 2FA and UPI transfer mode. **Not yet run live: Payouts sandbox credentials are needed.** |
| Easy Split | Off. |
| Production | Not deployed. Migration 028 is not applied. |

## How the money flows

Worked example: food ₹100, delivery ₹5, platform fee ₹10, so the customer pays **₹115**.

| Where it goes | ₹ | Ledger account |
|---|---:|---|
| Café | 100.00 | `cafeteria_payable` (vendor) |
| ECHO ECHO platform fee | 10.00 | recorded in `order_financials.platform_fee_paise` |
| Delivery partner (configured earning) | 10.00 | `delivery_clearing`, then `delivery_payable` (partner) once the handoff code is verified |
| Platform net | 5.00 | `platform_revenue` (₹10 fee + ₹5 delivery charge − ₹10 partner earning) |
| Gateway fee | from the report | `gateway_fee`. It comes from Cashfree's settlement report and is never estimated. It is never taken from the café. |

The partner earning is ₹10, or ₹15 when the food subtotal is ₹300 or more. Both
figures come from `pricing_policy`, and each order keeps the version it was priced
under. The live policy charges customers ₹15 for delivery; the ₹5 above is the test
scenario.

**Collect and disburse (the default).** Cashfree settles the whole ₹115, less its
fee, into ECHO ECHO's one settlement account. The ledger says who is owed what.
Payouts go out through Cashfree Payouts:

- **Cafés:** daily at 20:00 IST. A café is paid only into a *verified* settlement
  account. With no account, it shows `PENDING`. Its payable keeps accruing
  exactly, and the first run after verification pays the whole balance.
- **Partners:** weekly by default, or when the partner asks for a withdrawal.

**Easy Split (when approved).** Set `CASHFREE_EASY_SPLIT=on`. Then register each
café's Cashfree vendor id with `PUT /admin/vendors/:id/easy-split`. The server asks
Cashfree for the vendor's status, and only Cashfree's `ACTIVE` answer enables
the split. After that, `order_splits` sends the café's snapshot share to Cashfree.
Tonight's batch skips amounts that Cashfree is settling to the café directly.
Once Cashfree settles, `POST /admin/vendors/:id/easy-split/settled` records the
settlement with Cashfree's reference, as a `cashfree_easy_split` payout. The ledger
and payout rules do not change.

## Platform settlement account

Cashfree's documentation says settlements go to *the* bank account on the merchant
profile (Dashboard → Settings → Bank Accounts). It does not describe more than one
merchant settlement account. So the primary ECHO ECHO bank account is the only
platform destination. There is no split across "additional ECHO ECHO accounts",
and routing platform money through a fake Easy Split vendor would be an unsupported
workaround, so it is not built. If Cashfree confirms in writing that a second
account is supported for this merchant id, it is a dashboard setting and needs no code.

## Partner withdrawal rules (all configuration: `PUT /admin/payout-config`)

| Key | Default | Meaning |
|---|---|---|
| `frequency` | `weekly` | Allowed values: `weekly`, `daily` or `on_request`. `weekly` allows one withdrawal per ISO week, and the Monday 20:00 run also pays any eligible balance. |
| `min_withdrawal_paise` | 10000 (₹100) | The smallest balance a partner can withdraw. With ₹65 the partner cannot withdraw; at ₹100 they can. |
| `min_balance_paise` | 10000 | The smallest balance the weekly scheduled run pays. |
| `method` | `bank_or_upi` | Allowed values: `bank`, `upi` or `bank_or_upi`. |
| `earning_hold_hours` | 24 | How long an earning stays *pending* after delivery. An earning also stays pending while an incident on that order is open. |

The partner's status moves through these stages: Pending → Available → Withdrawal requested → Processing → Paid or Failed.

**Double-payment guards:**
- a per-partner `Idempotency-Key`
- only one live payout per payee
- our payout id is Cashfree's `transfer_id`
- the ledger posting is unique on the payout id

**When a transfer fails or times out:**
- A timeout or 5xx is not treated as a failure. The payout stays `processing` until the status sync or the payout webhook reports the result, so the transfer is never sent twice.
- A definite failure leaves the ledger untouched, and the money is available again.
- A retry is always a new transfer id.

Bank details go through the server to Cashfree and are not kept. ECHO ECHO stores
the beneficiary id, the last 4 digits (or a masked UPI id) and the IFSC. Log
redaction covers `accountNumber` and `vpa`.

## Refunds and cancellation

- The gateway is called first, then the ledger is updated. Each party's share
  goes back in proportion. Historical entries are never edited.
- **Refund before settlement:** it reduces the pending payables.
- **Refund after the café was paid:** the café's payable goes negative. That
  compensating entry is netted against its next settlement, and the paid payout
  stays exactly as it was.
- **Cancelling a paid order** (confirmed or preparing) triggers a full refund
  automatically, keyed `cancel:<order>`. The platform fee is returned. No partner
  earning ever existed for it. If the gateway call fails, reconciliation raises
  `refund_mismatch`.
- Cashfree refunds are asynchronous. A `REFUND_STATUS_WEBHOOK` marks a refund
  completed, and one still processing after 72 h raises `refund_stuck`.

## Delivery incidents

Reported → Under review → Resolved, with an append-only trail in `delivery_incident_event`.

- **Categories:** damaged, spilled, lost, missing, tampered, suspected theft, not delivered, wrong order.
- **While a report is open:** the earning on that order is held as pending and nothing is deducted.
- **Actions against a partner** (earning adjustment, suspension, warning): these require the finding `partner_responsible` and at least 20 characters of evidence. The adjustment is a ledger entry, idempotent per incident, capped at the order value, and needs a fresh passkey.
- **Repeat incidents:** they are surfaced for escalation, not automated. Two in 90 days suggests suspension and an account review. Three suggests reviewing the partner for removal.
- **Deposit deductions:** these keep their existing dispute window.
- **Partner terms:** migration 028 publishes them as a new version of the partner policy. Pending applicants must accept the new version, and approved partners are unaffected.

## Owner actions: things only you can do

1. **Sandbox keys (PG).**
   - In the Cashfree dashboard, go to Developers → API Keys (Sandbox) and generate or view them.
   - Put `CASHFREE_PG_APP_ID` and `CASHFREE_PG_SECRET_KEY` into `server/.env.sandbox`. Never paste them into chat or git.
   - Then run `node --env-file=.env.sandbox scripts/cashfree-sandbox-check.mjs`.
   - **Warning:** `server/.env` points at production Neon. Do not put sandbox keys there.
2. **Sandbox webhook.**
   - In Developers → Webhooks, add `https://<api-host>/payments/webhook` with the latest webhook version.
   - Tick Payment Success, Payment Failed, User Dropped and Refund Status.
3. **Payment methods.** In the checkout settings, confirm that UPI, credit cards and debit cards are enabled.
4. **Payouts sandbox.**
   - Enable Cashfree Payouts.
   - Generate the Payouts client id and secret, and whitelist the server IP or add the public key if Cashfree asks.
   - Set `PAYOUT_PROVIDER=cashfree`, `CASHFREE_PAYOUT_CLIENT_ID`, `CASHFREE_PAYOUT_CLIENT_SECRET` and `CASHFREE_PAYOUT_BASE_URL=https://sandbox.cashfree.com`.
   - Add the payouts webhook: `https://<api-host>/payouts/webhook`.
5. **Easy Split.**
   - Request it from Cashfree. It is subject to their eligibility review, including the RBI marketplace rules in `PAYMENTS-PROVIDER.md` §1.
   - After approval, create each café as a vendor with the café's own KYC and bank details, which only the café can supply.
   - Then set `CASHFREE_EASY_SPLIT=on`.
6. **Production.**
   - Complete KYC and business verification, and get production activation approved.
   - Then set the production keys with `CASHFREE_PG_BASE_URL=https://api.cashfree.com`.
   - Run migration 028 against prod before deploying this code.
7. **Café bank accounts.** When a café provides them, enter them with `PUT /admin/vendors/:id/settlement-account`. Cashfree verifies the beneficiary.

## Production deployment sequence (prepared, not executed)

1. **Owner:** get production activation from Cashfree, and Payouts activation if partner payouts should be automatic.
2. **Render env (production keys only):**
   - `PAYMENT_PROVIDER=cashfree`
   - `CASHFREE_PG_APP_ID` and `CASHFREE_PG_SECRET_KEY` (production)
   - `CASHFREE_PG_BASE_URL` unset (it defaults to api.cashfree.com)
   - `CASHFREE_PG_NOTIFY_URL=https://echo-echo-api.onrender.com/payments/webhook`
   - `CASHFREE_PG_RETURN_URL=https://www.echoecho.tech/`
   - Remove `PAYMENTS_DEFERRED`, and set `SWEEPER` back on, because unpaid orders must expire.

   The boot guard refuses sandbox URLs, TEST app ids and a non-https notify URL.
3. Apply migration 028 to production **before** the code: `npm --prefix server run migrate:local` against prod. This needs the owner's go-ahead.
4. Merge `cashfree-marketplace` into main. CI runs the full suite, deploy.yml deploys and runs the live check.
5. Place one real ₹1-scale order end to end and check that its webhook arrived. Then refund it.

**Rollback.** Redeploy the previous commit. Migration 028 only adds tables, nullable or defaulted columns, and widened CHECK sets, so the previous code runs on the migrated schema unchanged. There is no down-migration; nothing needs one. To stop taking payments immediately, set `PAYMENTS_DEFERRED=true` and unset `PAYMENT_PROVIDER`: checkout returns 503 and no order is placed.
