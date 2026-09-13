/* ==========================================================================
   ECHO ECHO — CUSTOMER WEBSITE

   The approved customer experience from prototype/ (the locked visual
   reference): the same phone-first stage, screens, markup and component
   classes — welcome → home → cafés → menu → cart → checkout → tracking —
   now reading from the live API instead of the prototype's seed data.

   What was demo scaffolding in the prototype is not carried over: the role
   switcher, the "pilot demo controls", timers that fake an order advancing,
   invented ratings, fees, partner names and handover codes, and the cash
   option (this product is prepaid only). Where the server has no data the
   screen says so instead of making something up.

   Every screen here reads from the API. The cart is the only client state,
   and it holds ids and quantities — never prices, because the server prices
   the draft.
   ========================================================================== */
import { quad, ApiError, Offline, rupees, ratingLabel } from '../../packages/data/client.js';
import { esc, VegMark, StatusPill, I as KIT, toggleTheme, restoreTheme } from '../../packages/ui/kit.js';

restoreTheme();

const BRAND = 'ECHO ECHO';
const $ = (s, r = document) => r.querySelector(s);
const money = rupees;

/* Prototype icons that kit.js sizes differently or does not carry. */
const I = {
  ...KIT,
  ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M12 3.5l1.9 4.7 4.7 1.9-4.7 1.9L12 16.7l-1.9-4.7L5.4 10l4.7-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
  bike: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="5.5" cy="17" r="3.2"/><circle cx="18.5" cy="17" r="3.2"/><path d="M8 17h7l-3-8h-3M12 9l2-4h3"/></svg>',
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 016 0v2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 014.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17v.3"/></svg>',
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/></svg>',
  plate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/></svg>',
};
/* An icon in the slot an emoji glyph used to occupy. */
const Ico = (svg, size = 20) => `<span class="ico" style="width:${size}px;height:${size}px">${svg}</span>`;

/* ===================== store ============================================ */
const S = {
  route: 'home',
  params: {},
  me: null,               // /auth/me, or null when signed out
  providers: null,        // /auth/status providers
  cart: [],               // [{ itemId, qty, name, pricePaise, veg, glyph, vendorId }]
  fulfilment: 'delivery',
  destination: null,      // { id, name, path }
  sheet: null,
  toast: null,
  auth: { phone: '', email: '', resendAfter: 0, error: '' },
  verify: {},             // mailbox-link flow on the verify screen
  campuses: null,         // /campuses
  setup: {},              // profile completion: { campusId, error }
  review: {},             // orderId -> { vendor: stars, delivery: stars }
  handoff: {},            // orderId -> delivery code, shown once
  chat: { messages: [], busy: false },
};

const signedIn = () => !!S.me?.authenticated;
const NEEDS_ACCOUNT = ['orders', 'tracking', 'profile', 'checkout', 'verify', 'partner', 'join', 'setup'];

/* ---------- campus -------------------------------------------------------
   The server stores the student's campus; this only reads it. Signed out,
   the site shows the first campus that is in service. */
const myProfile = () => S.me?.profile || null;
const profileIncomplete = () => signedIn() && myProfile() && !myProfile().complete;
function browseCampus() {
  const mine = myProfile()?.campus;
  if (mine) return mine;
  return (S.campuses || []).find((c) => c.available) || null;
}
const COLLEGE = () => browseCampus()?.collegeName?.replace(' - ', ' — ') || 'UPES — University of Petroleum and Energy Studies';
const campusLabel = () => {
  const c = signedIn() ? myProfile()?.campus : browseCampus();
  return c ? `UPES ${c.name.replace(/ Campus$/, '')}` : 'UPES';
};
const campusOpen = () => !browseCampus() || browseCampus().available;
const prettyPhone = (p) => String(p || '').replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2');

let poll = null;
function go(route, params = {}) {
  if (NEEDS_ACCOUNT.includes(route) && !signedIn()) {
    S.auth.next = { route, params };
    route = 'welcome'; params = {};
    toast('Sign in to continue', 'bad');
  }
  /* Ordering needs a complete profile. The server enforces it; this sends the
     student to the screen that fixes it instead of to a refusal. */
  if (['checkout', 'join'].includes(route) && profileIncomplete()) {
    S.setupNext = { route, params };
    route = 'setup'; params = {};
  }
  clearInterval(poll); poll = null;
  /* Open/closed and availability change during the day; show today's, not
     whatever was true when the tab was first opened. */
  if (['home', 'cafes', 'welcome'].includes(route)) drop('vendors');
  if (route === 'menu' && params.caf) drop(`menu:${params.caf}`);
  if (['join', 'profile', 'partner'].includes(route)) { drop('me'); S.joinError = ''; }
  if (route === 'partner') drop('partner');
  S.route = route; S.params = params; S.sheet = null;
  if (route === 'tracking') {
    /* The order advances on the server. Re-read it, never simulate it. */
    poll = setInterval(() => { drop(`order:${S.params.id}`); render(); }, 15000);
  }
  render(true);
}
function setSheet(name, params = {}) { S.sheet = name ? { name, ...params } : null; render(); }
function toast(msg, tone = 'ok') {
  S.toast = { msg, icon: tone === 'bad' ? Ico(I.warn, 16) : Ico(I.check, 14) }; render();
  setTimeout(() => { if (S.toast && S.toast.msg === msg) { S.toast = null; render(); } }, 2400);
}

/* ===================== data cache ======================================= */
const cache = {};
const inflight = {};
function need(key, loader) {
  if (key in cache) return cache[key];
  if (!inflight[key]) {
    inflight[key] = loader()
      .then((v) => { cache[key] = { ok: true, v }; }, (e) => { cache[key] = { ok: false, e }; })
      .finally(() => { delete inflight[key]; render(); });
  }
  return null;
}
const drop = (...keys) => keys.forEach((k) => delete cache[k]);

function explain(e) {
  if (e instanceof Offline) return `Cannot reach the ${BRAND} server.`;
  if (e instanceof ApiError) {
    if (e.isConfiguration) return `${e.message} — ${e.detail || 'not configured on the server.'}`;
    return e.detail ? `${e.message} — ${e.detail}` : e.message;
  }
  return e?.message || 'Something went wrong.';
}

/* ===================== view models ======================================
   Decoration only. The prototype gave each outlet a hero tint and a mark,
   and each dish a glyph; the database stores none of that, so it is derived
   here and never written anywhere. */
const TINTS = {
  frisco: ['var(--rose-100)', 'var(--rose-500)'],
  'chai-garam': ['var(--warn-bg)', 'var(--coral-500)'],
  tulips: ['var(--ok-bg)', 'var(--open-500)'],
};
const TINT_LIST = Object.values(TINTS);
function cafVM(v) {
  let h = 0;
  for (const ch of String(v.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [heroBg, markBg] = TINTS[v.slug] || TINT_LIST[h % TINT_LIST.length];
  const mark = (v.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return { ...v, heroBg, markBg, mark, open: !!(v.is_open && v.accepting), rating: ratingLabel(v.rating) };
}

/* Dishes carry no photos yet, so the tile shows the dish's monogram in the
   display face — the same treatment the cafeteria marks use. */
const dishMono = (name) => {
  const words = String(name || '?').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
};
const DishTile = (i) => `<div class="item-thumb"><span class="dish-mono">${esc(dishMono(i.name))}</span></div>`;

/* The seed menus have no categories, and categories cannot be created over
   the API, so sections are derived from each dish's own tags. Display only. */
const SECTIONS = [
  [/burger|wrap|roll|sandwich/, 'Burgers & sandwiches'], [/thali|meal|rice|curry|bread/, 'Meals'],
  [/snack|fries|side/, 'Snacks & sides'], [/beverage|tea|coffee|shake|cold|drink/, 'Drinks'],
  [/dessert|sweet/, 'Desserts'],
];
const sectionFor = (m) => {
  if (m.category) return m.category;
  const tags = (m.tags || []).join(' ').toLowerCase();
  return (SECTIONS.find(([re]) => re.test(tags)) || [null, 'Menu'])[1];
};

const placeGlyph = () => Ico(I.pin, 20);

const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const firstName = () => (S.me?.user?.name || '').split(/\s+/)[0] || 'there';

/* ===================== cart ============================================= */
const cartCount = () => S.cart.reduce((a, l) => a + l.qty, 0);
const cartSubtotal = () => S.cart.reduce((a, l) => a + l.pricePaise * l.qty, 0);
function addToCart(it, vendor, { replace = false } = {}) {
  /* An order comes from one cafeteria. Adding from another would silently
     throw away what is in the cart, so ask first. */
  if (S.cart.length && S.cart[0].vendorId !== vendor.id) {
    if (!replace) return setSheet('newcart', { item: it, vendor });
    S.cart = [];
  }
  const ex = S.cart.find((l) => l.itemId === it.id);
  if (ex) ex.qty += 1;
  else S.cart.push({ itemId: it.id, qty: 1, name: it.name, pricePaise: it.price_paise,
                     veg: it.veg, vendorId: vendor.id, vendorName: vendor.name });
  toast(`${it.name} added`);
}
function bump(idx, d) {
  const l = S.cart[idx]; if (!l) return;
  l.qty += d; if (l.qty <= 0) S.cart.splice(idx, 1);
  render();
}

/* ===================== shared components ================================ */
const Label = (t) => `<div class="t-label">${esc(t)}</div>`;

const TopBar = (title, { back = null, right = '', bordered = false, sub = '' } = {}) => `
  <div class="topbar ${bordered ? 'bordered' : ''}">
    ${back ? `<button class="backbtn" data-act="${back.act || 'go'}" data-route="${back.route || back}" aria-label="Back">${I.back}</button>` : ''}
    <div class="grow">
      <div class="t-h2 truncate">${esc(title)}</div>
      ${sub ? `<div class="t-xs muted truncate">${esc(sub)}</div>` : ''}
    </div>
    ${right}
  </div>`;

const Loading = (label = 'Loading') => `
  <div class="empty"><div class="skel" style="width:180px;height:14px"></div>
  <p class="t-sm muted">${esc(label)}…</p></div>`;

const Problem = (e) => `
  <div class="empty">
    <div class="empty-art">${Ico(I.warn, 34)}</div>
    <div class="t-h2">${esc(e instanceof ApiError && e.isConfiguration ? e.message
      : e instanceof Offline ? `Cannot reach the ${BRAND} server` : e?.message || 'Something went wrong')}</div>
    ${e?.detail ? `<p class="t-sm muted">${esc(e.detail)}</p>` : ''}
    ${e instanceof ApiError && e.isConfiguration
      ? `<p class="t-xs faint">This is a server configuration issue, not something you did.</p>` : ''}
  </div>`;

const NotConfigured = (title, body) => `
  <div class="campusnote">${Ico(I.cog, 18)}<div class="stack g1">
    <div class="t-h3">${esc(title)}</div>
    <p class="t-xs" style="color:var(--text-2)">${esc(body)}</p></div></div>`;

const LocLine = () => `
  <button class="row g1 t-sm" data-act="sheet" data-sheet="location" style="font-weight:700;color:var(--accent-text)">
    ${I.pin}<span>${S.destination ? esc(S.destination.name) : 'Choose a campus spot'}</span>${I.chev}</button>`;

const CafCard = (c) => `
  <button class="cafcard ${c.open ? '' : 'closed'}" data-act="menu" data-caf="${c.id}">
    <div class="cafcard-hero" style="background:${c.heroBg}">
      <span class="wm">${esc(c.name.toUpperCase())}</span>
      <div class="cafmark" style="background:${c.markBg}">${esc(c.mark)}</div>
    </div>
    <div class="between" style="align-items:flex-start">
      <div class="grow">
        <div class="t-h2">${esc(c.name)}</div>
        <div class="t-xs muted">${esc(c.kind || 'Campus outlet')}</div>
      </div>
      ${StatusPill(c.open)}
    </div>
    <div class="row g3 t-xs muted" style="margin-top:10px;flex-wrap:wrap">
      ${c.rating.empty ? '<span>No ratings yet</span>'
        : `<span class="row g1">${I.star}<b style="color:var(--text)">${c.rating.text}</b> (${c.rating.count})</span>`}
      ${c.prep_minutes ? `<span>~${c.prep_minutes} min prep</span>` : ''}
    </div>
  </button>`;

const ItemRow = (m, vendor) => {
  const inCart = S.cart.filter((l) => l.itemId === m.id).reduce((a, l) => a + l.qty, 0);
  const available = m.available !== false;
  const rating = ratingLabel(m.rating);
  return `
  <div class="item ${available ? '' : 'unavailable'}">
    <div class="grow item-main">
      <div class="row g2" style="margin-bottom:3px">${m.veg === null || m.veg === undefined ? '' : VegMark(m.veg)}
        ${!available ? '<span class="badge badge-closed">Unavailable</span>' : ''}
      </div>
      <div class="t-h3">${esc(m.name)}</div>
      <div class="money t-body" style="margin:2px 0 4px">${money(m.price_paise)}</div>
      ${m.description ? `<div class="t-xs muted">${esc(m.description)}</div>` : ''}
      <div class="t-xs faint">${m.prep_minutes ? `${m.prep_minutes} min · ` : ''}${rating.empty ? 'No ratings yet' : `★ ${rating.text} (${rating.count})`}</div>
      ${!available ? `<div class="t-xs" style="color:var(--warn);margin-top:6px">The counter has marked this out of stock.</div>` : ''}
    </div>
    <div class="item-thumbwrap">
      ${DishTile(m)}
      ${!available
        ? `<span class="item-add" style="border-color:var(--line-strong);color:var(--text-faint)">Sold out</span>`
        : !vendor.open
          ? `<span class="item-add" style="border-color:var(--line-strong);color:var(--text-faint)">Closed</span>`
          : inCart
            ? `<div class="qty" style="position:absolute;bottom:-10px;left:50%;transform:translateX(-50%)"><button data-act="step" data-item="${m.id}" data-d="-1" aria-label="Remove one">−</button><span>${inCart}</span><button data-act="step" data-item="${m.id}" data-d="1" aria-label="Add one">+</button></div>`
            : `<button class="item-add" data-act="add" data-item="${m.id}">ADD +</button>`}
    </div>
  </div>`;
};

/* On wide screens the cart sits beside the menu instead of in a bottom bar:
   the same lines and controls as the cart screen. */
const CartSummary = () => S.cart.length ? `
  <div class="card card-pad stack g3">
    <div class="between">${Label('Your cart')}<span class="t-xs muted">${esc(S.cart[0].vendorName)}</span></div>
    ${S.cart.map((l, i) => `
      <div class="row g3">
        <div class="grow"><div class="t-sm" style="font-weight:700">${esc(l.name)}</div>
          <div class="t-xs muted">${money(l.pricePaise)} each</div></div>
        <div class="qty"><button data-act="bump" data-i="${i}" data-d="-1" aria-label="Remove one">−</button><span>${l.qty}</span><button data-act="bump" data-i="${i}" data-d="1" aria-label="Add one">+</button></div>
      </div>`).join('')}
    <hr class="dashline" style="margin-block:2px">
    <div class="between"><span class="t-sm muted">Item total</span><span class="money">${money(cartSubtotal())}</span></div>
    <button class="btn btn-primary btn-block" data-act="go" data-route="cart">View cart ${I.chev}</button>
  </div>` : `
  <div class="card card-pad stack g2 center" style="align-items:center">
    <div class="empty-art" style="width:64px;height:64px">${Ico(I.cart, 26)}</div>
    <div class="t-h3">Your cart is empty</div>
    <p class="t-xs muted">Add something from the menu and it shows up here.</p>
  </div>`;

const CartBar = () => `<div class="actionbar cart-mobile">
    <button class="cartbar" data-act="go" data-route="cart" style="width:100%;text-align:left">
      <span class="badge" style="background:var(--accent);color:var(--text-on-rose)">${cartCount()}</span>
      <div class="grow"><div class="t-sm" style="font-weight:700">View cart</div>
      <div class="t-xs" style="opacity:.7">${esc(S.cart[0]?.vendorName || '')}</div></div>
      <span class="money">${money(cartSubtotal())}</span>${I.chev}
    </button>
  </div>`;

const BottomNav = () => {
  const at = (r) => (S.route === r ? 'aria-current="page"' : '');
  return `<nav class="bottomnav">
    <button class="navbtn" ${at('home')} data-act="go" data-route="home">${I.home}<span>Home</span></button>
    <button class="navbtn" ${at('cafes')} data-act="go" data-route="cafes">${I.grid}<span>Cafés</span></button>
    <button class="nav-ai" ${at('ai')} data-act="go" data-route="ai" aria-label="Ask ${BRAND}">${I.ask}</button>
    <button class="navbtn" ${at('orders')} data-act="go" data-route="orders">${I.receipt}<span>Orders</span></button>
    <button class="navbtn" ${at('profile')} data-act="go" data-route="profile">${I.user}<span>You</span></button>
  </nav>`;
};

/* ===================== STUDENT: welcome + sign-in ======================= */
function ScrWelcome() {
  const vs = need('vendors', loadVendors);
  const open = vs?.ok ? vs.v.vendors.filter((v) => v.is_open && v.accepting).length : null;
  return `<div class="screen no-nav welcome" style="display:flex;flex-direction:column">
    <div class="poster poster-grid" style="border-radius:0;flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding:var(--s-6) var(--s-5) var(--s-7)">
      <div class="poster-arc" style="width:230px;height:230px;top:-70px;right:-70px"></div>
      <div class="poster-arc" style="width:120px;height:120px;top:110px;left:-50px;background:var(--coral-400);opacity:.28"></div>
      <div class="stack g5 enter">
        <div class="row g2"><div class="cafmark" style="background:var(--surface-ink);width:40px;height:40px;border-radius:12px;font-size:1rem">E.</div>
          <span class="t-label" style="color:var(--text-2)">${BRAND} · UPES Bidholi</span></div>
        <h1 class="t-hero">Food from your campus.<br>Brought to wherever<br>you <em style="font-style:normal;color:var(--accent-text)">actually are</em>.</h1>
        <p class="t-body" style="color:var(--text-2);max-width:30ch">Library, ground, school blocks. Order from campus cafés, delivered by students between classes.</p>
        <div class="row g2" style="flex-wrap:wrap">
          <span class="sticker">Campus only</span>
          ${open === null ? '' : `<span class="badge badge-rose">${open} café${open === 1 ? '' : 's'} open now</span>`}
        </div>
      </div>
    </div>
    <div class="pad stack g3 welcome-cta" style="padding-block:var(--s-5) var(--s-6);background:var(--bg)">
      <div class="stack g1 only-lg" style="margin-bottom:var(--s-2)">
        <div class="t-h1">Order in two minutes</div>
        <p class="t-sm muted">Sign in with your university student email, or look around the menus first.</p>
      </div>
      <button class="btn btn-primary btn-lg btn-block" data-act="go" data-route="ob-email">Continue with your student email</button>
      <button class="btn btn-ghost btn-block" data-act="go" data-route="cafes">Browse cafés first</button>
      <p class="t-xs faint center">Only verified students can order. That's the whole point.</p>
    </div>
  </div>`;
}

/* The zero-cost student sign-in. The code goes to the university mailbox;
   receiving it is the proof. Only the exact student domain is accepted, and
   the server — not this form — enforces that. */
const studentDomains = () => S.providers?.student_email?.domains || ['stu.upes.ac.in'];

function ScrObEmail() {
  const a = S.auth;
  const emailOff = S.providers && !S.providers.student_email?.configured;
  const smsOn = S.providers?.otp?.configured;
  return `<div class="screen no-nav narrow">
    ${TopBar('', { back: 'welcome' })}
    <form class="pad stack g5 enter" data-form="email" style="padding-top:var(--s-3)">
      <div class="stack g2">
        ${Label('Step 1 of 2 · Student email')}
        <h1 class="t-display">What's your<br>student email?</h1>
        <p class="t-sm muted">We email a 6-digit code to your university mailbox. No password, no SMS.</p>
      </div>
      <div class="field">
        <label class="t-label" for="ob-em">University student email</label>
        <input class="input" id="ob-em" name="email" type="email" inputmode="email" autocomplete="email"
               autocapitalize="none" spellcheck="false" maxlength="254"
               placeholder="name.12345@${esc(studentDomains()[0])}" value="${esc(a.email || '')}">
        <p class="t-xs faint">Only @${esc(studentDomains().join(' or @'))} addresses can be verified.</p>
      </div>
      ${a.error ? `<p class="t-xs" style="color:var(--danger)">${esc(a.error)}</p>` : ''}
      ${emailOff
        ? NotConfigured('Student email sign-in is not available',
            'No email provider is configured on this server, so a code cannot be sent yet.')
        : `<button class="btn btn-primary btn-lg btn-block" type="submit">Email me a code</button>`}
      ${smsOn ? `<button class="btn btn-ghost btn-block t-sm" type="button" data-act="go" data-route="ob-phone">Use my phone number instead</button>` : ''}
      <button class="btn btn-ghost btn-block t-sm" type="button" data-act="go" data-route="ob-enrol">Staff sign-in with an enrolment code</button>
      <div class="campusnote">
        ${Ico(I.lock, 18)}
        <p class="t-xs" style="color:var(--text-2)">Receiving the code in your university mailbox is what proves you are a current student. ${BRAND} never asks for your mailbox password.</p>
      </div>
    </form>
  </div>`;
}

function ScrObEmailCode() {
  const a = S.auth;
  return `<div class="screen no-nav narrow">
    ${TopBar('', { back: 'ob-email' })}
    <form class="pad stack g5 enter" data-form="emailcode" style="padding-top:var(--s-3)">
      <div class="stack g2">
        ${Label('Step 2 of 2 · Verify')}
        <h1 class="t-display">Check your<br>university inbox.</h1>
        <p class="t-sm muted">Code sent to <b class="code" style="color:var(--text)">${esc(a.email)}</b>. It expires in 10 minutes. Check Junk if you don't see it.</p>
      </div>
      <div class="otp">${[0, 1, 2, 3, 4, 5].map((i) =>
        `<input inputmode="numeric" maxlength="1" aria-label="Digit ${i + 1}" data-otp="${i}">`).join('')}</div>
      ${a.error ? `<p class="t-xs" style="color:var(--danger)">${esc(a.error)}</p>` : ''}
      <button class="btn btn-primary btn-lg btn-block" type="submit">Verify &amp; continue</button>
      <button class="btn btn-ghost btn-block t-sm" type="button" data-act="resendEmail">Send a new code</button>
    </form>
  </div>`;
}

function ScrObPhone() {
  const a = S.auth;
  const smsOff = S.providers && !S.providers.otp?.configured;
  return `<div class="screen no-nav narrow">
    ${TopBar('', { back: 'ob-email' })}
    <form class="pad stack g5 enter" data-form="phone" style="padding-top:var(--s-3)">
      <div class="stack g2">
        ${Label('Step 1 of 2 · Identity')}
        <h1 class="t-display">What's your<br>mobile number?</h1>
        <p class="t-sm muted">We text a 6-digit code. No password to forget.</p>
      </div>
      <div class="field">
        <label class="t-label" for="ob-ph">Mobile number</label>
        <input class="input" id="ob-ph" name="phone" inputmode="numeric" maxlength="10"
               autocomplete="tel" placeholder="10-digit number" value="${esc(a.phone)}">
        <p class="t-xs faint">India (+91)</p>
      </div>
      ${a.error ? `<p class="t-xs" style="color:var(--danger)">${esc(a.error)}</p>` : ''}
      ${smsOff
        ? NotConfigured('Text-message sign-in is not available',
            'No SMS provider is configured on this server, so a code cannot be sent. ' +
            'Students can sign in once it is set up. Cafeteria and campus staff can use an enrolment code from an administrator.')
        : `<button class="btn btn-primary btn-lg btn-block" type="submit">Send code</button>`}
      <button class="btn btn-ghost btn-block t-sm" type="button" data-act="go" data-route="ob-enrol">Staff sign-in with an enrolment code</button>
      <div class="campusnote">
        ${Ico(I.lock, 18)}
        <p class="t-xs" style="color:var(--text-2)">Every account must verify student status before it can order. This is what keeps ${BRAND} a closed campus network — and what makes every order accountable to a real student.</p>
      </div>
    </form>
  </div>`;
}

function ScrObOtp() {
  const a = S.auth;
  return `<div class="screen no-nav narrow">
    ${TopBar('', { back: 'ob-phone' })}
    <form class="pad stack g5 enter" data-form="otp" style="padding-top:var(--s-3)">
      <div class="stack g2">
        ${Label('Step 2 of 2 · Verify')}
        <h1 class="t-display">Check your<br>messages.</h1>
        <p class="t-sm muted">Code sent to <b class="code" style="color:var(--text)">+91 ${esc(a.phone)}</b></p>
      </div>
      <div class="otp">${[0, 1, 2, 3, 4, 5].map((i) =>
        `<input inputmode="numeric" maxlength="1" aria-label="Digit ${i + 1}" data-otp="${i}">`).join('')}</div>
      ${a.error ? `<p class="t-xs" style="color:var(--danger)">${esc(a.error)}</p>` : ''}
      <button class="btn btn-primary btn-lg btn-block" type="submit">Verify &amp; continue</button>
      <button class="btn btn-ghost btn-block t-sm" type="button" data-act="resendOtp">Send a new code</button>
    </form>
  </div>`;
}

function ScrObEnrol() {
  const a = S.auth;
  return `<div class="screen no-nav narrow">
    ${TopBar('', { back: 'ob-email' })}
    <form class="pad stack g5 enter" data-form="enrol" style="padding-top:var(--s-3)">
      <div class="stack g2">
        ${Label('Sign in · Enrolment code')}
        <h1 class="t-display">Enter the code<br>you were given.</h1>
        <p class="t-sm muted">An administrator issues these. Each works once and expires.</p>
      </div>
      <div class="field">
        <label class="t-label" for="en-ph">Mobile number</label>
        <input class="input" id="en-ph" name="phone" inputmode="numeric" maxlength="10"
               autocomplete="tel" placeholder="10-digit number" value="${esc(a.phone)}">
      </div>
      <div class="field">
        <label class="t-label" for="en-code">Enrolment code</label>
        <input class="input code" id="en-code" name="code" maxlength="14" autocomplete="one-time-code"
               placeholder="XXXX-XXXX-XXXX" style="text-transform:uppercase;letter-spacing:.12em">
      </div>
      ${a.error ? `<p class="t-xs" style="color:var(--danger)">${esc(a.error)}</p>` : ''}
      <button class="btn btn-primary btn-lg btn-block" type="submit">Sign in</button>
    </form>
  </div>`;
}

/* ===================== STUDENT: profile completion ======================
   Three short steps, each showing what the server already knows so nothing
   is typed twice. Completion is whatever GET /me/profile says, never a flag
   this screen sets. */
const loadVendors = () => quad.vendors({ campusId: browseCampus()?.id });

function ScrSetup() {
  const p = myProfile();
  if (!p) return `<div class="screen no-nav narrow">${Loading('Loading your profile')}</div>`;
  const st = S.setup;
  const campuses = S.campuses || [];
  const chosen = st.campusId || p.campus?.id || '';
  const chosenCampus = campuses.find((c) => c.id === chosen);
  const college = campuses[0]?.collegeName?.replace(' - ', ' — ') || COLLEGE();
  const step = (n, title, done) => `<div class="row g2">
      <span class="avatar avatar-sm" style="width:24px;height:24px;font-size:.7rem;${done ? 'background:var(--accent);color:var(--text-on-rose)' : ''}">${done ? I.check : n}</span>
      <span class="t-label" style="color:var(--text)">${esc(title)}</span></div>`;
  return `<div class="screen no-nav narrow">
    ${TopBar('', { back: signedIn() && p.complete ? 'profile' : 'welcome' })}
    <form class="pad stack g5 enter" data-form="setup" style="padding-top:var(--s-2)">
      <div class="stack g2">
        ${Label('Almost done')}
        <h1 class="t-display">Set up your<br>profile.</h1>
        <p class="t-sm muted">Campus admin and your delivery partner use these details to reach you about an order.</p>
      </div>

      <div class="card card-pad stack g3">
        ${step(1, 'Student email', p.studentEmailVerified || p.verifiedByAdmin)}
        ${p.studentEmailVerified
          ? `<div class="row g2"><span class="t-sm" style="font-weight:700;word-break:break-all">${esc(p.studentEmail)}</span>
               <span class="badge badge-open">${I.check} Verified</span></div>`
          : p.verifiedByAdmin
            ? `<p class="t-sm muted">Your student status was verified by campus admin.</p>`
            : `<p class="t-sm muted">Verify your university student email first.</p>
               <button class="btn btn-secondary btn-sm" type="button" data-act="go" data-route="verify" style="align-self:flex-start">Verify my student email</button>`}
      </div>

      <div class="card card-pad stack g3">
        ${step(2, 'About you', !p.missing.includes('name') && !p.missing.includes('contact_phone'))}
        <div class="field"><label class="t-label" for="su-name">Full name</label>
          <input class="input" id="su-name" name="name" autocomplete="name" maxlength="80" required
                 value="${esc(st.name ?? p.name ?? '')}" placeholder="As in university records"></div>
        <div class="field"><label class="t-label" for="su-phone">Contact number</label>
          <input class="input" id="su-phone" name="contactPhone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="14" required
                 value="${esc(st.contactPhone ?? (p.contactPhone || '').replace(/^\+91/, ''))}" placeholder="10-digit mobile number">
          <p class="t-xs faint">For order updates and the payment gateway. It is not used to sign in.</p></div>
      </div>

      <div class="card card-pad stack g3">
        ${step(3, 'Your campus', !!chosen)}
        <div class="t-h3">${esc(college)}</div>
        ${campuses.length ? `<div class="stack g2" role="radiogroup" aria-label="Campus">
          ${campuses.map((c) => `
            <button type="button" class="loccard" role="radio" data-act="pickCampus" data-id="${c.id}"
                    aria-pressed="${c.id === chosen}" aria-checked="${c.id === chosen}" style="width:100%;text-align:left">
              <span class="row g2" style="justify-content:space-between;width:100%">
                <span class="t-h3">${esc(c.name)}</span>
                <span class="badge ${c.available ? 'badge-open' : 'badge-closed'}">${c.available ? 'Available' : 'Coming soon'}</span>
              </span>
              ${c.available ? '' : `<span class="t-xs muted">${esc(c.message)}</span>`}
            </button>`).join('')}
        </div>` : Loading('Loading campuses')}
        ${chosenCampus && !chosenCampus.available ? `<div class="campusnote">${Ico(I.clock, 18)}<p class="t-xs" style="color:var(--text-2)">
          <b>${esc(chosenCampus.message)}</b> ${BRAND} is not available at ${esc(chosenCampus.name)} yet, so you will not be able to order. You can still save it as your campus.</p></div>` : ''}
      </div>

      ${st.error ? `<p class="t-sm" role="alert" style="color:var(--danger)">${esc(st.error)}</p>` : ''}
      <button class="btn btn-primary btn-lg btn-block" type="submit">Save and continue</button>
    </form>
  </div>`;
}

/* The home and cafés screens for a campus where the service has not started. */
const ComingSoon = (c) => `
  <div class="card card-pad stack g3" style="text-align:left">
    <div class="t-label">${esc(COLLEGE())}</div>
    <div class="t-h1">${esc(c.name)}</div>
    <div class="campusnote">${Ico(I.clock, 18)}<div class="stack g1">
      <div class="t-h3">${esc(c.message || `Service coming soon for ${c.name}.`)}</div>
      <p class="t-xs" style="color:var(--text-2)">${BRAND} is not available on this campus yet. There are no cafés or deliveries here, and ordering is closed.</p></div></div>
    <button class="btn btn-secondary btn-sm" data-act="go" data-route="setup" style="align-self:flex-start">Change campus</button>
  </div>`;

/* ===================== STUDENT: home ==================================== */
const LIVE = ['confirmed', 'preparing', 'ready', 'assigned', 'picked_up'];

function ScrHome() {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const vs = need('vendors', loadVendors);
  const os = signedIn() ? need('orders', () => quad.orders({ scope: 'own' })) : null;
  const orders = os?.ok ? os.v.orders : [];
  const active = orders.filter((o) => LIVE.includes(o.state));
  const earlier = orders.filter((o) => o.state === 'delivered').slice(0, 2);
  const cafs = vs?.ok ? vs.v.vendors.map(cafVM) : [];

  return `<div class="screen">
    <div class="topbar">
      <div class="grow stack">
        <div class="t-xs muted">${greet}${signedIn() ? `, ${esc(firstName())}` : ''}</div>
        ${campusOpen() ? LocLine() : `<span class="t-sm" style="font-weight:700">${esc(browseCampus().name)}</span>`}
      </div>
      ${signedIn()
        ? `<button class="avatar avatar-sm hide-lg" data-act="go" data-route="profile" aria-label="Profile">${esc(initials(S.me.user.name))}</button>`
        : `<button class="btn btn-secondary btn-sm hide-lg" data-act="go" data-route="ob-email">Sign in</button>`}
    </div>

    <div class="pad stack g5 enter">
      ${profileIncomplete() ? `<button class="tile row g3" data-act="go" data-route="setup" style="width:100%;text-align:left;background:var(--warn-bg);border-color:transparent">
        ${Ico(I.user, 22)}<div class="grow"><div class="t-h3">Finish setting up your profile</div>
        <div class="t-xs muted">Add ${esc(myProfile().missing.map((m) => ({ name: 'your name', student_email: 'your student email', contact_phone: 'a contact number', campus: 'your campus' })[m]).join(', '))} to start ordering.</div></div>${I.chev}</button>` : ''}
      ${active.length ? `<div class="livegrid">${active.map(ActiveOrderCard).join('')}</div>` : ''}

      ${campusOpen() ? `<button class="poster poster-grid" data-act="go" data-route="ai" style="text-align:left;width:100%;border:0;padding:var(--s-5);cursor:pointer">
        <div class="poster-arc" style="width:150px;height:150px;bottom:-70px;right:-40px"></div>
        <div class="stack g3">
          <div class="row g2"><span class="ai-mark">E.</span><span class="t-label">Ask ${BRAND}</span></div>
          <div class="t-display" style="font-size:1.72rem">Tell ${BRAND}<br>what you want.</div>
          <p class="t-sm" style="color:var(--text-2)">“Ground pe 2 cold coffee aur ek burger bhej do” — it reads Hinglish, builds the order, you confirm.</p>
          <span class="btn btn-ink btn-sm btn-pill" style="align-self:flex-start;margin-top:2px">Start ordering ${I.chev}</span>
        </div>
      </button>` : ''}

      <div class="stack g3">
        ${browseCampus() && !browseCampus().available ? ComingSoon(browseCampus()) : `
        <div class="between">${Label(`Cafés · ${browseCampus()?.name || 'Campus'}`)}<button class="t-xs" data-act="go" data-route="cafes" style="color:var(--accent-text);font-weight:700">See all</button></div>
        ${!vs ? Loading('Loading cafés') : !vs.ok ? Problem(vs.e)
          : cafs.length ? `<div class="cafgrid">${cafs.map(CafCard).join('')}</div>`
          : `<div class="empty"><div class="empty-art">${Ico(I.store, 34)}</div><div class="t-h2">No cafés yet.</div>
               <p class="t-sm muted">Outlets appear here as soon as campus admin adds them.</p></div>`}`}
      </div>

      ${earlier.length ? `
      <div class="stack g3">
        ${Label('Order again')}
        <div class="stack g2">
          ${earlier.map((o) => {
            const c = cafs.find((x) => x.id === o.vendor_id) || cafVM({ id: o.vendor_id, name: o.vendor_name });
            return `<button class="tile row g3" data-act="menu" data-caf="${o.vendor_id}" style="width:100%;text-align:left">
              <div class="cafmark" style="width:38px;height:38px;border-radius:11px;font-size:.85rem;background:${c.markBg}">${esc(c.mark)}</div>
              <div class="grow"><div class="t-sm" style="font-weight:700">${esc((o.items || []).map((i) => `${i.qty}× ${i.name}`).join(', '))}</div>
              <div class="t-xs muted">${esc(o.vendor_name)} · ${when(o.created_at)}</div></div>
              <span class="money t-sm">${money(o.total_paise)}</span>
            </button>`; }).join('')}
        </div>
      </div>` : ''}

      ${campusOpen() ? `<div class="tile row g3" style="background:var(--surface-blush);border-color:transparent">
        ${Ico(I.bag, 22)}
        <div class="grow"><div class="t-h3">In a hurry? Self pickup</div>
        <div class="t-xs muted">Skip the delivery fee, collect from the counter</div></div>
        <button class="btn btn-secondary btn-sm" data-act="pickupMode">Pick up</button>
      </div>` : ''}
    </div>
  </div>`;
}

const ORDER_LABEL = {
  draft: 'Draft', awaiting_payment: 'Awaiting payment', confirmed: 'Order confirmed',
  preparing: 'Preparing', ready: 'Ready', assigned: 'Partner assigned',
  picked_up: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded',
};

function stagesFor(fulfilment) {
  return fulfilment === 'pickup'
    ? [['confirmed', 'Order confirmed', 'Payment confirmed · sent to the counter'],
       ['preparing', 'Preparing', 'On the counter now'],
       ['ready', 'Ready for pickup', 'Collect from the counter'],
       ['delivered', 'Collected', 'Enjoy your meal']]
    : [['confirmed', 'Order confirmed', 'Payment confirmed · sent to the counter'],
       ['preparing', 'Preparing', 'On the counter now'],
       ['ready', 'Ready', 'Packed and waiting'],
       ['assigned', 'Partner assigned', 'A campus partner is picking it up'],
       ['picked_up', 'On the way', 'Collected from the counter with its code'],
       ['delivered', 'Delivered', 'Enjoy your meal']];
}

function ActiveOrderCard(o) {
  const stages = stagesFor(o.fulfilment);
  const idx = Math.max(0, stages.findIndex(([s]) => s === o.state));
  return `<button class="card card-raise card-pad stack g3" data-act="track" data-id="${o.id}" style="width:100%;text-align:left;background:var(--surface-ink);color:var(--text-on-ink);border:0">
    <div class="between">
      <span class="badge" style="background:rgba(255,255,255,.14);color:var(--text-on-ink)"><i class="dot dot-live"></i>Live order</span>
      <span class="code t-xs" style="opacity:.7">#${esc(o.code)}</span>
    </div>
    <div class="t-h2">${esc(stages[idx][1])}</div>
    <div class="t-xs" style="opacity:.72">${esc(o.vendor_name)} → ${o.fulfilment === 'delivery' ? 'Campus delivery' : 'Self pickup'}</div>
    <div class="row g1" style="margin-top:2px">
      ${stages.map((_, i) => `<i style="height:3px;flex:1;border-radius:2px;background:${i <= idx ? 'var(--accent)' : 'rgba(255,255,255,.2)'}"></i>`).join('')}
    </div>
  </button>`;
}

/* ===================== STUDENT: cafés + menu ============================ */
function ScrCafes() {
  const vs = need('vendors', loadVendors);
  const cafs = vs?.ok ? vs.v.vendors.map(cafVM) : [];
  const open = cafs.filter((c) => c.open).length;
  const campus = browseCampus();
  if (campus && !campus.available) {
    return `<div class="screen">${TopBar('Campus cafés')}<div class="pad stack g4 enter">${ComingSoon(campus)}</div></div>`;
  }
  return `<div class="screen">
    ${TopBar('Campus cafés', { sub: vs?.ok ? `${open} of ${cafs.length} open now` : '' })}
    <div class="pad stack g4 enter">
      <div class="poster" style="padding:var(--s-5)">
        <div class="poster-arc" style="width:140px;height:140px;top:-50px;right:-40px"></div>
        <div class="t-label">${esc(COLLEGE())}</div>
        <div class="t-display" style="font-size:1.5rem;margin-top:6px">${esc(campus?.name || 'Campus')}</div>
        <div class="row g2" style="margin-top:12px;flex-wrap:wrap">
          ${S.fulfilment === 'pickup' ? '<span class="badge badge-ink">Self pickup</span>' : '<span class="badge badge-ink">Campus delivery</span>'}
          ${vs?.ok ? `<span class="badge badge-rose">${cafs.length} café${cafs.length === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>
      ${!vs ? Loading('Loading cafés') : !vs.ok ? Problem(vs.e)
        : cafs.length ? `<div class="cafgrid">${cafs.map(CafCard).join('')}</div>`
        : `<div class="empty"><div class="empty-art">${Ico(I.store, 34)}</div><div class="t-h2">No cafés yet.</div>
             <p class="t-sm muted">Outlets appear here as soon as campus admin adds them.</p></div>`}
    </div>
  </div>`;
}

function ScrMenu() {
  const id = S.params.caf;
  const r = need(`menu:${id}`, () => quad.menu(id));
  if (!r) return `<div class="screen">${TopBar('', { back: 'cafes' })}${Loading('Loading menu')}</div>`;
  if (!r.ok) return `<div class="screen">${TopBar('', { back: 'cafes' })}${Problem(r.e)}</div>`;
  const c = cafVM(r.v.vendor);
  const items = r.v.items || [];
  const cats = [...new Set(items.map(sectionFor))];
  const count = cartCount();
  return `<div class="screen">
    <!-- The hero tint is a light primitive in both themes, so its text is
         pinned to ink rather than following the theme's text colour. -->
    <div class="poster hero-band" style="border-radius:0;background:${c.heroBg};color:var(--ink-900);padding:var(--s-4) var(--s-4) var(--s-5)">
      <div class="row g3" style="margin-bottom:var(--s-4)">
        <button class="backbtn" data-act="go" data-route="cafes" aria-label="Back">${I.back}</button>
      </div>
      <span class="wm" style="position:absolute;right:-8px;top:36px;font-family:var(--font-display);font-weight:800;font-size:5rem;opacity:.14;letter-spacing:-.05em;color:var(--ink-900)">${esc(c.name.toUpperCase())}</span>
      <div class="row g3">
        <div class="cafmark" style="background:${c.markBg}">${esc(c.mark)}</div>
        <div class="grow">
          <div class="t-h1" style="color:var(--ink-900)">${esc(c.name)}</div>
          <div class="t-xs" style="color:var(--ink-700)">${esc(c.kind || 'Campus outlet')}</div>
        </div>
      </div>
      <div class="row g3 t-xs" style="margin-top:var(--s-4);flex-wrap:wrap;color:var(--ink-700)">
        ${StatusPill(c.open)}
        ${c.rating.empty ? '<span>No ratings yet</span>' : `<span class="row g1">${I.star}<b>${c.rating.text}</b></span>`}
        ${c.prep_minutes ? `<span>~${c.prep_minutes} min</span>` : ''}
      </div>
    </div>

    ${cats.length > 1 ? `<div class="chiprow" style="padding-block:var(--s-4)">
      ${cats.map((cat, i) => `<button class="chip" data-act="jumpcat" data-cat="${i}" ${i === 0 ? 'aria-pressed="true"' : ''}>${esc(cat)}</button>`).join('')}
    </div>` : '<div style="height:var(--s-4)"></div>'}

    <div class="pad site-split">
    <div class="stack g5">
      ${!c.open ? `<div class="campusnote">${Ico(I.clock, 18)}<p class="t-xs" style="color:var(--text-2)">${esc(c.name)} is closed right now. You can look through the menu, but not order.</p></div>` : ''}
      ${items.length ? cats.map((cat, i) => `
        <div class="stack g1" id="cat-${i}">
          ${Label(cat)}
          <div class="menugrid">${items.filter((m) => sectionFor(m) === cat).map((m) => ItemRow(m, c)).join('')}</div>
        </div>`).join('')
        : `<div class="empty"><div class="empty-art">${Ico(I.plate, 34)}</div><div class="t-h2">No menu published yet.</div>
             <p class="t-sm muted">${esc(c.name)} has not added any items. Check back later.</p></div>`}
    </div>
    <aside class="only-lg">${CartSummary()}</aside>
    </div>

    ${count ? CartBar() : ''}
  </div>`;
}

/* ===================== STUDENT: cart / checkout ========================= */
function ScrCart() {
  if (!S.cart.length) {
    return `<div class="screen">${TopBar('Your cart', { back: 'home' })}
      <div class="empty">
        <div class="empty-art">${Ico(I.cart, 34)}</div>
        <div class="t-h2">Nothing here yet.</div>
        <p class="t-sm muted">Pick a café, or just tell ${BRAND} what you're craving.</p>
        <div class="row g2" style="margin-top:8px">
          <button class="btn btn-secondary btn-sm" data-act="go" data-route="cafes">Browse cafés</button>
          <button class="btn btn-primary btn-sm" data-act="go" data-route="ai">Ask ${BRAND}</button>
        </div>
      </div></div>`;
  }
  const vendorId = S.cart[0].vendorId;
  const vendorName = S.cart[0].vendorName;
  return `<div class="screen">
    ${TopBar('Your cart', { back: { act: 'menu', route: 'menu' }, sub: vendorName })}
    <div class="pad site-split enter">
    <div class="stack g4">
      <div class="card card-pad stack g3">
        ${S.cart.map((l, i) => `
          <div class="row g3">
            ${l.veg === null || l.veg === undefined ? '' : VegMark(l.veg)}
            <div class="grow">
              <div class="t-h3">${esc(l.name)}</div>
              <div class="t-xs muted">${money(l.pricePaise)} each</div>
            </div>
            <div class="qty"><button data-act="bump" data-i="${i}" data-d="-1" aria-label="Remove one">−</button><span>${l.qty}</span><button data-act="bump" data-i="${i}" data-d="1" aria-label="Add one">+</button></div>
            <span class="money t-sm" style="min-width:56px;text-align:right">${money(l.pricePaise * l.qty)}</span>
          </div>`).join('')}
        <button class="btn btn-ghost btn-sm" data-act="menu" data-caf="${vendorId}" style="align-self:flex-start;padding-inline:0;color:var(--accent-text)">+ Add more from ${esc(vendorName)}</button>
      </div>

      <div class="stack g2">
        ${Label('How do you want it?')}
        <div class="row g3">
          <button class="loccard grow" data-act="setfulfil" data-f="delivery" ${S.fulfilment === 'delivery' ? 'aria-pressed="true"' : ''}>
            <span class="glyph">${Ico(I.bike, 22)}</span><span class="t-h3">Delivery</span>
            <span class="t-xs muted">Brought to you on campus</span>
          </button>
          <button class="loccard grow" data-act="setfulfil" data-f="pickup" ${S.fulfilment === 'pickup' ? 'aria-pressed="true"' : ''}>
            <span class="glyph">${Ico(I.bag, 22)}</span><span class="t-h3">Self pickup</span>
            <span class="t-xs muted">Collect at the counter</span>
          </button>
        </div>
      </div>

      ${FulfilTile(vendorName, 'Change')}
    </div>
    <aside class="stack g4">
      ${Bill()}
      <div class="actionbar">
        <button class="btn btn-primary btn-lg btn-block" data-act="go" data-route="checkout"
          ${S.fulfilment === 'delivery' && !S.destination ? 'disabled' : ''}>
          ${S.fulfilment === 'delivery' && !S.destination ? 'Choose where to deliver' : `Continue · ${money(cartSubtotal())} + fees`}</button>
      </div>
    </aside>
    </div>
  </div>`;
}

const FulfilTile = (vendorName, cta) => S.fulfilment === 'delivery' ? `
  <button class="tile row g3" data-act="sheet" data-sheet="location" style="width:100%;text-align:left">
    ${Ico(I.pin, 22)}
    <div class="grow"><div class="t-label">Deliver to</div>
    <div class="t-h3">${S.destination ? esc(S.destination.name) : 'Choose a campus spot'}</div>
    ${S.destination?.path ? `<div class="t-xs muted">${esc(S.destination.path)}</div>` : ''}</div>
    <span class="t-xs" style="color:var(--accent-text);font-weight:700">${cta}</span>
  </button>` : `
  <div class="tile row g3">
    ${Ico(I.bag, 22)}
    <div class="grow"><div class="t-label">Collect from</div>
    <div class="t-h3">${esc(vendorName)}</div></div>
  </div>`;

/* The item total is indicative: the server prices the order from the live
   menu, and delivery fee and total come from its pricing policy. */
const Bill = () => `
  <div class="card card-pad stack g2">
    ${Label('Bill')}
    <div class="between t-sm"><span class="muted">Item total</span><span class="money t-sm">${money(cartSubtotal())}</span></div>
    <div class="between t-sm"><span class="muted">${S.fulfilment === 'delivery' ? 'Campus delivery' : 'Self pickup'}</span><span class="t-sm muted">Set by the server</span></div>
    <hr class="dashline" style="margin-block:4px">
    <div class="between"><span class="t-h3">Total</span><span class="t-sm muted">Confirmed before you pay</span></div>
    <p class="t-xs faint">Priced by ${BRAND}'s server when you place the order. Item prices are frozen onto your order.</p>
  </div>`;

function ScrCheckout() {
  if (!S.cart.length) return ScrCart();
  const vendorName = S.cart[0].vendorName;
  const payReady = S.providers?.payments?.configured;
  const needsDest = S.fulfilment === 'delivery' && !S.destination;
  const verified = S.me?.user?.studentStatus === 'approved';
  return `<div class="screen">
    ${TopBar('Confirm & pay', { back: 'cart' })}
    <div class="pad site-split enter">
    <div class="stack g4">
      <div class="card card-pad stack g3">
        <div class="between">${Label('Your order')}<span class="badge badge-rose">${esc(vendorName)}</span></div>
        ${S.cart.map((l) => `<div class="between t-sm"><span>${esc(l.name)} × ${l.qty}</span><span class="money t-sm">${money(l.pricePaise * l.qty)}</span></div>`).join('')}
      </div>
      ${FulfilTile(vendorName, 'Change')}
      <div class="stack g2">
        ${Label('Payment method')}
        <div class="row g3">
          <button class="loccard grow" aria-pressed="true" disabled style="max-width:300px">
            <span class="glyph">${Ico(I.card, 22)}</span><span class="t-h3">Online Pay</span><span class="t-xs muted">UPI · cards · paid now</span></button>
        </div>
        <p class="t-xs faint">${BRAND} is prepaid only. There is no cash on delivery.</p>
        ${!payReady ? NotConfigured('Online payment is not available',
            'No payment gateway is configured on this server, so no order can be placed. ' +
            'Since there is no cash option, ordering is unavailable until it is configured.') : ''}
        ${payReady && !verified ? NotConfigured('Student verification required',
            S.me?.verificationStatus?.nextStep || 'Only verified students can place orders. Verify with your university student email from the You tab.') : ''}
      </div>
    </div>
    <aside class="stack g4">
      ${Bill()}
      <div class="actionbar">
        <button class="btn btn-primary btn-lg btn-block" data-act="placeOrder" ${payReady && !needsDest && verified ? '' : 'disabled'}>
          ${!payReady ? 'Online payment unavailable' : needsDest ? 'Choose where to deliver' : !verified ? 'Student verification required' : 'Pay & place order'}
        </button>
      </div>
    </aside>
    </div>
  </div>`;
}

/* ===================== STUDENT: tracking ================================ */
function ScrTracking() {
  const id = S.params.id;
  const r = need(`order:${id}`, () => quad.order(id));
  if (!r) return `<div class="screen">${TopBar('Order', { back: 'orders' })}${Loading('Loading order')}</div>`;
  if (!r.ok) return `<div class="screen">${TopBar('Order', { back: 'orders' })}${Problem(r.e)}</div>`;
  const { order: o, items, events, payment, partner, myReviews = [] } = r.v;
  const vs = need('vendors', loadVendors);
  const vendorName = vs?.ok ? (vs.v.vendors.find((v) => v.id === o.vendor_id)?.name || '') : '';
  const pickup = o.fulfilment === 'pickup';
  const stages = stagesFor(o.fulfilment);
  const stage = stages.findIndex(([s]) => s === o.state);
  const done = o.state === 'delivered';
  const at = (s) => events.find((e) => e.to_state === s)?.at;

  let headline;
  if (['draft', 'awaiting_payment'].includes(o.state)) {
    headline = `<div class="card card-pad stack g2" style="background:var(--warn-bg);border-color:transparent">
      <div class="t-h2">Waiting for payment</div>
      <p class="t-sm" style="color:var(--text-2)">This order is confirmed only when the payment gateway confirms the payment to our server.</p></div>`;
  } else if (['cancelled', 'refunded'].includes(o.state)) {
    headline = `<div class="card card-pad stack g2" style="background:var(--danger-bg);border-color:transparent">
      <div class="t-h2">${esc(ORDER_LABEL[o.state])}</div>
      <p class="t-sm" style="color:var(--text-2)">${o.state === 'refunded' ? 'The payment has been refunded.' : 'This order will not be prepared.'}</p></div>`;
  } else {
    headline = `<div class="card card-raise card-pad stack g3">
      <div class="between">
        <div class="stack">
          ${Label(pickup ? 'Self pickup' : 'Campus delivery')}
          <div class="t-h1">${esc(stages[Math.max(stage, 0)][1])}</div>
        </div>
        <span class="badge ${done ? 'badge-open' : 'badge-rose'}"><i class="dot ${done ? '' : 'dot-live'}"></i>${esc(ORDER_LABEL[o.state])}</span>
      </div>
      ${!pickup && ['assigned', 'picked_up'].includes(o.state) ? `
        <hr class="dashline">
        ${PartnerCard(partner, o.state === 'picked_up' ? 'is bringing your order' : 'is collecting your order')}
        <div class="sunken stack g2" style="padding:var(--s-3);margin-top:4px;align-items:center">
          ${Label('Give this code on arrival')}
          ${S.handoff[o.id]
            ? `<div class="codebox">${String(S.handoff[o.id]).split('').map((d) => `<b>${esc(d)}</b>`).join('')}</div>
               <p class="t-xs faint center">Read it to your partner when the food reaches you. It is shown once.</p>`
            : `<button class="btn btn-secondary btn-sm" data-act="handoff" data-id="${o.id}">Show my delivery code</button>`}
        </div>` : ''}
      ${pickup && o.state === 'ready' ? `
        <hr class="dashline">
        <div class="stack g2 center" style="padding-top:4px">
          ${Label('Show this at the counter')}
          <div class="codebox">${String(o.code).split('').map((d) => `<b>${esc(d)}</b>`).join('')}</div>
        </div>` : ''}
    </div>`;
  }

  return `<div class="screen">
    ${TopBar(`Order #${o.code}`, { back: 'orders', sub: `${vendorName}${vendorName ? ' · ' : ''}${pickup ? 'Self pickup' : 'Campus delivery'}` })}
    <div class="pad site-split enter">
    <div class="stack g4">
      ${headline}

      ${stage >= 0 ? `<div class="card card-pad">
        ${Label('Progress')}
        <div class="timeline" style="margin-top:var(--s-3)">
          ${stages.map(([s, t, d], i) => {
            const st = i < stage || done ? 'done' : i === stage ? 'active' : 'pending';
            return `<div class="tl-step ${st}">
              <div class="tl-rail"><div class="tl-node">${st === 'done' ? I.check : ''}</div>${i < stages.length - 1 ? '<div class="tl-line"></div>' : ''}</div>
              <div class="tl-body"><div class="tl-title">${esc(t)}</div><div class="t-xs muted">${esc(d)}${at(s) ? ` · ${when(at(s))}` : ''}</div></div>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}
      ${done && !pickup && partner ? `<div class="card card-pad">${PartnerCard(partner, 'delivered your order')}</div>` : ''}
      ${done ? ReviewCards(o, myReviews, !pickup && !!partner) : ''}
    </div>
    <aside class="stack g4">
      <div class="card card-pad ticket stack g2" style="--notch:64px">
        <div class="between">${Label('Receipt')}<span class="code t-xs muted">#${esc(o.code)}</span></div>
        ${items.map((l) => `<div class="between t-sm"><span>${esc(l.name_snapshot)} × ${l.qty}</span><span class="money t-sm">${money(l.line_paise)}</span></div>`).join('')}
        <hr class="dashline" style="margin-block:6px">
        <div class="between t-sm"><span class="muted">${pickup ? 'Self pickup' : 'Campus delivery'}</span><span class="money t-sm">${o.delivery_paise ? money(o.delivery_paise) : 'Free'}</span></div>
        <div class="between"><span class="t-h3">Total · ${payment ? esc(payment.status === 'captured' ? 'Paid online' : payment.status) : 'Not paid'}</span><span class="money t-h2">${money(o.total_paise)}</span></div>
        <p class="t-xs faint">These are the prices at the time you ordered. A later menu change does not affect them.</p>
      </div>

      <div class="row g2" style="flex-wrap:wrap">
        ${!pickup && ['assigned', 'picked_up', 'delivered'].includes(o.state)
          ? `<button class="btn btn-secondary btn-sm grow" data-act="sheet" data-sheet="incident" data-order="${o.id}">Report a problem</button>`
          : `<button class="btn btn-secondary btn-sm grow" data-act="sheet" data-sheet="report" data-order="${o.id}">Report an issue</button>`}
        <button class="btn btn-ghost btn-sm grow" data-act="cafContact" data-id="${o.vendor_id}">Contact cafeteria</button>
      </div>
    </aside>
    </div>
  </div>`;
}

/* Who is bringing the order: first name, photo and delivery rating. The
   server sends nothing more than that. */
const PartnerCard = (p, doing) => {
  if (!p) return `<div class="row g3" style="padding-top:4px"><div class="avatar">${I.bike}</div>
    <div class="grow"><div class="t-h3">A campus partner ${esc(doing)}</div><div class="t-xs muted">Verified student partner</div></div></div>`;
  const photo = quad.orderPartnerPhotoUrl(p.photoUrl);
  return `<div class="row g3" style="padding-top:4px">
    ${photo ? `<img class="avatar avatar-lg" src="${esc(photo)}" alt="Photo of ${esc(p.firstName)}, your delivery partner" style="object-fit:cover;padding:0">`
            : `<div class="avatar avatar-lg">${esc(initials(p.firstName))}</div>`}
    <div class="grow">
      <div class="t-h3">${esc(p.firstName)} ${esc(doing)}</div>
      <div class="t-xs muted">Verified student partner · ${p.rating ? `${I.star} ${p.rating.average.toFixed(1)} (${p.rating.count})` : 'No delivery ratings yet'}</div>
    </div>
  </div>`;
};

/* Two separate, clearly labelled reviews: the food/cafeteria and the
   delivery. A submitted review is shown as it was sent; it cannot be edited. */
function ReviewCards(o, mine, hasDelivery) {
  const done = (t) => mine.find((r) => r.target === t);
  const draft = S.review[o.id] || {};
  const card = (target, title, help) => {
    const got = done(target);
    if (got) {
      return `<div class="card card-pad stack g2">
        <div class="between">${Label(title)}<span class="badge badge-open">${I.check} Reviewed</span></div>
        <div class="row g1" aria-label="${got.stars} out of 5 stars">${Stars(got.stars)}</div>
        ${got.body ? `<p class="t-sm muted">“${esc(got.body)}”</p>` : ''}
        <p class="t-xs faint">Reviews cannot be changed after they are posted.</p>
      </div>`;
    }
    const stars = draft[target] || 0;
    return `<form class="card card-pad stack g3" data-form="review" data-order="${o.id}" data-target="${target}">
      ${Label(title)}
      <p class="t-xs muted">${esc(help)}</p>
      <div class="row g1" role="radiogroup" aria-label="${esc(title)} rating">
        ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="chip" data-act="pickStars" data-order="${o.id}" data-target="${target}" data-stars="${n}"
            role="radio" aria-checked="${n === stars}" aria-pressed="${n <= stars}" aria-label="${n} star${n === 1 ? '' : 's'}">${n}★</button>`).join('')}
      </div>
      <textarea class="input" name="body" rows="2" maxlength="1000" placeholder="Anything to add? (optional)"
                data-review-body="${o.id}:${target}">${esc(draft[`${target}Body`] || '')}</textarea>
      <button class="btn btn-primary btn-sm" type="submit" ${stars ? '' : 'disabled'} style="align-self:flex-start">${stars ? 'Post review' : 'Choose a rating'}</button>
    </form>`;
  };
  return `
    ${card('vendor', 'Food & cafeteria', 'How was the food and the counter? Only buyers of this order can review it.')}
    ${hasDelivery ? card('delivery', 'Delivery', 'How was the delivery? Your partner sees the rating, never who gave it.') : ''}`;
}
const Stars = (n) => [1, 2, 3, 4, 5].map((i) => `<span style="color:${i <= n ? 'var(--accent)' : 'var(--line-strong)'}">★</span>`).join('');

function ScrOrders() {
  const r = need('orders', () => quad.orders({ scope: 'own' }));
  const orders = r?.ok ? r.v.orders : [];
  const active = orders.filter((o) => LIVE.includes(o.state));
  const earlier = orders.filter((o) => !LIVE.includes(o.state) && o.state !== 'draft');
  return `<div class="screen">
    ${TopBar('Your orders')}
    <div class="pad stack g4 enter reading" style="margin-inline:0">
      ${!r ? Loading('Loading your orders') : !r.ok ? Problem(r.e) : !orders.length
        ? `<div class="empty"><div class="empty-art">${Ico(I.receipt, 34)}</div><div class="t-h2">No orders yet.</div>
             <p class="t-sm muted">When you order something it will appear here.</p>
             <button class="btn btn-secondary btn-sm" data-act="go" data-route="cafes">Browse cafés</button></div>`
        : `${active.length ? `<div class="livegrid">${active.map(ActiveOrderCard).join('')}</div>` : ''}
           ${earlier.length ? `${Label('Earlier')}
           <div class="stack g2">
             ${earlier.map((o) => {
               const c = cafVM({ id: o.vendor_id, name: o.vendor_name });
               return `<button class="tile row g3" data-act="track" data-id="${o.id}" style="width:100%;text-align:left">
                 <div class="cafmark" style="width:38px;height:38px;border-radius:11px;font-size:.85rem;background:${c.markBg}">${esc(c.mark)}</div>
                 <div class="grow"><div class="t-sm" style="font-weight:700">${esc((o.items || []).map((i) => `${i.qty}× ${i.name}`).join(', '))}</div>
                 <div class="t-xs muted">${esc(o.vendor_name)} · ${when(o.created_at)} · ${o.fulfilment === 'pickup' ? 'Picked up' : 'Delivery'}</div>
                 ${o.state === 'delivered' && (!o.reviewed_vendor || (o.fulfilment === 'delivery' && o.partner_id && !o.reviewed_delivery))
                   ? `<div class="t-xs" style="color:var(--accent-text);font-weight:700;margin-top:2px">${I.star} Rate ${[!o.reviewed_vendor && 'the food', o.fulfilment === 'delivery' && o.partner_id && !o.reviewed_delivery && 'the delivery'].filter(Boolean).join(' and ')}</div>` : ''}</div>
                 <div class="stack" style="align-items:flex-end"><span class="money t-sm">${money(o.total_paise)}</span>
                 <span class="badge ${o.state === 'delivered' ? 'badge-open' : ['cancelled', 'refunded'].includes(o.state) ? 'badge-danger' : 'badge-ink'}" style="margin-top:3px">${esc(ORDER_LABEL[o.state] || o.state)}</span></div>
               </button>`; }).join('')}
           </div>` : ''}`}
    </div>
  </div>`;
}

/* ===================== STUDENT: you ===================================== */
/* Titles and badges only; the reason and the next step come from the server
   (/auth/me verificationStatus), so the app can never contradict the gate. */
const VERIFY_COPY = {
  unverified: ['Not verified', 'Verify with your university student email to unlock ordering and the partner programme.', 'badge-closed'],
  email_verified: ['Email confirmed', 'Your student email is confirmed. An administrator still has to approve your account.', 'badge-warn'],
  pending: ['Pending admin review', 'Your verification is with the verification team. A decision is expected within 24 hours.', 'badge-warn'],
  needs_review: ['Pending admin review', 'An administrator needs to take a closer look.', 'badge-warn'],
  approved: ['Verified student', 'Your student identity has been verified.', 'badge-open'],
  rejected: ['Not accepted', 'Your verification was not accepted. You can send a new request.', 'badge-danger'],
  suspended: ['Suspended', 'Your student verification is suspended. Contact campus support.', 'badge-danger'],
};

function ScrProfile() {
  const r = need('me', () => quad.me());
  const me = r?.ok ? r.v : S.me;
  const u = me.user;
  const [vTitle, vFallback, vBadge] = VERIFY_COPY[u.studentStatus] || VERIFY_COPY.unverified;
  const vs = me.verificationStatus;
  const vBody = vs ? [vs.reason, vs.nextStep].filter(Boolean).join(' ') : vFallback;
  const p = me.partner;
  const partnerSub = !p || p.status === 'left'
    ? (u.studentStatus === 'approved' ? 'Earn by delivering campus orders' : 'Join as a delivery partner')
    : p.status === 'pending' ? 'Application under review'
    : p.status === 'approved' ? (p.online ? 'Active partner · online' : 'Active partner · offline')
    : p.status === 'rejected' ? 'Application not approved'
    : p.status === 'suspended' ? 'Partner account suspended'
    : `Partner status: ${p.status}`;
  const rows = [
    [I.shield, 'Student verification', vTitle, ['approved', 'suspended'].includes(u.studentStatus) ? '' : 'data-act="go" data-route="verify"'],
    [I.pin, 'Campus', me.profile?.campus ? `${me.profile.campus.name}${me.profile.campus.available ? '' : ' · service coming soon'}` : 'Not selected', 'data-act="go" data-route="setup"'],
    [I.user, 'Name and contact number', [me.profile?.name, prettyPhone(me.profile?.contactPhone)].filter(Boolean).join(' · ') || 'Not added yet', 'data-act="go" data-route="setup"'],
    [I.receipt, 'Order history', 'Everything you have ordered', 'data-act="go" data-route="orders"'],
    [I.bike, `Deliver with ${BRAND}`, partnerSub,
      p?.status === 'approved' ? 'data-act="go" data-route="partner"' : 'data-act="go" data-route="join"'],
    [I.help, 'Help & report an issue', 'Reach a real person in campus admin', 'data-act="sheet" data-sheet="report"'],
    [I.moon, 'Appearance', 'Switch between light and dark', 'data-act="theme"'],
    [I.logout, 'Sign out', '', 'data-act="signout"'],
  ];
  return `<div class="screen">
    ${TopBar('You')}
    <div class="pad site-split enter">
    <div class="stack g4">
      <div class="poster" style="padding:var(--s-5)">
        <div class="poster-arc" style="width:130px;height:130px;top:-50px;right:-30px"></div>
        <div class="row g3">
          <div class="avatar avatar-lg">${esc(initials(u.name))}</div>
          <div class="grow"><div class="t-h1">${esc(u.name || 'Unnamed')}</div>
            <div class="t-xs code muted">${esc(u.studentEmail || u.phone || '')}</div>
            <span class="badge ${vBadge}" style="margin-top:6px"><i class="dot"></i>${esc(vTitle)}</span></div>
        </div>
      </div>
      ${u.studentStatus !== 'approved' ? `<div class="campusnote">${Ico(I.shield, 18)}<p class="t-xs" style="color:var(--text-2)">${esc(vBody)}</p></div>` : ''}
      <div class="stack g2">
        ${Label('Account')}
        <div class="card" style="overflow:hidden">
          ${rows.map(([g, t, s, attrs]) => `
            <button class="adminrow" ${attrs} style="width:100%;text-align:left">
              ${Ico(g, 20)}
              <div class="grow"><div class="t-sm" style="font-weight:700">${esc(t)}</div>${s ? `<div class="t-xs muted">${esc(s)}</div>` : ''}</div>
              ${attrs ? I.chev : ''}</button>`).join('')}
        </div>
      </div>
    </div>
    <aside class="stack g4">
      ${NotificationsCard()}
    </aside>
    </div>
  </div>`;
}

function NotificationsCard() {
  const r = need('notifs', () => quad.notifications());
  if (!r?.ok) return '';
  const { notifications: list, channels } = r.v;
  return `<div class="stack g2">
    ${Label('Notifications')}
    <div class="card card-pad stack g2">
      ${list.length ? list.slice(0, 6).map((n) => `<div><div class="t-sm" style="font-weight:700">${esc(n.title)}</div>
        <div class="t-xs muted">${esc(n.body || '')} · ${when(n.created_at)}</div></div>`).join('')
        : '<p class="t-sm muted">Nothing yet.</p>'}
      ${!channels?.sms?.configured ? '<p class="t-xs faint">SMS notifications are not configured on this server, so you will only see them here.</p>' : ''}
    </div>
  </div>`;
}

/* Three ways to establish student status, strongest first. The college ID
   card is optional: a student without one uses their university mailbox, and
   a student with neither asks the verification team, who confirm status
   through an official channel. Which options are open comes from the server. */
function ScrVerify() {
  const r = need('myverif', () => quad.myVerification());
  const top = TopBar('Verify you are a student', { back: 'profile' });
  if (!r) return `<div class="screen">${top}${Loading('Checking your status')}</div>`;
  if (!r.ok) return `<div class="screen">${top}${Problem(r.e)}</div>`;
  const v = r.v;
  const opt = v.options || {};
  const status = `<div class="campusnote">${Ico(I.shield, 18)}<p class="t-xs" style="color:var(--text-2)">
      <b>${esc(v.verification.state.replace(/_/g, ' '))}</b> — ${esc([v.verification.reason, v.verification.nextStep].filter(Boolean).join(' '))}</p></div>`;
  const domains = studentDomains();

  const emailBlock = !opt.institutionalEmail ? '' : S.verify.codeSent ? `
    <form class="card card-pad stack g3" data-form="linkcode">
      ${Label('Recommended · University email')}
      <p class="t-sm muted">Enter the 6-digit code sent to <b>${esc(S.verify.email)}</b>. Check Junk if it has not arrived.</p>
      <input class="input code" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" required>
      <button class="btn btn-primary btn-block" type="submit">Verify code</button>
    </form>` : `
    <form class="card card-pad stack g3" data-form="linkemail">
      ${Label('Recommended · University email')}
      <p class="t-sm muted">No ID card needed. We email a code to your university mailbox; receiving it proves you are a current student.</p>
      <input class="input" name="email" type="email" autocapitalize="none" spellcheck="false" required
             placeholder="name.12345@${esc(domains[0])}">
      <p class="t-xs faint">Only @${esc(domains.join(' or @'))} addresses are accepted.</p>
      <button class="btn btn-primary btn-block" type="submit">Email me a code</button>
    </form>`;

  const idBlock = !opt.idCard ? '' : `
    <details class="card card-pad">
      <summary class="t-h3">I have my college ID card (optional)</summary>
      ${IdCardForm()}
    </details>`;

  const manualBlock = !opt.manualRequest ? '' : `
    <details class="card card-pad">
      <summary class="t-h3">I can't use my student email or ID card</summary>
      <form class="stack g3" data-form="manual" style="margin-top:var(--s-3)">
        <p class="t-sm muted">The verification team will confirm your student status through an official university channel before approving you. Do not upload screenshots or documents — they are not accepted as proof.</p>
        <div class="field"><label class="t-label" for="m-name">Full name as the university records it</label>
          <input class="input" id="m-name" name="name" required></div>
        <div class="field"><label class="t-label" for="m-roll">SAP ID / enrolment number</label>
          <input class="input" id="m-roll" name="roll" required></div>
        <div class="field"><label class="t-label" for="m-note">Why can't you use your student email?</label>
          <textarea class="input" id="m-note" name="note" rows="3" minlength="10" required></textarea></div>
        <button class="btn btn-secondary btn-block" type="submit">Send request to the verification team</button>
      </form>
    </details>`;

  return `<div class="screen">
    ${top}
    <div class="pad stack g4 enter narrow" style="margin-inline:0">
      ${status}
      ${emailBlock}${idBlock}${manualBlock}
      ${!emailBlock && !idBlock && !manualBlock ? '<p class="t-sm muted">There is nothing for you to do here right now.</p>' : ''}
    </div>
  </div>`;
}

function IdCardForm() {
  return `
    <form class="stack g4" data-form="verify" style="margin-top:var(--s-3)">
      <p class="t-sm muted">Photograph your college ID card. An administrator reviews every submission — nothing is approved automatically.</p>
      <div class="field"><label class="t-label" for="v-name">Your name as printed</label>
        <input class="input" id="v-name" name="name" required></div>
      <div class="field"><label class="t-label" for="v-roll">Roll / enrolment number</label>
        <input class="input" id="v-roll" name="roll" required></div>
      <div class="field"><label class="t-label" for="v-front">Front of the card</label>
        <input class="input" id="v-front" type="file" name="front" accept="image/*" capture="environment" required></div>
      <div class="field"><label class="t-label" for="v-back">Back of the card (optional)</label>
        <input class="input" id="v-back" type="file" name="back" accept="image/*" capture="environment"></div>
      <button class="btn btn-secondary btn-block" type="submit">Submit for review</button>
      <div class="campusnote">${Ico(I.lock, 18)}<p class="t-xs" style="color:var(--text-2)">Your ID images are stored privately and are visible only to administrators reviewing your case.</p></div>
    </form>`;
}

/* ===================== DELIVER WITH ECHO ECHO — onboarding ============
   One screen, six honest states, all read from /auth/me on every visit:
   the student's verification status and the partner_profile status. Joining
   is the existing POST /partner/apply — an application, never an activation;
   an administrator approves it in Campus Control, which is also what grants
   the delivery_partner role the dashboard needs. */
const PERKS = [
  [I.wallet, 'Earn by delivering campus orders', 'Pick up from a campus café and bring it to a student nearby.'],
  [I.clock, 'Choose when you are available', 'Go online between classes, and offline whenever you like.'],
  [I.lock, 'Every handover is verified', 'You collect with the counter\'s code and deliver with the student\'s code.'],
  [I.receipt, 'Earnings tracked for you', 'Each delivery\'s earning is recorded when it is delivered, and payouts are listed with their bank reference.'],
];

/* The application itself: photo, the policy in full, and an explicit
   acceptance. The server checks all three again; this only collects them. */
function JoinApplication(me, cta = 'Apply to deliver') {
  const pol = need('policy', () => quad.partnerPolicy());
  if (!pol) return Loading('Loading the partner policy');
  if (!pol.ok) return Problem(pol.e);
  const policy = pol.v.policy;
  if (!policy) return NotConfigured('Applications are closed', 'No partner policy is published right now.');
  const hasPhoto = me.user.hasPartnerPhoto;
  const deposit = policy.amountPaise;
  return `<div class="stack g4">
    <div class="stack g2">
      ${Label('1 · Your photo')}
      <div class="row g3">
        ${hasPhoto ? `<img class="avatar avatar-lg" src="${esc(quad.myPartnerPhotoUrl())}?v=${S.photoVersion || 0}" alt="Your partner photo" style="object-fit:cover;padding:0">`
                   : `<div class="avatar avatar-lg">${Ico(I.user, 22)}</div>`}
        <div class="grow stack g1">
          <p class="t-xs muted">A clear, recent photo of your face. Customers see it so they know who is delivering. No logos, group photos or screenshots.</p>
          <label class="btn btn-secondary btn-sm" style="align-self:flex-start;cursor:pointer">
            ${S.photoBusy ? 'Checking…' : hasPhoto ? 'Replace photo' : 'Add photo'}
            <input type="file" accept="image/jpeg,image/png" capture="user" data-partner-photo hidden ${S.photoBusy ? 'disabled' : ''}>
          </label>
        </div>
      </div>
      ${S.joinNote && hasPhoto ? `<p class="t-xs faint">${esc(S.joinNote)}</p>` : ''}
    </div>
    <div class="stack g2">
      ${Label('2 · Partner policy and security deposit')}
      <div class="sunken stack g2" style="padding:var(--s-3);max-height:220px;overflow:auto">
        <div class="between"><span class="t-sm" style="font-weight:700">Security deposit</span>
          <span class="money t-sm">${deposit ? money(deposit) : 'None required'}</span></div>
        <div class="between"><span class="t-xs muted">Time to dispute a proposed deduction</span>
          <span class="t-xs">${Math.round(policy.disputeWindowHours / 24)} days</span></div>
        <p class="t-xs" style="color:var(--text-2);white-space:pre-line">${esc(policy.terms)}</p>
      </div>
      ${deposit ? `<p class="t-xs faint">The deposit is paid to ${BRAND} by bank transfer or UPI after you apply, and recorded by campus admin with the transfer reference. Nothing is charged automatically.</p>` : ''}
      <label class="row g2 t-sm" style="align-items:flex-start;cursor:pointer">
        <input type="checkbox" id="accept-policy" data-policy="${policy.id}" style="margin-top:3px">
        <span>I have read the delivery partner policy${deposit ? ' and the security deposit terms' : ''} and I accept them.</span>
      </label>
    </div>
    <button class="btn btn-primary btn-lg btn-block" data-act="joinPartner" ${hasPhoto ? '' : 'disabled'}>${hasPhoto ? esc(cta) : 'Add your photo to apply'}</button>
  </div>`;
}

/* Shown while an application waits: what deposit is still owed, if any. */
function DepositDue() {
  const d = need('deposit', () => quad.deposit());
  if (!d?.ok || !d.v.requiredPaise) return '';
  const v = d.v;
  return v.shortfallPaise > 0
    ? `<div class="campusnote">${Ico(I.wallet, 18)}<p class="t-xs" style="color:var(--text-2)">
         <b>Security deposit due: ${money(v.shortfallPaise)}.</b> Pay it to ${BRAND} by bank transfer or UPI and tell campus admin the reference. You can be approved once it is recorded.</p></div>`
    : `<div class="campusnote">${Ico(I.check, 18)}<p class="t-xs" style="color:var(--text-2)">Security deposit of ${money(v.balancePaise)} received.</p></div>`;
}

function ScrJoin() {
  const r = need('me', () => quad.me());
  if (!r) return `<div class="screen">${TopBar(`Deliver with ${BRAND}`, { back: 'profile' })}${Loading('Checking your status')}</div>`;
  if (!r.ok) return `<div class="screen">${TopBar(`Deliver with ${BRAND}`, { back: 'profile' })}${Problem(r.e)}</div>`;
  const me = r.v;
  const student = me.user.studentStatus;
  const status = me.partner?.status || null;

  let state;
  if (status === 'approved') state = 'approved';
  else if (status === 'suspended') state = 'suspended';
  else if (status === 'pending') state = 'pending';
  else if (student !== 'approved') state = ['pending', 'needs_review'].includes(student) ? 'id_review' : 'unverified';
  else if (status === 'rejected') state = 'rejected';
  else state = 'eligible';

  const STATUS = {
    unverified: { badge: ['badge-closed', 'Student ID needed'], title: 'Verify you are a student first',
      body: 'Only verified students can deliver on campus. Verify with your university student email — it takes a minute. Then you can apply here.',
      action: () => `<button class="btn btn-primary btn-lg btn-block" data-act="go" data-route="verify">Verify my student status</button>` },
    id_review: { badge: ['badge-warn', 'ID under review'], title: 'Your student ID is being reviewed',
      body: 'You can join as soon as an administrator approves your ID. There is nothing else to do for now.',
      action: () => `<button class="btn btn-secondary btn-block" data-act="refreshJoin">Check again</button>` },
    eligible: { badge: ['badge-open', 'Eligible'], title: 'You can apply',
      body: 'You are a verified student. Add your photo, read the partner policy, and send your application.',
      action: () => JoinApplication(me) },
    pending: { badge: ['badge-warn', 'Application under review'], title: 'Application submitted',
      body: 'An administrator is reviewing your application. You will see it here, and in your notifications, once it is decided. You are not a delivery partner yet.',
      action: () => `${DepositDue()}<button class="btn btn-secondary btn-block" data-act="refreshJoin">Check status</button>` },
    approved: { badge: ['badge-open', 'Approved partner'], title: 'You are a delivery partner',
      body: 'Go online from your dashboard to start receiving delivery offers.',
      action: () => `<button class="btn btn-primary btn-lg btn-block" data-act="go" data-route="partner">Open partner dashboard</button>` },
    rejected: { badge: ['badge-danger', 'Not approved'], title: 'Your application was not approved',
      body: 'Campus admin did not approve your last application. If you think something was missed, contact them, or apply again.',
      action: () => `<div class="stack g2">${JoinApplication(me, 'Apply again')}
        <button class="btn btn-ghost btn-block" data-act="sheet" data-sheet="report">Contact campus admin</button></div>` },
    suspended: { badge: ['badge-danger', 'Suspended'], title: 'Your partner account is suspended',
      body: 'You cannot take deliveries while your account is suspended. Contact campus admin to find out why and what happens next.',
      action: () => `<button class="btn btn-secondary btn-block" data-act="sheet" data-sheet="report">Contact campus admin</button>` },
  }[state];

  const step = (n, label, done, current) => `
    <div class="row g3">
      <span class="avatar avatar-sm" style="width:26px;height:26px;font-size:.72rem;${done ? 'background:var(--accent);color:var(--text-on-rose)' : current ? '' : 'opacity:.5'}">${done ? I.check : n}</span>
      <span class="t-sm" style="${done || current ? 'font-weight:700' : 'color:var(--text-muted)'}">${esc(label)}</span>
    </div>`;
  const verified = student === 'approved';
  const applied = ['pending', 'approved', 'rejected', 'suspended'].includes(status);

  return `<div class="screen">
    ${TopBar(`Deliver with ${BRAND}`, { back: 'profile' })}
    <div class="pad site-split enter">
      <div class="stack g4">
        <div class="poster poster-grid" style="padding:var(--s-6) var(--s-5)">
          <div class="poster-arc" style="width:160px;height:160px;top:-60px;right:-50px"></div>
          <div class="t-label">Delivery partner programme</div>
          <div class="t-display" style="font-size:1.9rem;margin-top:8px">Deliver between<br>classes. Get paid.</div>
          <p class="t-sm" style="color:var(--text-2);margin-top:10px;max-width:46ch">Students on campus deliver orders from campus cafés to other students. It is flexible, it is on your own campus, and it counts every rupee you earn.</p>
        </div>
        <div class="card" style="overflow:hidden">
          ${PERKS.map(([icon, t, d]) => `
            <div class="adminrow">${Ico(icon, 20)}
              <div class="grow"><div class="t-sm" style="font-weight:700">${esc(t)}</div>
              <div class="t-xs muted">${esc(d)}</div></div></div>`).join('')}
        </div>
      </div>
      <aside class="stack g4 first-mobile">
        <div class="card card-pad stack g3">
          <div class="between">${Label('Your status')}<span class="badge ${STATUS.badge[0]}">${esc(STATUS.badge[1])}</span></div>
          <div class="t-h2">${esc(STATUS.title)}</div>
          <p class="t-sm muted">${esc(STATUS.body)}</p>
          ${S.joinError ? `<p class="t-xs" style="color:var(--danger)">${esc(S.joinError)}</p>` : ''}
          ${typeof STATUS.action === 'function' ? STATUS.action() : STATUS.action}
        </div>
        <div class="card card-pad stack g3">
          ${Label('How joining works')}
          ${step(1, 'Verify you are a student', verified, !verified)}
          ${step(2, 'Add your photo and accept the partner policy', applied || (me.user.hasPartnerPhoto && verified), verified && !applied)}
          ${(() => {
            const pol = need('policy', () => quad.partnerPolicy());
            const amount = pol?.ok ? pol.v.policy?.amountPaise : null;
            return amount === 0
              ? step(3, 'No security deposit is required right now', applied, false)
              : step(3, amount ? `Pay the ${money(amount)} security deposit` : 'Pay the security deposit, if one is set', status === 'approved', status === 'pending');
          })()}
          ${step(4, 'Approval by campus admin', status === 'approved', status === 'pending')}
          ${step(5, 'Go online and deliver', false, status === 'approved')}
        </div>
        ${['left', 'rejected'].includes(status) ? (() => {
          const d = need('deposit', () => quad.deposit());
          return d?.ok && (d.v.balancePaise > 0 || d.v.refundRequest) ? DepositCard(d.v) : '';
        })() : ''}
      </aside>
    </div>
  </div>`;
}

/* ===================== PARTNER (approved partners only) ================= */
function ScrPartner() {
  const r = need('partner', async () => ({
    offers: await quad.offers(), mine: await quad.orders({ scope: 'partner' }),
    earnings: await quad.earnings(), me: await quad.me(),
    deposit: await quad.deposit(), rating: await quad.partnerRating(),
  }));
  if (!r) return `<div class="screen">${TopBar('Deliveries', { back: 'profile' })}${Loading('Loading deliveries')}</div>`;
  /* Not (or no longer) a partner: the onboarding screen explains why, rather
     than the raw permission error. */
  if (!r.ok && r.e instanceof ApiError && r.e.status === 403) return ScrJoin();
  if (!r.ok) return `<div class="screen">${TopBar('Deliveries', { back: 'profile' })}${Problem(r.e)}</div>`;
  const { offers, mine, earnings: e, me, deposit, rating } = r.v;
  const online = !!me.partner?.online;
  const carrying = mine.orders.find((o) => ['assigned', 'picked_up'].includes(o.state));
  return `<div class="screen reading">
    <div class="partner-hero">
      <div class="between" style="margin-bottom:var(--s-5)">
        <div class="row g2">
          <button class="backbtn" data-act="go" data-route="profile" aria-label="Back">${I.back}</button>
          <div><div class="t-sm" style="font-weight:700">${esc(firstName())}</div><div class="t-xs" style="opacity:.6">Verified partner · ${rating.rating?.count ? `★ ${Number(rating.rating.average).toFixed(1)} (${rating.rating.count})` : 'No ratings yet'}</div></div></div>
        <span class="badge ${online ? 'badge-open' : ''}" style="${online ? '' : 'background:rgba(255,255,255,.14);color:var(--text-on-ink)'}"><i class="dot ${online ? 'dot-live' : ''}"></i>${online ? 'Online' : 'Offline'}</span>
      </div>
      <button class="gobtn ${online ? 'online' : ''}" data-act="toggleOnline" data-v="${online ? '0' : '1'}">
        <span style="font-size:1.5rem">${online ? 'ONLINE' : 'GO'}</span>
        <span class="t-xs" style="font-family:var(--font-ui);font-weight:600;opacity:.8">${online ? 'Tap to stop' : 'Tap to start'}</span>
      </button>
      <div class="statgrid" style="margin-top:var(--s-6)">
        <div><div class="statval">${money(e.todayEarnedPaise)}</div><div class="t-label" style="color:var(--text-on-ink);opacity:.6">Today</div></div>
        <div><div class="statval">${e.todayDeliveries}</div><div class="t-label" style="color:var(--text-on-ink);opacity:.6">Deliveries</div></div>
        <div><div class="statval">${money(e.pendingPayoutPaise)}</div><div class="t-label" style="color:var(--text-on-ink);opacity:.6">Pending</div></div>
      </div>
    </div>

    <div class="pad stack g4 enter" style="margin-top:var(--s-4)">
      ${carrying ? `<div class="campusnote">${Ico(I.lock, 18)}<p class="t-xs" style="color:var(--text-2)">
        Order #${esc(carrying.code)} is in your care. Keep it sealed and bring it straight to the customer. It stays assigned to you until the customer's code is entered; it cannot be cancelled, swapped or handed to someone else. If something goes wrong, report it now.</p></div>` : ''}
      <div class="stack g2">
        ${Label('Available now')}
        ${carrying ? '<p class="t-sm muted">Finish your current delivery to receive new offers.</p>' : ''}
        ${carrying ? '' : offers.offers.length ? offers.offers.map((o) => `
          <div class="tile row g3">
            <div class="grow"><div class="t-sm" style="font-weight:700">${esc(o.vendor_name)}</div>
            <div class="t-xs muted">${esc(o.destination || 'Pickup')} · ${money(o.total_paise)}</div></div>
            <button class="btn btn-primary btn-sm" data-act="acceptOffer" data-id="${o.id}">Accept</button>
          </div>`).join('')
          : `<div class="tile stack g2" style="background:var(--surface-blush);border-color:transparent">
               <div class="t-h3">${online ? 'Listening for offers' : "You're offline"}</div>
               <p class="t-sm muted">${online ? 'Nothing near you right now.' : 'Go online to receive delivery offers.'}</p></div>`}
      </div>
      <div class="stack g2">
        ${Label('Your deliveries')}
        ${mine.orders.length ? mine.orders.map((o) => `
          <div class="tile row g3">
            <span class="code t-xs muted" style="min-width:64px">#${esc(o.code)}</span>
            <div class="grow"><div class="t-sm" style="font-weight:700">${esc(o.vendor_name)}</div>
            <div class="t-xs muted">${esc(ORDER_LABEL[o.state] || o.state)}</div></div>
            <div class="stack g1" style="align-items:flex-end">
            ${o.state === 'assigned'
              ? `<button class="btn btn-primary btn-sm" data-act="pickupCode" data-id="${o.id}">Enter counter code</button>`
              : o.state === 'picked_up'
                ? `<button class="btn btn-primary btn-sm" data-act="doHandoff" data-id="${o.id}">Enter student code</button>` : ''}
            ${['assigned', 'picked_up'].includes(o.state)
              ? `<button class="btn btn-ghost btn-sm" data-act="sheet" data-sheet="incident" data-role="partner" data-order="${o.id}">Report a problem</button>` : ''}
            </div>
          </div>`).join('') : '<p class="t-sm muted">No deliveries yet.</p>'}
      </div>
      ${DepositCard(deposit)}
      <div class="card card-pad stack g2">
        ${Label('Earnings')}
        <div class="between t-sm"><span class="muted">Earned in total</span><span class="money t-sm">${money(e.totalEarnedPaise)}</span></div>
        <div class="between t-sm"><span class="muted">Already paid</span><span class="money t-sm">${money(e.paidOutPaise)}</span></div>
        <div class="between t-sm"><span class="muted">Completed deliveries</span><span class="t-sm">${e.completedDeliveries}</span></div>
        <p class="t-xs faint">You are paid what the order recorded when you delivered it, not a rate recalculated later.</p>
      </div>
      <div class="stack g2">
        ${Label('Payout history')}
        ${e.payouts.length ? e.payouts.map((p) => `
          <div class="tile row g3"><div class="grow"><div class="money t-sm">${money(p.amount_paise)}</div>
            <div class="t-xs muted">${esc(p.state)}${p.external_reference ? ` · ${esc(p.external_reference)}` : ''}</div></div>
            <span class="t-xs faint">${when(p.paid_at || p.created_at)}</span></div>`).join('')
          : '<p class="t-sm muted">Nothing paid out yet.</p>'}
      </div>
      <button class="btn btn-ghost btn-sm" data-act="leavePartner">Leave the partner programme</button>
    </div>
  </div>`;
}

const DEDUCTION_STATE = {
  proposed: ['badge-warn', 'Proposed · you can dispute'], disputed: ['badge-warn', 'Disputed · awaiting decision'],
  upheld: ['badge-danger', 'Upheld'], dismissed: ['badge-open', 'Dismissed'],
  withdrawn: ['badge-closed', 'Withdrawn'], applied: ['badge-danger', 'Deducted'],
};

/* The partner's security deposit, from the ledger: balance, every movement
   with its bank reference, every deduction with its evidence and state. */
function DepositCard(v) {
  if (!v) return '';
  const openDispute = (d) => d.state === 'proposed' && new Date(d.dispute_deadline) > new Date();
  return `<div class="card card-pad stack g3">
    <div class="between">${Label('Security deposit')}<span class="money t-h3">${money(v.balancePaise)}</span></div>
    ${v.requiredPaise ? `<p class="t-xs muted">Required by the current policy: ${money(v.requiredPaise)}${v.shortfallPaise ? ` · ${money(v.shortfallPaise)} still due` : ''}.</p>`
      : '<p class="t-xs muted">The current policy does not require a deposit.</p>'}
    <p class="t-xs faint">Held separately from your earnings. Never deducted automatically, and never because of a complaint alone.</p>
    ${v.deductions.length ? `<div class="stack g2">${v.deductions.map((d) => `
      <div class="tile stack g1">
        <div class="between"><span class="money t-sm">${money(d.amount_paise)}</span>
          <span class="badge ${DEDUCTION_STATE[d.state][0]}">${esc(DEDUCTION_STATE[d.state][1])}</span></div>
        <div class="t-xs muted">Order #${esc(d.order_code)} · ${esc(d.reason)}</div>
        ${openDispute(d) ? `<div class="between"><span class="t-xs faint">Dispute by ${new Date(d.dispute_deadline).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>
          <button class="btn btn-secondary btn-sm" data-act="openDispute" data-id="${d.id}">Dispute</button></div>` : ''}
        ${d.review_note ? `<div class="t-xs">Decision: ${esc(d.review_note)}</div>` : ''}
      </div>`).join('')}</div>` : ''}
    ${v.movements.length ? `<div class="stack g1">${v.movements.map((m) => `
      <div class="between t-xs"><span class="muted">${m.kind === 'received' ? 'Received' : 'Returned'} · ${esc(m.external_reference)}</span>
        <span class="money t-xs">${m.kind === 'received' ? '+' : '−'}${money(m.amount_paise)}</span></div>`).join('')}</div>` : ''}
    ${v.refundRequest?.state === 'requested' ? '<p class="t-xs" style="color:var(--warn)">Refund requested. Campus admin will transfer it and record the reference.</p>'
      : v.balancePaise > 0 ? (v.refund.eligible
        ? '<button class="btn btn-secondary btn-sm" data-act="depositRefund" style="align-self:flex-start">Request my deposit back</button>'
        : `<p class="t-xs faint">Refund available after you leave the programme with nothing outstanding.</p>`) : ''}
  </div>`;
}

/* ===================== ASSISTANT ======================================== */
function ScrAI() {
  const st = need('ai', () => quad.aiStatus());
  const empty = !S.chat.messages.length;
  const unavailable = st?.ok && !st.v.available;
  return `<div class="screen reading" style="display:flex;flex-direction:column">
    <div class="topbar">
      <span class="ai-mark">E.</span>
      <div class="grow"><div class="t-h3">Ask ${BRAND}</div>
        <div class="t-xs muted">Hinglish is fine${S.destination ? ` · ${esc(S.destination.name)}` : ''}</div></div>
      ${S.chat.messages.length ? `<button class="btn btn-ghost btn-sm" data-act="aiClear">Clear</button>` : ''}
    </div>

    <div class="pad stack g4 grow" style="padding-bottom:var(--s-4)">
      ${empty ? `
        <div class="poster poster-grid" style="margin-top:var(--s-2)">
          <div class="poster-arc" style="width:170px;height:170px;bottom:-90px;left:-50px"></div>
          <div class="t-label">Campus concierge</div>
          <div class="t-display" style="font-size:1.9rem;margin-top:8px">Tell ${BRAND}<br>what you want.</div>
          <p class="t-sm" style="color:var(--text-2);margin-top:10px">Say it how you'd say it to a friend. It looks at the real menu, checks what's actually available, and builds the order — you confirm before anything is paid.</p>
        </div>
        ${!st ? Loading('Checking the assistant') : unavailable || !st.ok
          ? NotConfigured('The ordering assistant is unavailable',
              `${st.ok ? st.v.message || '' : explain(st.e)} You can still browse and order normally.`)
          : ''}
        <div class="campusnote">${Ico(I.lock, 18)}<p class="t-xs" style="color:var(--text-2)">${BRAND}'s assistant can build and price an order, but it can never pay, place, or dispatch on its own. Every order needs your tap.</p></div>
      ` : `<div class="stack g4">${S.chat.messages.map((m) => m.who === 'user'
          ? `<div class="bubble-user msg-in">${esc(m.text)}</div>`
          : `<div class="row g2 msg-in" style="align-items:flex-start"><span class="ai-mark">E.</span><div class="bubble-ai grow">${esc(m.text)}</div></div>`).join('')}
          ${S.chat.busy ? `<div class="row g2 msg-in"><span class="ai-mark">E.</span><span class="thinking"><i></i><i></i><i></i></span></div>` : ''}</div>`}
    </div>

    ${st?.ok && st.v.available ? `<div class="composer">
      <div class="composer-inner">
        <textarea id="ai-in" rows="1" placeholder="Ground pe 2 cold coffee bhej do…" aria-label="Message ${BRAND}"></textarea>
        <button class="sendbtn" data-act="aiSend" aria-label="Send">${I.send}</button>
      </div>
    </div>` : ''}
  </div>`;
}

async function aiSend() {
  const input = $('#ai-in');
  const text = input?.value.trim();
  if (!text || S.chat.busy) return;
  if (!signedIn()) return go('ob-email');
  S.chat.messages.push({ who: 'user', text });
  S.chat.busy = true; render();
  try {
    const out = await quad.aiChat(S.chat.messages.map((m) => ({ role: m.who === 'user' ? 'user' : 'assistant', content: m.text })));
    S.chat.messages.push({ who: 'ai', text: out.reply });
  } catch (e) {
    S.chat.messages.push({ who: 'ai', text: explain(e) });
  } finally {
    S.chat.busy = false; render();
  }
}

/* ===================== sheets =========================================== */
const REPORTS = [
  ['Order never arrived', 'delivery'], ['Something was missing', 'wrong_order'],
  ['Packaging was tampered with', 'food_quality'], ['Wrong order delivered', 'wrong_order'],
  ['Partner behaviour', 'delivery'], ['Payment problem', 'payment'], ['Something else', 'other'],
];

/* Mirrors the server's list; the server is what validates the choice. */
const INCIDENT_BY_ROLE = {
  customer: [['not_delivered', 'My order was not delivered'], ['missing', 'Items were missing'],
             ['wrong_order', 'I received the wrong order'], ['tampered', 'The packaging was tampered with'],
             ['damaged', 'The order was damaged'], ['spilled', 'Food was badly spilled or damaged']],
  partner:  [['partner_not_received', 'I never received this order'], ['wrong_order', 'The counter gave me the wrong order'],
             ['missing', 'Items were missing when I collected'], ['tampered', 'The packaging was already open'],
             ['damaged', 'The order was damaged'], ['spilled', 'Food spilled during delivery']],
};

function Sheet() {
  if (!S.sheet) return '';
  const n = S.sheet.name;
  let body = '';

  if (n === 'location') {
    const parent = S.sheet.parent || '';
    const vendorId = S.cart[0]?.vendorId;
    const r = need(`campus:${parent}:${vendorId || ''}`, () => quad.campusChildren(parent || undefined, { vendorId }));
    const nodes = r?.ok ? r.v.nodes : [];
    const deliveryOff = r?.ok && r.v.deliveryAvailable === false;
    body = `
      <div class="sheet-body stack g4">
        <div class="stack g1">
          <h2 class="t-display" style="font-size:1.7rem">Where should<br>we bring it?</h2>
          <p class="t-sm muted">${parent ? esc(S.sheet.parentName || '') : `Campus spots only — that's how ${BRAND} stays fast.`}</p>
        </div>
        ${parent ? `<button class="btn btn-ghost btn-sm" data-act="sheetUp" style="align-self:flex-start;padding-inline:0">${I.back} All areas</button>` : ''}
        ${deliveryOff ? `<div class="campusnote">${Ico(I.clock, 18)}<div class="stack g1">
            <div class="t-h3">Campus delivery is not available yet</div>
            <p class="t-xs" style="color:var(--text-2)">${esc(r.v.note || 'The campus delivery area has not been confirmed.')} Choose self pickup to order now.</p></div></div>
          <button class="btn btn-secondary btn-sm" data-act="pickupFromSheet" style="align-self:flex-start">Switch to self pickup</button>` : ''}
        ${!r ? Loading('Loading campus spots') : !r.ok ? Problem(r.e) : deliveryOff ? '' : nodes.length ? `<div class="locgrid">
          ${nodes.map((l) => {
            const off = l.delivery_enabled === false;
            const act = off ? '' : l.deliverable ? 'data-act="setDest"' : 'data-act="sheetDrill"';
            return `<button class="loccard ${off ? 'faint' : ''}" ${act} data-id="${l.id}" data-name="${esc(l.name)}"
                ${S.destination?.id === l.id ? 'aria-pressed="true"' : ''} ${off ? 'disabled' : ''}>
              <span class="glyph">${placeGlyph()}</span>
              <span class="t-h3">${esc(l.name)}</span>
              <span class="t-xs muted">${off ? 'Delivery not available' : l.deliverable ? esc(l.detail || 'Deliver here') : 'Choose a spot inside'}</span>
              ${l.estimate && !off ? `<span class="t-xs" style="font-weight:700;color:var(--accent-text)" title="Estimated from the distance between the counter and this spot. Not live tracking.">${esc(l.estimate.label)} walk</span>` : ''}</button>`;
          }).join('')}
        </div>` : '<p class="t-sm muted">No delivery spots here yet.</p>'}
        <button class="btn btn-secondary btn-sm" data-act="useGps" style="align-self:flex-start">${I.pin} Use my live location</button>
        <div id="gps-results" class="stack g2"></div>
        <div class="campusnote">${Ico(I.pin, 18)}<p class="t-xs" style="color:var(--text-2)">
          ${BRAND} doesn't deliver outside campus and never asks for a street address. Off-campus isn't an option we hide — it doesn't exist in the system.</p></div>
      </div>
      <div class="sheet-foot"><button class="btn btn-primary btn-block btn-lg" data-act="closeSheet" ${S.destination ? '' : 'disabled'}>
        ${S.destination ? `Deliver to ${esc(S.destination.name)}` : 'Choose a spot'}</button></div>`;
  }

  if (n === 'report') {
    body = `<div class="sheet-body stack g4">
      <div class="stack g1"><h2 class="t-h1">What went wrong?</h2>
        <p class="t-sm muted">Reports go to a real person in campus admin${S.sheet.order ? ', with your order attached' : ''}.</p></div>
      ${!signedIn() ? '<p class="t-sm muted">Sign in to report an issue.</p>' : `<div class="stack g2">
        ${REPORTS.map(([t, cat]) => `
          <button class="tile row g3" data-act="report" data-cat="${cat}" data-subject="${esc(t)}" style="text-align:left;width:100%"><span class="grow t-sm">${esc(t)}</span>${I.chev}</button>`).join('')}
      </div>`}
      <p class="t-xs faint">${BRAND} can suspend accounts and partner status under campus policy. It never issues fines on its own.</p>
    </div>`;
  }

  if (n === 'incident') {
    const cats = INCIDENT_BY_ROLE[S.sheet.role || 'customer'];
    body = `<form class="sheet-body stack g4" data-form="incident">
      <div class="stack g1"><h2 class="t-h1">Report a delivery problem</h2>
        <p class="t-sm muted">Campus admin investigates every report using the order's pickup and handover records. Nobody is penalised on a report alone.</p></div>
      <div class="stack g2" role="radiogroup" aria-label="What happened">
        ${cats.map(([k, t]) => `<label class="tile row g3" style="cursor:pointer">
          <input type="radio" name="category" value="${k}" required> <span class="t-sm grow">${esc(t)}</span></label>`).join('')}
      </div>
      <div class="field"><label class="t-label" for="inc-desc">What happened?</label>
        <textarea class="input" id="inc-desc" name="description" rows="3" minlength="10" maxlength="2000" required
          placeholder="Where, when, and what you saw. At least 10 characters."></textarea></div>
      <button class="btn btn-primary btn-block btn-lg" type="submit">Send report</button>
    </form>`;
  }

  if (n === 'dispute') {
    const d = S.sheet.deduction;
    body = `<form class="sheet-body stack g4" data-form="dispute">
      <div class="stack g1"><h2 class="t-h1">Dispute this deduction</h2>
        <p class="t-sm muted">${money(d.amount_paise)} · Order #${esc(d.order_code)} · ${esc(d.reason)}</p></div>
      <div class="sunken stack g1" style="padding:var(--s-3)">
        ${Label('Evidence recorded by campus admin')}<p class="t-sm">${esc(d.evidence)}</p></div>
      <div class="field"><label class="t-label" for="dsp-text">Your side</label>
        <textarea class="input" id="dsp-text" name="text" rows="4" minlength="20" maxlength="4000" required
          placeholder="Explain what happened. At least 20 characters."></textarea></div>
      <p class="t-xs faint">Nothing is deducted while a dispute is open. A different administrator from the one who proposed it decides.</p>
      <button class="btn btn-primary btn-block btn-lg" type="submit">Send dispute</button>
    </form>`;
  }

  if (n === 'newcart') {
    body = `<div class="sheet-body stack g4">
      <div class="stack g1"><h2 class="t-h1">Start a new cart?</h2>
        <p class="t-sm muted">Your cart has items from ${esc(S.cart[0]?.vendorName || 'another cafeteria')}. An order comes from one cafeteria, so adding ${esc(S.sheet.item.name)} from ${esc(S.sheet.vendor.name)} will clear it.</p></div>
    </div>
    <div class="sheet-foot stack g2">
      <button class="btn btn-primary btn-block btn-lg" data-act="replaceCart">Clear cart and add</button>
      <button class="btn btn-ghost btn-block" data-act="closeSheet">Keep my cart</button>
    </div>`;
  }

  if (n === 'code') {
    body = `<form class="sheet-body stack g4" data-form="code">
      <div class="stack g1"><h2 class="t-h1">${esc(S.sheet.title)}</h2>
        <p class="t-sm muted">${esc(S.sheet.help)}</p></div>
      <input class="input code" id="code-in" inputmode="numeric" maxlength="8" autocomplete="one-time-code"
             style="font-size:1.4rem;letter-spacing:.3em;text-align:center">
      <button class="btn btn-primary btn-block btn-lg" type="submit">Confirm</button>
    </form>`;
  }

  return `<div class="scrim" data-act="closeSheet"></div>
    <div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grab"></div>${body}</div>`;
}

/* ===================== render =========================================== */
const ROUTES = {
  welcome: ScrWelcome, 'ob-email': ScrObEmail, 'ob-email-code': ScrObEmailCode, 'ob-phone': ScrObPhone, 'ob-otp': ScrObOtp, 'ob-enrol': ScrObEnrol,
  home: ScrHome, cafes: ScrCafes, menu: ScrMenu, cart: ScrCart, checkout: ScrCheckout,
  tracking: ScrTracking, orders: ScrOrders, profile: ScrProfile, ai: ScrAI,
  verify: ScrVerify, partner: ScrPartner, join: ScrJoin, setup: ScrSetup,
};
const NAVLESS = ['welcome', 'ob-email', 'ob-email-code', 'ob-phone', 'ob-otp', 'ob-enrol', 'checkout', 'setup'];

/* The page frame. On desktop the header carries the navigation; below
   1024px the header slims down and the app's bottom nav takes over. */
const SiteHeader = () => {
  const at = (...r) => (r.includes(S.route) ? 'aria-current="page"' : '');
  const count = cartCount();
  return `<header class="site-head"><div class="site-head-in">
    <button class="site-brand" data-act="go" data-route="${signedIn() ? 'home' : 'welcome'}">
      <span class="ai-mark">E.</span>${BRAND}</button>
    <nav class="site-nav" aria-label="Main">
      <button data-act="go" data-route="home" ${at('home')}>Home</button>
      <button data-act="go" data-route="cafes" ${at('cafes', 'menu')}>Cafés</button>
      <button data-act="go" data-route="orders" ${at('orders', 'tracking')}>Orders</button>
      <button data-act="go" data-route="ai" ${at('ai')}>Ask ${BRAND}</button>
    </nav>
    <div class="site-actions">
      ${count ? `<button class="site-cartbtn" data-act="go" data-route="cart" aria-label="Cart, ${count} items">
        ${I.cart}<span class="only-lg">Cart</span><span class="count">${count}</span></button>` : ''}
      <button class="site-icon" data-act="theme" aria-label="Toggle theme">${I.moon}</button>
      ${signedIn()
        ? `<button class="avatar avatar-sm only-lg" data-act="go" data-route="profile" aria-label="Your account">${esc(initials(S.me.user.name))}</button>`
        : `<button class="btn btn-secondary btn-sm" data-act="go" data-route="ob-email">Sign in</button>`}
    </div>
  </div></header>`;
};

function render(fresh = false) {
  const app = document.getElementById('app');
  const keep = fresh ? 0 : window.scrollY;
  const scr = (ROUTES[S.route] || ScrHome)();
  const nav = NAVLESS.includes(S.route) ? '' : BottomNav();
  app.innerHTML = `
    <div class="site">
      ${SiteHeader()}
      <main class="site-main">${scr}</main>
      <footer class="site-foot">${BRAND} · ${esc(campusLabel())} · Campus delivery only</footer>
      ${nav}
      ${Sheet()}
      ${S.toast ? `<div class="toast"><span>${S.toast.icon}</span>${esc(S.toast.msg)}</div>` : ''}
    </div>`;
  window.scrollTo?.(0, keep);
  /* The page behind an open sheet/dialog stays put; it scrolls again after. */
  if (document.body?.style) document.body.style.overflow = S.sheet ? 'hidden' : '';
}

const when = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts), diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

/* ===================== events =========================================== */
async function withBusy(btn, fn) {
  const label = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try { return await fn(); }
  catch (e) { toast(explain(e), 'bad'); return null; }
  finally { if (btn && document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = label; } }
}

async function signedInNow() {
  S.me = await quad.me();
  drop('orders', 'me', 'notifs', 'partner');
  let next = S.auth.next || { route: 'home', params: {} };
  /* A new account completes its profile before anything else. */
  if (profileIncomplete() && S.me.surfaces?.includes('web') && S.me.roles?.includes('student')) {
    S.setupNext = next; next = { route: 'setup', params: {} };
  }
  S.auth = { phone: '', email: '', resendAfter: 0, error: '' };
  if (!S.me.surfaces?.includes('web')) {
    toast('This account does not open the customer site', 'bad');
  }
  go(next.route, next.params);
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const a = t.dataset;

  switch (a.act) {
    case 'go': if (a.route === 'verify') drop('myverif'); go(a.route); break;
    case 'theme': toggleTheme(); break;
    case 'menu': go('menu', { caf: a.caf || S.cart[0]?.vendorId }); break;
    case 'track': go('tracking', { id: a.id }); break;
    case 'jumpcat': {
      const sec = document.getElementById(`cat-${a.cat}`);
      t.parentElement.querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', b === t));
      sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'add': {
      const r = cache[`menu:${S.params.caf}`];
      const it = r?.v?.items.find((m) => m.id === a.item);
      if (it) { addToCart(it, cafVM(r.v.vendor)); }
      break;
    }
    case 'bump': bump(+a.i, +a.d); break;
    case 'step': bump(S.cart.findIndex((l) => l.itemId === a.item), +a.d); break;
    case 'replaceCart': {
      const { item, vendor } = S.sheet;
      S.sheet = null; addToCart(item, vendor, { replace: true }); render();
      break;
    }
    case 'setfulfil': S.fulfilment = a.f; render(); break;
    case 'pickupFromSheet': S.fulfilment = 'pickup'; S.destination = null; setSheet(null); toast('Self pickup selected'); break;
    case 'pickupMode': S.fulfilment = 'pickup'; go('cafes'); toast('Self pickup selected'); break;

    case 'sheet': setSheet(a.sheet, { order: a.order, role: a.role }); break;
    case 'pickCampus': S.setup.campusId = a.id; keepSetupInputs(); render(); break;
    case 'pickStars': {
      S.review[a.order] = { ...(S.review[a.order] || {}), [a.target]: +a.stars };
      render(); break;
    }
    case 'openDispute': {
      const d = cache.partner?.v?.deposit?.deductions?.find((x) => x.id === a.id);
      if (d) setSheet('dispute', { deduction: d });
      break;
    }
    case 'depositRefund':
      await withBusy(t, async () => {
        const out = await quad.requestDepositRefund();
        drop('partner', 'deposit'); toast(out.message || 'Refund requested'); render();
      });
      break;
    case 'closeSheet': setSheet(null); break;
    case 'sheetDrill': setSheet('location', { parent: a.id, parentName: a.name }); break;
    case 'sheetUp': setSheet('location'); break;
    case 'setDest':
      S.destination = { id: a.id, name: a.name, path: S.sheet?.parentName || '' };
      render(); break;
    case 'useGps':
      await withBusy(t, async () => {
        const out = await quad.locate();
        const box = document.getElementById('gps-results');
        if (!out.inside) {
          toast(out.reason === 'outside_campus' ? 'You are outside the campus delivery zone.'
            : out.note || 'Could not place you on campus', 'bad');
          return;
        }
        if (!out.candidates?.length) { toast(out.note || 'No delivery point nearby', 'bad'); return; }
        if (box) box.innerHTML = `<p class="t-xs faint">We found you near:</p>` + out.candidates.map((c) => `
          <button class="tile row g3" data-act="setDest" data-id="${c.id}" data-name="${esc(c.name)}" style="width:100%;text-align:left">
            ${placeGlyph()}<div class="grow"><div class="t-sm" style="font-weight:700">${esc(c.name)}</div>
            <div class="t-xs muted">${esc(c.path || '')} · ~${c.metres} m</div></div></button>`).join('');
      });
      break;

    case 'report':
      await withBusy(t, async () => {
        await quad.createSupport({ orderId: S.sheet?.order || undefined, category: a.cat, subject: a.subject });
        setSheet(null); toast('Report sent to campus admin');
      });
      break;
    case 'cafContact':
      await withBusy(t, async () => {
        const c = await quad.vendorContact(a.id);
        toast(c.available ? `${c.name}: ${c.phone}` : c.message);
      });
      break;
    case 'handoff':
      await withBusy(t, async () => {
        const out = await quad.handoffCode(a.id);
        S.handoff[a.id] = out.code; render();
      });
      break;
    case 'rateItem':
      await withBusy(t, async () => {
        await quad.review({ orderId: a.order, orderItemId: a.line, stars: +a.stars });
        toast('Thanks for the rating');
      });
      break;
    case 'rateVendor':
      await withBusy(t, async () => {
        await quad.review({ orderId: a.order, stars: +a.stars });
        toast('Thanks for the rating');
      });
      break;

    case 'placeOrder':
      await withBusy(t, async () => {
        const draft = await quad.draft({
          vendorId: S.cart[0].vendorId,
          lines: S.cart.map((l) => ({ itemId: l.itemId, qty: l.qty })),
          fulfilment: S.fulfilment,
          destinationId: S.fulfilment === 'delivery' ? S.destination?.id : undefined,
        });
        const intent = await quad.paymentIntent(draft.id);
        await openGateway(intent, draft);
      });
      break;

    case 'resendEmail':
      await withBusy(t, async () => {
        await quad.sendEmailCode(S.auth.email);
        toast('A new code is on its way');
      });
      break;
    case 'contactPhone': {
      const v = prompt('Contact mobile number (used only by the payment gateway):', S.me?.user?.contactPhone || '');
      if (v === null) break;
      await withBusy(t, async () => {
        await quad.setContactPhone(v.trim());
        drop('me'); S.me = await quad.me(); toast('Contact number saved'); render();
      });
      break;
    }
    case 'resendOtp':
      await withBusy(t, async () => {
        await quad.sendOtp('+91' + S.auth.phone);
        toast('A new code is on its way');
      });
      break;
    case 'signout':
      await quad.logout().catch(() => {});
      S.me = null; S.cart = []; drop('orders', 'me', 'notifs', 'partner');
      go('welcome');
      break;

    case 'applyPartner':
    case 'joinPartner':
      S.joinError = '';
      await withBusy(t, async () => {
        try {
          const box = document.getElementById('accept-policy');
          if (!box?.checked) {
            S.joinError = 'Tick the box to confirm you have read and accept the partner policy.';
            return render();
          }
          const out = await quad.partnerApplyWithConsent(box.dataset.policy);
          drop('deposit', 'policy');
          toast(out.message || 'Application submitted');
        } catch (e) {
          /* A legitimate refusal (not verified, already applied, applications
             closed) is shown as the server phrased it. */
          S.joinError = explain(e);
        }
        drop('me', 'notifs'); S.me = await quad.me();
        render();
      });
      break;
    case 'refreshJoin':
      S.joinError = '';
      drop('me', 'notifs'); render();
      quad.me().then((m) => { S.me = m; }).catch(() => {});
      break;
    case 'leavePartner':
      if (!confirm('Leave the delivery partner programme? Your student account stays active.')) break;
      await withBusy(t, async () => { await quad.partnerLeave(); drop('me', 'partner'); S.me = await quad.me(); go('join'); });
      break;
    case 'toggleOnline':
      await withBusy(t, async () => { await quad.partnerOnline(a.v === '1'); drop('partner', 'me'); render(); });
      break;
    case 'acceptOffer':
      await withBusy(t, async () => { await quad.acceptOffer(a.id); drop('partner'); toast('Delivery accepted'); render(); });
      break;
    case 'pickupCode':
      setSheet('code', { mode: 'pickup', order: a.id, title: 'Counter code',
        help: 'Ask the counter for the pickup code for this order and enter it here.' });
      break;
    case 'doHandoff':
      setSheet('code', { mode: 'delivery', order: a.id, title: 'Student code',
        help: 'Ask the student for their delivery code and enter it here.' });
      break;

    case 'aiSend': aiSend(); break;
    case 'aiClear': S.chat.messages = []; render(); break;
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('[type=submit]');
  const kind = form.dataset.form;

  if (kind === 'phone') {
    const digits = form.phone.value.replace(/\D/g, '');
    S.auth.phone = digits;
    if (digits.length !== 10) { S.auth.error = 'Enter a 10-digit mobile number.'; return render(); }
    await withBusy(btn, async () => {
      try {
        const out = await quad.sendOtp('+91' + digits);
        S.auth.error = ''; S.auth.resendAfter = out.resendAfterSeconds || 0;
        go('ob-otp');
      } catch (err) { S.auth.error = explain(err); render(); }
    });
  }

  if (kind === 'setup') {
    const data = { name: form.name.value, contactPhone: form.contactPhone.value };
    const campusId = S.setup.campusId || myProfile()?.campus?.id;
    if (campusId) data.campusId = campusId;
    S.setup = { ...S.setup, name: data.name, contactPhone: data.contactPhone, error: '' };
    if (!campusId) { S.setup.error = 'Choose your campus.'; return render(); }
    await withBusy(btn, async () => {
      try {
        const profile = await quad.saveProfile(data);
        S.me = await quad.me();
        drop('vendors', 'me');
        S.setup = {};
        if (!profile.complete) {
          toast('Saved. One more step: verify your student email.', 'bad');
          return go('verify');
        }
        toast(profile.campus?.available ? 'Profile saved' : `Saved. ${profile.campus.message}`);
        const next = S.setupNext || { route: 'home', params: {} };
        S.setupNext = null;
        go(next.route, next.params);
      } catch (err) { S.setup.error = explain(err); render(); }
    });
  }

  if (kind === 'review') {
    const orderId = form.dataset.order;
    const target = form.dataset.target;
    const stars = S.review[orderId]?.[target];
    if (!stars) return;
    await withBusy(btn, async () => {
      await quad.review({ orderId, target: target === 'delivery' ? 'delivery' : undefined, stars, body: form.body.value });
      S.review[orderId] = { ...S.review[orderId], [target]: 0, [`${target}Body`]: '' };
      drop(`order:${orderId}`, 'orders');
      toast(target === 'delivery' ? 'Thanks for rating the delivery' : 'Thanks for rating the food');
    });
  }

  if (kind === 'incident') {
    const category = form.querySelector('input[name=category]:checked')?.value;
    if (!category) return toast('Choose what happened', 'bad');
    await withBusy(btn, async () => {
      const out = await quad.reportIncident(S.sheet.order, category, form.description.value);
      setSheet(null); drop('partner');
      toast(`Report ${out.code} sent to campus admin`);
    });
  }

  if (kind === 'dispute') {
    await withBusy(btn, async () => {
      await quad.disputeDeduction(S.sheet.deduction.id, form.text.value);
      setSheet(null); drop('partner');
      toast('Dispute sent. Nothing is deducted until it is decided.');
    });
  }

  if (kind === 'email') {
    S.auth.email = form.email.value.trim();
    if (!S.auth.email.includes('@')) { S.auth.error = 'Enter your university student email.'; return render(); }
    await withBusy(btn, async () => {
      try {
        const out = await quad.sendEmailCode(S.auth.email);
        S.auth.email = out.email; S.auth.error = '';
        go('ob-email-code');
      } catch (err) { S.auth.error = explain(err); render(); }
    });
  }

  if (kind === 'emailcode') {
    const code = [...form.querySelectorAll('[data-otp]')].map((i) => i.value).join('').replace(/\D/g, '');
    if (code.length !== 6) { S.auth.error = 'Enter the 6-digit code.'; return render(); }
    await withBusy(btn, async () => {
      try { await quad.verifyEmailCode(S.auth.email, code); await signedInNow(); }
      catch (err) { S.auth.error = explain(err); render(); }
    });
  }

  /* Verify screen: link a student mailbox to an account that signed in another way. */
  if (kind === 'linkemail') {
    const email = form.email.value.trim();
    await withBusy(btn, async () => {
      const out = await quad.linkEmailSend(email);
      S.verify = { email: out.email, codeSent: true };
      toast('Code sent to your university inbox');
      render();
    });
  }

  if (kind === 'linkcode') {
    const code = form.code.value.replace(/\D/g, '');
    await withBusy(btn, async () => {
      const out = await quad.linkEmailVerify(S.verify.email, code);
      S.verify = {};
      drop('me', 'myverif'); S.me = await quad.me();
      toast(out.verification.state === 'VERIFIED' ? 'You are a verified student' : 'Student email confirmed');
      go('profile');
    });
  }

  if (kind === 'manual') {
    await withBusy(btn, async () => {
      const out = await quad.requestManualVerification({
        name: form.name.value, roll: form.roll.value, note: form.note.value });
      drop('me', 'myverif'); S.me = await quad.me();
      toast(out.message || 'Request received');
      go('profile');
    });
  }

  if (kind === 'otp') {
    const code = [...form.querySelectorAll('[data-otp]')].map((i) => i.value).join('').replace(/\D/g, '');
    if (code.length !== 6) { S.auth.error = 'Enter the 6-digit code.'; return render(); }
    await withBusy(btn, async () => {
      try { await quad.verifyOtp('+91' + S.auth.phone, code); await signedInNow(); }
      catch (err) { S.auth.error = explain(err); render(); }
    });
  }

  if (kind === 'enrol') {
    const digits = form.phone.value.replace(/\D/g, '');
    S.auth.phone = digits;
    if (digits.length !== 10) { S.auth.error = 'Enter a 10-digit mobile number.'; return render(); }
    if (!form.code.value.trim()) { S.auth.error = 'Enter the code you were given.'; return render(); }
    await withBusy(btn, async () => {
      try { await quad.enrol('+91' + digits, form.code.value); await signedInNow(); }
      catch (err) { S.auth.error = explain(err); render(); }
    });
  }

  if (kind === 'verify') {
    await withBusy(btn, async () => {
      /* An empty optional file input is still sent as a zero-byte file, which
         the server rightly refuses ("No file received"). Leave it out. */
      const fd = new FormData(form);
      for (const [k, v] of [...fd.entries()]) if (v instanceof File && !v.size) fd.delete(k);
      const out = await quad.submitId(fd);
      drop('me', 'myverif'); S.me = await quad.me();
      toast(out.message || 'Submitted for review');
      go('profile');
    });
  }

  if (kind === 'code') {
    const code = $('#code-in')?.value.replace(/\D/g, '');
    if (!code) return;
    const { mode, order } = S.sheet;
    await withBusy(btn, async () => {
      if (mode === 'pickup') await quad.pickupWithCode(order, code);
      else await quad.handoff(order, code);
      setSheet(null); drop('partner');
      toast(mode === 'pickup' ? 'Picked up' : 'Delivered');
    });
  }
});

/* Typed text survives a re-render (choosing stars or a campus redraws the screen). */
function keepSetupInputs() {
  const f = document.querySelector('[data-form=setup]');
  if (f) S.setup = { ...S.setup, name: f.name.value, contactPhone: f.contactPhone.value };
}
document.addEventListener('input', (e) => {
  const rb = e.target.closest?.('[data-review-body]');
  if (rb) {
    const [orderId, target] = rb.dataset.reviewBody.split(':');
    S.review[orderId] = { ...(S.review[orderId] || {}), [`${target}Body`]: rb.value };
  }
});

/* Partner profile photo: uploaded as soon as it is chosen, checked by the server. */
document.addEventListener('change', async (e) => {
  const input = e.target.closest?.('[data-partner-photo]');
  if (!input || !input.files?.[0]) return;
  S.joinError = ''; S.photoBusy = true; render();
  try {
    const out = await quad.uploadPartnerPhoto(input.files[0]);
    S.photoVersion = Date.now();
    toast('Photo saved');
    S.joinNote = out.note;
  } catch (err) {
    S.joinError = explain(err);
  } finally {
    S.photoBusy = false; drop('me', 'join'); render();
  }
});

/* OTP boxes: one digit each, advancing as you type. */
document.addEventListener('input', (e) => {
  const box = e.target.closest('[data-otp]');
  if (!box) return;
  box.value = box.value.replace(/\D/g, '').slice(-1);
  if (box.value) box.nextElementSibling?.focus();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.sheet) { setSheet(null); return; }
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'ai-in') { e.preventDefault(); aiSend(); }
  const box = e.target.closest?.('[data-otp]');
  if (box && e.key === 'Backspace' && !box.value) box.previousElementSibling?.focus();
});

/* ---------- the two checkouts --------------------------------------------
   Each resolves when the customer leaves the checkout, by ANY route: paying,
   failing, closing the sheet, or pressing Back. None of them resolves with a
   result, because none of them knows one. What actually happened is a
   question only the server can answer, and openGateway() asks it below. */
async function openCashfree(intent) {
  if (!window.Cashfree) throw new Error('Payment gateway script is not loaded on this page.');
  const cf = window.Cashfree({ mode: intent.mode === 'sandbox' ? 'sandbox' : 'production' });
  await cf.checkout({
    paymentSessionId: intent.paymentSessionId,
    redirectTarget: '_modal',
  }).catch(() => {});                    // a dismissed sheet is not an error
}

async function openRazorpay(intent) {
  if (!window.Razorpay) throw new Error('Payment gateway script is not loaded on this page.');
  await new Promise((resolve) => {
    const rz = new window.Razorpay({
      key: intent.keyId, order_id: intent.gatewayOrderId,
      amount: intent.amountPaise, currency: intent.currency, name: BRAND,
      handler: () => resolve(),
      modal: { ondismiss: () => resolve() },
    });
    rz.open();
  });
}

/* ---------- payment gateway handoff --------------------------------------
   The gateway's own callback only stops the spinner. The order is confirmed
   by the server's webhook, so we poll the SERVER for the real state rather
   than believing anything the browser was told. */
async function openGateway(intent, draft) {
  const proceed = confirm(
    `${draft.items.map((i) => `${i.qty}× ${i.name}`).join('\n')}\n\n` +
    `Total: ${intent.amountDisplay}\n\nContinue to payment?`);
  if (!proceed) { await quad.cancelPayment(draft.id).catch(() => {}); return; }

  try {
    if (intent.provider === 'cashfree') await openCashfree(intent);
    else if (intent.provider === 'razorpay') await openRazorpay(intent);
    else throw new Error(`Unknown payment provider "${intent.provider}"`);
  } catch (e) {
    toast(e.message || 'The payment gateway could not be opened.', 'bad');
    return;
  }

  drop('orders', `order:${draft.id}`);
  for (let i = 0; i < 10; i++) {
    const st = await quad.paymentStatus(draft.id).catch(() => null);
    if (st?.confirmed) { S.cart = []; go('tracking', { id: draft.id }); return toast('Paid · order placed'); }
    if (st?.payment === 'failed') { go('checkout'); return toast('Payment failed — the order was not placed.', 'bad'); }
    await new Promise((r) => setTimeout(r, 1200));
  }
  go('tracking', { id: draft.id });
  toast('Waiting for confirmation from the payment gateway.');
}

/* ===================== boot ============================================= */
(async function boot() {
  render();
  try {
    const [me, status, campuses] = await Promise.all([quad.me(), quad.authStatus().catch(() => null),
      quad.campuses().catch(() => null)]);
    S.campuses = campuses?.campuses || [];
    S.me = me.authenticated ? me : null;
    S.providers = status?.providers || null;
  } catch (e) {
    if (e instanceof Offline) {
      document.getElementById('app').innerHTML = `<div class="shell"><div class="stage"><div class="device">
        <div class="screen no-nav">${Problem(e)}</div></div></div></div>`;
      return;
    }
  }
  go(!signedIn() ? 'welcome' : profileIncomplete() && S.me.roles?.includes('student') ? 'setup' : 'home');
})();
