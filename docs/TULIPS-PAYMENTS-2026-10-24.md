# Tulips: name, counter QR and how Tulips is paid — 2026-10-24

Everything below was observed in this repository, the test cluster, Cashfree
sandbox or read-only production endpoints. Where something could not be
verified it says so and names who can.

## 1. Name

Production had one record, slug `tulips`, id `6f4c9508-…`, named **"Tulips Cafe"**
(migration 022, after the "Tulips CAFE" signboard). Migration
`032_tulips_name.sql` renames that record to **"Tulips"** in place, and the campus
place it is attached to with it (only while it still reads "Tulips Cafe").

- No duplicate: same id, same slug, nothing inserted.
- Orders, payments, payouts and ledger rows refer to the vendor id, never to the
  name, so they are unchanged; every screen joins the name live (listings, menu,
  checkout, receipts, order history, café/partner/admin dashboards, CSV reports,
  notifications), so all of them read "Tulips" after the migration.
- Order `destination_snapshot`s and the field-survey evidence are history and are
  not rewritten. Chai Garam is not touched.
- Audited (`vendor.rename`, from/to). Idempotent: a re-run changes nothing.
- The Cashfree checkout note now names the café: `ECHO ECHO order EE-1234 from
  Tulips` (was `Quad order EE-1234`), ASCII-safe and ≤ 200 characters.
- Tests: `server/test/tulips-name.test.mjs` (4) and an assertion in
  `payments-cashfree.test.mjs`. Older tests that build the 022 state on purpose
  still say "Tulips Cafe" — that is the history being replayed.

**Production:** 032 must be applied before this commit deploys (the deploy
workflow's migration gate refuses it otherwise). Applying it is a production
write and is done only with the owner's approval.

## 2. The counter QR

Decoded, not guessed: a **static PhonePe merchant UPI QR**,
`upi://pay?pa=Q44•••248@ybl&pn=PhonePeMerchant&mc=0000&mode=02&purpose=00` —
no amount, no transaction reference, and the generic payee name
"PhonePeMerchant". Original preserved byte-for-byte (sha256 `9ec79868…df609b`),
kept out of the public repository. Full record and the payee-verification steps:
`docs/QR-CAFE-READINESS.md`.

The QR does **not** identify Tulips; only the Tulips owner (PhonePe Business →
Profile) or Cashfree's beneficiary validation, once Payouts is active, can.

## 3. Decision and architecture

The QR is **not** used for checkout. A static QR cannot be tied to an order,
confirmed by a webhook, refunded, or made to carry the ₹10 platform fee and ₹15
delivery fee; a customer "returning from PhonePe" proves nothing. The supported
arrangement, already built and unchanged:

```
customer ──Cashfree PG (server-created order, UPI/card)──▶ ECHO ECHO collection
            confirmed only by signed webhook or server status pull
ledger per paid order:  platform_revenue  (₹10 fee)
                        delivery fee      (₹15 delivery / ₹0 pickup) → partner earning
                        cafeteria_payable (Tulips' menu subtotal)
Tulips ◀── café settlement payout (daily batch, admin release) ── only to a
           Cashfree-VERIFIED account registered for Tulips in Campus Control
   or ◀── Easy Split at payment time, only when Cashfree activates a Tulips
           vendor account and CASHFREE_EASY_SPLIT is on (both off today)
```

Money for Tulips is never described as reaching Tulips while it sits in the
collection: it is `cafeteria_payable` until a verified payout succeeds.

Re-verified in this run: webhook HMAC over the raw body, timestamp window,
idempotency on event id, duplicate events, status pull, refunds and
reconciliation (`payments-cashfree.test.mjs`, `reconciliation.test.mjs`,
`settlement.test.mjs`, `marketplace.test.mjs` in the full suite); Cashfree
sandbox order created and read back (₹115, pending — a sandbox order only
completes in Cashfree's hosted page).

## 4. What is needed to pay Tulips

| Step | Who |
|---|---|
| Cashfree → Payouts → Request Activation (KYC), then put production Payouts client id/secret and the 2FA public key on Render | owner |
| Tulips owner gives the settlement account — a **bank account is preferred**: a PhonePe merchant id (`…@ybl` beginning with `Q`) is a P2M collection id and Cashfree may refuse it as a payout beneficiary | Tulips owner |
| Register it in Campus Control → Cafés → Tulips → Settlement account; Cashfree validates the name; it must match the Tulips owner/business | administrator |
| Confirm the ECHO ECHO collection settlement bank account in Cashfree → Settlements | owner |
| Or, instead of payouts: ask Cashfree to enable Easy Split and onboard Tulips as a vendor (Tulips does the KYC), then switch `CASHFREE_EASY_SPLIT` on | owner + Tulips |

No real money moved in this work.
