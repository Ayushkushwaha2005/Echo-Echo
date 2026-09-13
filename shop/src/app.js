/* ==========================================================================
   QUAD — COUNTER

   The cafeteria-side surface. A shopkeeper sees exactly one outlet: the one
   their `vendor_owner` or `vendor_staff` role is bound to, resolved from the
   session server-side. There is no outlet picker for them, and there is no
   client-side filter doing the scoping — every request they make is scoped
   by the API, and a hand-crafted request for another cafeteria is refused.

   The difference between owner and staff is enforced too: staff can mark an
   item out of stock, but the price control is not rendered for them and the
   API would refuse it anyway.
   ========================================================================== */
import {
  quad, session, gate, el, panel, toast, act, explain, rupees,
  vendorVM, EmptyState, Loading, ErrorState, signOut, when, ORDER_LABEL,
} from '../../packages/ui/runtime.js';
import { esc, toggleTheme, restoreTheme, Mark, VegMark } from '../../packages/ui/kit.js';
import { lockup } from '../../brand/logo.js';

const root = document.getElementById('app');
restoreTheme();

const S = { route: 'orders', vendor: null, vendorId: null, canPrice: false };

gate(root, 'counter', boot);

async function boot(me) {
  /* Which outlet is this? For a shopkeeper the server has already bound it
     to their role; a platform admin opening Counter picks one. */
  const vendors = (await quad.vendors()).vendors;
  if (!vendors.length) {
    root.innerHTML = `<div class="auth-screen"><div class="auth-card">
      ${lockup({ height: 28 })}
      <h1 class="auth-title">No cafeteria assigned</h1>
      <p class="auth-sub">This account holds a counter role but is not attached to an outlet.
      An administrator assigns it in Campus Control.</p>
      <button class="auth-btn" data-act="signout">Sign out</button></div></div>`;
    root.addEventListener('click', (e) => e.target.dataset.act === 'signout' && signOut());
    return;
  }
  S.vendorId = me.vendorIds[0] || vendors[0].id;
  S.vendor = vendors.find((v) => v.id === S.vendorId) || vendors[0];
  S.canPrice = session.has('vendor_owner', 'platform_owner', 'platform_admin');
  render(vendors);
}

/* Money is the owner's business, not the counter's: `finance` appears only
   for a cafeteria owner (or a platform role), which is the same set the
   server grants `finance.read` to. Staff asking for the route directly get
   a 403 from the API, so this is a courtesy, not the enforcement. */
const NAV = [['orders', 'Orders'], ['menu', 'Menu'], ['outlet', 'Outlet']];
const navFor = () => (S.canPrice ? [...NAV, ['finance', 'Finance']] : NAV);

let wired = false;
function render(vendors = []) {
  const v = vendorVM(S.vendor);
  root.innerHTML = `
    <div class="appframe">
      <aside class="rail">
        <div class="rail-brand">${lockup({ height: 24 })}
          <span class="t-xs faint">Counter</span></div>
        <div class="card card-pad" style="margin:10px 0">
          <div class="row" style="gap:10px">${Mark(v, 36)}
            <div><b>${esc(v.name)}</b>
              <div class="t-xs faint">${v.open ? 'Open' : 'Closed'}</div></div></div>
          ${session.isPlatform && vendors.length > 1 ? `
            <select class="input" data-act="switchVendor" style="margin-top:8px">
              ${vendors.map((x) => `<option value="${x.id}" ${x.id === S.vendorId ? 'selected' : ''}>
                ${esc(x.name)}</option>`).join('')}
            </select>` : ''}
          <button class="btn ${v.open ? 'btn-ink' : 'btn-primary'} btn-sm btn-block"
                  data-act="toggleOpen" data-v="${v.open ? '0' : '1'}" style="margin-top:8px">
            ${v.open ? 'Stop accepting orders' : 'Open for orders'}</button>
        </div>
        <nav class="stack">
          ${navFor().map(([r, l]) =>
            `<button class="railbtn" data-route="${r}" ${S.route === r ? 'aria-current="page"' : ''}>${esc(l)}</button>`).join('')}
        </nav>
        <div class="rail-foot">
          <div class="t-xs faint">${esc(session.me.user.name || session.me.user.phone)}</div>
          <div class="t-xs faint">${session.roles.map(esc).join(' · ')}</div>
          <button class="railbtn" data-act="theme">Theme</button>
          <button class="railbtn" data-act="signout">Sign out</button>
        </div>
      </aside>
      <main class="webmain">
        <nav class="chiprow webnav-mobile" aria-label="Pages"
             style="padding:var(--s-3) var(--s-4);border-bottom:1px solid var(--line)">
          ${navFor().map(([r, l]) =>
            `<button class="chip" data-route="${r}" ${S.route === r ? 'aria-pressed="true"' : ''}>${esc(l)}</button>`).join('')}
          <button class="chip" data-act="theme">Theme</button>
          <button class="chip" data-act="signout">Sign out</button>
        </nav>
        <header class="webhead">
          <div class="webhead-title">
            <h1 class="t-h2" id="page-title"></h1>
            <p class="t-sm muted" id="page-sub"></p>
          </div>
          <div class="row" id="head-actions"></div>
        </header>
        <div class="webbody"><div id="view" class="wrapmax"></div></div>
      </main>
    </div>`;
  if (!wired) {
    wired = true;
    root.addEventListener('click', onClick);
    root.addEventListener('change', (e) => {
      if (e.target.dataset.act === 'switchVendor') ACTIONS.switchVendor(e.target);
    });
  }
  route();
}

const view = () => document.getElementById('view');
const head = () => document.getElementById('head-actions');
const setTitle = (t, sub = '') => {
  document.getElementById('page-title').textContent = t;
  document.getElementById('page-sub').textContent = sub;
};

async function onClick(e) {
  const t = e.target.closest('[data-route],[data-act]');
  if (!t) return;
  if (t.dataset.route) { S.route = t.dataset.route; route(); return; }
  const fn = ACTIONS[t.dataset.act];
  if (fn) await fn(t, e);
}


/* The current page is marked with aria-current / aria-pressed, which is what
   .railbtn and .chip style. Called on every route change. */
function markNav() {
  root.querySelectorAll('.railbtn[data-route]').forEach((b) => {
    if (b.dataset.route === S.route) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  root.querySelectorAll('.webnav-mobile [data-route]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.route === S.route)));
}
const route = () => { markNav(); return ({ orders: scrOrders, menu: scrMenu, outlet: scrOutlet,
                       finance: scrFinance }[S.route] || scrOrders)(); };

/* ========================================================================
   FINANCE — this cafeteria's money, and only this cafeteria's

   Every figure comes from the server's ledger, scoped to this vendor by the
   session rather than by the id in the URL. There is no path from here to
   another cafeteria's books: the API answers 403.
   ======================================================================== */
async function scrFinance() {
  setTitle('Finance', 'What you have sold, what ECHO ECHO deducted, and what you are owed.');
  head().innerHTML = '';
  await panel(view(), () => quad.vendorFinance(S.vendorId), (d) => `
    <div class="grid-kpi">
      ${kpi('Sales today', rupees(d.todayFoodPaise), `${d.todayOrders} paid order(s)`)}
      ${kpi('Commission today', rupees(d.todayCommissionPaise),
            d.terms ? `${(d.terms.commission_bps / 100).toFixed(2)}% of food` : '')}
      ${kpi('Outstanding', rupees(d.outstanding_paise), 'owed to you now')}
      ${kpi('Settled', rupees(d.settled_paise), 'transferred to you')}
    </div>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">All time</h2>
      <div class="grid-kpi" style="margin-top:10px">
        ${kpi('Food sales', rupees(d.gross_food_sales_paise), 'gross, before commission')}
        ${kpi('Commission', rupees(d.commission_paise), 'deducted by ECHO ECHO')}
        ${kpi('Refunds', rupees(d.refunds_paise), 'your share of refunds')}
        ${kpi('Adjustments', rupees(d.adjustments_paise), 'corrections')}
        ${kpi('Net payable', rupees(d.net_payable_paise), 'earned in total')}
      </div>
      ${d.terms ? `<p class="t-xs faint" style="margin-top:10px">
        Commission is ${(d.terms.commission_bps / 100).toFixed(2)}% and is
        ${d.terms.commission_mode === 'charge_to_customer'
          ? 'added to what the customer pays, so your share is the full menu price'
          : 'deducted from your share of each order'}.
        Orders are always settled on the terms in force when they were placed.
      </p>` : ''}
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Settlements</h2>
      ${d.settlements.length ? table(
        ['Amount', 'State', 'Reference', 'When'],
        d.settlements.map((p) => [
          rupees(p.amount_paise),
          `<span class="badge ${p.state === 'paid' ? 'badge-open' : 'badge-closed'}">
             ${esc(p.state)}</span>`,
          esc(p.external_reference || p.provider_payout_id || '—'),
          when(p.paid_at || p.created_at),
        ])) : `<p class="t-sm muted">Nothing has been settled yet.</p>`}
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Recent paid orders</h2>
      ${d.orders.length ? table(
        ['Order', 'Food', 'Commission', 'Your share', 'When'],
        d.orders.map((o) => [
          esc(o.code), rupees(o.food_subtotal_paise), rupees(o.commission_paise),
          `<b>${rupees(o.cafeteria_payable_paise)}</b>`, when(o.created_at),
        ])) : `<p class="t-sm muted">No paid orders yet.</p>`}
    </section>`, { label: 'Loading your finances' });
}

const kpi = (label, value, note) => `
  <div class="kpi"><div class="t-label">${esc(label)}</div>
  <div class="statval">${esc(String(value))}</div>
  <div class="t-xs faint">${esc(note || '')}</div></div>`;

const table = (cols, rows) => `
  <div class="dtable-wrap"><table class="dtable">
    <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;

/* ========================================================================
   ORDERS — the live board
   ======================================================================== */
const COLUMNS = [
  ['confirmed', 'New'], ['preparing', 'Preparing'], ['ready', 'Ready'],
  ['assigned', 'With partner'], ['picked_up', 'On the way'],
];

/* The board re-reads the server every 20 seconds while it is the open screen
   and no dialog is up. Real state from the API, not an animation. */
let boardTimer = null;
function watchBoard() {
  clearInterval(boardTimer);
  boardTimer = setInterval(() => {
    if (S.route !== 'orders') return clearInterval(boardTimer);
    if (document.querySelector('.modalwrap') || document.hidden) return;
    scrOrders(true);
  }, 20_000);
}

async function scrOrders(quiet = false) {
  if (!quiet) watchBoard();
  setTitle('Orders', 'Paid orders only. An unpaid order never reaches this board.');
  head().innerHTML = `<button class="btn btn-secondary btn-sm" data-act="refresh">Refresh</button>`;
  await panel(view(), () => quad.orders({ scope: 'vendor', vendorId: S.vendorId }), (d) => {
    const live = d.orders.filter((o) => COLUMNS.some(([s]) => s === o.state));
    if (!live.length) {
      return EmptyState('No live orders.',
        'Orders appear here the moment a payment is confirmed by the gateway.');
    }
    return `<div class="board">${COLUMNS.map(([state, label]) => {
      const col = live.filter((o) => o.state === state);
      return `
        <section class="boardcol">
          <div class="boardcol-head"><b>${esc(label)}</b>
            <span class="chip chip-soft">${col.length}</span></div>
          ${col.map(ticket).join('') || `<p class="t-xs faint" style="padding:10px">Nothing here.</p>`}
        </section>`;
    }).join('')}</div>`;
  }, { label: 'Loading orders', quiet });
}

const NEXT = { confirmed: ['preparing', 'Start preparing'], preparing: ['ready', 'Mark ready'] };

const ticket = (o) => {
  const next = NEXT[o.state];
  return `
    <article class="ticket">
      <div class="between">
        <b>${esc(o.code)}</b>
        <span class="t-xs faint">${when(o.created_at)}</span>
      </div>
      <div class="kot">
        ${(o.items || []).map((i) => `
          <div class="kot-line"><span>${i.qty}× ${esc(i.name)}</span></div>`).join('')}
      </div>
      <div class="between" style="margin-top:8px">
        <span class="t-xs faint">${o.fulfilment === 'delivery' ? 'Delivery' : 'Pickup'}</span>
        <span class="money">${rupees(o.total_paise)}</span>
      </div>
      ${next ? `<button class="btn btn-primary btn-sm btn-block" data-act="advance"
                  data-id="${o.id}" data-to="${next[0]}" style="margin-top:8px">${next[1]}</button>` : ''}
      ${o.state === 'ready' && o.fulfilment === 'pickup'
        ? `<button class="btn btn-primary btn-sm btn-block" data-act="advance"
             data-id="${o.id}" data-to="delivered" style="margin-top:8px">Handed to customer</button>` : ''}
      ${o.state === 'ready' && o.fulfilment === 'delivery'
        ? `<p class="t-xs faint" style="margin-top:8px">Waiting for a delivery partner to accept.</p>` : ''}
      ${o.state === 'assigned' && o.fulfilment === 'delivery'
        ? `<button class="btn btn-primary btn-sm btn-block" data-act="pickupCode" data-id="${o.id}" data-code="${esc(o.code)}"
             style="margin-top:8px">Show pickup code</button>
           <p class="t-xs faint" style="margin-top:4px">Read it to the partner when you hand over the bag. Only then is it marked collected.</p>` : ''}
      <button class="btn btn-ghost btn-sm btn-block" data-act="ticketDetail" data-id="${o.id}">Details</button>
    </article>`;
};

/* ========================================================================
   MENU
   ======================================================================== */
async function scrMenu() {
  setTitle('Menu', S.canPrice
    ? 'Add food, set prices, control availability.'
    : 'You can mark items in and out of stock. Prices are set by the owner.');
  head().innerHTML = S.canPrice
    ? `<button class="btn btn-primary btn-sm" data-act="newItem">Add food</button>` : '';
  await paintMenu();
}

async function paintMenu() {
  await panel(view(), () => quad.menu(S.vendorId), (d) => {
    if (!d.items.length) {
      return EmptyState('No menu yet.',
        S.canPrice ? 'Add your first dish — it appears on the student site immediately.'
                   : 'The owner has not added anything yet.');
    }
    return `<div class="stack">${d.items.map((i) => `
      <div class="item ${i.active ? '' : 'faint'}">
        ${i.photo_asset
          ? `<img class="thumb-photo" src="${quad.assetUrl(i.photo_asset)}" alt="">`
          : `<div class="item-thumbwrap"><div class="item-thumb"></div></div>`}
        <div class="grow">
          <div class="row" style="gap:7px">
            ${i.veg === null || i.veg === undefined ? '' : VegMark(i.veg)}
            <b>${esc(i.name)}</b>
          </div>
          <div class="t-xs faint">
            ${i.rating ? `★ ${i.rating.average} (${i.rating.count})` : 'No ratings yet'}
            ${i.prep_minutes ? ` · ${i.prep_minutes} min` : ''}
          </div>
          ${!i.active ? `<span class="badge badge-danger">Archived</span>` : ''}
        </div>
        <div class="row" style="gap:8px">
          <span class="money">${rupees(i.price_paise)}</span>
          <button class="btn ${i.available ? 'btn-ghost' : 'btn-secondary'} btn-sm"
                  data-act="avail" data-id="${i.id}" data-v="${i.available ? '0' : '1'}">
            ${i.available ? 'In stock' : 'Out of stock'}</button>
          ${S.canPrice ? `
            <button class="btn btn-secondary btn-sm" data-act="editItem" data-id="${i.id}">Edit</button>
            <button class="btn btn-ghost btn-sm" data-act="priceLog" data-id="${i.id}">Price log</button>` : ''}
        </div>
      </div>`).join('')}
      ${!S.canPrice ? `<p class="t-xs faint" style="margin-top:12px">
        Editing prices and adding food requires the owner account. The server refuses
        these requests from a staff session, so the controls are not shown.</p>` : ''}`;
  }, { label: 'Loading menu' });
}

/* ========================================================================
   OUTLET
   ======================================================================== */
async function scrOutlet() {
  setTitle('Outlet', 'Your cafeteria as students see it.');
  head().innerHTML = '';
  await panel(view(), () => quad.vendors(), (d) => {
    const raw = d.vendors.find((x) => x.id === S.vendorId);
    const v = vendorVM(raw);
    return `
      <section class="card card-pad">
        <div class="row" style="gap:14px">${Mark(v, 56)}
          <div><h2 class="t-h2">${esc(v.name)}</h2>
            <p class="t-sm muted">${esc(v.kind || '')}</p>
            <p class="t-xs faint">${v.ratingText.empty
              ? 'No ratings yet — students can rate after a delivered order.'
              : `★ ${v.ratingText.text} from ${v.ratingText.count} rating${v.ratingText.count === 1 ? '' : 's'}`}</p>
          </div></div>
        <div class="row" style="gap:8px;margin-top:14px">
          <span class="badge ${v.open ? 'badge-open' : 'badge-closed'}">${v.open ? 'Open' : 'Closed'}</span>
          <span class="badge ${raw.delivery_enabled ? 'badge-open' : 'badge-closed'}">
            ${raw.delivery_enabled ? 'Delivers' : 'Pickup only'}</span>
        </div>
        ${S.canPrice ? `
          <button class="btn btn-secondary btn-sm" style="margin-top:14px" data-act="editOutlet">
            Edit outlet details</button>` : ''}
        <p class="t-xs faint" style="margin-top:12px">
          Creating or archiving a cafeteria, and assigning staff, is done by an
          administrator in Campus Control.
        </p>
      </section>`;
  }, { label: 'Loading outlet' });
}

/* ========================================================================
   MODAL + ACTIONS
   ======================================================================== */
/* The dialog lives on <body>, outside #app, so it needs its own listener —
   the shell's delegated handler never saw clicks in here, which is why Cancel,
   the backdrop and in-dialog actions did nothing. The backdrop is
   .scrim-fixed (made for this wrapper): the app's .scrim carries a z-index
   and a blur that put it ON TOP of the dialog, blurring it and eating clicks. */
/* An information-only dialog: one Done button, nothing to save. */
const DONE = () => Promise.resolve(true);
function modal(title, bodyHtml, onSubmit, sub = '') {
  const m = el(`
    <div class="modalwrap" role="dialog" aria-modal="true"><div class="scrim-fixed" data-act="closeModal"></div>
      <form class="modal">
        <div class="modal-head"><h2 class="t-h3">${esc(title)}</h2>
          ${sub ? `<p class="t-sm muted">${esc(sub)}</p>` : ''}</div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-foot">
          ${onSubmit === DONE ? '' : '<button type="button" class="btn btn-ghost" data-act="closeModal">Cancel</button>'}
          <button type="submit" class="btn btn-primary">${onSubmit === DONE ? 'Done' : 'Save'}</button>
        </div></form></div>`);
  document.body.append(m);
  lockScroll();
  /* One listener per dialog, removed with it: no stacking across opens. */
  m.addEventListener('click', onClick);
  m.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const data = Object.fromEntries(new FormData(e.target));
    const ok = await act(btn, () => onSubmit(data, e.target));
    if (ok !== null) { closeModal(m); route(); }
  });
  m.querySelector('input:not([type=hidden]):not([disabled]), select, textarea')?.focus();
  return m;
}
/* Closes the given dialog, or the one on top — dialogs can open dialogs. */
const closeModal = (target) => {
  const all = document.querySelectorAll('.modalwrap');
  const m = target instanceof Element && target.classList.contains('modalwrap') ? target : all[all.length - 1];
  m?.remove();
  lockScroll();
};
/* The page behind stays put while a dialog is open, and scrolls again after. */
function lockScroll() {
  document.body.style.overflow = document.querySelector('.modalwrap') ? 'hidden' : '';
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.modalwrap')) closeModal();
});
const field = (name, label, value = '', type = 'text') => `
  <label class="field"><span class="t-label">${esc(label)}</span>
  <input class="input" name="${name}" type="${type}" value="${esc(value ?? '')}"></label>`;
const check = (name, label, on) => `
  <label class="row" style="gap:8px"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}>
  <span class="t-sm">${esc(label)}</span></label>`;
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

const ACTIONS = {
  theme: () => toggleTheme(),
  signout: () => signOut(),
  closeModal,
  refresh: () => route(),

  switchVendor: async (t) => {
    S.vendorId = t.value;
    const vendors = (await quad.vendors()).vendors;
    S.vendor = vendors.find((v) => v.id === S.vendorId);
    render(vendors);
  },

  toggleOpen: async (t) => {
    await act(t, async () => {
      const on = t.dataset.v === '1';
      await quad.updateVendor(S.vendorId, { isOpen: on, accepting: on });
      const vendors = (await quad.vendors()).vendors;
      S.vendor = vendors.find((v) => v.id === S.vendorId);
      render(vendors);
    });
  },

  advance: (t) => act(t, () => quad.transition(t.dataset.id, t.dataset.to),
    { after: scrOrders }),

  /* The pickup code proves the partner collected THIS order from THIS counter.
     It is issued to the counter only, shown once, and replaced if requested
     again. The partner types it into their app. */
  pickupCode: async (t) => {
    const out = await act(t, () => quad.pickupCode(t.dataset.id));
    if (!out) return;
    modal(`Pickup code · ${t.dataset.code}`, `
      <p class="t-sm muted">Hand the bag over and read this code to the delivery partner. They enter it in their app.</p>
      <div class="enrolcode" style="letter-spacing:.3em">${esc(out.code)}</div>
      <p class="t-xs faint" style="margin-top:10px">Shown once. Asking again issues a new code and cancels this one.</p>`,
      DONE);
  },

  ticketDetail: async (t) => {
    const o = await quad.order(t.dataset.id);
    modal(`Order ${o.order.code}`, `
      <div class="sunken">
        ${o.items.map((i) => `<div class="kot-line"><span>${i.qty}× ${esc(i.name_snapshot)}</span>
          <span class="money">${rupees(i.line_paise)}</span></div>`).join('')}
        <div class="kot-line"><b>Total</b><b class="money">${rupees(o.order.total_paise)}</b></div>
      </div>
      <div class="rowmuted">Fulfilment: ${esc(o.order.fulfilment)}</div>
      <div class="rowmuted">Payment: ${o.payment ? esc(o.payment.status) : 'none'}</div>
      <h3 class="t-label" style="margin-top:12px">History</h3>
      ${o.events.map((e) => `<div class="rowmuted">${when(e.at)} — ${esc(e.to_state)}</div>`).join('')}`,
      DONE);
  },

  avail: (t) => act(t, () => quad.updateItem(t.dataset.id, { available: t.dataset.v === '1' }),
    { after: paintMenu }),

  newItem: () => modal('Add food', `
    ${field('name', 'Name')}${field('description', 'Description')}
    <div class="formrow">${field('price', 'Price (₹)')}${field('prepMinutes', 'Prep minutes', '', 'number')}</div>
    ${field('tags', 'Tags (comma separated)')}
    ${field('aliases', 'What students might call it (comma separated)')}
    ${check('veg', 'Vegetarian', true)}
    <label class="field"><span class="t-label">Photo</span>
      <input class="input" type="file" name="photo" accept="image/*"></label>
    <p class="t-xs faint">
      JPEG, PNG or WebP. The server checks the file's actual format, not its name.
    </p>`,
    async (d, form) => {
      const file = form.querySelector('input[name=photo]').files[0];
      const photoAsset = file ? (await quad.uploadPhoto(file, 'food_photo')).id : undefined;
      return quad.createItem(S.vendorId, {
        name: d.name, description: d.description, price: d.price,
        prepMinutes: +d.prepMinutes || null, veg: !!d.veg, photoAsset,
        tags: splitList(d.tags), aliases: splitList(d.aliases),
      });
    }),

  editItem: async (t) => {
    const i = (await quad.menu(S.vendorId)).items.find((x) => x.id === t.dataset.id);
    modal(`Edit ${i.name}`, `
      ${field('name', 'Name', i.name)}${field('description', 'Description', i.description)}
      <div class="formrow">${field('price', 'Price (₹)', (i.price_paise / 100).toFixed(2))}
      ${field('prepMinutes', 'Prep minutes', i.prep_minutes, 'number')}</div>
      ${field('tags', 'Tags', (i.tags || []).join(', '))}
      ${field('aliases', 'Aliases', (i.aliases || []).join(', '))}
      ${check('veg', 'Vegetarian', i.veg)}
      <label class="field"><span class="t-label">Replace photo</span>
        <input class="input" type="file" name="photo" accept="image/*"></label>
      <p class="t-xs faint">
        A new price applies to new orders only. Orders already placed keep the price
        the student agreed to.
      </p>`,
      async (d, form) => {
        const file = form.querySelector('input[name=photo]').files[0];
        const photoAsset = file ? (await quad.uploadPhoto(file, 'food_photo')).id : undefined;
        return quad.updateItem(i.id, {
          name: d.name, description: d.description, price: d.price,
          prepMinutes: +d.prepMinutes || null, veg: !!d.veg, photoAsset,
          tags: splitList(d.tags), aliases: splitList(d.aliases),
        });
      });
  },

  priceLog: async (t) => {
    const h = await quad.priceHistory(t.dataset.id);
    modal('Price history', h.history.length
      ? `<div class="stack">${h.history.map((r) => `
          <div class="rowmuted between">
            <span>${r.old_paise === null ? 'Set' : `${rupees(r.old_paise)} → ${rupees(r.new_paise)}`}</span>
            <span class="t-xs faint">${when(r.changed_at)} · ${esc(r.changed_by || 'system')}</span>
          </div>`).join('')}</div>
         <p class="t-xs faint" style="margin-top:10px">
           Orders placed before a change are unaffected — each one stores its own price.</p>`
      : `<p class="t-sm muted">No changes recorded.</p>`,
      DONE);
  },

  editOutlet: async () => {
    const v = (await quad.vendors()).vendors.find((x) => x.id === S.vendorId);
    modal('Outlet details', `
      ${field('name', 'Name', v.name)}${field('kind', 'Kind', v.kind)}
      ${field('description', 'Description', v.description)}
      <div class="formrow">${field('opensAt', 'Opens', v.opens_at, 'time')}
      ${field('closesAt', 'Closes', v.closes_at, 'time')}</div>
      ${field('prepMinutes', 'Typical prep minutes', v.prep_minutes, 'number')}
      ${check('deliveryEnabled', 'Offers delivery', v.delivery_enabled)}
      <p class="t-xs faint">
        Archiving an outlet is an administrator action — the server refuses it here.
      </p>`,
      (d) => quad.updateVendor(S.vendorId, { ...d, opensAt: d.opensAt || null, closesAt: d.closesAt || null,
        prepMinutes: +d.prepMinutes,
        deliveryEnabled: !!d.deliveryEnabled }));
  },
};
