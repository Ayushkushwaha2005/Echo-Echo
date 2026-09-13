# Backup and recovery

**Status: the procedure and the automation are ready; no backup is running
yet**, because the production database and buckets do not exist yet. Do not
treat ECHO ECHO as backed up until the first restore drill below has
succeeded.

## Why an extra backup is required on the free stack

Neon Free (checked 13 Sep 2026, neon.com/pricing) keeps **6 hours** of
point-in-time history (1 GB limit). That covers "I ran a bad UPDATE ten minutes
ago". It does **not** cover a problem noticed the next morning, a deleted
project, or losing the Neon account. So two layers are used:

| Layer | What | Retention | Cost |
|---|---|---|---|
| 1. Neon PITR | instant restore to any moment in the last 6 h | 6 hours | free |
| 2. Daily logical dump | `pg_dump` → AES-256 encrypted with your passphrase → private B2 bucket, by GitHub Actions (`.github/workflows/db-backup.yml`) | 30 days (B2 lifecycle rule) | free within B2's 10 GB and GitHub's 2,000 min/month; both stop rather than bill |

Worst case with this setup: up to **24 hours** of writes lost if the
database is lost outright. Before real payments go live, decide whether that
is acceptable or whether a paid database with longer PITR is warranted.

## What must be backed up

| Data | Where | Can it be rebuilt? |
|---|---|---|
| Orders, order items, events | PostgreSQL | **No** |
| Payments, refunds, webhooks, ledger, payouts, reconciliation | PostgreSQL | **No** |
| Deposit movements, deductions, incidents, reviews | PostgreSQL | **No** |
| Accounts, roles, administrator accounts and permissions, invitations, verification cases, passkey public keys, recovery-code hashes | PostgreSQL | **No** |
| Audit log (append-only) | PostgreSQL | **No** |
| Menus, cafeterias, campus locations, boundaries | PostgreSQL | by hand, slowly |
| Menu, cafeteria and partner photos; ID-card images | B2 assets bucket | No (ID images are deleted after 90 days by design) |

Not backed up, by design: sessions and one-time codes (they expire) and
secrets (Render's environment + your password manager).

## Setting up the daily dump

1. Create a **second** private B2 bucket, e.g. `echoecho-prod-backups`, with a
   lifecycle rule "keep only the last 30 days of versions".
2. Create a B2 application key restricted to that bucket (Read + Write).
3. Put the repository on GitHub (private is fine) and add the secrets listed at
   the top of `.github/workflows/db-backup.yml`.
4. Actions → db-backup → **Run workflow** once. Confirm a `.dump.gpg` file
   appears in the bucket.

The dump contains names, emails and phone numbers; it is encrypted before it
leaves the runner, and the passphrase exists only in GitHub secrets and your
password manager.

## Restore drill (before launch, then quarterly)

```bash
# 1. download and decrypt
aws s3 cp s3://echoecho-prod-backups/echoecho-YYYY-MM-DDTHHMMZ.dump.gpg . --endpoint-url https://s3.<region>.backblazeb2.com
gpg --decrypt echoecho-YYYY-MM-DDTHHMMZ.dump.gpg > restore.dump

# 2. restore into a NEW Neon branch or a local Postgres, never over production
createdb echoecho_restore_test            # or create a Neon branch and use its URL
pg_restore --no-owner --no-privileges --dbname="$RESTORE_URL" restore.dump

# 3. check it is coherent
cd server
DATABASE_URL="$RESTORE_URL" npm run migrate       # expect: every migration "already applied"
psql "$RESTORE_URL" -c "SELECT sum(amount_paise) FROM ledger_entry"   # expect 0
psql "$RESTORE_URL" -c "SELECT count(*) FROM audit_log"
```

Then start an API locally against it and check `/ready`. Record the date and
how long it took in this file.

| Date | Dump used | Minutes to restore | By |
|---|---|---|---|
| — | — | — | — |

## Recovering from an incident

1. **Bad code release** — Render → Deploys → roll back. Migrations are
   additive and forward-only; the previous release works on the newer schema.
2. **Bad data change noticed within 6 hours** — Neon console → Restore (or
   create a branch at a timestamp just before the change, verify it, then
   restore). Writes after that point are lost.
3. **Older problem, or the Neon project is gone** — create a new Neon project,
   restore the latest good dump (drill above), point `DATABASE_URL` at it,
   redeploy. Reconcile any payments against the gateway dashboard once
   payments are live.
4. **Bad migration** — restore the pre-deploy dump into a new database, point
   the API at it, fix the migration. Do not improvise a down-migration.

After any restore the ledger must balance: `SELECT sum(amount_paise) FROM ledger_entry` is `0`.

Before every deploy that includes a new migration, trigger the db-backup
workflow manually and wait for it to finish.

## Object storage (B2)

- Enable **versioning / keep prior versions for 30 days** on the assets
  bucket so an accidental delete is recoverable.
- Photos are referenced by key from `asset.storage_key`; restore the database
  and objects from close points in time.
- ID-card images purged after `ID_IMAGE_RETENTION_DAYS` (90) must not be
  "recovered" — that deletion is intentional.

## The audit log is append-only

Migration 015 installs a trigger that refuses `UPDATE` and `DELETE` on
`audit_log`. A restore preserves it. If audit retention is ever required,
it is a deliberate operator task by the database owner (disable trigger,
archive, re-enable), recorded in the runbook — never an application feature.

## Secrets

In Render's environment and your password manager, never in the repository:
`COOKIE_SECRET`, `DATABASE_URL`, B2 keys, Resend key, backup passphrase, and
later payment credentials. Losing `COOKIE_SECRET` signs everyone out and voids
in-flight email codes; it loses no data.

## Administrator lock-out

If the owner loses every passkey and every recovery code: sign in with the
email code, then in Render → Shell run `npm run admin:invite -- <owner email>`.
Shell access to the deployment is the proof of ownership. There is no other
back door.
