/* ==========================================================================
   ECHO ECHO — ACCEPTING A CAMPUS CONTROL INVITATION

   Where an invitation link lands. The token is in the URL fragment, which no
   browser sends to any server, and this page removes it from the address bar
   and history as soon as it has read it.

     email code → what you are being given → password → authenticator → done

   Every step is decided by the server (routes/admin-invitation.js). Nothing
   here grants anything, and neither the password nor the key is kept: they
   are gone from this page once the server has taken them. Finishing opens no
   session; the person then signs in like any other administrator.
   ========================================================================== */
import { quad, ApiError } from '../data/client.js';
import { lockup } from '../../brand/logo.js';
import { qrSvg, groupKey } from './admin-enrol.js';
import { passwordStrength } from './password-strength.js';

const safe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const message = (e) => (e instanceof ApiError ? (e.detail ? `${e.message} — ${e.detail}` : e.message) : e?.message || 'Something went wrong. Try again.');
const ROLE_NAMES = { platform_admin: 'Administrator', support: 'Support' };

/** The token in a location hash, or null. Exported so it can be tested. */
export function inviteTokenFrom(hash) {
  const m = /^#invite=([\w-]{40,64})$/.exec(String(hash || ''));
  return m ? m[1] : null;
}

export async function mountAdminInvite(root, { token, onDone }) {
  /* Out of the address bar, the history entry and any screenshot of the URL. */
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* still works without it */ }

  let step = 'opening';
  let error = '';
  let opened = null;
  let details = null;
  let setup = null;
  let enrol = null;
  let busy = false;

  const errorLine = () => (error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : '');

  const body = () => {
    switch (step) {
      case 'opening':
        return `<h1 class="auth-title">Opening your invitation…</h1>`;
      case 'dead':
        return `<h1 class="auth-title">This invitation can't be used</h1>
          <p class="auth-sub">${safe(error)}</p>
          <button class="auth-btn" data-inv="signin">Go to Campus Control sign-in</button>`;
      case 'email':
        return `<h1 class="auth-title">You've been invited to Campus Control</h1>
          <p class="auth-sub">First, confirm this is your mailbox. We'll send a 6-digit code to <b>${safe(opened.email)}</b>.</p>
          ${errorLine()}
          <button class="auth-btn" data-inv="send" ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : 'Email me a code'}</button>`;
      case 'code':
        return `<h1 class="auth-title">Enter the code</h1>
          <p class="auth-sub">We sent a 6-digit code to <b>${safe(opened.email)}</b>. It expires in 10 minutes.</p>
          <form class="stack" data-inv-form="code" novalidate>
            <label class="auth-field"><span class="auth-label">Code from your email</span>
              <input class="auth-input auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
            ${errorLine()}
            <button class="auth-btn" type="submit" ${busy ? 'disabled' : ''}>Continue</button>
          </form>
          <button class="auth-link" data-inv="send">Send another code</button>`;
      case 'review': {
        const groups = {};
        for (const p of details.permissions) (groups[p.group] ||= []).push(p.label);
        return `<h1 class="auth-title">Review your access</h1>
          <dl class="invite-facts">
            <dt>Invited by</dt><dd>${safe(details.invitedBy)}</dd>
            <dt>Your email</dt><dd>${safe(details.email)}</dd>
            <dt>Role</dt><dd>${safe(ROLE_NAMES[details.role] || details.role)}</dd>
          </dl>
          <h2 class="auth-label">You will be able to</h2>
          ${Object.entries(groups).map(([g, items]) => `<p class="auth-fine"><b>${safe(g)}</b></p>
            <ul class="invite-perms">${items.map((l) => `<li>${safe(l)}</li>`).join('')}</ul>`).join('')}
          ${errorLine()}
          <button class="auth-btn" data-inv="accept" ${busy ? 'disabled' : ''}>Accept this invitation</button>
          <p class="auth-fine">If this looks wrong, close this page and nothing happens. Your access starts only when you finish every step.</p>`;
      }
      case 'password':
        return `<h1 class="auth-title">Choose a password</h1>
          <p class="auth-sub">At least 12 characters; a few unrelated words work well. It is never emailed and only you know it.</p>
          <form class="stack" data-inv-form="password" novalidate>
            <label class="auth-field"><span class="auth-label">New password</span>
              <input class="auth-input" type="password" name="password" autocomplete="new-password" minlength="12" required aria-describedby="invite-strength"></label>
            <p class="auth-fine" id="invite-strength" aria-live="polite"></p>
            <label class="auth-field"><span class="auth-label">Type it again</span>
              <input class="auth-input" type="password" name="again" autocomplete="new-password" minlength="12" required></label>
            ${errorLine()}
            <button class="auth-btn" type="submit" ${busy ? 'disabled' : ''}>Save password</button>
          </form>`;
      case 'authenticator':
        return enrol ? `<h1 class="auth-title">Add your authenticator</h1>
          <p class="auth-sub">In an authenticator app such as Microsoft Authenticator, choose <b>Add account → Other account</b> and scan this code.</p>
          <div class="enrol-qr" aria-label="QR code for your authenticator app">${enrol.qr || '<p class="auth-fine">The QR code could not be drawn here. Use the key below.</p>'}</div>
          <details class="enrol-key"><summary>Can't scan? Enter the key instead</summary>
            <p class="auth-fine">Choose <b>Enter code manually</b>. Account name: ${safe(enrol.issuer)}. Time-based, 6 digits.</p>
            <code class="enrol-secret">${safe(groupKey(enrol.secret))}</code></details>
          <form class="stack" data-inv-form="complete" novalidate>
            <label class="auth-field"><span class="auth-label">The 6-digit code the app shows now</span>
              <input class="auth-input auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></label>
            ${errorLine()}
            <button class="auth-btn" type="submit" ${busy ? 'disabled' : ''}>Finish setup</button>
          </form>` : `<h1 class="auth-title">Add your authenticator</h1>
          <p class="auth-sub">Campus Control asks for a 6-digit code from an authenticator app every time you sign in. Have the app ready on your phone.</p>
          ${errorLine()}
          <button class="auth-btn" data-inv="begin" ${busy ? 'disabled' : ''}>Show my QR code</button>`;
      default:
        return `<h1 class="auth-title">You're all set</h1>
          <p class="auth-sub">Your administrator account is active. Sign in with <b>${safe(details?.email)}</b>, your password and the code from your authenticator app.</p>
          <button class="auth-btn" data-inv="signin">Go to Campus Control sign-in</button>`;
    }
  };

  const draw = () => {
    root.innerHTML = `<div class="auth-screen"><div class="auth-card enrol-card">${lockup({ height: 28 })}${body()}</div></div>`;
    const first = root.querySelector('input:not([type=hidden])');
    if (first) first.focus();
    else root.querySelector('.auth-error, .auth-title')?.setAttribute('tabindex', '-1');
  };

  const run = async (fn) => {
    busy = true; error = ''; draw();
    try { await fn(); } catch (e) {
      /* Revoked or expired underneath them: say so rather than leave a form. */
      if (e instanceof ApiError && e.status === 410) step = 'dead';
      error = message(e);
    }
    busy = false; draw();
  };

  root.onclick = (e) => {
    const b = e.target.closest('[data-inv]');
    if (!b || b.disabled) return;
    const act = b.dataset.inv;
    if (act === 'signin') { onDone?.(); return; }
    if (act === 'send') run(async () => { await quad.invitationSendCode(token); step = 'code'; });
    if (act === 'accept') run(async () => { await quad.invitationAccept(token, setup); step = 'password'; });
    if (act === 'begin') {
      run(async () => {
        const out = await quad.invitationBeginAuthenticator(token, setup);
        enrol = { secret: out.secret, issuer: out.issuer, qr: await qrSvg(out.uri) };
      });
    }
  };

  root.oninput = (e) => {
    if (e.target.name !== 'password') return;
    const hint = root.querySelector('#invite-strength');
    if (hint) hint.textContent = passwordStrength(e.target.value).label;
  };

  root.onsubmit = (e) => {
    const f = e.target.closest('[data-inv-form]');
    if (!f) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f));
    f.reset();
    run(async () => {
      if (f.dataset.invForm === 'code') {
        const code = String(data.code || '').replace(/\D/g, '');
        if (code.length !== 6) throw new Error('Enter the 6 digits from your email.');
        const out = await quad.invitationVerifyCode(token, code);
        setup = out.setup; details = out; step = 'review';
      } else if (f.dataset.invForm === 'password') {
        if (data.password !== data.again) throw new Error('The two passwords are not the same.');
        await quad.invitationSetPassword(token, setup, data.password);
        step = 'authenticator';
      } else {
        const code = String(data.code || '').replace(/\D/g, '');
        if (code.length !== 6) throw new Error('Enter the 6 digits the app is showing.');
        await quad.invitationComplete(token, setup, code);
        enrol = null; step = 'done';
      }
    });
  };

  draw();
  try {
    opened = await quad.invitationOpen(token);
    step = 'email';
  } catch (e) {
    step = 'dead';
    error = message(e);
  }
  draw();
}
