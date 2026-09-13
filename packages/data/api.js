/* ==========================================================================
   FRISCO — SERVICE LAYER  (stands in for the backend)
   The single place every mutation passes through, for every surface and
   every caller — student site, admin portal, shopkeeper portal, AI agent.

   The permission check lives HERE, not in the UI. Hiding a button is a
   courtesy; this function is the enforcement. Each call is recorded in an
   audit log so the admin portal can show that denials really happen.
   ========================================================================== */
import { VENDORS, ITEMS, PRICING, LIVE_ORDERS, ORDER_EVENTS } from './catalog.js';
import {
  CAMPUS_NODES, nodeById, insideCampus, nearestNodes, pathLabel, destinationOptions,
} from './campus.js';
import { CONFIG_FLAGS } from './config.js';
import { Unauthenticated, Forbidden, isPlatformRole, requireVendorAccess } from './auth.js';

/* ---------- users & roles ------------------------------------------------ */
export const USERS = [
  { id: 'usr_admin',        name: 'Dr. Meera Raghavan', initials: 'MR', role: 'platform_admin', roles: ['platform_admin'], title: 'Dean, Student Services', email: 'meera.r@campus.edu.in', status: 'active' },
  { id: 'usr_support',      name: 'Kabir Malhotra', initials: 'KM', role: 'support', roles: ['support'], title: 'Student Services desk', email: 'kabir.m@campus.edu.in', status: 'active' },
  { id: 'usr_owner_frisco', name: 'Ravi Sethi',   initials: 'RS', role: 'vendor_owner', roles: ['vendor_owner'], vendor: 'caf_frisco', title: 'Owner · Frisco',       email: 'ravi.frisco@campus.edu.in', status: 'active' },
  { id: 'usr_staff_frisco', name: 'Pooja Nair',   initials: 'PN', role: 'vendor_staff', roles: ['vendor_staff'], vendor: 'caf_frisco', title: 'Counter · Frisco',     email: 'pooja.n@campus.edu.in', status: 'active' },
  { id: 'usr_owner_chai',   name: 'Imran Qureshi',initials: 'IQ', role: 'vendor_owner', roles: ['vendor_owner'], vendor: 'caf_chai',   title: 'Owner · Chai Garam',   email: 'imran.q@campus.edu.in', status: 'active' },
  { id: 'usr_owner_tulips', name: 'Anita Deshmukh',initials:'AD', role: 'vendor_owner', roles: ['vendor_owner'], vendor: 'caf_tulips', title: 'Owner · Tulips',       email: 'anita.d@campus.edu.in', status: 'active' },
  /* A user may hold several roles. Ayush is a student who also delivers. */
  { id: 'usr_1',            name: 'Ayush Kumar',  initials: 'AK', role: 'student', roles: ['student', 'delivery_partner'], roll: '23BCS1043', partner: true, email: 'ayush.k23@campus.edu.in', status: 'active', tier: 2 },
  { id: 'usr_2',            name: 'Ishita Rao',   initials: 'IR', role: 'student', roles: ['student', 'delivery_partner'], roll: '23BEC1120', partner: true, email: 'ishita.r@campus.edu.in', status: 'active', tier: 2 },
  { id: 'usr_3',            name: 'Rhea Menon',   initials: 'RM', role: 'student', roles: ['student'], roll: '24BEC2210', partner: false, email: 'rhea.m@campus.edu.in', status: 'pending_verification', tier: 1 },
];
export const userById = (id) => USERS.find((u) => u.id === id);

/* ---------- capability matrix -------------------------------------------
   `scope: 'own_vendor'` means the actor may only touch rows whose vendor
   matches their own. That is what stops the Frisco owner editing Tulips. */
const PLATFORM_CAPS = {
  'vendor.create': true, 'vendor.update': true, 'vendor.archive': true, 'vendor.toggle': true,
  'menu.create': true, 'menu.update': true, 'menu.archive': true, 'menu.availability': true,
  'menu.price': true, 'menu.photo': true, 'menu.options': true,
  'campus.create': true, 'campus.update': true, 'campus.archive': true,
  'order.read': true, 'order.read_all': true, 'order.transition': true, 'order.inspect': true,
  'staff.manage': true, 'pricing.update': true, 'flags.update': true,
  'partner.verify': true, 'delivery.config': true, 'delivery.read': true,
  'user.read': true, 'user.role': true, 'user.suspend': true,
  'trust.read': true, 'trust.act': true,
};

const CAPS = {
  /* Highest role. Only the owner may grant or revoke platform_admin. */
  platform_owner: { ...PLATFORM_CAPS, 'admin.grant': true, 'user.role': true },
  platform_admin: { ...PLATFORM_CAPS },
  /* Read-heavy: can look, can act on live orders, cannot reconfigure. */
  support: {
    'order.read': true, 'order.read_all': true, 'order.inspect': true, 'order.transition': true,
    'user.read': true, 'trust.read': true, 'delivery.read': true,
  },
  vendor_owner: {
    'vendor.update': 'own_vendor', 'vendor.toggle': 'own_vendor',
    'menu.create': 'own_vendor', 'menu.update': 'own_vendor', 'menu.archive': 'own_vendor',
    'menu.availability': 'own_vendor', 'menu.price': 'own_vendor',
    'menu.photo': 'own_vendor', 'menu.options': 'own_vendor',
    'order.read': 'own_vendor', 'order.transition': 'own_vendor', 'order.inspect': 'own_vendor',
    'staff.manage': 'own_vendor',
  },
  vendor_staff: {
    'menu.availability': 'own_vendor',
    'order.read': 'own_vendor', 'order.transition': 'own_vendor',
  },
  delivery_partner: { 'order.read': 'own', 'delivery.accept': 'own', 'delivery.read': 'own' },
  student: { 'order.create': true, 'order.read': 'own', 'order.cancel': 'own' },
};

/* A user may hold several roles; the union of their capabilities applies. */
function capsFor(session) {
  const roles = (session && (session.roles || [session.role])) || [];
  return roles.reduce((acc, r) => Object.assign(acc, CAPS[r] || {}), {});
}
function rulesFor(session, action) {
  const roles = (session && (session.roles || [session.role])) || [];
  /* Take the most permissive rule any held role grants for this action. */
  let best = undefined;
  for (const r of roles) {
    const v = (CAPS[r] || {})[action];
    if (v === true) return true;
    if (v && best === undefined) best = v;
  }
  return best;
}

export class Denied extends Error {
  constructor(msg, detail) { super(msg); this.name = 'Denied'; this.detail = detail; }
}

export const AUDIT = [];
function record(session, action, target, outcome, note) {
  AUDIT.unshift({
    at: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    who: session ? session.name : 'anonymous', role: session ? session.role : '—',
    action, target, outcome, note,
  });
  if (AUDIT.length > 60) AUDIT.pop();
}

/* The gate. Every mutation below calls this first. */
/* ==========================================================================
   THE CENTRAL AUTHORIZATION LAYER — authorize(user, action, resource)
   Every mutation in this file calls it. Three checks, in order:
     1. AUTHENTICATION  — only enforced when CONFIG_FLAGS.AUTH_ENABLED
     2. CAPABILITY      — does any role this user holds grant the action?
     3. SCOPE           — for 'own_vendor' rules, is the resource theirs?
   Steps 2 and 3 run whether or not authentication is enabled, which is why
   the prototype's scoping already works today.
   ========================================================================== */
export function authorize(session, action, resourceVendorId = null) {
  if (!session) throw new Denied('Not signed in', 'No session on this request.');

  /* 1 — authentication (inert while the flag is off) */
  if (CONFIG_FLAGS.AUTH_ENABLED) {
    if (!session.authenticated) {
      throw new Unauthenticated('Sign in required',
        'AUTH_ENABLED=true: this request carried no authenticated session.');
    }
    if (session.expiresAt && session.expiresAt < Date.now()) {
      throw new Unauthenticated('Session expired', 'Sign in again.');
    }
    if (session.status === 'suspended') {
      throw new Forbidden('Account suspended', 'Contact campus admin.');
    }
  }

  /* 2 — capability */
  const rule = rulesFor(session, action);
  if (!rule) {
    const holders = Object.entries(CAPS).filter(([, c]) => c[action]).map(([r]) => r);
    throw new Denied(`${session.role} cannot perform ${action}`,
      holders.length
        ? `The capability matrix grants "${action}" to ${holders.join(', ')} only.`
        : `"${action}" is not granted to any role.`);
  }

  /* 3 — scope */
  if (rule === 'own_vendor') {
    if (!session.vendor) throw new Denied('No outlet on this account', 'This account is not attached to a cafeteria.');
    if (resourceVendorId && resourceVendorId !== session.vendor) {
      const mine = VENDORS.find((v) => v.id === session.vendor);
      const theirs = VENDORS.find((v) => v.id === resourceVendorId);
      throw new Denied(
        `${mine ? mine.name : 'Your outlet'} cannot modify ${theirs ? theirs.name : 'another outlet'}`,
        `Scope check failed server-side: session.vendor=${session.vendor}, resource.vendor=${resourceVendorId}.`);
    }
  }
  if (rule === 'own' && resourceVendorId && session.id && resourceVendorId !== session.id) {
    throw new Denied('That record is not yours',
      `Row-level isolation: session.id=${session.id}, resource.owner=${resourceVendorId}.`);
  }
  return true;
}

/* Convenience for UIs that want to grey out rather than fail loudly. */
export function can(session, action, vendorId = null) {
  try { authorize(session, action, vendorId); return true; } catch { return false; }
}

/* ---------- vendor CRUD --------------------------------------------------- */
export const api = {
  vendors(session, { includeArchived = false } = {}) {
    let list = VENDORS.filter((v) => includeArchived || v.active);
    const roles = session ? (session.roles || [session.role]) : [];
    if (session && session.vendor && !roles.some(isPlatformRole)) {
      list = list.filter((v) => v.id === session.vendor);
    }
    return list;
  },

  createVendor(session, data) {
    authorize(session, 'vendor.create');
    const id = 'caf_' + (data.name || 'new').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 18) + '_' + Math.random().toString(36).slice(2, 5);
    const v = {
      id, name: data.name, slug: id, kind: data.kind || 'Campus outlet',
      mark: (data.name || 'N').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
      markBg: data.markBg || 'var(--ink-800)', heroBg: data.heroBg || 'var(--cream-300)',
      zone: data.zone || null, location: data.location || '',
      active: true, is_open: false, accepting: false,
      prep_minutes: +data.prep_minutes || 10, rating: 0, orders_today: 0,
      tags: (data.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
      staff_can_deliver: !!data.staff_can_deliver,
      hours: { opens: data.opens || '08:00', closes: data.closes || '18:00' },
      owner: data.owner || null, staff: [],
    };
    VENDORS.push(v);
    record(session, 'vendor.create', v.name, 'ok', 'Created inactive; opens when the owner switches it on');
    return v;
  },

  updateVendor(session, id, patch) {
    authorize(session, 'vendor.update', id);
    const v = VENDORS.find((x) => x.id === id);
    if (!v) throw new Denied('No such outlet');
    Object.assign(v, patch);
    if (patch.hours) v.hours = { ...v.hours, ...patch.hours };
    record(session, 'vendor.update', v.name, 'ok', Object.keys(patch).join(', '));
    return v;
  },

  /* Archive, never delete — historical orders keep resolving. */
  archiveVendor(session, id) {
    authorize(session, 'vendor.archive', id);
    const v = VENDORS.find((x) => x.id === id);
    v.active = false; v.is_open = false; v.accepting = false;
    record(session, 'vendor.archive', v.name, 'ok', 'Deactivated — past orders unaffected');
    return v;
  },
  restoreVendor(session, id) {
    authorize(session, 'vendor.archive', id);
    const v = VENDORS.find((x) => x.id === id);
    v.active = true;
    record(session, 'vendor.restore', v.name, 'ok');
    return v;
  },

  /* ---------- menu CRUD -------------------------------------------------- */
  items(session, vendorId, { includeArchived = false } = {}) {
    return ITEMS.filter((i) => i.caf === vendorId && (includeArchived || i.active));
  },

  createItem(session, vendorId, data) {
    authorize(session, 'menu.create', vendorId);
    const it = {
      id: 'itm_' + Math.random().toString(36).slice(2, 8),
      caf: vendorId, cat: data.cat || 'Others', name: data.name,
      desc: data.desc || '', price: Math.round((+data.price || 0) * 100),
      veg: data.veg !== false, glyph: data.glyph || '🍽️',
      available: true, active: true, popular: false,
      prep: +data.prep || 5,
      tags: (data.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
      aliases: (data.aliases || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      options: [],
      photo: data.photo || null,
      photoAlt: data.photo ? (data.name || '') : undefined,
    };
    ITEMS.push(it);
    record(session, 'menu.create', `${it.name} @ ${vendorId}`, 'ok');
    return it;
  },

  updateItem(session, itemId, patch) {
    const it = ITEMS.find((i) => i.id === itemId);
    if (!it) throw new Denied('No such item');
    if (patch.price !== undefined) authorize(session, 'menu.price', it.caf);
    if (patch.photo !== undefined) authorize(session, 'menu.photo', it.caf);
    if (patch.options !== undefined) authorize(session, 'menu.options', it.caf);
    authorize(session, 'menu.update', it.caf);
    if (patch.price !== undefined) patch.price = Math.round(+patch.price * 100);
    if (typeof patch.aliases === 'string') patch.aliases = patch.aliases.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (typeof patch.tags === 'string') patch.tags = patch.tags.split(',').map((s) => s.trim()).filter(Boolean);
    Object.assign(it, patch);
    record(session, 'menu.update', it.name, 'ok', Object.keys(patch).join(', '));
    return it;
  },

  setAvailability(session, itemId, available) {
    const it = ITEMS.find((i) => i.id === itemId);
    authorize(session, 'menu.availability', it.caf);
    it.available = available;
    record(session, 'menu.availability', it.name, 'ok', available ? 'back on' : 'out of stock');
    return it;
  },

  archiveItem(session, itemId) {
    const it = ITEMS.find((i) => i.id === itemId);
    authorize(session, 'menu.archive', it.caf);
    it.active = false; it.available = false;
    record(session, 'menu.archive', it.name, 'ok', 'Deactivated — past orders unaffected');
    return it;
  },
  restoreItem(session, itemId) {
    const it = ITEMS.find((i) => i.id === itemId);
    authorize(session, 'menu.archive', it.caf);
    it.active = true;
    record(session, 'menu.restore', it.name, 'ok');
    return it;
  },

  /* ---------- campus locations ------------------------------------------- */
  createNode(session, data) {
    authorize(session, 'campus.create');
    const n = {
      id: 'n_' + Math.random().toString(36).slice(2, 8),
      parent: data.parent || null, kind: data.kind, name: data.name,
      glyph: data.glyph || '', detail: data.detail || '',
      deliverable: !!data.deliverable, active: true,
      geo: data.lat ? { lat: +data.lat, lng: +data.lng, r: +data.r || 40 } : undefined,
    };
    CAMPUS_NODES.push(n);
    record(session, 'campus.create', n.name, 'ok', `${n.kind} under ${data.parent || 'campus root'}`);
    return n;
  },
  updateNode(session, id, patch) {
    authorize(session, 'campus.update');
    const n = nodeById(id); Object.assign(n, patch);
    record(session, 'campus.update', n.name, 'ok');
    return n;
  },
  archiveNode(session, id) {
    authorize(session, 'campus.archive');
    const n = nodeById(id); n.active = false;
    record(session, 'campus.archive', n.name, 'ok', 'Hidden from ordering; past orders keep resolving');
    return n;
  },

  /* ---------- THE CAMPUS BOUNDARY ----------------------------------------
     A GPS fix from a browser is a claim, not a fact. This is where it is
     checked. The frontend never decides whether a coordinate is on campus. */
  resolveLiveLocation(session, lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      record(session, 'geo.resolve', 'malformed', 'denied', 'Non-numeric coordinate rejected');
      throw new Denied('Bad coordinates', 'Coordinates must be numeric.');
    }
    if (!insideCampus(lat, lng)) {
      record(session, 'geo.resolve', `${lat.toFixed(4)},${lng.toFixed(4)}`, 'denied', 'Outside campus polygon');
      return { inside: false, candidates: [] };
    }
    const candidates = nearestNodes(lat, lng, 4).map((c) => ({
      id: c.node.id, label: pathLabel(c.node.id), metres: c.m,
      options: destinationOptions(c.node.id).map((o) => ({ id: o.id, label: pathLabel(o.id) })),
    }));
    record(session, 'geo.resolve', `${lat.toFixed(4)},${lng.toFixed(4)}`, 'ok', `${candidates.length} candidates`);
    return { inside: true, candidates };
  },

  /* A destination is only valid if it is an active, deliverable node. There
     is no code path that accepts a string. */
  validateDestination(session, nodeId) {
    const n = nodeById(nodeId);
    if (!n || !n.active || !n.deliverable) {
      record(session, 'order.destination', String(nodeId), 'denied', 'Not an active deliverable campus node');
      throw new Denied('That is not a Frisco delivery location',
        'Destinations must reference an active, deliverable campus node.');
    }
    return { id: n.id, label: pathLabel(n.id) };
  },

  /* ---------- orders ------------------------------------------------------ */
  orders(session, { vendorId = null } = {}) {
    authorize(session, 'order.read', vendorId || (session.vendor ?? null));
    /* Row-level isolation: a vendor session can only ever see its own rows,
       regardless of what the caller asks for. */
    const roles = session.roles || [session.role];
    let list = LIVE_ORDERS;
    if (!roles.some(isPlatformRole) && session.vendor) list = list.filter((o) => o.caf === session.vendor);
    else if (vendorId) list = list.filter((o) => o.caf === vendorId);
    return list;
  },

  transitionOrder(session, code, to) {
    const o = LIVE_ORDERS.find((x) => x.code === code);
    if (!o) throw new Denied('No such order');
    authorize(session, 'order.transition', o.caf);
    o.status = to;
    record(session, 'order.transition', `#${code}`, 'ok', `→ ${to}`);
    return o;
  },

  /* ---------- food photos -------------------------------------------------
     The image is attached to the actual menu row. `photo` holds a URL (or a
     data URI in this prototype); `photoAlt` and `photoUpdated` travel with
     it so the student site can render it accessibly and cache-bust.        */
  setItemPhoto(session, itemId, { dataUrl, alt = '', filename = '' }) {
    const it = ITEMS.find((i) => i.id === itemId);
    if (!it) throw new Denied('No such item');
    authorize(session, 'menu.photo', it.caf);
    if (!dataUrl) throw new Denied('No image supplied');
    /* Server-side validation: type and size. A client-side accept="" filter
       is a convenience, not a control. */
    const okType = /^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl) || /^https?:\/\//.test(dataUrl);
    if (!okType) throw new Denied('Unsupported image type', 'PNG, JPEG, WebP or GIF only.');
    const approxBytes = dataUrl.startsWith('data:') ? Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75) : 0;
    if (approxBytes > 2_500_000) throw new Denied('Image too large', 'Maximum 2.5 MB.');
    it.photo = dataUrl;
    it.photoAlt = alt || it.name;
    it.photoUpdated = Date.now();
    record(session, 'menu.photo', it.name, 'ok', filename ? `uploaded ${filename}` : 'photo updated');
    return it;
  },

  removeItemPhoto(session, itemId) {
    const it = ITEMS.find((i) => i.id === itemId);
    authorize(session, 'menu.photo', it.caf);
    delete it.photo; delete it.photoAlt; delete it.photoUpdated;
    record(session, 'menu.photo', it.name, 'ok', 'photo removed');
    return it;
  },

  /* ---------- item options / add-ons ------------------------------------- */
  setItemOptions(session, itemId, options) {
    const it = ITEMS.find((i) => i.id === itemId);
    authorize(session, 'menu.options', it.caf);
    it.options = (options || []).map((g) => ({
      group: String(g.group || '').slice(0, 40),
      choices: (g.choices || []).map((c) => ({
        label: String(c.label || '').slice(0, 40),
        delta: Math.round(Number(c.delta) || 0),
      })),
    }));
    record(session, 'menu.options', it.name, 'ok', `${it.options.length} groups`);
    return it;
  },

  /* ---------- users & roles ---------------------------------------------- */
  users(session, { role = null } = {}) {
    authorize(session, 'user.read');
    return USERS.filter((u) => !role || (u.roles || [u.role]).includes(role));
  },

  setUserRoles(session, userId, roles) {
    authorize(session, 'user.role');
    const u = USERS.find((x) => x.id === userId);
    if (!u) throw new Denied('No such user');
    /* Only the platform owner may create another platform admin. */
    const grantingAdmin = roles.some((r) => r === 'platform_admin' || r === 'platform_owner');
    if (grantingAdmin) authorize(session, 'admin.grant');
    if (u.role === 'platform_owner') {
      throw new Denied('The platform owner cannot be modified',
        'Primary admin is configured server-side and is not editable from the portal.');
    }
    u.roles = roles;
    u.role = roles[0];
    record(session, 'user.role', u.name, 'ok', roles.join(' + '));
    return u;
  },

  setUserStatus(session, userId, status) {
    authorize(session, 'user.suspend');
    const u = USERS.find((x) => x.id === userId);
    if (!u) throw new Denied('No such user');
    if (u.role === 'platform_owner') throw new Denied('The platform owner cannot be suspended');
    u.status = status;
    record(session, 'user.status', u.name, 'ok', status);
    return u;
  },

  verifyPartner(session, userId, approve = true) {
    authorize(session, 'partner.verify');
    const u = USERS.find((x) => x.id === userId);
    if (!u) throw new Denied('No such user');
    if (approve) {
      u.roles = [...new Set([...(u.roles || [u.role]), 'delivery_partner'])];
      u.partner = true; u.tier = 2; u.status = 'active';
    } else {
      u.roles = (u.roles || []).filter((r) => r !== 'delivery_partner');
      u.partner = false;
    }
    record(session, 'partner.verify', u.name, 'ok', approve ? 'approved' : 'rejected');
    return u;
  },

  /* ---------- order inspection ------------------------------------------- */
  allOrders(session) {
    authorize(session, 'order.read_all');
    return LIVE_ORDERS;
  },

  inspectOrder(session, code) {
    const o = LIVE_ORDERS.find((x) => x.code === code);
    if (!o) throw new Denied('No such order');
    authorize(session, 'order.inspect', o.caf);
    return { ...o, events: ORDER_EVENTS.filter((e) => e.code === code) };
  },

  /* ---------- delivery configuration ------------------------------------- */
  setPricing(session, key, valuePaise) {
    authorize(session, 'delivery.config');
    if (!(key in PRICING)) throw new Denied('Unknown pricing key', key);
    const before = PRICING[key];
    PRICING[key] = Math.round(valuePaise);
    record(session, 'pricing.update', key, 'ok', `${before} → ${PRICING[key]} paise`);
    return PRICING;
  },

  /* Server-side pricing. The AI agent and every UI call this; none of them
     compute a total themselves. */
  priceOrder(lines, fulfilment) {
    const subtotal = lines.reduce((a, l) => a + l.unit * l.qty, 0);
    const fee = fulfilment === 'delivery' ? PRICING.delivery_fee_paise : 0;
    return { subtotal, fee, total: subtotal + fee };
  },
};

/* ---------- self-test: proves the boundaries actually hold ---------------
   Runs on load; the admin portal renders the results. If any of these ever
   flip, a permission boundary has regressed.                              */
export function runPermissionTests() {
  const admin = userById('usr_admin');
  const frisco = userById('usr_owner_frisco');
  const staff = userById('usr_staff_frisco');
  const student = userById('usr_1');
  const t = [];
  const expect = (name, fn, shouldPass) => {
    let passed = true, err = null;
    try { fn(); } catch (e) { passed = false; err = e.message; }
    t.push({ name, ok: passed === shouldPass, expected: shouldPass ? 'allowed' : 'denied', got: passed ? 'allowed' : 'denied', err });
  };

  expect('Admin edits any menu', () => authorize(admin, 'menu.update', 'caf_tulips'), true);
  expect('Frisco owner edits Frisco menu', () => authorize(frisco, 'menu.update', 'caf_frisco'), true);
  expect('Frisco owner edits Chai Garam menu', () => authorize(frisco, 'menu.update', 'caf_chai'), false);
  expect('Frisco owner edits Tulips menu', () => authorize(frisco, 'menu.update', 'caf_tulips'), false);
  expect('Frisco owner reads Tulips orders', () => authorize(frisco, 'order.read', 'caf_tulips'), false);
  expect('Counter staff toggles own availability', () => authorize(staff, 'menu.availability', 'caf_frisco'), true);
  expect('Counter staff changes own prices', () => authorize(staff, 'menu.price', 'caf_frisco'), false);
  expect('Counter staff creates a vendor', () => authorize(staff, 'vendor.create'), false);
  expect('Student edits a menu', () => authorize(student, 'menu.update', 'caf_frisco'), false);
  expect('Student edits campus locations', () => authorize(student, 'campus.update'), false);
  expect('Owner archives own outlet', () => authorize(frisco, 'vendor.archive', 'caf_frisco'), false);
  expect('Admin archives an outlet', () => authorize(admin, 'vendor.archive', 'caf_frisco'), true);
  return t;
}
