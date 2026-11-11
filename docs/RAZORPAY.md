# Razorpay collection: architecture, status and go-live steps

Decision (11 Nov 2026): **Option C**, one shared payment pipeline with
independent provider adapters. Cashfree's adapter body is unchanged; Razorpay
has its own adapter, credentials, webhook secret, refund semantics and tests.

## Layout

| Path | Role |
|---|---|
| `server/src/services/providers/common.js` | money conversion, error shaping, constant-time compare |
| `server/src/services/providers/cashfree.js` | Cashfree adapter, moved **verbatim** (diff against `main` is empty for the adapter block) |
| `server/src/services/providers/razorpay.js` | Razorpay adapter |
| `server/src/services/providers/index.js` | registry: `adapterFor` (by payment row), `activeAdapter` (by `PAYMENT_PROVIDER`), `configuredAdapter`, capabilities |
| `server/src/services/payment-providers.js` | re-export shim; every old import keeps working |
| `server/src/routes/payments.js` | shared intent, webhook, status pull, cancel; `applyOutcome` remains the only writer of `paid` |

Nothing in the ledger, pricing, settlement or order pipeline names a gateway.

## What changed in the shared code

- **Webhooks are per provider.** `POST /payments/webhook/razorpay` and
  `POST /payments/webhook/cashfree` each verify with that provider's secret
  only, whether or not it is the active collector. The bare
  `POST /payments/webhook` still verifies with the active provider, so the
  Cashfree dashboard entry needs no change today.
- **Status pull follows the payment row.** `GET /payments/status` asks the
  provider recorded on the attempt, not today's setting.
- **Refund lookups resolve by our refund id or the provider's.** A refund
  issued from a provider dashboard still completes correctly.
- **Scheduled reconciliation covers every configured provider**, active first.
- The two `adapter.id === 'cashfree'` branches in the intent route are now
  capability flags (`requiresCustomerPhone`, `supportsSplits`).

## Razorpay adapter: gaps closed

| Audit gap | Fix |
|---|---|
| No refund webhook reader | `readRefundEvent` for `refund.created/processed/failed`, keyed on `notes.quad_refund_id` or the provider refund id |
| No `fetchRefund` | Direct `GET /v1/refunds/{id}`; falls back to listing the payment's refunds |
| No capture policy | Orders created with `payment_capture: 1` |
| Event-id fallback could collide | Fallback is `<event>:<entity id>`, so authorized and captured are distinct events |
| Never run against Razorpay | `scripts/razorpay-test-check.mjs` (test keys only; refuses `rzp_live_`) |

Not added: Razorpay has no "terminate order" API, so a superseded attempt
stays payable at the gateway; a late success on it is flagged by
`applyOutcome`, never confirmed.

## Tests

- `test/payments.test.mjs` (23) unchanged, `test/payments-cashfree.test.mjs` (42) unchanged.
- `test/payments-razorpay.test.mjs` (18): per-provider endpoint, 404/503 refusals,
  authorized then captured without event ids, `order.paid`, wrong amount flagged,
  browser-return status pull (captured / authorized / failed / none), cancel then
  late capture flagged, pending refund completed by webhook and by sweep,
  dashboard-issued refund resolution, failed refund exception, partial refunds,
  ledger consistency.
- `test/providers-isolation.test.mjs` (7): both providers configured with
  Razorpay active; Cashfree events accepted on Cashfree's path, refused on the
  active path; cross-signature refusals; Cashfree status pull and refund go to
  Cashfree; reconciliation runs for both.

Run: `cd server && TEST_PG_PORT=56432 node runtests.mjs payments`

## Dashboard state (read 11 Nov 2026)

- Account activated (Individual); website `https://www.echoecho.tech/web/` approved.
- Live mode: UPI, UPI Autopay, Visa, Mastercard, RuPay, 29 net-banking banks active; Amex on request.
- Settlement account active: beneficiary AYUSH KUSHWAHA, SBI, IFSC SBIN0002580.
- Capture: automatic within 12 minutes (the adapter also requests capture on the order). Refund speed: normal.
- Offer: ₹5,00,000 of zero-platform-fee credits for 90 days from activation.
- No API key generated, no webhook configured, in either mode.
- Checkout preview shows the KYC business name "Echoecho"; the checkout header
  itself is set by our code (`name: BRAND` = ECHO ECHO). Changing the KYC name
  needs Razorpay support.

## Owner steps before any live traffic

1. Dashboard, **test mode**: generate a test key pair, create a webhook at
   `https://<api-host>/payments/webhook/razorpay` with the events listed in
   `server/.env.example`, and put the three values into `server/.env.razorpay-test`
   (git-ignored). Then `node --env-file=.env.razorpay-test scripts/razorpay-test-check.mjs`.
2. Pay the printed test order in Razorpay's test checkout; run the script with `--order`.
3. Dashboard, **live mode**: generate the live key, create the live webhook, and
   enter the three values in Render only (never in a file or chat).
4. Switch `PAYMENT_PROVIDER` only after step 3 and after a ₹1 live order is
   approved explicitly. Cashfree credentials stay in place so its refunds and
   reconciliation keep working.
