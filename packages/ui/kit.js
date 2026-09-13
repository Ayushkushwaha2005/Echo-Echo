/* ==========================================================================
   FRISCO — SHARED UI KIT
   Helpers and markup fragments used by the website, admin portal and
   shopkeeper portal. These reproduce the approved app's component output
   exactly — same classes, same structure — so the three new surfaces render
   in the identical visual language without the app being touched.
   ========================================================================== */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
/* Money is formatted from integer paise in exactly one place; see also
   rupees() in packages/data/client.js, which this mirrors. */
export const money = (p) => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const I = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M15 18l-6-6 6-6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M9 18l6-6-6-6"/></svg>',
  chevD: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M6 9l6 6 6-6"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
  ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l1.9 4.7 4.7 1.9-4.7 1.9L12 16.7l-1.9-4.7L5.4 10l4.7-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M5 12h13M12 5l7 7-7 7"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M4 12.5l5.5 5.5L20 6.5"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 2l2.9 6.3 6.6.7-4.9 4.5 1.4 6.5L12 16.8 6 20l1.4-6.5L2.5 9l6.6-.7z"/></svg>',
  bike: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17" r="3.2"/><circle cx="18.5" cy="17" r="3.2"/><path d="M8 17h7l-3-8h-3M12 9l2-4h3"/></svg>',
  store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h16l-1 11H5z"/><path d="M3 9l2-5h14l2 5"/><path d="M9 20v-5h6v5"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 7z"/><path d="M9 4v13M15 7v12.5"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.4 8.3-8 9.5C7.4 20.3 4 17 4 12V6z"/></svg>',
  cog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.6 1.6 0 008 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H2a2 2 0 110-4h.1A1.6 1.6 0 004.6 8a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V2a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H22a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" width="15" height="15"><path d="M12 5v14M5 12h14"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.5 12h11L21 7H6"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h15a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M3 7V6a2 2 0 012-2h11"/><circle cx="17" cy="13.5" r="1.2"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 17l5-5-5-5M19 12H9M11 4H6a2 2 0 00-2 2v12a2 2 0 002 2h5"/></svg>',
};

/* ---------- fragments (identical markup to the approved app) ------------- */
export const Label = (t) => `<div class="t-label">${esc(t)}</div>`;
export const VegMark = (veg) => `<span class="vmark ${veg ? '' : 'nonveg'}" role="img" aria-label="${veg ? 'Vegetarian' : 'Non-vegetarian'}"></span>`;
export const StatusPill = (open) => open
  ? `<span class="badge badge-open"><i class="dot dot-live"></i>Open</span>`
  : `<span class="badge badge-closed"><i class="dot"></i>Closed</span>`;
export const Mark = (v, size = 52) => `<div class="cafmark" style="background:${v.markBg};width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.29)}px;font-size:${size > 44 ? '1.25rem' : '.82rem'}">${esc(v.mark)}</div>`;

export const Brand = (sub) => `
  <div class="rail-brand">
    <div class="cafmark" style="background:var(--surface-ink);width:34px;height:34px;border-radius:11px;font-size:.9rem">f.</div>
    <div><span class="bm">frisco</span><span class="bm-sub">${esc(sub)}</span></div>
  </div>`;

export const RailBtn = (icon, label, route, current, count) => `
  <button class="railbtn" data-act="go" data-route="${route}" ${current === route ? 'aria-current="page"' : ''}>
    ${icon}<span>${esc(label)}</span>${count ? `<span class="rb-count">${count}</span>` : ''}
  </button>`;

export const Modal = (title, body, foot, sub = '') => `
  <div class="modalwrap">
    <div class="scrim-fixed" data-act="closeModal"></div>
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div class="grow"><h2 class="t-h1">${esc(title)}</h2>${sub ? `<p class="t-sm muted">${esc(sub)}</p>` : ''}</div>
        <button class="backbtn" data-act="closeModal" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>
  </div>`;

export const Field = (name, label, value = '', opts = {}) => `
  <div class="formrow">
    <label for="f_${name}">${esc(label)}</label>
    ${opts.textarea
      ? `<textarea class="input" id="f_${name}" name="${name}" placeholder="${esc(opts.ph || '')}">${esc(value)}</textarea>`
      : opts.select
        ? `<select class="input" id="f_${name}" name="${name}">${opts.select.map((o) =>
            `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
        : `<input class="input" id="f_${name}" name="${name}" value="${esc(value)}" placeholder="${esc(opts.ph || '')}" ${opts.type ? `type="${opts.type}"` : ''} ${opts.inputmode ? `inputmode="${opts.inputmode}"` : ''}>`}
    ${opts.hint ? `<span class="hint">${esc(opts.hint)}</span>` : ''}
  </div>`;

export const Toggle = (checked, act, extra = '') => `
  <button class="switch" role="switch" aria-checked="${!!checked}" data-act="${act}" ${extra}></button>`;

export const Empty = (art, title, body, actions = '') => `
  <div class="empty"><div class="empty-art">${art}</div>
    <div class="t-h2">${esc(title)}</div>
    <p class="t-sm muted" style="max-width:34ch">${esc(body)}</p>
    ${actions ? `<div class="row g2" style="margin-top:8px">${actions}</div>` : ''}</div>`;

export const Kpi = (label, value, note = '', tone = '') => `
  <div class="kpi"><div class="t-label">${esc(label)}</div>
    <div class="v" ${tone ? `style="color:var(--${tone})"` : ''}>${value}</div>
    ${note ? `<div class="t-xs muted" style="margin-top:2px">${esc(note)}</div>` : ''}</div>`;

/* ---------- theme ---------------------------------------------------------
   Same three-state model the app uses: explicit light, explicit dark, and
   the unstamped system default. */
export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark'
    : (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('frisco-theme', next); } catch {}
}
export function restoreTheme() {
  try {
    const t = localStorage.getItem('frisco-theme');
    if (t) document.documentElement.setAttribute('data-theme', t);
  } catch {}
}

/* ---------- toast ---------------------------------------------------------- */
let toastTimer = null;
export function toast(msg, icon = '✓') {
  let el = $('#toasthost');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toasthost';
    el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:90;pointer-events:none';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="toast" style="position:static;transform:none">${icon ? `<span>${icon}</span>` : ''}${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.innerHTML = ''; }, 2400);
}

/* Denial banner — shown when the service layer refuses a call. Deliberately
   surfaced rather than swallowed, so the boundary is visible. */
export function denial(e) {
  return `<div class="denied">
    <span style="font-size:1.1rem">⛔</span>
    <div class="stack g1">
      <div class="t-h3" style="color:var(--danger)">${esc(e.message)}</div>
      ${e.detail ? `<div class="t-xs" style="color:var(--text-2)">${esc(e.detail)}</div>` : ''}
      <div class="t-xs faint">Refused by the service layer, not by the interface.</div>
    </div>
  </div>`;
}

/* Reads a modal's inputs into a plain object */
export function readForm(scope = document) {
  const out = {};
  $$('.modal [name]', scope).forEach((el) => {
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return out;
}

/* ---------- food photo ---------------------------------------------------
   Renders the item's photo when one exists, otherwise the emoji glyph the
   approved design already used. Visual output for photo-less items is
   byte-identical to before.                                                */
export const Thumb = (item, cls = 'item-thumb') =>
  item && item.photo
    ? `<div class="${cls}"><img class="thumb-photo" src="${esc(item.photo)}" alt="${esc(item.photoAlt || item.name)}" loading="lazy"></div>`
    : `<div class="${cls}">${item ? item.glyph : '🍽️'}</div>`;

/* Photo picker used in the Add/Edit Food modals. The chosen file is read to
   a data URI and validated again by the service layer on save. */
export const PhotoField = (item) => `
  <div class="formrow">
    <label>Food photo</label>
    <label class="photo-drop" for="f_photo">
      <span class="photo-preview" id="photo_preview">
        ${item && item.photo
          ? `<img src="${esc(item.photo)}" alt="${esc(item.photoAlt || item.name)}">`
          : (item ? item.glyph : '📷')}
      </span>
      <span class="grow">
        <span class="t-sm" style="font-weight:700">${item && item.photo ? 'Replace photo' : 'Upload photo'}</span>
        <span class="t-xs muted" style="display:block">PNG, JPEG or WebP · up to 2.5 MB</span>
      </span>
      <span class="btn btn-secondary btn-sm">Choose</span>
    </label>
    <input type="file" id="f_photo" name="photo" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
    <input type="hidden" name="photoData" value="${item && item.photo ? esc(item.photo) : ''}">
    ${item && item.photo ? `<button class="btn btn-ghost btn-sm" data-act="removephoto" data-i="${item.id}" style="align-self:flex-start">Remove photo</button>` : ''}
  </div>`;

/* Wired once per modal open; keeps the preview and hidden field in sync. */
export function bindPhotoInput() {
  const input = document.getElementById('f_photo');
  if (!input) return;
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 2_500_000) { toast('Image too large — 2.5 MB max', '⛔'); input.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const hidden = document.querySelector('[name="photoData"]');
      if (hidden) hidden.value = reader.result;
      const prev = document.getElementById('photo_preview');
      if (prev) prev.innerHTML = `<img src="${reader.result}" alt="">`;
    };
    reader.readAsDataURL(file);
  });
}
