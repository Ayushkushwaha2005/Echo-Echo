/* ==========================================================================
   QUAD — AUTHORIZATION

   This file is the enforcement point, and it runs on the server. The old
   prototype had the same shape in the browser, where it was decorative:
   anyone could edit the bundle. Here the actor is derived from a session
   cookie whose token hash is in Postgres, and the resource's owning vendor
   is read from the database — never from the request body.

   Three checks, in order:
     1. AUTHENTICATION  — a live, unexpired, unrevoked session
     2. CAPABILITY      — does any role this user holds grant the action?
     3. SCOPE           — for 'own_vendor'/'own' rules, is the resource theirs?
   ========================================================================== */

import { evaluate as evaluateProfile, MISSING_COPY } from '../services/profile.js';
import { assertPasskeySession } from './passkey-policy.js';
import { capsFor, GRANTABLE_KEYS, PERMISSION_KEYS, ROLE_DEFAULT_PERMISSIONS } from './permissions.js';
import { STUDENT_EMAIL } from '../config.js';

export const ROLES = {
  platform_owner:   { rank: 100, label: 'Platform owner',   scope: 'platform' },
  platform_admin:   { rank: 90,  label: 'Admin',            scope: 'platform' },
  support:          { rank: 60,  label: 'Support',          scope: 'platform' },
  vendor_owner:     { rank: 50,  label: 'Cafeteria owner',  scope: 'vendor' },
  vendor_staff:     { rank: 40,  label: 'Cafeteria staff',  scope: 'vendor' },
  delivery_partner: { rank: 20,  label: 'Delivery partner', scope: 'self' },
  student:          { rank: 10,  label: 'Student',          scope: 'self' },
};

export const isPlatformRole = (r) => ROLES[r]?.scope === 'platform';

/* Which roles may open which surface — checked at the door, before any
   capability check. Routing after login is derived from this, server-side;
   the client cannot pick its own destination. */
export const SURFACE_ROLES = {
  admin:   ['platform_owner', 'platform_admin', 'support'],
  counter: ['platform_owner', 'platform_admin', 'vendor_owner', 'vendor_staff'],
  web:     ['student', 'delivery_partner', 'platform_owner', 'platform_admin'],
};

/* Highest-ranked role wins the landing surface. */
export function landingSurface(roles) {
  const ordered = [...roles].sort((a, b) => (ROLES[b]?.rank || 0) - (ROLES[a]?.rank || 0));
  for (const r of ordered) {
    if (SURFACE_ROLES.admin.includes(r)) return 'admin';
    if (SURFACE_ROLES.counter.includes(r)) return 'counter';
    if (SURFACE_ROLES.web.includes(r)) return 'web';
  }
  return 'web';
}

/* The platform role ceilings are derived from the permission catalogue
   (permissions.js), so a permission can never name a capability no role
   carries, and a capability added to a route without a permission is held
   by the owner alone - it fails closed for every other administrator. */
const asCaps = (set) => Object.fromEntries([...set].map((c) => [c, true]));
const GRANTABLE_CAPS = capsFor(GRANTABLE_KEYS);
const ALL_CAPS = capsFor(PERMISSION_KEYS);

export const CAPS = {
  /* Only the owner may grant or revoke platform-level roles. This is what
     stops an admin promoting themselves; see assertGrantable(). */
  platform_owner: { ...asCaps(ALL_CAPS), 'admin.grant': true, 'notification.read': true },
  platform_admin: { ...asCaps(GRANTABLE_CAPS), 'notification.read': true },
  /* Support can see the books - it has to, to answer "where is my refund" -
     but cannot change terms, adjust a balance or pay anyone. */
  support: asCaps(capsFor(ROLE_DEFAULT_PERMISSIONS.support)),
  vendor_owner: {
    'vendor.update': 'own_vendor', 'vendor.toggle': 'own_vendor',
    'menu.create': 'own_vendor', 'menu.update': 'own_vendor', 'menu.archive': 'own_vendor',
    'menu.availability': 'own_vendor', 'menu.price': 'own_vendor', 'menu.photo': 'own_vendor',
    'order.read': 'own_vendor', 'order.transition': 'own_vendor', 'order.inspect': 'own_vendor',
    'staff.manage': 'own_vendor',
    /* Own cafeteria's money, and only its own. The scope check reads the
       vendor from the database, so asking for another cafeteria's statement
       by changing an id in the URL is a 403, not a leak. Counter STAFF do
       not hold this: takings and settlements are the owner's business. */
    'finance.read': 'own_vendor',
  },
  vendor_staff: {
    'menu.availability': 'own_vendor',
    'order.read': 'own_vendor', 'order.transition': 'own_vendor',
  },
  delivery_partner: {
    'order.read': 'own', 'delivery.accept': 'own', 'delivery.read': 'own',
    'delivery.handoff': 'own', 'partner.leave': 'own',
    'finance.read': 'own',
  },
  student: {
    'order.create': true, 'order.read': 'own', 'order.cancel': 'own',
    'review.create': 'own', 'verification.submit': 'own', 'partner.apply': 'own',
  },
};

/* Platform-level roles nobody but the owner may hand out. */
export const OWNER_ONLY_ROLES = ['platform_owner', 'platform_admin', 'support'];

export class HttpError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status; this.code = code; this.detail = detail;
  }
}
export const Unauthenticated = (m = 'Sign in required', d) => new HttpError(401, 'unauthenticated', m, d);
export const Forbidden = (m = 'Access denied', d) => new HttpError(403, 'forbidden', m, d);
export const BadRequest = (m, d) => new HttpError(400, 'bad_request', m, d);
export const NotFound = (m = 'Not found', d) => new HttpError(404, 'not_found', m, d);
export const Conflict = (m, d) => new HttpError(409, 'conflict', m, d);
export const TooMany = (m, d) => new HttpError(429, 'rate_limited', m, d);
export const ProviderUnavailable = (m, d) => new HttpError(503, 'configuration_required', m, d);

/* `adminCaps` is the capability set derived from THIS administrator's
   granted permissions (session.js, read from the database per request). It
   narrows the platform_admin/support ceilings and never widens them. The
   owner is not narrowed. */
function ruleFor(roles, action, adminCaps = null) {
  let best;
  for (const r of roles) {
    let v = CAPS[r]?.[action];
    if (v && adminCaps && (r === 'platform_admin' || r === 'support') && !adminCaps.has(action)) v = undefined;
    if (v === true) return true;          // most permissive wins
    if (v && best === undefined) best = v;
  }
  return best;
}

/**
 * @param actor  { id, roles:[string], vendorIds:[uuid], status }
 * @param action capability key
 * @param res    { vendorId?, ownerId? } — read from the DB by the caller,
 *               never taken from the request body.
 */
export function authorize(actor, action, res = {}) {
  if (!actor) throw Unauthenticated('Sign in required', 'No session on this request.');
  if (actor.status === 'suspended') throw Forbidden('Account suspended', 'Contact campus support.');

  const rule = ruleFor(actor.roles, action, actor.adminCaps);
  /* Platform roles are withheld from a session that was not opened with a
     passkey (see actorFromToken). If one of those withheld roles is what
     would grant this, say so rather than "not permitted". */
  if (!rule && actor.withheldRoles?.length && actor.adminStatus === 'active' &&
      ruleFor(actor.withheldRoles, action, actor.adminCaps)) {
    assertPasskeySession({ passkeyAt: null });
  }
  if (!rule) {
    if (actor.adminCaps && ruleFor(actor.roles, action)) {
      throw new HttpError(403, 'permission_required', 'You do not have permission for this',
        'The platform owner has not granted your administrator account this permission.');
    }
    const holders = Object.entries(CAPS).filter(([, c]) => c[action]).map(([r]) => r);
    throw Forbidden(
      `Your account cannot perform ${action}`,
      holders.length ? `"${action}" is granted to ${holders.join(', ')} only.`
                     : `"${action}" is granted to no role.`);
  }

  if (rule === 'own_vendor') {
    if (!res.vendorId) throw Forbidden('Scope check failed', 'This action requires a cafeteria-scoped resource.');
    if (!actor.vendorIds?.includes(res.vendorId)) {
      throw Forbidden('That cafeteria is not yours',
        `Scope check failed server-side: session vendors=[${actor.vendorIds}], resource=${res.vendorId}.`);
    }
  }

  if (rule === 'own') {
    if (!res.ownerId) throw Forbidden('Scope check failed', 'This action requires an owned resource.');
    if (res.ownerId !== actor.id) {
      throw Forbidden('That record is not yours',
        `Row-level isolation: session=${actor.id}, resource owner=${res.ownerId}.`);
    }
  }
  return true;
}

/**
 * The gate on placing an order, applied server-side at every entry point
 * that can create one — the checkout route and the AI assistant's
 * create_order_draft tool.
 *
 * `authorize(actor, 'order.create')` proves the actor holds the capability.
 * It does NOT prove the person behind it is a verified student of this
 * campus, and those are different questions: a signed-in account with the
 * `student` role is one enrolment code away from existing, while student
 * status is a decision an authorised human made about a photographed ID.
 *
 * Everything checked here is read from the session's DATABASE row, resolved
 * per request in actorFromToken(). Nothing here can be influenced by a
 * request body, a route guard, a cached client flag, or an `isVerified`
 * boolean in a browser: a client calling this API directly meets exactly
 * the same four conditions as one that went through the app.
 *
 * The fifth condition — that the destination is inside the campus boundary
 * — is enforced separately by assertDeliverable() in services/campus.js,
 * because it is a property of the order rather than of the person.
 */
export function assertMayOrder(actor, { liveLocationRequired = false } = {}) {
  if (!actor) throw Unauthenticated('Sign in required');
  if (actor.status !== 'active') {
    throw Forbidden(`This account is ${actor.status}`,
      'Contact campus support. A suspended account cannot place orders.');
  }
  /* Phone verification is not a separate flag because it cannot be missing:
     every session in this product is created by an OTP login or by
     redeeming an enrolment code, and there is no third way to obtain one.
     A session existing IS the phone check. */
  if (actor.studentStatus !== 'approved') {
    throw Forbidden('Student verification is required to order',
      VERIFICATION_COPY[actor.studentStatus]?.next || 'Your student verification is not approved.');
  }
  /* Optional freshness of mailbox proof. Only for students whose approval
     rests on the mailbox; an admin-approved ID card is not re-asked. */
  if (STUDENT_EMAIL.reverifyDays > 0 && actor.verifiedVia === 'institutional_email' && actor.studentEmailVerifiedAt) {
    const ageDays = (Date.now() - new Date(actor.studentEmailVerifiedAt).getTime()) / 86_400_000;
    if (ageDays > STUDENT_EMAIL.reverifyDays) {
      throw new HttpError(403, 'reverify_email', 'Confirm your student email again to order',
        `Your university email was last confirmed more than ${STUDENT_EMAIL.reverifyDays} days ago. Sign in with a new code sent to it.`);
    }
  }
  /* ---- live location -------------------------------------------------
     ECHO ECHO takes orders from students who are on campus. The session
     proves that once, through POST /campus/presence, which writes the
     verdict onto the session row after testing the fix against the
     confirmed boundary. Read here from that row: a client that skipped the
     step, or that says it passed, is refused.

     `liveLocationRequired` is the admin-visible feature flag of the same
     name, resolved by the caller (it defaults on) and passed in rather than
     read here, so this function stays synchronous and testable. */
  if (liveLocationRequired && !actor.campusPresenceAt) {
    throw new HttpError(403, 'location_required', 'Confirm you are on campus',
      'ECHO ECHO needs to check your location before you order. Allow location access when your browser asks.');
  }
  if (liveLocationRequired && actor.campusPresenceSiteId && actor.campusId &&
      actor.campusPresenceSiteId !== actor.campusId) {
    throw new HttpError(403, 'location_required', 'You are not on the campus in your profile',
      'The location you confirmed is on a different campus. Confirm your location again.');
  }

  /* The profile is evaluated from the session's database row. A client that
     skips the completion screen meets the same refusal. */
  if (actor.profile) {
    const p = evaluateProfile(actor.profile);
    if (!p.complete) {
      throw Forbidden('Complete your profile to order',
        `Still needed: ${p.missing.map((m) => MISSING_COPY[m]).join(', ')}.`,
      );
    }
    if (actor.campusServiceStatus !== 'active') {
      throw Forbidden(`ECHO ECHO is not available at ${actor.campusName || 'your campus'} yet`,
        'Ordering opens when service starts on your campus.');
    }
  }
  return true;
}

/* ---------- canonical verification vocabulary ----------------------------
   The stored values predate this vocabulary and every gate compares against
   them ('approved'), so they are mapped here rather than renamed.          */
export const VERIFICATION_STATE = {
  unverified: 'UNVERIFIED',
  email_verified: 'EMAIL_VERIFIED',
  pending: 'PENDING_ADMIN_REVIEW',
  needs_review: 'PENDING_ADMIN_REVIEW',
  approved: 'VERIFIED',
  rejected: 'REJECTED',
  suspended: 'SUSPENDED',
};

/* What the student is told, and what they must do next. One source, so the
   ordering gate and the status endpoint can never disagree. */
export const VERIFICATION_COPY = {
  unverified: {
    why: 'You have not verified that you are a student yet.',
    next: 'Verify with your university student email to unlock ordering.' },
  email_verified: {
    why: 'Your student email is confirmed, but an administrator still has to approve your account.',
    next: 'Wait for the verification team, or send them more information if they asked for it.' },
  pending: {
    why: 'Your verification is with the verification team.',
    next: 'You will be able to order as soon as it is approved. There is nothing else to do for now.' },
  needs_review: {
    why: 'An administrator needs to take a closer look at your verification.',
    next: 'You will be able to order once they have decided. Contact campus support if it takes more than a day.' },
  approved: {
    why: 'Your student identity has been verified.', next: null },
  rejected: {
    why: 'Your verification was not accepted.',
    next: 'An administrator declined it. Submit a new request with more information, or contact campus support.' },
  suspended: {
    why: 'Your student verification has been suspended by an administrator.',
    next: 'Contact campus support. A suspended verification cannot order or deliver.' },
};

export function verificationView(studentStatus, accountStatus) {
  const s = accountStatus === 'suspended' ? 'suspended' : studentStatus;
  return {
    state: VERIFICATION_STATE[s] || 'UNVERIFIED',
    stored: studentStatus,
    reason: VERIFICATION_COPY[s]?.why || null,
    nextStep: VERIFICATION_COPY[s]?.next || null,
  };
}

export function can(actor, action, res) {
  try { authorize(actor, action, res); return true; } catch { return false; }
}

/* Role-granting has its own rule on top of the capability check: platform
   roles may only be granted by the platform owner, and `platform_owner`
   itself may never be granted over the API by anyone. It is established
   from PLATFORM_OWNER_PHONE at migration time and nowhere else. */
export function assertGrantable(actor, role) {
  if (role === 'platform_owner') {
    throw Forbidden('platform_owner cannot be granted over the API',
      'The platform owner is established from PLATFORM_OWNER_PHONE on the server.');
  }
  if (OWNER_ONLY_ROLES.includes(role) && !actor.roles.includes('platform_owner')) {
    throw Forbidden(`Only the platform owner may grant "${role}"`,
      'This prevents an admin from escalating their own or another account.');
  }
}
