# Edge security — what to put in front of Quad, and what not to expect from it

## Recommendation: Cloudflare free tier

For a campus pilot, Cloudflare's free plan in front of the API and the three
web surfaces. It is genuinely free at this scale, it is a DNS change rather
than an integration, and it can be removed as easily as it is added.

**Do not enable it blindly.** The list below says exactly what it protects and,
more importantly, what it does not — because an edge layer that is believed to
protect things it does not is worse than none at all.

---

## What Cloudflare actually protects

| Control | What it does for Quad | Plan |
|---|---|---|
| TLS termination + managed certificate | HTTPS on every surface without certificate renewal as an operational task | Free |
| Automatic HTTPS rewrites / Always Use HTTPS | A plaintext request is redirected before it reaches the origin | Free |
| Network-layer DDoS mitigation | Volumetric L3/L4 floods absorbed at the edge, unmetered on every plan | Free |
| Managed WAF ruleset (free tier) | A limited set of high-signal rules — the OWASP core ruleset and rate-limiting rules are paid | Free (limited) |
| Origin IP concealment | The origin is not directly addressable once DNS is proxied, provided it is also firewalled | Free |
| Bot Fight Mode | Crude automated-traffic filtering. Can produce false positives on legitimate API clients — test before enabling | Free |

**Requirement if you enable it:** set `TRUST_PROXY=true` on the server. Without
it, Fastify sees Cloudflare's IP on every request, and the per-IP rate limits
and the `ip` column in `audit_log` become useless — every request appears to
come from the same address. With it set, do **not** expose the origin directly:
`X-Forwarded-For` is trivially spoofable by anyone who can reach the origin, so
lock the origin's firewall to Cloudflare's published IP ranges.

---

## What remains the backend's job, and always will

This is the important half. None of the below is protected by an edge layer,
and none of it should be moved there.

| Control | Where it lives | Why not at the edge |
|---|---|---|
| **Payment amount authority** | `services/pricing.js`, `order_financials` CHECK constraints | The amount is computed from `menu_item` rows and frozen. No edge rule can tell a correct total from a tampered one |
| **Webhook authenticity** | `routes/payments.js` — HMAC over raw bytes, timing-safe | Cloudflare cannot verify a signature it has no secret for |
| **Webhook idempotency / replay** | `payment_webhook` primary key on `(provider, event_id)` | A replayed webhook is a *valid* request; only application state knows it is a duplicate |
| **Authorization and IDOR** | `auth/rbac.js` — capability + scope, resource owner read from the database | Whether this cafeteria owns this order is not visible in an HTTP request |
| **Payout idempotency** | Partial unique index on `payout`, `ledger_txn (kind, ref)`, provider idempotency keys | Money movement is a database invariant |
| **OTP and handover attempt limits** | `otp_challenge` / `order_handover_code`, per-identity in the database | Per-IP limits at the edge are diluted by NAT and rotation; per-phone and per-order limits are not |
| **Campus boundary** | `services/campus.js` — server-side polygon test, fails closed | A geofence is a business rule, not a network rule |
| **SQL injection** | Parameterised queries throughout `pg` | A WAF signature is a second line of defence for code that is already wrong |
| **Session integrity** | `auth/session.js` — token hash in Postgres, `SameSite=Lax` secure cookie | — |

The rate limits that actually protect an account in this codebase are
**per-identity and in the database** — the OTP service's per-phone hourly cap,
the handover code's attempt ceiling, the enrolment code's ceiling. Those cannot
be diluted by an attacker rotating IP addresses, which is precisely why the
per-IP limits in `config.js` are deliberately generous: on a campus, an entire
university shares a handful of NAT addresses, and a tight per-IP limit on the
login endpoints would lock out everyone the moment a lecture ended.

---

## Security headers

Already set by the application on every response, in `src/index.js`:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains   (when SECURE_COOKIES)
```

The CSP is maximally restrictive because the API serves JSON only — nothing it
returns is ever rendered. **Do not also set these at the edge**: duplicated
headers are a common source of confusion, and the application's are correct.
If you add Cloudflare Transform Rules for headers, make them add only what the
static surfaces need, not what the API already sends.

---

## What to configure, in order

1. Proxy DNS for the API host and the three web surfaces through Cloudflare.
2. SSL/TLS mode **Full (strict)** — anything less lets the edge-to-origin hop
   run unauthenticated, which defeats the point.
3. Always Use HTTPS on.
4. Set `TRUST_PROXY=true` on the server.
5. Firewall the origin to Cloudflare's IP ranges. **Without this step, steps
   1–4 are cosmetic** — anyone who finds the origin address bypasses the edge
   entirely and can now also spoof `X-Forwarded-For`.
6. Leave `/payments/webhook` reachable. It is exempt from the application's
   rate limiter by design — the gateway retries, and throttling a payment
   webhook risks an order that was paid for but never confirmed. If you add an
   edge rate-limit rule, exclude that path explicitly.
7. Test Bot Fight Mode against the real surfaces before leaving it on.

---

## What this does not remove from the readiness list

Edge security changes nothing about the external provisioning blockers: the
payment provider account, the payout account and payee onboarding, the SMS
gateway, S3-compatible storage, and the campus boundary polygon. An edge layer
in front of an application that cannot send an OTP is still an application that
cannot send an OTP.
