# Frisco — Authentication & Authorization (prototype, historical)

> **This document describes the original in-browser prototype and is kept for
> history only.** The live product authenticates on the server: students with
> a code emailed to their institutional mailbox followed by a live-location
> check (`docs/STUDENT-VERIFICATION.md`), administrators with an email, a
> password and an authenticator code (`docs/ADMIN-ACCESS.md`), cafeteria
> staff with enrolment codes. There is no phone sign-in anywhere.
> Nothing below applies to a deployment.

**Status (prototype): implemented, tested, and NOT activated.** `AUTH_ENABLED` is `false`.

---

## 1. The switch

`packages/data/config.js` is the only place a flag is read. Nothing else in the
codebase touches an env var.

```
AUTH_ENABLED=false   ← current, shipped state
```

| | `false` (now) | `true` |
|---|---|---|
| Campus Control | user picker, no password | email + password required |
| Counter | user picker, no password | email + password required |
| Role check at the door | advisory | enforced, 403 |
| Cafeteria ownership check | enforced (data rule) | enforced |
| Capability + scope checks | enforced | enforced |
| Session expiry / revocation | n/a | enforced |
| Demo account list on login | shown | hidden automatically |

Capability and scope checks run in **both** modes — that is why a Frisco owner
already cannot touch Tulips today. The flag adds *identity*, not *rules*.

### Turning it on

```bash
AUTH_ENABLED=true \
PRIMARY_ADMIN_EMAIL=you@campus.edu.in \
PRIMARY_ADMIN_NAME="Your Name" \
npm start
```

The server refuses to boot with `AUTH_ENABLED=true` and no
`PRIMARY_ADMIN_EMAIL`, so you cannot lock yourself out:

```
AUTH_ENABLED=true but PRIMARY_ADMIN_EMAIL is not set. Refusing to start.
```

Resolution order is `process.env` → `globalThis.FRISCO_CONFIG` (injected by the
server into the page) → defaults. A browser build never contains a secret.

---

## 2. Your admin account

`PRIMARY_ADMIN_EMAIL` names the **platform owner** — the highest role.

- It is **never** hardcoded in frontend code, and no password is ever an env var.
- On first boot with auth enabled, the server emails a one-time enrolment link
  to that address. You set the password there.
- Passwords are stored **only** as hashes with a per-user salt.
- `platform_owner` is the only role that can grant or revoke `platform_admin`,
  and it cannot be suspended or archived by anyone — including other admins.

> **Prototype limitation, stated plainly.** This is a browser app with no
> server. Authentication cannot be *enforced* in a client — anyone can edit the
> JavaScript. What exists here is the correct **shape**: one login path, one
> session object, one gate, written so the same module runs unchanged on Node.
> When you stand up the backend, `verifyCredential` and `issueSession` move
> behind an HTTP boundary and no call site changes. The demo hash is SHA-256;
> the server must use Argon2id or bcrypt (cost ≥ 12).

---

## 3. Roles

| Role | Scope | Surfaces |
|---|---|---|
| `platform_owner` | platform | admin, counter, web |
| `platform_admin` | platform | admin, counter, web |
| `support` | platform | admin (read-heavy) |
| `vendor_owner` | one cafeteria | counter |
| `vendor_staff` | one cafeteria | counter |
| `delivery_partner` | self | web |
| `student` | self | web |

A user may hold several roles; capabilities are the **union**. Ayush is
`['student', 'delivery_partner']`. Vendor roles stay scoped to their outlet
even when combined.

---

## 4. The authorization layer

`authorize(session, action, resource)` in `packages/data/api.js`. Every
mutation calls it. Three checks, in order:

1. **Authentication** — only when `AUTH_ENABLED`; checks `authenticated`,
   expiry and account status.
2. **Capability** — does any role this user holds grant this action?
3. **Scope** — `own_vendor` rules compare `session.vendor` to the resource's
   vendor; `own` rules compare `session.id` to the row owner.

```js
authorize(admin,       'menu.update', 'caf_frisco')  // ALLOW
authorize(friscoOwner, 'menu.update', 'caf_frisco')  // ALLOW
authorize(friscoOwner, 'menu.update', 'caf_chai')    // DENY
authorize(student,     'menu.update', 'caf_frisco')  // DENY
```

Two extra guards live in `auth.js`:

- `requireSurfaceAccess(session, surface)` — the door. Called before any page
  renders.
- `requireVendorAccess(session, vendorId)` — direct-resource guard. A
  shopkeeper hitting another outlet's URL by hand gets **403, not a redirect**,
  because the resource must actually be inaccessible.

Row-level isolation is separate from the capability check: `api.orders()` and
`api.vendors()` filter to the session's own vendor regardless of what the
caller asks for.

---

## 5. What each role can do

**Admin / owner** — everything: cafeteria CRUD (add, edit, archive, restore,
assign owner, hours, open/close, staff-can-deliver); food across *all*
cafeterias (name, photo, description, price, category, availability, veg flag,
tags, prep time, options, AI aliases); campus location tree; users, roles,
verification, suspension; delivery config, fee and payout; all orders with full
event history; trust reports and policy actions.

**Cafeteria owner** — the same food and photo powers, plus prices, hours,
open/closed and staff — **for their own outlet only**. Cannot create or archive
outlets, edit campus locations, read platform users, change platform pricing,
or see another outlet's anything.

**Cafeteria staff** — orders and availability at their own outlet. No prices,
no adding food, no photos, no staff management.

**Student / delivery partner** — no management capability at all, and neither
role appears on the admin or counter surface lists.

---

## 6. Food, photos and prices

`api.setItemPhoto(session, itemId, { dataUrl, alt, filename })` attaches the
image to the actual menu row (`photo`, `photoAlt`, `photoUpdated`). The service
layer re-validates **type and size** (PNG/JPEG/WebP/GIF, ≤ 2.5 MB) — the
`accept=""` attribute on the file input is a convenience, not a control.

Items without a photo keep the emoji glyph, so the approved visual output is
unchanged for every existing item.

Price changes require the `menu.price` capability, which owners and admins hold
and counter staff do not. In the Counter UI, staff see the price field disabled
with the reason — and the server refuses the write regardless.

---

## 7. Historical orders are immutable

Each historical order line carries its own `name` and `unit` snapshot, frozen
at confirmation. Nothing is looked up live.

```
Veg Burger menu price   ₹90 → ₹95
Order F1799 line        still ₹90
Order F1799 total       still ₹165
```

Archiving the item, or archiving the entire cafeteria, also leaves history
intact — orders keep `cafName` alongside the vendor id.

**Deactivate, never delete.** Vendors and items carry `active: false`. There is
no destructive delete anywhere in the service layer.

---

## 8. Login flows (when activated)

```
Admin      login → authenticate → role ∈ {owner, admin, support} → Dashboard
Shopkeeper login → authenticate → role ∈ {owner, staff} → vendor bound → Counter
Failure at any step → 401 or 403. Never a silent redirect.
```

Sessions carry an opaque token, expire after `SESSION_TTL_MINUTES` (default
720), and are revoked on sign-out. Five failed attempts locks an address for 15
minutes. Wrong-password and unknown-email return the *same* message, so the
form cannot be used to enumerate accounts.

---

## 9. Tests

```bash
bash tests/run-all.sh
```

| Suite | Checks | Mode |
|---|---|---|
| `tests/authorization.mjs` | 131 | `AUTH_ENABLED=false` |
| `tests/auth-enforced.mjs` | 41 | `AUTH_ENABLED=true` (isolated process) |
| `tests/acceptance.mjs` | campus boundary, pricing, vendor CRUD | false |
| `tests/locations.mjs` | hierarchical resolution | false |
| `tests/bundle-smoke.mjs` | all three bundles execute | false |
| `tests/prototype.md5` | locked app is byte-identical | — |

The enforced suite runs in its own process with the env var set, so the live
prototype is never affected.
