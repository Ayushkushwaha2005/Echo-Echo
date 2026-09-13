# Payment and payout provider — research, recommendation, decision

Researched against current provider documentation and the RBI Master Direction
on Payment Aggregators (15 September 2025). Every figure below is quoted from a
provider's own published pricing page; **all of it must be confirmed in writing
with the provider's sales team before you sign**, because published pricing in
this market is a starting point for negotiation and changes without notice.

---

## 1. The finding that decides this

**Provider-backed split settlement is not available to Quad at pilot scale.**

The RBI Master Direction of 15 September 2025 restricts split settlement and
linked-account arrangements to merchants above a turnover threshold:

| | Threshold |
|---|---|
| Domestic turnover | **> ₹40 lakh**, evidenced by GST-3B returns |
| Export turnover | > ₹5 lakh, evidenced by a bank-issued FIRC |

Razorpay's own Route documentation states this requirement directly and notes
that accounts which did not submit the evidence by 31 December 2025 had Route
access **disabled**. This is a regulatory limit, not a Razorpay commercial
choice, so it applies to **Cashfree Easy Split on the same terms**.

A new campus pilot with 3–10 cafeterias will not have ₹40 lakh of turnover or
the GST-3B returns to prove it. Concretely:

> The architecture in the brief — *customer pays ₹115 → provider splits →
> cafeteria receives ₹98 automatically* — **cannot be switched on for the
> pilot.** Not because of anything in Quad's code, and not because of a
> provider's product limits, but because Quad is not yet eligible.

### What this means for the design

It vindicates the architecture already built, and no code needed to change to
accommodate it:

1. **Collect** the customer's ₹115 into one Quad account.
2. **Allocate** it immediately in Quad's own double-entry ledger — cafeteria
   payable ₹98, delivery clearing ₹10, platform revenue ₹7 — inside the same
   transaction that confirms the order.
3. **Disburse** by outbound payout: cafeterias daily, partners weekly, each
   for the payee's exact current ledger balance.

The ledger is the source of truth for accounting and reconciliation in *both*
models. Split settlement, when Quad qualifies for it, changes only step 3 —
who executes the transfer — not the numbers, which are computed identically
either way. That is why `payout.method` is a column and the provider sits
behind an adapter.

**Cross this threshold and revisit.** Once Quad has four quarters of GST-3B
above ₹40 lakh, split settlement becomes worth applying for: it removes the
float Quad holds between capture and payout, which is the main operational risk
of the collect-and-disburse model.

---

## 2. Options compared

| | Razorpay | Cashfree |
|---|---|---|
| Gateway — UPI | **2%** platform fee (zero MDR, fee charged anyway) | **"as per applicable law"** — effectively 0% under zero-MDR |
| Gateway — credit card | 2% | 1.95% |
| Gateway — international | up to 3% | 2.99% (Amex 2.95%) |
| Setup / AMC | ₹0 | ₹0 |
| Split product | Route — **0.1% + gateway fees** | Easy Split — **0.20%** |
| Split eligibility | ₹40L turnover (RBI) | ₹40L turnover (RBI) |
| Payouts | RazorpayX — **quarterly subscription** from ₹2,476 (Core) up to ₹34,688 (Vendor Payments) | Pay-per-transfer: NEFT ₹3–8, IMPS/UPI ₹6–15 |
| Instant settlement | available | 0.30% |
| Current offer | — | **0% platform fee on domestic gateway transactions up to ₹20 lakh GMV**, for merchants signing up on or after 21 July 2026, running to 31 March 2027 |

GST at 18% applies on top of all fees for both providers.

---

## 3. Recommendation: **Cashfree**

Not because Cashfree is a better company than Razorpay, but because of three
things specific to Quad's shape.

### a. UPI pricing is the whole argument

Campus food ordering is almost entirely UPI. On a ₹115 order, Quad's gross take
is ₹7 — ₹5 platform fee plus ₹2 commission.

| | Razorpay | Cashfree (in offer) | Cashfree (after offer) |
|---|---|---|---|
| Gateway fee on ₹115 UPI | ₹2.30 (2%) | ₹0 | ~₹0 (zero-MDR) |
| + 18% GST | ₹0.41 | ₹0 | ₹0 |
| **Total cost** | **₹2.71** | **₹0** | **~₹0** |
| **% of Quad's ₹7 revenue** | **39%** | **0%** | **~0%** |

Razorpay charges a 2% platform fee on UPI even though the MDR itself is zero.
That fee would consume roughly **two fifths of Quad's gross margin on every
order**, permanently. This alone decides it.

*Caveat to verify:* Parliament amended the zero-MDR law in August 2026 to allow
MDR on large merchants above a turnover threshold. Quad is far below any such
threshold, and the government has restated that UPI stays free for users — but
confirm Cashfree's UPI rate for your specific MCC in writing.

### b. Payout cost structure suits a pilot

RazorpayX bills a **quarterly subscription** — from ₹2,476 for Core. At pilot
volume that is a fixed cost against near-zero volume. Cashfree Payouts is
**pay-per-transfer**.

Quad's payout pattern is daily cafeteria settlements plus weekly partner
settlements. With 5 cafeterias and 10 partners:

- Cafeterias: 5 × 30 = 150 transfers/month
- Partners: 10 × 4 = 40 transfers/month
- **190 transfers/month at IMPS ₹6–15 ≈ ₹1,140–2,850/month**

versus RazorpayX's ₹2,476/quarter (≈₹825/month) **plus** its own per-transfer
charges. The two are closer than they look, and if payout volume grows a lot,
re-run this comparison — the subscription may win at scale. **Use NEFT (₹3–8)
rather than IMPS for scheduled evening settlements**: nothing about a daily
20:00 batch needs instant transfer, and it roughly halves the cost.

### c. The ₹20 lakh offer covers the entire pilot — IF Quad is eligible

0% platform fee on domestic gateway transactions up to ₹20 lakh cumulative
GMV, through 31 March 2027. At ₹115 per order that is ~17,000 orders of free
processing — comfortably the whole pilot and well beyond.

**Eligibility, checked against Cashfree's published terms (September 2026) and
NOT assumed by any code in this repository:**

| Condition | Value |
|---|---|
| Who qualifies | Merchants signing up **on or after 21 July 2026, 12:00 IST** |
| Who does not | Any account that processed a transaction with Cashfree before that date |
| Cap | ₹20,00,000 cumulative GMV, whichever comes first |
| Ends | 31 March 2027, or at the cap |
| Activation | Automatic on KYC approval — no promo code, no first transaction needed |
| Excluded | Prepaid cards and other excluded methods, always at standard rate |
| Standard rate after | **1.95% + GST**, applied automatically |

**Verify this against your own dashboard before launch.** The offer is dated,
capped, and conditioned on a signup date; if Quad's Cashfree account predates
21 July 2026 it does not apply and the economics above become the 1.95% row,
not the 0% row.

**No code depends on this.** Quad never assumes a gateway rate. Gateway charges
are recorded from actual provider data when the provider reports them, and
reported as *not yet known* when it does not — see §6 below. A percentage
guessed at capture time and presented as a fact is how a net-revenue line stops
being true, and the finance dashboard would carry the lie all the way to the
settlement batch.

### Why not Razorpay, given the code already used it

The existing Razorpay integration is for **collection**, and it is good work:
signature-verified webhooks, idempotency, amount revalidation. But the
2%-on-UPI cost is structural and permanent, and choosing a provider to avoid
rewriting a webhook handler would be the tail wagging the dog.

**This is now resolved rather than argued about.** Collection has been moved
behind the same adapter seam that payouts already used
(`services/payment-providers.js`), and **both** providers are implemented and
tested. `PAYMENT_PROVIDER=cashfree` or `PAYMENT_PROVIDER=razorpay` selects one;
nothing in orders, pricing, the ledger, settlement or payouts names a gateway.

That matters for a launch three days out for a reason that has nothing to do
with pricing: **if one provider's KYC stalls, switching is an environment
variable, not a sprint.** Collection and payouts also remain separate
decisions — Razorpay collection with Cashfree Payouts is a supported
combination, as is Cashfree for both.

---

## 4. Cost per ₹100 order (₹115 charged)

Assuming UPI, Cashfree, inside the offer:

| Line | Amount |
|---|---|
| Customer pays | ₹115.00 |
| Gateway fee | ₹0.00 (offer) / ~₹0.00 (zero-MDR after) |
| Cafeteria receives | ₹98.00 |
| Delivery partner receives | ₹10.00 |
| **Quad gross** | **₹7.00** |
| Cafeteria payout cost (NEFT, amortised over a day's orders) | ₹3–8 **per settlement, not per order** |
| Partner payout cost (NEFT, weekly) | ₹3–8 **per settlement, not per order** |
| **Quad net** | **≈ ₹7.00 less a few paise of amortised payout cost** |

The payout charge is per *transfer*, not per order — a cafeteria doing 40
orders a day pays one ₹3–8 NEFT charge against ₹80 of commission. This is
exactly why daily batching beats per-order disbursement, and why the settlement
scheduler is built the way it is.

Under Razorpay the same order nets **₹4.29** instead of ₹7.00.

---

## 5. What Quad's code does about all this

Nothing in the order, pricing, settlement, payout or ledger layers names a
provider. **Collection:**

- `services/payment-providers.js` — adapters (`cashfree`, `razorpay`), one
  interface: `createOrder`, `verifyWebhook`, `readEvent`, `fetchOrder`,
  `refund`. Every provider outcome is normalised to
  `paid | failed | dropped | pending | unknown` and integer paise, so the
  route's checks are identical for every gateway.
- `routes/payments.js` — `applyOutcome()` is the ONLY function that can mark a
  payment paid, and both authoritative paths (the signed webhook and the
  server-side status pull) go through it. A check only one path performs is a
  check an attacker gets to choose to avoid.
- Migration 008 adds the checkout-session handle, the investigation flag, and
  a database CHECK that a flagged payment can never be `paid`.

**Payouts:**

- `services/payout-providers.js` — adapters (`razorpayx`, `cashfree`), one
  interface, `settled: true` only when money has actually left.
- `services/payouts.js` — `sendToProvider()` is the only seam; batch building
  and settlement are provider-blind.
- `config.js` — `PAYOUTS.provider` selects the adapter; `PAYOUTS.method` is
  what gets written to `payout.method`.
- Migration 007 widens `payout.method` to the closed set of supported rails.

Switching provider is a change of environment variables plus provisioning each
payee at the new provider. `test/settlement.test.mjs` drives both adapters
through the identical settlement path against wire-format stubs.

**Not yet built, because it needs eligibility that does not exist:** the
split-at-capture path (Route / Easy Split). When Quad qualifies, that is a
third adapter plus a transfer block on the payment-intent call — the ledger,
the pricing policy and the reconciliation views do not change.


---

## 6. Gateway charges: what is known, and when

The two providers differ in a way that shows up directly on the finance
dashboard, so it is worth being explicit rather than discovering it during
month-end reconciliation.

| | Razorpay | Cashfree |
|---|---|---|
| Fee reported on the payment webhook | **Yes** (`fee` on the captured entity) | **No** |
| When Quad learns the fee | At capture | In settlement reconciliation |
| `order_financials.gateway_fee_paise` at capture | The real figure | `0` |

`gateway_fee_paise` is the one field of an otherwise immutable financial
snapshot that may be written late, precisely for this. Under Cashfree it stays
0 until real settlement data arrives, and Quad's **net** revenue is reported as
gross-less-known-charges rather than gross-less-an-estimate.

This is a deliberate choice and it was made explicitly: an estimated fee
presented as a fact would flow into the daily settlement batch, the cafeteria
payable reconciliation and the revenue line, and every one of those would be
confidently wrong. A number that is honestly incomplete can be completed; a
number that is quietly wrong cannot be found.

**Built.** `services/reconciliation.js` imports Cashfree's settlement
reconciliation report (`POST /pg/settlement/recon`), matches each line to a
Quad payment on immutable provider identifiers, records the actual
`service_charge` + `service_tax`, and posts a balanced ledger correction. It
runs automatically once a day on the settlement scheduler's tick and can be
run by hand for a window, a settlement id or a UTR. See `docs/FINANCE.md` for
the full contract and the nine differences it detects.

The remaining gap is not code: the response shape above is implemented from
Cashfree's published documentation and exercised against a local server
speaking that format, but **no live report has been read**, because that needs
an account. If the live payload differs, the adapter's field mapping in
`cashfree.fetchSettlements()` is the one place that changes — and it fails
closed: a field it cannot read exactly becomes `null`, the line is refused
rather than estimated, and an exception is raised.

---

## 7. Verification status of the claims in this document

| Claim | Source | Verified |
|---|---|---|
| Cashfree 0% offer terms, eligibility, cap, end date | Cashfree pricing FAQ, Sept 2026 | ✅ read at implementation time |
| Standard rate 1.95% + GST | same | ✅ |
| PG order API, `x-api-version: 2026-01-01`, `payment_session_id` | Cashfree API reference | ✅ |
| Webhook signature = Base64(HMAC-SHA256(timestamp + rawBody, secret)) | Cashfree webhooks doc | ✅ implemented and tested against the documented algorithm |
| Cashfree does not report its fee on the PG payment webhook | Cashfree webhook payload schema | ✅ |
| **Quad's own merchant eligibility for the 0% offer** | Cashfree dashboard | ❌ **requires the account — check before launch** |
| **Easy Split / marketplace settlement availability for Quad** | Cashfree approval | ❌ **not assumed anywhere; the ledger + Payouts path stands regardless** |
| That Cashfree accepts Quad's actual API requests | sandbox credentials | ❌ **blocked — see the acceptance gate in the implementation report** |
| Settlement recon endpoint `POST /pg/settlement/recon`, cursor pagination | Cashfree API reference | ✅ |
| Recon line fields (`cf_payment_id`, `cf_settlement_id`, `service_charge`, `service_tax`, `settlement_amount`, `transfer_utr`) | Cashfree SDK schema docs | ✅ documented; ❌ **not yet seen in a live report** |
