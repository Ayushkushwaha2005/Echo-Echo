/* ==========================================================================
   ECHO ECHO — PUBLISHED WEBSITE SETTINGS, IN THE BROWSER

   The public website renders from these settings; Campus Control edits
   them. The server (server/src/services/site-config.js) is the authority:
   it validates every field and serves only the PUBLISHED version. This file

     · carries the same DEFAULTS, so the website looks exactly as it always
       has until somebody publishes (a test keeps the two copies equal)
     · turns a theme into CSS custom properties. Every value was validated
       as #RRGGBB, a bounded number or an enum before it was published, and
       is re-checked here, so nothing but a token value reaches the page
     · keeps an open page current: it asks for the version number when the
       tab comes back into view and every 30 seconds while it is visible,
       and fetches the settings only when that number moves
     · in Campus Control's preview frame, takes an unpublished draft from
       the parent window (same origin only) and never from anywhere else

   A copy of the last published settings is kept in localStorage purely so
   a returning visitor's first paint already has them; the server's answer
   replaces it as soon as it arrives.
   ========================================================================== */

export const SECTIONS = ['featured', 'banners', 'cafes', 'ask', 'reorder', 'pickup', 'deliver'];

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
    sections: SECTIONS.map((key) => ({ key, visible: true })),
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

export const FONT_STACK = {
  Manrope: '"Manrope"', Inter: '"Inter"', 'DM Sans': '"DM Sans"',
  'Plus Jakarta Sans': '"Plus Jakarta Sans"', 'Nunito Sans': '"Nunito Sans"',
};
const DENSITY = { compact: 0.875, comfortable: 1, spacious: 1.125 };
const SPACE = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 32, 8: 40, 9: 56, 10: 72 };

/** Published settings laid over the defaults, group by group. */
export function effective(config) {
  const d = structuredClone(DEFAULTS);
  if (!config || typeof config !== 'object') return d;
  for (const k of Object.keys(d)) {
    const v = config[k];
    if (v == null) continue;
    d[k] = Array.isArray(d[k]) ? (Array.isArray(v) ? v : d[k]) : { ...d[k], ...v };
  }
  /* Any section the stored list lacks (an older version) keeps its place. */
  const seen = new Set((d.home.sections || []).map((s) => s.key));
  d.home.sections = [...(d.home.sections || []).filter((s) => SECTIONS.includes(s.key)),
    ...SECTIONS.filter((k) => !seen.has(k)).map((key) => ({ key, visible: true }))];
  return d;
}

/* ---------- colour arithmetic, for the derived tokens --------------------- */
const HEX = /^#[0-9A-Fa-f]{6}$/;
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('').toUpperCase();
const mix = (a, b, t) => hex(rgb(a).map((x, i) => x + (rgb(b)[i] - x) * t));
function lum(h) {
  const [r, g, b] = rgb(h).map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
/* Darken toward the text colour until it reads on the surface (4.5:1). */
function readable(color, on, toward = '#1A1416') {
  let c = color;
  for (let t = 0.08; contrast(c, on) < 4.5 && t <= 1; t += 0.08) c = mix(color, toward, t);
  return c;
}
const onAccent = (accent) => (contrast('#FFFFFF', accent) >= contrast('#1A1416', accent) ? '#FFFFFF' : '#1A1416');

/**
 * The CSS for a theme: custom properties on :root only. Light appearance
 * only - the dark palette is tuned separately and its own rules are more
 * specific, so they keep winning in dark mode.
 */
export function themeCss(theme = {}) {
  const t = theme || {};
  const v = {};
  const ok = (x) => typeof x === 'string' && HEX.test(x);
  const surface = ok(t.surface) ? t.surface : '#FFFFFF';
  const text = ok(t.text) ? t.text : '#1A1416';
  if (ok(t.accent)) {
    v['--accent'] = t.accent;
    v['--accent-hover'] = mix(t.accent, '#000000', 0.14);
    v['--accent-soft'] = mix(t.accent, '#FFFFFF', 0.82);
    v['--accent-faint'] = mix(t.accent, '#FFFFFF', 0.92);
    v['--accent-text'] = readable(t.accent, surface, text);
    v['--accent-ring'] = `rgba(${rgb(t.accent).join(',')},.32)`;
    v['--text-on-rose'] = onAccent(t.accent);
    v['--surface-blush'] = mix(t.accent, '#FFFFFF', 0.94);
  }
  if (ok(t.background)) { v['--bg'] = t.background; v['--bg-sunken'] = mix(t.background, text, 0.05); }
  if (ok(t.surface)) { v['--surface'] = t.surface; v['--surface-2'] = mix(t.surface, ok(t.background) ? t.background : '#FAF7F3', 0.5); }
  if (ok(t.text)) { v['--text'] = t.text; v['--text-faint'] = mix(t.text, surface, 0.45); }
  if (ok(t.textSecondary)) { v['--text-2'] = t.textSecondary; v['--text-muted'] = mix(t.textSecondary, surface, 0.18); }
  if (ok(t.border)) { v['--line'] = t.border; v['--line-strong'] = mix(t.border, text, 0.12); }
  const int = (x, max) => Number.isInteger(x) && x >= 0 && x <= max;
  if (int(t.buttonRadius, 24)) { v['--r-btn'] = `${t.buttonRadius}px`; v['--r-input'] = `${t.buttonRadius}px`; }
  if (int(t.cardRadius, 28)) { v['--r-card'] = `${t.cardRadius}px`; v['--r-tile'] = `${Math.max(0, t.cardRadius - 2)}px`; }
  if (FONT_STACK[t.font]) v['--font-ui'] = `${FONT_STACK[t.font]}, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  if (DENSITY[t.density] && t.density !== 'comfortable') {
    for (const [k, px] of Object.entries(SPACE)) v[`--s-${k}`] = `${Math.round(px * DENSITY[t.density])}px`;
  }
  const body = Object.entries(v).map(([k, x]) => `${k}:${x}`).join(';');
  return body ? `:root{${body}}` : '';
}

/* ---------- applying to the document -------------------------------------- */
const FONT_URL = (f) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400..700&display=swap`;

export function applyToDocument(cfg, { assetUrl } = {}) {
  if (typeof document === 'undefined') return;
  const doc = document;
  let style = doc.getElementById('site-theme');
  if (!style) { style = doc.createElement('style'); style.id = 'site-theme'; doc.head.append(style); }
  style.textContent = themeCss(cfg.theme);

  const font = cfg.theme?.font;
  const link = doc.getElementById('site-font');
  if (font && font !== 'Manrope' && FONT_STACK[font]) {
    const l = link || Object.assign(doc.createElement('link'), { id: 'site-font', rel: 'stylesheet' });
    if (l.href !== FONT_URL(font)) l.href = FONT_URL(font);
    if (!link) doc.head.append(l);
  } else link?.remove();

  /* A visitor who has chosen light or dark keeps their choice. */
  let chosen = null;
  try { chosen = localStorage.getItem('frisco-theme'); } catch { /* storage blocked */ }
  if (!chosen) {
    const a = cfg.theme?.appearance;
    if (a === 'light' || a === 'dark') doc.documentElement.setAttribute('data-theme', a);
    else doc.documentElement.removeAttribute('data-theme');
  }

  if (cfg.seo?.title) doc.title = cfg.seo.title;
  const desc = doc.querySelector('meta[name="description"]');
  if (desc && cfg.seo?.description) desc.setAttribute('content', cfg.seo.description);

  const fav = cfg.brand?.faviconAsset && assetUrl ? assetUrl(cfg.brand.faviconAsset) : null;
  let icon = doc.getElementById('site-favicon');
  if (fav) {
    if (!icon) { icon = Object.assign(doc.createElement('link'), { id: 'site-favicon', rel: 'icon' }); doc.head.append(icon); }
    if (icon.href !== fav) icon.href = fav;
  } else icon?.remove();
}

/* ---------- keeping an open page current ---------------------------------- */
const CACHE_KEY = 'echo.site';
export const POLL_MS = 30_000;

/**
 * Starts the sync loop. `onChange(state)` runs whenever the settings in
 * force change; state = { version, config (effective), featuredItems,
 * preview }. Returns the current state synchronously (cached or defaults).
 */
export function startSiteSync({ api, onChange, previewFrom = null, now = () => Date.now() }) {
  let state = { version: 0, config: effective(null), featuredItems: [], preview: false };
  try {
    const c = JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) || 'null');
    if (c && Number.isInteger(c.version)) state = { version: c.version, config: effective(c.config), featuredItems: c.featuredItems || [], preview: false };
  } catch { /* no cache */ }

  const set = (next) => { state = next; onChange?.(state); };

  /* Campus Control's preview: the draft arrives by postMessage from the
     parent window on the same origin, and nothing is fetched or cached. */
  if (previewFrom) {
    state = { ...state, preview: true };
    previewFrom.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== previewFrom.parent) return;
      const m = e.data;
      if (m?.type !== 'echo-site-preview') return;
      set({ version: m.version || 0, config: effective(m.config), featuredItems: Array.isArray(m.featuredItems) ? m.featuredItems : [], preview: true });
    });
    try { previewFrom.parent.postMessage({ type: 'echo-site-preview-ready' }, location.origin); } catch { /* not framed */ }
    return state;
  }

  let busy = false;
  let lastCheck = 0;
  async function pull(force = false) {
    if (busy) return;
    busy = true;
    try {
      if (!force) {
        const { version } = await api.siteVersion();
        lastCheck = now();
        if (version === state.version) return;
      }
      const r = await api.siteConfig();
      lastCheck = now();
      if (r.version === state.version && !force) return;
      try { globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify({ version: r.version, config: r.config, featuredItems: r.featuredItems })); } catch { /* storage full or blocked */ }
      if (r.version !== state.version || JSON.stringify(r.featuredItems) !== JSON.stringify(state.featuredItems)) {
        set({ version: r.version, config: effective(r.config), featuredItems: r.featuredItems || [], preview: false });
      }
    } catch {
      /* The server is unreachable or waking up: the settings in force stay
         in force. The next check tries again. */
    } finally { busy = false; }
  }

  pull(true);
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  setInterval(() => { if (visible()) pull(); }, POLL_MS);
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (visible() && now() - lastCheck > 5000) pull(); });
  globalThis.addEventListener?.('focus', () => { if (now() - lastCheck > 5000) pull(); });
  return state;
}

/** Banners still in their window on the visitor's clock (the server filtered already). */
export const liveBanners = (cfg, t = Date.now()) => (cfg.banners || []).filter((b) => b.active
  && (!b.startsAt || Date.parse(b.startsAt) <= t) && (!b.endsAt || Date.parse(b.endsAt) > t));

/** An internal screen link (#/cafes) or an external one; the server checked it. */
export function linkAttrs(link) {
  if (!link) return null;
  const m = String(link).match(/^#\/([a-z-]+)(?:\/([A-Za-z0-9-]+))?$/);
  if (m) return { internal: true, route: m[1] === 'signin' ? 'signin' : m[1], id: m[2] || null };
  if (/^(https:|mailto:)/i.test(link)) return { internal: false, href: link };
  return null;
}
