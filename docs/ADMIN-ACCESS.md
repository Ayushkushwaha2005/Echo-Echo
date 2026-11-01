# Administrator access

## Who

| Person | Account | Access | How it is established |
|---|---|---|---|
| Ayush | `ayush.17551@stu.upes.ac.in` | **platform owner** — every permission, including owner-only powers | `PLATFORM_OWNER_EMAIL` on the server, applied when that mailbox is proven with the email code |
| Anushka | *her UPES email — not yet provided* | administrator, permissions chosen by Ayush | invited from Campus Control → Administrators → Invite administrator |
| Anyone else later | their UPES email | administrator or support, permissions chosen by Ayush | same invitation flow |

No account is created in advance and no password exists anywhere. Nobody's
email is hardcoded besides the owner's server configuration.

## The model

Three layers, all enforced on the server on **every request**:

1. **Role ceiling** (`user_role`): `platform_owner`, `platform_admin`, `support`.
2. **Granular permissions** (`admin_account.permissions`), chosen per person
   by the owner from the catalogue in `server/src/auth/permissions.js`. Each
   permission unlocks specific capability keys; routes check capability keys.
   A permission can only narrow what the role allows, never widen it.
3. **Passkey session**: platform roles are withheld from any session not
   opened (or re-confirmed) with that account's passkey. Sensitive actions also
   need a passkey confirmation from the last 10 minutes.

The session actor is rebuilt from the database on each request, so a
permission change, suspension or revocation applies to open sessions on their
very next request (tested: `server/test/admin-access.test.mjs`).

### Permission catalogue

| Area | Permissions |
|---|---|
| Students | `students.view`, `students.verify`, `students.suspend`, `students.reinstate` |
| Cafeterias / menus | `cafeterias.view`, `cafeterias.manage`, `menus.view`, `menus.manage` |
| Orders | `orders.view`, `orders.manage`, `orders.override` |
| Delivery | `delivery.view`, `delivery.manage`, `delivery.assign`, `delivery.incidents`, `delivery.resolve_incidents` |
| Partners | `partners.view`, `partners.approve`, `partners.suspend`, `partners.reinstate` |
| Deposits | `deposits.view`, `deposits.manage_policy`, `deposits.record`, `deposits.propose_deduction`, `deposits.approve_deduction`, `deposits.refund` |
| Reviews | `reviews.view`, `reviews.moderate`, `reviews.resolve_reports` |
| Campuses | `campuses.view`, `campuses.manage`, `locations.view`, `locations.manage`, `boundary.view`, `boundary.confirm` |
| Staff / counter | `staff.view`, `staff.manage`, `counter.manage` |
| Support | `support.view`, `support.manage` |
| Platform | `platform.view`, `platform.manage` |
| Audit | `audit.view` |
| Finance | `finance.view`, `finance.manage` |
| Administrator access | `admins.view`, `admins.suspend`; **owner only:** `admins.invite`, `admins.edit_permissions`, `admins.revoke`, `admins.restore` |
| Security | `sessions.revoke`; **owner only:** `passkeys.manage`, `security.manage` |

Presets offered in the invite form (copied into the person's explicit list —
editing a preset later never changes an existing admin): Operations admin,
Support (read-mostly), Student verification only, Every grantable permission.

`delivery.assign` exists in the catalogue but no manual-assignment route
exists yet (assignment is by partner acceptance); holding it currently grants
nothing.

Permissions flagged "shows personal data" (`students.view`, `orders.view`,
`partners.view`, `support.view`) expose names, emails or phone numbers. Grant
them only to people who need them. No permission ever exposes passwords (none
exist), codes, session tokens, API keys, passkey private keys, or recovery
codes — those are either never stored or stored only as hashes.

### Owner-only powers

Never grantable to anyone, through any API:

- becoming, replacing or changing the owner (server configuration only)
- inviting administrators, changing any administrator's permissions, revoking
  or restoring administrator access, cancelling invitations
- removing another administrator's passkeys
- issuing an enrolment sign-in code into another administrator's account
- security architecture (`security.manage` is a named placeholder; the
  configuration itself lives in server environment variables)

In addition, for every administrator-access action: the owner cannot be the
target, nobody can act on their own record, a written reason is required, and
a passkey confirmation from the last 10 minutes is required.

Accounts that hold `platform_admin` without an explicit permission list (e.g.
from `PLATFORM_ADMIN_EMAILS`, or granted before per-admin permissions existed)
get the role default — every grantable permission — shown as "role default" in
Campus Control. Narrow them from there.

## Inviting an administrator

The owner invites from Access Management with a name, any email address and the exact permissions. The
employee gets a link, proves the mailbox with a code, reviews and accepts, sets a password and confirms an
authenticator. Only that last step activates the account. See `docs/INVITATION-FLOW.md`.

## Permissions added in November 2026

- `delivery.track`: exact positions on the live map. Nobody is migrated into it. Grant it deliberately.
- `sessions.read`: other administrators' sessions and devices. Everyone holding `admins.view` was given it.
- `reports.export`: order report downloads. Everyone holding `orders.view` was given it.

Not done, because payments are frozen: splitting `finance.view` and `finance.manage` into payments,
settlements, pricing, payouts and adjustments. When that work resumes, every holder of `finance.manage` should get
all the new keys first, so nobody silently gains or loses power, and the owner can then narrow them. Finance
reports do not check `reports.export` for the same reason.

## Sessions

Sessions show last activity and a device name. One session can be ended by its opaque handle, or all of them at
once. Ending takes effect on the next request, and administrator sessions end after `ADMIN_IDLE_MINUTES` (60) idle.

## Recovery

An administrator creates recovery codes in My Profile: shown once, stored hashed, and replaced whenever a new
set is made. On the sign-in screen, **Lost your authenticator?** takes the password plus one code and allows
setting up a new authenticator, and nothing else. It opens no session, alerts every address on the account, and
signs out every session. Five wrong codes lock recovery for an hour. An alert address in My Profile can also
receive these alerts, ideally one that is not a student mailbox, and it can do nothing else.

**The owner's identity is still `PLATFORM_OWNER_EMAIL`, a student mailbox.** Moving it to a non-student address is
a server configuration change for the owner to make before graduation.

## Approvals

A non-owner's request for an action under an enabled policy queues on the Approvals page. The owner decides after
confirming it is them. The database refuses self-decision and any change to the payload, and execution happens once,
after re-checking current state. **With one owner, the owner's own actions run directly: there is no second person
to check them, and independent approval needs another owner-grade person, which does not exist.** Only archiving a
café is in the queue today, off by default. Payment actions were left out while payments are frozen.

## Lifecycle

| Action | Who | Effect |
|---|---|---|
| Change permissions | owner | applies on the next request; audited with added/removed/reason |
| Suspend | owner, or an admin holding `admins.suspend` | status suspended; every session ends; passkey sign-in refused; passkeys kept |
| Sign out everywhere | owner, or `sessions.revoke` | every session of that account ends |
| Revoke | owner | admin role, passkeys, recovery codes, pending invites, all sessions revoked; the person's **student account is unaffected** |
| Restore | owner | from suspended → active with the same permissions; from revoked → invited (needs a new invite code) |
| Activity | `admins.view` | status, permissions, passkeys, open sessions (metadata only), last sign-in, access history, last 100 actions |

## Anushka

Her email is not in the code or configuration and has not been invented. When
you have it: Campus Control → Administrators → Invite administrator. Nothing
else is needed.

## Passkeys

WebAuthn with `userVerification: required`: fingerprint, Face ID, Windows Hello
or device PIN. The biometric and PIN never leave the device; the server stores
a public key, a signature counter and a label. Details and recovery: unchanged
from the original design —

- first passkey needs a one-time invite (from an invitation, or
  `npm run admin:invite -- <email>` on the server shell);
- 10 recovery codes shown once, hashed, each usable once, good only for
  registering a replacement passkey (the recovery session carries no roles);
- 5 wrong recovery codes in an hour lock recovery for that account;
- removing a passkey ends every session opened with it.

## Sessions

HttpOnly, `SameSite=Lax`, `Secure` in production; only a SHA-256 of the token
is stored; administrator sessions expire after 4 hours; CSRF origin checks on
every cookie-bearing write; per-identity limits in the database.

## Separation of duties

- The administrator who proposes a deposit deduction cannot decide its
  dispute; the owner may only when no other administrator holds a passkey.
- Deductions need an incident resolved as the partner's responsibility,
  written evidence, a dispute window and an explicit apply step — and now also
  separate permissions (`deposits.propose_deduction` vs
  `deposits.approve_deduction`).

## Audit

Every privileged action writes actor, action, target, time, outcome and a
detail object (reason, before/after where relevant). Every refusal is written
too. `audit_log` is append-only in the database (migration 015 trigger refuses
UPDATE and DELETE).
