/* ==========================================================================
   QUAD — CAMPUS CONTROL

   The administrative surface. Every panel reads from the API and every
   button is an HTTP call; there is no local model of the platform, so two
   admins looking at the same screen see the same thing, and a refresh
   changes nothing.

   Where a control is missing it is because the server would refuse it —
   `platform_owner` cannot be granted here, for instance, because no API
   grants it. The UI does not pretend otherwise.
   ========================================================================== */
import {
  quad, session, gate, el, panel, toast, act, explain, rupees, ratingLabel,
  vendorVM, EmptyState, NotConfigured, Loading, ErrorState, signOut, when, ORDER_LABEL, adminReauth,
} from '../../packages/ui/runtime.js';
import { esc, toggleTheme, restoreTheme, Mark } from '../../packages/ui/kit.js';
import { lockup, mark } from '../../brand/logo.js';
import { API_BASE, ApiError } from '../../packages/data/client.js';
import { ORDER_TABS, TAB_STATE, orderActions, avatarFor, chartGeometry } from '../../packages/ui/order-view.js';
import { qrSvg, groupKey } from '../../packages/ui/admin-enrol.js';

const root = document.getElementById('app');
restoreAdminTheme();

const S = { route: 'overview', vendorId: null, userId: null, caseId: null, parentId: null,
            orderFilter: {}, orderPage: 1, payFilter: {}, payPage: 1 };

/* Roles that can be signed in with an enrolment code. platform_owner is
   absent on purpose: an admin must not be able to mint their way into the
   account that grants admin. The owner uses the server-side CLI. */
const ENROLLABLE = ['platform_admin', 'support', 'vendor_owner', 'vendor_staff'];

gate(root, 'admin', render);

/* The sidebar, in the groups an administrator thinks in. Every page still
   reads its own API, which checks its own permission; hiding an entry here
   is a courtesy so nobody stares at a page of refusals. */
const NAV_GROUPS = [
  ['Operations', [
    ['overview', 'Overview', 'grid'], ['orders', 'Order History', 'bag'], ['deliveries', 'Live Deliveries', 'route'],
    ['cafeterias', 'Cafés', 'store'], ['menu', 'Menu Management', 'menu'],
    ['partners', 'Delivery Partners', 'bike'], ['verification', 'Verification', 'id'],
    ['users', 'Users', 'users'], ['trust', 'Incidents & deposits', 'shield'],
    ['reviews', 'Reviews', 'star'], ['locations', 'Locations', 'pin'], ['support', 'Support', 'chat'],
  ]],
  ['Website', [['website', 'Website Customization', 'brush']]],
  ['Money', [
    ['finance', 'Payments & Settlements', 'wallet'], ['payments', 'Gateway payments', 'card'],
    ['reports', 'Reports', 'chart'],
  ]],
  ['Access & system', [
    ['admins', 'Access Management', 'key'], ['sessions', 'Sessions', 'device'],
    ['audit', 'Audit Logs', 'log'], ['reliability', 'System Health', 'pulse'], ['platform', 'Platform settings', 'cog'],
  ]],
];
const NAV = NAV_GROUPS.flatMap(([, items]) => items);

/* Which permission opens each page. Hiding is a courtesy: every panel's API
   call is checked by the server regardless. */
const NAV_PERM = {
  cafeterias: ['cafeterias.view', 'cafeterias.manage'], menu: ['menus.view', 'menus.manage'],
  orders: ['orders.view'], users: ['students.view'], verification: ['students.view'],
  partners: ['partners.view'], trust: ['delivery.incidents', 'deposits.view'], reviews: ['reviews.view'],
  locations: ['locations.view', 'boundary.view', 'campuses.view'], support: ['support.view'],
  finance: ['finance.view'], admins: ['admins.view'], platform: ['platform.view'], audit: ['audit.view'],
  payments: ['finance.view'], reports: ['orders.view', 'finance.view'], reliability: ['platform.view'],
  website: ['website.customize', 'website.publish'], deliveries: ['orders.view'],
  sessions: ['admins.view'], order: ['orders.view'],
};
const allowed = (r) => !NAV_PERM[r] || session.can(...NAV_PERM[r]);
const allowedNav = () => NAV.filter(([r]) => allowed(r));

/* Line icons for the sidebar: one stroke weight, one 24px grid. */
const ICON = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 016 0v2"/>',
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3 3 0 000-6H9a3 3 0 010-6h6.5"/>',
  store: '<path d="M4 9.5L5.5 4h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 005.3 0 2.7 2.7 0 005.4 0 2.7 2.7 0 005.3 0"/><path d="M5.5 11.5V20h13v-8.5M10 20v-5h4v5"/>',
  menu: '<path d="M5 4.5h14v15H5z"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/>',
  bike: '<circle cx="5.5" cy="17" r="3.2"/><circle cx="18.5" cy="17" r="3.2"/><path d="M8 17h7l-3-8h-3M12 9l2-4h3"/>',
  id: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6.5 15.5c.6-1.3 1.5-2 2.5-2s1.9.7 2.5 2M14 10h4M14 13.5h3"/>',
  users: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5"/><path d="M15.5 5.8a3 3 0 010 5.4M17 14.7c1.6.6 2.8 2 3.4 4.3"/>',
  shield: '<path d="M12 3.5l7 2.8v5.2c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V6.3z"/><path d="M9 12l2 2 4-4"/>',
  star: '<path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4 7.2 18.9l.9-5.4-3.9-3.8 5.4-.8z"/>',
  pin: '<path d="M12 20.5s6-5.6 6-10.5a6 6 0 00-12 0c0 4.9 6 10.5 6 10.5z"/><circle cx="12" cy="10" r="2.2"/>',
  chat: '<path d="M4.5 6.5A2.5 2.5 0 017 4h10a2.5 2.5 0 012.5 2.5v7A2.5 2.5 0 0117 16h-6.2L6.5 19.5V16H7a2.5 2.5 0 01-2.5-2.5z"/>',
  brush: '<path d="M14.5 4.5l5 5-7.8 7.8-5-5z"/><path d="M6.7 12.3c-2 0-3.2 1.6-3.2 3.7 0 1.4-.5 2.4-1 3 3.6.3 6.8-.6 7.6-3.6"/>',
  wallet: '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 9.5h17M16 14h1.5"/><path d="M6 6l9-2.5L16.5 6"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2 2"/>',
  device: '<rect x="3.5" y="4.5" width="17" height="11" rx="2"/><path d="M9 19.5h6M12 15.5v4"/>',
  log: '<path d="M6 3.5h9l3 3v14H6z"/><path d="M15 3.5v3h3M9 11h6M9 14.5h6M9 18h3"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4L6 18M18 18l-1.6-1.6M7.6 7.6L6 6"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  out: '<path d="M14 4.5h4.5v15H14M10 8l-4 4 4 4M6 12h9.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z"/>',
  moon: '<path d="M19.5 14.5A7.5 7.5 0 019.5 4.5a7.5 7.5 0 1010 10z"/>',
  collapse: '<path d="M14.5 6l-6 6 6 6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M7.5 13.5h2M11 13.5h2M14.5 13.5h2M7.5 17h2M11 17h2"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  dots: '<circle cx="12" cy="5.5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
};
/* Campus Control keeps its own light/dark choice, so switching it never
   changes the public website's theme in the same browser. */
const ADMIN_THEME_KEY = 'echo-admin-theme';
function restoreAdminTheme() {
  try { const t = localStorage.getItem(ADMIN_THEME_KEY); if (t) document.documentElement.setAttribute('data-theme', t); } catch { /* storage blocked */ }
}
function toggleAdminTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(ADMIN_THEME_KEY, next); } catch { /* storage blocked */ }
}
const icon = (k, size = 19) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ''}</svg>`;

const ROLE_LABEL = { platform_owner: 'Owner', platform_admin: 'Administrator', support: 'Support' };
const navLabel = (r) => NAV.find(([k]) => k === r)?.[1] || 'Overview';

function render() {
  if (!allowed(S.route)) S.route = 'overview';
  let collapsed = false;
  try { collapsed = localStorage.getItem('cc-rail') === 'collapsed'; } catch { /* storage blocked */ }
  /* One source for the signed-in administrator's name: My Profile's display
     name from /auth/me, falling back to the account's own name. */
  const name = session.me.adminProfile?.displayName || session.me.user.name || session.me.user.email || 'Administrator';
  const role = session.roles.map((r) => ROLE_LABEL[r]).filter(Boolean)[0] || 'Staff';
  root.innerHTML = `
    <div class="cc${collapsed ? ' cc-collapsed' : ''}">
      <div class="cc-frame">
        <aside class="cc-rail" aria-label="Campus Control">
          <div class="cc-brand">
            ${mark({ size: 34 })}
            <span class="cc-brand-name">ECHO ECHO ADMIN</span>
          </div>
          <nav class="cc-nav" aria-label="Pages">
            ${NAV_GROUPS.map(([group, items]) => {
              const mine = items.filter(([r]) => allowed(r));
              return mine.length ? `<div class="cc-navgroup"><div class="cc-navlabel">${esc(group)}</div>
                ${mine.map(([r, l, ic]) => `<button type="button" class="cc-navbtn" data-route="${r}" title="${esc(l)}"
                  ${S.route === r ? 'aria-current="page"' : ''}>${icon(ic)}<span>${esc(l)}</span></button>`).join('')}</div>` : '';
            }).join('')}
          </nav>
          <div class="cc-rail-foot">
            <button type="button" class="cc-navbtn" data-act="collapseRail" aria-label="Collapse the sidebar">${icon('collapse')}<span>Collapse</span></button>
          </div>
        </aside>
        <main class="cc-main">
          <header class="cc-top">
            <form class="cc-search" data-form="search" role="search">
              ${icon('search', 17)}
              <input class="cc-search-in" name="q" type="search" placeholder="Search orders: code, student or café" aria-label="Search orders" autocomplete="off">
            </form>
            <div class="cc-top-right">
              <span id="site-status"></span>
              <a class="cc-iconbtn" href="/web/" target="_blank" rel="noopener" title="Open the public website" aria-label="Open the public website">${icon('globe')}</a>
              <button type="button" class="cc-iconbtn" data-act="notifications" aria-label="Notifications" aria-haspopup="true">${icon('bell')}<span class="cc-dot" id="notif-dot" hidden></span></button>
              <div class="cc-profile">
                <button type="button" class="cc-profile-btn" data-act="profileMenu" aria-haspopup="true" aria-expanded="false">
                  <span class="cc-avatar">${esc(initialsOf(name))}</span>
                  <span class="cc-profile-text"><span class="cc-profile-name">${esc(name)}</span><span class="cc-profile-role">${esc(role)}</span></span>
                </button>
                <div class="cc-menu" id="profile-menu" hidden>
                  <div class="cc-menu-head"><b>${esc(name)}</b><span class="t-xs muted">${esc(session.me.user.email || '')}</span>
                    <span class="t-xs muted">${esc(session.roles.map((r) => ROLE_LABEL[r] || r).join(' · '))} · password and authenticator session</span></div>
                  <button type="button" class="cc-menu-item" data-route="admins">${icon('key', 17)} Your sign-in and access</button>
                  <button type="button" class="cc-menu-item" data-act="theme">${icon('moon', 17)} Light or dark</button>
                  <button type="button" class="cc-menu-item danger" data-act="signout">${icon('out', 17)} Sign out</button>
                </div>
              </div>
            </div>
          </header>
          <div class="cc-panel">
            <div class="cc-pagehead">
              <div class="cc-pagehead-text">
                <nav class="cc-crumbs" aria-label="Breadcrumb"><span>Campus Control</span><span aria-hidden="true">/</span><span id="crumb-page">${esc(navLabel(S.route))}</span></nav>
                <h1 class="cc-title" id="page-title"></h1>
                <p class="cc-sub" id="page-sub"></p>
              </div>
              <div class="cc-head-actions" id="head-actions"></div>
            </div>
            <div id="view" class="cc-view"></div>
          </div>
        </main>
      </div>
    </div>`;
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onFormSubmit);
  document.addEventListener('click', closeMenusOutside);
  route();
}

const initialsOf = (n) => String(n).split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'A';

/* The bell's unread dot and the website's live version, refreshed with each
   page. Both are optional: a failure leaves them blank, never an error. */
async function refreshTopbar() {
  quad.notifications('true').then((r) => {
    const dot = document.getElementById('notif-dot');
    if (dot) dot.hidden = !(r.notifications || []).length;
  }).catch(() => {});
  const box = document.getElementById('site-status');
  if (!box || !allowed('website')) return;
  try {
    const d = await quad.adminSite();
    const changed = d.draft.revision > 0 && (d.draft.baseVersion !== (d.live?.version ?? null)
      || JSON.stringify(d.draft.config) !== JSON.stringify(d.live?.config ?? d.defaults));
    box.innerHTML = `<button type="button" class="cc-sitechip${changed ? ' is-draft' : ''}" data-route="website"
      title="Website settings">${d.live ? `Website v${d.live.version} live` : 'Website: built-in settings'}${changed ? ' · unpublished draft' : ''}</button>`;
  } catch { box.innerHTML = ''; }
}

function closeMenusOutside(e) {
  /* An order row's menu closes on any click except the button that opened it. */
  if (!e.target.closest('.oh-dots')) document.querySelector('.oh-menu')?.remove();
  if (e.target.closest('.cc-profile, .cc-notifs, [data-act="notifications"]')) return;
  document.querySelectorAll('.cc-menu:not(.oh-menu)').forEach((m) => { m.hidden = true; });
  document.querySelector('.cc-profile-btn')?.setAttribute('aria-expanded', 'false');
  document.querySelector('.cc-notifs')?.remove();
}

const view = () => document.getElementById('view');
const head = () => document.getElementById('head-actions');
const setTitle = (t, sub = '') => {
  document.getElementById('page-title').textContent = t;
  document.getElementById('page-sub').textContent = sub;
  const crumb = document.getElementById('crumb-page');
  if (crumb) crumb.textContent = navLabel(S.route);
};

async function onClick(e) {
  const t = e.target.closest('[data-route],[data-act]');
  if (!t) return;
  if (t.dataset.route) {
    if (S.route === 'website' && t.dataset.route !== 'website' && wDirty()
        && !confirm('The website draft has unsaved changes. Leave without saving them?')) return;
    S.route = t.dataset.route; route(); return;
  }
  const fn = ACTIONS[t.dataset.act];
  if (fn) await fn(t, e);
}

const SCREENS = {
  overview: scrOverview, cafeterias: scrCafeterias, menu: scrMenu, orders: scrOrders,
  users: scrUsers, verification: scrVerification, partners: scrPartners,
  trust: scrTrust, reviews: scrReviews, admins: scrAdmins,
  locations: scrLocations, support: scrSupport, finance: scrFinance,
  platform: scrPlatform, audit: scrAudit,
  payments: scrPayments, reliability: scrReliability, reports: scrReports,
  website: scrWebsite, deliveries: scrDeliveries, sessions: scrSessions, order: scrOrderDetail,
};

/* The current page is marked with aria-current / aria-pressed, which is what
   .railbtn and .chip style. Called on every route change. */
function markNav() {
  const here = S.route === 'order' ? 'orders' : S.route;
  root.querySelectorAll('.cc-navbtn[data-route]').forEach((b) => {
    if (b.dataset.route === here) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.cc-menu').forEach((m) => { m.hidden = true; });
}
const route = () => { markNav(); refreshTopbar(); return (SCREENS[S.route] || scrOverview)(); };

/* ========================================================================
   OVERVIEW — counts, and honest gaps
   ======================================================================== */
async function scrOverview() {
  setTitle('Overview', 'Live platform state.');
  head().innerHTML = '';
  /* Each figure is fetched only when this administrator holds the permission
     behind it; the rest show as not available to them rather than failing. */
  const when_ = (ok, fn) => (ok ? fn() : Promise.resolve(null));
  await panel(view(), async () => {
    const [vendors, orders, cases, partners, flags, money, rel] = await Promise.all([
      when_(session.can('cafeterias.manage'), async () => (await quad.vendors({ includeArchived: 'true' })).vendors)
        .then((v) => v ?? (session.can('cafeterias.view') ? quad.vendors().then((x) => x.vendors) : null)),
      when_(session.can('orders.view'), async () => (await quad.orders({ scope: 'all' })).orders),
      when_(session.can('students.view'), async () => (await quad.verificationQueue('pending')).cases),
      when_(session.can('partners.view'), async () => (await quad.partners('pending')).partners),
      when_(session.can('platform.view'), () => quad.flags()),
      when_(session.can('finance.view'), async () => ({
        today: await quad.financeSummary({ from: startOfToday() }), all: await quad.financeSummary() })),
      /* A reliability failure must not blank the overview: it is shown as
         unavailable instead. */
      when_(session.can('platform.view'), () => quad.reliability().catch(() => null)),
    ]);
    return { vendors, orders, cases, partners, flags, money, rel };
  }, (d) => {
    const live = (d.orders || []).filter((o) =>
      ['confirmed', 'preparing', 'ready', 'assigned', 'picked_up'].includes(o.state));
    const missing = d.flags ? Object.entries(d.flags.providers)
      .filter(([, v]) => !v.configured).map(([k]) => k) : [];
    const na = 'not in your permissions';
    d.orders ||= [];
    return `
      <div class="grid-kpi">
        ${d.vendors ? kpi('Cafeterias', d.vendors.filter((v) => v.active).length,
              `${d.vendors.filter((v) => v.is_open && v.accepting).length} open now`) : kpi('Cafeterias', '—', na)}
        ${session.can('orders.view') ? kpi('Live orders', live.length, `${d.orders.length} total`) : kpi('Live orders', '—', na)}
        ${d.cases ? kpi('ID reviews waiting', d.cases.length,
              d.cases.length ? 'within a 24-hour SLA' : 'nothing waiting') : kpi('ID reviews waiting', '—', na)}
        ${d.partners ? kpi('Partner applications', d.partners.length, '') : kpi('Partner applications', '—', na)}
      </div>
      ${d.money ? `
        <section class="card card-pad" style="margin-top:18px">
          <div class="between"><h2 class="t-label">Money</h2>
            <button type="button" class="btn btn-ghost btn-sm" data-route="finance">Open settlements</button></div>
          <div class="grid-kpi" style="margin-top:10px">
            ${kpi('GMV today', rupees(d.money.today.gmvPaise), `${d.money.today.orders} order(s)`)}
            ${kpi('Platform fees today', rupees(d.money.today.platformFeesPaise), 'owner earnings, gross')}
            ${kpi('ECHO ECHO revenue', rupees(d.money.all.quadNetRevenuePaise), 'all time, net of refunds and gateway fees')}
            ${kpi('Owed to cafés', rupees(d.money.all.cafeteriaPayablePaise), 'payable now')}
            ${kpi('Owed to partners', rupees(d.money.all.deliveryPayablePaise), 'earned, not yet paid')}
            ${kpi('Payouts in flight', d.money.all.payoutsInFlight.count, rupees(d.money.all.payoutsInFlight.amountPaise))}
          </div>
        </section>` : ''}
      ${d.rel && (!d.rel.ok || d.rel.summary.warnings) ? `
        <section class="card card-pad" style="margin-top:18px">
          <div class="between"><h2 class="t-label">Alerts</h2>
            <button type="button" class="btn btn-ghost btn-sm" data-route="reliability">Open reliability</button></div>
          ${d.rel.checks.filter((c) => !c.ok).map((c) => `
            <div class="rowmuted"><span class="badge ${c.severity === 'error' ? 'badge-danger' : 'badge-warn'}">${
              c.severity === 'error' ? 'error' : 'warning'}</span> ${esc(c.label)}: ${esc(c.detail)}</div>`).join('')}
        </section>` : ''}
      ${missing.length ? `
        <section class="card card-pad" style="margin-top:18px">
          <h2 class="t-label">Not configured on this server</h2>
          <p class="t-sm muted">
            These integrations have no credentials, so the features that depend on them
            are unavailable rather than degraded. They are not errors.
          </p>
          <div class="chiprow">${missing.map((m) => `<span class="chip chip-soft">${esc(m)}</span>`).join('')}</div>
        </section>` : ''}
      <section class="card card-pad" style="margin-top:18px">
        <h2 class="t-label">Recent orders</h2>
        ${d.orders.length ? table(
          ['Code', 'Cafeteria', 'State', 'Total', 'When'],
          d.orders.slice(0, 10).map((o) => [esc(o.code), esc(o.vendor_name),
            esc(ORDER_LABEL[o.state] || o.state), rupees(o.total_paise), when(o.created_at)]))
          : `<p class="t-sm muted">No orders yet.</p>`}
      </section>`;
  }, { label: 'Loading platform state' });
}

const KPI_ICON = { Cafeterias: 'store', 'Live orders': 'bag', 'ID reviews waiting': 'id', 'Partner applications': 'bike',
  'GMV today': 'chart', 'Platform fees today': 'wallet', 'ECHO ECHO revenue': 'wallet', 'Owed to cafés': 'store',
  'Owed to partners': 'bike', 'Payouts in flight': 'card' };
const kpi = (label, value, note) => statCard(KPI_ICON[label] || 'grid', label, value, note);

const table = (cols, rows) => `
  <div class="dtable-wrap"><table class="dtable">
    <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;

/* ========================================================================
   FINANCE — where every rupee is

   Nothing on this screen is computed in the browser. Each figure arrives
   from a ledger or snapshot aggregate on the server, already in paise, and
   is only formatted here. The visual system is the approved one: the same
   kpi tiles, cards and data tables the rest of Campus Control uses.
   ======================================================================== */
async function scrFinance() {
  setTitle('Finance', 'Every rupee, from what the customer paid to what has been settled.');
  head().innerHTML = `
    <button class="btn btn-secondary btn-sm" data-act="editPricing">Commercial terms</button>
    <button class="btn btn-secondary btn-sm" data-act="editSchedule">Settlement schedule</button>
    <button class="btn btn-primary btn-sm" data-act="buildBatch" data-kind="cafeteria">
      Settle cafeterias now</button>
    <button class="btn btn-primary btn-sm" data-act="buildBatch" data-kind="partner">
      Settle partners now</button>`;

  await panel(view(), async () => ({
    today: await quad.financeSummary({ from: startOfToday() }),
    all: await quad.financeSummary(),
    cafeterias: (await quad.financeCafeterias()).cafeterias,
    partners: (await quad.financePartners()).partners,
    payouts: await quad.payouts(),
    recon: await quad.reconciliation(),
    pricing: await quad.pricing(),
    schedule: await quad.settlementSchedule(),
  }), (d) => {
    const t = d.today, a = d.all;
    const platform = d.pricing.live.find((p) => !p.vendor_id);
    const unconfigured = platform && !platform.commission_bps &&
                         !platform.platform_fee_flat_paise && !platform.platform_fee_bps;
    return `
      <div class="grid-kpi">
        ${kpi("Today's orders", t.orders, `${rupees(t.gmvPaise)} GMV`)}
        ${kpi('Platform fees', rupees(t.platformFeesPaise), 'today')}
        ${kpi('Commissions', rupees(t.commissionsPaise), 'today')}
        ${kpi('Delivery earnings', rupees(t.deliveryEarningsPaise), 'today')}
        ${kpi('Refunds', rupees(t.refundsPaise), `${t.refunds} today`)}
        ${kpi('ECHO ECHO revenue', rupees(t.quadNetRevenuePaise), 'today, net of refunds and fees')}
      </div>

      ${unconfigured ? `
        <section class="card card-pad" style="margin-top:18px">
          <h2 class="t-label">No commercial terms are set</h2>
          <p class="t-sm muted">
            Commission and platform fee are both zero, so ECHO ECHO is currently taking nothing
            from any order. Set the terms before trading; orders already placed keep the
            terms they were priced under.
          </p>
          <button class="btn btn-primary btn-sm" data-act="editPricing">Set terms</button>
        </section>` : ''}

      <section class="card card-pad" style="margin-top:18px">
        <h2 class="t-label">Owed and settled, all time</h2>
        <div class="grid-kpi" style="margin-top:10px">
          ${kpi('Cafeteria payable', rupees(a.cafeteriaPayablePaise), 'outstanding now')}
          ${kpi('Delivery payable', rupees(a.deliveryPayablePaise), 'earned, not yet paid')}
          ${kpi('Unsettled', rupees(a.unsettledPaise), 'both sides together')}
          ${kpi('Settled', rupees(a.settledCafeteriaPaise + a.settledPartnerPaise),
                'transfers recorded')}
          ${kpi('ECHO ECHO revenue', rupees(a.quadNetRevenuePaise),
                `${rupees(a.quadGrossRevenuePaise)} gross`)}
          ${kpi('Held at gateway', rupees(a.clearingBalancePaise), 'collected, not disbursed')}
        </div>
        ${a.payoutsInFlight.count ? `<p class="t-xs faint" style="margin-top:10px">
          ${a.payoutsInFlight.count} payout(s) in flight, ${rupees(a.payoutsInFlight.amountPaise)}.
        </p>` : ''}
      </section>

      ${a.payoutProvider.configured ? '' : `
        <section class="card card-pad" style="margin-top:18px">
          <h2 class="t-label">Settlement is manual on this deployment</h2>
          <p class="t-sm muted">${esc(a.payoutProvider.note)}</p>
        </section>`}

      <section class="card card-pad" style="margin-top:18px">
        <h2 class="t-label">Cafeterias</h2>
        ${d.cafeterias.length ? table(
          ['Cafeteria', 'Food sales', 'Commission', 'Refunds', 'Settled', 'Outstanding', ''],
          d.cafeterias.map((c) => [
            esc(c.name),
            rupees(c.gross_food_sales_paise),
            rupees(c.commission_paise),
            rupees(c.refunds_paise),
            rupees(c.settled_paise),
            `<b>${rupees(c.outstanding_paise)}</b>`,
            `<button class="btn btn-ghost btn-sm" data-act="adjust"
                     data-vendor="${c.vendor_id}" data-name="${esc(c.name)}">Adjust</button>`,
          ])) : `<p class="t-sm muted">No cafeteria has traded yet.</p>`}
      </section>

      <section class="card card-pad" style="margin-top:18px">
        <h2 class="t-label">Delivery partners</h2>
        ${d.partners.length ? table(
          ['Partner', 'Deliveries', 'Earned', 'Paid out', 'Pending'],
          d.partners.map((p) => [
            esc(p.name || '—'), String(p.completed_deliveries),
            rupees(p.total_earned_paise), rupees(p.paid_out_paise),
            `<b>${rupees(p.pending_payout_paise)}</b>`,
          ])) : `<p class="t-sm muted">No partner has earned yet.</p>`}
      </section>

      <section class="card card-pad" style="margin-top:18px">
        <div class="between">
          <h2 class="t-label">Gateway reconciliation</h2>
          <button class="btn btn-ghost btn-sm" data-act="reconcileNow">Import settlements</button>
        </div>
        <p class="t-sm muted">
          The gateway fee comes from the provider's own settlement report and nowhere else —
          never from the payment webhook, and never estimated from a rate. Runs automatically
          once a day.
        </p>
        <div class="grid-kpi" style="margin-top:10px">
          ${kpi('Reconciled',
                `${d.recon.coverage.reconciledPayments} / ${d.recon.coverage.paidPayments}`,
                'captured payments matched to a settlement')}
          ${kpi('Awaiting settlement', d.recon.coverage.unreconciledPayments,
                'no gateway charge recorded yet')}
          ${kpi('Open differences', d.recon.blockingCount,
                d.recon.blockingCount ? 'needs a person' : 'nothing outstanding')}
        </div>
        ${d.recon.coverage.unreconciledPayments
          ? `<p class="t-sm muted">Net revenue is provisional until every captured payment is
               reconciled: unreconciled orders carry no gateway charge yet.</p>`
          : ''}
        ${d.recon.exceptions.length ? table(
          ['Difference', 'Order', 'Detail', 'Seen', ''],
          d.recon.exceptions.slice(0, 25).map((x) => [
            `<span class="badge ${x.severity === 'blocking' ? 'badge-danger' : 'badge-closed'}">${
               esc(x.kind.replace(/_/g, ' '))}</span>`,
            esc(x.order_code || '—'),
            `<span class="t-xs faint">${esc(JSON.stringify(x.detail).slice(0, 120))}</span>`,
            when(x.created_at),
            `<button class="btn btn-ghost btn-sm" data-act="resolveRecon" data-id="${x.id}">
               Resolve</button>`,
          ])) : `<p class="t-sm muted">No open differences.</p>`}
        ${d.recon.imports.length ? `<p class="t-xs faint" style="margin-top:10px">
          Last run: ${esc(d.recon.imports[0].state.replace(/_/g, ' '))} —
          ${d.recon.imports[0].entries_seen} lines, ${d.recon.imports[0].entries_new} applied,
          ${d.recon.imports[0].entries_duplicate} already known,
          ${d.recon.imports[0].exceptions_raised} differences,
          ${when(d.recon.imports[0].started_at)}</p>` : ''}
      </section>

      <section class="card card-pad" style="margin-top:18px">
        <div class="between">
          <h2 class="t-label">Settlement batches</h2>
          <span class="t-xs faint">
            Cafeterias ${d.schedule.cafeteria.enabled
              ? `daily at ${pad(d.schedule.cafeteria.hour)}:${pad(d.schedule.cafeteria.minute)}`
              : 'not scheduled'} ·
            partners ${d.schedule.partner.enabled
              ? `${WEEKDAY[d.schedule.partner.weekday]} at ${pad(d.schedule.partner.hour)}:${pad(d.schedule.partner.minute)}`
              : 'not scheduled'} ·
            ${esc(d.schedule.timezone)}
          </span>
        </div>
        <p class="t-sm muted">
          Batches are calculated automatically from the ledger. Approving one records that
          you reviewed it; releasing one is what actually pays.
        </p>
        ${d.payouts.batches.length ? table(
          ['Period', 'Kind', 'Payouts', 'Total', 'State', 'Built', ''],
          d.payouts.batches.map((b) => [
            esc(b.period_key || 'manual'),
            esc(b.kind),
            String(b.payouts),
            rupees(b.total_paise),
            /* The SERVER's derived status, not the raw review state: it folds
               in what the payouts underneath actually did. PARTIALLY_FAILED
               is the one that earns its place — a batch where one transfer
               bounced must not read as PAID. */
            `<span class="badge ${b.status === 'PAID' ? 'badge-open'
              : b.status === 'FAILED' || b.status === 'PARTIALLY_FAILED' ? 'badge-danger'
              : b.status === 'APPROVED' || b.status === 'PROCESSING' ? 'badge-warn'
              : 'badge-closed'}">${esc((b.status || b.state).replace(/_/g, ' '))}</span>`,
            when(b.created_at),
            `<button class="btn btn-ghost btn-sm" data-act="openBatch" data-id="${b.id}">
               Review</button>`,
          ])) : `<p class="t-sm muted">No settlement batches yet.</p>`}
      </section>

      <section class="card card-pad" style="margin-top:18px">
        <h2 class="t-label">Payouts</h2>
        ${d.payouts.payouts.length ? table(
          ['Payee', 'Amount', 'State', 'Method', 'Reference', 'When', ''],
          d.payouts.payouts.map((p) => [
            esc(p.vendor_name || p.partner_name || '—'),
            rupees(p.amount_paise),
            `<span class="badge ${p.state === 'paid' ? 'badge-open'
              : p.state === 'failed' ? 'badge-warn' : 'badge-closed'}">${esc(p.state)}</span>`,
            esc(p.method || '—'),
            esc(p.external_reference || p.provider_payout_id || '—'),
            when(p.paid_at || p.created_at),
            p.state === 'pending' || p.state === 'processing'
              ? `<button class="btn btn-primary btn-sm" data-act="recordPayout"
                         data-id="${p.id}" data-amt="${p.amount_paise}">Record transfer</button>`
              : '',
          ])) : `<p class="t-sm muted">No payouts yet. Build a settlement batch above.</p>`}
      </section>

      <section class="card card-pad" style="margin-top:18px">
        <h2 class="t-label">Commercial terms in force</h2>
        ${table(['Scope', 'Commission', 'Treatment', 'Platform fee', 'Delivery charged',
                 'Partner earns', 'Since'],
          d.pricing.live.map((p) => [
            esc(p.vendor_name || 'Platform default'),
            `${(p.commission_bps / 100).toFixed(2)}%`,
            esc(p.commission_mode === 'charge_to_customer'
                ? 'added to the customer' : 'deducted from the cafeteria'),
            `${rupees(p.platform_fee_flat_paise)}${p.platform_fee_bps
                ? ` + ${(p.platform_fee_bps / 100).toFixed(2)}%` : ''}`,
            rupees(p.delivery_fee_paise), rupees(p.delivery_earning_paise),
            when(p.effective_from),
          ]))}
        <p class="t-xs faint" style="margin-top:10px">
          Superseded versions are kept. An order is always settled on the terms it was
          priced under, never on these.
        </p>
      </section>`;
  }, { label: 'Loading the books' });
}

const WEEKDAY = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays',
                'Thursdays', 'Fridays', 'Saturdays'];
const pad = (n) => String(n).padStart(2, '0');

const startOfToday = () => {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString();
};

/* ========================================================================
   CAFETERIAS
   ======================================================================== */
async function scrCafeterias() {
  setTitle('Cafeterias', 'Add outlets, assign owners, control trading.');
  head().innerHTML = `<button class="btn btn-primary btn-sm" data-act="newVendor">Add cafeteria</button>`;
  await panel(view(), () => quad.vendors({ includeArchived: 'true' }), (d) => {
    if (!d.vendors.length) {
      return EmptyState('No cafeterias yet.', 'Add the first one to start the platform.');
    }
    return `<div class="stack">${d.vendors.map((raw) => {
      const v = vendorVM(raw);
      return `
        <section class="card card-pad ${raw.active ? '' : 'faint'}">
          <div class="between">
            <div class="row" style="gap:12px">
              ${Mark(v, 44)}
              <div><b class="t-h3">${esc(v.name)}</b>
                <div class="t-xs faint">${esc(v.kind || '')} ·
                  ${v.ratingText.empty ? 'No ratings yet'
                    : `★ ${v.ratingText.text} (${v.ratingText.count})`}</div></div>
            </div>
            <div class="row" style="gap:8px">
              <span class="badge ${raw.active ? (v.open ? 'badge-open' : 'badge-closed') : 'badge-warn'}">
                ${!raw.active ? 'Archived' : v.open ? 'Open' : raw.is_open ? 'Orders paused' : 'Closed'}</span>
            </div>
          </div>
          <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" data-act="editVendor" data-id="${v.id}">Edit</button>
            <button class="btn btn-secondary btn-sm" data-act="menuFor" data-id="${v.id}">Menu</button>
            <button class="btn btn-secondary btn-sm" data-act="assignOwner" data-id="${v.id}">Assign owner</button>
            <button class="btn btn-secondary btn-sm" data-act="assignStaff" data-id="${v.id}">Add staff</button>
            <button class="btn btn-ghost btn-sm" data-act="toggleOpen" data-id="${v.id}" data-v="${v.open ? '0' : '1'}">
              ${v.open ? 'Close' : 'Open'}</button>
            ${raw.is_open ? `<button class="btn btn-ghost btn-sm" data-act="toggleAccepting" data-id="${v.id}"
              data-v="${raw.accepting ? '0' : '1'}">${raw.accepting ? 'Pause new orders' : 'Resume new orders'}</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-act="archiveVendor" data-id="${v.id}" data-v="${raw.active ? '0' : '1'}">
              ${raw.active ? 'Archive' : 'Restore'}</button>
          </div>
        </section>`;
    }).join('')}</div>`;
  }, { label: 'Loading cafeterias' });
}

/* ========================================================================
   MENU — across every cafeteria
   ======================================================================== */
async function scrMenu() {
  setTitle('Menu', 'Every item on the platform. Admins can edit any cafeteria.');
  const vs = (await quad.vendors({ includeArchived: 'true' })).vendors;
  if (!vs.length) { view().innerHTML = EmptyState('No cafeterias yet.', 'Add one first.'); return; }
  S.vendorId = S.vendorId && vs.some((v) => v.id === S.vendorId) ? S.vendorId : vs[0].id;
  head().innerHTML = `
    <select class="input" data-act="pickVendor" style="max-width:220px">
      ${vs.map((v) => `<option value="${v.id}" ${v.id === S.vendorId ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}
    </select>
    <button class="btn btn-secondary btn-sm" data-act="categories">Categories</button>
    <button class="btn btn-primary btn-sm" data-act="newItem">Add food</button>`;
  await paintMenu();
}

async function paintMenu() {
  await panel(view(), () => quad.menu(S.vendorId), (d) => {
    if (!d.items.length) return EmptyState('No items yet.', 'Add the first dish for this cafeteria.');
    return `<div class="stack">${d.items.map((i) => `
      <div class="item ${i.active ? '' : 'faint'}">
        ${i.photo_asset
          ? `<img class="thumb-photo" src="${quad.assetUrl(i.photo_asset)}" alt="">`
          : `<div class="item-thumbwrap"><div class="item-thumb"></div></div>`}
        <div class="grow">
          <b>${esc(i.name)}</b>
          <div class="t-xs faint">${esc(i.category || 'Uncategorised')} ·
            ${i.ratingText || (i.rating ? `★ ${i.rating.average} (${i.rating.count})` : 'No ratings yet')}</div>
          ${!i.available ? `<span class="badge badge-warn">Unavailable</span>` : ''}
          ${!i.active ? `<span class="badge badge-danger">Archived</span>` : ''}
        </div>
        <div class="row" style="gap:8px">
          <span class="money">${rupees(i.price_paise)}</span>
          <button class="btn btn-secondary btn-sm" data-act="editItem" data-id="${i.id}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-act="itemAvail" data-id="${i.id}" data-v="${i.available ? '0' : '1'}">
            ${i.available ? 'Mark out' : 'Mark in'}</button>
          <button class="btn btn-ghost btn-sm" data-act="itemArchive" data-id="${i.id}" data-v="${i.active ? '0' : '1'}">
            ${i.active ? 'Archive' : 'Restore'}</button>
          <button class="btn btn-ghost btn-sm" data-act="itemDelete" data-id="${i.id}" data-name="${esc(i.name)}">Delete</button>
        </div>
      </div>`).join('')}</div>`;
  }, { label: 'Loading menu' });
}

/* ========================================================================
   ORDERS · USERS · VERIFICATION · PARTNERS
   ======================================================================== */
async function scrUsers() {
  setTitle('Users', 'Search, inspect, assign roles, suspend.');
  head().innerHTML = `
    <input class="input" id="user-q" placeholder="Search name, phone or roll" style="max-width:240px">
    <button class="btn btn-secondary btn-sm" data-act="searchUsers">Search</button>
    <button class="btn btn-primary btn-sm" data-act="addRole">Assign role</button>`;
  await paintUsers('');
}

async function paintUsers(term) {
  await panel(view(), () => quad.users(term), (d) => {
    if (!d.users.length) return EmptyState('No users found.', '');
    return table(['Name', 'Phone / student email', 'Roles', 'Verification', 'Status', ''],
      d.users.map((u) => [
        esc(u.name || '—'), esc(u.phone || u.student_email || '—'),
        (u.roles || []).map((r) => `<span class="chip chip-soft">${esc(r.role)}${
          r.vendorName ? ` · ${esc(r.vendorName)}` : ''}</span>`).join(' ') || '—',
        `<span class="badge ${u.student_status === 'approved' ? 'badge-open'
          : u.student_status === 'pending' ? 'badge-warn' : 'badge-closed'}">${esc(u.student_status)}</span>`,
        `<span class="badge ${u.status === 'active' ? 'badge-open' : 'badge-danger'}">${esc(u.status)}</span>`,
        `<button class="btn btn-ghost btn-sm" data-act="inspectUser" data-id="${u.id}">Open</button>
         ${(u.roles || []).some((r) => ENROLLABLE.includes(r.role))
           ? `<button class="btn btn-ghost btn-sm" data-act="issueEnrol" data-id="${u.id}">
                Enrolment code</button>` : ''}
         <button class="btn btn-ghost btn-sm" data-act="toggleSuspend" data-id="${u.id}"
                 data-v="${u.status === 'active' ? 'suspended' : 'active'}">
           ${u.status === 'active' ? 'Suspend' : 'Restore'}</button>`,
      ]));
  }, { label: 'Loading users' });
}

const METHOD_LABEL = {
  institutional_email: 'University email',
  id_card: 'College ID card',
  manual: 'Manual request',
};

async function scrVerification() {
  setTitle('Student verification', 'Every submission is decided by a person.');
  const f = S.verifyFilter || 'pending';
  head().innerHTML = ['pending', 'needs_review', 'approved', 'rejected', 'all']
    .map((s) => `<button class="btn btn-ghost btn-sm" data-act="vqFilter" data-v="${s}" aria-pressed="${s === f}">${esc(s.replace('_', ' '))}</button>`).join('');
  await paintVerification(f);
}

async function paintVerification(state) {
  await panel(view(), () => quad.verificationQueue(state), (d) => {
    if (!d.cases.length) {
      return EmptyState('Nothing in this queue.',
        state === 'pending' ? 'No student is waiting on a decision.' : '');
    }
    return `<div class="stack">${d.cases.map((k) => `
      <section class="card card-pad">
        <div class="between">
          <div><b class="t-h3">${esc(k.user_name || k.verified_student_email || k.phone)}</b>
            <div class="t-xs faint">${esc(METHOD_LABEL[k.method] || k.method)} ·
              Claimed: ${esc(k.claimed_name || '—')} ·
              ${esc(k.claimed_roll || 'no roll number')} · submitted ${when(k.submitted_at)}</div>
            <div class="t-xs faint">Student mailbox: ${k.verified_student_email
              ? `<b>${esc(k.verified_student_email)}</b> — control proven by one-time code ${when(k.student_email_verified_at)}`
              : 'not proven'}</div>
            ${k.request_note ? `<div class="t-sm" style="margin-top:6px">“${esc(k.request_note)}”</div>` : ''}
            <div class="t-xs faint">${k.previous_attempts} previous attempt${k.previous_attempts === 1 ? '' : 's'}</div>
          </div>
          <span class="badge badge-ink">${esc(k.state)}</span>
        </div>

        <div class="row" style="gap:12px;margin-top:12px;flex-wrap:wrap">
          ${k.front_asset ? `<a href="${quad.verificationImage(k.id, 'front')}" target="_blank"
             class="btn btn-secondary btn-sm">View front</a>` : ''}
          ${k.back_asset ? `<a href="${quad.verificationImage(k.id, 'back')}" target="_blank"
             class="btn btn-secondary btn-sm">View back</a>` : ''}
        </div>

        ${k.method === 'id_card' ? pipelineBlock(k) : k.method === 'manual' ? `
          <div class="sunken" style="margin-top:12px">
            <h3 class="t-label">Manual request — no document, no mailbox proof</h3>
            <p class="t-xs faint">Do not approve on this request alone. Confirm the student's current enrolment
              through an official university channel, and record what you checked — approval is refused without it.</p>
          </div>` : ''}

        ${['approved', 'rejected'].includes(k.state) ? `
          <p class="t-sm muted" style="margin-top:12px">
            Decided ${when(k.decided_at)}${k.decision_note ? ` — ${esc(k.decision_note)}` : ''}</p>`
          : `<div class="row" style="gap:8px;margin-top:14px">
               <button class="btn btn-primary btn-sm" data-act="decide" data-id="${k.id}" data-d="approve"
                       data-m="${esc(k.method)}">Approve</button>
               <button class="btn btn-danger btn-sm" data-act="decide" data-id="${k.id}" data-d="reject">Reject</button>
               <button class="btn btn-secondary btn-sm" data-act="decide" data-id="${k.id}"
                       data-d="request_resubmission">Request resubmission</button>
             </div>`}
      </section>`).join('')}</div>`;
  }, { label: 'Loading verification queue' });
}

/* Shows what the pipeline actually did — including the stages that did not
   run because no provider is configured. */
function pipelineBlock(k) {
  const ocr = k.ocr || {};
  const roster = k.roster_match || {};
  const signals = k.signals || [];
  const stage = (name, status, note) => `
    <div class="rowmuted"><b class="t-xs">${esc(name)}</b>
      <span class="chip chip-soft">${esc(status)}</span>
      ${note ? `<div class="t-xs faint">${esc(note)}</div>` : ''}</div>`;
  return `
    <div class="sunken" style="margin-top:12px">
      <h3 class="t-label">Verification pipeline</h3>
      ${stage('Image quality', k.quality?.ok ? 'passed' : 'flagged',
              (k.quality?.notes || []).join(' '))}
      ${stage('OCR', ocr.status || 'not run',
              ocr.status === 'skipped' ? ocr.note : (ocr.fields
                ? `name: ${ocr.fields.name || '—'} · roll: ${ocr.fields.roll || '—'}` : ''))}
      ${stage('College roster', roster.status || 'not run', roster.note || '')}
      ${signals.length ? `<div class="chiprow">${signals.map((s) => `
        <span class="chip ${s.level === 'high' ? 'badge-danger' : s.level === 'warn' ? 'badge-warn' : 'chip-soft'}"
              title="${esc(s.message)}">${esc(s.code)}</span>`).join('')}</div>` : ''}
      <p class="t-xs faint" style="margin-top:8px">
        No submission is approved automatically. This is evidence for your decision, not a verdict.
      </p>
    </div>`;
}

async function scrPartners() {
  setTitle('Delivery partners', 'Approval is required before anyone can deliver.');
  const f = S.partnerFilter || 'pending';
  head().innerHTML = ['pending', 'approved', 'rejected', 'left', 'all']
    .map((s) => `<button class="btn btn-ghost btn-sm" data-act="pFilter" data-v="${s}" aria-pressed="${s === f}">${esc(s)}</button>`).join('');
  await paintPartners(f);
}

async function paintPartners(status) {
  await panel(view(), () => quad.partners(status), (d) => {
    if (!d.partners.length) return EmptyState('Nobody in this queue.', status === 'pending' ? 'No applications are waiting.' : '');
    return `
      ${d.policy ? `<p class="t-sm muted" style="margin-bottom:12px">Current policy: security deposit
        <b>${d.policy.amountPaise ? rupees(d.policy.amountPaise) : 'not required'}</b>.
        Approval needs a photo that clearly shows the applicant, acceptance of this policy, and the deposit recorded.</p>` : ''}
      ${table(['Photo', 'Name', 'Student', 'Policy', 'Deposit', 'Rating', 'Payouts', 'Status', ''],
      d.partners.map((p) => [
        p.has_photo
          ? `<a href="${quad.adminPartnerPhotoUrl(p.user_id)}" target="_blank" rel="noopener" title="Open full photo">
               <img src="${quad.adminPartnerPhotoUrl(p.user_id)}" alt="Photo of ${esc(p.name || 'applicant')}"
                    style="width:44px;height:44px;border-radius:50%;object-fit:cover;display:block"></a>`
          : '<span class="badge badge-danger">No photo</span>',
        `<b>${esc(p.name || '—')}</b><div class="t-xs faint">${esc(p.student_email || p.phone || '')}</div>`,
        `<span class="badge ${p.student_status === 'approved' ? 'badge-open' : 'badge-warn'}">${esc(p.student_status)}</span>`,
        p.consented ? '<span class="badge badge-open">Accepted</span>'
          : p.status === 'approved' ? '<span class="badge badge-closed" title="Approved under an earlier policy version">Earlier version</span>'
          : '<span class="badge badge-warn">Not accepted</span>',
        `${rupees(p.deposit_paise)}${p.deposit_required_paise ? ` <span class="t-xs faint">of ${rupees(p.deposit_required_paise)}</span>` : ''}`,
        p.rating?.count ? `★ ${Number(p.rating.average).toFixed(1)} (${p.rating.count})` : '<span class="t-xs faint">No ratings</span>',
        p.payout_destination
          ? `<span class="badge ${p.payout_destination.status === 'verified' ? 'badge-open' : p.payout_destination.status === 'failed' ? 'badge-danger' : 'badge-warn'}">${
              esc(p.payout_destination.status)}</span> <span class="t-xs">${esc(p.payout_destination.masked || '')}</span>
             ${p.payout_destination.holdUntil ? '<div class="t-xs faint">changed recently · on 24 h hold</div>' : ''}
             ${p.last_payout ? `<div class="t-xs faint">last: ${esc(p.last_payout.state)} ${rupees(p.last_payout.amount_paise)}</div>` : ''}`
          : '<span class="badge badge-closed">no bank or UPI yet</span>',
        `<span class="badge badge-ink">${esc(p.status)}${p.online ? ' · online' : ''}</span>
         <div class="t-xs faint">${p.deliveries} deliveries${p.active_orders ? ` · ${p.active_orders} active` : ''}</div>`,
        `<div class="row" style="gap:6px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" data-act="recordDeposit" data-id="${p.user_id}" data-name="${esc(p.name || '')}">Record deposit</button>
          ${p.status === 'pending'
            ? `<button class="btn btn-primary btn-sm" data-act="pDecide" data-id="${p.user_id}" data-d="approve">Approve</button>
               <button class="btn btn-danger btn-sm" data-act="pDecide" data-id="${p.user_id}" data-d="reject">Reject</button>`
            : p.status === 'approved'
            ? `<button class="btn btn-ghost btn-sm" data-act="pDecide" data-id="${p.user_id}" data-d="suspend">Suspend</button>`
            : ''}</div>`,
      ]))}`;
  }, { label: 'Loading partners' });
}

/* ========================================================================
   INCIDENTS & DEPOSITS — the delivery partner policy, operated
   Every decision here is a server call with its own rules: a deduction needs
   a resolved incident, written evidence and a dispute window; a disputed one
   needs a second administrator; money moves only on Apply.
   ======================================================================== */
const INCIDENT_OUTCOMES = [
  ['no_fault_found', 'No fault found'], ['partner_responsible', 'Partner responsible'],
  ['cafeteria_responsible', 'Cafeteria responsible'], ['customer_claim_not_supported', 'Customer claim not supported'],
  ['other', 'Other'],
];
const DED_BADGE = { proposed: 'badge-warn', disputed: 'badge-warn', upheld: 'badge-danger',
                    applied: 'badge-danger', dismissed: 'badge-open', withdrawn: 'badge-closed' };

async function scrTrust() {
  setTitle('Incidents & deposits', 'Delivery problems, partner security deposits and deductions.');
  head().innerHTML = `<button class="btn btn-secondary btn-sm" data-act="editDepositPolicy">Deposit policy</button>`;
  await panel(view(), async () => ({
    incidents: await quad.incidents('unresolved'),
    deductions: (await quad.deductions('open')).deductions,
    refunds: (await quad.depositRefunds('requested')).requests,
    policy: (await quad.partnerPolicy()).policy,
  }), (d) => `
    <div class="grid-kpi">
      ${kpi('Open incidents', d.incidents.incidents.length, 'reported, not yet resolved')}
      ${kpi('Deductions in progress', d.deductions.length, 'proposed, disputed or upheld')}
      ${kpi('Deposit refunds', d.refunds.length, 'waiting for a transfer')}
      ${kpi('Required deposit', d.policy?.amountPaise ? rupees(d.policy.amountPaise) : 'None', `${Math.round((d.policy?.disputeWindowHours || 72) / 24)}-day dispute window`)}
    </div>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Incidents</h2>
      <p class="t-xs faint">A report is a claim. Check the order timeline and handover codes before resolving. Only an incident resolved as the partner's responsibility can lead to a deduction.</p>
      ${d.incidents.incidents.length ? table(['Code', 'Order', 'What happened', 'Reported by', 'Partner', 'State', ''],
        d.incidents.incidents.map((i) => [
          esc(i.code), `#${esc(i.order_code)}<div class="t-xs faint">${esc(i.vendor_name)}</div>`,
          `<b>${esc(d.incidents.categories[i.category] || i.category)}</b><div class="t-xs muted" style="max-width:320px">${esc(i.description)}</div>`,
          `${esc(i.reporter_name || '—')}<div class="t-xs faint">${esc(i.reporter_role)} · ${when(i.created_at)}</div>`,
          esc(i.partner_name || '—'),
          `<span class="badge badge-warn">${esc(i.state)}</span>`,
          `<div class="row" style="gap:6px;flex-wrap:wrap">
            ${i.state === 'open' ? `<button class="btn btn-ghost btn-sm" data-act="investigate" data-id="${i.id}">Investigating</button>` : ''}
            <button class="btn btn-primary btn-sm" data-act="resolveIncident" data-id="${i.id}" data-code="${esc(i.code)}">Resolve</button></div>`,
        ])) : '<p class="t-sm muted">No open incidents.</p>'}
      <button class="btn btn-ghost btn-sm" data-act="resolvedIncidents" style="margin-top:8px">Resolved incidents and deductions</button>
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Deductions in progress</h2>
      ${d.deductions.length ? table(['Partner', 'Order', 'Amount', 'Reason and evidence', 'State', ''],
        d.deductions.map((x) => [
          esc(x.partner_name), `#${esc(x.order_code)}<div class="t-xs faint">${esc(x.incident_code)}</div>`, rupees(x.amount_paise),
          `<b>${esc(x.reason)}</b><div class="t-xs muted" style="max-width:320px">${esc(x.evidence)}</div>
           ${x.dispute_text ? `<div class="t-xs" style="margin-top:4px"><b>Partner's dispute:</b> ${esc(x.dispute_text)}</div>` : ''}
           <div class="t-xs faint">Proposed by ${esc(x.proposed_by_name)} · dispute window ${new Date(x.dispute_deadline) > new Date() ? `open until ${esc(new Date(x.dispute_deadline).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}` : 'closed'}</div>`,
          `<span class="badge ${DED_BADGE[x.state]}">${esc(x.state)}</span>`,
          `<div class="row" style="gap:6px;flex-wrap:wrap">
            ${x.state === 'disputed' ? `<button class="btn btn-primary btn-sm" data-act="reviewDeduction" data-id="${x.id}" data-d="uphold">Uphold</button>` : ''}
            ${['proposed', 'disputed'].includes(x.state) ? `<button class="btn btn-secondary btn-sm" data-act="reviewDeduction" data-id="${x.id}" data-d="dismiss">Dismiss</button>` : ''}
            ${x.applicable ? `<button class="btn btn-danger btn-sm" data-act="applyDeduction" data-id="${x.id}" data-amount="${x.amount_paise}">Apply deduction</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-act="withdrawDeduction" data-id="${x.id}">Withdraw</button></div>`,
        ])) : '<p class="t-sm muted">No deductions in progress.</p>'}
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Deposit refund requests</h2>
      ${d.refunds.length ? table(['Partner', 'Requested', 'Balance', ''],
        d.refunds.map((r) => [esc(r.partner_name), when(r.requested_at), rupees(r.balance_paise),
          `<div class="row" style="gap:6px">
            <button class="btn btn-primary btn-sm" data-act="payDepositRefund" data-id="${r.id}" data-amount="${r.balance_paise}">Record transfer</button>
            <button class="btn btn-ghost btn-sm" data-act="rejectDepositRefund" data-id="${r.id}">Decline</button></div>`]))
        : '<p class="t-sm muted">No refund requests.</p>'}
    </section>`, { label: 'Loading incidents and deposits' });
}

/* ========================================================================
   ADMINISTRATORS — who can run ECHO ECHO, and with which passkeys
   ======================================================================== */
const ADMIN_BADGE = { active: 'badge-ok', invited: 'badge-warn', suspended: 'badge-bad', revoked: 'badge-bad' };

async function scrAdmins() {
  setTitle('Administrators',
    'Who can run ECHO ECHO, and exactly what each of them may do. Everyone here signs in with a password and an authenticator code.');
  head().innerHTML = `
    ${session.isOwner ? '<button class="btn btn-primary btn-sm" data-act="newAdminInvite">Invite administrator</button>' : ''}
    <button class="btn btn-secondary btn-sm" data-act="changeAdminPassword">Change my password</button>
    <button class="btn btn-secondary btn-sm" data-act="replaceAuthenticator">Replace my authenticator</button>`;
  await panel(view(), async () => ({
    admins: await quad.accessAdmins(),
    invitations: session.can('admins.view') ? await quad.accessInvitations() : { invitations: [] },
    me: await quad.adminCredential(),
  }), (d) => {
    const open = d.invitations.invitations.filter((i) => i.state === 'waiting');
    return `
    <section class="card card-pad">
      <h2 class="t-label">Administrators</h2>
      ${table(['Name', 'Status', 'Permissions', 'Sign-in set up', 'Last sign-in', 'Sessions', ''],
        d.admins.administrators.map((a) => {
          const self = a.id === session.me.user.id;
          const btn = (act, label, extra = '') =>
            `<button class="btn btn-ghost btn-sm" data-act="${act}" data-id="${a.id}" data-name="${esc(a.name || a.email || '')}" ${extra}>${label}</button>`;
          return [
            `<b>${esc(a.name || '—')}</b><div class="t-xs muted">${esc(a.email || '—')}</div>`,
            a.isOwner ? '<span class="badge badge-ink">Owner</span>'
              : `<span class="badge ${ADMIN_BADGE[a.status] || ''}">${esc(a.status)}</span>${a.status_reason ? `<div class="t-xs faint">${esc(a.status_reason)}</div>` : ''}`,
            a.isOwner ? 'All' : `${a.effective.permissions.length}${a.effective.source === 'role_default' ? ' <span class="t-xs faint">(role default)</span>' : ''}`,
            a.signInReady === false ? '<span class="badge badge-warn">Not finished</span>'
              : a.signInReady === true ? '<span class="badge badge-ok">Ready</span>'
              : a.passkeys ? '<span class="badge badge-ok">Ready</span>'
              : '<span class="badge badge-warn">Not finished</span>',
            a.last_sign_in_at ? when(a.last_sign_in_at) : '—',
            String(a.active_sessions),
            `<div class="row" style="gap:6px;flex-wrap:wrap">
              ${btn('adminDetail', 'Activity')}
              ${!a.isOwner && !self && session.isOwner && a.status !== 'revoked' ? btn('editAdminPermissions', 'Permissions') : ''}
              ${!a.isOwner && !self && session.isOwner && a.status === 'invited' ? btn('reissueAdminInvite', 'New invite code') : ''}
              ${!a.isOwner && !self && session.can('admins.suspend') && ['active', 'invited'].includes(a.status) ? btn('suspendAdmin', 'Suspend') : ''}
              ${!a.isOwner && !self && session.isOwner && ['suspended', 'revoked'].includes(a.status) ? btn('restoreAdmin', 'Restore') : ''}
              ${!a.isOwner && !self && session.isOwner && a.status !== 'revoked' ? btn('revokeAdmin', 'Revoke access') : ''}
              ${!a.isOwner && !self && session.can('sessions.revoke') && a.active_sessions ? btn('revokeAdminSessions', 'Sign out everywhere') : ''}
            </div>`,
          ];
        }))}
      <p class="t-xs faint" style="margin-top:10px">Permission changes, suspension and revocation apply to open sessions on their next request.
        The platform owner is set in server configuration and cannot be changed, suspended or removed here.</p>
    </section>
    ${open.length ? `<section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Invitations waiting for sign-in</h2>
      ${table(['Name', 'Email', 'Permissions', 'Expires', ''], open.map((i) => [
        esc(i.name), esc(i.email), String(i.permissions.length), when(i.expires_at),
        session.isOwner ? `<button class="btn btn-ghost btn-sm" data-act="cancelInvitation" data-id="${i.id}">Cancel</button>` : '']))}
    </section>` : ''}
    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Your sign-in</h2>
      <p class="t-sm">
        Password ${d.me.passwordSet ? `set${d.me.passwordUpdatedAt ? ` ${when(d.me.passwordUpdatedAt)}` : ''}` : '<b>not set</b>'} ·
        Authenticator ${d.me.authenticatorReady ? 'working' : '<b>not finished</b>'}
      </p>
      ${!d.me.authenticatorReady ? `<p class="t-xs" style="color:var(--warn)">
        Finish setting up your authenticator app. Until you do, you cannot sign back in after this session ends.</p>` : ''}
      <p class="t-xs faint">Money, roles and campus boundaries ask for your password and a fresh code again after a while.
        ECHO ECHO stores no fingerprints and no face data.</p>
    </section>`; }, { label: 'Loading administrators' });
}

/* Permission picker, grouped as the server's catalogue is. Owner-only
   permissions are shown locked so nothing is silently missing. */
function permissionPicker(catalog, selected = []) {
  return `
    <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px">
      <span class="t-xs muted">Start from:</span>
      ${catalog.presets.map((p) => `<button type="button" class="btn btn-ghost btn-sm" data-act="applyPreset" data-perms="${esc(p.permissions.join(','))}">${esc(p.label)}</button>`).join('')}
      <button type="button" class="btn btn-ghost btn-sm" data-act="applyPreset" data-perms="">None</button>
    </div>
    <input class="input perm-search" type="search" placeholder="Search permissions" aria-label="Search permissions" data-perm-search>
    <div class="stack" style="gap:12px;max-height:56vh;overflow:auto">
      ${catalog.groups.map((g) => `
        <fieldset data-perm-group style="border:1px solid var(--line);border-radius:10px;padding:8px 12px">
          <legend class="t-label">${esc(g.name)}</legend>
          ${g.permissions.map((p) => `
            <label class="row" data-perm-row="${esc(`${g.name} ${p.label} ${p.key}`.toLowerCase())}" style="gap:8px;align-items:flex-start;padding:3px 0">
              <input type="checkbox" name="perm" value="${esc(p.key)}" ${selected.includes(p.key) ? 'checked' : ''} ${p.ownerOnly ? 'disabled' : ''}>
              <span class="t-sm">${esc(p.label)}
                <span class="t-xs faint">${esc(p.key)}${p.ownerOnly ? ' · owner only' : ''}${p.personalData ? ' · shows personal data' : ''}</span></span>
            </label>`).join('')}
        </fieldset>`).join('')}
    </div>`;
}
const pickedPermissions = (form) => [...form.querySelectorAll('input[name=perm]:checked')].map((i) => i.value);

async function scrReviews() {
  setTitle('Reviews', 'Ratings come only from completed orders. Moderation hides a review; it never edits one.');
  const f = S.reviewFilter || 'reported';
  head().innerHTML = `<button class="btn btn-ghost btn-sm" data-act="reviewsFilter" data-v="reported" aria-pressed="${f === 'reported'}">Reported</button>
    <button class="btn btn-ghost btn-sm" data-act="reviewsFilter" data-v="all" aria-pressed="${f === 'all'}">All recent</button>`;
  await paintReviews(f);
}

async function paintReviews(filter) {
  await panel(view(), () => quad.adminReviews(filter), (d) => {
    if (!d.reviews.length) return EmptyState(filter === 'reported' ? 'No reported reviews.' : 'No reviews yet.', '');
    return table(['Rating', 'About', 'Review', 'Order', 'Reports', ''],
      d.reviews.map((r) => [
        `${'★'.repeat(r.stars)}<span class="faint">${'★'.repeat(5 - r.stars)}</span>`,
        `${esc(r.target === 'delivery' ? `Delivery · ${r.partner_name || ''}` : `${r.vendor_name}${r.target === 'item' ? ' · item' : ''}`)}`,
        `${r.body ? esc(r.body) : '<span class="faint">No text</span>'}<div class="t-xs faint">${esc(r.author_name || '')} · ${when(r.created_at)}</div>
         ${r.hidden ? `<span class="badge badge-closed">Hidden: ${esc(r.hidden_reason || '')}</span>` : ''}`,
        `#${esc(r.order_code)}`,
        (r.reports || []).map((x) => `<div class="t-xs">${esc(x.reason)} <span class="badge ${x.state === 'open' ? 'badge-warn' : 'badge-closed'}">${esc(x.state)}</span>
          ${x.state === 'open' ? `<button class="btn btn-ghost btn-sm" data-act="resolveReport" data-id="${x.id}">Resolve</button>` : ''}</div>`).join('') || '—',
        r.hidden ? '' : `<button class="btn btn-ghost btn-sm" data-act="hideReview" data-id="${r.id}">Hide</button>`,
      ]));
  }, { label: 'Loading reviews' });
}

/* ========================================================================
   LOCATIONS — the campus builder
   ======================================================================== */
async function scrLocations() {
  setTitle('Campus locations', 'Only locations here can be delivered to.');
  head().innerHTML = `<button class="btn btn-primary btn-sm" data-act="newLocation">Add location</button>
    <button class="btn btn-secondary btn-sm" data-act="importPoints">Import GPS points</button>
    <button class="btn btn-ghost btn-sm" data-act="showDistances">Distances</button>`;
  const loaded = await panel(view(), async () => {
    const campuses = (await quad.adminCampuses()).campuses;
    S.locCampus = S.locCampus && campuses.some((c) => c.id === S.locCampus) ? S.locCampus
      : (campuses.find((c) => c.available) || campuses[0])?.id;
    /* Independent reads, so they go out together rather than one after another. */
    const [nodes, zones, boundaries, tree] = await Promise.all([
      quad.campusChildren(null, { campusId: S.locCampus }).then((r) => r.nodes),
      quad.campusZones(S.locCampus).then((r) => r.zones),
      S.locCampus ? quad.boundaries(S.locCampus).then((r) => r.boundaries) : [],
      S.locCampus ? quad.campusTree(S.locCampus).then((r) => r.nodes) : [],
    ]);
    return { campuses, nodes, zones, boundaries, tree };
  }, (d) => {
    const current = d.campuses.find((c) => c.id === S.locCampus);
    const active = d.boundaries.find((b) => b.status === 'active');
    return `
    <section class="card card-pad">
      <h2 class="t-label">Campuses</h2>
      <p class="t-xs faint">A campus that is not in service can be chosen by students, but the server refuses every order there.</p>
      ${table(['College', 'Campus', 'Cafeterias', 'Students', 'Service', ''],
        d.campuses.map((c) => [`<span style="display:inline-block;min-width:190px">${esc(c.collegeName)}</span>`,
          `<span style="display:inline-block;min-width:130px"><b>${esc(c.name)}</b>${c.message ? `<span class="t-xs faint" style="display:block">${esc(c.message)}</span>` : ''}</span>`,
          String(c.outlets), String(c.students),
          `<span class="badge ${c.available ? 'badge-open' : 'badge-closed'}">${esc(c.serviceStatus.replace('_', ' '))}</span>`,
          `<button class="btn btn-ghost btn-sm" data-act="editCampus" data-id="${c.id}" data-status="${c.serviceStatus}"
                   data-message="${esc(c.message || '')}" data-name="${esc(c.name)}">Change</button>`]))}
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <div class="between" style="flex-wrap:wrap;gap:8px">
        <h2 class="t-label">Delivery boundary · ${esc(current?.name || '')}</h2>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <button class="btn btn-secondary btn-sm" data-act="importPerimeter">Import walked perimeter</button>
          <button class="btn btn-ghost btn-sm" data-act="editBoundary">Type an outline</button>
        </div>
      </div>
      ${active
        ? `<p class="t-sm" style="margin:6px 0 10px"><span class="badge badge-open">Active</span>
             ${esc(active.name)} · confirmed ${when(active.verified_at)}${active.verified_by_name ? ` by ${esc(active.verified_by_name)}` : ''}</p>`
        : `<p class="t-sm" style="margin:6px 0 10px"><span class="badge badge-danger">No confirmed boundary</span>
             Delivery orders on this campus are refused until an outline is confirmed. Self pickup still works.</p>`}
      ${d.boundaries.length ? d.boundaries.filter((b) => b.status !== 'retired').map((b) => `
        <div class="sunken" style="padding:12px;margin-top:10px;display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:12px;align-items:start">
          <div class="stack" style="gap:4px;min-width:0">
            <div class="row" style="gap:8px;flex-wrap:wrap"><b>${esc(b.name)}</b>
              <span class="badge ${b.status === 'active' ? 'badge-open' : 'badge-warn'}">${esc(b.status)}</span></div>
            <div class="t-xs faint">${b.metrics ? `${b.metrics.points} points · about ${b.metrics.widthM} m × ${b.metrics.heightM} m · ${(b.metrics.areaM2 / 4046.86).toFixed(1)} acres` : ''}</div>
            <p class="t-xs" style="white-space:pre-line;color:var(--text-2)">${esc(b.source_note || b.source || 'No source recorded')}</p>
            ${b.status === 'proposed' ? `<div class="row" style="gap:8px;margin-top:4px">
              <button class="btn btn-primary btn-sm" data-act="activateBoundary" data-id="${b.id}" data-name="${esc(b.name)}">Confirm and activate</button>
              ${d.boundaries.filter((o) => o.status !== 'retired' && o.id !== b.id).map((o) =>
                `<button class="btn btn-ghost btn-sm" data-act="compareBoundary" data-id="${b.id}" data-with="${o.id}">Compare with ${esc(o.name)}</button>`).join('')}
              <button class="btn btn-ghost btn-sm" data-act="retireBoundary" data-id="${b.id}">Discard</button></div>` : ''}
          </div>
          ${outlineSvg(b.polygon)}
        </div>`).join('') : ''}
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Campus map · ${esc(current?.name || '')}</h2>
      <p class="t-xs faint" style="margin:4px 0 10px">
        Solid green: confirmed. Hollow amber: pending candidate, not deliverable.
        Boundary outlines: solid when active, dashed while only proposed.</p>
      <div id="campus-map"><div class="map-empty"><p class="t-sm muted">Loading the map…</p></div></div>
      ${(() => {
        const unplaced = d.tree.filter((n) => n.lat === null || n.lng === null);
        return unplaced.length ? `<details style="margin-top:10px"><summary class="t-xs">
            ${unplaced.length} place(s) have no recorded position and are not drawn</summary>
          <p class="t-xs faint" style="margin:6px 0">Rooms are never positioned from a door-plate photo:
            that reading is where the photographer stood in the corridor.</p>
          <p class="t-xs">${unplaced.map((n) => esc(n.name)).join(' · ')}</p></details>` : '';
      })()}
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Delivery zones</h2>
      ${d.zones.length ? table(['Zone', 'Delivery points', 'Active deliveries', 'Delivery', ''],
        d.zones.map((z) => [
          esc(z.name), String(z.locations), String(z.active_deliveries),
          `<span class="badge ${z.delivery_enabled ? 'badge-open' : 'badge-danger'}">
             ${z.delivery_enabled ? 'Available' : 'Unavailable'}</span>`,
          `<button class="btn btn-ghost btn-sm" data-act="toggleLoc" data-id="${z.id}"
                   data-v="${z.delivery_enabled ? '0' : '1'}">
             ${z.delivery_enabled ? 'Disable' : 'Enable'}</button>
           <button class="btn btn-ghost btn-sm" data-act="openNode" data-id="${z.id}">Open</button>`,
        ])) : `<p class="t-sm muted">No zones yet.</p>`}
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Locations</h2>
      ${d.nodes.length ? `<div class="tree" id="tree">${d.nodes.map(nodeRow).join('')}</div>`
        : `<p class="t-sm muted">No locations on ${esc(current?.name || 'this campus')} yet. Add zones and buildings from verified information only.</p>`}
    </section>`;
  }, { label: 'Loading campus' });
  const mapEl = document.getElementById('campus-map');
  if (loaded && mapEl) {
    const { drawCampusMap } = await import('../../packages/ui/map.js');
    await drawCampusMap(mapEl, { nodes: loaded.tree, boundaries: loaded.boundaries });
  }
}

/* A to-scale outline of a boundary, so a transposed point or a stray digit
   is visible at a glance before it is confirmed. Not a map. */
function outlineSvg(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return '';
  const lat0 = polygon.reduce((s, p) => s + p[0], 0) / polygon.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const pts = polygon.map(([la, ln]) => [ln * k, -la]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(6 + ((x - minX) / span) * 108).toFixed(1)},${(6 + ((y - minY) / span) * 108).toFixed(1)}`).join(' ') + ' Z';
  return `<svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="Outline preview"
    style="background:var(--surface);border-radius:10px"><path d="${d}" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"/></svg>`;
}

/* Two outlines on one to-scale canvas (plus optional points), so a difference
   between a walked perimeter and a map proposal is seen, not inferred. */
function overlaySvg(a, b, points = [], size = 320) {
  const all = [...a, ...b, ...points.map((p) => [p.lat, p.lng])];
  const lat0 = all.reduce((s, p) => s + p[0], 0) / all.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const proj = ([la, ln]) => [ln * k, -la];
  const P = all.map(proj);
  const minX = Math.min(...P.map((p) => p[0])), minY = Math.min(...P.map((p) => p[1]));
  const span = Math.max(Math.max(...P.map((p) => p[0])) - minX, Math.max(...P.map((p) => p[1])) - minY) || 1;
  const xy = (pt) => { const [x, y] = proj(pt); return [10 + ((x - minX) / span) * (size - 20), 10 + ((y - minY) / span) * (size - 20)]; };
  const path = (poly) => poly.map((pt, i) => { const [x, y] = xy(pt); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ') + ' Z';
  const metresAcross = Math.round(span * 111320);
  return `<svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width:${size}px;background:var(--surface);border-radius:10px" role="img" aria-label="Outline comparison">
    <path d="${path(b)}" fill="rgba(120,120,120,.15)" stroke="var(--text-2)" stroke-width="1.5" stroke-dasharray="5 4"/>
    <path d="${path(a)}" fill="var(--accent-soft)" fill-opacity=".45" stroke="var(--accent)" stroke-width="2"/>
    ${points.map((p) => { const [x, y] = xy([p.lat, p.lng]); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${p.inA === p.inB ? 'var(--text-2)' : 'var(--danger, #c0392b)'}"><title>${esc(p.name)}</title></circle>`; }).join('')}
    <text x="10" y="${size - 6}" font-size="10" fill="var(--text-2)">≈ ${metresAcross} m across</text>
  </svg>`;
}

const PLACE_TYPE_OPTS = [['', '— not set —'], ['academic_block', 'Academic block'], ['administrative', 'Administrative building'],
  ['library', 'Library'], ['hostel', 'Hostel'], ['residence', 'Residence'], ['student_facility', 'Student facility'],
  ['cafeteria_pickup', 'Cafeteria pickup point'], ['entrance', 'Entrance / access point'], ['delivery_point', 'Delivery point'], ['other', 'Other']];
const METHOD_OPTS = [['', '— not set —'], ['gps_on_site', 'GPS reading taken on site'], ['survey_track', 'Surveyed track'],
  ['official_map', 'Official UPES map/document'], ['public_map', 'Public map (e.g. OpenStreetMap) — unverified'], ['admin_entry', 'Typed in by an administrator']];

const nodeRow = (n) => `
  <div class="treenode ${n.active === false ? 'faint' : ''}">
    <button class="grow row" data-act="openNode" data-id="${n.id}" style="gap:8px;text-align:left">
      <span class="tree-kind">${esc(n.kind)}</span>
      <b>${esc(n.name)}</b>
      ${n.deliverable ? `<span class="badge ${n.delivery_enabled ? 'badge-open' : 'badge-danger'}">
        ${n.delivery_enabled ? 'Delivers' : 'Disabled'}</span>` : `<span class="chip chip-soft">Area</span>`}
      ${n.verification === 'pending' ? `<span class="badge badge-warn" title="${esc(n.source_note || '')}">Pending confirmation</span>` : ''}
      ${n.deliverable && n.lat == null ? '<span class="badge badge-danger">No position — refused</span>' : ''}
    </button>
    <div class="row" style="gap:6px">
      ${n.verification === 'pending' ? `<button class="btn btn-secondary btn-sm" data-act="confirmLocation" data-id="${n.id}" data-name="${esc(n.name)}">Confirm location</button>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="addChild" data-id="${n.id}">+ Child</button>
      <button class="btn btn-ghost btn-sm" data-act="editLocation" data-id="${n.id}">Edit</button>
      ${n.deliverable ? `<button class="btn btn-ghost btn-sm" data-act="toggleLoc" data-id="${n.id}"
        data-v="${n.delivery_enabled ? '0' : '1'}">${n.delivery_enabled ? 'Disable' : 'Enable'}</button>` : ''}
      <button class="btn btn-ghost btn-sm" data-act="archiveLoc" data-id="${n.id}">Archive</button>
    </div>
  </div>`;

/* ========================================================================
   SUPPORT · PLATFORM · AUDIT
   ======================================================================== */
async function scrSupport() {
  setTitle('Support', 'Cases raised by students, with full order context.');
  head().innerHTML = '';
  await panel(view(), () => quad.supportCases('all'), (d) => {
    if (!d.cases.length) return EmptyState('No support cases.', '');
    return table(['Case', 'Student', 'Subject', 'Order', 'State', ''],
      d.cases.map((k) => [
        esc(k.code), esc(k.user_name || k.user_phone), esc(k.subject),
        esc(k.order_code || '—'),
        `<span class="badge badge-ink">${esc(k.state)}</span>`,
        `<button class="btn btn-ghost btn-sm" data-act="openCase" data-id="${k.id}">Open</button>`,
      ]));
  }, { label: 'Loading support cases' });
}

async function scrPlatform() {
  setTitle('Platform', 'Feature flags, fees and integration status.');
  head().innerHTML = '';
  await panel(view(), async () => ({ ...(await quad.flags()), ready: await quad.readiness() }), (d) => `
    <section class="card card-pad">
      <div class="between" style="flex-wrap:wrap;gap:8px">
        <h2 class="t-label">Launch readiness</h2>
        <span class="t-sm">${d.ready.summary.done} done · <b>${d.ready.summary.blocking}</b> blocking · ${d.ready.summary.pending - d.ready.summary.blocking} other pending · ${d.ready.summary.deferred} deferred</span>
      </div>
      ${table(['Area', 'Item', 'Status', 'Next step'], d.ready.items.map((i) => [
        esc(i.area), esc(i.label),
        `<span class="badge ${i.status === 'done' ? 'badge-open' : i.status === 'deferred' ? 'badge-closed' : i.blocking ? 'badge-danger' : 'badge-warn'}">${esc(i.status)}${i.status === 'pending' && i.blocking ? ' · blocks launch' : ''}</span>`,
        i.status === 'done' ? '' : `<span class="t-xs">${esc(i.how || '')}</span>`]))}
      <p class="t-xs faint" style="margin-top:8px">${esc(d.ready.note)}</p>
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Feature flags</h2>
      ${Object.entries(d.flags).map(([k, f]) => `
        <div class="item">
          <div class="grow"><b>${esc(k)}</b>
            ${f.blockedBy ? `<div class="t-xs faint">
              Cannot be enabled: its provider is not configured on this server.</div>` : ''}
          </div>
          <button class="btn ${f.enabled ? 'btn-ink' : 'btn-secondary'} btn-sm"
                  data-act="flag" data-k="${esc(k)}" data-v="${f.requested ? '0' : '1'}"
                  ${f.blockedBy ? 'disabled' : ''}>
            ${f.enabled ? 'On' : f.blockedBy ? 'Unavailable' : 'Off'}</button>
        </div>`).join('')}
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Integrations</h2>
      ${Object.entries(d.providers).map(([k, v]) => `
        <div class="rowmuted between">
          <span>${esc(k)}${v.provider ? ` · ${esc(v.provider)}` : ''}</span>
          <span class="badge ${v.configured ? 'badge-open' : 'badge-closed'}">
            ${v.configured ? 'configured' : 'not configured'}</span>
        </div>`).join('')}
      <p class="t-xs faint" style="margin-top:8px">
        Credentials live in server environment variables and never reach this page.
      </p>
    </section>

    <section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Commercials</h2>
      <p class="t-sm muted">Delivery fee, partner earning, commission and platform fee are versioned terms,
        so that every order keeps the terms it was priced under. They are set in Finance.</p>
      <button class="btn btn-secondary btn-sm" data-route="finance">Open Finance</button>
    </section>`, { label: 'Loading platform configuration' });
}

async function scrAudit() {
  setTitle('Audit', 'Who did what, when, to which resource, and whether it was allowed.');
  head().innerHTML = `<input class="input" id="audit-q" placeholder="Filter by action" style="max-width:220px">
    <button class="btn btn-secondary btn-sm" data-act="auditFilter">Filter</button>`;
  await paintAudit('');
}

async function paintAudit(action) {
  await panel(view(), () => quad.audit(action), (d) => {
    if (!d.entries.length) return EmptyState('Nothing logged yet.', '');
    return table(['When', 'Who', 'Role', 'Action', 'Resource', 'Result'],
      d.entries.map((a) => [
        when(a.at), esc(a.actor_name || a.actor_phone || 'anonymous'), esc(a.actor_role || '—'),
        esc(a.action), esc(a.resource || '—'),
        `<span class="badge ${a.outcome === 'ok' ? 'badge-open'
          : a.outcome === 'denied' ? 'badge-danger' : 'badge-warn'}">${esc(a.outcome)}</span>`,
      ]));
  }, { label: 'Loading audit log' });
}

/* ========================================================================
   SHARED: filter bars and pagers

   Filtering and paging happen on the server; the URL-less app keeps the
   current filter in S so Back/refresh within a screen keeps the reader's
   place. An empty result says whether it is "nothing matched" or "nothing
   exists", because those mean different things to an operator.
   ======================================================================== */
const optionList = (values, selected, anyLabel, labels = {}) =>
  `<option value="">${esc(anyLabel)}</option>` + values.map((v) =>
    `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(labels[v] || v.replace(/_/g, ' '))}</option>`).join('');

const pager = (d, act) => {
  const first = d.total ? (d.page - 1) * d.pageSize + 1 : 0;
  const last = Math.min(d.total, d.page * d.pageSize);
  return `<nav class="pager" aria-label="Pages">
    <span class="t-xs faint">${first}–${last} of ${d.total}</span>
    <button type="button" class="btn btn-ghost btn-sm" data-act="${act}" data-page="${d.page - 1}"
            ${d.page <= 1 ? 'disabled' : ''}>Previous</button>
    <button type="button" class="btn btn-ghost btn-sm" data-act="${act}" data-page="${d.page + 1}"
            ${last >= d.total ? 'disabled' : ''}>Next</button>
  </nav>`;
};

const formValues = (form) => Object.fromEntries([...new FormData(form)].filter(([, v]) => v !== ''));
const payBadge = (s) => `<span class="badge ${s === 'paid' ? 'badge-open' : s === 'failed' ? 'badge-danger'
  : s === 'refunded' ? 'badge-warn' : 'badge-closed'}">${esc(s || 'none')}</span>`;

/* ========================================================================
   ORDERS — server-side search, filters and pages; a timeline per order
   ======================================================================== */
const ORDER_STATES = ['awaiting_payment', 'confirmed', 'preparing', 'ready', 'assigned',
  'picked_up', 'delivered', 'cancelled', 'refunded'];

async function scrOrders() {
  setTitle('Order History', 'Every order, searched and filtered on the server. Open one for its details and full timeline.');
  head().innerHTML = '';
  const f = S.orderFilter;
  const tab = S.orderTab || 'all';
  const cal = icon('calendar', 18);
  view().innerHTML = `
    <div class="oh-bar">
      <nav class="oh-tabs" aria-label="Order views">${ORDER_TABS.map(([k, l]) => `
        <button type="button" class="oh-tab" data-act="orderTab" data-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}>${esc(l)}</button>`).join('')}
      </nav>
      <form class="oh-dates" data-form="orderDates" aria-label="Date range">
        <label class="oh-date">${cal}<input type="date" name="from" value="${esc(f.from || '')}" aria-label="From date"></label>
        <span class="oh-to">To</span>
        <label class="oh-date">${cal}<input type="date" name="to" value="${esc(f.to || '')}" aria-label="To date"></label>
      </form>
    </div>
    ${tab === 'summary' ? '<div id="orders-summary"></div>' : `
    <form class="oh-filters" data-form="orders" aria-label="Filter orders">
      <input class="input" name="q" placeholder="Order code, student or café" value="${esc(f.q || '')}" aria-label="Search orders">
      ${tab === 'all' ? `<select class="input" name="state" aria-label="Order state">${optionList(ORDER_STATES, f.state, 'Any state', ORDER_LABEL)}</select>` : ''}
      <select class="input" name="fulfilment" aria-label="Fulfilment">${optionList(['pickup', 'delivery'], f.fulfilment, 'Pickup or delivery')}</select>
      <select class="input" name="payment" aria-label="Payment state">${optionList(['paid', 'pending', 'created', 'failed', 'refunded', 'cancelled'], f.payment, 'Any payment')}</select>
      <button type="submit" class="btn btn-secondary btn-sm">Apply</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="ordersReset">Clear</button>
    </form>
    <div id="orders-list"></div>`}`;
  if (tab === 'summary') await paintSummary(); else await paintOrders();
}

/* The list for the current tab: the tab fixes the state, the form adds to it. */
const orderQuery = () => {
  const tab = S.orderTab || 'all';
  const q = { ...S.orderFilter };
  if (tab !== 'all') q.state = TAB_STATE[tab];
  return q;
};

const STATUS_TONE = { delivered: 'ok', cancelled: 'bad', refunded: 'bad', picked_up: 'warn', assigned: 'warn',
  ready: 'ink', preparing: 'ink', confirmed: 'ink', awaiting_payment: 'faint', draft: 'faint' };
const PAY_LABEL_ADMIN = { paid: 'Paid', pending: 'Pending', created: 'Started', failed: 'Failed', refunded: 'Refunded', cancelled: 'Cancelled' };
const Avatar = (name, size = 34) => {
  const a = avatarFor(name);
  return `<span class="oh-avatar" style="width:${size}px;height:${size}px;background:${a.tint}" aria-hidden="true">${esc(a.initials)}</span>`;
};
const StatusDot = (state) => `<span class="oh-status tone-${STATUS_TONE[state] || 'ink'}"><span class="oh-dot"></span>${esc(ORDER_LABEL[state] || state)}</span>`;

async function paintOrders() {
  await panel(document.getElementById('orders-list'),
    () => quad.adminOrders({ ...orderQuery(), page: S.orderPage, pageSize: 25 }), (d) => {
      S.orderRows = Object.fromEntries(d.orders.map((o) => [o.id, o]));
      if (!d.orders.length) {
        return Object.keys(S.orderFilter).length || (S.orderTab && S.orderTab !== 'all')
          ? EmptyState('No order matches.', 'Change the tab, the dates or a filter to widen the search.')
          : EmptyState('No orders yet.', 'Orders appear here the moment a student starts checkout.');
      }
      return `<div class="oh-table-wrap"><table class="oh-table">
        <thead><tr><th>Id</th><th>Name</th><th>Payment</th><th>Placed</th><th>Type</th><th>Status</th><th class="num">Total</th><th class="oh-act-col">Action</th></tr></thead>
        <tbody>${d.orders.map((o) => `
          <tr data-row="${o.id}">
            <td><button type="button" class="oh-code" data-act="openOrder" data-id="${o.id}">#${esc(o.code)}</button></td>
            <td><span class="oh-person">${Avatar(o.customer_name)}<span>${esc(o.customer_name || '—')}<span class="oh-sub">${esc(o.vendor_name)}</span></span></span></td>
            <td>${esc(PAY_LABEL_ADMIN[o.payment_status] || 'No payment')}</td>
            <td><span class="oh-when">${icon('clock', 15)}${when(o.created_at)}</span></td>
            <td class="${o.fulfilment === 'delivery' ? 'oh-delivery' : ''}">${o.fulfilment === 'delivery' ? 'Delivery' : 'Collection'}</td>
            <td>${StatusDot(o.state)}</td>
            <td class="num">${rupees(o.total_paise)}</td>
            <td class="oh-act-col"><button type="button" class="oh-dots" data-act="rowMenu" data-id="${o.id}" aria-haspopup="true" aria-label="Actions for order ${esc(o.code)}">${icon('dots', 18)}</button></td>
          </tr>`).join('')}</tbody>
      </table></div>${pager(d, 'ordersPage')}`;
    }, { label: 'Loading orders' });
}

/* ---------- Summary: the figures and the Graph View ------------------------ */
async function paintSummary() {
  const box = document.getElementById('orders-summary');
  await panel(box, () => quad.adminOrderSummary({ from: S.orderFilter.from, to: S.orderFilter.to }), (d) => {
    S.summary = d;
    const t = d.totals;
    return `
      <div class="oh-summary">
        <div class="oh-top">
          ${bigStat('chart', 'Total Sales', rupees(t.sales_paise), 'gold')}
          ${bigStat('card', 'Average Order', rupees(t.average_paise), 'blue')}
          ${bigStat('check', 'Completed', String(t.completed), 'teal')}
        </div>
        <section class="oh-graph card">
          <div class="oh-graph-head">
            <h2>Graph View</h2>
            <select class="input oh-metric" data-graph-metric aria-label="Graph shows">
              <option value="sales" ${S.graphMetric !== 'orders' ? 'selected' : ''}>Sales</option>
              <option value="orders" ${S.graphMetric === 'orders' ? 'selected' : ''}>Orders</option>
            </select>
          </div>
          <div id="oh-chart"></div>
        </section>
        <div class="oh-side">
          ${bigStat('bag', 'Total Order', String(t.orders), 'grey')}
          ${bigStat('bike', 'Total Delivery', String(t.delivery), 'grey')}
          ${bigStat('store', 'Total Collection', String(t.pickup), 'grey')}
        </div>
      </div>
      <p class="t-xs faint oh-note">${esc(d.from)} to ${esc(d.to)}, India time${d.bucket === 'month' ? ', by month' : ', by day'}.
        Orders count from the moment payment is confirmed; sales leave out cancelled and refunded orders.
        ${t.cancelled ? `${t.cancelled} cancelled or refunded in this range.` : ''}</p>`;
  }, { label: 'Loading the summary' });
  paintChart();
}

const bigStat = (ic, label, value, tone) => `
  <div class="oh-stat">
    <span class="oh-stat-icon tone-${tone}" aria-hidden="true">${icon(ic, 26)}</span>
    <span class="oh-stat-text"><span class="oh-stat-label">${esc(label)}</span><span class="oh-stat-value">${esc(value)}</span></span>
  </div>`;

function paintChart() {
  const box = document.getElementById('oh-chart');
  if (!box || !S.summary) return;
  const metric = S.graphMetric === 'orders' ? 'orders' : 'sales';
  const val = (p) => (metric === 'orders' ? p.orders : p.salesPaise / 100);
  const g = chartGeometry(S.summary.series, val, { w: 640, h: 300 });
  const fmt = (v) => (metric === 'orders' ? String(Math.round(v)) : v >= 1000 ? `₹${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `₹${Math.round(v)}`);
  const label = (at) => {
    const d = new Date(`${at}T00:00:00`);
    return S.summary.bucket === 'month' ? d.toLocaleDateString('en-IN', { month: 'short' }) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };
  const empty = g.pts.every((p) => p.v === 0);
  const peak = g.peak && g.peak.v > 0 ? g.peak : null;
  box.innerHTML = `<svg class="oh-svg" viewBox="0 0 ${g.box.w} ${g.box.h}" role="img"
      aria-label="${metric === 'orders' ? 'Orders' : 'Sales'} from ${esc(S.summary.from)} to ${esc(S.summary.to)}${peak ? `, highest ${esc(fmt(peak.v))} on ${esc(label(peak.at))}` : ''}">
      ${g.grid.map((l) => `<line x1="${g.box.left}" x2="${g.box.w - g.box.right}" y1="${l.y}" y2="${l.y}" class="oh-gridline"/>
        <text x="${g.box.left - 8}" y="${l.y + 4}" class="oh-axis" text-anchor="end">${esc(fmt(l.v))}</text>`).join('')}
      ${g.pts.filter((_, i) => i % Math.max(1, Math.ceil(g.pts.length / 6)) === 0).map((p) => `<line x1="${p.x}" x2="${p.x}" y1="${g.box.top}" y2="${g.box.h - g.box.bottom}" class="oh-gridline v"/>`).join('')}
      ${g.labels.map((p) => `<text x="${p.x}" y="${g.box.h - 8}" class="oh-axis" text-anchor="middle">${esc(label(p.at))}</text>`).join('')}
      <path d="${g.d}" class="oh-line"/>
      ${peak ? `<g class="oh-peak"><line x1="${peak.x}" x2="${peak.x}" y1="${peak.y}" y2="${g.box.h - g.box.bottom}" class="oh-marker"/>
        <circle cx="${peak.x}" cy="${peak.y}" r="6" class="oh-point"/>
        <rect x="${peak.x - 26}" y="${peak.y - 32}" width="52" height="20" rx="10" class="oh-tip"/>
        <text x="${peak.x}" y="${peak.y - 18}" text-anchor="middle" class="oh-tiptext">${esc(fmt(peak.v))}</text></g>` : ''}
      ${g.pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="10" class="oh-hit"><title>${esc(label(p.at))}: ${esc(fmt(p.v))}</title></circle>`).join('')}
    </svg>${empty ? '<p class="t-sm muted oh-empty">No placed orders in this range yet.</p>' : ''}`;
}

/* ---------- the order page: two columns, as in the reference ---------------- */
async function scrOrderDetail() {
  const id = S.orderId;
  setTitle('Order', '');
  head().innerHTML = '<button type="button" class="btn btn-ghost btn-sm" data-route="orders">← Order History</button>';
  await panel(view(), async () => {
    const [o, t] = await Promise.all([quad.order(id), quad.orderTimeline(id)]);
    return { o, t };
  }, ({ o, t }) => {
    const ord = o.order;
    const f = t.financials || o.financials || null;
    const addr = ord.delivery_address || null;
    const dest = ord.destination_snapshot || null;
    const carrying = ['assigned', 'picked_up'].includes(ord.state);
    document.getElementById('page-title').innerHTML = `Order Number <span class="od-code">#${esc(ord.code)}</span>`;
    document.getElementById('crumb-page').textContent = `Order History / #${ord.code}`;
    const row = (k, v) => (v == null || v === '' ? '' : `<div class="od-row"><span>${esc(k)}</span><b>${v}</b></div>`);
    const money = (p) => (p == null ? '—' : rupees(p));
    const refundable = orderActions({ ...ord, payment_status: o.payment?.status }, (p) => session.can(p)).some((a) => a.act === 'refund');
    return `<div class="od">
      <div class="od-main">
        <section class="card od-card">
          <table class="od-items">
            <thead><tr><th>Items summary</th><th>QTY</th><th class="num">Price</th><th class="num">Total Price</th></tr></thead>
            <tbody>${o.items.map((i) => `<tr>
              <td><span class="od-item">${Avatar(i.name_snapshot, 30)}${esc(i.name_snapshot)}</span></td>
              <td>× ${i.qty}</td><td class="num">${rupees(i.unit_paise_snapshot)}</td><td class="num">${rupees(i.line_paise)}</td></tr>`).join('')}</tbody>
          </table>
        </section>
        <section class="card od-card">
          <h2 class="od-h">Customer And Order Details</h2>
          ${row('Customer Name', esc(t.order.customer_name || '—'))}
          ${row('Phone Number', ord.delivery_contact_phone ? esc(ord.delivery_contact_phone) : '—')}
          ${row('Café', esc(t.order.vendor_name))}
          ${row('Type', ord.fulfilment === 'delivery' ? 'Delivery' : 'Collection')}
          ${row('Placed via', esc(ord.placed_via || 'website'))}
          ${row('Note', esc(addr?.instructions || 'N/A'))}
        </section>
        <section class="card od-card">
          <h2 class="od-h">Timeline</h2>
          <ol class="timeline">${t.timeline.map((e) => `<li>
            <span class="t-xs faint">${esc(new Date(e.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>
            <span class="chip chip-soft">${esc(TIMELINE_KIND[e.kind] || e.kind)}</span>
            ${esc(e.label)}${e.amountPaise ? ` · ${rupees(e.amountPaise)}` : ''}${e.by ? ` · ${esc(e.by)}` : ''}${
              e.outcome && e.outcome !== 'ok' ? ` · <b>${esc(e.outcome)}</b>` : ''}${e.note ? `<div class="t-xs faint">${esc(e.note)}</div>` : ''}</li>`).join('')
            || '<li class="t-sm muted">Nothing recorded yet.</li>'}</ol>
        </section>
      </div>
      <aside class="od-side">
        ${ord.fulfilment === 'delivery' ? `<section class="card od-card od-rider">
          <h2 class="od-h">Rider Details</h2>
          ${ord.partner_id ? `<div class="od-rider-row">
              <span class="od-rider-avatar">${Avatar(t.order.partner_name || 'Partner', 56)}${session.can('partners.view')
                ? `<img class="od-rider-photo" src="${esc(quad.adminPartnerPhotoUrl(ord.partner_id))}" alt="" data-fallback="hide">` : ''}</span>
              <b class="od-rider-name">${esc(t.order.partner_name || 'Assigned partner')}</b>
              ${carrying ? '<button type="button" class="btn od-track" data-act="goDeliveries">Track Rider</button>' : ''}
            </div>${!t.order.partner_name ? '<p class="t-xs faint">The name needs the partners.view permission.</p>' : ''}`
            : '<p class="t-sm muted">No partner assigned yet.</p>'}
        </section>` : ''}
        <section class="card od-card">
          <div class="between"><h2 class="od-h" style="margin:0">Order summary</h2>${StatusDot(ord.state)}</div>
          ${row('Order Created', esc(new Date(ord.created_at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })))}
          ${row('Order Time', esc(new Date(ord.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })))}
          ${row('Subtotal', money(f?.food_subtotal_paise ?? ord.subtotal_paise))}
          ${row('Delivery Fee', money(f?.delivery_fee_paise ?? ord.delivery_paise))}
          ${f ? row('Platform Fee', money(f.platform_fee_paise)) : ''}
        </section>
        <section class="card od-card od-total"><div class="od-row"><span>Total</span><b>${rupees(ord.total_paise)}</b></div></section>
        ${ord.fulfilment === 'delivery' ? `<section class="card od-card">
          <h2 class="od-h">Delivery Address</h2>
          ${row('Place', esc(dest?.name || addr?.label || '—'))}
          ${row('Block', esc(addr?.block || ''))}${row('Floor', esc(addr?.floor || ''))}${row('Room', esc(addr?.room || ''))}
          ${row('Landmark', esc(addr?.landmark || ''))}
        </section>` : ''}
        <section class="card od-card">
          <h2 class="od-h">Payment</h2>
          ${o.payment ? `${row('Status', esc(PAY_LABEL_ADMIN[o.payment.status] || o.payment.status))}${row('Provider', esc(o.payment.provider))}${row('Amount', rupees(o.payment.amount_paise))}`
            : '<p class="t-sm muted">No payment recorded.</p>'}
          ${refundable ? `<button type="button" class="btn btn-danger btn-sm" data-act="refund" data-id="${ord.id}" style="margin-top:10px">Refund this order</button>` : ''}
        </section>
      </aside>
    </div>`;
  }, { label: 'Loading the order' });
}

/* The ⋮ menu: built from orderActions() for this administrator. */
function rowMenu(t) {
  const open = document.querySelector('.oh-menu');
  const same = open?.dataset.for === t.dataset.id;
  open?.remove();
  if (same) return;
  const o = S.orderRows?.[t.dataset.id];
  if (!o) return;
  const items = orderActions(o, (p) => session.can(p));
  const m = el(`<div class="cc-menu oh-menu" role="menu" data-for="${o.id}">${items.map((a) => `
    <button type="button" role="menuitem" class="cc-menu-item${a.danger ? ' danger' : ''}" data-act="${a.act}" data-id="${o.id}" data-code="${esc(o.code)}">${esc(a.label)}</button>`).join('')}</div>`);
  /* On <body>, fixed to the button: inside the table's scroll box it would
     be clipped. It has its own click listener for the same reason. */
  document.body.append(m);
  const r = t.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
  m.style.top = `${r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  m.addEventListener('click', onClick);
  m.querySelector('button')?.focus();
}
document.addEventListener('scroll', () => document.querySelector('.oh-menu')?.remove(), { passive: true, capture: true });

const ORDER_ACTIONS = {
  orderTab: (t) => { S.orderTab = t.dataset.tab; S.orderPage = 1; return scrOrders(); },
  rowMenu: (t) => rowMenu(t),
  openOrder: (t) => { document.querySelector('.oh-menu')?.remove(); S.orderId = t.dataset.id; S.route = 'order'; route(); },
  goDeliveries: () => { document.querySelector('.oh-menu')?.remove(); S.route = 'deliveries'; route(); },
  copyCode: async (t) => {
    document.querySelector('.oh-menu')?.remove();
    try { await navigator.clipboard.writeText(t.dataset.code); toast(`Copied ${t.dataset.code}`); }
    catch { toast(`Order code: ${t.dataset.code}`); }
  },
};

const TIMELINE_KIND = { state: 'Status', payment: 'Payment', refund: 'Refund', webhook: 'Gateway webhook', audit: 'Audit' };

/* ========================================================================
   PAYMENTS — what Cashfree was asked, what it said, and what was refused
   ======================================================================== */
async function scrPayments() {
  setTitle('Payments', 'Cashfree references, refunds and webhook history. A payment is confirmed server-to-server, never by the browser.');
  head().innerHTML = '';
  const f = S.payFilter;
  view().innerHTML = `
    <form class="filterbar" data-form="payments" aria-label="Filter payments">
      <input class="input" name="q" placeholder="Order code or Cashfree id" value="${esc(f.q || '')}" aria-label="Search payments">
      <select class="input" name="status" aria-label="Payment status">${optionList(['paid', 'pending', 'created', 'failed', 'refunded', 'cancelled'], f.status, 'Any status')}</select>
      <label class="t-xs faint"><input type="checkbox" name="unreconciled" value="true" ${f.unreconciled ? 'checked' : ''}> Not yet reconciled</label>
      <button type="submit" class="btn btn-secondary btn-sm">Apply</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="paymentsReset">Clear</button>
    </form>
    <div id="pay-list"></div>
    <div id="hook-list" style="margin-top:18px"></div>`;
  await Promise.all([paintPayments(), paintWebhooks()]);
}

async function paintPayments() {
  await panel(document.getElementById('pay-list'),
    () => quad.adminPayments({ ...S.payFilter, page: S.payPage, pageSize: 25 }), (d) => {
      if (!d.payments.length) {
        return Object.keys(S.payFilter).length ? EmptyState('No payment matches these filters.', '')
          : EmptyState('No payments yet.', 'The first checkout creates one.');
      }
      return table(['Order', 'When', 'Status', 'Amount', 'Refunded', 'Cashfree order', 'Cashfree payment', 'Reconciled'],
        d.payments.map((p) => [
          `<b style="white-space:nowrap">${esc(p.order_code)}</b>`, when(p.created_at),
          payBadge(p.status) + (p.flagged_reason ? ` <span class="badge badge-danger" title="${esc(p.flagged_reason)}">flagged</span>` : ''),
          `<span class="num">${rupees(p.amount_paise)}</span>`,
          `<span class="num">${p.refunded_paise ? rupees(p.refunded_paise) : '—'}</span>`,
          `<code class="t-xs">${esc(p.provider_order_id || '—')}</code>`,
          `<code class="t-xs">${esc(p.provider_payment_id || '—')}</code>`,
          p.reconciled_at ? when(p.reconciled_at) : (p.status === 'paid' ? '<span class="badge badge-warn">awaiting settlement</span>' : '—'),
        ])) + pager(d, 'paymentsPage');
    }, { label: 'Loading payments' });
}

async function paintWebhooks() {
  await panel(document.getElementById('hook-list'), () => quad.adminWebhooks(7), (d) => `
    <section class="card card-pad">
      <h2 class="t-label">Webhooks</h2>
      <div class="grid-kpi" style="margin-top:10px">
        ${kpi('Payment events', d.health.payments.events, `${d.health.payments.duplicates} duplicates ignored · 30 days`)}
        ${kpi('Payout events', d.health.payouts.events, `${d.health.payouts.duplicates} duplicates ignored · 30 days`)}
        ${kpi('Refused', d.refused.length, d.refused.length ? 'bad signature or stale · 7 days' : 'none in 7 days')}
      </div>
      ${d.refused.length ? `<h3 class="t-label" style="margin-top:14px">Refused deliveries</h3>
        ${table(['When', 'Endpoint', 'Reason'], d.refused.map((r) => [when(r.at), esc(r.action), esc(r.reason || '—')]))}` : ''}
      <h3 class="t-label" style="margin-top:14px">Recent payment events</h3>
      ${d.payments.length ? table(['Received', 'Event', 'Event id', 'Duplicates'],
        d.payments.slice(0, 25).map((w) => [when(w.received_at), esc(w.event_type || '—'),
          `<code class="t-xs">${esc(String(w.event_id).slice(0, 24))}</code>`, String(w.duplicate_count)]))
        : '<p class="t-sm muted">No payment events in the last 7 days.</p>'}
      <p class="t-xs faint" style="margin-top:8px">Payloads are kept on the server for audit and are not shown here.</p>
    </section>`, { label: 'Loading webhook history' });
}

/* ========================================================================
   RELIABILITY — what needs a person, and what to do about it
   ======================================================================== */
async function scrReliability() {
  setTitle('Reliability', 'Readiness, ledger invariants, stuck money and failed jobs, each with its next step.');
  head().innerHTML = `<button type="button" class="btn btn-secondary btn-sm" data-act="reliabilityRefresh">Check again</button>`;
  await panel(view(), () => quad.reliability(), (d) => `
    <section class="card card-pad">
      <div class="between" style="flex-wrap:wrap;gap:8px">
        <h2 class="t-label">${d.ok ? 'Nothing needs attention' : 'Needs attention'}</h2>
        <span class="t-sm">${d.summary.errors} error(s) · ${d.summary.warnings} warning(s) · ${d.summary.checks} checks
          ${d.commit ? ` · build <code class="t-xs">${esc(d.commit.slice(0, 12))}</code>` : ''}</span>
      </div>
      ${table(['Status', 'Check', 'Observed', 'What to do'], d.checks.map((c) => [
        `<span class="badge ${c.ok ? 'badge-open' : c.severity === 'error' ? 'badge-danger' : 'badge-warn'}">${c.ok ? 'ok' : c.severity === 'error' ? 'error' : 'warning'}</span>`,
        esc(c.label), `<span class="t-xs">${esc(c.detail)}</span>`, c.action ? `<span class="t-xs">${esc(c.action)}</span>` : '']))}
    </section>
    ${d.recentBatches.length ? `<section class="card card-pad" style="margin-top:18px">
      <h2 class="t-label">Recent settlement runs</h2>
      ${table(['Kind', 'Period', 'State', 'Built'], d.recentBatches.map((b) => [esc(b.kind), esc(b.period_key || 'manual'), esc(b.state), when(b.created_at)]))}
    </section>` : ''}
    <p class="t-xs faint" style="margin-top:10px">
      The scheduled keep-warm job checks /health and /ready from outside every 10 minutes;
      its failures arrive by GitHub email with the cause in the run summary.
    </p>`, { label: 'Running checks' });
}

/* ========================================================================
   REPORTS — server-built CSV, permission-checked and audited
   ======================================================================== */
const REPORT_KINDS = [
  ['orders', 'Orders', 'orders.view', 'Every order with fulfilment, state, payment state, fees and total.'],
  ['payments', 'Payments', 'finance.view', 'Cashfree order and payment ids, amounts, refunds and settlement ids.'],
  ['payouts', 'Payouts', 'finance.view', 'Café and partner transfers with masked destinations and UTRs.'],
  ['ledger', 'Ledger', 'finance.view', 'Every double-entry line: debit and credit per account and party.'],
];

async function scrReports() {
  setTitle('Reports', 'Exports for accounts and operations. Each export is recorded in the audit log.');
  head().innerHTML = '';
  const kinds = REPORT_KINDS.filter(([, , perm]) => session.can(perm));
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monthStart = iso(new Date(today.getFullYear(), today.getMonth(), 1));
  view().innerHTML = kinds.length ? `
    <section class="card card-pad">
      <form class="stack" data-form="report" aria-label="Export a report" style="max-width:520px">
        <label class="field"><span class="t-label">Report</span>
          <select class="input" name="kind">${kinds.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
        <div class="row" style="gap:12px;flex-wrap:wrap">
          <label class="field"><span class="t-label">From</span><input class="input" type="date" name="from" value="${monthStart}" required></label>
          <label class="field"><span class="t-label">To</span><input class="input" type="date" name="to" value="${iso(today)}" required></label>
        </div>
        <div><button type="submit" class="btn btn-primary btn-sm">Download CSV</button></div>
        <p class="t-xs faint">At most 366 days per export. Amounts are in rupees with two decimals.
          Bank accounts appear masked; full numbers are held only by Cashfree.</p>
      </form>
    </section>
    <section class="card card-pad" style="margin-top:18px">
      ${table(['Report', 'Contents'], kinds.map(([, l, , d]) => [esc(l), esc(d)]))}
    </section>`
    : EmptyState('No reports are available to you.', 'Exports need the orders.view or finance.view permission.');
}

async function downloadReport(form) {
  const btn = form.querySelector('button[type=submit]');
  const v = formValues(form);
  await act(btn, async () => {
    const { blob, name } = await quad.downloadReport(v.kind, v.from, v.to);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, { ok: 'Report downloaded' });
}

/* Every filter form on these screens submits here (Enter or Apply). */
function onFormSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form || form.closest('.modalwrap')) return;
  e.preventDefault();
  if (form.dataset.form === 'search') {
    const q = String(new FormData(form).get('q') || '').trim();
    if (!session.can('orders.view')) return toast('Searching orders needs the orders.view permission.', 'bad');
    S.orderFilter = q ? { q } : {}; S.orderTab = 'all'; S.orderPage = 1; S.route = 'orders'; route();
    return;
  }
  if (form.dataset.form === 'orders') {
    S.orderFilter = { ...formValues(form), from: S.orderFilter.from, to: S.orderFilter.to };
    S.orderPage = 1; paintOrders();
  }
  else if (form.dataset.form === 'payments') { S.payFilter = formValues(form); S.payPage = 1; paintPayments(); }
  else if (form.dataset.form === 'report') downloadReport(form);
}

/* ========================================================================
   MODAL
   ======================================================================== */
/* The dialog lives on <body>, outside #app, so it needs its own listener —
   the shell's delegated handler never saw clicks in here, which is why Cancel,
   the backdrop and in-dialog actions did nothing. The backdrop is
   .scrim-fixed (made for this wrapper): the app's .scrim carries a z-index
   and a blur that put it ON TOP of the dialog, blurring it and eating clicks. */
/* An information-only dialog: one Done button, nothing to save. */
const DONE = () => Promise.resolve(true);
function modal(title, bodyHtml, onSubmit, sub = '', { drawer = false } = {}) {
  const m = el(`
    <div class="modalwrap${drawer ? ' drawerwrap' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="scrim-fixed" data-act="closeModal"></div>
      <form class="modal">
        <div class="modal-head"><h2 class="t-h3">${esc(title)}</h2>
          ${sub ? `<p class="t-sm muted">${esc(sub)}</p>` : ''}</div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-foot">
          ${onSubmit === DONE ? '' : '<button type="button" class="btn btn-ghost" data-act="closeModal">Cancel</button>'}
          <button type="submit" class="btn btn-primary">${onSubmit === DONE ? 'Done' : 'Save'}</button>
        </div>
      </form></div>`);
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
  if (e.key === 'Escape' && document.querySelector('.oh-menu')) { document.querySelector('.oh-menu').remove(); return; }
  if (e.key === 'Escape' && document.querySelector('.modalwrap')) closeModal();
});

/* The date chips and the Graph View's metric apply as soon as they change. */
document.addEventListener('change', (e) => {
  const d = e.target.closest?.('.oh-dates input');
  if (d) {
    S.orderFilter = { ...S.orderFilter, [d.name]: d.value || undefined };
    S.orderPage = 1;
    return (S.orderTab === 'summary' ? paintSummary : paintOrders)();
  }
  if (e.target.matches?.('[data-graph-metric]')) { S.graphMetric = e.target.value; paintChart(); }
});

const field = (name, label, value = '', type = 'text') => `
  <label class="field"><span class="t-label">${esc(label)}</span>
  <input class="input" name="${name}" type="${type}" value="${esc(value ?? '')}"></label>`;
const check = (name, label, on) => `
  <label class="row" style="gap:8px"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}>
  <span class="t-sm">${esc(label)}</span></label>`;
/* A cafeteria's own sections, from the server; an item may have none. */
const categorySelect = (cats, current) => `
  <label class="field"><span class="t-label">Category</span>
    <select class="input" name="categoryId">
      <option value="">Uncategorised</option>
      ${cats.map((c) => `<option value="${c.id}" ${c.id === current ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select></label>`;

/* ========================================================================
   ACTIONS
   ======================================================================== */
const paise = (rupeesText) => Math.round(Number(String(rupeesText || '').replace(/[^\d.]/g, '')) * 100);
const textarea = (name, label, placeholder = '') => `
  <label class="field"><span class="t-label">${esc(label)}</span>
  <textarea class="input" name="${name}" rows="3" placeholder="${esc(placeholder)}"></textarea></label>`;
const select = (name, label, options) => `
  <label class="field"><span class="t-label">${esc(label)}</span>
  <select class="input" name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select></label>`;

const ACTIONS = {
  ordersPage: (t) => { S.orderPage = Number(t.dataset.page) || 1; return paintOrders(); },
  ordersReset: () => { S.orderFilter = {}; S.orderPage = 1; return scrOrders(); },
  paymentsPage: (t) => { S.payPage = Number(t.dataset.page) || 1; return paintPayments(); },
  paymentsReset: () => { S.payFilter = {}; S.payPage = 1; return scrPayments(); },
  reliabilityRefresh: () => scrReliability(),
  orderTimeline: async (t) => {
    const d = await quad.orderTimeline(t.dataset.id).catch((e) => { toast(e.message, 'bad'); return null; });
    if (!d) return;
    const f = d.financials;
    modal(`Order ${d.order.code}`, `
      <div class="rowmuted">${esc(d.order.vendor_name)} · ${esc(d.order.fulfilment)} · ${esc(ORDER_LABEL[d.order.state] || d.order.state)}</div>
      ${f ? `<div class="sunken" style="margin-top:10px">
        <div class="kot-line"><span>Food</span><span class="money">${rupees(f.food_subtotal_paise)}</span></div>
        <div class="kot-line"><span>Delivery fee</span><span class="money">${rupees(f.delivery_fee_paise)}</span></div>
        <div class="kot-line"><span>Platform fee</span><span class="money">${rupees(f.platform_fee_paise)}</span></div>
        <div class="kot-line"><b>Customer paid</b><b class="money">${rupees(d.order.total_paise)}</b></div>
        <div class="kot-line"><span>Gateway fee</span><span class="money">${f.gateway_fee_paise ? rupees(f.gateway_fee_paise) : 'from the settlement report'}</span></div>
      </div>` : '<p class="t-sm muted">No financial snapshot is recorded for this order (one is written when its payment is confirmed).</p>'}
      <h3 class="t-label" style="margin-top:12px">Timeline</h3>
      <ol class="timeline">${d.timeline.map((e) => `<li>
        <span class="t-xs faint">${esc(new Date(e.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</span>
        <span class="chip chip-soft">${esc(TIMELINE_KIND[e.kind] || e.kind)}</span>
        ${esc(e.label)}${e.amountPaise ? ` · ${rupees(e.amountPaise)}` : ''}${e.by ? ` · ${esc(e.by)}` : ''}${
          e.outcome && e.outcome !== 'ok' ? ` · <b>${esc(e.outcome)}</b>` : ''}${e.duplicates ? ` · ${e.duplicates} duplicate(s) ignored` : ''}${
          e.note ? `<div class="t-xs faint">${esc(e.note)}</div>` : ''}</li>`).join('') || '<li class="t-sm muted">Nothing recorded.</li>'}</ol>`, DONE, '', { drawer: true });
  },
  theme: () => toggleAdminTheme(),

  /* ---- incidents, deductions, deposits ---- */
  investigate: (t) => act(t, () => quad.investigateIncident(t.dataset.id), { ok: 'Marked as investigating', after: scrTrust }),
  resolveIncident: (t) => modal(`Resolve ${t.dataset.code}`, `
    ${select('outcome', 'Outcome', INCIDENT_OUTCOMES)}
    ${textarea('note', 'What the investigation found', 'Order timeline, pickup and handover code times, statements, photos.')}
    <p class="t-xs faint">Resolving as "Partner responsible" does not deduct anything. It only makes a deduction possible, which is proposed separately with evidence and can be disputed.</p>`,
    (d) => quad.resolveIncident(t.dataset.id, d.outcome, d.note)),
  resolvedIncidents: async () => {
    const [inc, ded] = await Promise.all([quad.incidents('resolved'), quad.deductions('all')]);
    modal('Resolved incidents', `
      ${inc.incidents.length ? table(['Code', 'Order', 'Outcome', ''], inc.incidents.map((i) => [
        esc(i.code), `#${esc(i.order_code)}`,
        `<b>${esc(i.outcome.replace(/_/g, ' '))}</b><div class="t-xs muted">${esc(i.resolution_note)}</div>`,
        i.outcome === 'partner_responsible' && !(i.deductions || []).some((x) => !['dismissed', 'withdrawn'].includes(x.state))
          ? `<button type="button" class="btn btn-secondary btn-sm" data-act="proposeDeduction" data-id="${i.id}" data-code="${esc(i.code)}" data-partner="${esc(i.partner_name || '')}">Propose deduction</button>`
          : (i.deductions || []).map((x) => `<span class="badge ${DED_BADGE[x.state]}">${esc(x.state)} ${rupees(x.amount_paise)}</span>`).join(' '),
      ])) : '<p class="t-sm muted">No resolved incidents.</p>'}
      <h3 class="t-label" style="margin-top:14px">Deduction history</h3>
      ${ded.deductions.length ? table(['Partner', 'Amount', 'State', 'When'], ded.deductions.map((x) => [
        esc(x.partner_name), rupees(x.amount_paise), `<span class="badge ${DED_BADGE[x.state]}">${esc(x.state)}</span>`, when(x.proposed_at)]))
        : '<p class="t-sm muted">No deductions.</p>'}`, DONE);
  },
  proposeDeduction: (t) => modal(`Propose a deduction · ${t.dataset.code}`, `
    <p class="t-sm muted">From ${esc(t.dataset.partner)}'s security deposit. They are notified and can dispute it before anything is deducted.</p>
    ${field('amount', 'Amount (₹)', '', 'number')}
    ${field('reason', 'Reason (shown to the partner)')}
    ${textarea('evidence', 'Evidence', 'What was checked and what it showed. At least 20 characters.')}`,
    (d) => quad.proposeDeduction({ incidentId: t.dataset.id, amountPaise: paise(d.amount), reason: d.reason, evidence: d.evidence })),
  reviewDeduction: (t) => modal(t.dataset.d === 'uphold' ? 'Uphold the deduction' : 'Dismiss the deduction',
    `${textarea('note', 'Reasoning (shown to the partner)')}
     ${t.dataset.d === 'uphold' ? '<p class="t-xs faint">The administrator who proposed a deduction cannot decide its dispute.</p>' : ''}`,
    (d) => quad.reviewDeduction(t.dataset.id, t.dataset.d, d.note)),
  applyDeduction: (t) => {
    if (!confirm(`Deduct ${rupees(+t.dataset.amount)} from this partner's security deposit? This is recorded permanently in the ledger.`)) return;
    return act(t, () => quad.applyDeduction(t.dataset.id), { ok: 'Deduction applied', after: scrTrust });
  },
  withdrawDeduction: (t) => modal('Withdraw the deduction', textarea('note', 'Why'), (d) => quad.withdrawDeduction(t.dataset.id, d.note)),
  recordDeposit: (t) => modal(`Record deposit · ${t.dataset.name}`, `
    <p class="t-sm muted">Only record money that has actually arrived in the ECHO ECHO account.</p>
    ${field('amount', 'Amount received (₹)', '', 'number')}
    ${select('method', 'Method', [['manual_upi', 'UPI'], ['manual_bank_transfer', 'Bank transfer']])}
    ${field('reference', 'UPI / bank transaction reference')}
    ${field('note', 'Note (optional)')}`,
    (d) => quad.recordDeposit(t.dataset.id, { amountPaise: paise(d.amount), method: d.method, externalReference: d.reference, note: d.note })),
  editDepositPolicy: async () => {
    const { policy } = await quad.partnerPolicy();
    const m = modal('Partner deposit policy', `
      <p class="t-sm muted">Publishing creates a new version. Partners who have not yet been approved must accept the new version.</p>
      ${field('amount', 'Security deposit (₹, 0 for none)', policy ? policy.amountPaise / 100 : 0, 'number')}
      ${field('window', 'Dispute window (hours, 24–720)', policy?.disputeWindowHours || 72, 'number')}
      ${textarea('terms', 'Terms partners agree to')}`,
      (d) => quad.setDepositPolicy({ amountPaise: paise(d.amount), disputeWindowHours: Number(d.window), terms: d.terms }));
    m.querySelector('textarea[name=terms]').value = policy?.terms || '';
  },
  payDepositRefund: (t) => modal('Record deposit refund', `
    <p class="t-sm muted">Transfer ${rupees(+t.dataset.amount)} to the partner first, then record the reference here.</p>
    ${select('method', 'Method', [['manual_upi', 'UPI'], ['manual_bank_transfer', 'Bank transfer']])}
    ${field('reference', 'Transaction reference')}`,
    (d) => quad.payDepositRefund(t.dataset.id, { method: d.method, externalReference: d.reference })),
  rejectDepositRefund: (t) => modal('Decline refund request', textarea('note', 'Reason (shown to the partner)'),
    (d) => quad.rejectDepositRefund(t.dataset.id, d.note)),

  /* ---- reviews ---- */
  reviewsFilter: (t) => { S.reviewFilter = t.dataset.v; return scrReviews(); },
  resolveReport: (t) => modal('Resolve report', textarea('resolution', 'Outcome'),
    (d) => quad.resolveReviewReport(t.dataset.id, d.resolution)),
  hideReview: (t) => modal('Hide review', `${textarea('reason', 'Reason')}<p class="t-xs faint">Hidden reviews stop counting towards ratings. The text is kept, unedited, for the record.</p>`,
    (d) => quad.hideReview(t.dataset.id, true, d.reason)),

  /* ---- administrators ---- */
  newAdminInvite: async () => {
    const catalog = await quad.accessCatalog();
    modal('Invite an administrator', `
      ${field('name', 'Name')}
      ${field('email', 'University email', '', 'email')}
      ${select('role', 'Role ceiling', [['platform_admin', 'Administrator'], ['support', 'Support']])}
      <p class="t-xs faint">They sign in with this mailbox, enter the one-time code from the invitation email, then set a password and an authenticator app.
        The code expires in ${catalog.inviteTtlHours} hours and works once.${catalog.emailDelivery ? '' : ' Email is not configured, so the code will be shown to you once instead.'}</p>
      ${permissionPicker(catalog)}`,
    async (d, form) => {
      const out = await quad.inviteAdministrator({ name: d.name, email: d.email, role: d.role, permissions: pickedPermissions(form) });
      if (out.inviteCode) {
        setTimeout(() => modal(`Invitation code · ${out.administrator.name}`, `
          <p class="t-sm muted">${esc(out.note)}</p><div class="enrolcode">${esc(out.inviteCode)}</div>
          <p class="t-xs faint" style="margin-top:10px">Expires ${esc(new Date(out.expiresAt).toLocaleString('en-IN'))}. Shown only now.</p>`, DONE), 0);
      } else toast('Invitation emailed');
      return out;
    });
  },
  applyPreset: (t) => {
    const want = new Set((t.dataset.perms || '').split(',').filter(Boolean));
    t.closest('form').querySelectorAll('input[name=perm]:not([disabled])').forEach((i) => { i.checked = want.has(i.value); });
  },
  editAdminPermissions: async (t) => {
    const [catalog, detail] = await Promise.all([quad.accessCatalog(), quad.accessAdmin(t.dataset.id)]);
    const before = detail.administrator.effective.permissions;
    modal(`Permissions · ${t.dataset.name}`, `
      <p class="t-sm muted">${esc(detail.administrator.email || '')} · ${esc(detail.administrator.status)} ·
        ${detail.sessions.length} open session(s). A change applies to their open sessions on the next request.</p>
      ${permissionPicker(catalog, before)}
      ${field('reason', 'Reason for the change (kept in the audit log)')}
      ${detail.history.length ? `<h3 class="t-label" style="margin-top:6px">Permission history</h3>
        ${table(['When', 'Change', 'By'], detail.history.slice(0, 12).map((h) => [when(h.at), esc(h.action.replace(/^admin\./, '').replace(/_/g, ' ')), esc(h.actor_name || '—')]))}` : ''}`,
    (d, form) => {
      const after = pickedPermissions(form);
      const added = after.filter((k) => !before.includes(k));
      const removed = before.filter((k) => !after.includes(k));
      if (!added.length && !removed.length) throw new Error('Nothing changed.');
      if (!confirm(`Change ${t.dataset.name}'s permissions?

${added.length ? `Grant: ${added.join(', ')}
` : ''}${removed.length ? `Remove: ${removed.join(', ')}` : ''}`)) throw new Error('Not saved.');
      return quad.setAdminPermissions(t.dataset.id, after, d.reason);
    }, '', { drawer: true });
  },
  suspendAdmin: (t) => modal(`Suspend ${t.dataset.name}`,
    `<p class="t-sm muted">Every session ends now. Their password and authenticator are kept, so the owner can restore access later.</p>
     ${field('reason', 'Reason')}`, (d) => quad.suspendAdmin(t.dataset.id, d.reason)),
  restoreAdmin: (t) => modal(`Restore ${t.dataset.name}`, field('reason', 'Reason'), (d) => quad.restoreAdmin(t.dataset.id, d.reason)),
  revokeAdmin: (t) => modal(`Revoke ${t.dataset.name}'s administrator access`,
    `<p class="t-sm muted">Removes their administrator role, password, authenticator, pending invites and every session.
      Their student account is not affected. Restoring later needs a new invitation.</p>
     ${field('reason', 'Reason')}`, (d) => quad.revokeAdmin(t.dataset.id, d.reason)),
  revokeAdminSessions: (t) => modal(`Sign ${t.dataset.name} out everywhere`, field('reason', 'Reason'),
    (d) => quad.revokeAdminSessions(t.dataset.id, d.reason)),
  reissueAdminInvite: async (t) => {
    const out = await act(t, () => quad.reissueAdminInvite(t.dataset.id));
    if (!out) return;
    if (out.inviteCode) {
      modal(`Invitation code · ${t.dataset.name}`, `<p class="t-sm muted">${esc(out.note)}</p><div class="enrolcode">${esc(out.inviteCode)}</div>`, DONE);
    } else toast('A new invitation code was emailed');
  },
  confirmLocation: (t) => modal(`Confirm ${t.dataset.name}`, `
    <p class="t-sm muted">This location came from a public map. Confirm it only after checking on the ground that it exists at the recorded position and that food can be handed over there.</p>
    ${textarea('confirmation', 'How you confirmed it', 'e.g. Visited 20 Sep; hand-over at the main entrance; position matches.')}`,
    (d) => quad.confirmLocation(t.dataset.id, d.confirmation)),
  cancelInvitation: (t) => act(t, () => quad.cancelInvitation(t.dataset.id), { ok: 'Invitation cancelled', after: scrAdmins }),
  adminDetail: async (t) => {
    const d = await quad.accessAdmin(t.dataset.id);
    const a = d.administrator;
    modal(`${a.name || a.email}`, `
      <p class="t-sm">${esc(a.email || '')} · ${a.isOwner ? 'Owner' : esc(a.status)}
        ${a.activated_at ? ` · active since ${when(a.activated_at)}` : ''}</p>
      <h3 class="t-label" style="margin-top:12px">Permissions</h3>
      <p class="t-xs">${a.isOwner ? 'All, including owner-only powers.' : a.effective.permissions.map(esc).join(', ') || 'None'}</p>
      <h3 class="t-label" style="margin-top:12px">Old passkeys</h3>
      <p class="t-xs faint">Left over from the previous sign-in. Nobody signs in with these any more — remove them when you see them.</p>
      ${d.credentials.length ? table(['Device', 'Added', 'Last used', ''], d.credentials.map((c) => [
        esc(c.label), when(c.created_at), c.last_used_at ? when(c.last_used_at) : '—',
        c.revoked_at ? '<span class="badge">removed</span>'
          : (session.isOwner || a.id === session.me.user.id)
            ? `<button type="button" class="btn btn-ghost btn-sm" data-act="revokePasskey" data-id="${c.id}" data-label="${esc(c.label)}">Remove</button>` : ''])) : '<p class="t-sm muted">None.</p>'}
      <h3 class="t-label" style="margin-top:12px">Open sessions</h3>
      ${d.sessions.length ? table(['Since', 'Method', 'IP', 'Device'], d.sessions.map((s) => [when(s.issued_at), esc(s.auth_method), esc(s.ip || '—'), `<span class="t-xs">${esc(s.user_agent)}</span>`])) : '<p class="t-sm muted">None.</p>'}
      <h3 class="t-label" style="margin-top:12px">Access history</h3>
      ${d.history.length ? table(['When', 'Change', 'By'], d.history.map((h) => [when(h.at), esc(h.action), esc(h.actor_name || '—')])) : '<p class="t-sm muted">None.</p>'}
      <h3 class="t-label" style="margin-top:12px">Recent activity</h3>
      ${d.activity.length ? table(['When', 'Action', 'Outcome'], d.activity.slice(0, 50).map((x) => [when(x.at), esc(x.action), esc(x.outcome)])) : '<p class="t-sm muted">No activity yet.</p>'}`, DONE, '', { drawer: true });
  },
  revokePasskey: (t) => {
    if (!confirm(`Remove the passkey “${t.dataset.label}”? Sessions opened with it end immediately.`)) return;
    return act(t, () => quad.revokePasskey(t.dataset.id), { ok: 'Passkey removed', after: scrAdmins });
  },

  /* ---- your own sign-in ---------------------------------------------------
     A new password needs the old one and a current code, so someone who
     walks up to an unlocked screen cannot lock the real administrator out. */
  changeAdminPassword: async () => {
    const current = prompt('Your current password:');
    if (current === null) return;
    const code = prompt('The 6-digit code your authenticator app is showing now:');
    if (code === null) return;
    const next = prompt('Your new password (at least 12 characters):');
    if (next === null) return;
    const again = prompt('Type the new password again:');
    if (again !== next) return toast('The two passwords do not match', 'bad');
    try {
      await quad.setAdminPassword({ currentPassword: current, code, password: next });
      toast('Password changed. Every other session has been signed out.');
      scrAdmins();
    } catch (e) { toast(explain(e), 'bad'); }
  },

  replaceAuthenticator: async () => {
    if (!confirm('Set up a new authenticator? The one you use now stops working as soon as you confirm the new one.')) return;
    let out;
    try { out = await quad.beginAuthenticator(); }
    catch (e) {
      /* Replacing a working authenticator needs a fresh password + code. */
      if (e instanceof ApiError && e.code === 'reauth_required') {
        try { await adminReauth(); out = await quad.beginAuthenticator(); } catch (e2) { return toast(explain(e2), 'bad'); }
      } else return toast(explain(e), 'bad');
    }
    const qr = await qrSvg(out.uri);
    modal('Set up your authenticator', `
      <p class="t-sm muted">In Microsoft Authenticator choose <b>Add account → Other account</b> and scan this code,
        or choose <b>Enter code manually</b> and type the key below.</p>
      ${qr ? `<div class="enrol-qr">${qr}</div>` : ''}
      <div class="enrolcode">${esc(groupKey(out.secret))}</div>
      <p class="t-xs faint">Account name: ${esc(out.issuer)} · ${out.digits} digits · a new code every ${out.periodSeconds} seconds.
        This key is shown once. It is stored encrypted and nothing can read it back.</p>
      <label class="t-label" style="margin-top:12px;display:block">Code the app is showing now</label>
      <input class="input" name="code" inputmode="numeric" maxlength="6" placeholder="——————"
             style="font-family:'DM Mono',monospace;letter-spacing:.3em;text-align:center">`,
      async (data) => {
        const code = String(data.code || '').replace(/\D/g, '');
        if (code.length !== 6) throw new Error('Enter the 6 digits the app is showing.');
        await quad.confirmAuthenticator(code);
        toast('Authenticator set up');
      });
  },
  /* Passkeys are no longer a sign-in method; nothing offers adding one. */

  /* ---- campuses ---- */
  editCampus: (t) => {
    const m = modal(`${t.dataset.name} · service`, `
      ${select('status', 'Service status', [['active', 'Active — ordering open'], ['coming_soon', 'Coming soon'], ['paused', 'Paused']])}
      ${field('message', 'Message shown to students when not active', t.dataset.message)}`,
      (d) => quad.setCampus(t.dataset.id, { serviceStatus: d.status, statusMessage: d.message }));
    m.querySelector('select[name=status]').value = t.dataset.status;
  },
  signout: () => signOut(),
  closeModal,

  /* ---- cafeterias ---- */
  newVendor: () => modal('Add cafeteria', `
    ${field('name', 'Name')}${field('kind', 'Kind', 'Campus outlet')}
    ${field('description', 'Description')}
    <div class="formrow">${field('opensAt', 'Opens', '', 'time')}${field('closesAt', 'Closes', '', 'time')}</div>
    ${field('prepMinutes', 'Typical prep (minutes)', '10', 'number')}
    ${check('deliveryEnabled', 'Offers delivery', true)}
    ${check('staffCanDeliver', 'Staff can deliver', false)}`,
    (d) => quad.createVendor({ ...d, prepMinutes: +d.prepMinutes || 10,
      deliveryEnabled: !!d.deliveryEnabled, staffCanDeliver: !!d.staffCanDeliver }),
    'It is created closed. The owner opens it when they are ready to trade.'),

  editVendor: async (t) => {
    const v = (await quad.vendors({ includeArchived: 'true' })).vendors.find((x) => x.id === t.dataset.id);
    const nodes = v.campus_site_id ? (await quad.campusTree(v.campus_site_id)).nodes : [];
    modal(`Edit ${v.name}`, `
      ${field('name', 'Name', v.name)}${field('kind', 'Kind', v.kind)}
      ${field('description', 'Description', v.description)}
      <div class="formrow">${field('opensAt', 'Opens', v.opens_at, 'time')}${field('closesAt', 'Closes', v.closes_at, 'time')}</div>
      ${field('prepMinutes', 'Prep minutes', v.prep_minutes, 'number')}
      ${field('contactPhone', 'Business contact phone', v.contact_phone)}
      ${check('contactPublic', 'Show this number to customers', v.contact_public)}
      ${check('deliveryEnabled', 'Offers delivery', v.delivery_enabled)}
      <label class="field"><span class="t-label">Pickup point (for walking-time estimates)</span>
        <select class="input" name="campusNodeId">
          <option value="">Not set — no estimates are shown</option>
          ${nodes.map((n) => `<option value="${n.id}" ${n.id === v.campus_node_id ? 'selected' : ''}>
            ${esc(n.name)}${n.lat == null ? ' (no recorded position)' : ''}</option>`).join('')}
        </select></label>`,
      (d) => quad.updateVendor(v.id, { ...d, opensAt: d.opensAt || null, closesAt: d.closesAt || null,
        prepMinutes: +d.prepMinutes, campusNodeId: d.campusNodeId || null,
        deliveryEnabled: !!d.deliveryEnabled, contactPublic: !!d.contactPublic }));
  },

  toggleOpen: (t) => act(t, () => quad.updateVendor(t.dataset.id,
    { isOpen: t.dataset.v === '1', accepting: t.dataset.v === '1' }), { after: route }),

  toggleAccepting: (t) => act(t, () => quad.updateVendor(t.dataset.id, { accepting: t.dataset.v === '1' }),
    { after: route }),

  archiveVendor: (t) => act(t, () => quad.updateVendor(t.dataset.id, { active: t.dataset.v === '1' }),
    { after: route }),

  assignOwner: (t) => modal('Assign cafeteria owner', `
    ${field('name', 'Name')}${field('phone', 'Phone number', '', 'tel')}
    <p class="t-xs faint">
      No password is created. Give them an enrolment code and they sign in at the Counter.
    </p>`,
    (d) => quad.grantRole({ ...d, role: 'vendor_owner', vendorId: t.dataset.id })),

  assignStaff: (t) => modal('Add counter staff', `
    ${field('name', 'Name')}${field('phone', 'Phone number', '', 'tel')}`,
    (d) => quad.grantRole({ ...d, role: 'vendor_staff', vendorId: t.dataset.id })),

  menuFor: (t) => { S.vendorId = t.dataset.id; S.route = 'menu'; route(); },

  /* ---- menu ---- */
  pickVendor: (t) => { S.vendorId = t.value; paintMenu(); },

  newItem: async () => modal('Add food', `
    ${field('name', 'Name')}${field('description', 'Description')}
    <div class="formrow">${field('price', 'Price (₹)')}${field('prepMinutes', 'Prep minutes', '', 'number')}</div>
    ${categorySelect((await quad.categories(S.vendorId)).categories)}
    ${check('available', 'Available to order now', true)}
    ${field('tags', 'Tags (comma separated)')}
    ${field('aliases', 'AI aliases (comma separated)')}
    ${check('veg', 'Vegetarian', true)}
    <label class="field"><span class="t-label">Photo</span>
      <input class="input" type="file" name="photo" accept="image/*"></label>`,
    async (d, form) => {
      const file = form.querySelector('input[name=photo]').files[0];
      const photoAsset = file ? (await quad.uploadPhoto(file, 'food_photo')).id : undefined;
      return quad.createItem(S.vendorId, {
        name: d.name, description: d.description, price: d.price,
        prepMinutes: +d.prepMinutes || null, veg: !!d.veg, photoAsset,
        categoryId: d.categoryId || null, available: !!d.available,
        tags: splitList(d.tags), aliases: splitList(d.aliases),
      });
    }),

  editItem: async (t) => {
    const [menu, cats] = await Promise.all([quad.menu(S.vendorId), quad.categories(S.vendorId)]);
    const i = menu.items.find((x) => x.id === t.dataset.id);
    modal(`Edit ${i.name}`, `
      ${field('name', 'Name', i.name)}${field('description', 'Description', i.description)}
      <div class="formrow">${field('price', 'Price (₹)', (i.price_paise / 100).toFixed(2))}
      ${field('prepMinutes', 'Prep minutes', i.prep_minutes, 'number')}</div>
      ${categorySelect(cats.categories, i.category_id)}
      ${field('tags', 'Tags', (i.tags || []).join(', '))}
      ${field('aliases', 'AI aliases', (i.aliases || []).join(', '))}
      ${check('veg', 'Vegetarian', i.veg)}
      <label class="field"><span class="t-label">Replace photo</span>
        <input class="input" type="file" name="photo" accept="image/*"></label>
      <p class="t-xs faint">
        Changing the price affects new orders only. Existing orders keep the price they were placed at.
      </p>`,
      async (d, form) => {
        const file = form.querySelector('input[name=photo]').files[0];
        const photoAsset = file ? (await quad.uploadPhoto(file, 'food_photo')).id : undefined;
        return quad.updateItem(i.id, {
          name: d.name, description: d.description, price: d.price,
          prepMinutes: +d.prepMinutes || null, veg: !!d.veg, photoAsset,
          categoryId: d.categoryId || null,
          tags: splitList(d.tags), aliases: splitList(d.aliases),
        });
      });
  },

  itemAvail: (t) => act(t, () => quad.updateItem(t.dataset.id, { available: t.dataset.v === '1' }),
    { after: paintMenu }),
  itemArchive: (t) => act(t, () => quad.updateItem(t.dataset.id, { active: t.dataset.v === '1' }),
    { after: paintMenu }),
  /* The server deletes only an item nobody has ordered and says why otherwise. */
  itemDelete: (t) => modal(`Delete ${t.dataset.name}?`, `
      <p class="t-sm muted">This removes the item for good. If anyone has ever ordered it,
      the server refuses and it should be archived instead.</p>`,
    () => quad.deleteItem(t.dataset.id)),

  categories: async () => {
    const { categories } = await quad.categories(S.vendorId);
    modal('Categories', `
      ${categories.length ? `<div class="stack">${categories.map((c) => `
        <div class="between">
          <span class="t-sm">${esc(c.name)} <span class="t-xs faint">· ${c.items} item${c.items === 1 ? '' : 's'}</span></span>
          <span class="row" style="gap:6px">
            <button type="button" class="btn btn-ghost btn-sm" data-act="renameCategory" data-id="${c.id}" data-name="${esc(c.name)}">Rename</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="removeCategory" data-id="${c.id}" data-name="${esc(c.name)}">Remove</button>
          </span>
        </div>`).join('')}</div>` : '<p class="t-sm muted">No categories yet.</p>'}
      ${field('name', 'New category')}
      <p class="t-xs faint">Removing a category keeps its food; those items become uncategorised.</p>`,
      (d) => (String(d.name || '').trim() ? quad.createCategory(S.vendorId, { name: d.name }) : true));
  },
  renameCategory: (t) => modal('Rename category', field('name', 'Name', t.dataset.name),
    (d) => quad.updateCategory(t.dataset.id, { name: d.name })),
  removeCategory: (t) => modal(`Remove ${t.dataset.name}?`,
    `<p class="t-sm muted">Its items stay on the menu, uncategorised.</p>`,
    () => quad.deleteCategory(t.dataset.id)),

  /* ---- users ---- */
  searchUsers: () => paintUsers(document.getElementById('user-q').value.trim()),

  addRole: () => modal('Assign a role', `
    ${field('name', 'Name')}${field('phone', 'Phone number', '', 'tel')}
    <label class="field"><span class="t-label">Role</span>
      <select class="input" name="role">
        <option value="vendor_owner">Cafeteria owner</option>
        <option value="vendor_staff">Cafeteria staff</option>
        <option value="support">Support</option>
        <option value="platform_admin">Admin</option>
      </select></label>
    ${field('vendorId', 'Cafeteria id (vendor roles only)')}
    <p class="t-xs faint">
      platform_owner cannot be granted here — it is set from the server's
      PLATFORM_OWNER_PHONE and no API can hand it out. Platform roles can only
      be granted by the platform owner.
    </p>`,
    (d) => quad.grantRole({ ...d, vendorId: d.vendorId || undefined })),

  inspectUser: async (t) => {
    const u = await quad.user(t.dataset.id);
    modal(`${u.user.name || u.user.phone}`, `
      <div class="sunken">
        <div class="rowmuted">Phone: ${esc(u.user.phone || '—')}</div>
        <div class="rowmuted">Student email: ${u.user.student_email
          ? `${esc(u.user.student_email)} (proven ${when(u.user.student_email_verified_at)})` : 'not proven'}</div>
        <div class="rowmuted">Student verification: ${esc(u.user.student_status)}</div>
        <div class="rowmuted">Roll: ${esc(u.user.roll_number || '—')}</div>
        <div class="rowmuted">Orders delivered: ${u.orders.n} · ${rupees(u.orders.spent)}</div>
      </div>
      <h3 class="t-label" style="margin-top:12px">Roles</h3>
      ${u.roles.map((r) => `<div class="rowmuted between">
        <span>${esc(r.role)}${r.vendor_name ? ` · ${esc(r.vendor_name)}` : ''}</span>
        <span class="badge ${r.status === 'active' ? 'badge-open' : 'badge-closed'}">${esc(r.status)}</span>
      </div>`).join('')}
      <h3 class="t-label" style="margin-top:12px">Verification history</h3>
      ${u.verificationHistory.length ? u.verificationHistory.map((k) => `
        <div class="rowmuted">${esc(METHOD_LABEL[k.method] || k.method)} · ${esc(k.state)} · ${when(k.submitted_at)}
          ${k.decision_note ? ` — ${esc(k.decision_note)}` : ''}</div>`).join('')
        : '<p class="t-sm muted">No submissions.</p>'}
      <div class="row" style="gap:8px;margin-top:12px">
        ${u.user.student_status === 'suspended'
          ? `<button class="btn btn-secondary btn-sm" data-act="studentVerif" data-id="${u.user.id}" data-v="reinstate">Reinstate verification</button>`
          : `<button class="btn btn-danger btn-sm" data-act="studentVerif" data-id="${u.user.id}" data-v="suspend">Suspend verification</button>`}
      </div>`,
      DONE);
  },

  studentVerif: async (t) => {
    const note = prompt(t.dataset.v === 'suspend'
      ? 'Reason for suspending this student\'s verification (recorded, and shown to them):'
      : 'Reason for reinstating (recorded):');
    if (note === null) return;
    await act(t, () => quad.setStudentVerification(t.dataset.id, t.dataset.v, note),
      { ok: t.dataset.v === 'suspend' ? 'Verification suspended' : 'Verification reinstated',
        after: () => paintUsers(document.getElementById('user-q')?.value || '') });
  },

  toggleSuspend: (t) => act(t, () => quad.setUserStatus(t.dataset.id, t.dataset.v),
    { after: () => paintUsers(document.getElementById('user-q')?.value || '') }),

  /* Issues a sign-in code that needs no SMS provider. Shown once, here,
     because the plaintext exists nowhere else — the server keeps only a
     hash, and the audit log records the issue but never the code. */
  issueEnrol: async (t) => {
    const out = await act(t, () => quad.issueEnrolment(t.dataset.id));
    if (!out) return;
    const hours = Math.round(out.ttlMinutes / 60);
    modal('Enrolment code', `
      <p class="t-sm muted">Read this to <b>${esc(out.name || out.phone)}</b> in person,
      or send it by a channel you trust. They enter it with their number at sign-in.</p>
      <div class="enrolcode">${esc(out.code)}</div>
      <div class="sunken" style="margin-top:12px">
        <div class="rowmuted">Account: ${esc(out.phone)}</div>
        <div class="rowmuted">Expires: in ${hours} hour${hours === 1 ? '' : 's'}</div>
        <div class="rowmuted">Works once. Issuing another code cancels this one.</div>
      </div>
      <p class="t-xs faint" style="margin-top:10px">
        This is the only time the code is shown. ECHO ECHO stores only its hash, so it
        cannot be looked up again — issue a new one if it is lost.
      </p>`,
      DONE);
  },

  /* ---- verification ---- */
  vqFilter: (t) => { S.verifyFilter = t.dataset.v; return scrVerification(); },
  decide: async (t) => {
    let note = '';
    if (t.dataset.d !== 'approve') note = prompt('Reason (shown to the student):') ?? '';
    else if (t.dataset.m === 'manual') {
      note = prompt('How did you confirm this student is currently enrolled? (required, recorded in the audit log)');
      if (note === null) return;
    }
    await act(t, () => quad.decideVerification(t.dataset.id, t.dataset.d, note),
      { ok: 'Decision recorded', after: scrVerification });
  },

  /* ---- partners ---- */
  pFilter: (t) => { S.partnerFilter = t.dataset.v; return scrPartners(); },
  pDecide: (t) => act(t, () => quad.decidePartner(t.dataset.id, t.dataset.d),
    { ok: 'Decision recorded', after: scrPartners }),

  /* ---- locations ---- */
  newLocation: () => locationModal(null, null),
  addChild: (t) => locationModal(null, t.dataset.id),
  editLocation: (t) => locationModal(t.dataset.id, null),
  openNode: async (t) => {
    const kids = (await quad.campusChildren(t.dataset.id)).nodes;
    modal('Locations inside', kids.length
      ? `<div class="tree">${kids.map(nodeRow).join('')}</div>`
      : `<p class="t-sm muted">Nothing inside this location yet.</p>`,
      DONE);
  },
  toggleLoc: (t) => act(t, () => quad.updateLocation(t.dataset.id, { deliveryEnabled: t.dataset.v === '1' }),
    { after: route }),
  archiveLoc: (t) => {
    if (!confirm('Archive this location? Historical orders that used it stay resolvable.')) return;
    return act(t, () => quad.archiveLocation(t.dataset.id), { after: route });
  },

  editBoundary: () => modal('Propose a delivery boundary', `
    ${field('name', 'Name')}
    <label class="field"><span class="t-label">Outline — one "lat,lng" per line, in order around the perimeter</span>
      <textarea class="input" name="polygon" rows="8"
        placeholder="30.4160,77.9680&#10;30.4172,77.9701"></textarea></label>
    ${textarea('sourceNote', 'Where does this outline come from?', 'For example: walked the perimeter with GPS on 20 Sep; traced from the official campus map.')}
    <p class="t-xs faint">
      A proposal changes nothing for students. It is used only after an
      administrator confirms it, with a passkey. Never enter an outline you have
      not verified: an invented one silently accepts or rejects students in the
      wrong places.
    </p>`,
    (d) => {
      const polygon = String(d.polygon || '').split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => l.split(',').map((x) => Number(x.trim())));
      if (polygon.some((p) => p.length !== 2 || p.some(Number.isNaN))) {
        throw new Error('Each line must be "lat,lng"');
      }
      return quad.proposeBoundary(S.locCampus, { name: d.name, polygon, source: 'admin', sourceNote: d.sourceNote });
    }),

  activateBoundary: (t) => modal(`Confirm ${t.dataset.name}`, `
    <p class="t-sm muted">Once active, delivery on this campus is allowed only to locations inside this outline,
      and live location is checked against it. The current boundary, if any, is retired.</p>
    ${textarea('confirmation', 'How did you confirm this outline?', 'For example: walked the perimeter on 20 Sep; all hostel blocks and both gates are inside.')}`,
    (d) => quad.activateBoundary(t.dataset.id, d.confirmation)),

  /* ---- field geodata ---- */
  useDeviceGps: (t) => {
    const form = t.closest('form');
    const status = form.querySelector('[data-gps-status]');
    if (!('geolocation' in navigator)) { status.textContent = 'This browser cannot read GPS.'; return; }
    status.textContent = 'Reading GPS… stand still, outdoors if possible.';
    t.disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      t.disabled = false;
      const { latitude, longitude, accuracy } = pos.coords;
      form.querySelector('[name=lat]').value = latitude.toFixed(7);
      form.querySelector('[name=lng]').value = longitude.toFixed(7);
      form.querySelector('[name=gpsAccuracyM]').value = Math.round(accuracy);
      form.querySelector('[name=verificationMethod]').value = 'gps_on_site';
      status.textContent = `Recorded to about ±${Math.round(accuracy)} m at ${new Date(pos.timestamp).toLocaleTimeString('en-IN')}.` +
        (accuracy > 25 ? ' That is imprecise — wait a few seconds outdoors and read again.' : '');
    }, (err) => {
      t.disabled = false;
      status.textContent = err.code === 1 ? 'Location permission was refused.' : 'Could not read a GPS position. Try again outdoors.';
    }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
  },

  importPoints: () => {
    const m = modal('Import GPS points', `
      <p class="t-sm muted">Paste an export from a GPS app: CSV (<code>name,type,lat,lng,accuracy_m,method,deliverable,note</code>),
        GPX waypoints, or GeoJSON points. Preview first — nothing is stored until you import.</p>
      ${select('format', 'Format', [['', 'Detect automatically'], ['csv', 'CSV'], ['gpx', 'GPX'], ['geojson', 'GeoJSON']])}
      <label class="field"><span class="t-label">File contents</span>
        <textarea class="input" name="text" rows="8" placeholder="name,type,lat,lng,accuracy_m,method,deliverable,note"></textarea></label>
      <label class="field"><span class="t-label">Or choose a file</span><input class="input" type="file" name="file" accept=".csv,.gpx,.json,.geojson,text/*"></label>
      ${select('defaultMethod', 'Method for rows that do not say', METHOD_OPTS.filter(([v]) => v))}
      <div class="row" style="gap:8px;margin:8px 0"><button type="button" class="btn btn-secondary btn-sm" data-act="previewPoints">Preview</button></div>
      <div data-preview></div>
      ${check('confirm', 'I collected these on site myself — confirm them now (needs passkey)', false)}
      ${field('confirmation', 'How they were collected (required to confirm)')}`,
    async (d, form) => {
      const text = await fileOrText(form);
      const out = await quad.importPoints(S.locCampus, { format: d.format || undefined, text, defaultMethod: d.defaultMethod,
        confirm: !!d.confirm, confirmation: d.confirmation });
      toast(`${out.created.length} location(s) imported${out.confirmed ? ' and confirmed' : ' as pending'}`);
      return out;
    });
    m.querySelector('select[name=defaultMethod]').value = 'gps_on_site';
  },
  previewPoints: async (t) => {
    const form = t.closest('form');
    const box = form.querySelector('[data-preview]');
    try {
      const text = await fileOrText(form);
      const d = Object.fromEntries(new FormData(form));
      const out = await quad.previewPoints(S.locCampus, { format: d.format || undefined, text, defaultMethod: d.defaultMethod });
      box.innerHTML = `
        <p class="t-sm"><b>${out.points.length}</b> valid · <b>${out.rejected.length}</b> invalid ·
          boundary: ${out.boundaries.active ? `checked against “${esc(out.boundaries.active.name)}”` : '<span class="badge badge-warn">none confirmed</span>'}</p>
        ${out.rejected.length ? table(['Line', 'Name', 'Problem'], out.rejected.map((r) => [String(r.line), esc(r.name || '—'), esc(r.problems.join('; '))])) : ''}
        ${table(['Name', 'Type', 'Lat, Lng', '±m', 'Inside boundary', 'Notes'], out.points.map((p) => [
          esc(p.name), esc(p.type), `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`, p.accuracyM ?? '—',
          p.insideActiveBoundary === null ? '—' : p.insideActiveBoundary ? 'yes' : '<b>no</b>',
          `<span class="t-xs">${esc(p.warnings.join('; '))}</span>`]))}`;
    } catch (e) {
      box.innerHTML = `<p class="t-sm" style="color:var(--danger, #c0392b)">${esc(e.message)}${e.detail ? ` — ${esc(e.detail)}` : ''}</p>`;
    }
  },
  showDistances: async () => {
    const d = await quad.campusDistances(S.locCampus);
    const ready = d.rows.filter((r) => r.estimate);
    modal(`Distances · ${d.campus.name}`, `
      <p class="t-xs faint">${esc(d.basis)}${d.boundaryConfirmed ? '' : ' No boundary is confirmed yet, so no delivery is possible.'}</p>
      ${table(['Cafeteria', 'Pickup point', 'Ready'], d.vendors.map((v) => [esc(v.name), esc(v.pickupName || '—'),
        v.pickupReady ? '<span class="badge badge-open">yes</span>' : '<span class="badge badge-warn">not yet</span><div class="t-xs faint">needs a confirmed pickup point with GPS</div>']))}
      <h3 class="t-label" style="margin-top:12px">Estimates (${ready.length})</h3>
      ${ready.length ? table(['From', 'To', 'Distance', 'Estimate', 'Inside boundary', 'Deliverable'], ready.map((r) => [
        esc(r.vendor), esc(r.point), `${r.metres} m`, esc(r.estimate),
        r.insideActiveBoundary === null ? '—' : r.insideActiveBoundary ? 'yes' : '<b>no</b>', r.deliverable ? 'yes' : 'no']))
        : `<p class="t-sm muted">No estimate yet. ${d.pointCount ? 'Confirm each cafeteria’s pickup point with a position.' : 'No location on this campus has a recorded position yet.'}</p>`}`, DONE);
  },
  importPerimeter: () => modal('Import a walked perimeter', `
    <p class="t-sm muted">Paste the track from a GPS app (GPX track, GeoJSON line/polygon, or CSV <code>lat,lng</code>).
      It becomes a <b>proposal</b>, shown next to any existing outline. Nothing is replaced and delivery stays off until someone confirms an outline.</p>
    ${select('format', 'Format', [['', 'Detect automatically'], ['gpx', 'GPX'], ['geojson', 'GeoJSON'], ['csv', 'CSV']])}
    <label class="field"><span class="t-label">Track</span><textarea class="input" name="text" rows="6"></textarea></label>
    <label class="field"><span class="t-label">Or choose a file</span><input class="input" type="file" name="file" accept=".gpx,.csv,.json,.geojson,text/*"></label>
    ${field('name', 'Name', 'Walked perimeter')}
    ${select('collectionMethod', 'Collected by', [['gps_walk', 'Walking the perimeter with GPS'], ['survey', 'Survey'], ['official_map', 'Official map']])}
    ${textarea('sourceNote', 'How it was collected', 'e.g. walked the fence line on 21 Sep with GPS Logger, 1 s interval, phone held outdoors.')}
    <div class="row" style="gap:8px;margin:8px 0"><button type="button" class="btn btn-secondary btn-sm" data-act="previewPerimeter">Preview and compare</button></div>
    <div data-preview></div>`,
    async (d, form) => {
      const out = await quad.importPerimeter(S.locCampus, { format: d.format || undefined, text: await fileOrText(form),
        name: d.name, collectionMethod: d.collectionMethod, sourceNote: d.sourceNote });
      toast('Saved as a proposal. Compare it before confirming.');
      return out;
    }),
  previewPerimeter: async (t) => {
    const form = t.closest('form');
    const box = form.querySelector('[data-preview]');
    try {
      const d = Object.fromEntries(new FormData(form));
      const out = await quad.importPerimeter(S.locCampus, { format: d.format || undefined, text: await fileOrText(form),
        name: d.name, collectionMethod: d.collectionMethod, sourceNote: d.sourceNote || 'preview only, not stored', dryRun: true });
      box.innerHTML = `
        <p class="t-sm">${out.stats.trackPoints} track points → ${out.stats.vertices} vertices · about ${out.metrics.widthM} × ${out.metrics.heightM} m ·
          ${(out.metrics.areaM2 / 4046.86).toFixed(1)} acres · closing gap ${out.stats.closingGapM} m</p>
        ${out.warnings.map((w) => `<p class="t-xs" style="color:var(--warn)">${esc(w)}</p>`).join('')}
        ${out.comparisons.length ? table(['Compared with', 'Status', 'Overlap', 'Largest deviation', 'Area (new / existing)'], out.comparisons.map((c) => [
          esc(c.withName), esc(c.withStatus), `${c.overlapPct}%`, `${c.maxDeviationM} m`,
          `${Math.round(c.areaM2.a / 4046.86 * 10) / 10} / ${Math.round(c.areaM2.b / 4046.86 * 10) / 10} acres`])) : '<p class="t-sm muted">No existing outline to compare with.</p>'}
        ${outlineSvg(out.polygon)}`;
    } catch (e) {
      box.innerHTML = `<p class="t-sm" style="color:var(--danger, #c0392b)">${esc(e.message)}${e.detail ? ` — ${esc(e.detail)}` : ''}</p>`;
    }
  },
  compareBoundary: async (t) => {
    const c = await quad.compareBoundary(t.dataset.id, t.dataset.with);
    modal(`${c.a.name} vs ${c.b.name}`, `
      <div class="row" style="gap:16px;flex-wrap:wrap;align-items:flex-start">
        ${overlaySvg(c.a.polygon, c.b.polygon)}
        <div class="stack" style="gap:6px;min-width:200px">
          <p class="t-sm"><span style="color:var(--accent)">■</span> ${esc(c.a.name)} (${esc(c.a.status)})<br>
            <span style="color:var(--text-2)">▭</span> ${esc(c.b.name)} (${esc(c.b.status)})</p>
          <p class="t-sm">Overlap <b>${c.overlapPct}%</b> · largest deviation <b>${c.maxDeviationM} m</b></p>
          <p class="t-xs">Only in ${esc(c.a.name)}: ${Math.round(c.areaM2.onlyInA)} m²<br>Only in ${esc(c.b.name)}: ${Math.round(c.areaM2.onlyInB)} m²</p>
          <p class="t-xs faint">${esc(c.method)}</p>
        </div>
      </div>
      <h3 class="t-label" style="margin-top:12px">Locations that would change sides</h3>
      ${c.locationsThatChangeSides.length ? table(['Location', `Inside ${c.a.name}`, `Inside ${c.b.name}`], c.locationsThatChangeSides.map((x) =>
        [esc(x.name), x.inA ? 'yes' : '<b>no</b>', x.inB ? 'yes' : '<b>no</b>'])) : '<p class="t-sm muted">None of the recorded locations change sides.</p>'}
      <h3 class="t-label" style="margin-top:12px">Corners of ${esc(c.a.name)} outside ${esc(c.b.name)}</h3>
      ${c.verticesOfAOutsideB.length ? table(['#', 'Lat, Lng', 'Distance to other edge'], c.verticesOfAOutsideB.map((v) =>
        [String(v.index + 1), `${v.lat}, ${v.lng}`, `${v.metresToOtherEdge} m`])) : '<p class="t-sm muted">None.</p>'}`, DONE);
  },

  retireBoundary: (t) => {
    if (!confirm('Discard this proposed outline? It is kept on record as retired.')) return;
    return act(t, () => quad.retireBoundary(t.dataset.id), { ok: 'Outline discarded', after: route });
  },

  /* ---- support ---- */
  openCase: async (t) => {
    const k = await quad.supportCase(t.dataset.id);
    modal(`${k.case.code} — ${k.case.subject}`, `
      ${k.context ? `<div class="sunken">
        <div class="rowmuted">Order: ${esc(k.context.order.code)} · ${esc(k.context.order.state)}</div>
        <div class="rowmuted">Cafeteria: ${esc(k.context.order.vendor_name)}</div>
        <div class="rowmuted">Payment: ${k.context.payment
          ? `${esc(k.context.payment.status)} · ${rupees(k.context.payment.amount_paise)}` : 'none'}</div>
        <div class="rowmuted">Destination: ${esc(k.context.order.destination || 'pickup')}</div>
        <div class="rowmuted">Partner: ${esc(k.context.order.partner_name || 'none assigned')}</div>
      </div>` : ''}
      <div class="stack" style="margin-top:12px">
        ${k.messages.map((m) => `<div class="rowmuted"><b class="t-xs">${esc(m.author_name)}</b>
          <div class="t-sm">${esc(m.body)}</div></div>`).join('')}
      </div>
      <label class="field"><span class="t-label">Reply</span>
        <textarea class="input" name="body" rows="3"></textarea></label>
      ${k.context?.payment?.status === 'paid' ? `
        <p class="t-xs faint">A refund can be issued from the order once you have replied.</p>` : ''}`,
      (d) => d.body ? quad.supportReply(k.case.id, d.body) : Promise.resolve(true));
  },

  inspectOrder: async (t) => {
    const o = await quad.order(t.dataset.id);
    modal(`Order ${o.order.code}`, `
      <div class="sunken">
        ${o.items.map((i) => `<div class="kot-line"><span>${i.qty}× ${esc(i.name_snapshot)}</span>
          <span class="money">${rupees(i.line_paise)}</span></div>`).join('')}
        <div class="kot-line"><b>Total</b><b class="money">${rupees(o.order.total_paise)}</b></div>
      </div>
      <div class="rowmuted">State: ${esc(ORDER_LABEL[o.order.state] || o.order.state)}</div>
      <div class="rowmuted">Payment: ${o.payment ? esc(o.payment.status) : 'none'}</div>
      <h3 class="t-label" style="margin-top:12px">Event history</h3>
      ${o.events.map((e) => `<div class="rowmuted">${when(e.at)} — ${esc(e.to_state)}
        ${e.actor_name ? `by ${esc(e.actor_name)}` : ''}${e.note ? ` · ${esc(e.note)}` : ''}</div>`).join('')}
      ${o.payment?.status === 'paid' ? `
        <button type="button" class="btn btn-danger btn-sm" data-act="refund"
                data-id="${o.order.id}" style="margin-top:12px">Refund this order</button>` : ''}`,
      DONE);
  },

  refund: async (t) => {
    const reason = prompt('Refund reason (recorded in the audit log):');
    if (!reason) return;
    const out = await act(t, () => quad.refund(t.dataset.id, reason), { ok: 'Refund issued' });
    closeModal();
    if (out && ['orders', 'order'].includes(S.route)) route();
  },

  /* ---- platform ---- */
  flag: (t) => act(t, () => quad.setFlag(t.dataset.k, t.dataset.v === '1'), { after: route }),
  /* ---------- gateway reconciliation -------------------------------------
     Importing is safe to press twice: every layer of the idempotency is on
     the individual settlement line, so a second run applies nothing. */
  reconcileNow: (t) => act(t, () => quad.reconcileNow(), { ok: 'Settlement import finished',
                                                          after: route }),
  resolveRecon: async (t) => {
    const note = prompt('What did you find, and what did you do about it? ' +
                        'This is recorded against your name. Resolving records a judgement; ' +
                        'it does not apply a fee or move any money.');
    if (!note) return;
    await act(t, () => quad.resolveReconException(t.dataset.id, note),
              { ok: 'Difference resolved', after: route });
  },

  /* ---------- settlement ------------------------------------------------- */
  openBatch: async (t) => {
    const d = await quad.payoutBatch(t.dataset.id);
    const b = d.batch;
    const canApprove = b.state === 'open';
    const canRelease = b.state === 'approved' && d.counts.pending > 0;
    modal(`Settlement — ${b.period_key || 'manual batch'}`, `
      <p class="t-sm muted">
        ${esc(b.note || '')} Built ${when(b.created_at)}${
          b.approved_by_name ? `, approved by ${esc(b.approved_by_name)}` : ''}.
      </p>
      <div class="grid-kpi" style="margin:10px 0">
        ${kpi('Total', rupees(d.totalPaise), `${d.payouts.length} payee(s)`)}
        ${kpi('Pending', String(d.counts.pending), 'not yet paid')}
        ${kpi('Paid', String(d.counts.paid), '')}
      </div>
      ${table(['Payee', 'Sales', 'Commission', 'Refunds', 'Adj.', 'Payout', 'State'],
        d.payouts.map((p) => [
          esc(p.vendor_name || p.partner_name || '—'),
          p.gross_food_sales_paise == null ? '—' : rupees(p.gross_food_sales_paise),
          p.statement_commission_paise == null ? '—' : rupees(p.statement_commission_paise),
          p.refunds_paise == null ? '—' : rupees(p.refunds_paise),
          p.adjustments_paise == null ? '—' : rupees(p.adjustments_paise),
          `<b>${rupees(p.amount_paise)}</b>`,
          esc(p.state),
        ]))}
      ${d.counts.withoutDestination && d.provider.configured ? `
        <p class="t-xs faint">${d.counts.withoutDestination} payee(s) have no fund account
        with the payout provider and cannot be paid automatically.</p>` : ''}
      ${d.provider.configured ? '' : `
        <p class="t-xs faint">${esc(d.provider.blocker)}</p>`}
      <div class="row" style="gap:8px;margin-top:12px">
        ${canApprove ? `<button type="button" class="btn btn-primary btn-sm"
           data-act="approveBatch" data-id="${b.id}">Approve</button>` : ''}
        ${canRelease ? `<button type="button" class="btn btn-primary btn-sm"
           data-act="releaseBatch" data-id="${b.id}">Release</button>` : ''}
      </div>`,
      /* Read-only review: the buttons act, Save just closes. */
      async () => {});
  },

  approveBatch: async (t) => {
    await act(t, async () => {
      await quad.approveBatch(t.dataset.id);
      toast('Approved — no money has moved yet');
      closeModal(); route();
    });
  },

  releaseBatch: async (t) => {
    await act(t, async () => {
      const out = await quad.releaseBatch(t.dataset.id);
      toast(out.mode === 'manual_bank_transfer'
        ? `${rupees(out.totalPaise)} to transfer by hand — nothing was sent`
        : `${out.released} payout(s) released`);
      closeModal(); route();
    });
  },

  editSchedule: async () => {
    const cfg = await quad.settlementSchedule();
    modal('Settlement schedule', `
      <p class="t-sm muted">
        Batches are calculated from the ledger at these times and wait for your approval.
        Releasing money is always a separate, deliberate step.
      </p>
      <label class="field"><span>Timezone</span>
        <input class="input" name="timezone" value="${esc(cfg.timezone)}" required></label>
      <label class="field"><span>Cafeterias — hour (0-23)</span>
        <input class="input" name="cafHour" type="number" min="0" max="23"
               value="${cfg.cafeteria.hour}" required></label>
      <label class="field"><span>Cafeterias — minute</span>
        <input class="input" name="cafMinute" type="number" min="0" max="59"
               value="${cfg.cafeteria.minute}"></label>
      <label class="field"><span>Partners — day</span>
        <select class="input" name="partnerWeekday">
          ${WEEKDAY.map((d, i) =>
            `<option value="${i}" ${i === cfg.partner.weekday ? 'selected' : ''}>${d}</option>`)
            .join('')}
        </select></label>
      <label class="field"><span>Partners — hour (0-23)</span>
        <input class="input" name="partnerHour" type="number" min="0" max="23"
               value="${cfg.partner.hour}" required></label>
      <p class="t-xs faint">${esc(cfg.note)}</p>`,
      async (d) => {
        await quad.setSettlementSchedule({
          timezone: d.timezone,
          cafeteria: { hour: Number(d.cafHour), minute: Number(d.cafMinute || 0) },
          partner: { weekday: Number(d.partnerWeekday), hour: Number(d.partnerHour), minute: 0 },
        });
        toast('Schedule saved');
        route();
      });
  },

  /* ---------- finance ---------------------------------------------------- */
  editPricing: async () => {
    const live = (await quad.pricing()).live.find((p) => !p.vendor_id) || {};
    modal('Commercial terms', `
      <p class="t-sm muted">
        These apply to orders placed from now on. Every order already placed keeps the
        terms it was priced under, so changing this never rewrites history.
      </p>
      <label class="field"><span>Commission (basis points, 200 = 2%)</span>
        <input class="input" name="commissionBps" type="number" min="0" max="10000"
               value="${live.commission_bps ?? 0}" required></label>
      <label class="field"><span>Commission treatment</span>
        <select class="input" name="commissionMode">
          <option value="deduct_from_cafeteria"
            ${live.commission_mode !== 'charge_to_customer' ? 'selected' : ''}>
            Deducted from the cafeteria (customer pays ₹100, cafeteria receives ₹98)</option>
          <option value="charge_to_customer"
            ${live.commission_mode === 'charge_to_customer' ? 'selected' : ''}>
            Added to the customer (customer pays ₹102, cafeteria receives ₹100)</option>
        </select></label>
      <label class="field"><span>Platform fee, flat (paise)</span>
        <input class="input" name="platformFeeFlatPaise" type="number" min="0"
               value="${live.platform_fee_flat_paise ?? 0}"></label>
      <label class="field"><span>Platform fee, proportional (basis points)</span>
        <input class="input" name="platformFeeBps" type="number" min="0" max="10000"
               value="${live.platform_fee_bps ?? 0}"></label>
      <label class="field"><span>Delivery charged to the customer (paise)</span>
        <input class="input" name="deliveryFeePaise" type="number" min="0"
               value="${live.delivery_fee_paise ?? 0}"></label>
      <label class="field"><span>Delivery earning paid to the partner (paise)</span>
        <input class="input" name="deliveryEarningPaise" type="number" min="0"
               value="${live.delivery_earning_paise ?? 0}"></label>
      <label class="field"><span>Higher earning on a bigger order (paise)</span>
        <input class="input" name="deliveryEarningHighPaise" type="number" min="0"
               value="${live.delivery_earning_high_paise ?? ''}"
               placeholder="leave both empty for one flat earning"></label>
      <label class="field"><span>Food subtotal at which the higher earning starts (paise)</span>
        <input class="input" name="deliveryEarningThresholdPaise" type="number" min="0"
               value="${live.delivery_earning_threshold_paise ?? ''}"
               placeholder="e.g. 30000 for ₹300"></label>
      <label class="field"><span>Tax on food (basis points)</span>
        <input class="input" name="taxBps" type="number" min="0" max="10000"
               value="${live.tax_bps ?? 0}"></label>`,
      async (d) => {
        await quad.setPricing({
          commissionBps: Number(d.commissionBps), commissionMode: d.commissionMode,
          platformFeeFlatPaise: Number(d.platformFeeFlatPaise),
          platformFeeBps: Number(d.platformFeeBps),
          deliveryFeePaise: Number(d.deliveryFeePaise),
          deliveryEarningPaise: Number(d.deliveryEarningPaise),
          /* Both or neither. Passed through as typed - empty means "no
             tier", and the server refuses one without the other rather than
             quietly keeping half a rule. */
          deliveryEarningHighPaise: d.deliveryEarningHighPaise,
          deliveryEarningThresholdPaise: d.deliveryEarningThresholdPaise,
          taxBps: Number(d.taxBps),
        });
        toast('New terms take effect on the next order');
        route();
      });
  },

  buildBatch: async (t) => {
    await act(t, async () => {
      const out = await quad.buildPayoutBatch({ kind: t.dataset.kind });
      toast(out.payouts.length
        ? `${out.payouts.length} payout(s) queued, ${rupees(out.totalPaise)}`
        : 'Nothing outstanding to settle');
      route();
    });
  },

  /* Deliberately not called "mark as paid". The administrator makes the
     transfer in their bank and enters its reference; the server refuses
     without one, and so does the database. */
  recordPayout: async (t) => {
    modal(`Record a transfer of ${rupees(Number(t.dataset.amt))}`, `
      <p class="t-sm muted">
        Make the transfer from your bank first. This records what you did — it does not
        move any money itself, and nothing is marked settled without the bank's reference.
      </p>
      <label class="field"><span>Bank reference (UTR)</span>
        <input class="input" name="reference" required minlength="4"></label>`,
      async (d) => {
        await quad.recordPayout(t.dataset.id, d.reference);
        toast('Settlement recorded');
        route();
      });
  },

  adjust: async (t) => {
    modal(`Adjust ${t.dataset.name}`, `
      <p class="t-sm muted">
        A correction is posted to the ledger with its reason, never as an edit. A negative
        amount deducts from what this cafeteria is owed; a positive one credits it.
      </p>
      <label class="field"><span>Amount (paise, may be negative)</span>
        <input class="input" name="amountPaise" type="number" required></label>
      <label class="field"><span>Reason</span>
        <input class="input" name="reason" required minlength="4"></label>`,
      async (d) => {
        await quad.adjustment({ vendorId: t.dataset.vendor,
                                amountPaise: Number(d.amountPaise), reason: d.reason });
        toast('Adjustment posted');
        route();
      });
  },

  saveConfig: async (t) => {
    const fee = document.getElementById('cfg-fee').value;
    const payout = document.getElementById('cfg-payout').value;
    await act(t, async () => {
      if (fee !== '') await quad.setConfig('delivery_fee_paise', Math.round(Number(fee) * 100));
      if (payout !== '') await quad.setConfig('partner_payout_pct', Number(payout));
    }, { ok: 'Saved' });
  },

  auditFilter: () => paintAudit(document.getElementById('audit-q').value.trim()),
};

async function locationModal(id, parentId) {
  /* Editing starts from what is stored. A blank form here used to overwrite
     the name and flags with empty values. */
  let n = {};
  if (id) {
    const tree = (await quad.campusTree(S.locCampus)).nodes;
    n = tree.find((x) => x.id === id) || {};
  }
  const KIND_OPTS = [['zone', 'Zone'], ['building', 'Building / Block'], ['floor', 'Floor'], ['room', 'Room'], ['spot', 'Spot / other point']];
  const m = modal(id ? `Edit ${n.name || 'location'}` : 'Add location', `
    ${field('name', 'Name', n.name)}
    <label class="field"><span class="t-label">Kind</span>
      <select class="input" name="kind">${KIND_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    ${field('detail', 'Short description shown to students (optional)', n.detail)}
    ${field('instructions', 'Handover note for the delivery partner (optional)', n.instructions)}
    ${field('aliases', 'Other names students use (comma separated)', (n.aliases || []).join(', '))}
    ${select('placeType', 'Type of place', PLACE_TYPE_OPTS)}
    <div class="formrow">${field('lat', 'Latitude (only if measured)', n.lat ?? '')}${field('lng', 'Longitude (only if measured)', n.lng ?? '')}</div>
    <div class="formrow">${field('gpsAccuracyM', 'GPS accuracy (m)', n.gps_accuracy_m ?? '')}
      <label class="field"><span class="t-label">&nbsp;</span>
        <button type="button" class="btn btn-secondary" data-act="useDeviceGps">Use this phone's GPS here</button></label></div>
    <p class="t-xs faint" data-gps-status></p>
    ${select('verificationMethod', 'How the position was established', METHOD_OPTS)}
    ${field('sourceNote', 'Source of this information', n.source_note || '')}
    ${check('deliverable', 'Orders can be delivered here', id ? n.deliverable : true)}
    ${check('deliveryEnabled', 'Delivery currently available', id ? n.delivery_enabled : true)}
    <p class="t-xs faint">
      Add only places you have verified. Leave coordinates blank unless they were
      measured on site or taken from a reliable map; a guessed coordinate is
      worse than none.
    </p>`,
    (d) => {
      if (!String(d.name || '').trim()) throw new Error('Give the location a name');
      const hasLat = String(d.lat).trim() !== '', hasLng = String(d.lng).trim() !== '';
      if (hasLat !== hasLng) throw new Error('Enter both latitude and longitude, or neither');
      if (hasLat && !d.verificationMethod) throw new Error('Say how the position was established');
      const body = {
        name: d.name.trim(), kind: d.kind, detail: d.detail || null, instructions: d.instructions || null,
        aliases: splitList(d.aliases), deliverable: !!d.deliverable, deliveryEnabled: !!d.deliveryEnabled,
        lat: hasLat ? Number(d.lat) : null, lng: hasLng ? Number(d.lng) : null, sourceNote: d.sourceNote || null,
        placeType: d.placeType || null, verificationMethod: d.verificationMethod || null,
        gpsAccuracyM: String(d.gpsAccuracyM ?? '').trim() === '' ? null : Number(d.gpsAccuracyM),
      };
      if (!id) { body.parentId = parentId || null; body.campusSiteId = S.locCampus; }
      return id ? quad.updateLocation(id, body) : quad.createLocation(body);
    });
  m.querySelector('select[name=kind]').value = n.kind || (parentId ? 'building' : 'zone');
  m.querySelector('select[name=placeType]').value = n.place_type || '';
  m.querySelector('select[name=verificationMethod]').value = n.verification_method || '';
}

/* A chosen file wins over pasted text; both are read in the browser and sent
   as text - nothing is uploaded to storage. */
async function fileOrText(form) {
  const f = form.querySelector('input[type=file]')?.files?.[0];
  if (f) {
    if (f.size > 5_000_000) throw new Error('That file is larger than 5 MB');
    return f.text();
  }
  const text = form.querySelector('textarea[name=text]')?.value || '';
  if (!text.trim()) throw new Error('Paste the file contents or choose a file');
  return text;
}

const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/* ========================================================================
   WEBSITE CUSTOMIZATION — the public website's content and look

   One shared draft on the server, edited here and previewed live in a frame
   of the real website. Nothing on this page changes what visitors see until
   Publish: that is a server call that re-validates the draft and makes it a
   new version in one transaction. Every control maps to an allowlisted
   field the server checks; there is no free CSS, HTML or script anywhere.
   ======================================================================== */
const W = {
  data: null,        // GET /admin/site
  config: null,      // the working copy being edited
  saved: null,       // JSON of the draft as last saved, for "unsaved changes"
  revision: 0,
  tab: 'theme',
  problems: [],
  previewRoute: 'welcome',
  previewWidth: 'mobile',
  vendors: null,
  items: null,       // id -> { id, vendorId, vendorName, name, pricePaise, veg, available, photoAsset }
  limits: null,      // /assets/limits
  busy: false,
};
const W_TABS = [
  ['theme', 'Brand & theme'], ['hero', 'Landing hero'], ['home', 'Homepage sections'],
  ['featured', 'Featured cafés & dishes'], ['banners', 'Banners'], ['announcement', 'Announcement bar'],
  ['footer', 'Footer & contact'], ['seo', 'Title & description'], ['features', 'Show or hide'],
  ['history', 'Versions & rollback'],
];
const SECTION_LABEL = {
  featured: 'Featured cafés & dishes', banners: 'Promotional banners', cafes: 'Cafés on this campus',
  ask: 'Ask ECHO ECHO', reorder: 'Order again', pickup: 'Self pickup', deliver: 'Deliver with ECHO ECHO',
};
const SHIPPED_THEME = { accent: '#C8425F', background: '#FAF7F3', surface: '#FFFFFF', text: '#1A1416', textSecondary: '#3D3134', border: '#E9E1DA' };
const ROUTE_LABEL = { home: 'Home', cafes: 'Cafés', deliver: 'Deliver with ECHO ECHO', ai: 'Ask ECHO ECHO', orders: 'Orders',
  profile: 'Profile', signin: 'Sign in (Student / Employee)', 'ob-college': 'Student sign-in', cart: 'Cart' };

const getPath = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function setPath(o, path, v) {
  const ks = path.split('.'); const last = ks.pop();
  const parent = ks.reduce((x, k) => x[k], o);
  parent[last] = v;
}
const wDirty = () => W.config && JSON.stringify(W.config) !== W.saved;
const canEdit = () => !!W.data?.can.edit;
const canPublish = () => !!W.data?.can.publish;

async function scrWebsite() {
  setTitle('Website Customization', 'Edit the public website’s words, images, sections and colours. Visitors see a change only after it is published.');
  head().innerHTML = '';
  await panel(view(), async () => {
    const [d, limits] = await Promise.all([quad.adminSite(), W.limits ? W.limits : quad.assetLimits().catch(() => null)]);
    return { d, limits };
  }, ({ d, limits }) => {
    W.data = d; W.limits = limits;
    W.config = structuredClone(d.draft.config);
    W.saved = JSON.stringify(d.draft.config);
    W.revision = d.draft.revision;
    W.problems = [];
    return `<div class="wz" id="wz">
      <nav class="wz-tabs" aria-label="Website settings">${W_TABS.map(([k, l]) => `
        <button type="button" class="wz-tab" data-act="wzTab" data-tab="${k}" ${W.tab === k ? 'aria-current="true"' : ''}>${esc(l)}</button>`).join('')}
      </nav>
      <section class="wz-edit card" aria-label="Editor">
        <div class="wz-status" id="wz-status"></div>
        <div id="wz-problems"></div>
        <div id="wz-form" class="wz-form"></div>
      </section>
      <section class="wz-preview card" aria-label="Live preview">
        <div class="wz-preview-bar">
          <select class="input input-sm" data-wz-route aria-label="Preview screen">
            ${[['welcome', 'Landing page'], ['home', 'Home'], ['signin', 'Student / Employee'], ['cafes', 'Cafés'], ['deliver', 'Deliver with ECHO ECHO']]
              .map(([r, l]) => `<option value="${r}" ${W.previewRoute === r ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <div class="seg" role="group" aria-label="Preview width">
            <button type="button" class="seg-btn" data-act="wzWidth" data-w="mobile" aria-pressed="${W.previewWidth === 'mobile'}">Phone</button>
            <button type="button" class="seg-btn" data-act="wzWidth" data-w="desktop" aria-pressed="${W.previewWidth === 'desktop'}">Desktop</button>
          </div>
          <span class="wz-preview-tag">Draft preview · not public</span>
        </div>
        <div class="wz-frame-wrap ${W.previewWidth}"><iframe id="wz-frame" title="Preview of the website with this draft"
          src="/web/?site-preview=1" loading="eager"></iframe></div>
      </section>
    </div>`;
  }, { label: 'Loading website settings' });
  if (!W.data) return;
  wzHeadActions();
  wzStatus();
  await wzPaintForm();
  wzBindOnce();
}

function wzHeadActions() {
  head().innerHTML = `
    <button type="button" class="btn btn-ghost btn-sm" data-act="wzDiscard" ${canEdit() ? '' : 'disabled'}>Discard changes</button>
    <button type="button" class="btn btn-ghost btn-sm" data-act="wzReset" ${canEdit() ? '' : 'disabled'}>Reset to last published</button>
    <button type="button" class="btn btn-secondary btn-sm" data-act="wzSave" ${canEdit() ? '' : 'disabled'}>Save draft</button>
    <button type="button" class="btn btn-primary btn-sm" data-act="wzPublish" ${canPublish() ? '' : 'disabled title="Needs the website.publish permission"'}>Publish changes</button>`;
}

function wzStatus() {
  const box = document.getElementById('wz-status');
  if (!box || !W.data) return;
  const d = W.data;
  const live = d.live;
  box.innerHTML = `
    <span class="wz-pill ${wDirty() ? 'warn' : 'ok'}">${wDirty() ? 'Unsaved changes' : 'All changes saved'}</span>
    <span>${W.revision ? `Draft revision ${W.revision}${d.draft.updatedAt ? `, saved ${when(d.draft.updatedAt)}${d.draft.updatedBy ? ` by ${esc(d.draft.updatedBy)}` : ''}` : ''}` : 'No draft saved yet'}</span>
    <span>${live ? `Live: version ${live.version}, published ${when(live.publishedAt)}${live.publishedBy ? ` by ${esc(live.publishedBy)}` : ''}` : 'Live: the built-in website (nothing published yet)'}</span>
    ${!canEdit() ? '<span class="wz-pill">Read only: you do not have website.customize</span>' : ''}`;
}

function wzProblems() {
  const box = document.getElementById('wz-problems');
  if (!box) return;
  box.innerHTML = W.problems.length ? `<div class="wz-problems" role="alert"><b>Fix these before saving:</b><ul>${
    W.problems.map((p) => `<li><code>${esc(p.path)}</code> ${esc(p.problem)}</li>`).join('')}</ul></div>` : '';
  document.querySelectorAll('[data-path]').forEach((i) => {
    const bad = W.problems.some((p) => p.path === i.dataset.path || p.path.startsWith(`${i.dataset.path}.`));
    i.classList.toggle('is-invalid', bad);
    i.setAttribute('aria-invalid', String(bad));
  });
}

/* ---------- field builders ---------------------------------------------- */
const ro = () => (canEdit() ? '' : 'disabled');
const wText = (path, label, { max = 120, area = false, hint = '' } = {}) => {
  const v = getPath(W.config, path) ?? '';
  return `<label class="field"><span class="t-label">${esc(label)} <span class="wz-count" data-count-for="${path}">${String(v).length}/${max}</span></span>
    ${area ? `<textarea class="input" rows="3" maxlength="${max}" data-path="${path}" ${ro()}>${esc(v)}</textarea>`
      : `<input class="input" maxlength="${max}" data-path="${path}" value="${esc(v)}" ${ro()}>`}
    ${hint ? `<span class="t-xs faint">${esc(hint)}</span>` : ''}</label>`;
};
const wBool = (path, label, hint = '') => `<label class="wz-switch"><input type="checkbox" data-path="${path}" ${getPath(W.config, path) ? 'checked' : ''} ${ro()}>
  <span class="grow"><span class="t-sm t-strong">${esc(label)}</span>${hint ? `<span class="t-xs faint" style="display:block">${esc(hint)}</span>` : ''}</span></label>`;
const wSelect = (path, label, options, { allowNull = false } = {}) => {
  const v = getPath(W.config, path);
  return `<label class="field"><span class="t-label">${esc(label)}</span>
    <select class="input" data-path="${path}" ${allowNull ? 'data-null="1"' : ''} ${ro()}>
      ${allowNull ? `<option value="" ${v == null ? 'selected' : ''}>Website default</option>` : ''}
      ${options.map(([val, l]) => `<option value="${esc(val)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}
    </select></label>`;
};
const wColor = (key, label) => {
  const path = `theme.${key}`;
  const v = getPath(W.config, path);
  const shown = v || SHIPPED_THEME[key];
  return `<div class="wz-color">
    <span class="t-label">${esc(label)}</span>
    <div class="row g2">
      <input type="color" class="wz-swatch" data-color-for="${path}" value="${esc(shown.toLowerCase())}" aria-label="${esc(label)} colour picker" ${ro()}>
      <input class="input wz-hex" data-path="${path}" data-null="1" value="${esc(v || '')}" placeholder="${esc(SHIPPED_THEME[key])}" title="Empty means the website's own colour" maxlength="7" aria-label="${esc(label)} hex value" ${ro()}>
      <button type="button" class="btn btn-ghost btn-sm" data-act="wzClear" data-path="${path}" ${v ? '' : 'disabled'} ${ro()}>Reset</button>
    </div></div>`;
};
const wNumber = (path, label, min, max) => {
  const v = getPath(W.config, path);
  return `<label class="field"><span class="t-label">${esc(label)} <span class="t-xs faint">${min}–${max} px, empty for default</span></span>
    <input class="input" type="number" min="${min}" max="${max}" step="1" data-path="${path}" data-null="1" data-int="1" value="${v ?? ''}" ${ro()}></label>`;
};
const linkOptions = (path, label, { allowEmpty = true } = {}) => {
  const v = getPath(W.config, path) || '';
  const internal = Object.entries(ROUTE_LABEL).map(([r, l]) => [`#/${r}`, l]);
  const custom = v && !internal.some(([x]) => x === v);
  return `<label class="field"><span class="t-label">${esc(label)}</span>
    <select class="input" data-link-select="${path}" ${ro()}>
      ${allowEmpty ? `<option value="" ${!v ? 'selected' : ''}>No link</option>` : ''}
      ${internal.map(([x, l]) => `<option value="${esc(x)}" ${v === x ? 'selected' : ''}>Website: ${esc(l)}</option>`).join('')}
      <option value="__custom" ${custom ? 'selected' : ''}>Another address (https:// or mailto:)</option>
    </select>
    <input class="input" data-path="${path}" value="${esc(custom ? v : '')}" placeholder="https://…" ${custom ? '' : 'hidden'} ${ro()}></label>`;
};
function wImage(path, label, hint) {
  const id = getPath(W.config, path);
  return `<div class="wz-image" data-image-for="${path}">
    <span class="t-label">${esc(label)}</span>
    <div class="row g3" style="align-items:center;flex-wrap:wrap">
      <div class="wz-thumb">${id ? `<img src="${esc(quad.assetUrl(id))}" alt="">` : '<span class="t-xs faint">No image</span>'}</div>
      <div class="stack g1">
        <label class="btn btn-secondary btn-sm ${canEdit() ? '' : 'is-disabled'}">Upload<input type="file" accept="image/jpeg,image/png,image/webp" data-upload="${path}" hidden ${ro()}></label>
        ${id ? `<button type="button" class="btn btn-ghost btn-sm" data-act="wzClear" data-path="${path}" ${ro()}>Remove</button>` : ''}
      </div>
      <div class="wz-progress" data-progress-for="${path}" hidden><span></span></div>
    </div>
    <span class="t-xs faint">${esc(hint)}${W.limits ? ` JPEG, PNG or WebP, up to ${Math.round(W.limits.maxBytes / 1048576)} MB.` : ''}</span>
  </div>`;
}

/* ---------- the forms ----------------------------------------------------- */
async function wzPaintForm() {
  const box = document.getElementById('wz-form');
  if (!box) return;
  const c = W.config;
  const opt = W.data.options;
  const T = {
    theme: () => `
      <h2 class="wz-h">Brand</h2>
      ${wImage('brand.logoAsset', 'Logo', 'Shown in the header and footer instead of the approved artwork. Wide images work best; at least 120 px high.')}
      ${wImage('brand.faviconAsset', 'Favicon', 'The browser-tab icon. Square, at least 64 × 64 px.')}
      <h2 class="wz-h">Colours <span class="t-xs faint">applied to the light appearance; dark mode keeps its own tuned palette</span></h2>
      <div class="wz-grid2">
        ${wColor('accent', 'Primary brand colour')}${wColor('background', 'Page background')}
        ${wColor('surface', 'Cards and panels')}${wColor('border', 'Borders and dividers')}
        ${wColor('text', 'Main text')}${wColor('textSecondary', 'Secondary text')}
      </div>
      <p class="t-xs faint">Text colours are checked against the background and cards (4.5:1) and the brand colour against cards (3:1); a combination that would be hard to read is refused.</p>
      <h2 class="wz-h">Shape and type</h2>
      <div class="wz-grid2">
        ${wNumber('theme.buttonRadius', 'Button corner radius', 0, 24)}
        ${wNumber('theme.cardRadius', 'Card corner radius', 0, 28)}
        ${wSelect('theme.font', 'Typeface', opt.fonts.map((f) => [f, f]), { allowNull: true })}
        ${wSelect('theme.density', 'Spacing', opt.densities.map((x) => [x, x[0].toUpperCase() + x.slice(1)]), { allowNull: true })}
        ${wSelect('theme.appearance', 'Appearance for new visitors', [['system', 'Follow the device'], ['light', 'Light'], ['dark', 'Dark']], { allowNull: true })}
      </div>`,
    hero: () => `
      <h2 class="wz-h">Landing hero <span class="t-xs faint">the first screen a signed-out visitor sees</span></h2>
      ${wText('hero.eyebrow', 'Small line above the heading', { max: 60 })}
      ${wText('hero.heading', 'Heading', { max: 90 })}
      ${wText('hero.headingAccent', 'Highlighted end of the heading', { max: 60, hint: 'Shown in the brand colour after the heading.' })}
      ${wText('hero.body', 'Description', { max: 280, area: true })}
      ${wImage('hero.imageAsset', 'Background photograph', 'Optional. Faded behind the words so they stay readable; at least 1200 px wide.')}
      <div class="wz-grid2">
        ${wText('hero.primaryLabel', 'Main button label', { max: 40 })}
        ${linkOptions('hero.primaryLink', 'Main button opens', { allowEmpty: false })}
        ${wText('hero.secondaryLabel', 'Second button label', { max: 40, hint: 'Leave empty to hide the second button.' })}
        ${linkOptions('hero.secondaryLink', 'Second button opens')}
      </div>`,
    home: () => `
      <h2 class="wz-h">Homepage</h2>
      ${wText('home.title', 'Home page heading', { max: 90 })}
      <h2 class="wz-h">Sections <span class="t-xs faint">drag to reorder, or use the arrows; switch a section off to hide it</span></h2>
      <ol class="wz-sections" id="wz-sections">${c.home.sections.map((s, i) => `
        <li class="wz-section" draggable="${canEdit()}" data-index="${i}">
          <span class="wz-grip" aria-hidden="true">⋮⋮</span>
          <span class="grow t-sm t-strong">${esc(SECTION_LABEL[s.key] || s.key)}</span>
          <label class="wz-mini"><input type="checkbox" data-path="home.sections.${i}.visible" ${s.visible ? 'checked' : ''} ${ro()}> Shown</label>
          <button type="button" class="btn btn-ghost btn-sm" data-act="wzMove" data-list="home.sections" data-i="${i}" data-d="-1" aria-label="Move ${esc(SECTION_LABEL[s.key])} up" ${i === 0 ? 'disabled' : ''} ${ro()}>↑</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="wzMove" data-list="home.sections" data-i="${i}" data-d="1" aria-label="Move ${esc(SECTION_LABEL[s.key])} down" ${i === c.home.sections.length - 1 ? 'disabled' : ''} ${ro()}>↓</button>
        </li>`).join('')}</ol>
      <p class="t-xs faint">Active orders and the "finish your profile" reminder always stay at the top: they are a student's own business, not promotion.</p>`,
    featured: () => wzFeatured(),
    banners: () => `
      <h2 class="wz-h">Promotional banners <span class="t-xs faint">up to ${opt.limits.banners}, shown in the "Promotional banners" home section</span></h2>
      ${c.banners.map((b, i) => `
        <fieldset class="wz-card">
          <legend class="t-label">Banner ${i + 1}</legend>
          <div class="wz-grid2">
            ${wText(`banners.${i}.title`, 'Title', { max: 60 })}
            ${wText(`banners.${i}.linkLabel`, 'Button label', { max: 30 })}
          </div>
          ${wText(`banners.${i}.body`, 'Text', { max: 140, area: true })}
          ${linkOptions(`banners.${i}.link`, 'Button opens')}
          ${wImage(`banners.${i}.imageAsset`, 'Image', 'Optional, square works best.')}
          <div class="wz-grid2">
            <label class="field"><span class="t-label">Show from</span><input class="input" type="datetime-local" data-path="banners.${i}.startsAt" data-date="1" data-null="1" value="${esc(toLocalInput(b.startsAt))}" ${ro()}></label>
            <label class="field"><span class="t-label">Show until</span><input class="input" type="datetime-local" data-path="banners.${i}.endsAt" data-date="1" data-null="1" value="${esc(toLocalInput(b.endsAt))}" ${ro()}></label>
          </div>
          <div class="row g2" style="flex-wrap:wrap">
            ${wBool(`banners.${i}.active`, 'Switched on')}
            <span class="grow"></span>
            <button type="button" class="btn btn-ghost btn-sm" data-act="wzMove" data-list="banners" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} ${ro()}>↑</button>
            <button type="button" class="btn btn-ghost btn-sm" data-act="wzMove" data-list="banners" data-i="${i}" data-d="1" ${i === c.banners.length - 1 ? 'disabled' : ''} ${ro()}>↓</button>
            <button type="button" class="btn btn-ghost btn-sm danger-text" data-act="wzRemove" data-list="banners" data-i="${i}" ${ro()}>Remove banner</button>
          </div>
        </fieldset>`).join('') || '<p class="t-sm muted">No banners yet.</p>'}
      <button type="button" class="btn btn-secondary btn-sm" data-act="wzAddBanner" ${c.banners.length >= opt.limits.banners ? 'disabled' : ''} ${ro()}>Add a banner</button>`,
    announcement: () => `
      <h2 class="wz-h">Announcement bar <span class="t-xs faint">a single line under the header on every page</span></h2>
      ${wBool('announcement.enabled', 'Show the announcement bar')}
      ${wText('announcement.text', 'Message', { max: 160 })}
      ${wSelect('announcement.tone', 'Style', [['info', 'Information'], ['promo', 'Promotion'], ['alert', 'Important notice']])}
      <div class="wz-grid2">${wText('announcement.linkLabel', 'Link label', { max: 30 })}${linkOptions('announcement.link', 'Link opens')}</div>`,
    footer: () => `
      <h2 class="wz-h">Footer</h2>
      ${wText('footer.text', 'Footer line', { max: 200 })}
      <h2 class="wz-h">Footer links <span class="t-xs faint">up to ${opt.limits.footerLinks}</span></h2>
      ${c.footer.links.map((l, i) => `<div class="wz-card wz-grid2">
          ${wText(`footer.links.${i}.label`, 'Label', { max: 30 })}
          ${linkOptions(`footer.links.${i}.link`, 'Opens', { allowEmpty: false })}
          <div class="row g2"><button type="button" class="btn btn-ghost btn-sm danger-text" data-act="wzRemove" data-list="footer.links" data-i="${i}" ${ro()}>Remove link</button></div>
        </div>`).join('')}
      <button type="button" class="btn btn-secondary btn-sm" data-act="wzAddLink" ${c.footer.links.length >= opt.limits.footerLinks ? 'disabled' : ''} ${ro()}>Add a link</button>
      <h2 class="wz-h">Contact and support</h2>
      <div class="wz-grid2">
        ${wText('footer.contactEmail', 'Contact email', { max: 120 })}
        ${wText('footer.contactPhone', 'Contact phone', { max: 20 })}
      </div>
      ${linkOptions('footer.supportLink', 'Help link')}`,
    seo: () => `
      <h2 class="wz-h">Title and description <span class="t-xs faint">what a browser tab and a search result show</span></h2>
      ${wText('seo.title', 'Page title', { max: 70 })}
      ${wText('seo.description', 'Description', { max: 300, area: true })}`,
    features: () => `
      <h2 class="wz-h">Show or hide</h2>
      ${wBool('features.askEcho', 'Ask ECHO ECHO on the home page', 'The assistant itself stays available from the menu.')}
      ${wBool('features.deliverPromo', '"Deliver with ECHO ECHO" invitations', 'On the landing page, the home page and in the footer.')}
      ${wBool('features.pickupPromo', 'The self-pickup suggestion on the home page')}
      ${wBool('features.browseFirst', 'The second button on the landing page')}
      <p class="t-xs faint">These hide promotion only. Ordering, prices, opening hours and who may order are not website settings and cannot be changed here.</p>`,
    history: () => '<div id="wz-history"><p class="t-sm muted">Loading versions…</p></div>',
  };
  box.innerHTML = (T[W.tab] || T.theme)();
  wzProblems();
  if (W.tab === 'history') wzHistory();
  if (W.tab === 'featured') wzFeaturedLoad();
  wzPreview();
}

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function wzFeatured() {
  const c = W.config.featured;
  const opt = W.data.options.limits;
  const vendors = W.vendors || [];
  const items = W.items ? Object.values(W.items) : [];
  const name = (id) => vendors.find((v) => v.id === id)?.name;
  return `
    <h2 class="wz-h">Featured</h2>
    ${wText('featured.heading', 'Section heading', { max: 60 })}
    <p class="t-xs faint">A featured café appears only while it is listed on the website, and a featured dish only while its café and the dish are active: featuring never makes anything orderable.</p>
    <h2 class="wz-h">Cafés <span class="t-xs faint">${c.cafeIds.length}/${opt.featuredCafes}</span></h2>
    ${W.vendors === null ? '<p class="t-sm muted">Loading cafés…</p>' : `<div class="wz-checklist">${vendors.map((v) => `
      <label class="wz-mini"><input type="checkbox" data-feature="cafeIds" value="${v.id}" ${c.cafeIds.includes(v.id) ? 'checked' : ''}
        ${!c.cafeIds.includes(v.id) && c.cafeIds.length >= opt.featuredCafes ? 'disabled' : ''} ${ro()}> ${esc(v.name)}</label>`).join('')}</div>`}
    <h2 class="wz-h">Dishes <span class="t-xs faint">${c.itemIds.length}/${opt.featuredItems}</span></h2>
    ${c.itemIds.length ? `<ol class="wz-picked">${c.itemIds.map((id, i) => {
      const it = W.items?.[id];
      return `<li>${it ? `${esc(it.name)} <span class="t-xs faint">${esc(it.vendorName)} · ${rupees(it.pricePaise)}</span>` : `<span class="t-xs faint">Dish ${esc(id.slice(0, 8))} (not found: archived?)</span>`}
        <button type="button" class="btn btn-ghost btn-sm" data-act="wzMove" data-list="featured.itemIds" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} ${ro()}>↑</button>
        <button type="button" class="btn btn-ghost btn-sm danger-text" data-act="wzRemove" data-list="featured.itemIds" data-i="${i}" ${ro()}>Remove</button></li>`;
    }).join('')}</ol>` : '<p class="t-sm muted">No dishes featured.</p>'}
    ${W.items === null ? '<p class="t-sm muted">Loading menus…</p>' : `
    <label class="field"><span class="t-label">Add a dish</span>
      <select class="input" data-add-item ${c.itemIds.length >= opt.featuredItems ? 'disabled' : ''} ${ro()}>
        <option value="">Choose a dish…</option>
        ${vendors.map((v) => `<optgroup label="${esc(v.name)}">${items.filter((it) => it.vendorId === v.id && !c.itemIds.includes(it.id))
          .map((it) => `<option value="${it.id}">${esc(it.name)} · ${rupees(it.pricePaise)}${it.available ? '' : ' (unavailable now)'}</option>`).join('')}</optgroup>`).join('')}
      </select></label>`}
    ${c.cafeIds.length ? `<p class="t-xs faint">Featured cafés: ${c.cafeIds.map((id) => esc(name(id) || id.slice(0, 8))).join(', ')}</p>` : ''}`;
}

/* Cafés and their menus, read once, to name featured dishes and to give the
   preview the same dish details the public endpoint would. */
async function wzFeaturedLoad(force = false) {
  if (W.vendors && W.items && !force) return;
  try {
    const vs = (await quad.vendors()).vendors;
    W.vendors = vs;
    const menus = await Promise.all(vs.map((v) => quad.menu(v.id).catch(() => ({ items: [] }))));
    W.items = {};
    menus.forEach((m, i) => (m.items || []).filter((it) => it.active !== false).forEach((it) => {
      W.items[it.id] = { id: it.id, vendorId: vs[i].id, vendorName: vs[i].name, name: it.name,
        pricePaise: it.price_paise, veg: it.veg, available: it.available, photoAsset: it.photo_asset };
    }));
  } catch (e) {
    W.vendors ||= []; W.items ||= {};
    toast(explain(e), 'bad');
  }
  if (W.tab === 'featured') { document.getElementById('wz-form').innerHTML = wzFeatured(); wzProblems(); }
  wzPreview();
}

async function wzHistory() {
  const box = document.getElementById('wz-history');
  try {
    const { versions } = await quad.siteVersions();
    box.innerHTML = `
      <h2 class="wz-h">Published versions <span class="t-xs faint">every publish is kept; rolling back publishes a copy as a new version</span></h2>
      ${versions.length ? table(['Version', 'Published', 'By', 'Note', ''], versions.map((v) => [
        `<b>v${v.version}</b> ${v.live ? '<span class="badge badge-ok">live</span>' : ''}${v.kind === 'rollback' ? ` <span class="badge">rollback of v${v.rolledBackFrom}</span>` : ''}`,
        when(v.publishedAt), esc(v.publishedBy || '—'), `<span class="t-xs">${esc(v.note || '')}</span>`,
        `<div class="row g2"><button type="button" class="btn btn-ghost btn-sm" data-act="wzPreviewVersion" data-v="${v.version}">Preview</button>
          ${!v.live && canPublish() ? `<button type="button" class="btn btn-ghost btn-sm" data-act="wzRollback" data-v="${v.version}">Roll back to this</button>` : ''}</div>`,
      ])) : '<p class="t-sm muted">Nothing has been published yet. The website shows its built-in settings.</p>'}`;
  } catch (e) { box.innerHTML = ErrorState(e); }
}

/* ---------- preview --------------------------------------------------------
   The frame is the real website, told by URL that it is a preview. The draft
   reaches it only by postMessage on this origin; it is never stored or sent
   to the server by the frame. */
let previewTimer = null;
let previewOverride = null;   // a historical version being looked at
function wzPreview(now = false) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const f = document.getElementById('wz-frame');
    if (!f?.contentWindow) return;
    const cfg = previewOverride || W.config;
    const items = (cfg.featured?.itemIds || []).map((id) => W.items?.[id]).filter(Boolean);
    f.contentWindow.postMessage({ type: 'echo-site-preview', config: cfg, featuredItems: items,
      version: W.data?.live?.version || 0 }, location.origin);
  }, now ? 0 : 140);
}
const wzPreviewRoute = () => document.getElementById('wz-frame')?.contentWindow
  ?.postMessage({ type: 'echo-site-route', route: W.previewRoute }, location.origin);

let wzBound = false;
function wzBindOnce() {
  if (wzBound) return;
  wzBound = true;
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.type !== 'echo-site-preview-ready') return;
    wzPreview(true);
    setTimeout(wzPreviewRoute, 60);
  });
  root.addEventListener('input', wzOnInput);
  root.addEventListener('change', wzOnChange);
  root.addEventListener('dragstart', (e) => { const li = e.target.closest?.('.wz-section'); if (li) { e.dataTransfer.setData('text/plain', li.dataset.index); li.classList.add('dragging'); } });
  root.addEventListener('dragend', (e) => e.target.closest?.('.wz-section')?.classList.remove('dragging'));
  root.addEventListener('dragover', (e) => { if (e.target.closest?.('.wz-section')) e.preventDefault(); });
  root.addEventListener('drop', (e) => {
    const li = e.target.closest?.('.wz-section');
    if (!li || !canEdit()) return;
    e.preventDefault();
    const from = Number(e.dataTransfer.getData('text/plain'));
    const to = Number(li.dataset.index);
    if (Number.isInteger(from) && from !== to) {
      const list = W.config.home.sections;
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      wzChanged(true);
    }
  });
  window.addEventListener('beforeunload', (e) => { if (S.route === 'website' && wDirty()) { e.preventDefault(); e.returnValue = ''; } });
}

function wzValue(i) {
  if (i.type === 'checkbox') return i.checked;
  const raw = i.value.trim();
  if (i.dataset.null && raw === '') return null;
  if (i.dataset.int) { const n = Number(raw); return Number.isInteger(n) ? n : raw; }
  if (i.dataset.date) { const d = new Date(raw); return Number.isNaN(d.getTime()) ? raw : d.toISOString(); }
  if (i.classList.contains('wz-hex')) return raw.toUpperCase();
  return i.tagName === 'SELECT' && i.dataset.null && raw === '' ? null : i.value;
}

function wzOnInput(e) {
  const i = e.target;
  if (S.route !== 'website') return;
  if (i.dataset.path) {
    setPath(W.config, i.dataset.path, wzValue(i));
    const cnt = document.querySelector(`[data-count-for="${i.dataset.path}"]`);
    if (cnt) cnt.textContent = `${i.value.length}/${cnt.textContent.split('/')[1]}`;
    if (i.classList.contains('wz-hex') && /^#[0-9A-Fa-f]{6}$/.test(i.value)) {
      const sw = document.querySelector(`[data-color-for="${i.dataset.path}"]`);
      if (sw) sw.value = i.value.toLowerCase();
    }
    wzChanged(false);
  } else if (i.dataset.colorFor) {
    const v = i.value.toUpperCase();
    setPath(W.config, i.dataset.colorFor, v);
    const hex = document.querySelector(`.wz-hex[data-path="${i.dataset.colorFor}"]`);
    if (hex) hex.value = v;
    wzChanged(false);
  }
}

async function wzOnChange(e) {
  const i = e.target;
  if (S.route !== 'website') return;
  if (i.matches('[data-wz-route]')) { W.previewRoute = i.value; wzPreviewRoute(); return; }
  if (i.dataset.linkSelect) {
    const path = i.dataset.linkSelect;
    const text = i.parentElement.querySelector(`input[data-path="${path}"]`);
    if (i.value === '__custom') { text.hidden = false; text.focus(); setPath(W.config, path, text.value.trim()); }
    else { text.hidden = true; text.value = ''; setPath(W.config, path, i.value); }
    return wzChanged(false);
  }
  if (i.dataset.feature) {
    const list = W.config.featured[i.dataset.feature];
    if (i.checked && !list.includes(i.value)) list.push(i.value);
    if (!i.checked) list.splice(list.indexOf(i.value), 1);
    return wzChanged(true);
  }
  if (i.matches('[data-add-item]') && i.value) {
    W.config.featured.itemIds.push(i.value);
    return wzChanged(true);
  }
  if (i.dataset.upload) return wzUpload(i);
  if (i.dataset.path && (i.type === 'checkbox' || i.tagName === 'SELECT')) wzChanged(false);
}

/* After an edit: mark unsaved, refresh the preview, and redraw the form
   only when its structure changed (a list grew, shrank or moved). */
function wzChanged(repaint) {
  W.problems = [];
  previewOverride = null;
  wzStatus();
  wzProblems();
  if (repaint) wzPaintForm(); else wzPreview();
  refreshSiteChipDirty();
}
function refreshSiteChipDirty() {
  const chip = document.querySelector('.cc-sitechip');
  if (chip && wDirty()) chip.classList.add('is-draft');
}

/* Uploads go to the image store as `site_image` (website.customize on the
   server); the bytes are checked there by their magic number, size and
   dimensions. The checks here only save a pointless upload. */
async function wzUpload(input) {
  const file = input.files?.[0];
  const path = input.dataset.upload;
  input.value = '';
  if (!file) return;
  const allowed = W.limits?.allowedMime || ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) return toast('Choose a JPEG, PNG or WebP image.', 'bad');
  if (W.limits?.maxBytes && file.size > W.limits.maxBytes) return toast(`That image is larger than ${Math.round(W.limits.maxBytes / 1048576)} MB.`, 'bad');
  const dims = await imageSize(file).catch(() => null);
  if (!dims) return toast('That file could not be read as an image.', 'bad');
  const minimum = path === 'brand.faviconAsset' ? [64, 64] : path === 'brand.logoAsset' ? [0, 120] : path === 'hero.imageAsset' ? [1200, 0] : [200, 200];
  if (dims.width < minimum[0] || dims.height < minimum[1]) {
    return toast(`Too small: ${dims.width} × ${dims.height} px. This needs at least ${minimum[0] || 'any'} wide and ${minimum[1] || 'any'} high.`, 'bad');
  }
  if (path === 'brand.faviconAsset' && Math.abs(dims.width - dims.height) > 2) return toast('A favicon must be square.', 'bad');
  const bar = document.querySelector(`[data-progress-for="${path}"]`);
  if (bar) { bar.hidden = false; bar.firstElementChild.style.width = '0%'; }
  try {
    const out = await uploadWithProgress(file, 'site_image', (p) => { if (bar) bar.firstElementChild.style.width = `${Math.round(p * 100)}%`; });
    setPath(W.config, path, out.id);
    toast('Image uploaded. Save the draft to keep it.');
    wzChanged(true);
  } catch (e) {
    toast(explain(e), 'bad');
  } finally { if (bar) bar.hidden = true; }
}

const imageSize = (file) => new Promise((ok, bad) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { ok({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
  img.onerror = () => { bad(new Error('unreadable')); URL.revokeObjectURL(url); };
  img.src = url;
});

/* fetch() cannot report upload progress; XMLHttpRequest can. Same endpoint,
   same cookie, same error shape as the API client. */
function uploadWithProgress(file, kind, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('photo', file);
    const x = new XMLHttpRequest();
    x.open('POST', `${API_BASE}/assets/`);
    x.withCredentials = true;
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let body = null;
      try { body = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status >= 200 && x.status < 300 && body?.id) resolve(body);
      else reject(new ApiError(x.status, body || { error: 'The upload failed' }));
    };
    x.onerror = () => reject(new Error('Cannot reach the ECHO ECHO server'));
    x.send(fd);
  });
}

/* ---------- save, publish, rollback ---------------------------------------- */
async function wzSave(btn) {
  if (!canEdit()) return null;
  const out = await act(btn, async () => {
    try {
      return await quad.saveSiteDraft(W.config, W.revision);
    } catch (e) {
      if (e instanceof ApiError && e.problems) { W.problems = e.problems; wzProblems(); }
      throw e;
    }
  });
  if (!out) return null;
  W.revision = out.revision;
  W.config = structuredClone(out.config);
  W.saved = JSON.stringify(out.config);
  W.data.draft = { ...W.data.draft, revision: out.revision, updatedAt: out.updatedAt, updatedBy: session.me.user.name, config: out.config };
  W.problems = [];
  toast(`Draft saved (revision ${out.revision})`);
  wzStatus(); wzProblems(); refreshTopbar();
  return out;
}

const GROUP_LABEL = { theme: 'Colours and type', brand: 'Logo and favicon', announcement: 'Announcement bar', hero: 'Landing hero',
  home: 'Homepage sections', featured: 'Featured', banners: 'Banners', footer: 'Footer and contact', seo: 'Title and description', features: 'Show or hide' };
function changedGroups(a, b) {
  return Object.keys(GROUP_LABEL).filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])).map((k) => GROUP_LABEL[k]);
}

async function wzPublish(btn) {
  if (!canPublish()) return;
  if (wDirty()) {
    const saved = await wzSave(btn);
    if (!saved) return;
  }
  const check = await quad.validateSite(W.config).catch((e) => ({ ok: false, problems: [{ path: 'server', problem: explain(e) }] }));
  if (!check.ok) { W.problems = check.problems; wzProblems(); return toast('The draft has problems; nothing was published.', 'bad'); }
  const live = W.data.live?.config || W.data.defaults;
  const groups = changedGroups(W.config, live);
  modal('Publish the website?', `
    <p class="t-sm">Visitors will see this draft (revision ${W.revision}) as version ${(W.data.live?.version || 0) + 1}.
      Open pages pick it up within about half a minute, without reloading.</p>
    <p class="t-sm"><b>Changed since the live version:</b> ${groups.length ? groups.map(esc).join(', ') : 'nothing; this publishes the same settings again'}.</p>
    ${field('note', 'Note for the history (optional)')}
    <p class="t-xs faint">You may be asked for your password and authenticator code. The previous version stays in the history and can be restored.</p>`,
  async (d) => {
    const t0 = performance.now();
    const out = await quad.publishSite(W.revision, d.note || '');
    toast(`Published version ${out.version}. Checking the public website…`);
    measurePublic(out.version, t0);
    return out;
  });
}

/* How long until the PUBLIC endpoint, through the CDN, returns the new
   version: the number reported to the owner is measured, not promised. */
async function measurePublic(version, t0) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${API_BASE}/site/version/?t=${Date.now()}`, { credentials: 'omit', cache: 'no-store' }).then((x) => x.json());
      if (r.version >= version) {
        toast(`Version ${version} is live on the public website (${((performance.now() - t0) / 1000).toFixed(1)} s after publishing). Open pages update within 30 s.`);
        return;
      }
    } catch { /* keep trying */ }
    await new Promise((res) => setTimeout(res, 1500));
  }
  toast(`Version ${version} is published; the public endpoint had not shown it after a minute. Check System Health.`, 'bad');
}

function wzRollback(t) {
  const v = Number(t.dataset.v);
  modal(`Roll back to version ${v}?`, `
    <p class="t-sm">Version ${v}'s settings become the live website again, as a new version. Nothing is deleted, and your draft is left as it is.</p>
    ${field('note', 'Reason (kept in the history)')}`,
  (d) => quad.rollbackSite(v, d.note || '').then((out) => { toast(`Rolled back: version ${out.version} is live`); measurePublic(out.version, performance.now()); return out; }));
}

async function wzPreviewVersion(t) {
  const v = Number(t.dataset.v);
  try {
    const r = await quad.siteVersionConfig(v);
    previewOverride = r.config;
    wzPreview(true);
    toast(`Previewing version ${v}. Any edit returns the preview to your draft.`);
  } catch (e) { toast(explain(e), 'bad'); }
}

const WZ_ACTIONS = {
  wzTab: (t) => { W.tab = t.dataset.tab; previewOverride = null; document.querySelectorAll('.wz-tab').forEach((b) => b.toggleAttribute('aria-current', b === t)); return wzPaintForm(); },
  wzWidth: (t) => {
    W.previewWidth = t.dataset.w;
    document.querySelector('.wz-frame-wrap')?.classList.toggle('mobile', W.previewWidth === 'mobile');
    document.querySelector('.wz-frame-wrap')?.classList.toggle('desktop', W.previewWidth === 'desktop');
    document.querySelectorAll('[data-act="wzWidth"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.w === W.previewWidth)));
  },
  wzClear: (t) => { setPath(W.config, t.dataset.path, null); wzChanged(true); },
  wzMove: (t) => {
    const list = getPath(W.config, t.dataset.list);
    const i = Number(t.dataset.i), j = i + Number(t.dataset.d);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    wzChanged(true);
  },
  wzRemove: (t) => { getPath(W.config, t.dataset.list).splice(Number(t.dataset.i), 1); wzChanged(true); },
  wzAddBanner: () => {
    const n = W.config.banners.length + 1;
    let id = `banner-${n}`;
    while (W.config.banners.some((b) => b.id === id)) id = `banner-${Math.floor(Math.random() * 1e6)}`;
    W.config.banners.push({ id, title: 'New banner', body: '', imageAsset: null, link: '', linkLabel: '', active: false, startsAt: null, endsAt: null });
    wzChanged(true);
  },
  wzAddLink: () => { W.config.footer.links.push({ label: 'New link', link: '#/cafes' }); wzChanged(true); },
  wzDiscard: () => {
    if (!wDirty()) return toast('There are no unsaved changes.');
    W.config = JSON.parse(W.saved); W.problems = []; previewOverride = null;
    toast('Unsaved changes discarded'); wzStatus(); wzPaintForm();
  },
  wzReset: () => modal('Reset the draft to the live website?', `
    <p class="t-sm">The shared draft is replaced with ${W.data.live ? `version ${W.data.live.version}, which is live now` : 'the built-in website settings'}.
      Unpublished changes, including other administrators' saved ones, are discarded.</p>`,
    async () => { const out = await quad.resetSiteDraft(W.revision); toast('The draft now matches the live website'); return out; }),
  wzSave: (t) => wzSave(t),
  wzPublish: (t) => wzPublish(t),
  wzRollback: (t) => wzRollback(t),
  wzPreviewVersion: (t) => wzPreviewVersion(t),
};

/* ========================================================================
   LIVE DELIVERIES — what is being carried right now

   The state of each delivery and how fresh its partner's position is. The
   position itself (coordinates) is never drawn or shown here: the age is
   what operations needs, and the location stays with the people who need
   it. The tracking API applies its own rules: a position exists only while
   an order is being carried and is deleted when the delivery ends.
   ======================================================================== */
const FRESH_S = 60, STALE_S = 300;
function freshness(t) {
  if (!t) return '<span class="badge">unknown</span>';
  if (t.partnerVisibility === 'delivery_over') return '<span class="badge">delivery over</span>';
  if (!t.partner) return '<span class="badge badge-warn">no position shared yet</span>';
  const a = t.partner.ageSeconds;
  if (a <= FRESH_S) return `<span class="badge badge-ok">updated ${a} s ago</span>`;
  if (a <= STALE_S) return `<span class="badge badge-warn">stale · ${Math.round(a / 60)} min old</span>`;
  return `<span class="badge badge-danger">not updating · ${Math.round(a / 60)} min</span>`;
}

async function scrDeliveries() {
  setTitle('Live Deliveries', 'Deliveries in progress, who is carrying them and whether their position is updating. Positions are not shown here.');
  head().innerHTML = '<button type="button" class="btn btn-secondary btn-sm" data-act="deliveriesRefresh">Refresh</button>';
  await panel(view(), async () => {
    const get = (state) => quad.adminOrders({ state, fulfilment: 'delivery', pageSize: 50 }).then((r) => r.orders);
    const [waiting, assigned, onway] = await Promise.all([
      Promise.all(['confirmed', 'preparing', 'ready'].map(get)).then((x) => x.flat()), get('assigned'), get('picked_up')]);
    const carrying = [...assigned, ...onway];
    const tracks = await Promise.all(carrying.map((o) => quad.tracking(o.id).catch(() => null)));
    return { waiting, assigned, onway, track: Object.fromEntries(carrying.map((o, i) => [o.id, tracks[i]])) };
  }, (d) => {
    const stale = [...d.assigned, ...d.onway].filter((o) => {
      const t = d.track[o.id];
      return !t?.partner || t.partner.ageSeconds > FRESH_S;
    }).length;
    const rows = (list, carrying) => list.map((o) => [
      `<b>${esc(o.code)}</b><div class="t-xs muted">${when(o.created_at)}</div>`,
      esc(o.vendor_name), esc(o.customer_name || '—'),
      carrying ? (o.partner_name ? esc(o.partner_name) : '<span class="t-xs faint">assigned (name needs partners.view)</span>')
        : '<span class="t-xs faint">not assigned yet</span>',
      `<span class="badge badge-ink">${esc(ORDER_LABEL[o.state] || o.state)}</span>`,
      carrying ? freshness(d.track[o.id]) : '—',
      `<span class="num">${rupees(o.total_paise)}</span>`,
      `<button type="button" class="btn btn-ghost btn-sm" data-act="orderTimeline" data-id="${o.id}">Timeline</button>`,
    ]);
    const cols = ['Order', 'Café', 'Student', 'Partner', 'State', 'Position', 'Total', ''];
    return `
      <div class="grid-kpi">
        ${statCard('route', 'On the way', d.onway.length, 'picked up, being carried')}
        ${statCard('bike', 'Partner assigned', d.assigned.length, 'heading to the café')}
        ${statCard('bag', 'Waiting for a partner', d.waiting.length, 'confirmed delivery orders')}
        ${statCard('pulse', 'Position not fresh', stale, `older than ${FRESH_S} s, or not shared`, stale ? 'warn' : '')}
      </div>
      <section class="card card-pad cc-section">
        <h2 class="cc-h">Being carried</h2>
        ${d.assigned.length + d.onway.length ? table(cols, rows([...d.onway, ...d.assigned], true))
          : EmptyState('Nothing is being carried right now.', 'Deliveries appear here when a partner accepts one.')}
      </section>
      <section class="card card-pad cc-section">
        <h2 class="cc-h">Waiting for a partner</h2>
        ${d.waiting.length ? table(cols, rows(d.waiting, false)) : EmptyState('No delivery is waiting.', '')}
      </section>
      <p class="t-xs faint">A partner's phone sends its position about every 20 seconds while the delivery screen is open; a locked phone or a backgrounded browser pauses it.
        Fresh means under ${FRESH_S} s, stale up to ${STALE_S / 60} min; after that the customer's map stops drawing it.</p>`;
  }, { label: 'Loading deliveries' });
}

/* ========================================================================
   SESSIONS — who is signed in to Campus Control
   ======================================================================== */
async function scrSessions() {
  setTitle('Sessions', 'Open administrator sessions. Signing someone out ends every session they have, at once.');
  head().innerHTML = '';
  await panel(view(), async () => {
    const { administrators } = await quad.accessAdmins();
    const details = await Promise.all(administrators.map((a) => quad.accessAdmin(a.id).catch(() => null)));
    return administrators.map((a, i) => ({ a, sessions: details[i]?.sessions || [] }));
  }, (list) => {
    const total = list.reduce((n, x) => n + x.sessions.length, 0);
    return `
      <div class="grid-kpi">
        ${statCard('device', 'Open sessions', total, 'across all administrators')}
        ${statCard('users', 'Administrators', list.length, `${list.filter((x) => x.sessions.length).length} signed in now`)}
      </div>
      ${list.map(({ a, sessions }) => {
        const self = a.id === session.me.user.id;
        return `<section class="card card-pad cc-section">
          <div class="between" style="flex-wrap:wrap;gap:8px">
            <div><h2 class="cc-h" style="margin:0">${esc(a.name || a.email || 'Administrator')}${self ? ' <span class="badge">you</span>' : ''}</h2>
              <span class="t-xs muted">${esc(a.email || '')} · ${a.isOwner ? 'Owner' : esc(a.status)}</span></div>
            ${!a.isOwner && !self && session.can('sessions.revoke') && sessions.length
              ? `<button class="btn btn-secondary btn-sm" data-act="revokeAdminSessions" data-id="${a.id}" data-name="${esc(a.name || a.email || '')}">Sign out everywhere</button>` : ''}
          </div>
          ${sessions.length ? table(['Signed in', 'Expires', 'Method', 'IP', 'Device'], sessions.map((s) => [
            when(s.issued_at), new Date(s.expires_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
            esc(s.auth_method === 'admin_totp' ? 'password + authenticator' : s.auth_method), esc(s.ip || '—'),
            `<span class="t-xs">${esc(s.user_agent || '')}</span>`])) : '<p class="t-sm muted">No open sessions.</p>'}
        </section>`; }).join('')}
      <p class="t-xs faint">Session details only: no session token or its hash ever leaves the server.</p>`;
  }, { label: 'Loading sessions' });
}

/* A figure card in the reference's style: a round tinted icon, a label and
   the number. Values always come from the server. */
const statCard = (ic, label, value, note = '', tone = '') => `
  <div class="cc-stat${tone ? ` tone-${tone}` : ''}">
    <span class="cc-stat-icon" aria-hidden="true">${icon(ic, 22)}</span>
    <span class="cc-stat-text"><span class="cc-stat-label">${esc(label)}</span>
      <span class="cc-stat-value">${esc(String(value))}</span>
      ${note ? `<span class="cc-stat-note">${esc(note)}</span>` : ''}</span>
  </div>`;

Object.assign(ACTIONS, WZ_ACTIONS, {
  collapseRail: () => {
    const c = document.querySelector('.cc');
    c.classList.toggle('cc-collapsed');
    try { localStorage.setItem('cc-rail', c.classList.contains('cc-collapsed') ? 'collapsed' : 'open'); } catch { /* storage blocked */ }
  },
  profileMenu: (t) => {
    const m = document.getElementById('profile-menu');
    m.hidden = !m.hidden;
    t.setAttribute('aria-expanded', String(!m.hidden));
    if (!m.hidden) m.querySelector('button')?.focus();
  },
  notifications: async (t) => {
    if (document.querySelector('.cc-notifs')) { document.querySelector('.cc-notifs').remove(); return; }
    const box = el('<div class="cc-menu cc-notifs" role="dialog" aria-label="Notifications"><p class="t-sm muted" style="padding:12px">Loading…</p></div>');
    t.parentElement.append(box);
    try {
      const { notifications } = await quad.notifications();
      box.innerHTML = `<div class="cc-menu-head"><b>Notifications</b></div>${notifications.length ? notifications.slice(0, 12).map((n) => `
        <div class="cc-notif${n.read_at ? '' : ' unread'}"><span class="t-sm">${esc(n.title || n.kind || 'Notice')}</span>
          ${n.body ? `<span class="t-xs muted">${esc(n.body)}</span>` : ''}<span class="t-xs faint">${when(n.created_at)}</span></div>`).join('')
        : '<p class="t-sm muted" style="padding:12px">Nothing new.</p>'}`;
    } catch (e) { box.innerHTML = `<p class="t-sm" style="padding:12px">${esc(explain(e))}</p>`; }
  },
  deliveriesRefresh: () => scrDeliveries(),
});

/* Narrowing the permission list as the owner types. Only hides rows; the
   checked state, and what is saved, is unaffected. */
document.addEventListener('input', (e) => {
  const box = e.target.closest?.('[data-perm-search]');
  if (!box) return;
  const want = box.value.trim().toLowerCase();
  const form = box.closest('form');
  form.querySelectorAll('[data-perm-row]').forEach((r) => { r.hidden = want && !r.dataset.permRow.includes(want); });
  form.querySelectorAll('[data-perm-group]').forEach((g) => { g.hidden = ![...g.querySelectorAll('[data-perm-row]')].some((r) => !r.hidden); });
});
Object.assign(ACTIONS, ORDER_ACTIONS);
