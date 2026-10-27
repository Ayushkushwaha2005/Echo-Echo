/* ==========================================================================
   ECHO ECHO — SETTING UP CAMPUS CONTROL SIGN-IN

   Where an administrator lands when they open Campus Control from a session
   that proved their university mailbox with an email code (their ordinary
   student sign-in) but not their administrator password and authenticator.
   The server holds their platform role back from that session, so this
   screen is the only thing it can do:

     1. choose a password (only if none is set yet; changing one needs the
        current password and a code, from a full Campus Control session)
     2. add the authenticator: a QR code and the same key typed out, then
        the six-digit code the app shows, which the server must accept
        before the authenticator counts as set up
     3. sign out and sign in properly: email, password, authenticator code

   The QR code is drawn here, in this browser, from the otpauth:// URI the
   server returns once to this signed-in account. The key is never sent
   anywhere else, never stored by this page, and is gone when it closes.
   Nothing on this screen grants access: Campus Control still opens only
   from a session signed in with the password AND a current code.
   ========================================================================== */
import { quad, ApiError } from '../data/client.js';
import { lockup } from '../../brand/logo.js';

const safe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const message = (e) => (e instanceof ApiError ? (e.detail ? `${e.message} — ${e.detail}` : e.message) : e?.message || 'Something went wrong.');

/* qrcode-generator 1.4.4 (MIT), from cdnjs, pinned by its published SRI. It
   only turns text into a matrix; the text never leaves the page. */
const QR_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
const QR_SRI = 'sha512-ZDSPMa/JM1D+7kdg2x3BsruQ6T/JpJo3jWDWkCZsP+5yVyp1KfESqLI+7RqB5k24F7p2cV7i2YHh/890y6P6Sw==';
let qrPromise = null;
function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  qrPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = QR_SRC; s.integrity = QR_SRI; s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer'; s.async = true;
    s.onload = () => (window.qrcode ? resolve(window.qrcode) : reject(new Error('QR library missing')));
    s.onerror = () => reject(new Error('The QR code could not be drawn'));
    document.head.append(s);
  }).catch((e) => { qrPromise = null; throw e; });
  return qrPromise;
}

/** An SVG QR code for `text`, or null if the library could not load. */
export async function qrSvg(text, { cell = 5, margin = 4 } = {}) {
  try {
    const make = await loadQr();
    const q = make(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: cell, margin, scalable: true });
  } catch { return null; }
}

/* Groups of four so a key typed by hand is easy to check. */
export const groupKey = (k) => String(k || '').replace(/\s/g, '').match(/.{1,4}/g)?.join(' ') || '';

const RECOVERY = `Lost the phone with your authenticator? Your password alone never opens Campus Control, and
  “Forgot password?” resets only the password. The platform owner sets up a new authenticator for an
  administrator; the owner does it for themselves from the server with <code>npm run admin:setup</code>,
  which replaces the old one.`;

export async function mountAdminEnrol(root) {
  let status = null;
  let enrol = null;      // { secret, uri, qr } while adding the authenticator
  let error = '';
  let done = false;
  try { status = await quad.adminCredential(); } catch (e) { error = message(e); }

  const signOutToSignIn = async () => { await quad.logout().catch(() => {}); location.reload(); };

  const draw = () => {
    const step = done ? 'done'
      : !status ? 'error'
      : status.passwordSet && status.authenticatorReady ? 'ready'
      : !status.passwordSet ? 'password' : 'authenticator';
    root.innerHTML = `
      <div class="auth-screen"><div class="auth-card enrol-card">
        ${lockup({ height: 28 })}
        ${step === 'error' ? `
          <h1 class="auth-title">Campus Control sign-in</h1>
          <p class="auth-error" role="alert">${safe(error)}</p>`
        : step === 'ready' ? `
          <h1 class="auth-title">Sign in to Campus Control</h1>
          <p class="auth-sub">You are signed in with your student email code, which opens ordering but not Campus Control.
            Your administrator sign-in is set up: sign out here, then sign in with your email, your password and the
            six-digit code from your authenticator app.</p>
          <button class="auth-btn" data-en="signin">Continue to Campus Control sign-in</button>`
        : step === 'password' ? `
          <h1 class="auth-title">Set your Campus Control password</h1>
          <p class="auth-sub">Step 1 of 2. At least 12 characters; a few unrelated words work well. It is never shown again, never emailed, and only you know it.</p>
          <form class="stack" data-en-form="password" novalidate>
            <label class="auth-field"><span class="auth-label">New password</span>
              <input class="auth-input" type="password" name="password" autocomplete="new-password" minlength="12" required></label>
            <label class="auth-field"><span class="auth-label">Type it again</span>
              <input class="auth-input" type="password" name="again" autocomplete="new-password" minlength="12" required></label>
            ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
            <button class="auth-btn" type="submit">Save password</button>
          </form>`
        : step === 'authenticator' ? (enrol ? `
          <h1 class="auth-title">Add your authenticator</h1>
          <p class="auth-sub">Step 2 of 2. In Microsoft Authenticator choose <b>Add account → Other account</b> and scan this code.</p>
          <div class="enrol-qr" aria-label="QR code for your authenticator app">${enrol.qr || '<p class="auth-fine">The QR code could not be drawn here. Use the key below instead.</p>'}</div>
          <details class="enrol-key"><summary>Can’t scan? Enter the key instead</summary>
            <p class="auth-fine">Choose <b>Enter code manually</b>. Account name: ${safe(enrol.issuer)}. Time-based, 6 digits.</p>
            <code class="enrol-secret">${safe(groupKey(enrol.secret))}</code></details>
          <form class="stack" data-en-form="confirm" novalidate>
            <label class="auth-field"><span class="auth-label">The 6-digit code the app shows now</span>
              <input class="auth-input auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
            ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
            <button class="auth-btn" type="submit">Confirm authenticator</button>
          </form>` : `
          <h1 class="auth-title">Add your authenticator</h1>
          <p class="auth-sub">Step 2 of 2. Campus Control needs a six-digit code from an authenticator app, such as Microsoft Authenticator, every time you sign in.</p>
          ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
          <button class="auth-btn" data-en="begin">Show my QR code</button>`)
        : `
          <h1 class="auth-title">Authenticator set up</h1>
          <p class="auth-sub">Two-step sign-in is on. Sign out of this student session and sign in to Campus Control with your
            email, your password and the code your app shows.</p>
          <button class="auth-btn" data-en="signin">Sign in to Campus Control</button>`}
        ${step !== 'error' ? `<p class="auth-fine enrol-recovery">${RECOVERY}</p>` : ''}
        <button class="auth-link" data-en="signout">Sign out</button>
      </div></div>`;
    root.querySelector('input:not([type=hidden])')?.focus();
  };

  root.onclick = async (e) => {
    const b = e.target.closest('[data-en]');
    if (!b || b.disabled) return;
    if (b.dataset.en === 'signout' || b.dataset.en === 'signin') return signOutToSignIn();
    if (b.dataset.en === 'begin') {
      b.disabled = true; b.textContent = 'Preparing…';
      try {
        const out = await quad.beginAuthenticator();
        enrol = { secret: out.secret, issuer: out.issuer, qr: await qrSvg(out.uri) };
        error = '';
      } catch (err) { error = message(err); }
      draw();
    }
  };
  root.onsubmit = async (e) => {
    const f = e.target.closest('[data-en-form]');
    if (!f) return;
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    const data = Object.fromEntries(new FormData(f));
    btn.disabled = true;
    try {
      if (f.dataset.enForm === 'password') {
        if (data.password !== data.again) throw new Error('The two passwords are not the same.');
        status = await quad.setAdminPassword({ password: data.password });
      } else {
        const code = String(data.code || '').replace(/\D/g, '');
        if (code.length !== 6) throw new Error('Enter the 6 digits the app is showing.');
        status = await quad.confirmAuthenticator(code);
        enrol = null; done = true;
      }
      error = '';
    } catch (err) {
      error = message(err);
    }
    /* Neither the password nor the key is kept by this page. */
    f.reset();
    draw();
  };
  draw();
}
