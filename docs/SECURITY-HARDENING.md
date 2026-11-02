# Security hardening

Status of each finding in section 9 of the 31 Oct 2026 audit. Deployed in `26c9c99` on 3 Nov 2026 IST.

| ID | Status | What was done | What remains |
|---|---|---|---|
| S1 Invitation code not enforced | COMPLETE | `docs/INVITATION-FLOW.md` | Real inbox delivery only provable on production |
| S2 Shared origin and cookie | BLOCKED | Cookie confirmed host-only; steps in `STAGING-AND-DEPLOYMENT.md` | DNS, certificate and Vercel setup by the owner |
| S3 CSP report-only | PARTIAL | Enforced on Campus Control and Counter, verified in a browser: injected scripts blocked, no violations on tested journeys | The student site stays report-only, because it loads the checkout SDK and checkout can't be tested while payments are frozen |
| S4 Owner recovery | PARTIAL | Recovery codes, alert address, tested | Owner identity is still a student mailbox: change `PLATFORM_OWNER_EMAIL` before graduation |
| S5 Exposed authenticator secret | BLOCKED | Nothing could be checked: telling needs the owner | Owner replaces it in My Profile (below) |
| S6 High-risk approvals | PARTIAL | Café archive and website publish, the audit's two non-payment actions, are wired, off by default. DB refuses self-decision | Audit's main examples are payout and finance actions, excluded while frozen. A second approver for the owner doesn't exist |
| S7 Branch protection | BLOCKED | Confirmed `main` is unprotected; command prepared | Owner's decision |
| S8 Audit outside the transaction | PARTIAL | `atomic-routes.js` runs 44 privileged non-payment routes in one transaction with their audit row, and `auditTx` covers invitations, sessions, recovery, approvals and bulk menu. Proved by making the audit log fail: the change is undone | Finance, wallet, payment, refund and deposit routes keep best-effort audit, because they are frozen. Sign-in keeps it on purpose, so a logging fault can't lock everyone out |
| S9 Coordinates via `orders.view` | COMPLETE | `delivery.track`; views audited | Owner grants it deliberately |
| S10 Database roles | PARTIAL | `deploy/db-roles.sql`, proved on a throwaway database | Production change needs an owner decision and a backup |
| S11 Plaintext secrets on this PC | BLOCKED | Inventory done, all gitignored, history scanned | Owner moves them to a password manager, and checks `server/.env`, which points at a remote database |
| S12 Forged X-Forwarded-For | COMPLETE | Edge limit on every IP-keyed per-route limit; spoofing test | Effective only with `EDGE_CLIENT_IP_HEADER` set in production |
| S13 Legacy passkey path | PARTIAL | Gone from the invitation flow and email | Route and `WEBAUTHN_*` settings kept: proving no account depends on them needs reading production |
| S14 Public `/ready` | COMPLETE | Provider and pool detail for administrators only; owner email out of `render.yaml` | The address remains in Git history |
| S15 Dependencies | COMPLETE | `npm audit`: 0 vulnerabilities in `server` after updating `fast-uri` | The GitHub alerts close once this merges |
| S16 Image re-encoding | COMPLETE | Decoded and rebuilt server-side with `sharp` | Adds a native dependency: check the production image builds |
| S17 Request ids | COMPLETE | Strict format, otherwise generated | |
| S18 Session timeout | COMPLETE | 60 idle minutes, `last_seen_at` per session | |
| S19 Auto-deploy mismatch | COMPLETE | Turned off in the Render dashboard on 3 Nov 2026; the API reports `autoDeploy: no` | Keep it off, so every deploy passes CI and the migration gate |

## S5: replacing the authenticator (owner only)

The audit found a production authenticator secret that had appeared in a screenshot, with no record it was
replaced. Whether it is still active can't be told from here, and it was not looked up. Treat it as exposed:

1. In Campus Control, open **My Profile → Authenticator** and start a replacement.
2. Scan the new key. The old one keeps working until a code from the new one is accepted, so this can't lock you out.
3. Confirm with a code from the new entry. Other sessions end at that point.
4. Delete the old entry from the app, and delete the screenshot and any copies.
5. Create recovery codes on the same page and store them away from your phone.

## Security issues found while doing this work

- **The administrator detail route returned the wrong person. This is live on `main`.** `WHERE a OR b AND u.id = $1` meant `GET /admin/access/admins/:id` could return the first administrator with an account row, so once a second one exists the detail panel, sessions, activity and permission form could show someone else. Saving that form sends the target's id with permissions read from the wrong person, so **check any permission changes made once more than one invited administrator exists**. Found by a browser journey, fixed, regression-tested.
- **Enforced CSP would have blocked the website preview frame.** Found by a browser journey before release; `frame-src` now allows `'self'`.
- **Revoked certificate warning.** On 2 Nov 2026, Windows reported `udyamregistration.gov.in` as revoked. That's a
  government site, unrelated to ECHO ECHO, and already raised with the owner.
- **`sharp` 0.33.5 had a high-severity advisory** when first chosen, so 0.35.5 is pinned.
- **The Menu café picker ignored a keyboard or phone selection.** This is live on `main`. The dropdown showed the new café while the page kept the old café's menu, so an edit could land on the wrong café. Found by a browser journey and fixed.
- **Test isolation:** the test helper could connect to another checkout's database on the same port and drop it. It now checks the data directory first.
- **A stream start race** could miss a change made right after connecting. Found by a test and fixed.
- **Duplicate-photo detection** would have silently stopped working once images were re-encoded. Found by an
  existing test and fixed: the fingerprint is now of the uploaded bytes.

## Not done

This work was not a penetration test, and one is still worth having. The audit's `innerHTML` uses were checked two ways rather than read line by line: a browser journey stores script payloads in cafés, dishes, names, notes, reviews, support cases, delivery addresses and data requests, then opens every Campus Control page and six student pages; and a scan found no unescaped user-text field in the three apps outside `modal()` titles, which it escapes.
