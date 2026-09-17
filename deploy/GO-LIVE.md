# ECHO ECHO — go-live checklist

**Written:** 18 September 2026
**Commit:** see `git log -1` — the tree is clean and pushed to `origin/main`

One ordered list of everything still standing between the current state and a
real production deployment. Every step says who does it, the exact values, and
what becomes possible once it is done.

`deploy/AZURE.md` has the detail and the reasoning. This is the running order.

> **Nothing here asks you to paste a secret into a chat window.** Passwords,
> private keys, API keys and connection strings are typed into the portal that
> owns them, or generated on the VM. If you are ever asked for one, that is a
> mistake — refuse it.

---

## Where it stands

| Layer | State |
|---|---|
| Repository | **done** — clean, pushed |
| Backend code | **done** — 585/585 tests |
| Frontend | **live** on Vercel at `echo-echo-nu.vercel.app` |
| Azure VM | **not created** |
| PostgreSQL | **not created** |
| `echoecho.tech` | **not registered** — verified, returns NXDOMAIN |
| Resend | **not configured** |
| S3 storage | **not configured** |
| Payments | deferred (`PAYMENTS_DEFERRED=true`) |
| Campus geofence | **fail-closed** — delivery refused, by design |

The API **cannot start** until PostgreSQL, Resend and S3 all exist. That is the
boot guard doing its job, not a bug. It fixes the running order below.

---

## 1 — Claim the domain (you, ~10 minutes)

Do this first. It unblocks three other things at once and has a clock on it.

1. <https://education.github.com/pack> → find the **.TECH Domains** offer
2. Claim **`echoecho.tech`**, free for one year
3. **Turn auto-renew OFF the moment it is claimed.** It renews near $45/yr
4. Tell me the registrar's nameserver/DNS panel you ended up with

Unblocks: Resend domain verification, `WEBAUTHN_RP_ID`, and the `SameSite=Lax`
cookie working across frontend and API.

---

## 2 — Create the VM (you, in the portal, ~10 minutes)

Generate the key **on your own machine first** — a private key never leaves it:

```bash
ssh-keygen -t ed25519 -C "echo-echo-api" -f ~/.ssh/echo_echo_api
```

Paste only `~/.ssh/echo_echo_api.pub` into the portal.

Azure Portal → **Virtual machines** → **Create** → Azure virtual machine:

| Setting | Value |
|---|---|
| Subscription | Azure for Students |
| Resource group | **Create new** → `echo-echo-rg` |
| Virtual machine name | `echo-echo-api` |
| Region | **(Asia Pacific) Central India** — the database must match |
| Availability options | No infrastructure redundancy required |
| Security type | Standard |
| Image | **Ubuntu Server 24.04 LTS — x64 Gen2** |
| Run with Azure Spot discount | **unchecked** — eviction kills the schedulers |
| Size | **Standard_B1s** (1 vcpu, 1 GiB) |
| Authentication type | **SSH public key** |
| Username | `echoadmin` |
| SSH public key source | Use existing public key → paste `echo_echo_api.pub` |
| Public inbound ports | Allow selected → **22, 80, 443** |

**Disks** tab → OS disk size **64 GiB**, type **Premium SSD (LRS)**.
The 30 GiB default is a P4 and is *not* in the free allowance; 64 GiB is a P6
and is.

**Networking** tab → Public IP → **Create new** → SKU **Standard**,
Assignment **Static**. A dynamic IP changes on deallocation and the API
silently disappears.

**Management** tab → **Auto-shutdown OFF.** The sweeper (30 s) and settlement
(60 s) schedulers are in-process timers; a nightly shutdown stops them.

→ **Report the static public IP back to me.**

---

## 3 — Create PostgreSQL (you, in the portal, ~15 minutes)

Azure Portal → **Azure Database for PostgreSQL flexible servers** → Create:

| Setting | Value |
|---|---|
| Resource group | `echo-echo-rg` |
| Name | `echo-echo-db` |
| Region | **Central India** — same as the VM |
| Workload type | Development |
| Compute + storage | **Burstable B1MS**, **32 GiB** storage |
| Backup retention | 7 days, **32 GiB** |
| Availability zone | No preference |
| High availability | **disabled** |
| Authentication | PostgreSQL authentication only |
| Admin username | `echoadmin` |
| Password | **type it into the portal; do not send it to me** |

**Networking:**

- Prefer **Private access (VNet integration)**, same VNet as the VM.
- If the free configuration only offers **Public access**, then: add exactly
  one firewall rule for the VM's static IP (start = end = that IP), leave
  *"Allow public access from any Azure service within Azure"* **OFF**, and keep
  **Require secure transport ON**.

Either way the database is reached **outbound from the VM only**. It is never
something the internet connects to.

→ Tell me which networking mode you got. I do not need the password.

---

## 4 — Resend (you, ~20 minutes, needs step 1)

**The previously exposed Resend API key must be treated as compromised.**
Revoke it in the Resend dashboard and generate a new one. Do not reuse the old
key anywhere, and do not send the new one to me.

1. <https://resend.com> → **Domains** → Add `echoecho.tech`
2. Add the DKIM/SPF records it gives you at your registrar
3. Wait for **Verified**
4. **API Keys** → create one with **Sending access** only
5. Keep it on screen for step 7 — it goes straight into `server.env` on the VM

The `resend.dev` test domain only delivers to your own address, so no student
could receive a code. The domain must be verified.

Student sign-in stays exactly `@stu.upes.ac.in`. No phone OTP.

---

## 5 — Private S3-compatible storage (you, ~15 minutes)

Any S3-compatible provider. It holds **student government-ID images**.

- Bucket **private**. No public read, no public listing, no static-website
  hosting, no public bucket policy.
- Create an access key scoped to this bucket only.
- Note the endpoint, region and bucket name.

The server signs short-lived URLs and checks authorization before issuing one;
no object URL is ever public. Keep it that way.

---

## 6 — Prepare the VM (me, once you give me the IP)

With Termius, or any SSH client, as `echoadmin@<STATIC_IP>`:

```bash
git clone https://github.com/Ayushkushwaha2005/Echo-Echo.git ~/echo-echo
bash ~/echo-echo/deploy/bootstrap-vm.sh
```

`bootstrap-vm.sh` installs Docker and the compose plugin, hardens SSH
(no password auth, no root login), enables `ufw` for 22/80/443 only, installs
`fail2ban` and unattended security upgrades, and adds swap so a 1 GiB B1s can
build the image.

---

## 7 — Fill the environment (you type the secrets, on the VM)

```bash
cd ~/echo-echo/deploy
cp server.env.example server.env
chmod 600 server.env

# Generate the two machine secrets HERE. They must never be typed into a chat
# window, a ticket, or an editor that syncs to the cloud.
echo "COOKIE_SECRET=$(openssl rand -base64 48)"
echo "ADMIN_TOTP_KEY=$(openssl rand -base64 48)"

nano server.env
```

`server.env` is git-ignored and must stay on the VM. What goes in it:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgres://echoadmin:<password>@echo-echo-db.postgres.database.azure.com:5432/postgres` |
| `PGSSLMODE` | `require` |
| `COOKIE_SECRET` | the generated value |
| `ADMIN_TOTP_KEY` | the generated value |
| `SECURE_COOKIES` | `true` |
| `WEB_ORIGIN` | `https://echoecho.tech` |
| `TRUST_PROXY` | `true` |
| `WEBAUTHN_RP_ID` | `echoecho.tech` |
| `WEBAUTHN_ORIGINS` | `https://echoecho.tech` |
| `PLATFORM_OWNER_EMAIL` | `ayush.17551@stu.upes.ac.in` |
| `EMAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | the **new** key from step 4 |
| `STORAGE_PROVIDER` | `s3` |
| `S3_*` | endpoint, region, bucket, key, secret from step 5 |
| `PAYMENTS_DEFERRED` | `true` until Cashfree KYC clears |

---

## 8 — Bring it up (me)

```bash
cd ~/echo-echo/deploy
docker compose up -d --build
docker compose ps
curl -s localhost:8080/health
curl -s localhost:8080/ready | head -c 400
```

`/ready` is the honest one: it checks PostgreSQL, migration state and every
provider. If anything is missing the container restart-loops with a readable
message naming it — read the message rather than working around it.

Then migrations:

```bash
docker compose exec api node src/db/migrate.js
```

Idempotent. Establishes `PLATFORM_OWNER_EMAIL` as `platform_owner`. There are
**21** migrations; 021 adds the room-plate columns and inserts no rows.

---

## 9 — DNS (you) then the rewrite (me)

At the registrar:

| Record | Type | Value |
|---|---|---|
| `echoecho.tech` | A | **the exact A-record value Vercel shows** in Project → Settings → Domains after you add the domain. Do not copy an address from anywhere else, including this file |
| `www` | CNAME | `cname.vercel-dns.com` |
| `api` | A | the VM's **static** public IP |

Add `echoecho.tech` as a custom domain on the Vercel `echo-echo` project and
let it verify.

Once `api.echoecho.tech` resolves, Caddy gets a real certificate automatically
on first request. Then I add the rewrite to `vercel.json`:

```json
"rewrites": [
  { "source": "/api/:path*", "destination": "https://api.echoecho.tech/:path*" }
]
```

This is why `SameSite=Lax` can stay. The browser only ever sees one origin, so
the session cookie rides along. CORS would not fix this — it governs whether a
request is allowed, not whether the cookie is attached. **Do not weaken the
cookie to make Vercel work.**

---

## 10 — Administrator (you, at the terminal)

```bash
docker compose exec -it api node src/db/admin-setup.js
```

Prompts for your password (not echoed) and prints the authenticator secret and
`otpauth://` URI **once**. Scan it into your authenticator before closing the
terminal — it is stored encrypted and nothing can read it back.

---

## 11 — Catalog seed (only on your explicit say-so)

`server/src/db/seed.js` refuses to run under `NODE_ENV=production` by design.

```bash
docker compose exec -e NODE_ENV= api node src/db/seed.js
```

Creates 3 vendors, 26 menu items and the Bidholi campus nodes. It creates
**no coordinates and no boundary polygon**, so the geofence stays fail-closed.

---

## 12 — Campus data (me, then you on site)

In this order, none of it automatic:

1. Import the 7 candidate points through Campus Control → Locations →
   **Import GPS points** → *Preview* first. They land as **pending** and
   therefore undeliverable.
2. **Walk the perimeter** with a GPS logger at 1 s interval, one full lap,
   export GPX. This is the only thing that can lift the fail-closed geofence.
   Import it, compare it against the OpenStreetMap proposal, then *Confirm and
   activate*.
3. Stand at each counter — Frisco, Tulips, and whatever the "CHA…" sign turns
   out to be — and record the position from Campus Control, which stores
   accuracy and method properly. The photo positions are where the
   photographer stood, not the hand-over point.
4. Get one clear photograph of the "CHA…" signboard. Until then Chai Garam
   stays **UNCONFIRMED** and is not in any candidate file.
5. Get the official block list, so block numbers stop being inferred from
   which caption a photo happened to carry.

See `docs/campus/BIDHOLI-FIELD-REPORT.md` for what the evidence does and does
not support.

---

## 13 — Payments (later, needs KYC)

`PAYMENTS_DEFERRED=true` keeps checkout honestly unavailable (503) and `/ready`
reports it. When Cashfree KYC clears, configure the provider through the
existing adapter — the architecture does not change. UPI and cards only; **no
COD**. Nothing may claim payments are production-ready until a real transaction
has been through the live provider and reconciled.

---

## What I do without waiting for any of this

Code, configuration, tests, campus data preparation, documentation, and every
dry run that does not need production credentials. What I cannot do is create
Azure resources, register a domain, or hold a secret — those need you.
