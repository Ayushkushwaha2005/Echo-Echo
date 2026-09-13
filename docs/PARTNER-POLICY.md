# Delivery partner policy, as enforced

Everything below is enforced on the server (`routes/partner.js`, `routes/trust.js`,
`services/delivery.js`, `services/handover.js`) and covered by `test/trust.test.mjs`
and `test/handover.test.mjs`.

## Joining
1. Verified student (institutional email, or admin verification).
2. Complete profile: full name, contact number, campus.
3. Own photo uploaded (`POST /partner/photo`). Checked on the bytes: real JPEG/PNG,
   ≥ 320 px short edge, head-and-shoulders framing, not blank/flat, not reused from any
   other image on the platform. **Whether it shows this person's face is confirmed by
   the approving admin** — there is no automated face check.
4. Explicit acceptance of the live deposit policy version (`partner_policy_consent`).
5. Admin approval, which the server refuses without the photo, consent to the *current*
   version, and the required deposit recorded in the ledger.

## Handling an order
- **Accepting**: eligibility re-checked at the moment of acceptance; one order in a
  partner's care at a time; first accept wins (unique index).
- **Pickup**: only via the counter's code (`POST /orders/:id/pickup`), only for an order
  assigned to that partner. No other route reaches `picked_up`.
- **After pickup**: the order stays tied to that partner. A partner holds no capability to
  cancel, transition, reassign or edit an order, and cannot leave the programme while
  carrying one.
- **Handover**: only via the customer's code (`POST /orders/:id/handoff`). The delivery
  earning posts in the same transaction. A platform admin override exists only with a
  written reason and is recorded as an override.

## Problems
Customers, the partner, the cafeteria and admins can file a delivery incident (damaged,
tampered, missing, partner never received it, not delivered, wrong order, spilled).
A report changes nothing about anyone's status or money. An admin investigates and
resolves it with an outcome and a written finding.

## Security deposit
- Amount, dispute window and terms are a versioned policy set in Campus Control
  (starts at ₹0 — the amount is your decision).
- Held in a per-partner `partner_deposit` ledger account, backed by `deposit_bank`;
  never mixed with `delivery_payable` (earnings).
- **Collection**: by bank transfer/UPI to ECHO ECHO, recorded by an admin with the
  transaction reference. No card or account is ever charged automatically; the payment
  gateway integration is for orders and is not used for deposits.
- **Deduction** requires: an incident resolved as `partner_responsible`, amount ≤ available
  deposit, reason and evidence, proposal by a finance admin, partner notification, a
  dispute window. A disputed deduction must be upheld by a *different* admin (platform
  owner excepted). Money moves only on *Apply*, after the window or an upheld dispute.
  Every step is audited; the posting is an append-only ledger transaction.
- **Refund**: only after leaving (or rejection), with no delivery in progress, no open
  incident and no unfinished deduction. Paid by admin transfer, recorded with reference.
