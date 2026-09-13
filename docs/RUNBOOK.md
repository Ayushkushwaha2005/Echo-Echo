# Quad — production runbook

Operational procedures. `docs/DEPLOY.md` covers first-time setup; this is
what you need once it is running.

## Database

### Migrations

```bash
npm run migrate          # applies pending migrations, tracked in schema_migration
```

Forward-only, one transaction each, applied once. Re-running is safe: already-applied
files are skipped by name. A failure rolls back and exits non-zero, so a bad
deploy stops rather than half-applies.

Deploy order matters: **migrate before rolling new code**, and write each
migration so the previous release still works against it (add columns, don't
rename; backfill in a later release). That way a rollback needs no down-migration.

`/ready` reports which migrations the connected database has applied, so a
half-migrated instance is visible rather than mysterious.

### Backups

Neon Free keeps 6 hours of history; `.github/workflows/db-backup.yml` adds a
daily encrypted dump to a private B2 bucket. Procedure, restore drill and
incident recovery: [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md). Trigger the
workflow manually before any deploy that carries a migration.

The rows you cannot reconstruct from anywhere else: `food_order`,
`order_item`, `payment`, `refund`, `review`, `audit_log`, `verification_case`.
Everything else could in principle be re-entered by an administrator.

### Connection pooling

`PG_POOL_MAX` (default 10) is **per instance**. Keep
`instances × PG_POOL_MAX` below the provider's `max_connections` with headroom
for migrations and your own psql session. Past a few instances, put PgBouncer
in transaction mode in front — the code holds no session state in Postgres,
so transaction pooling is safe.

`PG_STATEMENT_TIMEOUT_MS` (default 15s) caps any single statement, so one
pathological query cannot pin a connection until the provider kills it.

## Health checks

| Path | Meaning | Point the LB at |
|---|---|---|
| `/health` | the process is alive | liveness |
| `/ready` | Postgres answers; per-provider configuration | **readiness** |

`/ready` returns 503 when the database is unreachable, so a broken instance
leaves rotation instead of serving errors. It also reports pool saturation
(`total`, `idle`, `waiting`) — a rising `waiting` means `PG_POOL_MAX` is too
low for the traffic.

## Logs

Structured JSON, one line per event, with `x-request-id` on every line
(honoured from the inbound header, so traces survive the proxy).

**Redacted at the logger**: cookies, authorization headers, the Razorpay
signature, `set-cookie`, and any field named `code`, `otp`, `password`,
`code_hash`, `token_hash`, `apiKey` or `secret`. OTP codes, enrolment codes
and session tokens therefore cannot reach a log aggregator. Do not add a log
line that prints a request body wholesale — `test/config-safety.test.mjs`
fails the build if a log statement references a secret-shaped field.

## Free-tier budgets to watch

| Budget | Where to look | What happens at the limit |
|---|---|---|
| Resend 100/day, 3,000/month | `SELECT outcome, count(*) FROM email_send_log WHERE at > now() - interval '1 day' GROUP BY 1`; `npm run check:email` prints today's/month's use | ECHO ECHO refuses student codes at 95/day or 2,900/month (5 kept for admin invites); students see "could not send the email right now" |
| Neon 100 CU-hours/month, 0.5 GB | Neon console → Usage | compute suspends until next month: **the whole API returns 503 on `/ready`**. Keep `SWEEPER=off` while payments are deferred |
| Render 750 instance-hours/month | Render → Billing/usage | service suspended |
| B2 10 GB | B2 → Caps & Alerts (alerts at 75% / 100%) | uploads refused |
| GitHub Actions 2,000 min/month (private repo) | Settings → Billing | backup job blocked — check it still ran |

A burst of `refused_budget` rows in `email_send_log` while traffic is low
means someone is requesting codes for many addresses: check `audit_log` rows
with `action = 'auth.email.send'` grouped by `ip`, and lower
`EMAIL_CODE_MAX_SENDS_PER_IP_HOUR` if needed.

## Administrator access incidents

**Suspected compromised administrator.** Anyone holding `admins.suspend`
(the owner always): Administrators → Suspend (ends every session now). Then the
owner reviews Administrators → Activity for that account and either restores
or revokes. Revocation removes roles, passkeys, recovery codes and invites.

**Owner's device lost.** Sign in with the email code → "I lost my passkey
device" → recovery code → register a new passkey (old passkeys and sessions are
revoked). No codes left: Render → Shell → `npm run admin:invite -- ayush.17551@stu.upes.ac.in`.

**An administrator gets "You do not have permission for this"**
(`permission_required`). Working as designed: the owner has not granted that
permission. Owner → Administrators → Permissions.

**An invited administrator cannot set up a passkey.** Check Administrators →
invitations: expired or cancelled invitations grant nothing. The owner re-issues
(New invite code). The invitee must sign in with exactly the invited mailbox.

## Background sweeper

On the free database tier run with `SWEEPER=off` while `PAYMENTS_DEFERRED=true`
(there are no orders to sweep, and each tick would keep Neon awake). When
enabled it runs in-process every `SWEEPER_INTERVAL_SECONDS` (default 30):

- expires unanswered delivery offers and re-offers, up to 3 rounds
- cancels orders that reached `awaiting_payment` and were never captured (20 min)
- prunes OTP challenges older than 24 hours and email-code challenges older than 48 hours
- deletes ID-card images past `ID_IMAGE_RETENTION_DAYS` (default 90)

Every statement is a conditional `UPDATE`, so running it on several instances
is safe. Set `SWEEPER=off` where it should not run.

## Payments

An order is confirmed by **one** path: `POST /payments/webhook`, after an
HMAC-SHA256 check over the raw bytes and an amount comparison against our own
`payment` row. Nothing a browser sends can confirm an order.

Register the webhook at `https://<your-api-domain>/payments/webhook` for
`payment.captured` and `payment.failed`. **If you forget, orders are paid for
and never confirm** — the money is taken by the gateway and the sweeper
cancels the order after 20 minutes. Verify the webhook before opening.

Duplicate deliveries are absorbed by the primary key on
`payment_webhook (provider, event_id)`.

### Refunds

`POST /refunds`, platform roles only. Executed against the gateway; the local
row reaches `completed` only when the gateway confirms. One live refund per
payment, enforced by a partial unique index. Shopkeepers and support cannot
refund; neither can the AI, which has no tool that reaches payments.

## Rollback

1. **Code**: redeploy the previous image. Migrations are forward-only, so the
   old code must still work against the new schema — see the migration rule above.
2. **Data**: point-in-time recovery to just before the incident. Expect to
   lose writes after that point; reconcile payments against the gateway
   dashboard, which is the external record of truth for money.
3. **A bad migration**: restore, do not improvise a down-migration under
   pressure.

## Incident notes

**"Orders are paid but stay awaiting_payment."** The webhook is not arriving.
Check the gateway's webhook delivery log, then that `RAZORPAY_WEBHOOK_SECRET`
matches, then that the endpoint is publicly reachable. Audit rows with
`action='payment.webhook', outcome='denied'` mean it arrived and failed the
signature check — usually a secret mismatch.

**"Students cannot sign in."** Check `/ready` → `providers.student_email.configured`.
If false, Resend is not configured and `POST /auth/email/send` returns 503. If
true: a 503 `email_unavailable` means the daily/monthly budget was reached or
Resend refused — the server log line `resend <status>: ...` or `email budget
reached` says which. Otherwise look in the Resend dashboard for bounces, and ask
the student to check Junk/quarantine. Per-address limits (5/hour, 12/day) and
the per-network limit (30/hour) return a clear 429 message.

**"An administrator cannot get in."** They sign in with the email code, then
confirm with their passkey. Lost device: "I lost my passkey device" → a saved
recovery code. No recovery codes left: the other administrator issues a
passkey invite from Administrators, or run `npm run admin:invite -- <email>`
on the server. See `docs/ADMIN-ACCESS.md`.

**"Delivery is refused for everyone."** Campus Control → Locations: is there
an **active** boundary? Without one, delivery orders are refused by design
and self pickup still works. For one location: it may be pending confirmation,
have no recorded position, or lie outside the boundary — each is refused with
that reason.

**"Deliveries are not being offered."** Offers need an *approved*, *online*
partner whose `student_status` is `approved`, who is not the customer and not
already on a delivery. Check `partner_profile`. Also confirm the sweeper is
running on at least one instance.

**Connection storms after a provider restart.** Expected: the pool discards
dead sockets and reconnects. The `pool.on('error')` handler stops an idle
client error from taking the process down. If it persists, lower
`PG_IDLE_TIMEOUT_MS` below the provider's idle cull.

## Security posture

- Sessions: 32 random bytes, only the SHA-256 stored; roles re-read from the
  database on every request, so revocation is immediate.
- `platform_owner` cannot be granted, revoked or suspended through any API,
  and cannot be reached by an enrolment code.
- Administrators hold only the granular permissions the owner granted; owner-only
  powers are never grantable. See `docs/ADMIN-ACCESS.md`.
- `audit_log` is append-only in the database.
- Per-IP rate limits are deliberately generous because a campus shares NAT.
  The real limits are per-phone and per-code, enforced in the database.
- ID-card images are never public and never presigned; they stream through an
  authorization check and every view is audited.
