# Money in Quad

Where every rupee is, who it belongs to, and how it eventually leaves.

## The worked example

A student orders ₹100 of food for delivery.

| | paise | |
|---|---:|---|
| Food subtotal | 10000 | sum of `order_item.line_paise` |
| Platform fee | 500 | charged to the customer |
| Delivery fee | 1000 | charged to the customer |
| **Customer pays** | **11500** | `order_financials.customer_total_paise` |
| Cafeteria payable | 9800 | food less 2% commission |
| Delivery payable | 1000 | what the partner earns |
| Quad gross | 700 | ₹5 platform fee + ₹2 commission |

The three allocations sum to the customer total. That is not a convention —
it is a `CHECK` constraint (`allocation_balances`) on `order_financials`, so
an order whose money does not add up cannot be written to the database.

## Answering the eight questions

**Where is the ₹115 recorded?**
`order_financials`, one immutable row per order, written inside the same
transaction that creates the order. It records the customer total, every
component of it, and the allocation. A trigger refuses every later `UPDATE`
and `DELETE` except a one-time write of the gateway fee.

**How does Quad know its ₹7?**
`ledger_account` of kind `platform_revenue`, credited 700 by the capture
posting. `v_account_balance` reports the running balance; the admin summary
reports gross and net (net = gross − refunded share − gateway fees).

**How does Quad know the cafeteria's payable?**
`ledger_account` of kind `cafeteria_payable` scoped to that vendor, credited
9800. `v_cafeteria_statement` turns the account into a statement: gross food
sales, commission, refunds, adjustments, net payable, settled, outstanding.

**How does Quad know the delivery partner's payable?**
At capture the 1000 goes to `delivery_clearing`, a platform-held account,
because nobody has earned it yet. When the handoff code is verified, a
`delivery_earned` transaction moves it to that partner's `delivery_payable`
account. A pickup order never has one; an undelivered order never pays one.

**How is each amount persisted?**
Double entry. Every posting is a set of `ledger_entry` rows sharing a
`ledger_txn`, and a deferred constraint trigger refuses to commit a
transaction whose entries do not sum to zero. Entries and transactions are
append-only — a trigger blocks `UPDATE` and `DELETE`. Corrections are new
entries, never edits.

**How is each amount settled?**
A settlement batch reads each payee's current ledger balance under a lock and
creates one `payout` per payee. The payout becomes `paid` only against
evidence: a provider payout id, or the bank reference (UTR) of a transfer an
administrator actually made. The `paid_has_evidence` CHECK enforces that in
the database. Paying posts a `payout` transaction that discharges the payable
and reduces the clearing account, so the outstanding balance is always
"earned minus paid" with no separate counter to drift.

**How are refunds handled?**
The gateway is called first; only once it confirms does the ledger give each
party back its share. The split is proportional to what each received, with
largest-remainder rounding so the parts sum to the refund exactly. If the
delivery was completed, `refund_delivery_policy` decides whether the partner
keeps the earning (`platform_absorbs`, the default — Quad funds that part) or
it is clawed back (`clawback_partner`). The split is recorded in
`refund_allocation`.

**How can Admin see all of it?**
Campus Control → Finance. Today's orders, GMV, platform fees, commissions,
delivery earnings, refunds, cafeteria payable, delivery payable, Quad revenue
gross and net, unsettled and settled, and the terms in force. Per-order:
`GET /admin/finance/orders/:id` returns the snapshot, the policy it was priced
under, and every ledger entry it produced.

## The ledger

Debit-positive. Assets and expenses are positive when they increase;
liabilities and revenue are negative when they increase. `v_account_balance`
flips the sign so a payable reads as a positive amount owed.

| Posting | Trigger | Idempotent on |
|---|---|---|
| `order_capture` | `payment.captured` webhook | payment id |
| `delivery_earned` | handoff code verified | order id |
| `refund` | gateway confirmed the refund | refund id |
| `payout` | transfer confirmed or recorded | payout id |
| `adjustment` | an administrator, with a reason | caller-supplied key |

`ledger_txn` holds `UNIQUE (kind, ref)`. That single index is why a webhook
retry, a replayed refund or a double-clicked payout cannot allocate money
twice — including the case the `payment_webhook` table does not catch, where
the *same* payment arrives under a *different* event id.

The capture of ₹115:

```
gateway_clearing    +11500
cafeteria_payable    -9800
delivery_clearing    -1000
platform_revenue      -700
                    -------
                         0
```

## The settlement schedule

Cafeterias settle **daily at 20:00 campus time**; delivery partners settle
**weekly on Mondays at 20:00**. Both are `platform_config` rows an
administrator can change from Campus Control without a deploy
(`PUT /admin/settlement/schedule`), including the timezone — "8 PM" means 8 PM
in `settlement_timezone`, never the server's own clock.

Nobody calculates an amount. The run reads each payee's ledger balance, which
is already `gross sales − commission − their share of refunds − adjustments −
everything previously paid`, and writes one pending payout per payee.

The lifecycle is four steps, and only the last one moves money:

```
built (scheduled)  →  reviewed  →  approved  →  released
   ledger balance      the admin    recorded     provider transfer, or
   becomes payouts     sees the     with who     an admin's own bank
   in state 'open'     arithmetic   and when     transfer + its UTR
```

`POST /admin/payouts/batches/:id/release` with no payout provider connected
returns the exact list of transfers to make and marks **nothing** paid. Each
one is then settled by `POST /admin/payouts/:id/record` with its UTR.

Three properties make a scheduled money job safe here:

- **It never moves money.** A run only builds. `settlement_auto_release`
  exists, defaults to `false`, and the route refuses to enable it while no
  payout provider is connected.
- **It is safe to run constantly.** Each scheduled batch carries the period it
  settles (`period_key`, e.g. `cafeteria:2026-09-07`, `partner:2026-W37`) and
  `(kind, period_key)` is `UNIQUE`. A restart loop at 20:00, a redeploy, or two
  instances side by side all produce exactly one batch for the evening.
- **It catches up.** The question asked each minute is "is it past 20:00 and is
  today's batch missing", not "did the clock just strike 20:00". A server that
  was down all evening builds the batch when it returns, settling the evening
  it missed rather than skipping a day.

A balance below `min_paise` rolls over to the next run rather than being paid
or written off. A failed payout can be retried
(`POST /admin/payouts/:id/retry`), which is safe because a failure never
touched the ledger — only a `paid` payout posts a discharging transaction, and
that posting is idempotent on the payout id.

## Pricing is versioned, never edited

`pricing_policy` holds the commercial terms: commission in basis points and
how it is treated, platform fee (flat + proportional), what delivery costs the
customer and what it pays the partner, tax, and who funds a discount. A vendor
row overrides the platform default.

Changing the terms closes the live row (`effective_to`) and inserts a new one.
A trigger refuses any other modification. Each order pins the policy id it was
priced under, so **no old order is ever recalculated from today's
configuration** — the guarantee the whole design exists for.

`delivery_fee_paise` and `partner_payout_pct` used to be `platform_config`
keys. They are not any more: `PUT /admin/config/:key` rejects them and points
at `PUT /admin/pricing`. Their values were carried into the initial policy by
migration 004, so the change is not a silent repricing.

## Nothing the client sends is trusted

`quote()` in `services/pricing.js` takes a subtotal computed from `menu_item`
rows and a policy read from the database. Commission, platform fee, delivery
earning, cafeteria payable and the total are not parameters — there is no
field a request could set. `POST /payments/intent` charges the snapshot's
total, and the webhook re-checks the captured amount against it, so a gateway
callback for less confirms nothing.

## What the payment gateway actually does

**A standard gateway account collects. It does not settle a marketplace.**
This is true of Cashfree and Razorpay alike, and it is the single most
commonly misunderstood thing about running a three-sided marketplace.

The customer's ₹115 lands in **one** Quad account, less the gateway's fee.
Nothing about that arrangement pays the cafeteria ₹98 or the partner ₹10.
Split-at-capture products — Cashfree **Easy Split**, Razorpay **Route** — are
separate products with their own onboarding and their own eligibility rules,
and **neither is implied by working checkout**. Quad does not assume access to
either, and no code path anywhere in this repository depends on one.

So the split lives in **Quad's own ledger**, which stays the source of truth
for allocation and reconciliation whatever the provider does, and the
disbursement is a separate outbound transfer, by one of three mechanisms:

- **`cashfree_payouts`** — a real call to the Cashfree Payouts API. Our payout
  id is the `transfer_id`, so a retry is rejected as a duplicate rather than
  paying twice. Only `SUCCESS` marks a payout paid; `RECEIVED`, `APPROVED` and
  `PENDING` mean *accepted*, not *paid*, and leave the payable outstanding.
- **`razorpayx`** — a real call to the RazorpayX Payouts API, keyed with
  `X-Payout-Idempotency` so a retry returns the original payout instead of
  making a second transfer. Only a `processed` response marks a payout paid;
  `queued` and `processing` leave the payable untouched.
- **`manual_bank_transfer`** — the administrator transfers the money and
  records the UTR. Always available. Nothing is marked settled without it.

There is no fourth mechanism, and no path that marks a payout paid because a
button was pressed. "Accepted by the provider" is not "paid", in the schema as
well as in the prose: the `paid_has_evidence` constraint refuses a `paid`
payout that has no provider payout id and no bank reference.

## Gateway charges, and why they are sometimes zero

`order_financials.gateway_fee_paise` is the one field of an otherwise
immutable financial snapshot that may be written after the fact, because when
the fee becomes knowable depends on the provider:

- **Razorpay** reports its fee on the captured payment entity, so the figure is
  recorded inside the same transaction that confirms the order. Quad's NET
  revenue is a fact from that moment.
- **Cashfree** does not report it on the payment webhook; it arrives in the
  daily settlement reconciliation report. So the field stays `0` and the
  finance dashboard reports gateway charges as **not yet known**.

It does **not** get estimated from a percentage. An estimate would flow into
the daily settlement batch, the cafeteria payable reconciliation and the
revenue line, and all three would be confidently wrong — and a number that is
quietly wrong cannot be found later, whereas one that is honestly incomplete
can be completed.

## Settlement reconciliation

The importer (`services/reconciliation.js`) is how the real figure arrives.
It reads the provider's own settlement reconciliation report, which is the
**only** source Quad accepts for a gateway fee — the payment webhook is
authoritative about whether money arrived, and about nothing else.

**Matching** is on immutable provider identifiers only: the provider payment
id, cross-checked against the provider order id. Never on amount, never on
time. Two students buying the same coffee in the same minute is an ordinary
Tuesday, and an amount match would pick one of them at random.

**What it writes**, and nothing else:

| | |
|---|---|
| `order_financials.gateway_fee_paise` | once, from zero, via the write-once exemption the immutability trigger already allowed |
| `payment.reconciled_at` / `settlement_id` | the explicit marker, plus its evidence |
| a ledger `adjustment` posting | `debit gateway_fee / credit gateway_clearing`, balanced, idempotent on the payment id |
| `provider_settlement_entry` | the provider's raw line, verbatim, kept forever |
| `reconciliation_exception` | every difference it could not explain |

**What it never writes:** any allocation value. The cafeteria payable, the
delivery earning and Quad's gross take are the immutable snapshot, and the
database trigger refuses to let reconciliation near them independently of
anything the code intends. The gateway's fee is Quad's cost of collecting,
not a deduction from someone else's money — a reconciliation that quietly
moved it onto a cafeteria would be taking their money to pay Quad's bill.

**Why `reconciled_at` is a column and not an inference.** It would be natural
to read "reconciled" off a non-zero fee. That is wrong here in the most
expensive possible way: under Cashfree's 0% offer the correct reconciled fee
is genuinely **zero** for the entire pilot, so inferring from the amount would
mark every properly reconciled order as outstanding and raise a missing-
transaction exception for every order Quad ever took.

### The nine differences it detects

| Exception | What it means |
|---|---|
| `missing_payment` | the provider settled something Quad has no payment for |
| `unsettled_payment` | Quad holds a captured payment the provider never settled — money taken from a student and not passed on |
| `order_mismatch` | the two provider identifiers point at different Quad records |
| `amount_mismatch` | the settled amount is not what Quad charged |
| `fee_mismatch` | a fee was already recorded and the report disagrees |
| `unexpected_deduction` | settlement ≠ amount − charge − tax, in either direction |
| `duplicate_provider_txn` | one payment settled under two settlement ids |
| `partial_settlement` | the provider settled part of a payment |
| `refund_unmatched` | the provider returned money Quad has no refund for |

Plus `payout_already_executed`, which is informational: reconciling after a
cafeteria was paid changes nothing, because the fee was never part of their
payable — but it is the first question anyone asks when a number moves, so it
is answered before it is asked.

Nothing is auto-resolved. Closing a difference requires a person, a reason of
at least ten characters, and an audit entry — and resolving records a
judgement rather than applying a fee.

### Running it

- **Automatically**, once a day, on the settlement scheduler's tick, over a
  rolling `RECON_LOOKBACK_DAYS` window (default 7). It runs *after* the payout
  batch build on purpose: making tonight's cafeteria payout wait on a
  provider API that may be slow would trade a real obligation for a
  bookkeeping one.
- **By hand**, `POST /admin/finance/reconciliation/import`, for a window, a
  settlement id, or a bank UTR.

Safe to run repeatedly, by three independent mechanisms: the settlement
entry's unique index, the ledger's `UNIQUE (kind, ref)`, and the snapshot's
write-once trigger. Any one would do; all three are present because this job
will be re-run by a cron and by hand during incidents, and "we ran it twice"
must never be a financial event.

**A 200 from the provider reconciles nothing.** A run is `completed` only when
every line was applied and no difference was found; `completed_with_exceptions`
when differences were found; `failed` when it could not finish. The import
endpoint returns `reconciled: false` for anything but a clean run, and
`/admin/finance/reconciliation` reports how much of the book is actually
reconciled — which is the number that says whether the net-revenue line can be
trusted yet.

### External provisioning blocker

RazorpayX requires a **RazorpayX current account** — a separate business
onboarding from the Razorpay account that collects payments — and each payee
must be provisioned there as a contact and fund account. Until that is done:

- `PAYOUT_PROVIDER` stays unset, `providerStatus().payouts.configured` is
  `false`, and `POST /admin/payouts/:id/execute` returns 503
  `configuration_required` with the reason.
- Amounts owed are still tracked exactly, and settlement runs through the
  manual path.
- Campus Control says so on the Finance screen rather than implying automatic
  payouts exist.

Quad never stores bank account numbers or IFSC codes. `payout_destination`
holds only the provider's opaque contact and fund-account ids.

## Who sees what

| | |
|---|---|
| `finance.read_all` | platform owner, admin, support — the whole books |
| `pricing.manage`, `payout.manage`, `finance.adjust` | owner and admin only; support may read but not change terms, adjust a balance or move money |
| `finance.read` (`own_vendor`) | cafeteria **owner** — its own statement only. Counter staff do not hold it |
| `finance.read` (`own`) | delivery partner — their own earnings only |

The scope is checked against the owning vendor or partner read from the
database, so changing an id in a URL is a 403. `GET /partner/earnings` reads
the session's own id; there is no parameter that widens it.

## Tables

| | |
|---|---|
| `pricing_policy` | versioned commercial terms; immutable except for closing |
| `order_financials` | the frozen per-order snapshot; immutable |
| `ledger_account` | one per party per kind, created on demand |
| `ledger_txn` / `ledger_entry` | append-only double entry, balanced by trigger |
| `refund_allocation` | how each refund was split |
| `payout_batch` / `payout` | settlement runs and individual transfers |
| `payout_destination` | provider ids for a payee; no bank details |
| `v_account_balance`, `v_cafeteria_statement`, `v_partner_statement` | reporting |

## Tests

`server/test/finance.test.mjs` (37 tests) and
`server/test/settlement.test.mjs` (22 tests), against real PostgreSQL through
the real Fastify stack.

Finance: the ₹115 allocation, commission in both treatments,
platform fee, delivery earning and when it is earned, cafeteria payable,
duplicate webhooks (same and different event ids), an unbalanced ledger
transaction being rejected by the database, snapshot/ledger/policy
immutability, unpaid cancellation, full and partial refunds, refund rounding,
refund after a completed delivery under both policies, duplicate and
concurrent refunds, batch building, execution with no provider, recorded
manual settlement, duplicate payouts, concurrent settlement, persistence
across a fresh connection, cafeteria/partner/customer/support isolation, and
client-side amount manipulation.

Settlement: the schedule read in campus time rather than the server's, the
weekly run firing only on its weekday, a disabled schedule, the 20:00 run
producing the payable with nobody typing a number, gross less commission less
refunds less adjustments reaching the payout exactly, repeated runs building
one batch per evening, three concurrent runs building one batch, a server that
was down at 20:00 catching up, the next evening being a new batch, an empty
evening, a sub-minimum balance rolling over, weekly partner settlement keyed by
ISO week, an undelivered order paying no partner, release refused before
approval, review showing the arithmetic, approval moving no money, release with
no provider paying nobody, retry after failure, a failed payout leaving the
ledger untouched, schedule validation, and role isolation.

Run with `cd server && npm test` for everything, or
`node runtests.mjs finance` / `node runtests.mjs settlement` for one group.
