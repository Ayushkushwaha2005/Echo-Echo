# Continue with Microsoft — student sign-in

A second way into the **same** student account the email code opens. It is
off until three server values are set; until then the button is not shown and
`/auth/microsoft/start` sends the visitor back to the email screen.

## Who gets in

Only a person who is a **member** of the university's Entra tenant and whose
sign-in name (UPN) ends in exactly `@stu.upes.ac.in` — the same
`STUDENT_EMAIL_DOMAINS` rule and the same normalisation the email code uses.

| Check (server, `services/microsoft-oidc.js`) | Refuses |
|---|---|
| Authorize URL names the university tenant, not `common`/`organizations` | personal Microsoft accounts, every other organisation (Microsoft refuses before we see them) |
| ID token RS256 signature against the tenant's published keys | forged or altered tokens |
| `iss` and `tid` equal the pinned tenant | tokens from any other tenant, incl. the consumer tenant |
| `aud` = our client id, `exp`/`nbf`/`iat` (2 min skew), `nonce`, `ver` 2.0 | replayed, expired, or other apps' tokens |
| No `idp` claim other than the tenant, `acct` 0 if present | guests / B2B users invited into the tenant |
| `oid` present | identities without an immutable id |
| UPN normalised (lower case) and its domain **exactly** in the list | `gmail.com`, `outlook.com`, `upes.ac.in`, `stu.upes.ac.in.attacker.com`, `x.stu.upes.ac.in` |

The `email` claim is **never** used — Entra does not verify it. The UPN is used
because Entra only lets a tenant assign UPNs on domains that tenant has proven
it owns, and the tenant is pinned.

Flow protections: random `state` (stored hashed, single use, 10 min) bound to
the browser by an httpOnly cookie; PKCE S256; nonce; the code is redeemed on
the server with the client secret; the browser never receives a token.

## Accounts

- Same mailbox as an existing account → that account is signed in. No
  duplicate; orders, profile, roles, password and authenticator are untouched.
- First Microsoft sign-in binds the account to the Entra object id (`oid`).
  A different `oid` later presenting the same mailbox (a reissued name) is
  refused with a generic message, never re-linked.
- Session `auth_method` is `microsoft`; it is a student session exactly like
  `code` and carries no platform role (admin powers still need a passkey).
- Audit: `auth.microsoft.start`, `auth.microsoft.callback` (denied, with the
  reason), `auth.login` (`via: microsoft`, `linked`), `verification.email`.

## Setup (owner)

### 1. University tenant

`stu.upes.ac.in` is a managed domain in the Entra tenant
`91cc1fb6-1275-4acf-b3ea-c213ec16257b` (read from Microsoft's public
discovery document for the domain on 13 Nov 2026 — confirm it the same way:
`https://login.microsoftonline.com/stu.upes.ac.in/v2.0/.well-known/openid-configuration`).
That is the value for `MICROSOFT_TENANT_ID`.

### 2. App registration (in **your** Entra directory)

Entra admin center → **Identity → Applications → App registrations → New registration**

- Name: `ECHO ECHO`
- Supported account types: **Accounts in any organizational directory (Multitenant)**
  — required because students live in the university's tenant, not yours.
  Do not pick the option that includes personal accounts.
- Redirect URI: platform **Web**, `https://echoecho.tech/api/auth/microsoft/callback`
  (add `http://localhost:3000/api/auth/microsoft/callback` only for local use).

Then:

- **Certificates & secrets → New client secret** (24 months max). Copy the
  *Value* once, straight into Render (step 3). Never into chat, Git or a file.
- **API permissions**: `Microsoft Graph → openid` and `profile` (delegated).
  Nothing else; the app never calls Graph.
- **Token configuration → Add optional claim → ID → `upn`** (recommended; the
  code falls back to `preferred_username`).
- **Branding & properties**: publisher domain `echoecho.tech`; ideally become a
  **verified publisher** (Microsoft Partner Network ID) — many universities
  only allow students to consent to apps from verified publishers.

### 3. Server values (Render → echo-echo-api → Environment)

| Key | Value |
|---|---|
| `MICROSOFT_TENANT_ID` | university tenant id from step 1 |
| `MICROSOFT_CLIENT_ID` | Application (client) ID from step 2 |
| `MICROSOFT_CLIENT_SECRET` | the secret Value from step 2 |

`MICROSOFT_REDIRECT_URI` can stay unset in production (it defaults to
`https://echoecho.tech/api/auth/microsoft/callback` from `WEB_ORIGIN`).

### 4. University consent — likely needed

If the first student sees *"Need admin approval"*, the university restricts
user consent. A UPES Entra administrator must grant admin consent once:
`https://login.microsoftonline.com/91cc1fb6-1275-4acf-b3ea-c213ec16257b/adminconsent?client_id=<CLIENT_ID>`.
Until then students get the "your university has not yet approved" message and
the email code keeps working.
