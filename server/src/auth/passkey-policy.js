/* ==========================================================================
   ECHO ECHO - ADMINISTRATOR SESSION POLICY

   Two rules, both server-side:

   1. A capability that an account holds ONLY through a platform role
      (owner, admin, support) is usable only from a session opened with that
      administrator's own password and authenticator code. A student who is
      also an administrator can still order food from an email-code session;
      they cannot touch Campus Control from it.

   2. Actions that move money, change who can do what, or change where the
      campus boundary is, additionally need that confirmation to be recent —
      within the last ADMIN_REAUTH_MINUTES minutes.

   The file is still called passkey-policy.js and still says `passkeyAt`
   because that is the column and the field the rest of the codebase reads;
   what it records is now "the moment this session proved it was an
   administrator", whichever strong method did the proving.
   ========================================================================== */
import { ADMIN } from '../config.js';
import { HttpError } from './rbac.js';

export const PasskeyRequired = (m, d) => new HttpError(403, 'admin_signin_required', m, d);
export const ReauthRequired = (m, d) => new HttpError(403, 'reauth_required', m, d);

export function assertPasskeySession(actor) {
  if (!ADMIN.passkeyRequired) return;
  if (!actor?.passkeyAt) {
    throw PasskeyRequired('Sign in to Campus Control to do that',
      'Administrator actions need a session opened with your administrator password and authenticator code.');
  }
}

export function assertRecentPasskey(actor, what = 'this action') {
  if (!ADMIN.passkeyRequired) return;
  assertPasskeySession(actor);
  const age = (Date.now() - new Date(actor.passkeyAt).getTime()) / 60000;
  if (!(age <= ADMIN.reauthMinutes)) {
    throw ReauthRequired('Confirm it is you again',
      `For ${what}, enter your password and authenticator code again. A confirmation lasts ${ADMIN.reauthMinutes} minutes.`);
  }
}
