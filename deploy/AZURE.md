# ECHO ECHO on Azure — deployment runbook

The surfaces are already on Vercel. This is the API half:

```
browser ──► echo-echo-nu.vercel.app   (the surfaces, already deployed)
               │  /api/* rewrite, so the browser only ever sees ONE origin
               ▼
         <API_HOSTNAME> ──► Caddy (TLS) ──► Fastify container ──► managed PostgreSQL
```

`<API_HOSTNAME>` is whatever you set in `deploy/.env`. It does **not** have
to be a domain you bought: `20-197-1-2.sslip.io` (the VM's static IP with
dots as dashes) resolves on its own and Let's Encrypt will issue a real
certificate for it. See §2.

**Why the rewrite rather than calling the API host directly.** The session
cookie is `SameSite=Lax`. A browser decides "same site" by registrable
domain, and `vercel.app` is on the Public Suffix List, so
`echo-echo-nu.vercel.app` and any API host are different sites and the cookie
is simply never sent. CORS does not change that — it governs whether a
request is permitted, not whether the cookie rides along. The rewrite keeps
one origin, which is why `SameSite=Lax` stays as it is.

---

## 0. Before anything: the resource-provider blocker

VM creation fails while `Microsoft.Compute`, `Microsoft.Storage` and
`Microsoft.Network` are unregistered. There are two different causes and they
have different fixes, so identify which one applies first.

**Check the offer.** Azure Portal → Subscriptions → *Azure for Students* →
**Overview**, and read **Offer** / *Offer ID*:

| Offer ID | Name | VMs |
|---|---|---|
| `MS-AZR-0170P` | Azure for Students | **Allowed** — $100 credit |
| `MS-AZR-0144P` | Azure for Students **Starter** | **Blocked by the offer itself** |

*Azure for Students Starter* permits only a fixed namespace list
(`Microsoft.Web`, `Microsoft.Sql`, `Microsoft.Resources`, …). `Microsoft.Compute`
is not on it, and no amount of clicking Register will change that — the
restriction is the subscription type. The fix is to obtain the full
*Azure for Students* offer via academic verification, not to retry.

If the offer **is** `MS-AZR-0170P` (it should be — Starter carries no credit,
and this subscription has $100), then the cause is one of:

1. **The subscription is still provisioning.** Providers register
   asynchronously after activation and this error is transient for a while.
2. **The signed-in account is not Owner/Contributor** on that subscription, or
   the portal is scoped to a different directory/tenant.

### The manual action

Azure Portal → **Subscriptions** → *Azure for Students* → **Settings** →
**Resource providers** → select each of `Microsoft.Compute`,
`Microsoft.Storage`, `Microsoft.Network` → **Register**. Each moves
`NotRegistered` → `Registering` → `Registered` in 1–5 minutes.

If **Register** is greyed out, confirm the role at
**Access control (IAM)** → **View my access**: it must be *Owner* or
*Contributor*. On a personal Azure for Students subscription the activating
account is normally Owner; if it is not, the portal is showing a subscription
that belongs to someone else's tenant.

This step cannot be done from this repository — it needs the signed-in portal
session.

---

## 1. Resources

| Resource | Value |
|---|---|
| Resource group | `echo-echo-rg` |
| Region | Pick one close to Dehradun and use it for **both** VM and database (`Central India`, else `South India`) |
| VM | `echo-echo-api`, Ubuntu Server 24.04 LTS x64 **Gen2**, **Standard B1s** |
| Authentication | **SSH public key only** — never password |
| Admin username | `echoadmin` |
| Inbound ports | 22, 80, 443 only |
| Database | Azure Database for PostgreSQL **Flexible Server**, Burstable **B1MS**, 32 GB storage, 32 GB backup |

Put the VM and the database in the **same region**: cross-region traffic is
billed and adds latency to every query the sweeper makes.

### Database networking — do not expose PostgreSQL publicly

Choose **Private access (VNet integration)** if offered, and put the VM in the
same VNet. If only **Public access** is available on the free configuration,
then add exactly one firewall rule for the VM's public IP and leave
*"Allow public access from any Azure service"* **off**. Either way keep
**Require secure transport = ON** (the server refuses a non-TLS connection in
production anyway).

---

## 2. On the VM

One-time preparation — Docker, SSH hardening, firewall, swap:

```bash
git clone https://github.com/Ayushkushwaha2005/Echo-Echo.git ~/echo-echo
bash ~/echo-echo/deploy/bootstrap-vm.sh
# log out and back in so the docker group applies
```

### Configuration: two files, only one of them secret

```bash
cd ~/echo-echo/deploy

cp .env.example .env            # PUBLIC: API_HOSTNAME, ACME_EMAIL
cp server.env.example server.env
chmod 600 server.env            # SECRET: DATABASE_URL, COOKIE_SECRET, keys
```

**`deploy/.env` — the API's hostname.** You do **not** need to buy a domain
to get the API onto real TLS. Two forms work, and `deploy/Caddyfile` reads
whichever you set:

| `API_HOSTNAME` | Needs | When |
|---|---|---|
| `20-197-1-2.sslip.io` | nothing — the VM's static IP with dots as dashes | now |
| `api.echoecho.tech` | the domain, plus an `A` record for `api` | later |

`sslip.io` resolves any dashed-IP name to that IP, which is enough for
Let's Encrypt to issue a **genuine** certificate over the HTTP-01 challenge.
Nothing in the browser or in the Vercel rewrite has to relax its verification,
and moving to a bought domain later is one line of `deploy/.env` plus a
redeploy. Set the VM's IP allocation to **Static** first — a dynamic IP
changes on deallocation and both the name and the certificate stop matching.

**`deploy/server.env` — the secrets.** Generate the two that belong to this
machine **on** this machine. They must never be typed into a chat window, a
ticket, or an editor that syncs to the cloud:

```bash
echo "COOKIE_SECRET=$(openssl rand -base64 48)"
echo "ADMIN_TOTP_KEY=$(openssl rand -base64 48)"
nano server.env     # those two, plus DATABASE_URL, Resend, S3, WEB_ORIGIN
```

`WEB_ORIGIN` must be the exact Vercel origin with no trailing slash —
`https://echo-echo-nu.vercel.app`. The CSRF check refuses any cookie-bearing
write from an origin it does not recognise, so a typo here presents as every
action failing with "Cross-origin request rejected".

### Deploy

```bash
bash deploy/deploy.sh
```

Idempotent, and safe to re-run for every subsequent release. It pulls,
rebuilds, runs migrations, brings the stack up, and then **refuses to report
success until the API actually answers `/ready`** — polling rather than
sleeping, and printing the last 40 log lines if it never does. A deploy
script that exits 0 because `docker compose up` returned is how a broken
container sits there unnoticed.

Preflight stops the run before anything changes if Docker is missing, if
either configuration file is absent, if `server.env` is not mode 600, if
`API_HOSTNAME` does not resolve to this VM, or if a required key is empty.
It never prints a value.

`restart: unless-stopped` means the API returns after a crash **and** after a
VM reboot. That matters more than it looks: the 30-second sweeper and the
60-second settlement scheduler are in-process timers, so a container that
stays down means abandoned orders are never released and settlement batches
are never built.

Checking by hand, on the VM:

```bash
curl -s localhost:8080/health          # {"ok":true,...}
curl -s localhost:8080/ready | head -c 400
```

`/ready` is the honest one — it checks PostgreSQL, the migration state and
every provider. `/health` only says the process is alive.

---

## 3. The catalog

`deploy.sh` has already run the migrations, which also establishes
`PLATFORM_OWNER_EMAIL` as `platform_owner`.

The catalog seed is **deliberately blocked under `NODE_ENV=production`** and
requires an explicit decision — see §7 of the deployment report for the exact
command and everything it writes. It creates no coordinates and no boundary
polygon, so **the campus geofence stays fail-closed**: students can browse,
and delivery is refused, until somebody supplies real surveyed geodata.

---

## 4. Administrator

```bash
cd ~/echo-echo/deploy
docker compose exec -it api node src/db/admin-setup.js
```

Prompts for the password (not echoed) and prints the authenticator secret and
`otpauth://` URI **once**. Scan it into Microsoft Authenticator before closing
the terminal; it is stored encrypted and nothing can read it back.

The owner is `ayush.17551@stu.upes.ac.in` and nobody else is added until a
real institutional address is provided.

---

## 5. Connecting the surfaces to the API

The browser must only ever see **one origin**. The session cookie is
`SameSite=Lax`, a browser decides "same site" by registrable domain, and
`vercel.app` is on the Public Suffix List — so `echo-echo-nu.vercel.app` and
any API host are different sites and the cookie is simply never sent. CORS
does not change that: it governs whether a request is *permitted*, not
whether the cookie rides along. Routing the API through a path on the same
origin is the only arrangement where `SameSite=Lax` survives unweakened.

Three edits that only work together. Any one alone leaves sign-in broken in a
way that looks exactly like the server being down, so do all three:

```bash
# 1. the rewrite (writes vercel.json; validates the host first)
node deploy/link-frontend.mjs 20-197-1-2.sslip.io

# 2. the build-time API base
vercel env rm  QUAD_API_BASE production
vercel env add QUAD_API_BASE production      # value:  /api

# 3. the API's allowed origin, on the VM
#    deploy/server.env:  WEB_ORIGIN=https://echo-echo-nu.vercel.app
bash deploy/deploy.sh

git add vercel.json && git commit -m 'deploy: point the surfaces at the API' && git push
```

`node deploy/link-frontend.mjs --check` reports the current state without
changing anything.

Verify from a terminal rather than the browser, so a failure is attributable:

```bash
curl -s https://20-197-1-2.sslip.io/health                    # the API itself
curl -s https://echo-echo-nu.vercel.app/api/health            # through the rewrite
```

If the first works and the second does not, the rewrite or the deployment is
the problem, not the API.

Only public configuration ever reaches Vercel. `DATABASE_URL`,
`COOKIE_SECRET`, `RESEND_API_KEY` and the S3 keys live **only** in
`deploy/server.env` on the VM.

### If you later buy the domain

Point `echoecho.tech` at Vercel and an `api` A record at the VM, then:
`API_HOSTNAME=api.echoecho.tech` in `deploy/.env`, `bash deploy/deploy.sh`,
`node deploy/link-frontend.mjs api.echoecho.tech`, and update `WEB_ORIGIN`
and `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGINS` to the new front-end origin.

---


## 6. Order of operations

The boot guard has no deferral flag for email or storage — only for payments.
So the API **cannot start in production** until Resend and S3 credentials
exist. Do them before the first `docker compose up`, or the container will
restart-loop with a readable message about what is missing.

1. Register the resource providers (§0)
2. Create the VM and the database (§1), and set the IP allocation to **Static**
3. Verify a Resend sending domain + create the private S3 bucket (§6 of the report)
4. `bootstrap-vm.sh`, fill `.env` and `server.env`, `deploy.sh` (§2) — migrations run here
5. Connect the surfaces: `link-frontend.mjs`, `QUAD_API_BASE=/api`, `WEB_ORIGIN` (§5)
6. Catalog seed — on explicit confirmation (§3)
7. `admin-setup` (§4)

Step 3 is the one that gates everything: the boot guard has no deferral flag
for email or storage, so the container will not start without them. Only
payments have a deferral (`PAYMENTS_DEFERRED=true`), and with it checkout
stays honestly unavailable rather than pretending.
