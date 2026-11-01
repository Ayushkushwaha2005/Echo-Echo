# Administrator invitations

How someone becomes a Campus Control administrator. Implemented in
`server/src/services/admin-invitation.js`, `routes/admin-invitation.js` and
`packages/ui/admin-invite.js`; proved by `server/test/admin-invitation.test.mjs`.

## Flow

1. The owner enters a name, an email and the exact permissions, after confirming
   it is them. This writes one `admin_invitation` row and **grants nothing**.
2. The server creates 32 random bytes and stores only their SHA-256. The link
   lives 72 hours (`ADMIN_INVITE_TTL_HOURS`) and works once. The token is in the URL
   fragment, so it never reaches a server log or a Referer header, and the page
   removes it from the address bar on arrival.
3. Opening the link shows only a masked address.
4. The employee asks for a code. It goes to the invited address only, lasts 10
   minutes, allows 5 attempts and has a 60-second resend cooldown.
5. A correct code issues a 30-minute setup ticket and reveals who invited them,
   their role and the exact permissions.
6. They press Accept, set a password (at least 12 characters) and scan an
   authenticator key.
7. A current code from that authenticator triggers one database transaction, which:
   - re-checks that the link is live, the inviter is still the owner, and the
     permissions are still valid;
   - finds or creates the account, grants the role, sets `active`, stores the
     credential, consumes the invitation and clears the held secrets;
   - writes the audit row. If that write fails, nothing happens.
8. No session opens. They sign in normally.

## Rules that are enforced and tested

- Email proof alone activates nothing, and no step can be skipped.
- Plain student email sign-in no longer accepts an invitation or grants a role.
- An `invited` account cannot set its own credentials around the invitation.
- A setup ticket works only with its own invitation.
- A live invitation is never silently replaced: inviting again returns 409.
- Resend makes a new link, kills the old one and discards progress.
- Cancel kills the link and erases any held password or key.
- Only the owner can invite, resend or cancel. The owner's address cannot be invited.
- Owner-only permissions cannot be granted.

## Employees outside the university

`app_user.staff_email` holds an address proved through an invitation, separate from
`student_email`. Sign-in and password reset accept either. A staff account has no
student role and cannot order.

## Accounts stuck in `invited`

Migration 036 changes none of them. In Access Management the owner presses
**New invitation**, and completing it activates the same account. Nothing forces a
status, and `admin:setup` is not needed. Invitation rows from the old code flow can
be resent but cannot be opened.

## If email fails

The owner sees the link once, to pass on over a channel they trust. It is never
written to the audit log or the database.

## Not yet proven

Delivery through the real email provider, and landing in a real employee's inbox, can
only be checked on production. Brevo single-sender mail to an outside address may land
in spam, and fixing that needs a verified sending domain, which only the owner can set.
