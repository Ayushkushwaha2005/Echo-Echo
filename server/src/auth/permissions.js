/* ==========================================================================
   ECHO ECHO - GRANULAR ADMINISTRATOR PERMISSIONS

   The capability keys in rbac.js are what routes check. They were designed
   around roles, so a platform_admin held all of them. This file is the layer
   the platform owner actually manages: a catalogue of human-sized
   permissions, each of which unlocks a precise set of capability keys.

   How the two combine, for an account holding platform_admin or support:

     effective = CAPS[role]  (the role's ceiling)
               ∩ union(caps of the permissions granted to THIS admin)

   so a grant can only ever narrow what the role allows; it can never reach a
   capability the role itself does not carry. platform_owner is not filtered.

   Permissions marked ownerOnly are never grantable to anyone. They exist in
   the catalogue so the owner's own powers are named and auditable, and so
   the UI can show them as locked instead of silently omitting them.
   ========================================================================== */

export const PERMISSIONS = {
  /* ---- students ---- */
  'students.view':      { group: 'Students', label: 'View students and verification cases', caps: ['user.read', 'verification.read'], pii: true },
  'students.verify':    { group: 'Students', label: 'Approve or reject student verification', caps: ['verification.decide'] },
  'students.suspend':   { group: 'Students', label: 'Suspend a student account', caps: ['user.suspend'] },
  'students.reinstate': { group: 'Students', label: 'Reinstate a suspended account', caps: ['user.reinstate'] },

  /* ---- cafeterias / menus ---- */
  'cafeterias.view':    { group: 'Cafeterias', label: 'View cafeterias', caps: ['vendor.read'] },
  'cafeterias.manage':  { group: 'Cafeterias', label: 'Create, edit, open/close and archive cafeterias', caps: ['vendor.create', 'vendor.update', 'vendor.archive', 'vendor.toggle'] },
  'menus.view':         { group: 'Menus', label: 'View menus and price history', caps: ['menu.read'] },
  'menus.manage':       { group: 'Menus', label: 'Edit menus, prices, availability and photos', caps: ['menu.create', 'menu.update', 'menu.archive', 'menu.availability', 'menu.price', 'menu.photo'] },

  /* ---- orders ---- */
  'orders.view':        { group: 'Orders', label: 'View every order, its items, amounts and history', caps: ['order.read', 'order.read_all', 'order.inspect'], pii: true },
  'orders.manage':      { group: 'Orders', label: 'Move orders through their normal states', caps: ['order.transition'] },
  'orders.override':    { group: 'Orders', label: 'Override an order (admin cancel, refund)', caps: ['order.override', 'order.refund'] },

  /* ---- delivery ---- */
  'delivery.view':              { group: 'Delivery', label: 'View live deliveries and delivery configuration', caps: ['delivery.read_all'] },
  'delivery.manage':            { group: 'Delivery', label: 'Change delivery configuration', caps: ['delivery.config'] },
  'delivery.assign':            { group: 'Delivery', label: 'Assign or reassign a delivery partner', caps: ['delivery.assign'] },
  'delivery.incidents':         { group: 'Delivery', label: 'View and investigate delivery incidents', caps: ['incident.read', 'incident.manage'] },
  'delivery.resolve_incidents': { group: 'Delivery', label: 'Resolve delivery incidents (decide responsibility)', caps: ['incident.resolve'] },

  /* ---- partners ---- */
  'partners.view':      { group: 'Partners', label: 'View partner applications and profiles', caps: ['partner.read'], pii: true },
  'partners.approve':   { group: 'Partners', label: 'Approve or reject partner applications', caps: ['partner.approve'] },
  'partners.suspend':   { group: 'Partners', label: 'Suspend a delivery partner', caps: ['partner.suspend'] },
  'partners.reinstate': { group: 'Partners', label: 'Reinstate a suspended partner', caps: ['partner.reinstate'] },

  /* ---- deposits ---- */
  'deposits.view':              { group: 'Deposits', label: 'View partner deposits, deductions and refund requests', caps: ['deposit.read'] },
  'deposits.manage_policy':     { group: 'Deposits', label: 'Publish the deposit policy', caps: ['deposit.policy'] },
  'deposits.record':            { group: 'Deposits', label: 'Record a deposit received', caps: ['deposit.record'] },
  'deposits.propose_deduction': { group: 'Deposits', label: 'Propose or withdraw a deduction', caps: ['deposit.deduction.propose'] },
  'deposits.approve_deduction': { group: 'Deposits', label: 'Decide disputes and apply deductions', caps: ['deposit.deduction.approve'] },
  'deposits.refund':            { group: 'Deposits', label: 'Pay or reject deposit refunds', caps: ['deposit.refund'] },

  /* ---- reviews ---- */
  'reviews.view':            { group: 'Reviews', label: 'View reviews and reports', caps: ['review.read'] },
  'reviews.moderate':        { group: 'Reviews', label: 'Hide reviews', caps: ['review.moderate'] },
  'reviews.resolve_reports': { group: 'Reviews', label: 'Resolve review reports', caps: ['review.report.resolve'] },

  /* ---- campuses / locations ---- */
  'campuses.view':    { group: 'Campuses', label: 'View campuses', caps: ['campus.read'] },
  'campuses.manage':  { group: 'Campuses', label: 'Change campus service status and details', caps: ['campus.manage', 'campus.toggle_delivery'] },
  'locations.view':   { group: 'Campuses', label: 'View delivery locations and zones', caps: ['location.read'] },
  'locations.manage': { group: 'Campuses', label: 'Create, edit and archive delivery locations and pickup points', caps: ['campus.create', 'campus.update', 'campus.archive'] },
  'boundary.view':    { group: 'Campuses', label: 'View and propose campus boundaries', caps: ['boundary.read', 'boundary.propose'] },
  'boundary.confirm': { group: 'Campuses', label: 'Confirm or retire a campus boundary (enables delivery)', caps: ['boundary.confirm'] },

  /* ---- staff / counter ---- */
  'staff.view':     { group: 'Staff', label: 'View cafeteria staff', caps: ['staff.read'] },
  'staff.manage':   { group: 'Staff', label: 'Add or remove cafeteria staff, issue their sign-in codes', caps: ['staff.manage', 'user.enrol'] },
  'counter.manage': { group: 'Staff', label: 'Assign cafeteria owners and staff roles', caps: ['user.role.grant', 'user.role.revoke'] },

  /* ---- support ---- */
  'support.view':   { group: 'Support', label: 'Read support cases', caps: ['support.read'], pii: true },
  'support.manage': { group: 'Support', label: 'Reply to and close support cases', caps: ['support.manage'] },

  /* ---- platform ---- */
  'platform.view':   { group: 'Platform', label: 'View feature flags and provider status', caps: ['platform.read'] },
  'platform.manage': { group: 'Platform', label: 'Change feature flags and platform settings', caps: ['flags.update', 'config.update'] },

  /* ---- audit ---- */
  'audit.view': { group: 'Audit', label: 'Read the audit log', caps: ['audit.read'] },

  /* ---- finance ---- */
  'finance.view':   { group: 'Finance', label: 'View the books, payouts and reconciliation', caps: ['finance.read_all'] },
  'finance.manage': { group: 'Finance', label: 'Change pricing, run payouts, adjust balances', caps: ['pricing.manage', 'payout.manage', 'finance.adjust'] },

  /* ---- administrator access ---- */
  'admins.view':             { group: 'Administrator access', label: 'See administrators, their permissions and activity', caps: ['admin.read'] },
  'admins.suspend':          { group: 'Administrator access', label: 'Suspend another administrator (containment)', caps: ['admin.suspend'] },
  'admins.invite':           { group: 'Administrator access', label: 'Invite administrators', caps: ['admin.invite'], ownerOnly: true },
  'admins.edit_permissions': { group: 'Administrator access', label: 'Change an administrator\'s permissions', caps: ['admin.permissions'], ownerOnly: true },
  'admins.revoke':           { group: 'Administrator access', label: 'Revoke administrator access', caps: ['admin.revoke'], ownerOnly: true },
  'admins.restore':          { group: 'Administrator access', label: 'Restore administrator access', caps: ['admin.restore'], ownerOnly: true },

  /* ---- security ---- */
  'sessions.revoke':  { group: 'Security', label: 'Sign another administrator out everywhere', caps: ['session.revoke'] },
  'passkeys.manage':  { group: 'Security', label: 'Remove another administrator\'s passkeys', caps: ['passkey.manage'], ownerOnly: true },
  'security.manage':  { group: 'Security', label: 'Owner identity, owner recovery and security architecture', caps: ['security.manage'], ownerOnly: true },
};

export const PERMISSION_KEYS = Object.keys(PERMISSIONS);
export const GRANTABLE_KEYS = PERMISSION_KEYS.filter((k) => !PERMISSIONS[k].ownerOnly);

/* Starting points offered in the invite form. They are copied into the
   admin's explicit list at the moment of the invite - editing a preset
   later never silently changes an existing administrator. */
export const PRESETS = {
  operations: {
    label: 'Operations admin',
    permissions: GRANTABLE_KEYS.filter((k) => !['finance.manage', 'deposits.approve_deduction', 'deposits.refund',
      'platform.manage', 'admins.suspend', 'sessions.revoke', 'counter.manage', 'boundary.confirm'].includes(k)),
  },
  support: {
    label: 'Support (read-mostly)',
    permissions: ['students.view', 'cafeterias.view', 'menus.view', 'orders.view', 'delivery.view',
      'delivery.incidents', 'partners.view', 'deposits.view', 'reviews.view', 'campuses.view',
      'locations.view', 'boundary.view', 'support.view', 'support.manage', 'finance.view'],
  },
  verification: {
    label: 'Student verification only',
    permissions: ['students.view', 'students.verify'],
  },
  full: { label: 'Every grantable permission', permissions: [...GRANTABLE_KEYS] },
};

/* What an account holding the role but WITHOUT an explicit permission list
   gets - accounts created before per-admin permissions existed, or listed in
   PLATFORM_ADMIN_EMAILS. Kept equal to the role's previous behaviour so an
   upgrade does not lock anyone out; the owner narrows it from Campus Control. */
export const ROLE_DEFAULT_PERMISSIONS = {
  platform_admin: [...GRANTABLE_KEYS],
  support: [...PRESETS.support.permissions, 'audit.view', 'delivery.resolve_incidents'],
};

export function capsFor(permissionKeys) {
  const out = new Set();
  for (const k of permissionKeys || []) for (const c of PERMISSIONS[k]?.caps || []) out.add(c);
  return out;
}

export function validatePermissionList(list) {
  if (!Array.isArray(list)) return { ok: false, problem: 'permissions must be a list' };
  const unique = [...new Set(list.map(String))];
  const unknown = unique.filter((k) => !PERMISSIONS[k]);
  if (unknown.length) return { ok: false, problem: `Unknown permission: ${unknown.join(', ')}` };
  const locked = unique.filter((k) => PERMISSIONS[k].ownerOnly);
  if (locked.length) return { ok: false, problem: `Owner-only, never grantable: ${locked.join(', ')}` };
  return { ok: true, permissions: unique.sort() };
}

export function catalogue() {
  const groups = {};
  for (const [key, p] of Object.entries(PERMISSIONS)) {
    (groups[p.group] ||= []).push({ key, label: p.label, ownerOnly: !!p.ownerOnly, personalData: !!p.pii });
  }
  return {
    groups: Object.entries(groups).map(([name, permissions]) => ({ name, permissions })),
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, permissions: p.permissions })),
  };
}
