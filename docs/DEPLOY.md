# Deploying ECHO ECHO

The production path, in order. Every step says what is done in code, what
needs your account, and what can only be done once servers are up. The single
tick-list is [PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md).

The payment gateway is **deliberately deferred** (`PAYMENTS_DEFERRED=true`).
Nothing below needs payment credentials.

Goal for this stage: **no new paid service**. Every provider below was checked
against its own pricing/documentation on **13 September 2026**. Re-check before
signing up — free tiers change.

---

## 0. The zero-cost stack, and its honest limits

| Piece | Choice | Free-tier limits (official source, 13 Sep 2026) | At the limit | Card needed? |
|---|---|---|---|---|
| API hosting | **Render** free web service | 750 instance-hours/month per workspace; spins down after 15 min without inbound traffic; ephemeral filesystem; custom domains + TLS included ([render.com/docs/free](https://render.com/docs/free)) | service is suspended, not billed | No |
| Static surfaces | **Render** static sites (or Cloudflare Pages) | free static hosting with TLS | — | No |
| PostgreSQL | **Neon** Free | 0.5 GB storage/project, 100 CU-hours/month/project, scale-to-zero after 5 min, 6-hour point-in-time restore (1 GB), no card ([neon.com/pricing](https://neon.com/pricing)) | compute **suspends until next month** — not billed | No |
| Object storage | **Backblaze B2** | first 10 GB stored free; Class A/B/C calls free, 2,500 Class D/day free; free egress up to 3× stored ([backblaze.com/cloud-storage/pricing](https://www.backblaze.com/cloud-storage/pricing)) | accounts without a card are capped at 10 GB (uploads refused with `storage_cap_exceeded`, per B2 client reports); set Caps & Alerts in the console | No |
| Email | **Resend** Free | 3,000 emails/month, 100/day, no overage fee; **needs a domain you verify by DNS** ([resend.com/pricing](https://resend.com/pricing), [domains doc](https://resend.com/docs/dashboard/domains/introduction)) | HTTP 429 `daily_quota_exceeded` / `monthly_quota_exceeded` — not billed. ECHO ECHO stops itself at 95/day and 2,900/month first | No |
| DNS + HTTPS | Cloudflare DNS (free) or your registrar's DNS; TLS from Render | — | — | No |
| Uptime monitoring | **UptimeRobot** Free | 50 monitors, 5-minute interval; described as "for hobby and non-profit projects" ([uptimerobot.com/pricing](https://uptimerobot.com/pricing/)) | — | No |
| Off-site DB backups | **GitHub Actions** + B2 | private repos 2,000 min/month; "usage is blocked once you use up your quota" without a payment method ([docs.github.com](https://docs.github.com/en/billing/concepts/product-billing/github-actions)) | jobs stop, not billed | No |

**Rejected, and why**

- **Cloudflare R2** (10 GB, 1M Class A, 10M Class B free): enabling R2 requires
  a payment method on file, and usage beyond the free tier is then billed. It
  does not fail closed, so it is not the zero-cost choice. The S3 adapter
  still supports it if you later prefer it.
- **Render free Postgres**: expires 30 days after creation and has no backups.
- **Supabase free Postgres**: 500 MB, projects pause after 1 week of
  inactivity, and backups are not included on the Free plan
  ([supabase.com/pricing](https://supabase.com/pricing)).
- **Vercel / Netlify** for the API: serverless; the API is a long-running
  Fastify process with in-process schedulers.

**What is NOT free and cannot be avoided: a domain name.** Two independent
reasons:

1. Resend only emails other people's mailboxes from a domain you verify. The
   `resend.dev` test domain delivers only to your own account address, so
   without a domain **no student can receive a sign-in code**.
2. `onrender.com` is on the Public Suffix List (checked 13 Sep 2026), so
   `api-x.onrender.com` and `web-x.onrender.com` are different *sites*. The
   `SameSite=Lax` session cookie would not flow between the student site and
   the API. With your own domain, `echoecho.in` and `api.echoecho.in` are the
   same site.

Nothing was purchased. Buying a domain is your decision (see section 1).

**What the free stack cannot guarantee for a real launch**

- **Cold starts.** Render free spins down after 15 minutes idle; the first
  request afterwards waits for the instance to boot (typically tens of
  seconds). An UptimeRobot check on `/health` every 5 minutes keeps it awake
  (one service × ~730 h ≤ 750 h/month) — `/health` does not touch the database,
  so it does not keep Neon awake.
- **Database compute.** 100 CU-hours at Neon's 0.25 CU minimum is ~400 awake
  hours a month (~13 h/day). The in-process sweeper and settlement scheduler
  query the database every 30/60 s, which would keep it awake 24/7 (~180
  CU-hours) and exhaust the quota mid-month. **While `PAYMENTS_DEFERRED=true`
  there are no orders to sweep: run with `SWEEPER=off`.** When ordering opens,
  either raise `SWEEPER_INTERVAL_SECONDS` substantially or move to a paid
  database — the sweeper cancels unpaid orders and expires delivery offers.
- **Backups.** Neon Free keeps 6 hours of history. That is not a backup
  strategy; section 2 adds a daily off-site dump.
- **Email volume.** 100 emails/day is roughly 100 student sign-ins a day.
  Fine for a pilot, not for a campus-wide launch day.
- **Storage.** 10 GB is plenty for menu photos and partner photos (ID images
  are purged after 90 days).

---

## 1. Domain and HTTPS — requires your decision

1. Buy (or use one you already own) a registrable domain. Do not use a free
   subdomain host — see section 0.
2. Point DNS at Cloudflare (free) or keep your registrar's DNS.
3. Layout:

| Host | Serves | Render resource |
|---|---|---|
| `echoecho.in` | student site (`dist/web`) | static site |
| `admin.echoecho.in` | Campus Control (`dist/admin`) | static site |
| `counter.echoecho.in` | Counter (`dist/shop`) | static site |
| `api.echoecho.in` | API | web service |
| `mail.echoecho.in` | Resend sending subdomain (DNS records only) | — |

4. Add each custom domain in Render; it issues TLS certificates. If DNS is on
   Cloudflare, use **DNS only (grey cloud)** for Render hosts so Render can
   issue and renew certificates.

Configuration that depends on the domain:

```
WEB_ORIGIN=https://echoecho.in,https://admin.echoecho.in,https://counter.echoecho.in
WEBAUTHN_RP_ID=echoecho.in
WEBAUTHN_ORIGINS=https://admin.echoecho.in,https://counter.echoecho.in
SECURE_COOKIES=true
TRUST_PROXY=true          # Render terminates TLS and sets X-Forwarded-For
```

The server refuses to start in production with a non-https origin, a
localhost origin, insecure cookies, a missing `WEBAUTHN_RP_ID`, or a WebAuthn
origin that is not on the RP ID. The API sends HSTS (`max-age=31536000;
includeSubDomains`) whenever secure cookies are on — only enable that once
every subdomain you use serves HTTPS. The surfaces load no `http://` resources
(the production build audit rejects `localhost` and http references).

## 2. Database — Neon Free

1. Create a Neon project in **AWS Asia Pacific (Singapore)** (closest to
   Dehradun). Postgres 16 or 17.
2. Copy the **direct** (non-pooled) connection string. ECHO ECHO runs one
   instance with a small pool; the direct endpoint supports the startup
   parameters it sets (`statement_timeout`) and is what migrations and
   `pg_dump` need.
3. Configure:

   ```
   DATABASE_URL=postgresql://<user>:<password>@<host>/<db>?sslmode=require
   PGSSLMODE=require
   PG_POOL_MAX=5
   PG_IDLE_TIMEOUT_MS=30000      # idle connections close, so Neon can scale to zero
   SWEEPER=off                    # while PAYMENTS_DEFERRED=true — see section 0
   ```

   Neon is reachable from the internet but only with the password over TLS.
   Neon's IP Allow feature is only on the Scale plan; keep the password
   long and in Render's secret store only.

4. Apply migrations **before** starting the API:

   ```bash
   cd server
   NODE_ENV=production DATABASE_URL=... PGSSLMODE=require PLATFORM_OWNER_EMAIL=ayush.17551@stu.upes.ac.in npm run migrate
   npm run check:db    # with the same variables in server/.env: answers, TLS on, migrations applied
   ```

   Migrations `001`…`017` apply in order, each in one transaction, once.
   **Never run `npm run seed` against production** (it refuses, and `/ready`
   reports seed rows as not-ready).

5. Backups: see [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md) — a daily `pg_dump`
   to B2 from GitHub Actions, plus Neon's 6-hour restore window.

## 3. Object storage — Backblaze B2

1. Create a B2 account (no card). In **Caps & Alerts**, set storage, download
   and transaction caps to the free amounts.
2. Create a bucket: **Private**, default encryption on, name e.g.
   `echoecho-prod-assets`. Note its endpoint (`s3.<region>.backblazeb2.com`).
3. Create an **application key restricted to that bucket**, Read and Write.
4. Configure:

   ```
   STORAGE_PROVIDER=s3
   S3_BUCKET=echoecho-prod-assets
   S3_REGION=<region from the endpoint, e.g. us-west-004>
   S3_ENDPOINT=https://s3.<region>.backblazeb2.com
   S3_ACCESS_KEY_ID=<keyID>
   S3_SECRET_ACCESS_KEY=<applicationKey>
   UPLOAD_MAX_BYTES=8388608
   ```

5. Prove it against the real bucket:

   ```bash
   cd server && npm run check:storage
   ```

   It uploads, downloads and deletes an object, **checks that an unsigned read
   is refused (the bucket is private)**, and checks a presigned URL works.

What the code already enforces (tested in `test/storage.test.mjs`): images
are validated on their bytes (JPEG/PNG/WebP magic numbers, size, dimensions),
stored under server-generated random keys (a caller cannot choose a filename or
path), deleted from the bucket when replaced or removed, ID-card images are
never presigned and stream through an authorization check, and food photos are
served by 5-minute presigned URLs.

## 4. Email — Resend Free

Requires the domain from section 1.

1. Create a Resend account. Add the domain **`mail.echoecho.in`** (a subdomain,
   as Resend recommends). Add the SPF, DKIM and MX records it shows at your
   DNS; add a DMARC record (`_dmarc.mail` TXT `v=DMARC1; p=none;`) to start.
   Wait for "Verified".
2. Create an API key with **Sending access** restricted to that domain.
3. Configure:

   ```
   EMAIL_PROVIDER=resend
   RESEND_API_KEY=re_...
   EMAIL_FROM=ECHO ECHO <verify@mail.echoecho.in>
   STUDENT_EMAIL_DOMAINS=stu.upes.ac.in
   EMAIL_DAILY_BUDGET=95
   EMAIL_MONTHLY_BUDGET=2900
   EMAIL_ADMIN_RESERVE=5
   ```

4. Prove it: `cd server && npm run check:email -- your.name@stu.upes.ac.in`,
   then check the UPES inbox **and Junk**. University Microsoft 365 tenants
   may quarantine new senders; if so, ask UPES IT to allow `mail.echoecho.in`.

Free-tier protection built in: the server counts every send in
`email_send_log`, refuses student codes once the day's or month's budget is
reached (keeping a reserve for administrator invitations), caps codes per
address (5/hour, 12/day), per network address (30/hour) and per code (5
attempts, 60 s resend cooldown). A provider quota or error returns a generic
"could not send the email right now" — the provider's message is logged
server-side only. The plan is never upgraded by the code.

## 5. Administrators and passkeys

Details: [ADMIN-ACCESS.md](ADMIN-ACCESS.md).

```
PLATFORM_OWNER_EMAIL=ayush.17551@stu.upes.ac.in
PLATFORM_ADMIN_EMAILS=                      # leave empty; invite admins from Campus Control
ADMIN_PASSKEY_REQUIRED=true
ADMIN_PASSKEY_INVITE_TTL_HOURS=24
```

First sign-in, once the API is live:

1. Ayush opens `https://echo-echo-nu.vercel.app/admin/`, signs in with the
   email code. The proven mailbox grants `platform_owner`. **This step needs
   a verified email domain** — until then no code can be delivered.
2. `npm run admin:invite -- ayush.17551@stu.upes.ac.in` prints a one-time code.

   Render's **free plan has no shell**, so run it from a trusted machine with
   `DATABASE_URL` pointing at Neon: the script only touches the database, and
   holding the production database credential is the same proof of ownership
   that shell access was. Do not run it anywhere the credential should not be.
3. Enter it in Campus Control and create the passkey (fingerprint, Face ID,
   Windows Hello or device PIN). **Save the 10 recovery codes offline.**
4. Administrators → "Add a passkey on this device" on a second device.
5. Administrators → **Invite administrator**: name, UPES email, permissions.
   The invitee receives a one-time code by email, signs in with their mailbox,
   enters the code and creates a passkey.

## 6. API on Render

1. New **Web Service** from the repository, root directory `server`, runtime
   Docker (uses `server/Dockerfile`) or Node (`npm ci`, start `node src/index.js`).
2. Instance type **Free**. Health check path: `/health` (liveness; `/ready`
   touches the database — use it for manual checks, not as Render's frequent probe).
3. Environment (Render → Environment, all as secrets where marked):

```
NODE_ENV=production
PORT=10000                                  # Render provides PORT; keep whatever it sets
COOKIE_SECRET=<openssl rand -hex 32>        # secret; keep stable
PAYMENTS_DEFERRED=true
SESSION_TTL_MINUTES=720
ADMIN_SESSION_TTL_MINUTES=240
LOG_LEVEL=info
# + sections 1–5
```

4. Deploy. The boot guard prints exactly what is missing if anything is.
5. Add an UptimeRobot HTTP monitor on `https://api.echoecho.in/health`, 5 min.

`COOKIE_SECRET` also keys the HMAC protecting stored email codes; rotating it
signs everyone out and voids in-flight codes (no data loss).

## 7. Surfaces

```bash
QUAD_API_BASE=https://api.echoecho.in node build.mjs --production
```

The build audit fails on demo credentials, hardcoded OTPs, fake GPS controls,
hardcoded ratings, secrets, `localhost`, or prototype imports in `dist/`.
Create three Render **Static Sites** publishing `dist/web`, `dist/admin`,
`dist/shop`; add the rewrite `/* → /index.html` only if a surface needs it
(`dist/serve.json` is the reference); no directory listing.

## 7b. Surfaces on Vercel (current deployment)

The surfaces are deployed to Vercel from `main`:

| | |
|---|---|
| Project | `echo-echo` |
| Production URL | https://echo-echo-nu.vercel.app |
| Repository | github.com/Ayushkushwaha2005/Echo-Echo (`main`) |
| Build | `node build.mjs --production` |
| Output | `dist` |
| Install | none — the surfaces are plain ES modules with no dependencies |

`vercel.json` mirrors the redirects and headers that `build.mjs` already
writes into `dist/serve.json`, so the deployed site behaves the way
`npm run web` does locally: `/` redirects to `/web/`, and every response
carries `nosniff`, `DENY`, `no-referrer` and `no-cache`.

**Only the surfaces are on Vercel. The API is not, and must not be.** It is a
long-running Fastify process holding a PostgreSQL pool and running in-process
schedulers; a serverless function is neither long-running nor a stable place
to hold either. Nothing about that should be worked around — the API runs on
Render (section 6) and the surfaces reach it through a rewrite, so the
browser still only ever talks to one origin.

### What is actually deployed (23 September 2026)

| | |
|---|---|
| Surfaces | https://echo-echo-nu.vercel.app — Vercel project `echo-echo` |
| API | https://echo-echo-api.onrender.com — Render `echo-echo-api`, free, Virginia, Docker from `server/Dockerfile` |
| Database | Neon project `lingering-bar-50764365`, AWS `us-east-1`, 21 migrations applied |
| Storage | Backblaze B2 `echo-echo-production-storage-2026`, `allPrivate`, SSE-B2, `us-east-005` |
| Email | Resend, `onboarding@resend.dev` — **no domain verified yet**, see below |
| Payments | deferred (`PAYMENTS_DEFERRED=true`) |
| Sweeper | `SWEEPER=off` while there are no orders to sweep |

The API base is `/api`, rewritten by `vercel.json` to the Render service.
Everything is co-located in `us-east-1`: the Vercel marketplace does not
expose a Neon region, and an API request runs several queries, so the API
sits next to the database rather than next to the students. Measured from
the deployed service, a database round trip is 6–8 ms.

Two consequences of the rewrite worth keeping in mind:

- The rewrite source must be `/api/(.*)`, not `/api/:path*`. Vercel's
  trailing-slash 308 runs **before** rewrites, so calls arrive spelled
  `/api/auth/status/`, and `:path*` does not match a trailing slash. With the
  wrong pattern every proxied call falls through to the static site and
  returns Vercel's own 404, which looks exactly like the API being down.
- That 308 is paid per API call (~30 ms). It disappears when the API moves to
  `api.<your-domain>`; it is not worth contorting the surfaces to avoid,
  because `trailingSlash: true` is what makes relative asset paths resolve
  under `/web/`.

**Student sign-in does not work for students yet.** Resend's free tier only
delivers to the account holder's own mailbox until a domain is DNS-verified,
so `POST /auth/email/send` for an `@stu.upes.ac.in` address returns 503 and
the log records Resend's refusal. The server, the code path and the budget
ledger are all correct and verified.

**The domain-free alternative is Brevo** (`EMAIL_PROVIDER=brevo`, added 23
September 2026). Brevo Free sends 300 emails/day to any recipient from one
sender address verified by a confirmation link, so no domain is required.
The adapter is tested end to end against a stub (`test/email-brevo.test.mjs`)
but has not sent a real message: that needs a Brevo account, which is the
owner's to create. To switch, in this order (production refuses to boot
without a working sign-in provider, so the order matters):

1. Create a free Brevo account; under **Senders**, add and verify the sender
   address. Create an API key (SMTP & API → API keys).
2. Render → `echo-echo-api` → Environment: set `BREVO_API_KEY`, and set
   `EMAIL_FROM` to `ECHO ECHO <that verified address>`.
3. Change `EMAIL_PROVIDER` from `resend` to `brevo`. Save; Render redeploys.
4. Request a code for a real `@stu.upes.ac.in` mailbox on the site and check
   the inbox **and Junk**. Mail from an unauthenticated sender domain may be
   quarantined by the university's Microsoft 365 tenant; if it is, only a
   domain of your own (with SPF/DKIM) fixes that.

### Deploying the API

`.github/workflows/deploy.yml` deploys the API. It runs when the `ci`
workflow succeeds on a push to `main`, asks Render (with the
`RENDER_API_KEY` repository secret) to deploy **that commit**, waits for
Render to report it live, then reads `commit` back from `/api/health/`
through the production Vercel rewrite and runs `tools/live-check.mjs`
against production. Render's own trigger is off (`autoDeployTrigger: "off"`
in `render.yaml`) so a push is never deployed before its tests pass.

`.github/workflows/keep-warm.yml` asks `/health` every 10 minutes so the free
instance sleeps less often. It does not touch the database. GitHub runs
scheduled jobs late under load, so it reduces cold starts but cannot remove
them.

### Load time

Measure with `node tools/perf-check.mjs https://echo-echo-nu.vercel.app/`
(real headless Chrome; first visit and returning visit reported separately,
and API time reported separately from static-site time).

- Every script and stylesheet is served from `/_v/<content hash>/` with
  `Cache-Control: public, max-age=31536000, immutable`; only the three HTML
  pages are `no-cache`. A returning visitor re-downloads only the page.
- Each page declares its static module graph with `modulepreload`.
- The payment gateway SDKs are loaded at checkout, not in every page head
  (they used to hold the app until both had downloaded).
- The web-font stylesheet no longer blocks the first paint.
- **Render cold start is separate and is not a frontend problem.** After 15
  idle minutes the first API request waits for the free instance to boot
  (~13 s measured on 23 Sep 2026). The page shell renders without waiting for
  it; data-driven parts show their loading state until the API answers.

### The API base, and why it is `same-origin`

The Vercel project sets `QUAD_API_BASE=same-origin` at build time. Nothing is
injected into the pages and `client.js` falls back to `location.origin`.

This is not a placeholder for a missing URL. It is the only arrangement that
can work at all, because the session cookie is `SameSite=Lax`:

- `*.vercel.app` is on the Public Suffix List, so
  `echo-echo-nu.vercel.app` and any separate API host are **different sites**
  to a browser. A `SameSite=Lax` cookie is not sent across them, so
  sign-in would appear to succeed and then every following request would
  arrive anonymous.
- Pointing the build at a separate API hostname does not fix that. Only
  same-origin does.

So until the API is hosted, the deployed site is the **interface only**: every
screen renders, and anything that needs the API reports that it cannot reach
the server. That is accurate, not a degraded mode to apologise for.

### Connecting the API to it

Two options, both same-origin:

1. **A Vercel rewrite** to the API host, so the browser only ever talks to the
   Vercel origin. Add to `vercel.json`, before deploying:

   ```json
   "rewrites": [{ "source": "/api/:path*", "destination": "https://<api-host>/:path*" }]
   ```

   This keeps one origin and the cookie flows. Note the API sets cookies on
   the proxied responses, so `HTTP.secureCookies` must be on and
   `TRUST_PROXY=true`.

2. **A custom domain**, `echoecho.in` for the surfaces and `api.echoecho.in`
   for the API. Same registrable domain, so `SameSite=Lax` is satisfied
   without a proxy. This is the arrangement section 1 describes and the one to
   prefer for a real launch.

Either way the build stays `same-origin` for option 1, or becomes
`QUAD_API_BASE=https://api.echoecho.in` for option 2.

## 8. Campus data (Bidholi)

Research and sources: [CAMPUS-UPES-BIDHOLI.md](CAMPUS-UPES-BIDHOLI.md).

- UPES Bidholi is in service; Kandholi is "coming soon" and refused server-side.
- The OpenStreetMap outline is a **proposed** boundary. Until an administrator
  holding `boundary.confirm` confirms it with a fresh passkey and a written
  note, **every delivery order is refused** (self pickup works).
- **Students cannot pass the live-location check until a boundary is
  active.** With none, `POST /campus/presence` refuses everyone with "Campus
  delivery is not switched on yet". The committed field survey does not
  confirm the OSM outline (114 interior readings, nobody walked the
  perimeter, reading #098 is 58 m outside it), so it is not activated in code.
  The owner confirms it, after checking it on the ground, either in Campus
  Control or, while Campus Control sign-in is not set up, with:

  ```bash
  cd server
  npm run boundary:confirm:local                 # read-only: outlines + evidence
  npm run boundary:confirm:local -- --activate <id> --confirmation "how you checked it"
  npm run boundary:confirm:local -- --deactivate <id> --confirmation "why"   # undo
  ```

  It activates only an outline already in the database, records the owner
  as the verifier and writes `audit_log`. Activating it opens the location
  check only: `deliveryAvailable` stays `false` until a confirmed,
  positioned delivery point lies inside it. Delivery points are opened the
  same way, from a reviewed plan that can only confirm positions already
  stored (`npm run locations:confirm:local`, read-only; add `-- --apply`).
  The Bidholi plan is `docs/campus/bidholi-destinations-2026-09-25.json`.
  The evidence behind the Bidholi
  outline: [campus/BIDHOLI-BOUNDARY-ASSESSMENT.md](campus/BIDHOLI-BOUNDARY-ASSESSMENT.md).
- Field data is entered through the workflow in [CAMPUS-FIELD-COLLECTION.md](CAMPUS-FIELD-COLLECTION.md). Migration 016 adds two **pending, non-deliverable** location candidates
  (Energy Block, Infirmary) from OpenStreetMap. Nothing is deliverable until
  confirmed on the ground (Locations → Confirm location), and a delivery point
  without a recorded position is refused.
- Café Frisco and Tulips Cafe exist in production, with no menu: menus are
  entered by their owners in Counter (or by an administrator in Campus
  Control → Menu), including categories, availability, archive and photos.
- **Chai Garam is not in production.** The only photograph of a possible
  outlet shows a sign reading "CH…" with the rest hidden, re-checked on 23
  Sep 2026 (the "VALLO" board beside it is an advertisement). When the
  shopkeeper or an administrator confirms the outlet, add it from Campus
  Control → Cafeterias → Add cafeteria. Do not invent its hours or phone.

## 9. Payment gateway — later

Deferred. With `PAYMENTS_DEFERRED=true` the server starts, `/ready` reports
payments unconfigured, and checkout returns 503 "not available" — no order is
created. When KYC is complete follow [PAYMENTS-PROVIDER.md](PAYMENTS-PROVIDER.md),
then remove `PAYMENTS_DEFERRED` and turn the sweeper back on.

## 10. Verify after deploy

| Check | Expect |
|---|---|
| `GET /health` | `{ ok: true }` |
| `GET /ready` | `ready: true`, `migrations.pending: []`, `data.developmentSeedRows: 0` |
| `npm run check:db` / `check:storage` / `check:email` | all ✓ |
| Student email code to a real UPES mailbox | arrives; sign-in → VERIFIED |
| Campus Control passkey sign-in | works on both administrators' devices |
| Upload a menu photo in Counter | image shows |
| Delivery order before boundary confirmed | refused: "Campus delivery is not available yet" |
| Checkout | 503 "Online payment is not available" (deferred) |

## Rollback

Redeploy the previous Render deploy (Render → Deploys → Rollback). Migrations
are additive and forward-only, so the previous release keeps working on the
newer schema. For data problems see [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md).

## Probes and logs

| Path | Meaning |
|---|---|
| `/health` | the process is alive; no database query |
| `/ready` | database answers, all shipped migrations applied, no seed data, provider status |

Logs are structured JSON with `x-request-id` on every line. Redacted at the
logger: cookies, authorization, `set-cookie`, webhook signatures, body fields
`code`, `otp`, `password`, `inviteCode`, `credential`, plus `code_hash`,
`token_hash`, `apiKey`, `secret`, `public_key_jwk`. Render keeps recent logs
on the free plan; nothing sensitive is written to them.
