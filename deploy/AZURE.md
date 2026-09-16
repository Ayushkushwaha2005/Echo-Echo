# ECHO ECHO on Azure — deployment runbook

The surfaces are already on Vercel. This is the API half:

```
browser ──► echoecho.tech (Vercel)
               │  /api/* rewrite, so the browser only ever sees ONE origin
               ▼
         api.echoecho.tech ──► Caddy (TLS) ──► Fastify container ──► Azure PostgreSQL
```

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

```bash
# Docker
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER && newgrp docker

# The application
git clone https://github.com/Ayushkushwaha2005/Echo-Echo.git ~/echo-echo
cd ~/echo-echo/deploy
cp server.env.example server.env
chmod 600 server.env

# Generate the two secrets ON THE VM. They must never be typed into a chat
# window, a ticket, or an editor that syncs to the cloud.
echo "COOKIE_SECRET=$(openssl rand -base64 48)"
echo "ADMIN_TOTP_KEY=$(openssl rand -base64 48)"

nano server.env      # paste those two, plus DATABASE_URL, Resend and S3

docker compose up -d --build
docker compose ps
```

`restart: unless-stopped` means the API returns after a crash **and** after a
VM reboot. That matters more than it looks: the 30-second sweeper and the
60-second settlement scheduler are in-process timers, so a container that
stays down means abandoned orders are never released and settlement batches
are never built.

Verify locally on the VM before touching DNS:

```bash
curl -s localhost:8080/health          # {"ok":true,...}
curl -s localhost:8080/ready | head -c 400
```

`/ready` is the honest one — it checks PostgreSQL, the migration state and
every provider. `/health` only says the process is alive.

---

## 3. Migrations, then the catalog

```bash
docker compose exec api node src/db/migrate.js
```

Idempotent, and it also establishes `PLATFORM_OWNER_EMAIL` as `platform_owner`.

The catalog seed is **deliberately blocked under `NODE_ENV=production`** and
requires an explicit decision — see §7 of the deployment report for the exact
command and everything it writes. It creates no coordinates and no boundary
polygon, so **the campus geofence stays fail-closed**: students can browse,
and delivery is refused, until somebody supplies real surveyed geodata.

---

## 4. Administrator

```bash
docker compose exec -it api node src/db/admin-setup.js
```

Prompts for the password (not echoed) and prints the authenticator secret and
`otpauth://` URI **once**. Scan it into Microsoft Authenticator before closing
the terminal; it is stored encrypted and nothing can read it back.

The owner is `ayush.17551@stu.upes.ac.in` and nobody else is added until a
real institutional address is provided.

---

## 5. DNS and Vercel

| Record | Type | Value |
|---|---|---|
| `echoecho.tech` | A / ALIAS | Vercel's apex address |
| `www` | CNAME | `cname.vercel-dns.com` |
| `api` | A | the VM's **static** public IP |

Set the VM's IP allocation to **Static** first. A dynamic IP changes on
deallocation and the API silently disappears.

Then add the rewrite to `vercel.json` and redeploy:

```json
"rewrites": [
  { "source": "/api/:path*", "destination": "https://api.echoecho.tech/:path*" }
]
```

Only public configuration ever reaches Vercel. `DATABASE_URL`,
`COOKIE_SECRET`, `RESEND_API_KEY` and the S3 keys live **only** in
`deploy/server.env` on the VM.

---

## 6. Order of operations

The boot guard has no deferral flag for email or storage — only for payments.
So the API **cannot start in production** until Resend and S3 credentials
exist. Do them before the first `docker compose up`, or the container will
restart-loop with a readable message about what is missing.

1. Register the resource providers (§0)
2. Create the VM and the database (§1)
3. Verify Resend domain + create the private S3 bucket (§6 of the report)
4. Fill `server.env`, bring the stack up (§2)
5. Migrate (§3)
6. DNS + rewrite (§5)
7. Catalog seed — on explicit confirmation (§3)
8. `admin-setup` (§4)
