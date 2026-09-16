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
  vendorVM, EmptyState, NotConfigured, Loading, ErrorState, signOut, when, ORDER_LABEL,
} from '../../packages/ui/runtime.js';
import { esc, toggleTheme, restoreTheme, Mark } from '../../packages/ui/kit.js';
import { lockup } from '../../brand/logo.js';

const root = document.getElementById('app');
restoreTheme();

const S = { route: 'overview', vendorId: null, userId: null, caseId: null, parentId: null };

/* Roles that can be signed in with an enrolment code. platform_owner is
   absent on purpose: an admin must not be able to mint their way into the
   account that grants admin. The owner uses the server-side CLI. */
const ENROLLABLE = ['platform_admin', 'support', 'vendor_owner', 'vendor_staff'];

gate(root, 'admin', render);

const NAV = [
  ['overview', 'Overview'], ['cafeterias', 'Cafeterias'], ['menu', 'Menu'],
  ['orders', 'Orders'], ['users', 'Users'], ['verification', 'Verification'],
  ['partners', 'Partners'], ['trust', 'Incidents & deposits'], ['reviews', 'Reviews'],
  ['locations', 'Locations'], ['support', 'Support'],
  ['finance', 'Finance'], ['admins', 'Administrators'], ['platform', 'Platform'], ['audit', 'Audit'],
];

/* Which permission opens each page. Hiding is a courtesy: every panel's API
   call is checked by the server regardless. */
const NAV_PERM = {
  cafeterias: ['cafeterias.view', 'cafeterias.manage'], menu: ['menus.view', 'menus.manage'],
  orders: ['orders.view'], users: ['students.view'], verification: ['students.view'],
  partners: ['partners.view'], trust: ['delivery.incidents', 'deposits.view'], reviews: ['reviews.view'],
  locations: ['locations.view', 'boundary.view', 'campuses.view'], support: ['support.view'],
  finance: ['finance.view'], admins: ['admins.view'], platform: ['platform.view'], audit: ['audit.view'],
};
const allowedNav = () => NAV.filter(([r]) => !NAV_PERM[r] || session.can(...NAV_PERM[r]));

function render() {
  if (NAV_PERM[S.route] && !session.can(...NAV_PERM[S.route])) S.route = 'overview';
  root.innerHTML = `
    <div class="appframe">
      <aside class="rail">
        <div class="rail-brand">${lockup({ height: 24 })}
          <span class="t-xs faint">Campus Control</span></div>
        <nav class="stack">
          ${allowedNav().map(([r, l]) =>
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
          ${allowedNav().map(([r, l]) =>
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
  root.addEventListener('click', onClick);
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

const SCREENS = {
  overview: scrOverview, cafeterias: scrCafeterias, menu: scrMenu, orders: scrOrders,
  users: scrUsers, verification: scrVerification, partners: scrPartners,
  trust: scrTrust, reviews: scrReviews, admins: scrAdmins,
  locations: scrLocations, support: scrSupport, finance: scrFinance,
  platform: scrPlatform, audit: scrAudit,
};

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
const route = () => { markNav(); return (SCREENS[S.route] || scrOverview)(); };

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
    const [vendors, orders, cases, partners, flags] = await Promise.all([
      when_(session.can('cafeterias.manage'), async () => (await quad.vendors({ includeArchived: 'true' })).vendors)
        .then((v) => v ?? (session.can('cafeterias.view') ? quad.vendors().then((x) => x.vendors) : null)),
      when_(session.can('orders.view'), async () => (await quad.orders({ scope: 'all' })).orders),
      when_(session.can('students.view'), async () => (await quad.verificationQueue('pending')).cases),
      when_(session.can('partners.view'), async () => (await quad.partners('pending')).partners),
      when_(session.can('platform.view'), () => quad.flags()),
    ]);
    return { vendors, orders, cases, partners, flags };
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

const kpi = (label, value, note) => `
  <div class="kpi"><div class="t-label">${esc(label)}</div>
  <div class="statval">${esc(String(value))}</div>
  <div class="t-xs faint">${esc(note)}</div></div>`;

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
                ${raw.active ? (v.open ? 'Open' : 'Closed') : 'Archived'}</span>
            </div>
          </div>
          <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
            <button class="btn btn-secondary btn-sm" data-act="editVendor" data-id="${v.id}">Edit</button>
            <button class="btn btn-secondary btn-sm" data-act="menuFor" data-id="${v.id}">Menu</button>
            <button class="btn btn-secondary btn-sm" data-act="assignOwner" data-id="${v.id}">Assign owner</button>
            <button class="btn btn-secondary btn-sm" data-act="assignStaff" data-id="${v.id}">Add staff</button>
            <button class="btn btn-ghost btn-sm" data-act="toggleOpen" data-id="${v.id}" data-v="${v.open ? '0' : '1'}">
              ${v.open ? 'Close' : 'Open'}</button>
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
        </div>
      </div>`).join('')}</div>`;
  }, { label: 'Loading menu' });
}

/* ========================================================================
   ORDERS · USERS · VERIFICATION · PARTNERS
   ======================================================================== */
async function scrOrders() {
  setTitle('Orders', 'Every order on the platform.');
  head().innerHTML = '';
  await panel(view(), () => quad.orders({ scope: 'all' }), (d) => {
    if (!d.orders.length) return EmptyState('No orders yet.', '');
    return table(['Code', 'Cafeteria', 'Items', 'State', 'Total', 'When', ''],
      d.orders.map((o) => [
        esc(o.code), esc(o.vendor_name),
        (o.items || []).map((i) => `${i.qty}× ${esc(i.name)}`).join(', '),
        `<span class="badge badge-ink">${esc(ORDER_LABEL[o.state] || o.state)}</span>`,
        rupees(o.total_paise), when(o.created_at),
        `<button class="btn btn-ghost btn-sm" data-act="inspectOrder" data-id="${o.id}">Inspect</button>`,
      ]));
  }, { label: 'Loading orders' });
}

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
      ${table(['Photo', 'Name', 'Student', 'Policy', 'Deposit', 'Rating', 'Status', ''],
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
        `<span class="badge badge-ink">${esc(p.status)}${p.online ? ' · online' : ''}</span>
         <div class="t-xs faint">${p.deliveries} deliveries</div>`,
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
    <div class="stack" style="gap:12px;max-height:48vh;overflow:auto">
      ${catalog.groups.map((g) => `
        <fieldset style="border:1px solid var(--line);border-radius:10px;padding:8px 12px">
          <legend class="t-label">${esc(g.name)}</legend>
          ${g.permissions.map((p) => `
            <label class="row" style="gap:8px;align-items:flex-start;padding:3px 0">
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
  await panel(view(), async () => {
    const campuses = (await quad.adminCampuses()).campuses;
    S.locCampus = S.locCampus && campuses.some((c) => c.id === S.locCampus) ? S.locCampus
      : (campuses.find((c) => c.available) || campuses[0])?.id;
    return {
      campuses,
      nodes: (await quad.campusChildren(null, { campusId: S.locCampus })).nodes,
      zones: (await quad.campusZones(S.locCampus)).zones,
      boundaries: S.locCampus ? (await quad.boundaries(S.locCampus)).boundaries : [],
    };
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
   MODAL
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
  if (e.key === 'Escape' && document.querySelector('.modalwrap')) closeModal();
});

const field = (name, label, value = '', type = 'text') => `
  <label class="field"><span class="t-label">${esc(label)}</span>
  <input class="input" name="${name}" type="${type}" value="${esc(value ?? '')}"></label>`;
const check = (name, label, on) => `
  <label class="row" style="gap:8px"><input type="checkbox" name="${name}" ${on ? 'checked' : ''}>
  <span class="t-sm">${esc(label)}</span></label>`;

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
  theme: () => toggleTheme(),

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
    modal(`Permissions · ${t.dataset.name}`, `
      ${permissionPicker(catalog, detail.administrator.effective.permissions)}
      ${field('reason', 'Reason for the change (kept in the audit log)')}`,
    (d, form) => quad.setAdminPermissions(t.dataset.id, pickedPermissions(form), d.reason));
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
      ${d.activity.length ? table(['When', 'Action', 'Outcome'], d.activity.slice(0, 50).map((x) => [when(x.at), esc(x.action), esc(x.outcome)])) : '<p class="t-sm muted">No activity yet.</p>'}`, DONE);
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
    catch (e) { return toast(explain(e), 'bad'); }
    modal('Set up your authenticator', `
      <p class="t-sm muted">In Microsoft Authenticator — or any authenticator app — choose
        <b>Add account → Other account → Enter key manually</b>, then type this key.</p>
      <div class="enrolcode">${esc(out.secret)}</div>
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

  newItem: () => modal('Add food', `
    ${field('name', 'Name')}${field('description', 'Description')}
    <div class="formrow">${field('price', 'Price (₹)')}${field('prepMinutes', 'Prep minutes', '', 'number')}</div>
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
          tags: splitList(d.tags), aliases: splitList(d.aliases),
        });
      });
  },

  itemAvail: (t) => act(t, () => quad.updateItem(t.dataset.id, { available: t.dataset.v === '1' }),
    { after: paintMenu }),
  itemArchive: (t) => act(t, () => quad.updateItem(t.dataset.id, { active: t.dataset.v === '1' }),
    { after: paintMenu }),

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
    await act(t, () => quad.refund(t.dataset.id, reason), { ok: 'Refund issued' });
    closeModal();
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
