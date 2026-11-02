# Staging and deployment

## Staging: prepared, not created

No hosted staging environment exists. Nothing already configured can stand in for one: Vercel previews
proxy to the single production API, and production refuses their writes. Instead, the `rehearsal` job in
`ci.yml` runs on every push with free GitHub runners and synthetic data: it builds the production image,
upgrades from the previous release's schema, dumps and restores with timings, starts the image on the
restored database, and starts the previous release on the new schema. That proves the release mechanics,
but not real hosting, the Vercel proxy or the network. For a hosted environment,
`deploy/staging.render.yaml` is ready to use, and this is what it takes:

1. **Database:** create a separate free Neon project, not a branch of production. A branch copies
   production's personal data, so it must not be used here.
2. **API:** create a Render Blueprint from `deploy/staging.render.yaml` and set its secrets in Render.
   Generate new ones; never reuse a production value.
3. **Frontend:** a separate Vercel project with `QUAD_API_BASE` pointing at staging.
4. **Data:** run `npm --prefix server run migrate`, then `seed`. Synthetic data only. The production
   backup must never be restored here.
5. **Payments:** leave deferred. Staging uses no payment keys unless a test is explicitly approved.

Limit: a free Render instance sleeps, so staging cannot measure cold-start-free targets or hold
streams open. A paid instance is the owner's decision.

## Releasing this branch

The existing release process stays: PR, CI, deploy workflow with its migration gate, then the
live check. Migrations 036 to 042 are additive (`server/test/migration-upgrade.test.mjs` proves it from a populated 035):

| Migration | Adds | Note |
|---|---|---|
| 036 | Invitation lifecycle, `staff_email` | Changes one identity CHECK to allow `staff_email` |
| 037 | Location consent | New table |
| 038 | Session activity, recovery tickets | Adds `sessions.read` and `reports.export` to existing holders of `admins.view` and `orders.view`, so nobody loses access |
| 039 | Change feed, catalogue revisions | Triggers on catalogue, partner, support, review, incident and location tables. **None on orders or payments** |
| 040 | Approvals | Off by default, so nothing queues |
| 041 | Data requests | New table |
| 042 | Restore from history, website publish approval, deletion request review | Replaces the revision trigger function; policy off by default |

**What changes for people on release:**

- `orders.view` holders stop seeing exact positions until granted `delivery.track`.
- Partners must tap Start sharing. A phone with the old page open will be refused until it reloads.
- Administrator sessions end after 60 idle minutes (`ADMIN_IDLE_MINUTES`).
- `/ready` no longer shows provider detail publicly; `tools/live-check.mjs` was updated.
- Before syncing the Blueprint, confirm `PLATFORM_OWNER_EMAIL` is set on the Render service. It is now
  `sync: false`, which keeps the value already there.

**Rollback:** redeploy the previous commit. The migrations can stay, because the old code ignores new
columns and tables. One catch: old code would not know about `staff_email`, so any staff-only
administrator could not sign in until the release is restored.

## Admin on its own host (S2): prepared, not done

Moving Campus Control to `admin.echoecho.tech` isolates it properly. The session cookie is host-only
(no `Domain`), HttpOnly, SameSite=Lax and Secure, so a separate host gets a separate cookie with no
code change, and browsers would not send it to the student site. Remaining steps, all outside this repo:

1. Add the DNS record and let Vercel issue the certificate.
2. Serve `/admin/` there, with `/api` proxied the same way, and redirect `/admin/` on the main host.
3. Add the host to `WEB_ORIGIN`, and set `ADMIN_PUBLIC_URL=https://admin.echoecho.tech/`.
4. Administrators sign in once on the new host. Their old sessions simply stop being used.

## Database roles (S10): prepared and tested, not applied

`deploy/db-roles.sql` creates a runtime role that owns nothing, tested on a throwaway database by
`server/test/db-roles.test.mjs`. Using it means a new `DATABASE_URL` for the API and a separate one for
migrations in the deploy workflow, so it needs an owner decision and a backup first.

## Secrets (S11)

Checked on this PC without printing any value, on 2 Nov 2026:

- `server/.env`, `server/.env.production`, `deploy/.env.providers`, `deploy/.env.backup` and `API.txt` all
  exist and are all gitignored. None is tracked.
- **`server/.env` points at a remote database, not a local one.** Its host differs from the one in
  `server/.env.production`, so it was not confirmed to be production. Check it: a dev file that reaches a
  real database is how accidents happen. It was not changed.
- Git history across all branches: 0 private keys, AWS-style keys, Cashfree production secrets, Resend keys,
  Brevo keys or GitHub tokens by pattern. The one database URL match is a placeholder in `deploy/GO-LIVE.md`.
  A pattern scan can miss things, so it is a reason for confidence and not proof.
- Moving these into a password manager is for the owner to do.

## GitHub branch protection (S7): not enabled

`main` is unprotected. This was left for the owner because it changes how every future merge works. To turn
on the audit's recommendation:

```
gh api -X PUT repos/Ayushkushwaha2005/Echo-Echo/branches/main/protection --input docs/branch-protection.json
```

Check the repository name first. `docs/branch-protection.json` requires a PR and the CI checks and blocks
force pushes. It leaves administrators able to override in an emergency.

## Render auto-deploy (S19)

`render.yaml` says `autoDeployTrigger: "off"`. Read from the Render API on 2 Nov 2026: `autoDeploy: yes`,
`autoDeployTrigger: commit`. The last five deploys were all `api`, so CI and the migration gate have not been
bypassed in that sample, but nothing prevents it. Changing the setting through the API was refused by the
permission controls of the session doing this work. The owner should turn it off in the Render dashboard under
Settings → Auto-Deploy, before the next merge to `main`.
