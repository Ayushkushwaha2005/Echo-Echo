# ECHO ECHO — deployment checkpoint

**Written:** 17 September 2026
**Commit at checkpoint:** `551254f` — *deploy: one-time VM preparation script*
**Working tree:** clean, `main` in sync with `origin/main`

Every status below was verified by running the check, not recalled. Anything
not verified is marked **NOT VERIFIED** rather than assumed.

---

## 1. Where the project actually is

| Layer | State |
|---|---|
| Frontend | **Live** on Vercel |
| Backend | **Ready to deploy, not deployed.** No server exists yet |
| Database | **Not created** |
| Domain | **Not registered/configured** |
| Email + storage | **Not configured** — and both are required to boot (see §7) |

Nothing has been deployed to Azure. No VM, database, DNS record or Vercel
rewrite exists.

---

## 2. Frontend

| | |
|---|---|
| Repository | https://github.com/Ayushkushwaha2005/Echo-Echo (`main`, public) |
| Vercel project | `echo-echo` (`prj_rEtDUCu0Mj1eNiQjuslCA7XFuPPX`) |
| Production URL | **https://echo-echo-nu.vercel.app** |
| Git integration | Connected — a push to `main` auto-deploys |
| Build | `node build.mjs --production` → `dist`, no install step |
| Build env | `QUAD_API_BASE=same-origin` (not a secret) |
| Last QA | **19/19 passed** against the live site |
| Verified now | `/web/` → 200 |

QA covers: no uncaught JS exceptions, every static asset loads, no horizontal
overflow at 1280px and 390px, all three surfaces render, no hosting or
configuration wording on screen, and no secret or personal address in the
shipped bundles.

**The frontend cannot reach an API yet**, because there isn't one. Screens
render and anything needing the API says *"Cannot reach the ECHO ECHO
server."* That is the honest state, not a defect.

---

## 3. Backend

| | |
|---|---|
| Tests | **552 passing, 0 failing** (verified at this commit) |
| Bundle smoke | All three surfaces execute cleanly |
| Docker | `server/Dockerfile` exists — `node:22-alpine`, multi-stage, `npm ci --omit=dev`, non-root `quad` user, `HEALTHCHECK` on `/ready` |
| Docker build | **NOT VERIFIED** — Docker is not installed on the dev laptop. First real build happens on the VM |
| Health | `GET /health` — liveness only |
| Readiness | `GET /ready` — checks PostgreSQL, migration state and every provider |
| Migrations | 20 files, `001` … `020` |
| Schedulers | Sweeper 30 s, settlement 60 s — **in-process timers**, so the process must stay alive |
| Shutdown | SIGINT/SIGTERM → close Fastify → end pg pool |
| Log redaction | Cookies, passwords, OTP codes, admin challenge, reset token, `currentPassword`, `*.secret` |

Deployment assets prepared and committed (all under `deploy/`):

- `AZURE.md` — the runbook
- `bootstrap-vm.sh` — Docker, SSH hardening, ufw, fail2ban, swap (syntax-checked)
- `docker-compose.yml` — `restart: unless-stopped`, loopback-only port, mem limit, log rotation
- `Caddyfile` — automatic TLS for `api.echoecho.tech`
- `server.env.example` — variable **names only, zero values**

---

## 4. Azure

Confirmed by Ayush in the portal:

- Azure for Students subscription **ACTIVE**; $100 credit, expires **17 Sep 2027**
- Ayush is **Owner** of the subscription
- `Microsoft.Compute` — **Registered**
- `Microsoft.Network` — **Registered**
- `Microsoft.Storage` — **Registered**

Not yet created:

- **VM — NOT created**
- **PostgreSQL Flexible Server — NOT created**

The earlier provider-registration blocker is **resolved**.

### Verified cost model

| Resource | Free allowance | Cost |
|---|---|---|
| B1s VM | 750 h/mo, 12 months (a month needs ~730) | ₹0 |
| OS disk 64 GiB Premium SSD (**P6**) | 2 × 64 GB P6 included | ₹0 |
| Outbound bandwidth | 15 GB/mo | ₹0 at this scale |
| **Standard static public IP** | **no free tier** | **~$3.65/mo from credit** |
| PostgreSQL B1MS + 32 GB + 32 GB backup | 750 h/mo, 12 months | ₹0 |

≈ **$3.65/month ≈ $44/year** against a $100 credit. Azure for Students holds
no card and **disables the subscription rather than charging**, so there is no
surprise-bill path.

Two choices that actually matter: the OS disk must be **64 GiB P6** (the
default 30 GiB is P4 and is *not* free), and **auto-shutdown must be OFF** or
the schedulers stop every night.

---

## 5. The exact next step

Create the VM:

| Setting | Value |
|---|---|
| Subscription | Azure for Students |
| Resource group | **create new** → `echo-echo-rg` |
| VM name | `echo-echo-api` |
| Region | `(Asia Pacific) Central India` — **the database must match** |
| Image | Ubuntu Server **24.04 LTS — x64 Gen2** |
| Size | **Standard_B1s** (1 vcpu, 1 GiB) |
| Availability | No infrastructure redundancy required |
| Security type | Standard |
| Spot discount | **unchecked** — Spot VMs are evicted, which kills the schedulers |
| Authentication | **SSH public key only** |
| Username | `echoadmin` |
| Inbound ports | **22, 80, 443** only |
| OS disk | **64 GiB, Premium SSD (LRS)** |
| Public IP | new, SKU **Standard**, assignment **Static** |
| Auto-shutdown | **OFF** |

Generate the key first — a private key must never be pasted into a chat or
committed:

```bash
ssh-keygen -t ed25519 -C "echo-echo-api" -f ~/.ssh/echo_echo_api
```

Paste only `echo_echo_api.pub` into the portal.

Then, on the VM:

```bash
git clone https://github.com/Ayushkushwaha2005/Echo-Echo.git ~/echo-echo
bash ~/echo-echo/deploy/bootstrap-vm.sh
```

---

## 6. Domain

- `echoecho.tech` — **not registered/configured** (verified: does not resolve)
- `api.echoecho.tech` — **not configured** (verified: does not resolve)

Free for one year via the GitHub Student Pack (.TECH). **Turn auto-renew off
the day it is claimed** — it renews at roughly $45/yr.

Claiming it unblocks three things at once: Resend domain verification,
`WEBAUTHN_RP_ID`, and the `SameSite=Lax` cookie working across the frontend
and the API. Worth doing in parallel with the VM.

---

## 7. Resend and S3 — the sequencing trap

**Neither is configured. No placeholder containing a secret exists anywhere in
this repository, and none should ever be added.**

`assertBootable()` in `server/src/config.js` has a deferral flag for payments
(`PAYMENTS_DEFERRED=true`, already planned) but **none for email or storage**.
So with `NODE_ENV=production` the API **will not start** until both exist — it
will restart-loop with a readable message naming what is missing.

This is not a bug to work around. It means the real order is:

> VM → PostgreSQL → **Resend + S3** → `server.env` → `docker compose up`

Doing it in any other order produces a container that will not boot.

- **Resend**: needs `echoecho.tech` verified first. The `resend.dev` test
  domain only delivers to your own account address, so no student could
  receive a code.
- **S3**: any S3-compatible private bucket. It holds **student government-ID
  images** — the bucket must not be public.

Both go only into `deploy/server.env` on the VM (chmod 600, git-ignored).
Never into Vercel, never into the repository, never into chat.

---

## 8. Database

- Production PostgreSQL — **not created**
- Migrations — **not run against production**

Once the server exists:

```bash
docker compose exec api node src/db/migrate.js
```

Idempotent. It also establishes `PLATFORM_OWNER_EMAIL` as `platform_owner`.

Networking: prefer **Private access (VNet)**. If only Public access is
available on the free configuration, add exactly one firewall rule for the
VM's IP, leave *"Allow public access from any Azure service"* **off**, and
keep **Require secure transport ON**. The database is reached outbound from
the VM; it is never something the internet connects to.

---

## 9. Catalog seed — NOT executed

`server/src/db/seed.js` **refuses to run when `NODE_ENV=production`**, by
design. Running it is a deliberate, one-time decision and needs Ayush's
explicit confirmation first.

Command (when approved):

```bash
docker compose exec -e NODE_ENV= api node src/db/seed.js
```

What it creates:

- **3 vendors** — Frisco, Chai Garam, Tulips
- **26 menu items** across those three
- **Campus nodes for Bidholi** — Academic Area (SoE, SoCS, SoD, SoHST, SoB,
  SoLS), Library, Sports Ground (football, basketball, volleyball),
  Hostel Area, Auditorium — all marked `source='public_source'`

What it does **not** create — verified by reading the file:

- **no GPS coordinates** (`lat`/`lng` stay NULL)
- **no campus boundary polygon**
- no users, no students, no partners, no admins beyond the configured owner
- no orders, no deliveries, no earnings
- no ratings or reviews

**The geofence therefore remains fail-closed.** `assertDeliverable()` refuses
delivery outright while no confirmed boundary exists, so students will be able
to browse but **not order** until real surveyed geodata is supplied. That is
correct and must not be worked around by inventing coordinates.

---

## 10. Security rules that hold regardless of what comes next

- **Never commit a secret.** `.env`, `deploy/server.env` and `.vercel` are
  git-ignored; `.env` has never been committed in any commit in this history.
- **Never ask Ayush for a password, private key, TOTP secret or API key**, and
  never accept one pasted into chat. Tell him where to enter it instead.
- `COOKIE_SECRET` and `ADMIN_TOTP_KEY` are generated **on the VM** with
  `openssl rand -base64 48`.
- **Preserve the production boot guards.** They are the reason a misconfigured
  deployment fails loudly instead of quietly serving a broken product.
- **`SameSite=Lax` stays.** Cross-origin is solved by the Vercel `/api`
  rewrite or a shared domain, never by weakening the cookie.
- The S3 bucket holding student ID images must be **private**.
- Owner identity is **`ayush.17551@stu.upes.ac.in`** and does not change.
  Anushka is not added until her real institutional email is provided.
- No Resend key has ever passed through this project — scanned, none present.
  Any key exposed elsewhere should be treated as compromised and rotated.

---

## 11. Sequence to continue

1. **Create the VM** (§5). Note the **static public IP**.
2. SSH in with Termius; run `deploy/bootstrap-vm.sh`.
3. **Create PostgreSQL Flexible Server** — B1MS, 32 GB, same region, TLS
   required, restricted networking.
4. **Claim `echoecho.tech`**; turn **auto-renew off**.
5. **Verify the domain in Resend**; create the **private** S3 bucket.
6. Fill `deploy/server.env` on the VM (chmod 600) — secrets generated there.
7. `docker compose up -d --build`; check `/health` and `/ready` on localhost.
8. DNS: `api` → VM static IP; apex/`www` → Vercel.
9. Add the Vercel rewrite `/api/:path*` → `https://api.echoecho.tech/:path*`,
   redeploy.
10. `node src/db/migrate.js`.
11. Catalog seed — **only on explicit confirmation** (§9).
12. `node src/db/admin-setup.js` — Ayush types the password and scans the
    authenticator himself.
13. Full production verification.

**Optional, and faster:** installing the Azure CLI (`winget install -e --id
Microsoft.AzureCLI`) and running `az login` yourself lets steps 1 and 3 be
created and *verified* by command rather than clicked, with no credential ever
being shared.

---

## Tomorrow's single next action

**Create the Azure B1s VM exactly as specified in §5, then report back the
static public IP.**
