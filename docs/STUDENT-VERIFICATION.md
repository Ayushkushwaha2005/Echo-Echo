# Student verification (zero-cost, no SMS)

## States

| API (`verificationStatus.state`) | Stored `app_user.student_status` | Can order / deliver |
|---|---|---|
| `UNVERIFIED` | `unverified` | no |
| `EMAIL_VERIFIED` | `email_verified` | no — mailbox proven, admin approval outstanding |
| `PENDING_ADMIN_REVIEW` | `pending`, `needs_review` | no |
| `VERIFIED` | `approved` | yes (delivery still needs separate partner approval) |
| `REJECTED` | `rejected` | no |
| `SUSPENDED` | `suspended` (or account `status = suspended`) | no |

Stored names were kept so every existing server-side gate — `assertMayOrder`
(orders, payments, AI assistant), delivery offers, partner application and
approval — is unchanged.

## Paths, strongest first

1. **University email** (`POST /auth/email/send` → `/auth/email/verify`, or
   `/verification/email/*` for an account already signed in). The server
   sends a 6-digit code to the exact address; only `STUDENT_EMAIL_DOMAINS`
   (default `stu.upes.ac.in`, exact match) is accepted. Success signs the
   student in and records the proof.
2. **College ID card** (`POST /verification/submit`) — optional. Always admin-reviewed.
3. **Manual request** (`POST /verification/manual`) — for a student who has
   neither. Accepts no document. An admin may approve only with a written
   record (≥ 10 chars) of the evidence checked; the database enforces this.

## Why mailbox proof makes a student VERIFIED by default

- The university issues and withdraws `@stu.upes.ac.in` mailboxes, so control
  of one is evidence of current enrolment that a photo cannot give.
- What `VERIFIED` unlocks is limited: prepaid ordering to configured campus
  destinations only. Delivering requires a *second*, separate admin approval.
- One mailbox can verify one account (unique index); plus-addressing is refused.
- Admins can suspend a verification at any time, effective on the next request.
- A student code never overrides an admin decision (`rejected`, `suspended`,
  `needs_review` stay as they are).

Set `STUDENT_EMAIL_REQUIRES_ADMIN_REVIEW=true` to require a human to approve
every mailbox-verified student instead (e.g. if alumni mailboxes turn out to
stay active).

## Code security

`crypto.randomInt`; stored as HMAC-SHA256 keyed with `COOKIE_SECRET` plus a
per-challenge salt; 10-minute expiry; 5 attempts claimed atomically; single
use, consumed atomically; a new code supersedes the old; 60 s resend cooldown;
5 sends/hour and 12/day per address; per-IP route limits; `link` challenges
bound to one account by foreign key; send is serialised per address; no code is
ever returned, logged, or included in a provider error.

## Operational limits to know

- Resend free plan: 3,000 emails/month, **100/day**, 1 sending domain. Sending
  pauses at the cap. A signup rush of more than ~100 students in a day will
  exceed it.
- Codes sent to university mail servers from a new domain may land in Junk until the
  domain's SPF/DKIM/DMARC are set and it builds reputation.
