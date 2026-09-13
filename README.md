# Quad

Campus commerce platform. **Quad** is the platform; **Frisco**, **Chai Garam**
and **Tulips** are cafeterias trading on it.

```
server/               Fastify + Postgres API — the authority for everything
  src/db/             schema, migrations, dev seed
  src/auth/           rbac.js (the gate) · session.js
  src/routes/         auth · catalog · campus · orders · payments ·
                      partner · verification · admin · finance · ai
  src/services/       otp · handover · campus · delivery · verification ·
                      storage · flags · ai-tools · pricing · ledger ·
                      payouts · payout-providers · settlement · sweeper
brand/logo.js         the Quad mark, lockup, favicon, mono/light/dark
packages/
  design-system/      tokens.css + components.css (unchanged) + web.css
  data/client.js      the browser's only data source: HTTP to server/
  ui/login.js         phone → OTP gateway, shared by every surface
web/ admin/ shop/     student site · Campus Control · Counter
prototype/            🔒 LOCKED — original approved visual reference
```

## Run locally

Three processes, each in its own terminal, from the repository root.

```bash
cd server && npm install && cd ..
cp server/.env.example server/.env   # set PLATFORM_OWNER_PHONE; DATABASE_URL
                                     # postgres://quad:quad@localhost:55433/quad

npm run db          # 1. PostgreSQL (embedded binaries, server/var/pgdev) — keep running
npm run migrate     #    once, and after pulling new migrations
npm run seed        #    dev only: 3 cafeterias (closed), menus, campus tree
npm run api         # 2. API on http://localhost:8080 — keep running
npm run web         # 3. builds dist/ and serves it on http://localhost:3000 — keep running
npm run enrol:owner #    prints a one-time sign-in code for the platform owner
```

| Surface | URL |
|---|---|
| Customer site (and the delivery-partner screens) | http://localhost:3000/web/ |
| Campus Control | http://localhost:3000/admin/ |
| Counter | http://localhost:3000/shop/ |
| API health / readiness | http://localhost:8080/health · /ready |

The development database is separate from the test cluster on purpose: the
test runner recreates and stops `server/var/pgdata`, and must never take the
running site down. `npm test` runs the full suite against real PostgreSQL.

The server **refuses to start** without `DATABASE_URL` and
`PLATFORM_OWNER_PHONE`, and prints exactly which capabilities are inert
because their provider is missing. Production deployment: docs/DEPLOY.md.
## What is enforced, and where

Authorization moved out of the browser. `packages/data/api.js` still exists as
the prototype's fixture, but it is no longer the source of truth — the gate is
`server/src/auth/rbac.js`, called with an actor derived from a session cookie
whose hash is in Postgres, against a resource whose owning vendor is read from
the database rather than taken from the request body.

| Rule | Where it actually lives |
|---|---|
| Role of the caller | `user_role` rows, re-read every request |
| Landing surface | `landingSurface()` server-side — no client role picker |
| `platform_owner` | `PLATFORM_OWNER_PHONE` at migration; ungrantable over the API |
| Off-campus delivery | `food_order.destination_id` FK → `campus_node`; no address column exists |
| Historical prices | `order_item.unit_paise_snapshot`, written once |
| Order confirmed | only `POST /payments/webhook` after HMAC verification |
| Commission, fees, earnings | `services/pricing.js` from a `pricing_policy` row; no request field reaches it |
| Where the money went | `order_financials` (immutable) + double-entry `ledger_entry` (append-only) |
| Terms of an old order | `order_financials.pricing_policy_id`; never recalculated from today's config |
| No money allocated twice | `ledger_txn` `UNIQUE (kind, ref)` |
| A payout is really paid | `payout.paid_has_evidence` CHECK — a provider id or a bank UTR |
| One settlement per period | `payout_batch` `UNIQUE (kind, period_key)` |
| Review authenticity | `review.order_item_id` FK + partial unique indexes |
| One delivery per order | `one_accepted_offer_per_order` partial unique index |

## Money

See [docs/FINANCE.md](docs/FINANCE.md). Briefly: the customer pays a
server-computed total, an immutable snapshot records where every paisa of it
belongs, and a double-entry ledger holds the balances. Razorpay **collects**;
it does not settle a marketplace, so cafeteria and partner settlement is
Quad's own ledger plus an outbound transfer — RazorpayX if provisioned,
otherwise a transfer an administrator makes and records with its UTR. Nothing
is ever marked settled without evidence that money moved.

## Honesty rules

No fixed OTP, no auto-accepted code, no simulated payment, no auto-approved ID,
no seeded ratings. Where a provider is absent the API returns `503` with
`code: "configuration_required"` and the surface renders that state.

Ratings return `null` until a delivered order produces a review, so the UI shows
**No ratings yet** rather than an invented 4.8.

## Campus data

UPES Bidholi's schools, library, grounds and courts are documented publicly and
are seeded with `source: 'public_source'`. Individual hostel block names, floors,
room numbers, GPS coordinates and internal distances are **not** publicly
published, so they are not invented: hostels are seeded as a container with
delivery disabled, coordinates are `NULL`, and the boundary polygon is empty
until an administrator draws it. Live location returns
`no_boundary_configured` until then.

## Not done

Provider provisioning, not code:

- **RazorpayX has not been provisioned.** A plain Razorpay account collects;
  it does not settle a marketplace. Until a RazorpayX current account exists
  and each payee is provisioned there, settlements are transfers an
  administrator makes and records with the bank's UTR. Amounts owed are
  tracked exactly either way. See [docs/FINANCE.md](docs/FINANCE.md).
- No notification provider, so email notifications record as unsent.
- The S3 adapter throws rather than silently writing to disk, so production
  needs `STORAGE_PROVIDER=s3` with credentials.

Each of these is reported by `providerStatus()`, refuses with `503
configuration_required` at the route, and renders as an unavailable state on
the surface. None of them is a silent fallback.

The surfaces DO now render from `packages/data/client.js` (via
`packages/ui/runtime.js`); the prototype's in-memory modules are never copied
into `dist/` and the build audit fails if anything shipped imports them.
