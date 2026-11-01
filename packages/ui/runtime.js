/* ==========================================================================
   QUAD — SHARED SURFACE RUNTIME

   Everything the three surfaces need in common once they talk to a real
   server rather than an in-memory module:

     · a session gate that asks the server who you are and refuses to render
       a surface your roles do not open
     · view-model adapters, so server rows render in the approved design
       without the prototype's invented fields
     · loading, error and empty states that tell the truth, including the
       difference between "nothing here yet" and "this service is not
       configured"

   No surface keeps business state. Every mutation is an HTTP call and the
   result is re-read from the server, so a reload never loses anything and
   two surfaces never disagree.
   ========================================================================== */
import { quad, ApiError, Offline, rupees, ratingLabel, staffRequests } from '../data/client.js';

/* Campus Control and the counter: a request that hangs is reported, and a
   route the server lacks is named as such (packages/data/client.js). */
staffRequests();
import { esc } from './kit.js';
import { mark as logoMark, lockup } from '../../brand/logo.js';

export { quad, ApiError, Offline, rupees, ratingLabel };

/* Re-confirming an administrator: the same two factors as signing in, asked
   for in place rather than by throwing the person back to the sign-in screen
   and losing what they were doing. A real dialog with a masked password
   field: window.prompt() would show the password as it is typed. Resolves
   when the server accepts both; rejects if the person cancels. */
export function adminReauth({ reason = 'This change needs you to confirm it is you.' } = {}) {
  return new Promise((resolve, reject) => {
    const wrap = document.createElement('div');
    wrap.className = 'modalwrap reauthwrap';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'reauth-title');
    wrap.innerHTML = `
      <div class="scrim-fixed" data-reauth="cancel"></div>
      <form class="modal reauth" novalidate>
        <div class="modal-head"><h2 class="t-h3" id="reauth-title">Confirm it is you</h2>
          <p class="t-sm muted">${esc(reason)} Enter your password and the code your authenticator app shows now.</p></div>
        <div class="modal-body">
          <label class="field"><span class="t-label">Password</span>
            <input class="input" type="password" name="password" autocomplete="current-password" required></label>
          <label class="field"><span class="t-label">Authenticator code</span>
            <input class="input code-input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
          <p class="reauth-error" role="alert" hidden></p>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn-ghost" data-reauth="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Confirm</button>
        </div>
      </form>`;
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
    const cancel = () => { close(); reject(new Error('Confirmation cancelled.')); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('click', (e) => { if (e.target.closest('[data-reauth=cancel]')) cancel(); });
    const form = wrap.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const err = form.querySelector('.reauth-error');
      const password = form.password.value;
      const code = String(form.code.value || '').replace(/\D/g, '');
      if (!password || code.length !== 6) { err.hidden = false; err.textContent = 'Enter your password and the 6-digit code.'; return; }
      btn.disabled = true;
      try {
        const out = await quad.adminReauth(password, code);
        close(); resolve(out);
      } catch (x) {
        err.hidden = false; err.textContent = explain(x); btn.disabled = false;
        form.code.value = ''; form.code.focus();
      }
    });
    document.body.append(wrap);
    form.password.focus();
  });
}

/* ---------- session ------------------------------------------------------ */
export const session = {
  me: null,
  get roles() { return this.me?.roles || []; },
  get vendorIds() { return this.me?.vendorIds || []; },
  has(...roles) { return roles.some((r) => this.roles.includes(r)); },
  get isPlatform() { return this.has('platform_owner', 'platform_admin', 'support'); },
  /* Granular administrator permissions from /auth/me. Used only to hide
     controls the server would refuse; the server is the enforcement point. */
  get isOwner() { return !!this.me?.isOwner; },
  can(...perms) { return this.isOwner || perms.some((p) => (this.me?.permissions || []).includes(p)); },
};

/**
 * The door. Loads the session, and refuses the surface if the server says
 * this account does not open it. The check is a courtesy — the API denies
 * the calls regardless — but it stops a shopkeeper staring at an admin
 * shell full of 403s.
 */
export async function gate(root, surface, render) {
  root.innerHTML = shellLoading();
  let me;
  try {
    me = await quad.me();
  } catch (e) {
    /* A server waking from sleep and no connection at all are different
       problems; the development hint is shown only in a local build. */
    const local = globalThis.QUAD_DEPLOY?.env === 'local';
    return root.replaceChildren(el(fatal(
      e instanceof Offline && e.code === 'timeout' ? 'The ECHO ECHO server is taking too long to answer'
        : e instanceof Offline ? 'Cannot reach the ECHO ECHO server'
        : 'Something went wrong signing you in',
      e instanceof Offline
        ? (local ? 'The API is not responding. Start it with `npm start` in server/.'
          : e.code === 'timeout' ? 'It may be starting up after a quiet period. Reload in a moment.'
          : 'Check your internet connection, then reload.')
        : e.message)));
  }

  if (!me.authenticated) {
    const { mountLogin } = await import('./login.js');
    return mountLogin(root, { surface, onSignedIn: () => location.reload() });
  }
  session.me = me;

  /* An administrator signed in with only their student email code: the
     server holds the platform role back from that session, so the honest
     next screen is setting up (or going to) the real Campus Control sign-in
     - password plus authenticator code - rather than a wall of 403s. A
     legacy passkey recovery session keeps the passkey step it was made for. */
  if (!me.surfaces.includes(surface) && me.passkey?.recoverySession) {
    const { mountPasskeyStep } = await import('./passkey.js');
    return mountPasskeyStep(root, { onDone: () => location.reload() });
  }
  if (!me.surfaces.includes(surface) && me.passkey?.adminSurfacesPending?.includes(surface)) {
    const { mountAdminEnrol } = await import('./admin-enrol.js');
    return mountAdminEnrol(root);
  }

  if (!me.surfaces.includes(surface)) {
    return root.replaceChildren(el(denied(surface, me)));
  }
  return render(me);
}

const SURFACE_LABEL = { admin: 'Campus Control', counter: 'Counter', web: 'the student site' };

function denied(surface, me) {
  const home = { admin: '../admin/', counter: '../shop/', web: '../web/' }[me.surface];
  return `
    <div class="auth-screen">
      <div class="auth-card">
        ${lockup({ height: 28 })}
        <h1 class="auth-title">Not your surface</h1>
        <p class="auth-sub">
          This account holds ${me.roles.map((r) => `<b>${esc(r)}</b>`).join(', ')},
          which does not open ${esc(SURFACE_LABEL[surface] || surface)}.
        </p>
        <a class="auth-btn" style="text-decoration:none;text-align:center" href="${home}">
          Go to ${esc(SURFACE_LABEL[me.surface])}
        </a>
        <button class="auth-link" data-act="signout">Sign out</button>
      </div>
    </div>`;
}

export function fatal(title, detail) {
  return `
    <div class="auth-screen">
      <div class="auth-card">
        ${lockup({ height: 28 })}
        <h1 class="auth-title">${esc(title)}</h1>
        <p class="auth-sub">${esc(detail || '')}</p>
        <!-- A link to this same page rather than an inline onclick: the
             Content-Security-Policy allows no inline script. -->
        <a class="auth-btn" style="text-decoration:none;text-align:center" href="">Try again</a>
      </div>
    </div>`;
}

const shellLoading = () => `
  <div class="auth-screen"><div class="auth-card" style="align-items:center">
    ${logoMark({ size: 34 })}
    <p class="auth-sub" style="margin-top:10px">Loading…</p>
  </div></div>`;

/* ---------- DOM ---------------------------------------------------------- */
export const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = String(html).trim();
  return t.content.firstElementChild;
};

/* ---------- view-model adapters ------------------------------------------
   The design system wants a two-letter mark and a colour per outlet. Rather
   than store decoration in the database, both are derived from the vendor's
   own id, so they are stable, unique-ish, and never need a migration. */
const MARK_BG = ['var(--ink-800)', '#8C4A5E', '#4A5F7A', '#6B5B4A', '#4F6B57', '#7A4A6B'];

export function vendorVM(v) {
  const initials = (v.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  let h = 0;
  for (const ch of String(v.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    ...v,
    mark: initials,
    markBg: MARK_BG[h % MARK_BG.length],
    open: !!(v.is_open && v.accepting),
    ratingText: ratingLabel(v.rating),
    prep: v.prep_minutes,
  };
}

export function itemVM(i) {
  return {
    ...i,
    priceText: rupees(i.price_paise),
    ratingText: ratingLabel(i.rating),
    orderable: i.available !== false,
  };
}

/* ---------- states -------------------------------------------------------
   Three distinct things, never conflated: still loading, genuinely empty,
   and unavailable because a provider is not configured. */
export const Loading = (label = 'Loading') => `
  <div class="empty"><div class="skel" style="width:180px;height:14px"></div>
  <p class="t-sm muted" style="margin-top:12px">${esc(label)}…</p></div>`;

export const EmptyState = (title, body, actions = '') => `
  <div class="empty">
    <div class="empty-art">${logoMark({ size: 30 })}</div>
    <h3 class="t-h3">${esc(title)}</h3>
    <p class="t-sm muted">${esc(body || '')}</p>
    ${actions}
  </div>`;

/* The honest unavailable state: says which configuration is missing. */
export const NotConfigured = (title, detail) => `
  <div class="empty">
    <h3 class="t-h3">${esc(title)}</h3>
    <p class="t-sm muted">${esc(detail || '')}</p>
    <p class="t-xs faint" style="margin-top:8px">
      This is a server configuration issue, not an error you caused.
    </p>
  </div>`;

export const ErrorState = (e, retryAct = '') => `
  <div class="empty">
    <h3 class="t-h3">${esc(e instanceof Offline ? (e.code === 'timeout' ? e.message : 'Cannot reach the server') : e.message)}</h3>
    ${e.detail ? `<p class="t-sm muted">${esc(e.detail)}</p>` : ''}
    ${retryAct ? `<button class="btn btn-secondary btn-sm" data-act="${retryAct}">Try again</button>` : ''}
  </div>`;

/* Renders whichever of the three states applies. Used by every panel so the
   distinction is made consistently rather than per-screen. */
/* Panels started while a background refresh is running (quietly()) are quiet. */
let QUIET = false;
export async function quietly(start) {
  QUIET = true;
  try { const p = start(); QUIET = false; return await p; } finally { QUIET = false; }
}
/* A new page is about to be drawn into `node`: any panel still loading there
   belongs to the page being left, and must not paint its late answer (or
   its error) over the new one. Called by each surface's router. Without it,
   opening Team Chat while a slow Overview was still loading ended with the
   Overview's "Cannot reach the server" drawn over the chat - with a Try
   again that retried the Overview. */
export function claim(node) {
  if (node) node.dataset.loadSeq = String((Number(node.dataset.loadSeq) || 0) + 1);
  return node;
}
export async function panel(node, loader, view, { label, quiet = QUIET } = {}) {
  /* A background refresh keeps what is on screen until the new data arrives,
     instead of flashing a loading state every few seconds. */
  if (!quiet) node.innerHTML = Loading(label);
  /* Only the newest load may write into this node: leaving a page while it
     is still loading must not paint its late answer over the next page. */
  const seq = String((Number(node.dataset.loadSeq) || 0) + 1);
  node.dataset.loadSeq = seq;
  const current = () => node.dataset.loadSeq === seq && node.isConnected;
  try {
    const data = await loader();
    if (!current()) return null;
    node.innerHTML = view(data);
    return data;
  } catch (e) {
    if (!current() || quiet) return null;   // quiet: keep the last good board; the next tick retries
    node.innerHTML = e instanceof ApiError && e.isConfiguration
      ? NotConfigured(e.message, e.detail)
      : `${ErrorState(e)}<div class="panel-retry"><button type="button" class="btn btn-secondary btn-sm" data-panel-retry>Try again</button></div>`;
    node.querySelector('[data-panel-retry]')?.addEventListener('click', () => panel(node, loader, view, { label }), { once: true });
    return null;
  }
}

/* ---------- feedback ----------------------------------------------------- */
export function toast(msg, tone = 'ok') {
  document.querySelector('.toast')?.remove();
  const t = el(`<div class="toast ${tone === 'bad' ? 'badge-danger' : ''}">${esc(msg)}</div>`);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('pop'));
  setTimeout(() => t.remove(), 3200);
}

/** Turns any thrown API error into a message a person can act on. */
export function explain(e) {
  if (e instanceof Offline) return 'Cannot reach the ECHO ECHO server.';
  if (e instanceof ApiError) {
    if (e.isConfiguration) return `${e.message} — ${e.detail || 'not configured on the server.'}`;
    return e.detail ? `${e.message} — ${e.detail}` : e.message;
  }
  return e?.message || 'Something went wrong.';
}

/** Wraps a mutation: disables the button, reports the real error, refreshes. */
export async function act(btn, fn, { after, ok } = {}) {
  const original = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    let out;
    try {
      out = await fn();
    } catch (e) {
      /* Money, roles and boundaries need a fresh confirmation that it is
         really this administrator. Ask once, then repeat the same request;
         the server decides whether the confirmation was good enough. */
      if (!(e instanceof ApiError) ||
          !['reauth_required', 'admin_signin_required'].includes(e.code)) throw e;
      await adminReauth();
      out = await fn();
    }
    if (ok) toast(ok);
    await after?.();
    return out;
  } catch (e) {
    toast(explain(e), 'bad');
    return null;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

/* ---------- misc --------------------------------------------------------- */
export const brandHeader = (sub) => `
  <div class="rail-brand">${lockup({ height: 32 })}
  ${sub ? `<span class="t-xs faint">${esc(sub)}</span>` : ''}</div>`;

/* Signing out ends THIS session on the server, then shows the sign-in
   screen. If the server could not end it, that is said - the screen does
   not pretend. `admin` uses Campus Control's own logout. */
export async function signOut({ admin = false, button = null } = {}) {
  if (button) { button.disabled = true; button.textContent = 'Signing out…'; }
  try {
    await (admin ? quad.adminLogout() : quad.logout());
  } catch (e) {
    if (button) { button.disabled = false; button.textContent = 'Sign out'; }
    toast(`Sign-out did not complete: ${explain(e)}`, 'bad');
    return false;
  }
  try { sessionStorage.clear(); } catch { /* storage blocked */ }
  /* replace(): Back does not return to the signed-in page. */
  location.replace(location.pathname);
  return true;
}

export const when = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts), now = Date.now(), diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

export const ORDER_LABEL = {
  draft: 'Draft', awaiting_payment: 'Awaiting payment', confirmed: 'Confirmed',
  preparing: 'Preparing', ready: 'Ready', assigned: 'Partner assigned',
  picked_up: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled',
  refunded: 'Refunded',
};
