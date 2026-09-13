# Production checklist

One list, top to bottom. Detail for each step: [DEPLOY.md](DEPLOY.md).
Zero-cost stack and its limits: DEPLOY.md section 0.

## READY IN CODE (done and tested — no action)

- [x] Student sign-in: exact `@stu.upes.ac.in` → 6-digit code (HMAC-hashed, 10 min, single use, 5 attempts, 60 s resend, 5/h & 12/day per address, 30/h per network address) → VERIFIED
- [x] Email free-tier guard: counts every send; stops at 95/day and 2,900/month (below Resend Free's 100 / 3,000), keeps 5 for admin invitations; provider errors and quota refusals return a generic 503, details logged server-side only
- [x] **Granular administrator permissions** (54 permissions, owner-only powers, role ceilings), enforced server-side on every request
- [x] **Owner-managed administrator lifecycle**: invite by email with chosen permissions, change permissions, suspend, restore, revoke, sign out everywhere, activity and last sign-in
- [x] Invitations keyed by email; no account exists until the mailbox is proven; code hashed, single use, expiring
- [x] Administrator passkeys (WebAuthn), recovery codes, fresh-passkey confirmation for sensitive actions, credential and session revocation
- [x] Changes to permissions/suspension/revocation apply to already-open sessions immediately
- [x] Audit log records actor, action, target, time, outcome, reason/before-after; **append-only in the database**
- [x] Bidholi in service; Kandholi refused on every path
- [x] Fail-closed delivery: no confirmed boundary → no delivery; outside boundary refused; **no recorded position refused; pending (unconfirmed) locations refused**; low/unknown-accuracy and near-edge GPS gives no suggestion
- [x] Walking-time ranges only between recorded points ("Approx. 5–8 min")
- [x] CSRF, RBAC, row-level scope checks, IDOR tests, secure cookies, HSTS with secure cookies
- [x] Ledger append-only and balanced; payment code intact and deferred
- [x] `/health` (no DB), `/ready` (DB, migrations, seed rows, providers), graceful shutdown, redacted structured logs
- [x] Production startup guard (secrets, HTTPS origins, TLS DB, S3 storage, passkeys, RP ID, email/OTP, payment or explicit `PAYMENTS_DEFERRED`)
- [x] Migrations 001–017 (tested on an empty database and as an upgrade of the dev database); seed refuses production
- [x] Field geodata workflow: on-site GPS capture in Campus Control, CSV/GPX/GeoJSON point import with preview, batch confirmation (passkey + note), distance/ETA matrix, walked-perimeter import compared against the OSM proposal — see [CAMPUS-FIELD-COLLECTION.md](CAMPUS-FIELD-COLLECTION.md)
- [x] Launch readiness list in Campus Control → Platform (done / pending / deferred for every external dependency)
- [x] Optional mailbox re-proof window `STUDENT_EMAIL_REVERIFY_DAYS` (alumni-mailbox mitigation, off by default)
- [x] Operator self-tests against real providers: `npm run check:db`, `check:storage` (including "bucket is private"), `check:email`
- [x] Daily encrypted off-site DB dump workflow (`.github/workflows/db-backup.yml`)

## REQUIRES YOUR DECISION / ACCOUNT (before deploy)

- [ ] **A domain name you own** (the only unavoidable cost — needed for Resend and for same-site cookies; see DEPLOY.md §0). Not purchased.
- [ ] GitHub repository (private is fine) — Render deploys from it and it runs the backup job
- [ ] **Render** account (free, no card) — API web service + 3 static sites
- [ ] **Neon** account (free, no card), project in Singapore → direct `DATABASE_URL`
- [ ] **Backblaze B2** account (free, no card) → assets bucket (private) + backups bucket (private) + two restricted keys; Caps & Alerts set to free amounts
- [ ] **Resend** account (free), `mail.<domain>` verified with SPF/DKIM/DMARC → sending-only API key
- [ ] **UptimeRobot** account (free) → monitor `https://api.<domain>/health`
- [ ] `COOKIE_SECRET` (`openssl rand -hex 32`) and backup passphrase, in your password manager
- [ ] **Anushka's real UPES email** (only needed when you invite her)

## DEPLOYMENT

- [ ] Environment set as in DEPLOY.md §§1–6, including `PAYMENTS_DEFERRED=true`, `SWEEPER=off`, `TRUST_PROXY=true`
- [ ] `npm run migrate` against Neon (before starting the API)
- [ ] `npm run check:db`, `check:storage`, `check:email -- <your UPES address>` all ✓
- [ ] Deploy API; `/ready` → `ready: true`, `pending: []`, `developmentSeedRows: 0`
- [ ] `QUAD_API_BASE=https://api.<domain> node build.mjs --production`; deploy `dist/web`, `dist/admin`, `dist/shop`
- [ ] Run the db-backup workflow once; confirm the encrypted dump is in B2

## AFTER DEPLOYMENT (on the live system)

- [ ] Ayush: email-code sign-in → Render Shell `npm run admin:invite -- ayush.17551@stu.upes.ac.in` → passkey → **recovery codes offline** → second device
- [ ] Invite Anushka from Administrators with the permissions you choose
- [ ] Create Chai Garam, Frisco, Tulips; assign owners; issue their enrolment codes in person
- [ ] Owners add real menus, prices and hours in Counter
- [ ] Upload one menu photo and view it
- [ ] Publish the partner deposit policy (₹0 until you decide)
- [ ] One restore drill from the B2 dump into a Neon branch ([BACKUP-RECOVERY.md](BACKUP-RECOVERY.md))

## REQUIRES MANUAL VERIFICATION (on campus)

- [ ] Walk/compare the proposed Bidholi boundary; then Locations → Confirm and activate (needs `boundary.confirm` + passkey)
- [ ] Walk the perimeter with a GPS logger; import it; compare with the OSM proposal; confirm only if it matches
- [ ] Record Frisco, Tulips, Chai Garam counters and every legitimate delivery point on site ([CAMPUS-FIELD-COLLECTION.md](CAMPUS-FIELD-COLLECTION.md))
- [ ] Confirm or archive the two pending OSM candidates (Energy Block, Infirmary)
- [ ] Ask UPES IT when student mailboxes are disabled after leaving; set `STUDENT_EMAIL_REVERIFY_DAYS` if applicable
- [ ] Add each real delivery point with measured coordinates and its source (hostel office list, signage, on-site measurement)
- [ ] Measure and set each cafeteria's pickup point (enables walking-time estimates)
- [ ] Confirm with UPES that student partners may deliver inside campus and hostels
- [ ] Check that code emails reach UPES inboxes (not quarantine)

## PAYMENT / KYC (deferred on purpose)

- [ ] Cashfree (recommended) or Razorpay KYC
- [ ] `PAYMENT_PROVIDER` + credentials; remove `PAYMENTS_DEFERRED`
- [ ] Webhook at `https://api.<domain>/payments/webhook`
- [ ] Re-enable the sweeper (and reassess the free database, DEPLOY.md §0)
- [ ] One live low-value payment, refund and reconciliation run
