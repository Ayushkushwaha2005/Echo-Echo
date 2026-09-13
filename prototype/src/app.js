/* ==========================================================================
   FRISCO — APPLICATION
   One store, one router, one component vocabulary. Every screen is reached
   from another screen; there are no orphan mocks.
   ========================================================================== */
import {
  CONFIG, PRICING, SERVICE_WINDOW, LOCATIONS, CAFETERIAS, MENU, MENU_CATEGORIES,
  ME, PARTNER, PARTNER_HISTORY, STAFF_QUEUE, RECENT_ORDERS, VERIFICATIONS,
  REPORTS, FLAGS, AI_SUGGESTIONS,
} from './data.js';

/* ===================== helpers ========================================== */
const $ = (s, r = document) => r.querySelector(s);
const money = (p) => CONFIG.currency + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const caf = (id) => CAFETERIAS.find((c) => c.id === id);
const item = (id) => MENU.find((m) => m.id === id);
const loc = (id) => LOCATIONS.find((l) => l.id === id);

/* ===================== store ============================================ */
const S = {
  role: 'student',
  route: 'welcome',
  params: {},
  onboarded: false,
  theme: null,
  cart: [],
  cafId: 'caf_frisco',
  locationId: 'loc_grnd',
  room: null,
  fulfilment: 'delivery',
  payment: null,
  order: null,
  orderStage: 0,
  noPartner: false,
  ai: { messages: [], draft: null, busy: false },
  partner: { ...PARTNER },
  offerLeft: 0,
  staffTab: 'placed',
  queue: STAFF_QUEUE.map((o) => ({ ...o })),
  flags: FLAGS.map((f) => ({ ...f })),
  sheet: null,
  toast: null,
  _timers: [],
};

function go(route, params = {}) {
  clearTimers();
  S.route = route; S.params = params; S.sheet = null;
  render();
  const sc = $('.screen'); if (sc) sc.scrollTop = 0;
}
function setSheet(name, params = {}) { S.sheet = name ? { name, params } : null; render(); }
function toast(msg, icon = '✓') {
  S.toast = { msg, icon }; render();
  setTimeout(() => { if (S.toast && S.toast.msg === msg) { S.toast = null; render(); } }, 2000);
}
function clearTimers() { S._timers.forEach(clearTimeout); S._timers = []; }
function later(fn, ms) { S._timers.push(setTimeout(fn, ms)); }

/* ===================== cart / pricing ===================================
   NOTE: every total below is computed here — the "server". The agent never
   does arithmetic; it only ever hands over item ids and quantities. (§12)  */
function cartLines() {
  return S.cart.map((l) => {
    const it = item(l.itemId);
    const delta = (l.opts || []).reduce((a, o) => a + o.delta, 0);
    return { ...l, it, unit: it.price + delta, line: (it.price + delta) * l.qty };
  });
}
function priceOrder(lines = cartLines(), fulfilment = S.fulfilment) {
  const subtotal = lines.reduce((a, l) => a + l.line, 0);
  const fee = fulfilment === 'delivery' ? PRICING.delivery_fee_paise : 0;
  return { subtotal, fee, total: subtotal + fee };
}
function cartCount() { return S.cart.reduce((a, l) => a + l.qty, 0); }
function addToCart(itemId, qty = 1, opts = []) {
  const it = item(itemId);
  if (!it.available) return toast(`${it.name} is unavailable`, '·');
  if (S.cart.length && item(S.cart[0].itemId).caf !== it.caf) {
    S.cart = []; toast('Started a new cart', '↻');
  }
  const key = JSON.stringify(opts.map((o) => o.label).sort());
  const ex = S.cart.find((l) => l.itemId === itemId && JSON.stringify((l.opts || []).map((o) => o.label).sort()) === key);
  if (ex) ex.qty += qty; else S.cart.push({ itemId, qty, opts });
  S.cafId = it.caf;
  toast(`${it.name} added`);
}
function bump(idx, d) {
  const l = S.cart[idx]; if (!l) return;
  l.qty += d; if (l.qty <= 0) S.cart.splice(idx, 1);
  render();
}

/* ===================== icons ============================================ */
const I = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M15 18l-6-6 6-6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M9 18l6-6-6-6"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
  ask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M12 3.5l1.9 4.7 4.7 1.9-4.7 1.9L12 16.7l-1.9-4.7L5.4 10l4.7-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M5 12h13M12 5l7 7-7 7"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 21s7-6.3 7-11a7 7 0 10-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M4 12.5l5.5 5.5L20 6.5"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 2l2.9 6.3 6.6.7-4.9 4.5 1.4 6.5L12 16.8 6 20l1.4-6.5L2.5 9l6.6-.7z"/></svg>',
  bike: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><circle cx="5.5" cy="17" r="3.2"/><circle cx="18.5" cy="17" r="3.2"/><path d="M8 17h7l-3-8h-3M12 9l2-4h3"/></svg>',
  bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 016 0v2"/></svg>',
};

/* ===================== shared components ================================ */
const Label = (t) => `<div class="t-label">${esc(t)}</div>`;

const TopBar = (title, { back = null, right = '', bordered = false, sub = '' } = {}) => `
  <div class="topbar ${bordered ? 'bordered' : ''}">
    ${back ? `<button class="backbtn" data-act="go" data-route="${back}" aria-label="Back">${I.back}</button>` : ''}
    <div class="grow">
      <div class="t-h2 truncate">${esc(title)}</div>
      ${sub ? `<div class="t-xs muted truncate">${esc(sub)}</div>` : ''}
    </div>
    ${right}
  </div>`;

const StatusPill = (open) => open
  ? `<span class="badge badge-open"><i class="dot dot-live"></i>Open</span>`
  : `<span class="badge badge-closed"><i class="dot"></i>Closed</span>`;

const VegMark = (veg) => `<span class="vmark ${veg ? '' : 'nonveg'}" role="img" aria-label="${veg ? 'Vegetarian' : 'Non-vegetarian'}"></span>`;

const LocLine = () => {
  const l = loc(S.locationId);
  return `<button class="row g1 t-sm" data-act="sheet" data-sheet="location" style="font-weight:700;color:var(--accent-text)">
    ${I.pin}<span>${esc(l.name)}${S.room ? ' · ' + esc(S.room) : ''}</span>${I.chev}</button>`;
};

const CafCard = (c) => `
  <button class="cafcard ${c.is_open ? '' : 'closed'}" data-act="menu" data-caf="${c.id}">
    <div class="cafcard-hero" style="background:${c.heroBg}">
      <span class="wm">${esc(c.name.toUpperCase())}</span>
      <div class="cafmark" style="background:${c.markBg}">${esc(c.mark)}</div>
    </div>
    <div class="between" style="align-items:flex-start">
      <div class="grow">
        <div class="t-h2">${esc(c.name)}</div>
        <div class="t-xs muted">${esc(c.kind)} · ${esc(c.location)}</div>
      </div>
      ${StatusPill(c.is_open)}
    </div>
    <div class="row g3 t-xs muted" style="margin-top:10px;flex-wrap:wrap">
      <span class="row g1">${I.star}<b style="color:var(--text)">${c.rating}</b></span>
      <span>~${c.prep_minutes} min prep</span>
      <span>${esc(c.tags.join(' · '))}</span>
    </div>
  </button>`;

const ItemRow = (m, { compact = false } = {}) => {
  const inCart = S.cart.filter((l) => l.itemId === m.id).reduce((a, l) => a + l.qty, 0);
  const hasOpts = (m.options || []).length > 0;
  return `
  <div class="item ${m.available ? '' : 'unavailable'}">
    <div class="grow item-main">
      <div class="row g2" style="margin-bottom:3px">${VegMark(m.veg)}
        ${m.popular ? '<span class="badge badge-rose">Popular</span>' : ''}
        ${!m.available ? '<span class="badge badge-closed">Unavailable</span>' : ''}
      </div>
      <div class="t-h3">${esc(m.name)}</div>
      <div class="money t-body" style="margin:2px 0 4px">${money(m.price)}</div>
      ${compact ? '' : `<div class="t-xs muted">${esc(m.desc)}</div>`}
      ${!m.available ? `<div class="t-xs" style="color:var(--warn);margin-top:6px">Back tomorrow morning — the counter has marked this out of stock.</div>` : ''}
    </div>
    <div class="item-thumbwrap">
      <div class="item-thumb">${m.glyph}</div>
      ${m.available
        ? (inCart
          ? `<span class="item-add" style="border-style:solid;background:var(--accent);color:var(--text-on-rose);border-color:var(--accent)">${inCart} added</span>`
          : `<button class="item-add" data-act="${hasOpts ? 'opts' : 'add'}" data-item="${m.id}">${hasOpts ? 'ADD +' : 'ADD +'}</button>`)
        : `<span class="item-add" style="border-color:var(--line-strong);color:var(--text-faint)">Sold out</span>`}
    </div>
  </div>`;
};

const BottomNav = () => {
  if (S.role === 'student') {
    const at = (r) => (S.route === r ? 'aria-current="page"' : '');
    return `<nav class="bottomnav">
      <button class="navbtn" ${at('home')} data-act="go" data-route="home">${I.home}<span>Home</span></button>
      <button class="navbtn" ${at('cafes')} data-act="go" data-route="cafes">${I.grid}<span>Cafés</span></button>
      <button class="nav-ai" ${at('ai')} data-act="go" data-route="ai" aria-label="Ask Frisco">${I.ask}</button>
      <button class="navbtn" ${at('orders')} data-act="go" data-route="orders">${I.receipt}<span>Orders</span></button>
      <button class="navbtn" ${at('profile')} data-act="go" data-route="profile">${I.user}<span>You</span></button>
    </nav>`;
  }
  if (S.role === 'partner') {
    const at = (r) => (S.route === r ? 'aria-current="page"' : '');
    return `<nav class="bottomnav">
      <button class="navbtn" ${at('p-home')} data-act="go" data-route="p-home">${I.home}<span>Home</span></button>
      <button class="navbtn" ${at('p-earnings')} data-act="go" data-route="p-earnings">${I.receipt}<span>Earnings</span></button>
      <button class="navbtn" ${at('p-history')} data-act="go" data-route="p-history">${I.grid}<span>History</span></button>
      <button class="navbtn" ${at('p-profile')} data-act="go" data-route="p-profile">${I.user}<span>You</span></button>
    </nav>`;
  }
  return '';
};

/* ===================== STUDENT: onboarding ============================== */
function ScrWelcome() {
  return `<div class="screen no-nav" style="display:flex;flex-direction:column">
    <div class="poster poster-grid" style="border-radius:0;flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding:var(--s-6) var(--s-5) var(--s-7)">
      <div class="poster-arc" style="width:230px;height:230px;top:-70px;right:-70px"></div>
      <div class="poster-arc" style="width:120px;height:120px;top:110px;left:-50px;background:var(--coral-400);opacity:.28"></div>
      <div class="stack g5 enter">
        <div class="row g2"><div class="cafmark" style="background:var(--surface-ink);width:40px;height:40px;border-radius:12px;font-size:1rem">f.</div>
          <span class="t-label" style="color:var(--text-2)">${esc(CONFIG.college)}</span></div>
        <h1 class="t-hero">Food from your campus.<br>Brought to wherever<br>you <em style="font-style:normal;color:var(--accent-text)">actually are</em>.</h1>
        <p class="t-body" style="color:var(--text-2);max-width:30ch">Library, ground, labs, LT-3, hostel block. Order from campus cafés, delivered by students between classes.</p>
        <div class="row g2" style="flex-wrap:wrap">
          <span class="sticker">Campus only</span>
          <span class="badge badge-ink">8 AM – 6 PM</span>
          <span class="badge badge-rose">3 cafés live</span>
        </div>
      </div>
    </div>
    <div class="pad stack g3" style="padding-block:var(--s-5) var(--s-6);background:var(--bg)">
      <button class="btn btn-primary btn-lg btn-block" data-act="go" data-route="ob-email">Continue with college email</button>
      <p class="t-xs faint center">Only verified <b class="code">@${CONFIG.emailDomain}</b> accounts can order. That's the whole point.</p>
    </div>
  </div>`;
}

function ScrObEmail() {
  return `<div class="screen no-nav">
    ${TopBar('', { back: 'welcome' })}
    <div class="pad stack g5 enter" style="padding-top:var(--s-3)">
      <div class="stack g2">
        ${Label('Step 1 of 3 · Identity')}
        <h1 class="t-display">Which college<br>email is yours?</h1>
        <p class="t-sm muted">We send a 6-digit code. No password to forget.</p>
      </div>
      <div class="field">
        <label class="t-label" for="ob-mail">College email</label>
        <input class="input" id="ob-mail" type="email" value="ayush.k23@${CONFIG.emailDomain}" autocomplete="email">
        <p class="t-xs faint">Must end in @${CONFIG.emailDomain}</p>
      </div>
      <button class="btn btn-primary btn-lg btn-block" data-act="go" data-route="ob-otp">Send code</button>
      <div class="campusnote">
        <span style="font-size:1.1rem">🔒</span>
        <p class="t-xs" style="color:var(--text-2)">Your roll number is matched against the college roster. This is what keeps Frisco a closed campus network — and what makes every order accountable to a real student.</p>
      </div>
    </div>
  </div>`;
}

function ScrObOtp() {
  return `<div class="screen no-nav">
    ${TopBar('', { back: 'ob-email' })}
    <div class="pad stack g5 enter" style="padding-top:var(--s-3)">
      <div class="stack g2">
        ${Label('Step 2 of 3 · Verify')}
        <h1 class="t-display">Check your inbox.</h1>
        <p class="t-sm muted">Code sent to <b class="code" style="color:var(--text)">ayush.k23@${CONFIG.emailDomain}</b></p>
      </div>
      <div class="otp">${[4, 1, 7, 2, '', ''].map((v, i) =>
        `<input inputmode="numeric" maxlength="1" value="${v}" aria-label="Digit ${i + 1}">`).join('')}</div>
      <button class="btn btn-primary btn-lg btn-block" data-act="go" data-route="ob-profile">Verify &amp; continue</button>
      <button class="btn btn-ghost btn-block t-sm">Resend in 0:24</button>
    </div>
  </div>`;
}

function ScrObProfile() {
  return `<div class="screen no-nav">
    ${TopBar('', { back: 'ob-otp' })}
    <div class="pad stack g5 enter" style="padding-top:var(--s-3)">
      <div class="stack g2">
        ${Label('Step 3 of 3 · You')}
        <h1 class="t-display">Almost done,<br>${esc(ME.first)}.</h1>
      </div>
      <div class="card card-pad stack g4">
        <div class="row g3">
          <div class="avatar avatar-lg">${ME.initials}</div>
          <div class="grow">
            <div class="t-h2">${esc(ME.name)}</div>
            <div class="t-xs muted code">${esc(ME.roll)}</div>
            <span class="badge badge-open" style="margin-top:6px"><i class="dot"></i>Roster matched</span>
          </div>
        </div>
        <hr class="dashline">
        <div class="field">
          <label class="t-label" for="ob-ph">Phone — for delivery calls only</label>
          <input class="input" id="ob-ph" value="+91 98765 44417" inputmode="tel">
        </div>
      </div>
      <div class="stack g2">
        ${Label('Where are you usually?')}
        <div class="chiprow" style="padding-inline:0;flex-wrap:wrap">
          ${LOCATIONS.slice(0, 4).map((l) => `<button class="chip" data-act="setloc" data-loc="${l.id}" ${S.locationId === l.id ? 'aria-pressed="true"' : ''}>${l.glyph} ${esc(l.name)}</button>`).join('')}
        </div>
        <p class="t-xs faint">You can change this on every order. Only campus locations exist here.</p>
      </div>
      <button class="btn btn-primary btn-lg btn-block" data-act="finishOb">Start ordering</button>
    </div>
  </div>`;
}

/* ===================== STUDENT: home ==================================== */
function ScrHome() {
  const hour = 13;
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const popular = MENU.filter((m) => m.popular && m.available).slice(0, 6);
  const active = S.order && S.orderStage < 6;

  return `<div class="screen">
    <div class="topbar">
      <div class="grow stack">
        <div class="t-xs muted">${greet}, ${esc(ME.first)}</div>
        ${LocLine()}
      </div>
      <button class="avatar avatar-sm" data-act="go" data-route="profile" aria-label="Profile">${ME.initials}</button>
    </div>

    <div class="pad stack g5 enter">
      ${active ? ActiveOrderCard() : ''}

      <button class="poster poster-grid" data-act="go" data-route="ai" style="text-align:left;width:100%;border:0;padding:var(--s-5);cursor:pointer">
        <div class="poster-arc" style="width:150px;height:150px;bottom:-70px;right:-40px"></div>
        <div class="stack g3">
          <div class="row g2"><span class="ai-mark">f.</span><span class="t-label">Ask Frisco</span></div>
          <div class="t-display" style="font-size:1.72rem">Tell Frisco<br>what you want.</div>
          <p class="t-sm" style="color:var(--text-2)">“Ground pe 2 cold coffee aur ek burger bhej do” — it reads Hinglish, builds the order, you confirm.</p>
          <span class="btn btn-ink btn-sm btn-pill" style="align-self:flex-start;margin-top:2px">Start ordering ${I.chev}</span>
        </div>
      </button>

      <div class="stack g3">
        <div class="between">${Label('Campus cafés')}<button class="t-xs" data-act="go" data-route="cafes" style="color:var(--accent-text);font-weight:700">See all</button></div>
        <div class="stack g3">${CAFETERIAS.map(CafCard).join('')}</div>
        <button class="addcaf" data-act="sheet" data-sheet="addcaf">
          <div class="cafmark" style="background:var(--bg-sunken);color:var(--text-faint);font-size:1.5rem">+</div>
          <div class="grow">
            <div class="t-h3">Add another cafeteria</div>
            <div class="t-xs muted">New outlets are onboarded by campus admin — no app update needed</div>
          </div>
          ${I.chev}
        </button>
      </div>

      <div class="stack g3">
        ${Label('Popular right now')}
        <div class="chiprow" style="padding-inline:0">
          ${popular.map((m) => `<button class="chip" data-act="add" data-item="${m.id}">
            <span>${m.glyph}</span><span>${esc(m.name)}</span><span class="money t-xs" style="color:var(--accent-text)">${money(m.price)}</span>
          </button>`).join('')}
        </div>
      </div>

      <div class="stack g3">
        ${Label('Order again')}
        <div class="stack g2">
          ${RECENT_ORDERS.slice(0, 2).map((o) => `
            <button class="tile row g3" data-act="menu" data-caf="${o.caf}" style="width:100%;text-align:left">
              <div class="cafmark" style="width:38px;height:38px;border-radius:11px;font-size:.85rem;background:${caf(o.caf).markBg}">${caf(o.caf).mark}</div>
              <div class="grow"><div class="t-sm" style="font-weight:700">${esc(o.items)}</div>
              <div class="t-xs muted">${esc(caf(o.caf).name)} · ${esc(o.when)}</div></div>
              <span class="money t-sm">${money(o.total)}</span>
            </button>`).join('')}
        </div>
      </div>

      <div class="tile row g3" style="background:var(--surface-blush);border-color:transparent">
        <span style="font-size:1.3rem">🛍️</span>
        <div class="grow"><div class="t-h3">In a hurry? Self pickup</div>
        <div class="t-xs muted">Skip the delivery fee, collect from the counter</div></div>
        <button class="btn btn-secondary btn-sm" data-act="pickupMode">Pick up</button>
      </div>
    </div>
  </div>`;
}

function ActiveOrderCard() {
  const stages = ['Order placed', 'Cafeteria accepted', 'Preparing', 'Ready', 'Picked up', 'On the way', 'Delivered'];
  return `<button class="card card-raise card-pad stack g3" data-act="go" data-route="tracking" style="width:100%;text-align:left;background:var(--surface-ink);color:var(--text-on-ink);border:0">
    <div class="between">
      <span class="badge" style="background:rgba(255,255,255,.14);color:var(--text-on-ink)"><i class="dot dot-live"></i>Live order</span>
      <span class="code t-xs" style="opacity:.7">#${esc(S.order.code)}</span>
    </div>
    <div class="t-h2">${esc(stages[S.orderStage])}</div>
    <div class="t-xs" style="opacity:.72">${esc(caf(S.order.cafId).name)} → ${esc(S.order.fulfilment === 'delivery' ? loc(S.order.locationId).name : 'Self pickup')}</div>
    <div class="row g1" style="margin-top:2px">
      ${stages.map((_, i) => `<i style="height:3px;flex:1;border-radius:2px;background:${i <= S.orderStage ? 'var(--accent)' : 'rgba(255,255,255,.2)'}"></i>`).join('')}
    </div>
  </button>`;
}

/* ===================== STUDENT: cafés + menu ============================ */
function ScrCafes() {
  return `<div class="screen">
    ${TopBar('Campus cafés', { sub: `${CAFETERIAS.filter(c => c.is_open).length} open now · ${SERVICE_WINDOW.opens}–${SERVICE_WINDOW.closes}` })}
    <div class="pad stack g4 enter">
      <div class="poster" style="padding:var(--s-5)">
        <div class="poster-arc" style="width:140px;height:140px;top:-50px;right:-40px"></div>
        <div class="t-label">Campus zones</div>
        <div class="t-display" style="font-size:1.5rem;margin-top:6px">Three counters,<br>one campus.</div>
        <div class="row g2" style="margin-top:12px;flex-wrap:wrap">
          ${['Z1 Academic', 'Z2 Ground', 'Z3 Hostel'].map((z) => `<span class="badge badge-ink">${z}</span>`).join('')}
        </div>
      </div>
      ${CAFETERIAS.map(CafCard).join('')}
      <button class="addcaf" data-act="sheet" data-sheet="addcaf">
        <div class="cafmark" style="background:var(--bg-sunken);color:var(--text-faint);font-size:1.5rem">+</div>
        <div class="grow"><div class="t-h3">Add another cafeteria</div>
        <div class="t-xs muted">Admin-managed capability, not a fourth outlet</div></div>${I.chev}
      </button>
    </div>
  </div>`;
}

function ScrMenu() {
  const c = caf(S.params.caf || S.cafId);
  const cats = MENU_CATEGORIES(c.id);
  const items = MENU.filter((m) => m.caf === c.id);
  const count = cartCount();
  return `<div class="screen">
    <div class="poster" style="border-radius:0;background:${c.heroBg};padding:var(--s-4) var(--s-4) var(--s-5)">
      <div class="row g3" style="margin-bottom:var(--s-4)">
        <button class="backbtn" data-act="go" data-route="cafes" aria-label="Back">${I.back}</button>
      </div>
      <span class="wm" style="position:absolute;right:-8px;top:36px;font-family:var(--font-display);font-weight:800;font-size:5rem;opacity:.14;letter-spacing:-.05em;color:var(--ink-900)">${esc(c.name.toUpperCase())}</span>
      <div class="row g3">
        <div class="cafmark" style="background:${c.markBg}">${esc(c.mark)}</div>
        <div class="grow">
          <div class="t-h1">${esc(c.name)}</div>
          <div class="t-xs" style="color:var(--text-2)">${esc(c.kind)} · ${esc(c.location)}</div>
        </div>
      </div>
      <div class="row g3 t-xs" style="margin-top:var(--s-4);flex-wrap:wrap;color:var(--text-2)">
        ${StatusPill(c.is_open)}
        <span class="row g1">${I.star}<b>${c.rating}</b></span>
        <span>~${c.prep_minutes} min</span>
        <span>${c.orders_today} orders today</span>
      </div>
    </div>

    <div class="chiprow" style="padding-block:var(--s-4)">
      ${cats.map((cat, i) => `<button class="chip" ${i === 0 ? 'aria-pressed="true"' : ''}>${esc(cat)}</button>`).join('')}
    </div>

    <div class="pad stack g5">
      ${cats.map((cat) => `
        <div class="stack g1">
          ${Label(cat)}
          <div>${items.filter((m) => m.cat === cat).map((m) => ItemRow(m)).join('')}</div>
        </div>`).join('')}
    </div>

    ${count ? CartBar() : ''}
  </div>`;
}

const CartBar = () => {
  const { total } = priceOrder();
  return `<div class="actionbar">
    <button class="cartbar" data-act="go" data-route="cart" style="width:100%;text-align:left">
      <span class="badge" style="background:var(--accent);color:var(--text-on-rose)">${cartCount()}</span>
      <div class="grow"><div class="t-sm" style="font-weight:700">View cart</div>
      <div class="t-xs" style="opacity:.7">${esc(caf(S.cafId).name)}</div></div>
      <span class="money">${money(total)}</span>${I.chev}
    </button>
  </div>`;
};

/* ===================== STUDENT: cart / checkout ========================= */
function ScrCart() {
  const lines = cartLines();
  if (!lines.length) {
    return `<div class="screen">${TopBar('Your cart', { back: 'home' })}
      <div class="empty">
        <div class="empty-art">🛒</div>
        <div class="t-h2">Nothing here yet.</div>
        <p class="t-sm muted">Pick a café, or just tell Frisco what you're craving.</p>
        <div class="row g2" style="margin-top:8px">
          <button class="btn btn-secondary btn-sm" data-act="go" data-route="cafes">Browse cafés</button>
          <button class="btn btn-primary btn-sm" data-act="go" data-route="ai">Ask Frisco</button>
        </div>
      </div></div>`;
  }
  const p = priceOrder();
  const c = caf(S.cafId);
  return `<div class="screen">
    ${TopBar('Your cart', { back: 'menu', sub: c.name })}
    <div class="pad stack g4 enter">
      <div class="card card-pad stack g3">
        ${lines.map((l, i) => `
          <div class="row g3">
            ${VegMark(l.it.veg)}
            <div class="grow">
              <div class="t-h3">${esc(l.it.name)}</div>
              ${(l.opts || []).length ? `<div class="t-xs muted">${esc(l.opts.map(o => o.label).join(', '))}</div>` : ''}
              <div class="t-xs muted">${money(l.unit)} each</div>
            </div>
            <div class="qty"><button data-act="bump" data-i="${i}" data-d="-1" aria-label="Remove one">−</button><span>${l.qty}</span><button data-act="bump" data-i="${i}" data-d="1" aria-label="Add one">+</button></div>
            <span class="money t-sm" style="min-width:56px;text-align:right">${money(l.line)}</span>
          </div>`).join('')}
        <button class="btn btn-ghost btn-sm" data-act="menu" data-caf="${c.id}" style="align-self:flex-start;padding-inline:0;color:var(--accent-text)">+ Add more from ${esc(c.name)}</button>
      </div>

      <div class="stack g2">
        ${Label('How do you want it?')}
        <div class="row g3">
          <button class="loccard grow" data-act="setfulfil" data-f="delivery" ${S.fulfilment === 'delivery' ? 'aria-pressed="true"' : ''}>
            <span class="glyph">🚴</span><span class="t-h3">Delivery</span>
            <span class="t-xs muted">+${money(PRICING.delivery_fee_paise)} · brought to you</span>
          </button>
          <button class="loccard grow" data-act="setfulfil" data-f="pickup" ${S.fulfilment === 'pickup' ? 'aria-pressed="true"' : ''}>
            <span class="glyph">🛍️</span><span class="t-h3">Self pickup</span>
            <span class="t-xs muted">No fee · collect at counter</span>
          </button>
        </div>
      </div>

      ${S.fulfilment === 'delivery' ? `
      <button class="tile row g3" data-act="sheet" data-sheet="location" style="width:100%;text-align:left">
        <span style="font-size:1.3rem">${loc(S.locationId).glyph}</span>
        <div class="grow"><div class="t-label">Deliver to</div>
        <div class="t-h3">${esc(loc(S.locationId).name)}${S.room ? ' · ' + esc(S.room) : ''}</div></div>
        <span class="t-xs" style="color:var(--accent-text);font-weight:700">Change</span>
      </button>` : `
      <div class="tile row g3">
        <span style="font-size:1.3rem">🛍️</span>
        <div class="grow"><div class="t-label">Collect from</div>
        <div class="t-h3">${esc(c.name)}</div><div class="t-xs muted">${esc(c.location)}</div></div>
      </div>`}

      ${Bill(p)}
    </div>
    <div class="actionbar">
      <button class="btn btn-primary btn-lg btn-block" data-act="go" data-route="checkout">Continue · ${money(p.total)}</button>
    </div>
  </div>`;
}

const Bill = (p) => `
  <div class="card card-pad stack g2">
    ${Label('Bill')}
    <div class="between t-sm"><span class="muted">Item total</span><span class="money t-sm">${money(p.subtotal)}</span></div>
    <div class="between t-sm"><span class="muted">${p.fee ? 'Campus delivery' : 'Self pickup'}</span><span class="money t-sm">${p.fee ? money(p.fee) : 'Free'}</span></div>
    <hr class="dashline" style="margin-block:4px">
    <div class="between"><span class="t-h3">Total</span><span class="money t-h1">${money(p.total)}</span></div>
    <p class="t-xs faint">Priced by Frisco's server at confirmation. Item prices are frozen onto your order.</p>
  </div>`;

function ScrCheckout() {
  const p = priceOrder();
  const c = caf(S.cafId);
  return `<div class="screen">
    ${TopBar('Confirm & pay', { back: 'cart' })}
    <div class="pad stack g4 enter">
      <div class="card card-pad stack g3">
        <div class="between">${Label('Your order')}<span class="badge badge-rose">${esc(c.name)}</span></div>
        ${cartLines().map((l) => `<div class="between t-sm"><span>${esc(l.it.name)} × ${l.qty}</span><span class="money t-sm">${money(l.line)}</span></div>`).join('')}
      </div>
      <div class="tile row g3">
        <span style="font-size:1.2rem">${S.fulfilment === 'delivery' ? loc(S.locationId).glyph : '🛍️'}</span>
        <div class="grow">
          <div class="t-label">${S.fulfilment === 'delivery' ? 'Delivering to' : 'Collecting from'}</div>
          <div class="t-h3">${S.fulfilment === 'delivery' ? esc(loc(S.locationId).name) + (S.room ? ' · ' + esc(S.room) : '') : esc(c.name)}</div>
        </div>
      </div>
      ${Bill(p)}
      <div class="stack g2">
        ${Label('Payment method')}
        <div class="row g3">
          <button class="loccard grow" data-act="setpay" data-p="online" ${S.payment === 'online' ? 'aria-pressed="true"' : ''}>
            <span class="glyph">📲</span><span class="t-h3">Online Pay</span><span class="t-xs muted">UPI · paid now</span></button>
          <button class="loccard grow" data-act="setpay" data-p="cash" ${S.payment === 'cash' ? 'aria-pressed="true"' : ''}>
            <span class="glyph">💵</span><span class="t-h3">Cash</span><span class="t-xs muted">Pay on ${S.fulfilment === 'delivery' ? 'delivery' : 'collection'}</span></button>
        </div>
        ${S.payment === 'cash' ? `<div class="campusnote"><span>💡</span><p class="t-xs" style="color:var(--text-2)">Keep ${money(p.total)} ready. Your partner carries limited change — cash is tracked to your account until settled.</p></div>` : ''}
      </div>
    </div>
    <div class="actionbar">
      <button class="btn btn-primary btn-lg btn-block" data-act="placeOrder" ${S.payment ? '' : 'disabled'}>
        ${S.payment === 'cash' ? `Place order · pay ${money(p.total)} on arrival` : S.payment === 'online' ? `Pay ${money(p.total)} & place order` : 'Choose a payment method'}
      </button>
    </div>
  </div>`;
}

/* ===================== STUDENT: tracking ================================ */
const STAGES = [
  { t: 'Order placed', d: 'Sent to the counter' },
  { t: 'Cafeteria accepted', d: 'Your order is confirmed' },
  { t: 'Preparing', d: 'On the counter now' },
  { t: 'Ready', d: 'Packed and waiting' },
  { t: 'Partner assigned', d: 'A student is picking it up' },
  { t: 'Picked up', d: 'On the way to you' },
  { t: 'Delivered', d: 'Enjoy 🎉' },
];

function ScrTracking() {
  if (!S.order) return ScrOrders();
  const o = S.order, c = caf(o.cafId);
  const pickup = o.fulfilment === 'pickup';
  const stages = pickup
    ? [STAGES[0], STAGES[1], STAGES[2], { t: 'Ready for pickup', d: 'Collect from the counter' }, { t: 'Collected', d: 'Enjoy 🎉' }]
    : STAGES;
  const stage = Math.min(S.orderStage, stages.length - 1);

  return `<div class="screen">
    ${TopBar(`Order #${o.code}`, { back: 'home', sub: `${c.name} · ${pickup ? 'Self pickup' : 'Campus delivery'}` })}
    <div class="pad stack g4 enter">

      ${S.noPartner ? NoPartnerCard() : ''}

      <div class="card card-raise card-pad stack g3">
        <div class="between">
          <div class="stack">
            ${Label(pickup ? 'Self pickup' : 'Estimated arrival')}
            <div class="t-h1">${stage >= stages.length - 1 ? 'Delivered' : pickup ? `${c.prep_minutes} min` : `${c.prep_minutes + 5} min`}</div>
          </div>
          <span class="badge ${stage >= stages.length - 1 ? 'badge-open' : 'badge-rose'}"><i class="dot ${stage < stages.length - 1 ? 'dot-live' : ''}"></i>${esc(stages[stage].t)}</span>
        </div>
        ${!pickup && stage >= 4 ? PartnerStrip() : ''}
        ${pickup && stage >= 3 ? `
          <hr class="dashline">
          <div class="stack g2 center" style="padding-top:4px">
            ${Label('Show this at the counter')}
            <div class="codebox">${'7412'.split('').map(d => `<b>${d}</b>`).join('')}</div>
          </div>` : ''}
      </div>

      <div class="card card-pad">
        ${Label('Progress')}
        <div class="timeline" style="margin-top:var(--s-3)">
          ${stages.map((s, i) => {
            const st = i < stage ? 'done' : i === stage ? 'active' : 'pending';
            return `<div class="tl-step ${st}">
              <div class="tl-rail"><div class="tl-node">${i < stage ? I.check : ''}</div>${i < stages.length - 1 ? '<div class="tl-line"></div>' : ''}</div>
              <div class="tl-body"><div class="tl-title">${esc(s.t)}</div><div class="t-xs muted">${esc(s.d)}</div></div>
            </div>`;
          }).join('')}
        </div>
      </div>

      <div class="card card-pad ticket stack g2" style="--notch:64px">
        <div class="between">${Label('Receipt')}<span class="code t-xs muted">#${esc(o.code)}</span></div>
        ${o.lines.map((l) => `<div class="between t-sm"><span>${esc(l.name)} × ${l.qty}</span><span class="money t-sm">${money(l.line)}</span></div>`).join('')}
        <hr class="dashline" style="margin-block:6px">
        <div class="between t-sm"><span class="muted">${o.fee ? 'Campus delivery' : 'Self pickup'}</span><span class="money t-sm">${o.fee ? money(o.fee) : 'Free'}</span></div>
        <div class="between"><span class="t-h3">Total · ${o.payment === 'cash' ? 'Cash' : 'Paid online'}</span><span class="money t-h2">${money(o.total)}</span></div>
      </div>

      <div class="row g2">
        <button class="btn btn-secondary btn-sm grow" data-act="sheet" data-sheet="report">Report an issue</button>
        ${stage < 2 ? `<button class="btn btn-danger btn-sm grow" data-act="cancel">Cancel order</button>` : ''}
      </div>

      <div class="tile stack g2" style="background:var(--bg-sunken);border-style:dashed">
        ${Label('Pilot demo controls')}
        <div class="row g2" style="flex-wrap:wrap">
          <button class="chip" data-act="advance">Advance status</button>
          <button class="chip" data-act="simNoPartner">Simulate: no partner</button>
        </div>
      </div>
    </div>
  </div>`;
}

const PartnerStrip = () => `
  <hr class="dashline">
  <div class="row g3" style="padding-top:4px">
    <div class="avatar">IR</div>
    <div class="grow">
      <div class="t-h3">Ishita is bringing your order</div>
      <div class="row g2 t-xs muted">
        <span class="row g1" style="color:var(--warn)">${I.star}<b style="color:var(--text)">4.9</b></span>
        <span>·</span><span>Verified campus partner</span>
      </div>
    </div>
    <button class="backbtn" aria-label="Call partner">📞</button>
  </div>
  <div class="sunken row g3" style="padding:var(--s-3);margin-top:4px">
    <div class="grow"><div class="t-label">Give this code on arrival</div>
      <div class="code" style="font-size:1.35rem;letter-spacing:.22em;font-weight:500">3 9 0 4</div></div>
    <span style="font-size:1.4rem">🤝</span>
  </div>`;

const NoPartnerCard = () => `
  <div class="card card-pad stack g3" style="background:var(--warn-bg);border-color:transparent">
    <div class="row g2"><span style="font-size:1.2rem">🚴</span><div class="t-h2">Everyone's busy right now.</div></div>
    <p class="t-sm" style="color:var(--text-2)">No student partner is free at the moment. Your food is being made either way — here's what you can do.</p>
    <div class="stack g2">
      <button class="btn btn-primary btn-block" data-act="switchPickup">Switch to self pickup · refund ${money(PRICING.delivery_fee_paise)}</button>
      <div class="row g2">
        <button class="btn btn-secondary btn-sm grow" data-act="retryPartner">Try again</button>
        <button class="btn btn-ghost btn-sm grow" data-act="cancel">Cancel, no charge</button>
      </div>
    </div>
  </div>`;

function ScrOrders() {
  return `<div class="screen">
    ${TopBar('Your orders')}
    <div class="pad stack g4 enter">
      ${S.order && S.orderStage < 6 ? ActiveOrderCard() : ''}
      ${Label('Earlier')}
      <div class="stack g2">
        ${RECENT_ORDERS.map((o) => `
          <div class="tile row g3">
            <div class="cafmark" style="width:38px;height:38px;border-radius:11px;font-size:.85rem;background:${caf(o.caf).markBg}">${caf(o.caf).mark}</div>
            <div class="grow"><div class="t-sm" style="font-weight:700">${esc(o.items)}</div>
            <div class="t-xs muted">${esc(caf(o.caf).name)} · ${esc(o.when)} · ${o.loc ? esc(o.loc) : 'Picked up'}</div></div>
            <div class="stack" style="align-items:flex-end"><span class="money t-sm">${money(o.total)}</span>
            <span class="badge badge-open" style="margin-top:3px">${esc(o.status)}</span></div>
          </div>`).join('')}
      </div>
    </div>
  </div>`;
}

function ScrProfile() {
  return `<div class="screen">
    ${TopBar('You')}
    <div class="pad stack g4 enter">
      <div class="poster" style="padding:var(--s-5)">
        <div class="poster-arc" style="width:130px;height:130px;top:-50px;right:-30px"></div>
        <div class="row g3">
          <div class="avatar avatar-lg">${ME.initials}</div>
          <div class="grow"><div class="t-h1">${esc(ME.name)}</div>
            <div class="t-xs code muted">${esc(ME.roll)} · ${esc(ME.email)}</div>
            <span class="badge badge-open" style="margin-top:6px"><i class="dot"></i>Tier ${ME.tier} verified</span></div>
        </div>
      </div>
      <div class="stack g2">
        ${Label('Account')}
        <div class="card" style="overflow:hidden">
          ${[['🏠', 'Saved campus spots', `${LOCATIONS.length} locations`],
             ['🧾', 'Order history', `${RECENT_ORDERS.length} orders`],
             ['🚴', 'Deliver with Frisco', 'You are a verified partner'],
             ['🛟', 'Help & report an issue', ''],
             ['📜', 'Campus policy', 'How penalties actually work']].map(([g, t, s]) => `
            <button class="adminrow" style="width:100%;text-align:left">
              <span style="font-size:1.1rem">${g}</span>
              <div class="grow"><div class="t-sm" style="font-weight:700">${t}</div>${s ? `<div class="t-xs muted">${s}</div>` : ''}</div>
              ${I.chev}</button>`).join('')}
        </div>
      </div>
      <p class="t-xs faint center">Frisco · ${esc(CONFIG.college)}<br>Campus delivery ${SERVICE_WINDOW.opens}–${SERVICE_WINDOW.closes}, every day</p>
    </div>
  </div>`;
}

/* ===================== AI AGENT =========================================
   A real parser. Quantities (digits + Hindi number words), items resolved
   against menu aliases, campus location resolved from the whitelist, budget
   + mood for recommendations, and an explicit off-campus refusal.
   The agent produces item ids + quantities ONLY. Pricing is server-side.  */

const NUMWORDS = { ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, one: 1, two: 2, three: 3, four: 4, five: 5, a: 1, an: 1, kuch: 1 };
const OFFCAMPUS = ['outside', 'bahar', 'off campus', 'main gate', 'gate ke bahar', 'home', 'ghar', 'sector', 'society', 'city', 'station', 'market', 'pg '];
const LOCWORDS = [
  { id: 'loc_grnd', w: ['ground', 'maidan', 'basketball', 'court', 'field'] },
  { id: 'loc_lib', w: ['library', 'lib', 'reading hall'] },
  { id: 'loc_lab', w: ['lab', 'labs', 'cs lab', 'workshop'] },
  { id: 'loc_aud', w: ['auditorium', 'audi'] },
  { id: 'loc_hostel', w: ['hostel', 'block a', 'block b', 'block c', 'room'] },
  { id: 'loc_ab', w: ['class', 'classroom', 'academic', 'ab-', 'lt-', 'lecture'] },
];

function parseOrder(text) {
  const t = ' ' + text.toLowerCase().replace(/[,.!]/g, ' ').replace(/\s+/g, ' ') + ' ';

  // 1. campus boundary — refuse before anything else
  if (OFFCAMPUS.some((w) => t.includes(w))) return { kind: 'offcampus' };

  // 2. location
  let locId = null;
  for (const L of LOCWORDS) if (L.w.some((w) => t.includes(w))) { locId = L.id; break; }

  // 3. budget + mood → recommendation
  const budget = t.match(/(?:₹|rs\.?\s?)?(\d{2,4})\s*(?:ke andar|ke under|under|tak|budget|rupee|rs)/);
  const moods = ['spicy', 'filling', 'light', 'sweet', 'cold', 'hot', 'crispy'];
  const mood = moods.filter((m) => t.includes(m));
  const wantsRec = (budget && mood.length) || (mood.length && !/\d/.test(t) && !MENU.some(m => matchIn(t, m)));

  // 4. items + quantities
  const found = [];
  for (const m of MENU) {
    const hit = matchIn(t, m);
    if (!hit) continue;
    const before = t.slice(Math.max(0, hit.idx - 14), hit.idx);
    const dm = before.match(/(\d+)\s*(?:x|×)?\s*$/);
    const wm = before.match(/\b([a-z]+)\s*$/);
    const qty = dm ? parseInt(dm[1], 10) : (wm && NUMWORDS[wm[1]] ? NUMWORDS[wm[1]] : 1);
    found.push({ id: m.id, caf: m.caf, qty: Math.min(qty, 20), at: hit.idx, len: hit.len });
  }
  // longest-match wins on overlap (so "cold coffee" beats "coffee")
  found.sort((a, b) => b.len - a.len);
  const taken = [];
  const items = found.filter((f) => {
    if (taken.some((r) => f.at < r.end && f.at + f.len > r.start)) return false;
    taken.push({ start: f.at, end: f.at + f.len }); return true;
  });

  if (wantsRec && !items.length) return { kind: 'recommend', budget: budget ? +budget[1] * 100 : 15000, mood, locId };
  if (!items.length) return { kind: 'unknown', locId };

  // 5. ambiguity: the same dish exists at more than one café
  const cafs = [...new Set(items.map((i) => i.caf))];
  if (cafs.length > 1) {
    const counts = cafs.map((c) => ({ c, n: items.filter((i) => i.caf === c).length }));
    counts.sort((a, b) => b.n - a.n);
    if (counts[0].n === counts[1].n) return { kind: 'ambiguous', items, cafs, locId };
    const win = counts[0].c;
    return { kind: 'order', items: items.filter((i) => i.caf === win), cafId: win, locId, dropped: items.filter((i) => i.caf !== win) };
  }
  return { kind: 'order', items, cafId: cafs[0], locId };
}

function matchIn(t, m) {
  const keys = [m.name.toLowerCase(), ...(m.aliases || [])].sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const i = t.indexOf(' ' + k);
    if (i >= 0) return { idx: i + 1, len: k.length };
  }
  return null;
}

/* Server-side draft: the ONLY thing the agent can create (roadmap §13) */
function buildDraft(parsed) {
  const avail = parsed.items.filter((i) => item(i.id).available);
  const gone = parsed.items.filter((i) => !item(i.id).available);
  const lines = avail.map((i) => {
    const it = item(i.id);
    return { itemId: i.id, name: it.name, qty: i.qty, unit: it.price, line: it.price * i.qty, veg: it.veg, glyph: it.glyph };
  });
  const locId = parsed.locId || S.locationId;
  const fulfilment = 'delivery';
  const subtotal = lines.reduce((a, l) => a + l.line, 0);
  const fee = PRICING.delivery_fee_paise;
  return { cafId: parsed.cafId, lines, gone, locId, fulfilment, subtotal, fee, total: subtotal + fee };
}

function aiSay(html, extra = {}) { S.ai.messages.push({ who: 'ai', html, ...extra }); }
function aiUser(text) { S.ai.messages.push({ who: 'user', text }); }

function aiSubmit(text) {
  if (!text.trim() || S.ai.busy) return;
  aiUser(text);
  S.ai.busy = true; S.ai.draft = null; render();
  later(() => {
    const p = parseOrder(text);
    S.ai.busy = false;

    if (p.kind === 'offcampus') {
      aiSay(`Frisco delivers <b>inside campus only</b> — that's a hard rule, not a setting I can change.<br><br>Pick a campus spot and I'll get it moving, or switch to self pickup.`, { locs: true });
    } else if (p.kind === 'unknown') {
      aiSay(`I didn't catch an item in that. Try something like <i>“2 cold coffee aur ek burger ground pe”</i> — or tell me a budget and a mood and I'll suggest.`, { chips: AI_SUGGESTIONS.slice(0, 2) });
    } else if (p.kind === 'recommend') {
      const picks = MENU.filter((m) => m.available && (!p.mood.length || p.mood.some((x) => m.tags.includes(x))))
        .sort((a, b) => b.popular - a.popular).slice(0, 4)
        .filter((m, _, arr) => arr.reduce((a, x) => a + x.price, 0) >= 0);
      const fit = []; let run = 0;
      for (const m of picks) { if (run + m.price + PRICING.delivery_fee_paise <= p.budget) { fit.push(m); run += m.price; } }
      const list = (fit.length ? fit : picks.slice(0, 2));
      aiSay(`Under <b>${money(p.budget)}</b>${p.mood.length ? ` and on the ${esc(p.mood.join(' + '))} side` : ''}, these are actually available right now:`, { recs: list.map((m) => m.id) });
    } else if (p.kind === 'ambiguous') {
      aiSay(`Quick one — <b>cold coffee</b> is on two counters. Which do you want?`, { cafs: p.cafs });
    } else {
      const d = buildDraft(p);
      S.ai.draft = d;
      let pre = '';
      if (d.gone.length) pre = `<span style="color:var(--warn)">${esc(item(d.gone[0].id).name)} is out of stock right now</span> — left it out. `;
      if (p.dropped && p.dropped.length) pre += `Kept everything on one counter so it arrives together. `;
      aiSay(`${pre}Here's the order — <b>check it before you pay</b>.`, { draft: true });
    }
    render();
    const sc = $('.screen'); if (sc) sc.scrollTop = sc.scrollHeight;
  }, 620);
  render();
  const sc = $('.screen'); if (sc) sc.scrollTop = sc.scrollHeight;
}

function ScrAI() {
  const empty = !S.ai.messages.length;
  return `<div class="screen" style="display:flex;flex-direction:column">
    <div class="topbar">
      <span class="ai-mark">f.</span>
      <div class="grow"><div class="t-h3">Ask Frisco</div>
        <div class="t-xs muted">Hinglish is fine · ${esc(loc(S.locationId).name)}</div></div>
      ${S.ai.messages.length ? `<button class="btn btn-ghost btn-sm" data-act="aiClear">Clear</button>` : ''}
    </div>

    <div class="pad stack g4 grow" style="padding-bottom:var(--s-4)">
      ${empty ? `
        <div class="poster poster-grid" style="margin-top:var(--s-2)">
          <div class="poster-arc" style="width:170px;height:170px;bottom:-90px;left:-50px"></div>
          <div class="t-label">Campus concierge</div>
          <div class="t-display" style="font-size:1.9rem;margin-top:8px">Tell Frisco<br>what you want.</div>
          <p class="t-sm" style="color:var(--text-2);margin-top:10px">Say it how you'd say it to a friend. I'll find the items, check what's actually available, and build the order — you confirm before anything is paid.</p>
        </div>
        <div class="stack g2">
          ${Label('Try one of these')}
          ${AI_SUGGESTIONS.map((s) => `<button class="tile row g3" data-act="aiSend" data-text="${esc(s)}" style="text-align:left;width:100%">
            <span style="font-size:1rem">💬</span><span class="grow t-sm">${esc(s)}</span>${I.chev}</button>`).join('')}
        </div>
        <div class="campusnote"><span>🔒</span><p class="t-xs" style="color:var(--text-2)">Frisco's assistant can build and price an order, but it can never pay, place, or dispatch on its own. Every order needs your tap.</p></div>
      ` : `<div class="stack g4">${S.ai.messages.map(Msg).join('')}${S.ai.busy ? `<div class="row g2 msg-in"><span class="ai-mark">f.</span><span class="thinking"><i></i><i></i><i></i></span></div>` : ''}</div>`}
    </div>

    <div class="composer">
      <div class="composer-inner">
        <textarea id="ai-in" rows="1" placeholder="Ground pe 2 cold coffee bhej do…" aria-label="Message Frisco"></textarea>
        <button class="sendbtn" data-act="aiSendInput" aria-label="Send">${I.send}</button>
      </div>
    </div>
  </div>`;
}

function Msg(m) {
  if (m.who === 'user') return `<div class="bubble-user msg-in">${esc(m.text)}</div>`;
  let extra = '';
  if (m.locs) extra = `<div class="row g2 msg-in" style="flex-wrap:wrap;margin-top:10px">
    ${LOCATIONS.map((l) => `<button class="chip chip-soft" data-act="aiPickLoc" data-loc="${l.id}">${l.glyph} ${esc(l.name)}</button>`).join('')}</div>`;
  if (m.chips) extra = `<div class="stack g2" style="margin-top:10px">${m.chips.map((c) => `<button class="tile t-sm" data-act="aiSend" data-text="${esc(c)}" style="text-align:left">${esc(c)}</button>`).join('')}</div>`;
  if (m.cafs) extra = `<div class="row g2" style="margin-top:10px;flex-wrap:wrap">${m.cafs.map((c) => `<button class="chip chip-soft" data-act="aiPickCaf" data-caf="${c}">${esc(caf(c).name)} · ${money(MENU.find(x => x.caf === c && x.name === 'Cold Coffee').price)}</button>`).join('')}</div>`;
  if (m.recs) extra = `<div class="stack g2" style="margin-top:10px">
    ${m.recs.map((id) => { const it = item(id); return `<div class="tile row g3">
      <span style="font-size:1.2rem">${it.glyph}</span>
      <div class="grow"><div class="row g2">${VegMark(it.veg)}<span class="t-sm" style="font-weight:700">${esc(it.name)}</span></div>
      <div class="t-xs muted">${esc(caf(it.caf).name)} · ${esc(it.tags.join(', '))}</div></div>
      <span class="money t-sm">${money(it.price)}</span>
      <button class="btn btn-soft btn-sm" data-act="add" data-item="${id}">Add</button></div>`; }).join('')}
    <button class="btn btn-secondary btn-sm" data-act="go" data-route="cart">Review cart</button></div>`;
  if (m.draft && S.ai.draft) extra = DraftCard(S.ai.draft);
  return `<div class="stack g2 msg-in"><div class="row g2" style="align-items:flex-start">
    <span class="ai-mark">f.</span><div class="bubble-ai grow">${m.html}</div></div>${extra}</div>`;
}

/* The confirmation card — rendered by the app from the server draft, never
   written by the model. This is the payment boundary. (roadmap §12)      */
function DraftCard(d) {
  const c = caf(d.cafId);
  return `<div class="card card-raise pop" style="overflow:hidden">
    <div style="background:${c.heroBg};padding:var(--s-4)">
      <div class="between">
        <div class="row g2"><div class="cafmark" style="width:36px;height:36px;border-radius:11px;font-size:.8rem;background:${c.markBg}">${c.mark}</div>
        <div><div class="t-label">Your order</div><div class="t-h3">${esc(c.name)}</div></div></div>
        <span class="badge badge-ink">Draft</span>
      </div>
    </div>
    <div class="card-pad stack g3">
      ${d.lines.map((l) => `<div class="between t-sm">
        <span class="row g2">${VegMark(l.veg)}<span>${esc(l.name)} × ${l.qty}</span></span>
        <span class="money t-sm">${money(l.line)}</span></div>`).join('')}
      ${d.gone.length ? `<div class="t-xs" style="color:var(--warn)">Not added: ${d.gone.map(g => esc(item(g.id).name)).join(', ')} — unavailable</div>` : ''}
      <hr class="dashline">
      <div class="between t-sm"><span class="muted">Campus delivery</span><span class="money t-sm">${money(d.fee)}</span></div>
      <div class="between"><span class="t-h3">Total</span><span class="money" style="font-size:1.5rem">${money(d.total)}</span></div>
      <div class="row g2 t-sm" style="color:var(--accent-text);font-weight:700">${I.pin}<span>${esc(loc(d.locId).name)}</span>
        <button class="t-xs" data-act="sheet" data-sheet="location" style="color:var(--text-muted);font-weight:600;text-decoration:underline">change</button></div>
      <hr class="dashline">
      <div class="stack g2">
        ${Label('How would you like to pay?')}
        <div class="row g2">
          <button class="btn btn-primary grow" data-act="aiConfirm" data-p="online">📲 Online Pay</button>
          <button class="btn btn-secondary grow" data-act="aiConfirm" data-p="cash">💵 Cash</button>
        </div>
        <p class="t-xs faint">Nothing is charged until you tap. Frisco's assistant cannot pay for you.</p>
      </div>
    </div>
  </div>`;
}

/* ===================== PARTNER ========================================== */
function ScrPHome() {
  const p = S.partner;
  return `<div class="screen">
    <div class="partner-hero">
      <div class="between" style="margin-bottom:var(--s-5)">
        <div class="row g2"><div class="avatar avatar-sm" style="background:rgba(255,255,255,.14);color:var(--text-on-ink)">${ME.initials}</div>
          <div><div class="t-sm" style="font-weight:700">${esc(ME.first)}</div><div class="t-xs" style="opacity:.6">Verified partner</div></div></div>
        <span class="badge ${p.online ? 'badge-open' : ''}" style="${p.online ? '' : 'background:rgba(255,255,255,.14);color:var(--text-on-ink)'}"><i class="dot ${p.online ? 'dot-live' : ''}"></i>${p.online ? 'Online' : 'Offline'}</span>
      </div>
      <button class="gobtn ${p.online ? 'online' : ''}" data-act="toggleOnline">
        <span style="font-size:1.5rem">${p.online ? 'ONLINE' : 'GO'}</span>
        <span class="t-xs" style="font-family:var(--font-ui);font-weight:600;opacity:.8">${p.online ? 'Tap to stop' : 'Tap to start'}</span>
      </button>
      <div class="statgrid" style="margin-top:var(--s-6)">
        <div><div class="statval">${money(p.earnings_today_paise)}</div><div class="t-label" style="color:var(--text-on-ink);opacity:.6">Today</div></div>
        <div><div class="statval">${p.deliveries_today}</div><div class="t-label" style="color:var(--text-on-ink);opacity:.6">Deliveries</div></div>
        <div><div class="statval">${p.rating}</div><div class="t-label" style="color:var(--text-on-ink);opacity:.6">Rating</div></div>
      </div>
    </div>

    <div class="pad stack g4 enter" style="margin-top:var(--s-4)">
      ${p.online ? `
        <div class="card card-pad stack g3" style="border-style:dashed">
          <div class="row g2"><i class="dot dot-live" style="background:var(--ok)"></i>${Label('Listening for offers')}</div>
          <p class="t-sm muted">You'll get a card the moment something near you comes up. Keep the app open while you walk.</p>
          <button class="btn btn-soft btn-sm" data-act="simOffer" style="align-self:flex-start">Simulate an offer</button>
        </div>` : `
        <div class="tile stack g2" style="background:var(--surface-blush);border-color:transparent">
          <div class="t-h3">You're offline</div>
          <p class="t-sm muted">Go online between ${SERVICE_WINDOW.opens} and ${SERVICE_WINDOW.closes} to receive delivery offers.</p>
        </div>`}

      <div class="row g3">
        <div class="kpi grow"><div class="t-label">Reliability</div><div class="v">${p.reliability}</div>
          <div class="bar" style="margin-top:6px"><i style="width:${p.reliability}%"></i></div></div>
        <div class="kpi grow"><div class="t-label">Cash held</div><div class="v">${money(p.cash_held_paise)}</div>
          <div class="t-xs muted" style="margin-top:6px">Cap ${money(PRICING.cash_float_cap_paise)}</div></div>
      </div>

      ${p.cash_held_paise > 0 ? `<div class="campusnote"><span>💵</span><p class="t-xs" style="color:var(--text-2)">
        Deposit ${money(p.cash_held_paise)} at the Frisco counter before ${SERVICE_WINDOW.closes}. Unsettled cash over 24 hours blocks going online.</p></div>` : ''}

      <div class="stack g2">
        ${Label('Recent')}
        ${PARTNER_HISTORY.slice(0, 3).map(HistRow).join('')}
        <button class="btn btn-ghost btn-sm" data-act="go" data-route="p-history">See all deliveries</button>
      </div>
    </div>
  </div>`;
}

const HistRow = (h) => `
  <div class="tile row g3">
    <span class="code t-xs muted" style="min-width:44px">#${h.code}</span>
    <div class="grow"><div class="t-sm" style="font-weight:700">${esc(h.from)} → ${esc(h.to)}</div>
    <div class="t-xs muted">${esc(h.at)}</div></div>
    <span class="money t-sm" style="color:var(--ok)">+${money(h.payout)}</span>
  </div>`;

function ScrPOffer() {
  const pct = (S.offerLeft / 45) * 100;
  return `<div class="screen no-nav" style="display:flex;flex-direction:column;background:var(--surface-ink)">
    <div class="pad stack g5" style="padding-top:var(--s-6);color:var(--text-on-ink)">
      <div class="center stack g1">
        <div class="t-label" style="color:var(--text-on-ink);opacity:.6">New delivery</div>
        <div class="t-display" style="font-size:2.6rem;color:var(--text-on-ink)">${money(1200)}</div>
        <div class="t-sm" style="opacity:.7">Base ${money(PRICING.partner_base_payout_paise)} + peak ${money(200)}</div>
      </div>

      <div class="countdown"><i style="width:${pct}%"></i></div>
      <div class="center t-sm" style="opacity:.75">${S.offerLeft}s to accept · first to accept gets it</div>

      <div class="card card-pad stack g4">
        <div class="row g3">
          <div class="cafmark" style="background:var(--rose-500);width:44px;height:44px;border-radius:13px;font-size:1rem">F</div>
          <div class="grow"><div class="t-label">Pick up</div><div class="t-h3">Frisco</div>
          <div class="t-xs muted">Academic Block, Ground Floor</div></div>
          <span class="badge badge-warn">2 min</span>
        </div>
        <div style="border-left:2px dashed var(--line-strong);height:16px;margin-left:21px"></div>
        <div class="row g3">
          <div class="cafmark" style="background:var(--surface-blush);color:var(--accent-text);width:44px;height:44px;border-radius:13px;font-size:1.3rem">🏀</div>
          <div class="grow"><div class="t-label">Drop</div><div class="t-h3">Ground</div>
          <div class="t-xs muted">Basketball court side</div></div>
          <span class="badge badge-rose">5 min</span>
        </div>
        <hr class="dashline">
        <div class="between t-sm"><span class="muted">2 × Cold Coffee, 1 × Veg Burger</span><span class="badge badge-open">Prepaid</span></div>
      </div>
    </div>
    <div class="pad stack g2 mt-auto" style="padding-bottom:var(--s-6)">
      <button class="btn btn-primary btn-lg btn-block" data-act="acceptOffer">Accept delivery</button>
      <button class="btn btn-ghost btn-block" data-act="declineOffer" style="color:var(--text-on-ink);opacity:.7">Not now</button>
    </div>
  </div>`;
}

function ScrPActive() {
  const st = S.params.st || 'topickup';
  return `<div class="screen">
    ${TopBar(st === 'topickup' ? 'Head to Frisco' : 'Deliver to Ground', { back: 'p-home', sub: '#F1842 · ' + money(1200) })}
    <div class="pad stack g4 enter">
      <div class="card card-raise card-pad stack g3">
        <div class="between">
          <span class="badge ${st === 'topickup' ? 'badge-warn' : 'badge-open'}"><i class="dot dot-live"></i>${st === 'topickup' ? 'Collect order' : 'On the way'}</span>
          <span class="t-sm muted">${st === 'topickup' ? '2 min away' : '5 min away'}</span>
        </div>
        <div class="t-h1">${st === 'topickup' ? 'Frisco counter' : 'Basketball Ground'}</div>
        <div class="t-sm muted">${st === 'topickup' ? 'Academic Block, Ground Floor' : 'Court side, near the benches'}</div>
        <div class="sunken stack g2" style="padding:var(--s-4);align-items:center">
          ${Label(st === 'topickup' ? 'Read this to the counter' : 'Ask the student for their code')}
          <div class="codebox">${(st === 'topickup' ? '7412' : '3904').split('').map((d) => `<b>${d}</b>`).join('')}</div>
          <p class="t-xs faint center">${st === 'topickup' ? 'Staff confirm the handover with this code' : 'Enter their code to close the delivery'}</p>
        </div>
      </div>

      <div class="card card-pad stack g2">
        ${Label('Order')}
        <div class="between t-sm"><span>2 × Cold Coffee</span><span class="muted">Frisco</span></div>
        <div class="between t-sm"><span>1 × Veg Burger</span><span class="muted">Frisco</span></div>
        <hr class="dashline">
        <div class="between"><span class="t-sm muted">Customer pays</span><span class="badge badge-open">Already paid online</span></div>
      </div>

      <div class="row g2">
        <button class="btn btn-secondary btn-sm grow">📞 Call student</button>
        <button class="btn btn-secondary btn-sm grow" data-act="sheet" data-sheet="report">Report issue</button>
      </div>
    </div>
    <div class="actionbar">
      ${st === 'topickup'
        ? `<button class="btn btn-primary btn-lg btn-block" data-act="pickedUp">Mark picked up</button>`
        : `<button class="btn btn-primary btn-lg btn-block" data-act="delivered">Mark delivered</button>`}
    </div>
  </div>`;
}

function ScrPEarnings() {
  const p = S.partner;
  const days = [['Mon', 62], ['Tue', 48], ['Wed', 80], ['Thu', 55], ['Fri', 92], ['Sat', 30], ['Today', 45]];
  const max = Math.max(...days.map((d) => d[1]));
  return `<div class="screen">
    ${TopBar('Earnings', { sub: 'Paid weekly at the Frisco counter' })}
    <div class="pad stack g4 enter">
      <div class="poster" style="padding:var(--s-5)">
        <div class="poster-arc" style="width:140px;height:140px;top:-60px;right:-40px"></div>
        <div class="t-label">This week</div>
        <div class="t-hero" style="font-size:2.8rem;margin-top:4px">${money(p.earnings_week_paise)}</div>
        <div class="row g3 t-sm" style="margin-top:8px;color:var(--text-2)">
          <span>${p.deliveries_total} lifetime</span><span>·</span><span>${money(PRICING.partner_base_payout_paise)}–${money(PRICING.partner_base_payout_paise + PRICING.partner_peak_bonus_paise)} per order</span>
        </div>
      </div>

      <div class="card card-pad stack g3">
        ${Label('Daily')}
        <div class="row g2" style="align-items:flex-end;height:120px">
          ${days.map(([d, v]) => `<div class="grow stack g2" style="align-items:center;height:100%;justify-content:flex-end">
            <span class="t-xs muted" style="font-variant-numeric:tabular-nums">${money(v * 100)}</span>
            <div style="width:100%;height:${(v / max) * 74}%;border-radius:6px 6px 3px 3px;background:${d === 'Today' ? 'var(--accent)' : 'var(--accent-soft)'}"></div>
            <span class="t-label">${d}</span></div>`).join('')}
        </div>
      </div>

      <div class="card card-pad stack g3">
        <div class="between">${Label('Cash to settle')}<span class="badge badge-warn">Due today</span></div>
        <div class="between"><span class="t-sm muted">Collected in cash</span><span class="money t-h2">${money(p.cash_held_paise)}</span></div>
        <p class="t-xs muted">Hand this in at the Frisco counter. Your earnings are paid separately — they're never deducted from cash you're holding.</p>
        <button class="btn btn-secondary btn-block btn-sm">How settlement works</button>
      </div>
    </div>
  </div>`;
}

function ScrPHistory() {
  return `<div class="screen">
    ${TopBar('Delivery history', { sub: `${PARTNER.deliveries_total} completed` })}
    <div class="pad stack g4 enter">
      <div class="row g3">
        <div class="kpi grow"><div class="t-label">Completion</div><div class="v">98%</div></div>
        <div class="kpi grow"><div class="t-label">On time</div><div class="v">94%</div></div>
        <div class="kpi grow"><div class="t-label">Rating</div><div class="v">${PARTNER.rating}</div></div>
      </div>
      ${Label('Today')}
      <div class="stack g2">${PARTNER_HISTORY.map(HistRow).join('')}</div>
    </div>
  </div>`;
}

function ScrPProfile() {
  return `<div class="screen">
    ${TopBar('Partner profile')}
    <div class="pad stack g4 enter">
      <div class="card card-pad stack g3">
        <div class="row g3"><div class="avatar avatar-lg">${ME.initials}</div>
          <div class="grow"><div class="t-h2">${esc(ME.name)}</div><div class="t-xs code muted">${esc(ME.roll)}</div>
          <span class="badge badge-open" style="margin-top:6px"><i class="dot"></i>Tier 2 approved</span></div></div>
        <hr class="dashline">
        <div class="stack g2">
          <div class="between t-sm"><span class="muted">Reliability score</span><b>${PARTNER.reliability} / 100</b></div>
          <div class="bar"><i style="width:${PARTNER.reliability}%"></i></div>
          <p class="t-xs muted">Built from completion, on-time arrival and ratings over your last 50 deliveries. Accepting then abandoning is what moves it down fastest.</p>
        </div>
      </div>
      <div class="card" style="overflow:hidden">
        ${[['🪪', 'Verification', 'ID card + phone approved'], ['💵', 'Cash settlement', money(PARTNER.cash_held_paise) + ' outstanding'],
           ['📜', 'Partner policy', 'What counts as a violation'], ['🛟', 'Support', '']].map(([g, t, s]) => `
          <button class="adminrow" style="width:100%;text-align:left"><span style="font-size:1.1rem">${g}</span>
          <div class="grow"><div class="t-sm" style="font-weight:700">${t}</div>${s ? `<div class="t-xs muted">${s}</div>` : ''}</div>${I.chev}</button>`).join('')}
      </div>
    </div>
  </div>`;
}

/* ===================== CAFETERIA STAFF ================================== */
function ScrStaff() {
  const tabs = [['placed', 'New'], ['preparing', 'Preparing'], ['ready', 'Ready'], ['done', 'Done']];
  const list = S.queue.filter((o) => o.status === S.staffTab);
  return `<div class="screen no-nav staff">
    <div class="topbar" style="background:var(--surface)">
      <div class="cafmark" style="width:38px;height:38px;border-radius:11px;font-size:.85rem;background:var(--rose-500)">F</div>
      <div class="grow"><div class="t-h3">Frisco counter</div>
        <div class="t-xs muted">${S.queue.filter(o => o.status === 'placed').length} waiting · ${SERVICE_WINDOW.opens}–${SERVICE_WINDOW.closes}</div></div>
      <button class="btn btn-secondary btn-sm" data-act="sheet" data-sheet="staffmenu">Menu</button>
    </div>
    <div class="stafftabs">
      ${tabs.map(([k, l]) => `<button class="stafftab" data-act="stafftab" data-t="${k}" ${S.staffTab === k ? 'aria-pressed="true"' : ''}>
        <b>${S.queue.filter((o) => o.status === k).length}</b>${l}</button>`).join('')}
    </div>
    <div class="pad stack g3 enter" style="padding-top:var(--s-4)">
      ${list.length ? list.map(KOT).join('') : `<div class="empty"><div class="empty-art">${S.staffTab === 'placed' ? '🔔' : '✅'}</div>
        <div class="t-h2">${S.staffTab === 'placed' ? 'No new orders' : 'Nothing here'}</div>
        <p class="t-sm muted">${S.staffTab === 'placed' ? 'You\'ll hear a chime the moment one lands.' : 'Orders move here as you work through the queue.'}</p></div>`}
      <div class="tile stack g3" style="border-style:dashed;background:transparent">
        ${Label('Counter controls')}
        <div class="between"><div><div class="t-sm" style="font-weight:700">Accepting orders</div>
          <div class="t-xs muted">Turn off during a rush — students see “closed”</div></div>
          <button class="switch" role="switch" aria-checked="true" data-act="noop"></button></div>
        <div class="between"><div><div class="t-sm" style="font-weight:700">Paneer Zinger</div>
          <div class="t-xs muted">Marked out of stock today</div></div>
          <button class="switch" role="switch" aria-checked="false" data-act="noop"></button></div>
      </div>
    </div>
  </div>`;
}

const KOT = (o) => {
  const cls = o.status === 'placed' ? 'new' : o.status === 'preparing' ? 'prep' : 'ready';
  return `<div class="kot ${cls}">
    <div class="between">
      <div class="row g2">
        <span class="code t-h3">#${o.code}</span>
        <span class="badge ${o.fulfilment === 'delivery' ? 'badge-rose' : 'badge-ink'}">${o.fulfilment === 'delivery' ? '🚴 Delivery' : '🛍️ Pickup'}</span>
      </div>
      <span class="t-xs muted">${esc(o.placed)}</span>
    </div>
    <div class="stack g1">
      ${o.items.map((i) => `<div class="kot-line"><b>${i.q}×</b><span>${esc(i.n)}</span></div>`).join('')}
    </div>
    <div class="row g3 t-xs muted" style="flex-wrap:wrap">
      ${o.loc ? `<span class="row g1">${I.pin}${esc(o.loc)}</span>` : '<span>Counter collection</span>'}
      <span class="badge ${o.pay === 'cash' ? 'badge-warn' : 'badge-open'}">${o.pay === 'cash' ? 'Collect ' + money(o.total) : 'Prepaid'}</span>
      ${o.partner ? `<span>🚴 ${esc(o.partner)}</span>` : ''}
      ${o.pickupCode ? `<span class="code">Code ${o.pickupCode}</span>` : ''}
    </div>
    <div class="row g2">
      ${o.status === 'placed' ? `
        <button class="btn btn-primary grow" data-act="kot" data-code="${o.code}" data-to="preparing">Accept</button>
        <button class="btn btn-danger btn-sm" data-act="kot" data-code="${o.code}" data-to="rejected">Reject</button>` : ''}
      ${o.status === 'preparing' ? `<button class="btn btn-primary btn-block" data-act="kot" data-code="${o.code}" data-to="ready">Mark ready</button>` : ''}
      ${o.status === 'ready' ? `<button class="btn btn-ink btn-block" data-act="kot" data-code="${o.code}" data-to="done">${o.fulfilment === 'delivery' ? 'Handed to partner' : 'Collected by student'}</button>` : ''}
    </div>
  </div>`;
};

/* ===================== ADMIN ============================================ */
function ScrAdmin() {
  const tab = S.params.tab || 'overview';
  const tabs = [['overview', 'Overview'], ['cafes', 'Cafés'], ['campus', 'Campus'], ['pricing', 'Pricing'], ['trust', 'Trust']];
  return `<div class="screen no-nav">
    ${TopBar('Campus admin', { sub: esc(CONFIG.college) })}
    <div class="chiprow" style="padding-bottom:var(--s-3)">
      ${tabs.map(([k, l]) => `<button class="chip" data-act="admintab" data-t="${k}" ${tab === k ? 'aria-pressed="true"' : ''}>${l}</button>`).join('')}
    </div>
    <div class="pad stack g4 enter">${
      tab === 'overview' ? AdminOverview() :
      tab === 'cafes' ? AdminCafes() :
      tab === 'campus' ? AdminCampus() :
      tab === 'pricing' ? AdminPricing() : AdminTrust()
    }</div>
  </div>`;
}

function AdminOverview() {
  const bars = [['08', 12], ['10', 34], ['12', 96], ['14', 62], ['16', 40], ['18', 8]];
  const max = Math.max(...bars.map((b) => b[1]));
  return `
    <div class="row g3">
      <div class="kpi grow"><div class="t-label">Orders today</div><div class="v">418</div><div class="t-xs" style="color:var(--ok)">+12% vs last Tue</div></div>
      <div class="kpi grow"><div class="t-label">No partner</div><div class="v">6%</div><div class="t-xs muted">Recruiting signal</div></div>
    </div>
    <div class="row g3">
      <div class="kpi grow"><div class="t-label">Median delivery</div><div class="v">14<span class="t-sm muted"> min</span></div></div>
      <div class="kpi grow"><div class="t-label">Cash unsettled</div><div class="v">${money(184000)}</div></div>
    </div>
    <div class="card card-pad stack g3">
      ${Label('Orders by hour')}
      <div class="row g2" style="align-items:flex-end;height:110px">
        ${bars.map(([h, v]) => `<div class="grow stack g2" style="align-items:center;height:100%;justify-content:flex-end">
          <span class="t-xs muted">${v}</span>
          <div style="width:100%;height:${(v / max) * 70}%;border-radius:6px 6px 3px 3px;background:${v === max ? 'var(--accent)' : 'var(--accent-soft)'}"></div>
          <span class="t-label">${h}</span></div>`).join('')}
      </div>
      <p class="t-xs muted">The 12:00 spike is ~70% of the day. Kitchen capacity, not software, is the binding constraint here.</p>
    </div>
    <div class="card card-pad stack g3">
      ${Label('AI ordering funnel')}
      ${[['Conversations', 340, 100], ['Reached a draft', 268, 79], ['Confirmed & paid', 231, 68]].map(([l, v, p]) => `
        <div class="stack g1"><div class="between t-sm"><span>${l}</span><b>${v}</b></div>
        <div class="bar"><i style="width:${p}%"></i></div></div>`).join('')}
    </div>`;
}

function AdminCafes() {
  return `
    ${Label('Cafeterias — rows, not code')}
    <div class="card" style="overflow:hidden">
      ${CAFETERIAS.map((c) => `<div class="adminrow">
        <div class="cafmark" style="width:36px;height:36px;border-radius:11px;font-size:.8rem;background:${c.markBg}">${c.mark}</div>
        <div class="grow"><div class="t-sm" style="font-weight:700">${esc(c.name)}</div>
        <div class="t-xs muted">${esc(c.kind)} · ${c.orders_today} today · zone ${c.zone}</div></div>
        ${StatusPill(c.is_open)}</div>`).join('')}
    </div>
    <button class="addcaf" data-act="sheet" data-sheet="addcaf">
      <div class="cafmark" style="background:var(--bg-sunken);color:var(--text-faint);font-size:1.4rem">+</div>
      <div class="grow"><div class="t-h3">Add a cafeteria</div><div class="t-xs muted">Name, zone, hours, menu import — live in minutes</div></div>${I.chev}
    </button>
    <div class="card card-pad stack g3">
      ${Label('Service hours')}
      <div class="between"><span class="t-sm">Campus-wide window</span><b class="code">${SERVICE_WINDOW.opens} – ${SERVICE_WINDOW.closes}</b></div>
      <p class="t-xs muted">Outlets may narrow this, never widen it. Delivery is hard-stopped outside the window.</p>
    </div>`;
}

function AdminCampus() {
  return `
    ${Label('Approved delivery locations')}
    <div class="card" style="overflow:hidden">
      ${LOCATIONS.map((l) => `<div class="adminrow">
        <span style="font-size:1.2rem">${l.glyph}</span>
        <div class="grow"><div class="t-sm" style="font-weight:700">${esc(l.name)}</div>
        <div class="t-xs muted">${esc(l.detail)} · zone ${l.zone}</div></div>
        <span class="badge badge-open"><i class="dot"></i>Live</span></div>`).join('')}
    </div>
    <div class="campusnote"><span>🚧</span><p class="t-xs" style="color:var(--text-2)">
      This list <b>is</b> the campus boundary. An order can only reference a row here — there is no address field anywhere in Frisco, so off-campus delivery isn't blocked, it's unrepresentable.</p></div>
    <button class="btn btn-secondary btn-block">+ Add campus location</button>`;
}

function AdminPricing() {
  const rows = [['Delivery fee', PRICING.delivery_fee_paise, 'Charged to student on delivery orders'],
    ['Partner base payout', PRICING.partner_base_payout_paise, 'Per completed delivery'],
    ['Peak bonus', PRICING.partner_peak_bonus_paise, '12–2 PM and 5–6 PM'],
    ['Cash float cap', PRICING.cash_float_cap_paise, 'Partner stops receiving cash orders above this']];
  return `
    ${Label('Pricing config — versioned rows')}
    <div class="card" style="overflow:hidden">
      ${rows.map(([l, v, d]) => `<div class="adminrow">
        <div class="grow"><div class="t-sm" style="font-weight:700">${l}</div><div class="t-xs muted">${d}</div></div>
        <span class="money t-h3">${money(v)}</span>${I.chev}</div>`).join('')}
    </div>
    <p class="t-xs muted">Changes take effect from the moment they're saved. Orders already placed keep the price they were quoted.</p>
    ${Label('Feature flags')}
    <div class="card" style="overflow:hidden">
      ${S.flags.map((f, i) => `<div class="adminrow">
        <div class="grow"><div class="t-sm" style="font-weight:700">${esc(f.label)}</div><div class="t-xs muted">${esc(f.desc)}</div></div>
        <button class="switch" role="switch" aria-checked="${f.on}" data-act="flag" data-i="${i}"></button></div>`).join('')}
    </div>`;
}

function AdminTrust() {
  return `
    ${Label('Pending verification')}
    <div class="card" style="overflow:hidden">
      ${VERIFICATIONS.map((v) => `<div class="adminrow">
        <div class="avatar avatar-sm">${v.name.split(' ').map(n => n[0]).join('')}</div>
        <div class="grow"><div class="t-sm" style="font-weight:700">${esc(v.name)}</div>
        <div class="t-xs muted code">${esc(v.roll)} · ${esc(v.doc)} · ${esc(v.submitted)}</div></div>
        <span class="badge badge-warn">${esc(v.tier)}</span></div>`).join('')}
    </div>
    ${Label('Open reports')}
    <div class="stack g2">
      ${REPORTS.map((r) => `<div class="tile stack g2" style="border-left:4px solid var(--${r.sev === 'danger' ? 'danger' : 'warn'})">
        <div class="between"><span class="t-sm" style="font-weight:700">${esc(r.cat)}</span><span class="code t-xs muted">${r.id}</span></div>
        <div class="t-xs muted">${esc(r.subject)} — ${esc(r.detail)}</div>
        <div class="row g2"><button class="btn btn-secondary btn-sm">Review</button>
        <button class="btn btn-ghost btn-sm">Contact</button></div></div>`).join('')}
    </div>
    <div class="campusnote"><span>⚖️</span><p class="t-xs" style="color:var(--text-2)">
      Frisco records and escalates — it never auto-debits anyone. Every monetary consequence goes to a named reviewer under approved college policy. Platform access is the lever, not fines.</p></div>`;
}

/* ===================== SHEETS =========================================== */
function Sheet() {
  if (!S.sheet) return '';
  const n = S.sheet.name;
  let body = '';

  if (n === 'location') {
    body = `
      <div class="sheet-body stack g4">
        <div class="stack g1">
          <h2 class="t-display" style="font-size:1.7rem">Where should<br>we bring it?</h2>
          <p class="t-sm muted">Campus spots only — that's how Frisco stays fast.</p>
        </div>
        <div class="locgrid">
          ${LOCATIONS.map((l) => `<button class="loccard" data-act="setloc" data-loc="${l.id}" ${S.locationId === l.id ? 'aria-pressed="true"' : ''}>
            <span class="glyph">${l.glyph}</span>
            <span class="t-h3">${esc(l.name)}</span>
            <span class="t-xs muted">${esc(l.detail)}</span></button>`).join('')}
        </div>
        ${loc(S.locationId).rooms ? `<div class="stack g2">${Label('Which one?')}
          <div class="row g2" style="flex-wrap:wrap">${loc(S.locationId).rooms.map((r) => `
            <button class="chip" data-act="setroom" data-room="${esc(r)}" ${S.room === r ? 'aria-pressed="true"' : ''}>${esc(r)}</button>`).join('')}</div></div>` : ''}
        <div class="campusnote"><span>📍</span><p class="t-xs" style="color:var(--text-2)">
          Frisco doesn't deliver outside campus and never asks for a street address. Off-campus isn't an option we hide — it doesn't exist in the system.</p></div>
      </div>
      <div class="sheet-foot"><button class="btn btn-primary btn-block btn-lg" data-act="closeSheet">Deliver here</button></div>`;
  }

  if (n === 'addcaf') {
    body = `<div class="sheet-body stack g4">
      <div class="stack g1"><h2 class="t-display" style="font-size:1.6rem">Add a cafeteria</h2>
        <p class="t-sm muted">Outlets are data, not code. Nothing ships to add one.</p></div>
      <div class="field"><label class="t-label" for="nc">Outlet name</label><input class="input" id="nc" placeholder="e.g. Nescafé Corner"></div>
      <div class="stack g2">${Label('Campus zone')}
        <div class="row g2">${['Z1 Academic', 'Z2 Ground', 'Z3 Hostel'].map((z, i) => `<button class="chip grow" ${i === 0 ? 'aria-pressed="true"' : ''}>${z}</button>`).join('')}</div></div>
      <div class="stack g2">${Label('What happens next')}
        ${['Owner account created & invited', 'Menu imported from CSV', 'Hours set within the campus window', 'Goes live behind a feature flag'].map((s, i) => `
          <div class="row g3"><span class="avatar avatar-sm" style="width:24px;height:24px;font-size:.7rem">${i + 1}</span><span class="t-sm">${s}</span></div>`).join('')}</div>
    </div>
    <div class="sheet-foot"><button class="btn btn-primary btn-block btn-lg" data-act="closeSheet">Create outlet</button></div>`;
  }

  if (n === 'opts') {
    const m = item(S.sheet.params.item);
    body = `<div class="sheet-body stack g4">
      <div class="row g3"><div class="item-thumb">${m.glyph}</div>
        <div class="grow"><div class="row g2">${VegMark(m.veg)}<span class="t-h2">${esc(m.name)}</span></div>
        <div class="t-xs muted">${esc(m.desc)}</div><div class="money t-h3" style="margin-top:4px">${money(m.price)}</div></div></div>
      ${(m.options || []).map((g, gi) => `<div class="stack g2">${Label(g.group)}
        <div class="row g2" style="flex-wrap:wrap">${g.choices.map((c, ci) => `
          <button class="chip" data-act="opt" data-g="${gi}" data-c="${ci}" ${ci === 0 ? 'aria-pressed="true"' : ''}>
            ${esc(c.label)}${c.delta ? ` <b style="color:var(--accent-text)">+${money(c.delta)}</b>` : ''}</button>`).join('')}</div></div>`).join('')}
    </div>
    <div class="sheet-foot"><button class="btn btn-primary btn-block btn-lg" data-act="addWithOpts" data-item="${m.id}">Add to cart</button></div>`;
  }

  if (n === 'staffmenu') {
    const items = MENU.filter((m) => m.caf === 'caf_frisco');
    body = `<div class="sheet-body stack g3">
      <div class="stack g1"><h2 class="t-h1">Menu &amp; availability</h2>
        <p class="t-sm muted">Toggle anything the counter has run out of. Students still see it, greyed out.</p></div>
      ${items.map((m) => `<div class="between">
        <div class="row g2 grow">${VegMark(m.veg)}<div><div class="t-sm" style="font-weight:700">${esc(m.name)}</div>
        <div class="t-xs muted">${money(m.price)}</div></div></div>
        <button class="switch" role="switch" aria-checked="${m.available}" data-act="stock" data-item="${m.id}"></button></div>`).join('')}
    </div>
    <div class="sheet-foot"><button class="btn btn-primary btn-block" data-act="closeSheet">Done</button></div>`;
  }

  if (n === 'report') {
    body = `<div class="sheet-body stack g4">
      <div class="stack g1"><h2 class="t-h1">What went wrong?</h2>
        <p class="t-sm muted">Reports go to a real person in campus admin, with your order attached.</p></div>
      <div class="stack g2">
        ${['Order never arrived', 'Something was missing', 'Packaging was tampered with', 'Wrong order delivered', 'Partner behaviour', 'Something else'].map((r) => `
          <button class="tile row g3" style="text-align:left;width:100%"><span class="grow t-sm">${r}</span>${I.chev}</button>`).join('')}
      </div>
      <p class="t-xs faint">Frisco can suspend accounts and partner status under campus policy. It never issues fines on its own.</p>
    </div>`;
  }

  return `<div class="scrim" data-act="closeSheet"></div>
    <div class="sheet" role="dialog" aria-modal="true"><div class="sheet-grab"></div>${body}</div>`;
}

/* ===================== render =========================================== */
const ROUTES = {
  welcome: ScrWelcome, 'ob-email': ScrObEmail, 'ob-otp': ScrObOtp, 'ob-profile': ScrObProfile,
  home: ScrHome, cafes: ScrCafes, menu: ScrMenu, cart: ScrCart, checkout: ScrCheckout,
  tracking: ScrTracking, orders: ScrOrders, profile: ScrProfile, ai: ScrAI,
  'p-home': ScrPHome, 'p-offer': ScrPOffer, 'p-active': ScrPActive,
  'p-earnings': ScrPEarnings, 'p-history': ScrPHistory, 'p-profile': ScrPProfile,
  staff: ScrStaff, admin: ScrAdmin,
};

const NAVLESS = ['welcome', 'ob-email', 'ob-otp', 'ob-profile', 'p-offer', 'p-active', 'staff', 'admin', 'checkout'];

function DeskSide() {
  return `<aside class="deskside">
    <div class="card card-pad stack g2">
      <div class="t-label">Frisco · pilot build</div>
      <div class="t-h2">One product,<br>four surfaces.</div>
      <p class="t-xs muted">Student, delivery partner, cafeteria counter and campus admin all run on the same design system and the same data. Switch roles in the bar above.</p>
    </div>
    <div class="card card-pad stack g3">
      <div class="t-label">Try this</div>
      ${[['Ask Frisco in Hinglish', 'ai'], ['Watch an order track', 'tracking'], ['Take a delivery', 'p-home'], ['Work the counter', 'staff']].map(([t, r]) => `
        <button class="row g2 t-sm" data-act="jump" data-route="${r}" style="font-weight:700;color:var(--accent-text);text-align:left">${t} ${I.chev}</button>`).join('')}
    </div>
    <div class="card card-pad stack g2">
      <div class="t-label">Campus rule</div>
      <p class="t-xs muted">There is no address field anywhere in this interface. Delivery destinations come only from the approved campus list — the same constraint the database enforces.</p>
    </div>
  </aside>`;
}

function render() {
  const scr = (ROUTES[S.route] || ScrHome)();
  const nav = NAVLESS.includes(S.route) ? '' : BottomNav();
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <div class="demobar">
        <div class="brandmark"><span class="bm-text">frisco</span><span class="bm-tag">campus pilot</span></div>
        <div class="roleswitch" role="group" aria-label="Switch surface">
          ${[['student', 'Student'], ['partner', 'Partner'], ['staff', 'Counter'], ['admin', 'Admin']].map(([k, l]) =>
            `<button data-act="role" data-role="${k}" aria-pressed="${S.role === k}">${l}</button>`).join('')}
        </div>
        <button class="iconbtn-dark" data-act="theme" aria-label="Toggle theme">${I.moon}</button>
      </div>
      <div class="stage">
        <div class="spacer"></div>
        <div class="device">
          ${scr}
          ${nav}
          ${Sheet()}
          ${S.toast ? `<div class="toast"><span>${S.toast.icon}</span>${esc(S.toast.msg)}</div>` : ''}
        </div>
        ${DeskSide()}
      </div>
    </div>`;
}

/* ===================== events =========================================== */
let pendingOpts = {};

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const a = t.dataset;

  switch (a.act) {
    case 'go': go(a.route); break;
    case 'jump':
      S.role = a.route.startsWith('p-') ? 'partner' : a.route === 'staff' ? 'staff' : a.route === 'admin' ? 'admin' : 'student';
      go(a.route); break;
    case 'role':
      S.role = a.role;
      go(a.role === 'student' ? (S.onboarded ? 'home' : 'welcome') : a.role === 'partner' ? 'p-home' : a.role);
      break;
    case 'theme': {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark'
        : (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', next);
      break;
    }
    case 'menu': go('menu', { caf: a.caf }); break;
    case 'finishOb': S.onboarded = true; go('home'); break;
    case 'setloc': S.locationId = a.loc; S.room = null; render(); break;
    case 'setroom': S.room = a.room; render(); break;
    case 'setfulfil': S.fulfilment = a.f; render(); break;
    case 'setpay': S.payment = a.p; render(); break;
    case 'sheet': setSheet(a.sheet, { item: a.item }); break;
    case 'closeSheet': setSheet(null); break;
    case 'add': addToCart(a.item); render(); break;
    case 'opts': pendingOpts = {}; setSheet('opts', { item: a.item }); break;
    case 'opt': {
      pendingOpts[a.g] = +a.c;
      t.parentElement.querySelectorAll('[data-act="opt"]').forEach((b) => b.setAttribute('aria-pressed', b === t));
      break;
    }
    case 'addWithOpts': {
      const m = item(a.item);
      const opts = (m.options || []).map((g, gi) => g.choices[pendingOpts[gi] ?? 0]).filter((c) => c);
      addToCart(a.item, 1, opts); setSheet(null); break;
    }
    case 'bump': bump(+a.i, +a.d); break;
    case 'pickupMode': S.fulfilment = 'pickup'; go('cafes'); toast('Self pickup selected', '🛍️'); break;

    case 'placeOrder': {
      const p = priceOrder();
      S.order = {
        code: 'F' + (1840 + Math.floor(Math.random() * 9)), cafId: S.cafId,
        lines: cartLines().map((l) => ({ name: l.it.name, qty: l.qty, line: l.line })),
        locationId: S.locationId, fulfilment: S.fulfilment, payment: S.payment, ...p,
      };
      S.cart = []; S.orderStage = 0; S.noPartner = false;
      go('tracking');
      toast(S.payment === 'online' ? 'Paid · order placed' : 'Order placed', '✓');
      later(() => { S.orderStage = 1; render(); }, 2400);
      later(() => { S.orderStage = 2; render(); }, 5200);
      break;
    }
    case 'advance':
      S.orderStage = Math.min(S.orderStage + 1, S.order.fulfilment === 'pickup' ? 4 : 6);
      S.noPartner = false; render(); break;
    case 'simNoPartner': S.noPartner = true; S.orderStage = 3; render(); break;
    case 'switchPickup':
      S.order.fulfilment = 'pickup'; S.order.fee = 0; S.order.total = S.order.subtotal;
      S.noPartner = false; S.orderStage = 3; render();
      toast('Switched to self pickup · ₹15 refunded', '🛍️'); break;
    case 'retryPartner': S.noPartner = false; render(); toast('Looking for a partner…', '🔍'); break;
    case 'cancel': S.order = null; S.noPartner = false; go('home'); toast('Order cancelled · no charge', '·'); break;

    case 'aiSend': aiSubmit(a.text); break;
    case 'aiSendInput': { const el = $('#ai-in'); if (el && el.value.trim()) aiSubmit(el.value); break; }
    case 'aiClear': S.ai.messages = []; S.ai.draft = null; render(); break;
    case 'aiPickLoc':
      S.locationId = a.loc; S.room = null;
      aiUser(loc(a.loc).name);
      aiSay(`${loc(a.loc).glyph} <b>${esc(loc(a.loc).name)}</b> it is. Now tell me what you'd like — items and quantities, however you'd normally say it.`);
      render(); break;
    case 'aiPickCaf': {
      S.ai.busy = true; render();
      later(() => {
        const last = [...S.ai.messages].reverse().find((m) => m.who === 'user');
        const p = parseOrder(last ? last.text : '');
        const items = (p.items || []).filter((i) => i.caf === a.caf);
        S.ai.busy = false;
        if (!items.length) { aiSay('Nothing from that counter in your message — try again?'); render(); return; }
        S.ai.draft = buildDraft({ items, cafId: a.caf, locId: p.locId });
        aiSay(`${esc(caf(a.caf).name)} it is. Here's the order — <b>check it before you pay</b>.`, { draft: true });
        render();
      }, 500);
      break;
    }
    case 'aiConfirm': {
      const d = S.ai.draft; if (!d) break;
      S.cafId = d.cafId; S.locationId = d.locId; S.fulfilment = 'delivery'; S.payment = a.p;
      S.order = {
        code: 'F' + (1840 + Math.floor(Math.random() * 9)), cafId: d.cafId,
        lines: d.lines.map((l) => ({ name: l.name, qty: l.qty, line: l.line })),
        locationId: d.locId, fulfilment: 'delivery', payment: a.p,
        subtotal: d.subtotal, fee: d.fee, total: d.total,
      };
      S.orderStage = 0; S.noPartner = false; S.ai.draft = null;
      S.ai.messages.push({ who: 'ai', html: `Done — order <b class="code">#${S.order.code}</b> is with ${esc(caf(d.cafId).name)}. I'll keep you posted.` });
      go('tracking');
      toast(a.p === 'online' ? 'Paid · order placed' : 'Order placed · pay cash', '✓');
      later(() => { S.orderStage = 1; render(); }, 2400);
      later(() => { S.orderStage = 2; render(); }, 5200);
      break;
    }

    case 'toggleOnline':
      S.partner.online = !S.partner.online; render();
      toast(S.partner.online ? "You're online" : "You're offline", S.partner.online ? '🟢' : '⚪');
      if (S.partner.online) later(() => { if (S.partner.online && S.route === 'p-home') startOffer(); }, 3200);
      break;
    case 'simOffer': startOffer(); break;
    case 'acceptOffer': clearTimers(); go('p-active', { st: 'topickup' }); toast('Delivery locked to you', '🔒'); break;
    case 'declineOffer': clearTimers(); go('p-home'); break;
    case 'pickedUp': go('p-active', { st: 'todrop' }); toast('Picked up', '📦'); break;
    case 'delivered':
      S.partner.deliveries_today += 1;
      S.partner.earnings_today_paise += 1200;
      go('p-home'); toast('Delivered · ₹12 added', '🎉'); break;

    case 'stafftab': S.staffTab = a.t; render(); break;
    case 'kot': {
      const o = S.queue.find((x) => x.code === a.code);
      if (!o) break;
      if (a.to === 'rejected' || a.to === 'done') { S.queue = S.queue.filter((x) => x.code !== a.code); toast(`#${a.code} ${a.to === 'done' ? 'completed' : 'rejected'}`, '·'); }
      else { o.status = a.to; toast(`#${a.code} → ${a.to}`, '✓'); }
      render(); break;
    }
    case 'stock': {
      const m = item(a.item); m.available = !m.available;
      t.setAttribute('aria-checked', m.available);
      toast(`${m.name} ${m.available ? 'back on' : 'marked out of stock'}`, m.available ? '✓' : '·');
      break;
    }
    case 'admintab': go('admin', { tab: a.t }); break;
    case 'flag': {
      S.flags[+a.i].on = !S.flags[+a.i].on;
      t.setAttribute('aria-checked', S.flags[+a.i].on);
      toast(`${S.flags[+a.i].label} ${S.flags[+a.i].on ? 'on' : 'off'}`, '⚙');
      break;
    }
    case 'noop': t.setAttribute('aria-checked', t.getAttribute('aria-checked') !== 'true'); break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'ai-in') {
    e.preventDefault();
    if (e.target.value.trim()) aiSubmit(e.target.value);
  }
});

function startOffer() {
  S.offerLeft = 45;
  go('p-offer');
  const tick = () => {
    S.offerLeft -= 1;
    if (S.route !== 'p-offer') return;
    if (S.offerLeft <= 0) { go('p-home'); toast('Offer expired · passed to the next partner', '⏱'); return; }
    render(); later(tick, 1000);
  };
  later(tick, 1000);
}

render();
