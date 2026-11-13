/* ==========================================================================
   ECHO ECHO — LOST AUTHENTICATOR

   Email, password and one recovery code buy exactly one thing: setting up a new
   authenticator. No session opens here, every address on the account is alerted,
   and all existing sessions end. Then the person signs in normally.
   ========================================================================== */
import { quad, ApiError } from '../data/client.js';
import { lockup } from '../../brand/logo.js';
import { qrSvg, groupKey } from './admin-enrol.js';
import { otpField, otpSucceeded } from './otp-field.js';

const safe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const message = (e) => (e instanceof ApiError ? (e.detail ? `${e.message} — ${e.detail}` : e.message) : e?.message || 'Something went wrong. Try again.');

export function mountAdminRecover(root, { onDone }) {
  let step = 'proof';
  let error = '';
  let enrol = null;

  const errorLine = () => (error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : '');
  const body = () => {
    if (step === 'proof') {
      return `<h1 class="auth-title">Lost your authenticator?</h1>
        <p class="auth-sub">You need your password and one of the recovery codes you saved. Using one alerts your email addresses and signs out all your sessions.</p>
        <form class="stack" data-rec="proof" novalidate>
          <label class="auth-field"><span class="auth-label">Email</span><input class="auth-input" type="email" name="email" autocomplete="username" required></label>
          <label class="auth-field"><span class="auth-label">Password</span><input class="auth-input" type="password" name="password" autocomplete="current-password" required></label>
          <label class="auth-field"><span class="auth-label">Recovery code</span><input class="auth-input" name="recoveryCode" autocomplete="off" required></label>
          ${errorLine()}
          <button class="auth-btn" type="submit">Continue</button>
        </form>
        <button class="auth-link" type="button" data-rec-act="back">Back to sign-in</button>
        <p class="auth-fine">No recovery codes? The platform owner can issue you a new invitation; the owner uses <code>npm run admin:setup</code> on the server.</p>`;
    }
    if (step === 'authenticator') {
      return `<h1 class="auth-title">Add your new authenticator</h1>
        <p class="auth-sub">In your authenticator app choose <b>Add account → Other account</b> and scan this code.</p>
        <div class="enrol-qr" aria-label="QR code for your authenticator app">${enrol.qr || '<p class="auth-fine">The QR code could not be drawn here. Use the key below.</p>'}</div>
        <details class="enrol-key"><summary>Can't scan? Enter the key instead</summary>
          <code class="enrol-secret">${safe(groupKey(enrol.secret))}</code></details>
        <form class="stack" data-rec="complete" novalidate>
          ${otpField({ label: 'The 6-digit code the app shows now', state: error ? 'error' : 'idle' })}
          ${errorLine()}
          <button class="auth-btn" type="submit">Replace authenticator</button>
        </form>`;
    }
    return `<h1 class="auth-title">Authenticator replaced</h1>
      <p class="auth-sub">All your sessions were signed out. Sign in with your password and the new authenticator, then create fresh recovery codes in My Profile.</p>
      <button class="auth-btn" type="button" data-rec-act="back">Go to sign-in</button>`;
  };
  const draw = () => {
    root.innerHTML = `<div class="auth-screen"><div class="auth-card enrol-card">${lockup({ height: 28 })}${body()}</div></div>`;
    root.querySelector('input[name=code], input')?.focus();
  };

  root.onclick = (e) => { if (e.target.closest('[data-rec-act=back]')) onDone?.(); };
  root.onsubmit = async (e) => {
    const f = e.target.closest('[data-rec]');
    if (!f) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    f.querySelector('button[type=submit]').disabled = true;
    error = '';
    try {
      if (f.dataset.rec === 'proof') {
        const out = await quad.recoveryBegin(d);
        enrol = { ticket: out.ticket, secret: out.secret, qr: await qrSvg(out.uri) };
        step = 'authenticator';
      } else {
        await quad.recoveryComplete({ ticket: enrol.ticket, code: String(d.code || '').replace(/\D/g, '') });
        await otpSucceeded(f);
        enrol = null;
        step = 'done';
      }
    } catch (err) { error = message(err); }
    draw();
  };
  draw();
}
