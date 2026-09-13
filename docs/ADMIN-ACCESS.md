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

1. Owner: Administrators → **Invite administrator** → name, UPES email, role
   ceiling, permissions → Save (passkey confirmation).
2. The server stores the invitation **keyed by email**, with the one-time
   code stored only as a salted hash, and emails the code via Resend. If email
   cannot be sent, the code is shown to the owner once instead.
3. The invitee signs in with that mailbox using the normal email code. Only
   then — mailbox proven — does the invitation become their role, their
   `admin_account` (status **invited**) and their passkey invite.
4. They enter the invitation code and create a passkey. The account becomes
   **active** and receives 10 recovery codes, shown once.

Invitations expire after `ADMIN_PASSKEY_INVITE_TTL_HOURS` (default 24), are
single-use, allow 5 wrong attempts, and are never written to logs or the audit
log. An expired or cancelled invitation grants nothing.

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
