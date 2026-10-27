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
  'students.view':      { group: 'Users', label: 'View student accounts and their verification cases', caps: ['user.read', 'verification.read'], pii: true },
  'students.verify':    { group: 'Verification', label: 'Approve or reject student verification', caps: ['verification.decide'] },
  'students.suspend':   { group: 'Users', label: 'Suspend a student account', caps: ['user.suspend'] },
  'students.reinstate': { group: 'Users', label: 'Reinstate a suspended account', caps: ['user.reinstate'] },

  /* ---- cafeterias / menus ---- */
  'cafeterias.view':    { group: 'Cafés', label: 'View cafés', caps: ['vendor.read'] },
  'cafeterias.manage':  { group: 'Cafés', label: 'Create, edit, open, close and archive cafés', caps: ['vendor.create', 'vendor.update', 'vendor.archive', 'vendor.toggle'] },
  'menus.view':         { group: 'Menu', label: 'View menus and price history', caps: ['menu.read'] },
  'menus.manage':       { group: 'Menu', label: 'Edit menus, prices, availability and photos', caps: ['menu.create', 'menu.update', 'menu.archive', 'menu.availability', 'menu.price', 'menu.photo'] },

  /* ---- orders ---- */
  'orders.view':        { group: 'Orders', label: 'View every order, its items, amounts and history', caps: ['order.read', 'order.read_all', 'order.inspect'], pii: true },
  'orders.manage':      { group: 'Orders', label: 'Move orders through their normal states', caps: ['order.transition'] },
  'orders.override':    { group: 'Payments', label: 'Refund an order, or cancel it as an administrator', caps: ['order.override', 'order.refund'] },

  /* ---- delivery ---- */
  'delivery.view':              { group: 'Delivery tracking', label: 'View live deliveries and delivery settings', caps: ['delivery.read_all'] },
  'delivery.manage':            { group: 'Delivery tracking', label: 'Change delivery settings', caps: ['delivery.config'] },
  'delivery.assign':            { group: 'Delivery tracking', label: 'Assign or reassign a delivery partner', caps: ['delivery.assign'] },
  'delivery.incidents':         { group: 'Delivery tracking', label: 'View and investigate delivery incidents', caps: ['incident.read', 'incident.manage'] },
  'delivery.resolve_incidents': { group: 'Delivery tracking', label: 'Resolve delivery incidents and decide responsibility', caps: ['incident.resolve'] },

  /* ---- partners ---- */
  'partners.view':      { group: 'Partners', label: 'View partner applications and profiles', caps: ['partner.read'], pii: true },
  'partners.approve':   { group: 'Partners', label: 'Approve or reject partner applications', caps: ['partner.approve'] },
  'partners.suspend':   { group: 'Partners', label: 'Suspend a delivery partner', caps: ['partner.suspend'] },
  'partners.reinstate': { group: 'Partners', label: 'Reinstate a suspended partner', caps: ['partner.reinstate'] },

  /* ---- deposits ---- */
  'deposits.view':              { group: 'Partner deposits', label: 'View deposits, deductions and refund requests', caps: ['deposit.read'] },
  'deposits.manage_policy':     { group: 'Partner deposits', label: 'Publish the deposit policy', caps: ['deposit.policy'] },
  'deposits.record':            { group: 'Partner deposits', label: 'Record a deposit received', caps: ['deposit.record'] },
  'deposits.propose_deduction': { group: 'Partner deposits', label: 'Propose or withdraw a deduction', caps: ['deposit.deduction.propose'] },
  'deposits.approve_deduction': { group: 'Partner deposits', label: 'Decide disputes and apply deductions', caps: ['deposit.deduction.approve'] },
  'deposits.refund':            { group: 'Partner deposits', label: 'Pay or reject deposit refunds', caps: ['deposit.refund'] },

  /* ---- reviews ---- */
  'reviews.view':            { group: 'Reviews', label: 'View reviews and reports', caps: ['review.read'] },
  'reviews.moderate':        { group: 'Reviews', label: 'Hide reviews', caps: ['review.moderate'] },
  'reviews.resolve_reports': { group: 'Reviews', label: 'Resolve review reports', caps: ['review.report.resolve'] },

  /* ---- campuses / locations ---- */
  'campuses.view':    { group: 'Campus locations', label: 'View campuses', caps: ['campus.read'] },
  'campuses.manage':  { group: 'Campus locations', label: 'Change campus service status and details', caps: ['campus.manage', 'campus.toggle_delivery'] },
  'locations.view':   { group: 'Campus locations', label: 'View delivery locations and zones', caps: ['location.read'] },
  'locations.manage': { group: 'Campus locations', label: 'Create, edit and archive delivery locations and pickup points', caps: ['campus.create', 'campus.update', 'campus.archive'] },
  'boundary.view':    { group: 'Campus locations', label: 'View and propose campus boundaries', caps: ['boundary.read', 'boundary.propose'] },
  'boundary.confirm': { group: 'Campus locations', label: 'Confirm or retire a campus boundary (turns delivery on)', caps: ['boundary.confirm'] },

  /* ---- staff / counter ---- */
  'staff.view':     { group: 'Café staff', label: 'View café staff', caps: ['staff.read'] },
  'staff.manage':   { group: 'Café staff', label: 'Add or remove café staff and issue their sign-in codes', caps: ['staff.manage', 'user.enrol'] },
  'counter.manage': { group: 'Café staff', label: 'Assign café owner and café staff roles', caps: ['user.role.grant', 'user.role.revoke'] },

  /* ---- support ---- */
  'support.view':   { group: 'Support', label: 'Read support cases', caps: ['support.read'], pii: true },
  'support.manage': { group: 'Support', label: 'Reply to and close support cases', caps: ['support.manage'] },

  /* ---- platform ---- */
  'platform.view':   { group: 'System health', label: 'View system health, feature flags and provider status', caps: ['platform.read'] },
  'platform.manage': { group: 'Platform settings', label: 'Change feature flags and platform settings', caps: ['flags.update', 'config.update'] },

  /* ---- public website ---- */
  'website.customize': { group: 'Website customization', label: 'Edit the website draft: theme, homepage, banners, footer, images', caps: ['site.read', 'site.draft'] },
  'website.publish':   { group: 'Website publishing', label: 'Publish the website draft, or roll back to an earlier version', caps: ['site.read', 'site.publish'] },

  /* ---- audit ---- */
  'audit.view': { group: 'Audit logs', label: 'Read the audit log', caps: ['audit.read'] },

  /* ---- finance ---- */
  'finance.view':   { group: 'Payments', label: 'View payments, the books and reconciliation', caps: ['finance.read_all'] },
  'finance.manage': { group: 'Settlements', label: 'Change pricing, run payouts and adjust balances', caps: ['pricing.manage', 'payout.manage', 'finance.adjust'] },

  /* ---- administrator access ---- */
  'admins.view':             { group: 'Access management', label: 'See administrators, their permissions and activity', caps: ['admin.read'] },
  'admins.suspend':          { group: 'Access management', label: 'Suspend another administrator (containment)', caps: ['admin.suspend'] },
  'admins.invite':           { group: 'Access management', label: 'Invite administrators', caps: ['admin.invite'], ownerOnly: true },
  'admins.edit_permissions': { group: 'Access management', label: 'Change an administrator\'s permissions', caps: ['admin.permissions'], ownerOnly: true },
  'admins.revoke':           { group: 'Access management', label: 'Revoke administrator access', caps: ['admin.revoke'], ownerOnly: true },
  'admins.restore':          { group: 'Access management', label: 'Restore administrator access', caps: ['admin.restore'], ownerOnly: true },

  /* ---- security ---- */
  'sessions.revoke':  { group: 'Sessions', label: 'Sign another administrator out everywhere', caps: ['session.revoke'] },
  'passkeys.manage':  { group: 'Authentication & security', label: 'Remove another administrator\'s old passkeys', caps: ['passkey.manage'], ownerOnly: true },
  'security.manage':  { group: 'Authentication & security', label: 'Owner identity, owner recovery and security architecture', caps: ['security.manage'], ownerOnly: true },
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
      'platform.manage', 'admins.suspend', 'sessions.revoke', 'counter.manage', 'boundary.confirm',
      'website.publish'].includes(k)),
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
/* Permissions added after this default was set are NOT in it, so an older
   account does not quietly gain a new power: the owner grants it by name. */
const ADDED_LATER = ['website.customize', 'website.publish'];
export const ROLE_DEFAULT_PERMISSIONS = {
  platform_admin: GRANTABLE_KEYS.filter((k) => !ADDED_LATER.includes(k)),
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

/* The order Campus Control shows the areas in. */
export const GROUP_ORDER = ['Orders', 'Cafés', 'Menu', 'Users', 'Verification', 'Partners', 'Partner deposits',
  'Delivery tracking', 'Payments', 'Settlements', 'Reviews', 'Campus locations', 'Café staff', 'Support',
  'Website customization', 'Website publishing', 'Access management', 'Sessions', 'Audit logs',
  'System health', 'Platform settings', 'Authentication & security'];

/* What every administrator has without a grant, shown so the picture of an
   administrator's access is complete. These are not permissions: there is
   nothing to switch off. Reports follow the permissions behind each export. */
export const ALWAYS_AVAILABLE = [
  { group: 'Dashboard', label: 'The overview, showing only the figures their permissions allow' },
  { group: 'Profile', label: 'Their own name, photo, password, authenticator and sessions, and nobody else\'s' },
  { group: 'Reports', label: 'Order exports with "View every order"; money exports with "View payments"' },
];

export function catalogue() {
  const groups = {};
  for (const [key, p] of Object.entries(PERMISSIONS)) {
    (groups[p.group] ||= []).push({ key, label: p.label, ownerOnly: !!p.ownerOnly, personalData: !!p.pii });
  }
  const rank = (g) => (GROUP_ORDER.indexOf(g) + 1) || 99;
  return {
    groups: Object.entries(groups).sort(([a], [b]) => rank(a) - rank(b)).map(([name, permissions]) => ({ name, permissions })),
    alwaysAvailable: ALWAYS_AVAILABLE,
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, permissions: p.permissions })),
  };
}
