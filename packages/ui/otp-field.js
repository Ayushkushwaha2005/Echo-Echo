/* ==========================================================================
   ECHO ECHO — THE ONE OTP FIELD

   Every six-digit code on the platform is typed into this: Campus Control
   sign-in, password reset, invitations, authenticator setup and recovery,
   the "confirm it is you" dialog, and the student email code.

   It is a port of the supplied `input-otp-10` React component (particle
   sphere, rotating rings, six spring-animated slots, success shield) to the
   plain ES modules this repository ships. There is no bundler here, so React,
   motion and input-otp are not used; the behaviour they provided is below:

     input-otp   one real <input> laid over six painted slots, so paste,
                 SMS/one-time-code autofill, arrows, Backspace and screen
                 readers all work on a normal text field
     motion      spring transitions on each character and the pulse ring
     particles   ParticleSphereAnimation, drawn on a <canvas>

   What it never does is decide that a code is right. Six digits only make
   the status line say so; the success shield appears when the caller says
   the SERVER accepted the code (otpSucceeded), and nowhere else.

     otpField({ name, label, state, title, help })   markup for a form
     otpSucceeded(scope)  shield + green, resolves after the animation
     otpState(scope, 'idle' | 'loading' | 'error')

   autoSubmit: true (authenticator-only forms). The sixth digit submits the
   form itself, through the form's own submit handler, so the server call and
   its rules are exactly the ones a click used to make. The form's submit
   button is hidden (kept in the page for that handler) and:
     - one complete code is sent once: the same six digits are not sent again
       until the code is edited, so a refused code never loops;
     - nothing is sent while a check is running (Enter, a second paste or a
       repeated input event are ignored);
     - a refused code shows the error state; typing clears it and the next
       complete code is sent.
   ========================================================================== */

const safe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LENGTH = 6;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const SHIELD = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`;

/**
 * The field's markup. `name` is the form field the existing submit handler
 * already reads, so FormData, form.code and input[name=code] keep working.
 */
export function otpField({ name = 'code', label = '6-digit code', state = 'idle', title = '', help = '', id = '', autoSubmit = false } = {}) {
  const inputId = id || `otp10-${Math.random().toString(36).slice(2, 9)}`;
  return `<div class="otp10" data-otp10 data-state="${safe(state)}"${autoSubmit ? ' data-otp-auto' : ''}>
    <div class="otp10-glow otp10-glow-a" aria-hidden="true"></div>
    <div class="otp10-glow otp10-glow-b" aria-hidden="true"></div>
    <div class="otp10-orb" aria-hidden="true">
      <div class="otp10-ring otp10-ring-1"></div>
      <div class="otp10-ring otp10-ring-2"></div>
      <div class="otp10-ring otp10-ring-3"></div>
      <div class="otp10-halo"></div>
      <div class="otp10-sphere"><canvas></canvas></div>
      <div class="otp10-shield">${SHIELD}</div>
    </div>
    ${title || help ? `<div class="otp10-head">
      ${title ? `<p class="otp10-title">${safe(title)}</p>` : ''}
      ${help ? `<p class="otp10-help">${safe(help)}</p>` : ''}</div>` : ''}
    <label class="otp10-label" for="${inputId}">${safe(label)}</label>
    <div class="otp10-slots">
      <input class="otp10-input" id="${inputId}" name="${safe(name)}" type="text" inputmode="numeric"
             autocomplete="one-time-code" maxlength="${LENGTH}" pattern="[0-9]{${LENGTH}}" required
             spellcheck="false" autocapitalize="off" ${state === 'error' ? 'aria-invalid="true"' : ''}>
      ${Array.from({ length: LENGTH }, () => `<div class="otp10-slot" aria-hidden="true"><span class="otp10-caret"></span></div>`).join('')}
    </div>
    <p class="otp10-status" aria-live="polite"></p>
  </div>`;
}

const STATUS = {
  loading: 'Verifying with the server…',
  success: 'Code accepted',
  error: 'That code was not accepted',
};

function root(scope) {
  if (!scope) return null;
  if (scope.matches?.('[data-otp10]')) return scope;
  return scope.querySelector?.('[data-otp10]') || scope.closest?.('[data-otp10]') || null;
}

/** Set the visual state. Typing again after an error returns it to idle. */
export function otpState(scope, state) {
  const el = root(scope);
  if (!el) return;
  el.dataset.state = state;
  const input = el.querySelector('.otp10-input');
  if (input) {
    input.readOnly = state === 'loading' || state === 'success';
    if (state === 'error') input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }
  paint(el);
}

/**
 * Show the success shield. Call it only after the server has confirmed the
 * code. Resolves once the animation has had time to be seen.
 */
export function otpSucceeded(scope, ms = 700) {
  const el = root(scope);
  if (!el) return Promise.resolve();
  otpState(el, 'success');
  return new Promise((r) => setTimeout(r, reduced() ? 150 : ms));
}

/* ---------- painting the slots from the one real input ------------------- */
function paint(el) {
  const input = el.querySelector('.otp10-input');
  const slots = el.querySelectorAll('.otp10-slot');
  const value = input.value;
  const focused = document.activeElement === input;
  const caret = Math.min(input.selectionStart ?? value.length, LENGTH - 1);
  const prev = el._otpPrev || '';
  slots.forEach((slot, i) => {
    const ch = value[i] || '';
    const had = prev[i] || '';
    const active = focused && el.dataset.state !== 'success'
      && (i === caret || (value.length === LENGTH && i === LENGTH - 1 && caret >= LENGTH - 1));
    slot.classList.toggle('is-active', active);
    slot.classList.toggle('is-filled', !!ch);
    slot.classList.toggle('has-caret', active && !ch);
    if (ch !== had) {
      slot.querySelector('.otp10-char')?.classList.add('is-leaving');
      setTimeout(() => slot.querySelectorAll('.otp10-char.is-leaving').forEach((n) => n.remove()), 220);
      if (ch) {
        const span = document.createElement('span');
        span.className = 'otp10-char';
        span.textContent = ch;
        slot.append(span);
        const pulse = document.createElement('span');
        pulse.className = 'otp10-pulse';
        slot.append(pulse);
        setTimeout(() => pulse.remove(), 450);
      }
    }
  });
  el._otpPrev = value;
  const status = el.querySelector('.otp10-status');
  const state = el.dataset.state;
  status.textContent = STATUS[state]
    || (value.length === 0 ? 'Awaiting code…'
      : value.length < LENGTH ? `Entering code: ${value.length} / ${LENGTH}`
        : 'Six digits entered — submit to verify');
}

/* ---------- the particle sphere (ParticleSphereAnimation) ---------------- */
function sphere(el) {
  const canvas = el.querySelector('.otp10-sphere canvas');
  if (!canvas || canvas._otpRunning) return;
  canvas._otpRunning = true;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const N = 420;
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = golden * i;
    pts.push([Math.cos(t) * r, y, Math.sin(t) * r]);
  }
  let angle = 0;
  let last = 0;
  const frame = (now) => {
    if (!canvas.isConnected) { canvas._otpRunning = false; return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = canvas.clientWidth || 128;
    if (canvas.width !== size * dpr) { canvas.width = size * dpr; canvas.height = size * dpr; }
    const state = el.dataset.state;
    const speed = state === 'loading' ? 0.0022 : state === 'success' ? 0.0004 : 0.0008;
    angle += last ? (now - last) * speed : 0;
    last = now;
    const style = getComputedStyle(el);
    const rgb = (state === 'success' ? style.getPropertyValue('--otp10-ok-rgb')
      : state === 'error' ? style.getPropertyValue('--otp10-bad-rgb')
        : style.getPropertyValue('--otp10-accent-rgb')).trim() || '224,86,122';
    const w = canvas.width, c = w / 2, R = w * 0.42;
    ctx.clearRect(0, 0, w, w);
    const ca = Math.cos(angle), sa = Math.sin(angle), tilt = 0.35, ct = Math.cos(tilt), st = Math.sin(tilt);
    for (const [x, y, z] of pts) {
      const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
      const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
      const depth = (z2 + 1) / 2;
      const scale = 0.7 + depth * 0.5;
      ctx.fillStyle = `rgba(${rgb},${(0.12 + depth * 0.88).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(c + x1 * R * scale, c + y2 * R * scale, (0.5 + depth * 1.3) * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reduced()) requestAnimationFrame(frame);
    else canvas._otpRunning = false;
  };
  requestAnimationFrame(frame);
}

/* ---------- wiring --------------------------------------------------------
   Each surface renders by setting innerHTML, so a field is upgraded when it
   appears in the document rather than by every caller remembering to. */
/* The sixth digit sends the code, once. */
const AUTO_STUCK_MS = 30_000;
function autoSubmit(el, input, digits) {
  const form = input.form;
  if (!form) return;
  if (digits.length < LENGTH) { el._otpSent = null; return; }
  if (digits === el._otpSent || el.dataset.state === 'loading' || el.dataset.state === 'success') return;
  const btn = form.querySelector('button[type=submit]');
  if (btn?.disabled) return;
  el._otpSent = digits;
  otpState(el, 'loading');
  el._otpFiring = true;
  try { form.requestSubmit(); } finally { el._otpFiring = false; }
  /* A surface that neither re-renders nor reports back must not leave the
     field locked: after a long silence the student can type again. */
  clearTimeout(el._otpStuck);
  el._otpStuck = setTimeout(() => { if (el.isConnected && el.dataset.state === 'loading') otpState(el, 'idle'); }, AUTO_STUCK_MS);
}

function enhance(el) {
  if (el._otp10) return;
  el._otp10 = true;
  const input = el.querySelector('.otp10-input');
  const auto = el.hasAttribute('data-otp-auto') && !!input.form;
  if (auto) {
    const form = input.form;
    /* The button is the form's submitter for its own handler; it is no longer
       something to press. */
    const btn = form.querySelector('button[type=submit]');
    if (btn) { btn.hidden = true; btn.style.display = 'none'; btn.tabIndex = -1; btn.setAttribute('aria-hidden', 'true'); }
    /* Enter, or any other submit while a check is running, is not a second
       request. Capture phase: runs before the surface's own handler. */
    form.addEventListener('submit', (e) => {
      if (el._otpFiring) return;
      const digits = input.value.replace(/\D/g, '');
      if (el.dataset.state === 'loading' || (digits.length === LENGTH && digits === el._otpSent)) {
        e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
        return;
      }
      if (digits.length === LENGTH) { el._otpSent = digits; otpState(el, 'loading'); }
    }, true);
    /* Ready to type as soon as the step opens, unless the person is already
       typing somewhere else. */
    queueMicrotask(() => {
      const a = document.activeElement;
      if (!a || a === document.body || !a.matches?.('input, textarea, select, [contenteditable="true"]')) input.focus({ preventScroll: true });
    });
    /* A code already there (autofill before this ran) counts too. */
    if (input.value) queueMicrotask(() => autoSubmit(el, input, input.value.replace(/\D/g, '').slice(0, LENGTH)));
  }
  const sync = () => paint(el);
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, LENGTH);
    if (digits !== input.value) input.value = digits;
    if (el.dataset.state === 'error') otpState(el, 'idle'); else paint(el);
    if (auto) autoSubmit(el, input, digits);
  });
  /* A pasted "482 913" or "Your code is 482913" keeps only its digits. */
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    const digits = text.replace(/\D/g, '');
    if (!digits) return;
    e.preventDefault();
    input.value = digits.slice(0, LENGTH);
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (const ev of ['focus', 'blur', 'keyup', 'click', 'select']) input.addEventListener(ev, sync);
  document.addEventListener('selectionchange', () => { if (document.activeElement === input) sync(); });
  /* The surface's own form handlers run first; when one is still waiting on
     the server, its button is disabled and the field shows it is checking. */
  const form = input.form;
  if (form && !form._otp10) {
    form._otp10 = true;
    form.addEventListener('submit', () => {
      queueMicrotask(() => {
        const btn = form.querySelector('[type=submit]');
        if (btn?.disabled && input.value.length === LENGTH) {
          otpState(el, 'loading');
          const watch = new MutationObserver(() => {
            if (!btn.disabled || !btn.isConnected) { watch.disconnect(); if (el.dataset.state === 'loading') otpState(el, 'idle'); }
          });
          watch.observe(btn, { attributes: true, attributeFilter: ['disabled'] });
        }
      });
    });
  }
  paint(el);
  sphere(el);
}

function scan(node) {
  if (node.nodeType !== 1) return;
  if (node.matches('[data-otp10]')) enhance(node);
  node.querySelectorAll('[data-otp10]').forEach(enhance);
  node.querySelectorAll('[data-otp10] canvas').forEach((cv) => sphere(cv.closest('[data-otp10]')));
}

if (typeof document !== 'undefined' && typeof MutationObserver === 'function' && !window.__otp10) {
  window.__otp10 = true;
  const start = () => {
    scan(document.body);
    new MutationObserver((list) => {
      for (const m of list) m.addedNodes.forEach(scan);
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
}
