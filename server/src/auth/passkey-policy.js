/* ==========================================================================
   QUAD - ADMINISTRATOR PASSKEY POLICY

   Two rules, both server-side:

   1. A capability that an account holds ONLY through a platform role
      (owner, admin, support) is usable only from a session that was opened -
      or re-confirmed - with that account's passkey. A student who is also an
      administrator can still order food from an email-code session; they
      cannot touch Campus Control from it.

   2. Actions that move money, change who can do what, or change where the
      campus boundary is, additionally need a passkey confirmation from the
      last ADMIN_REAUTH_MINUTES minutes.
   ========================================================================== */
import { ADMIN } from '../config.js';
import { HttpError } from './rbac.js';

export const PasskeyRequired = (m, d) => new HttpError(403, 'passkey_required', m, d);
export const ReauthRequired = (m, d) => new HttpError(403, 'reauth_required', m, d);

export function assertPasskeySession(actor) {
  if (!ADMIN.passkeyRequired) return;
  if (!actor?.passkeyAt) {
    throw PasskeyRequired('Confirm it is you with your passkey',
      'Administrator actions need a session opened with your passkey (fingerprint, face or device PIN).');
  }
}

export function assertRecentPasskey(actor, what = 'this action') {
  if (!ADMIN.passkeyRequired) return;
  assertPasskeySession(actor);
  const age = (Date.now() - new Date(actor.passkeyAt).getTime()) / 60000;
  if (!(age <= ADMIN.reauthMinutes)) {
    throw ReauthRequired('Confirm with your passkey again',
      `For ${what}, confirm with your passkey. It is valid for ${ADMIN.reauthMinutes} minutes.`);
  }
}
