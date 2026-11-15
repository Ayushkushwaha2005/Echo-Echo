/* ==========================================================================
   ECHO ECHO — LIGHT / DARK SWITCH  (from the owner's cinematic-theme-switcher.tsx)

   The supplied React component without React, next-themes, framer-motion or
   lucide-react, keeping what it draws and how it moves:

   * the 104×64 pill (6 px padding, 2 px border) with its radial-gradient
     face, twelve-layer inset/outer shadows, inner groove, glossy overlay and
     ambient occlusion, light and dark exactly as written;
   * Sun and Moon (lucide, 20 px) behind the thumb, amber-600 / slate-700 in
     light and yellow-100 in dark;
   * the 44 px thumb with its gradient, shadows, border and shine, carrying
     the Sun (amber-500) or Moon (yellow-200);
   * framer-motion's spring, stiffness 300 / damping 20 / mass 1, moving the
     thumb 0 ↔ 46 px, simulated here frame by frame so it overshoots and
     settles the same way;
   * three grain-textured particles from the thumb's centre, 0.1 s apart,
     0.6 / 0.7 / 0.8 s (0.5 s when turning dark), scaling to 8 (6 dark) with
     opacity 0 → 1 → 0, cleared after 1 s; whileTap scale 0.98.

   next-themes became this site's own theme model (packages/ui/kit.js): the
   choice is data-theme on <html> and 'frisco-theme' in localStorage, and
   with no choice the system setting decides. The supplied component also
   defines two SVG grain filters that nothing references; they draw nothing
   and are left out.

   `zoom` (the --cts-scale custom property) shrinks the whole switch for a
   navigation bar without changing its proportions.
   ========================================================================== */

/* The public site's key; Campus Control keeps its own (bindThemeSwitch storageKey). */
let KEY = 'frisco-theme';
const icon = (body, size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const SUN = (s = 20) => icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>', s);
const MOON = (s = 20) => icon('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', s);
const GRAIN = `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`;
const TRAVEL = 46;

const systemDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
/** Dark now: an explicit choice, or the system when there is none. */
export function isDark(doc = document) {
  const t = doc.documentElement.getAttribute('data-theme');
  return t === 'dark' || (t !== 'light' && systemDark());
}
function setTheme(next, doc = document) {
  doc.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(KEY, next); } catch { /* storage blocked: this page still switches */ }
}

/** The switch as HTML, drawn in the theme that is active right now. */
export function ThemeSwitch({ className = '' } = {}) {
  const dark = typeof document !== 'undefined' && isDark();
  return `<span class="cts${className ? ` ${className}` : ''}">
    <button type="button" class="cts-track" data-theme-switch role="switch" aria-checked="${dark}"
      aria-label="Switch to ${dark ? 'light' : 'dark'} mode">
      <span class="cts-groove"></span><span class="cts-gloss"></span><span class="cts-ao"></span>
      <span class="cts-bg"><span class="cts-bg-sun">${SUN()}</span><span class="cts-bg-moon">${MOON()}</span></span>
      <span class="cts-thumb" style="transform:translateX(${dark ? TRAVEL : 0}px)">
        <span class="cts-shine"></span><span class="cts-particles"></span>
        <span class="cts-icon"><span class="cts-icon-sun">${SUN()}</span><span class="cts-icon-moon">${MOON()}</span></span>
      </span>
    </button></span>`;
}

/* framer-motion's default spring: stiffness 300, damping 20, mass 1. */
const springs = new WeakMap();
function spring(el, to) {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cur = springs.get(el);
  if (cur) cancelAnimationFrame(cur.raf);
  const m = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform || '');
  let x = cur?.x ?? (m ? Number(m[1]) : 0), v = cur?.v ?? 0;
  if (reduce || typeof requestAnimationFrame !== 'function') {
    el.style.transform = `translateX(${to}px)`; springs.delete(el); return;
  }
  let last = null;
  const state = { x, v, raf: 0 };
  const step = (t) => {
    const dt = last === null ? 1 / 60 : Math.min((t - last) / 1000, 1 / 30);
    last = t;
    for (let i = 0; i < 4; i++) {            // small fixed sub-steps keep it stable
      const h = dt / 4;
      const a = -300 * (x - to) - 20 * v;
      v += a * h; x += v * h;
    }
    state.x = x; state.v = v;
    el.style.transform = `translateX(${x.toFixed(2)}px)`;
    if (Math.abs(x - to) < 0.01 && Math.abs(v) < 0.01) {
      el.style.transform = `translateX(${to}px)`; springs.delete(el); return;
    }
    state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
  springs.set(el, state);
}

function particles(thumb, dark) {
  const host = thumb.querySelector('.cts-particles');
  if (!host) return;
  host.innerHTML = '';
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (let i = 0; i < 3; i++) {
    const p = document.createElement('span');
    p.className = 'cts-particle';
    p.style.setProperty('--cts-scale-to', dark ? 6 : 8);
    p.style.animationDuration = `${dark ? 0.5 : 0.6 + i * 0.1}s`;
    p.style.animationDelay = `${i * 0.1}s`;
    p.innerHTML = `<span class="cts-grain" style="background-image:${GRAIN}"></span>`;
    host.append(p);
  }
  clearTimeout(host._clear);
  host._clear = setTimeout(() => { host.innerHTML = ''; }, 1000);
}

/** Make every switch on the page show the active theme; `animate` moves them. */
export function syncThemeSwitches({ animate = false, burst = null } = {}) {
  const dark = isDark();
  for (const btn of document.querySelectorAll('[data-theme-switch]')) {
    btn.setAttribute('aria-checked', String(dark));
    btn.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
    const thumb = btn.querySelector('.cts-thumb');
    if (!thumb) continue;
    if (animate) spring(thumb, dark ? TRAVEL : 0);
    else { springs.delete(thumb); thumb.style.transform = `translateX(${dark ? TRAVEL : 0}px)`; }
    if (burst === btn) particles(thumb, dark);
  }
}

/* Installed once per page. */
let bound = false;
export function bindThemeSwitch({ doc = typeof document === 'undefined' ? null : document, storageKey = null } = {}) {
  if (storageKey) KEY = storageKey;
  if (bound || !doc) return;
  bound = true;
  doc.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[data-theme-switch]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    setTheme(isDark() ? 'light' : 'dark');
    syncThemeSwitches({ animate: true, burst: btn });
  }, true);
  /* Another tab, or the system setting while no choice is stored. */
  (doc.defaultView || globalThis).addEventListener?.('storage', (e) => {
    if (e.key !== KEY) return;
    if (e.newValue === 'light' || e.newValue === 'dark') doc.documentElement.setAttribute('data-theme', e.newValue);
    syncThemeSwitches({ animate: true });
  });
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => syncThemeSwitches({ animate: true }));
  }
}
