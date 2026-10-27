/* ==========================================================================
   ECHO ECHO - WEBSITE CUSTOMIZATION: THE SCHEMA

   What an administrator may change about the public website without a
   deployment, and nothing else. The configuration is DATA rendered by the
   website's own code: there is no field that carries CSS, HTML, script or a
   free-form URL scheme, so publishing cannot inject anything into the page.

     · every key is on an allowlist; an unknown key is an error, not ignored
     · colours are #RRGGBB, radii and counts are bounded integers, fonts and
       presets are enums, text is plain text with a length limit
     · a link is an internal screen (#/cafes) or an https:/mailto: address
     · cafés, dishes and images are referenced by id and checked to exist;
       the website still shows only what /vendors would show, so featuring a
       closed or archived café cannot make it orderable
     · a theme whose text would be unreadable on its background is refused

   The website (packages/data/site-config.js) carries a copy of DEFAULTS so
   it renders the same page before anything has ever been published; a test
   keeps the two copies equal.
   ========================================================================== */

export const SCHEMA_VERSION = 1;

export const FONTS = ['Manrope', 'Inter', 'DM Sans', 'Plus Jakarta Sans', 'Nunito Sans'];
export const DENSITIES = ['compact', 'comfortable', 'spacious'];
export const APPEARANCES = ['system', 'light', 'dark'];
export const TONES = ['info', 'promo', 'alert'];
export const HOME_SECTIONS = ['featured', 'banners', 'cafes', 'ask', 'reorder', 'pickup', 'deliver'];
export const ROUTES = ['home', 'cafes', 'deliver', 'ai', 'orders', 'profile', 'signin', 'ob-college', 'cart'];

export const LIMITS = {
  featuredCafes: 6, featuredItems: 8, banners: 5, footerLinks: 6,
};

/* What the website shows today, written down once. A field left as it is
   here changes nothing on the page. Theme values of null mean "the design
   system's own token", so an untouched theme is the shipped theme. */
export const DEFAULTS = Object.freeze({
  theme: {
    accent: null, background: null, surface: null, text: null, textSecondary: null, border: null,
    buttonRadius: null, cardRadius: null, font: null, density: null, appearance: null,
  },
  brand: { logoAsset: null, faviconAsset: null },
  announcement: { enabled: false, text: '', tone: 'info', linkLabel: '', link: '' },
  hero: {
    eyebrow: 'ECHO ECHO · UPES Bidholi',
    heading: 'Campus food, brought to',
    headingAccent: 'where you are',
    body: 'Order from the cafés on campus. Another student on their way past brings it to the library, the ground or your block, or you pick it up yourself.',
    imageAsset: null,
    primaryLabel: 'Sign in with your student email', primaryLink: '#/signin',
    secondaryLabel: 'Browse cafés first', secondaryLink: '#/cafes',
  },
  home: {
    title: 'Campus food, brought to your spot.',
    sections: HOME_SECTIONS.map((key) => ({ key, visible: true })),
  },
  featured: { heading: 'Featured', cafeIds: [], itemIds: [] },
  banners: [],
  footer: { text: 'Campus delivery only', links: [], contactEmail: '', contactPhone: '', supportLink: '' },
  seo: {
    title: 'ECHO ECHO — Campus food at UPES Bidholi',
    description: 'Order from the cafés on UPES Bidholi campus. A verified student delivers it to a spot on campus, or pick it up yourself. Prepaid online, with the full total shown before you pay.',
  },
  features: { askEcho: true, deliverPromo: true, pickupPromo: true, browseFirst: true },
});

export const defaults = () => structuredClone(DEFAULTS);

/* ---------- primitives ---------------------------------------------------- */
const HEX = /^#[0-9A-Fa-f]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;

/* Plain text: control characters removed, whitespace collapsed at the ends.
   It is escaped wherever it is rendered; this only keeps it tidy. */
// eslint-disable-next-line no-control-regex
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

/** An internal screen, an https: page or a mailto: address. '' is "none". */
export function checkLink(v) {
  if (v === '' || v == null) return '';
  const s = String(v).trim();
  const internal = s.match(/^#\/([a-z-]+)(?:\/([A-Za-z0-9-]{1,64}))?$/);
  if (internal) {
    const [, route, id] = internal;
    if (route === 'menu' && id) return s;
    if (ROUTES.includes(route) && !id) return s;
    throw new Error(`"${s}" is not a screen on the website`);
  }
  if (/^mailto:/i.test(s)) {
    if (!EMAIL.test(s.slice(7))) throw new Error(`"${s}" is not a valid email link`);
    return s;
  }
  let u;
  try { u = new URL(s); } catch { throw new Error(`"${s}" is not a link the website can open`); }
  if (u.protocol !== 'https:') throw new Error('Links must start with https://');
  if (u.username || u.password) throw new Error('Links must not contain a user name or password');
  if (s.length > 300) throw new Error('That link is too long');
  return u.toString();
}

/* WCAG relative luminance and contrast ratio, for the readability check. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/* The light theme's shipped values, for checking a partial override. */
const SHIPPED = { background: '#FAF7F3', surface: '#FFFFFF', text: '#1A1416', textSecondary: '#3D3134', accent: '#C8425F' };

/* ---------- the walker ------------------------------------------------------
   Each field is described once; the walker checks type and bounds, strips
   nothing silently, and reports every problem with its path so the editor
   can point at the field. */
const F = {
  text: (max, { required = false } = {}) => ({ kind: 'text', max, required }),
  bool: () => ({ kind: 'bool' }),
  hex: () => ({ kind: 'hex' }),
  int: (min, max) => ({ kind: 'int', min, max }),
  oneOf: (values) => ({ kind: 'enum', values }),
  asset: () => ({ kind: 'asset' }),
  link: () => ({ kind: 'link' }),
  email: () => ({ kind: 'email' }),
  phone: () => ({ kind: 'phone' }),
  date: () => ({ kind: 'date' }),
};

const SHAPE = {
  theme: {
    accent: F.hex(), background: F.hex(), surface: F.hex(), text: F.hex(), textSecondary: F.hex(), border: F.hex(),
    buttonRadius: F.int(0, 24), cardRadius: F.int(0, 28),
    font: F.oneOf(FONTS), density: F.oneOf(DENSITIES), appearance: F.oneOf(APPEARANCES),
  },
  brand: { logoAsset: F.asset(), faviconAsset: F.asset() },
  announcement: { enabled: F.bool(), text: F.text(160), tone: F.oneOf(TONES), linkLabel: F.text(30), link: F.link() },
  hero: {
    eyebrow: F.text(60), heading: F.text(90, { required: true }), headingAccent: F.text(60), body: F.text(280),
    imageAsset: F.asset(),
    primaryLabel: F.text(40, { required: true }), primaryLink: F.link(),
    secondaryLabel: F.text(40), secondaryLink: F.link(),
  },
  footer: { text: F.text(200), contactEmail: F.email(), contactPhone: F.phone(), supportLink: F.link() },
  seo: { title: F.text(70, { required: true }), description: F.text(300) },
  features: { askEcho: F.bool(), deliverPromo: F.bool(), pickupPromo: F.bool(), browseFirst: F.bool() },
};
const NULLABLE = new Set(['theme', 'brand', 'hero.imageAsset']);

function field(spec, v, path, problems) {
  const bad = (m) => { problems.push({ path, problem: m }); return undefined; };
  const nullable = NULLABLE.has(path.split('.')[0]) || NULLABLE.has(path);
  if (v === null && (nullable || spec.kind === 'asset' || spec.kind === 'date')) return null;
  switch (spec.kind) {
    case 'text': {
      if (typeof v !== 'string') return bad('must be text');
      const s = clean(v);
      if (spec.required && !s) return bad('cannot be empty');
      if (s.length > spec.max) return bad(`must be at most ${spec.max} characters`);
      return s;
    }
    case 'bool': return typeof v === 'boolean' ? v : bad('must be true or false');
    case 'hex': return typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : bad('must be a colour like #C8425F');
    case 'int': return Number.isInteger(v) && v >= spec.min && v <= spec.max ? v : bad(`must be a whole number from ${spec.min} to ${spec.max}`);
    case 'enum': return spec.values.includes(v) ? v : bad(`must be one of ${spec.values.join(', ')}`);
    case 'asset': return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad('must be an uploaded image');
    case 'date': {
      const d = typeof v === 'string' ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d.toISOString() : bad('must be a date and time');
    }
    case 'email': {
      if (typeof v !== 'string') return bad('must be text');
      const s = clean(v);
      return !s || EMAIL.test(s) ? s : bad('must be an email address');
    }
    case 'phone': {
      if (typeof v !== 'string') return bad('must be text');
      const s = clean(v);
      return !s || PHONE.test(s) ? s : bad('must be a phone number');
    }
    case 'link': {
      if (typeof v !== 'string') return bad('must be a link');
      try { return checkLink(v); } catch (e) { return bad(e.message); }
    }
    default: return bad('is not a known field');
  }
}

function group(shape, obj, path, problems) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    problems.push({ path, problem: 'must be an object' });
    return null;
  }
  const out = {};
  for (const k of Object.keys(obj)) if (!(k in shape)) problems.push({ path: `${path}.${k}`, problem: 'is not a setting the website has' });
  for (const [k, spec] of Object.entries(shape)) {
    if (!(k in obj)) { problems.push({ path: `${path}.${k}`, problem: 'is missing' }); continue; }
    out[k] = field(spec, obj[k], `${path}.${k}`, problems);
  }
  return out;
}

const uuidList = (v, path, max, problems) => {
  if (!Array.isArray(v)) { problems.push({ path, problem: 'must be a list' }); return []; }
  if (v.length > max) problems.push({ path, problem: `can hold at most ${max}` });
  const ids = v.map((x) => String(x).toLowerCase());
  if (ids.some((x) => !UUID.test(x))) problems.push({ path, problem: 'contains something that is not an id' });
  if (new Set(ids).size !== ids.length) problems.push({ path, problem: 'lists the same thing twice' });
  return ids;
};

/**
 * Check a whole configuration. Returns { ok, config, problems } where config
 * is the normalised copy (only when ok). Pure: references to cafés, dishes
 * and images are checked separately by checkReferences(), which needs the DB.
 */
export function validate(input) {
  const problems = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: [{ path: 'config', problem: 'must be an object' }] };
  }
  const TOP = ['theme', 'brand', 'announcement', 'hero', 'home', 'featured', 'banners', 'footer', 'seo', 'features'];
  for (const k of Object.keys(input)) if (!TOP.includes(k)) problems.push({ path: k, problem: 'is not a setting the website has' });

  const out = {};
  for (const k of ['theme', 'brand', 'announcement', 'hero', 'seo', 'features']) {
    out[k] = k in input ? group(SHAPE[k], input[k], k, problems) : (problems.push({ path: k, problem: 'is missing' }), null);
  }

  /* footer: plain fields plus a list of links. */
  const footer = input.footer;
  if (footer && typeof footer === 'object' && !Array.isArray(footer)) {
    const { links, ...rest } = footer;
    out.footer = group(SHAPE.footer, rest, 'footer', problems);
    if (!Array.isArray(links)) problems.push({ path: 'footer.links', problem: 'must be a list' });
    else {
      if (links.length > LIMITS.footerLinks) problems.push({ path: 'footer.links', problem: `can hold at most ${LIMITS.footerLinks}` });
      out.footer.links = links.map((l, i) => group({ label: F.text(30, { required: true }), link: F.link() }, l, `footer.links.${i}`, problems));
      out.footer.links.forEach((l, i) => { if (l && !l.link) problems.push({ path: `footer.links.${i}.link`, problem: 'cannot be empty' }); });
    }
  } else problems.push({ path: 'footer', problem: 'must be an object' });

  /* home: a title and every known section exactly once, in display order. */
  const home = input.home;
  if (home && typeof home === 'object' && !Array.isArray(home)) {
    for (const k of Object.keys(home)) if (!['title', 'sections'].includes(k)) problems.push({ path: `home.${k}`, problem: 'is not a setting the website has' });
    out.home = { title: field(F.text(90, { required: true }), home.title, 'home.title', problems), sections: [] };
    if (!Array.isArray(home.sections)) problems.push({ path: 'home.sections', problem: 'must be a list' });
    else {
      out.home.sections = home.sections.map((s, i) => group({ key: F.oneOf(HOME_SECTIONS), visible: F.bool() }, s, `home.sections.${i}`, problems));
      const keys = out.home.sections.map((s) => s?.key);
      if (keys.length !== HOME_SECTIONS.length || HOME_SECTIONS.some((k) => !keys.includes(k))) {
        problems.push({ path: 'home.sections', problem: `must list each section once: ${HOME_SECTIONS.join(', ')}` });
      }
    }
  } else problems.push({ path: 'home', problem: 'must be an object' });

  /* featured: a heading and ids, checked against the database later. */
  const fe = input.featured;
  if (fe && typeof fe === 'object' && !Array.isArray(fe)) {
    for (const k of Object.keys(fe)) if (!['heading', 'cafeIds', 'itemIds'].includes(k)) problems.push({ path: `featured.${k}`, problem: 'is not a setting the website has' });
    out.featured = {
      heading: field(F.text(60, { required: true }), fe.heading, 'featured.heading', problems),
      cafeIds: uuidList(fe.cafeIds, 'featured.cafeIds', LIMITS.featuredCafes, problems),
      itemIds: uuidList(fe.itemIds, 'featured.itemIds', LIMITS.featuredItems, problems),
    };
  } else problems.push({ path: 'featured', problem: 'must be an object' });

  /* banners: promotional cards with an optional schedule. */
  if (!Array.isArray(input.banners)) problems.push({ path: 'banners', problem: 'must be a list' });
  else {
    if (input.banners.length > LIMITS.banners) problems.push({ path: 'banners', problem: `can hold at most ${LIMITS.banners}` });
    const BANNER = { id: F.text(40, { required: true }), title: F.text(60, { required: true }), body: F.text(140),
                     imageAsset: F.asset(), link: F.link(), linkLabel: F.text(30), active: F.bool(),
                     startsAt: F.date(), endsAt: F.date() };
    out.banners = input.banners.map((b, i) => group(BANNER, b, `banners.${i}`, problems));
    const ids = out.banners.map((b) => b?.id);
    out.banners.forEach((b, i) => {
      if (!b) return;
      if (b.id && !SLUG.test(b.id)) problems.push({ path: `banners.${i}.id`, problem: 'must be lowercase letters, digits and dashes' });
      if (b.startsAt && b.endsAt && b.startsAt >= b.endsAt) problems.push({ path: `banners.${i}.endsAt`, problem: 'must be after the start' });
      if (b.link && !b.linkLabel) problems.push({ path: `banners.${i}.linkLabel`, problem: 'is needed when the banner has a link' });
    });
    if (new Set(ids).size !== ids.length) problems.push({ path: 'banners', problem: 'two banners have the same id' });
  }

  /* Cross-field rules. */
  const a = out.announcement;
  if (a?.enabled && !a.text) problems.push({ path: 'announcement.text', problem: 'is needed while the announcement is on' });
  if (a?.link && !a.linkLabel) problems.push({ path: 'announcement.linkLabel', problem: 'is needed when the announcement has a link' });
  if (out.hero?.secondaryLabel && !out.hero.secondaryLink) problems.push({ path: 'hero.secondaryLink', problem: 'is needed when the second button has a label' });
  if (out.hero && !out.hero.primaryLink) problems.push({ path: 'hero.primaryLink', problem: 'cannot be empty' });

  /* Readability: text must stay legible on the page and on cards. */
  const t = out.theme;
  if (t && problems.every((p) => !p.path.startsWith('theme.'))) {
    const v = { ...SHIPPED, ...Object.fromEntries(Object.entries(t).filter(([, x]) => x !== null)) };
    const need = [
      ['text', 'background', 4.5], ['text', 'surface', 4.5],
      ['textSecondary', 'background', 4.5], ['textSecondary', 'surface', 4.5],
      ['accent', 'surface', 3],
    ];
    for (const [fg, bg, min] of need) {
      const r = contrast(v[fg], v[bg]);
      if (r < min) problems.push({ path: `theme.${fg}`, problem: `is too hard to read on the ${bg} colour (contrast ${r.toFixed(2)}:1, needs ${min}:1)` });
    }
  }

  return problems.length ? { ok: false, problems } : { ok: true, config: out, problems: [] };
}

/** Every asset id the configuration points at. */
export function assetIds(config) {
  return [config.brand?.logoAsset, config.brand?.faviconAsset, config.hero?.imageAsset,
    ...(config.banners || []).map((b) => b.imageAsset)].filter(Boolean);
}

/**
 * Database checks a pure validator cannot make: referenced images exist and
 * are site or menu images; featured cafés and dishes exist and are not
 * archived. Returns problems in the same shape as validate().
 */
export async function checkReferences(config, { q }) {
  const problems = [];
  const assets = [...new Set(assetIds(config))];
  if (assets.length) {
    const { rows } = await q(`SELECT id::text, kind FROM asset WHERE id = ANY($1::uuid[])`, [assets]);
    const ok = new Map(rows.map((r) => [r.id, r.kind]));
    for (const id of assets) {
      if (!ok.has(id)) problems.push({ path: 'images', problem: `image ${id} was not found; upload it again` });
      else if (!['site_image', 'vendor_photo', 'food_photo'].includes(ok.get(id))) problems.push({ path: 'images', problem: `image ${id} cannot be used on the public website` });
    }
  }
  const cafes = config.featured?.cafeIds || [];
  if (cafes.length) {
    const { rows } = await q(`SELECT id::text FROM vendor WHERE id = ANY($1::uuid[]) AND active`, [cafes]);
    const have = new Set(rows.map((r) => r.id));
    for (const id of cafes) if (!have.has(id)) problems.push({ path: 'featured.cafeIds', problem: `café ${id} does not exist or is archived` });
  }
  const items = config.featured?.itemIds || [];
  if (items.length) {
    const { rows } = await q(`SELECT i.id::text AS id FROM menu_item i JOIN vendor v ON v.id = i.vendor_id WHERE i.id = ANY($1::uuid[]) AND i.active AND v.active`, [items]);
    const have = new Set(rows.map((r) => r.id));
    for (const id of items) if (!have.has(id)) problems.push({ path: 'featured.itemIds', problem: `dish ${id} does not exist or is archived` });
  }
  return problems;
}
