/* ==========================================================================
   ECHO ECHO — SIGN IN

   One way in per audience, and the server decides where you land. There is
   no role picker here, because a role is not a client-side choice.

     Campus Control   email → password → authenticator code
     Counter          the enrolment code an administrator reads out
     Student site     handled by web/src/app.js: college → campus →
                      university email → code → live location

   What used to be here and is gone: phone numbers, SMS codes, passkeys, and
   the choice between three ways in on one screen. Every one of them was a
   second door onto a surface that only needs one.
   ========================================================================== */
import { quad, ApiError, Offline } from '../data/client.js';
import { lockup } from '../../brand/logo.js';

/* Server messages and typed input are text, never markup. */
const safe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

export async function mountLogin(root, { onSignedIn, surface = 'admin' } = {}) {
  root.innerHTML = '';
  let adminStatus = null;
  try {
    if (surface === 'admin') adminStatus = await quad.adminAuthStatus();
    else await quad.authStatus();
  } catch (e) {
    root.append(el(`
      <div class="auth-screen">
        <div class="auth-card">
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Can't reach ECHO ECHO</h1>
          <p class="auth-sub">${e instanceof Offline
            ? 'The ECHO ECHO server is not responding. Check that it is running and try again.'
            : safe(e.message)}</p>
        </div>
      </div>`));
    return;
  }

  let email = '';
  /* Stage-one proof and the reset token. Both are short-lived, single-use and
     worth nothing alone, and both stay in this closure - never in storage. */
  let challenge = null;
  let resetToken = null;

  const SCREENS = {
    admin: adminStep,
    code: codeStep,
    'reset-email': resetEmailStep,
    'reset-code': resetCodeStep,
    'reset-new': resetNewStep,
    enrol: enrolStep,
  };

  render(surface === 'admin' ? 'admin' : 'enrol');

  function render(step, ctx = {}) {
    root.innerHTML = '';
    root.append((SCREENS[step] || adminStep)(ctx));
  }

  /* ---------- Campus Control ----------------------------------------------
     Two screens, in this order and no other:

       1. email + password   -> a short-lived challenge, no session
       2. authenticator code -> the session

     Neither screen alone gets anyone in. The challenge lives in this
     closure: it is not a session, and writing it to storage would leave half
     a sign-in lying around after the tab is closed. */
  function adminStep({ error } = {}) {
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Campus Control</h1>
          <p class="auth-sub">Sign in with your administrator email and password.</p>

          <label class="auth-field"><span class="auth-label">Administrator email</span>
            <input class="auth-input" name="email" type="email" autocomplete="username"
                   autocapitalize="none" spellcheck="false" maxlength="254"
                   placeholder="you@stu.upes.ac.in" value="${safe(email)}" required></label>

          <label class="auth-field"><span class="auth-label">Password</span>
            <input class="auth-input" name="password" type="password" autocomplete="current-password"
                   maxlength="200" required></label>

          ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
          ${adminStatus && adminStatus.configured === false
            ? `<p class="auth-error">Administrator sign-in is not available on this server.</p>`
            : '<button class="auth-btn" type="submit">Continue</button>'}
          <button class="auth-link" type="button" data-act="forgot">Forgot password?</button>
        </form>
      </div>`);

    const [emailInput, pwInput] = node.querySelectorAll('input');
    node.querySelector('[data-act=forgot]').addEventListener('click', () => {
      email = emailInput.value.trim() || email;
      render('reset-email');
    });
    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      email = emailInput.value.trim();
      if (!email || !pwInput.value) return render('admin', { error: 'Enter your email and password.' });
      const btn = node.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        const out = await quad.adminPasswordStage(email, pwInput.value);
        challenge = out.challenge;
        render('code');
      } catch (err) {
        render('admin', { error: message(err) });
      }
    });
    setTimeout(() => (email ? pwInput : emailInput).focus(), 0);
    return node;
  }

  /* Screen 2. The account was settled by the password step, so there is
     nothing to name here - only a code to produce. */
  function codeStep({ error } = {}) {
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Authenticator code</h1>
          <p class="auth-sub">Enter the 6-digit code for ${safe(email)} from your authenticator app.</p>

          <label class="auth-field"><span class="auth-label">6-digit code</span>
            <input class="auth-input auth-code" name="code" inputmode="numeric" autocomplete="one-time-code"
                   maxlength="6" placeholder="——————" required></label>

          ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
          <button class="auth-btn" type="submit">Sign in</button>
          <button class="auth-link" type="button" data-act="back">Back</button>
        </form>
      </div>`);

    const codeInput = node.querySelector('input');
    node.querySelector('[data-act=back]').addEventListener('click', () => { challenge = null; render('admin'); });
    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = codeInput.value.replace(/\D/g, '');
      if (code.length !== 6) return render('code', { error: 'Enter the 6-digit code from your authenticator app.' });
      const btn = node.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const out = await quad.adminLogin(challenge, code);
        challenge = null;
        onSignedIn ? onSignedIn(out) : (location.href = surfaceUrl(out.surface));
      } catch (err) {
        /* A challenge that has timed out or run out of attempts is spent, and
           the only way on is to prove the password again. */
        if (err instanceof ApiError && /timed out|attempts/i.test(`${err.message} ${err.detail || ''}`)) {
          challenge = null;
          return render('admin', { error: message(err) });
        }
        render('code', { error: message(err) });
      }
    });
    setTimeout(() => codeInput.focus(), 0);
    return node;
  }

  /* ---------- Forgot password ---------------------------------------------
     A code to the institutional mailbox, then a new password. It never opens
     a session: it ends back at screen 1, where both factors are still
     required. The screen says the same thing whether or not the address
     belongs to an administrator, because the server does too. */
  function resetEmailStep({ error, notice } = {}) {
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Reset your password</h1>
          <p class="auth-sub">We will email a code to your administrator address.</p>

          <label class="auth-field"><span class="auth-label">Administrator email</span>
            <input class="auth-input" name="email" type="email" autocomplete="username"
                   autocapitalize="none" spellcheck="false" maxlength="254"
                   value="${safe(email)}" required></label>

          ${notice ? `<p class="auth-note">${safe(notice)}</p>` : ''}
          ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
          <button class="auth-btn" type="submit">Send code</button>
          <button class="auth-link" type="button" data-act="back">Back to sign in</button>
        </form>
      </div>`);

    const emailInput = node.querySelector('input');
    node.querySelector('[data-act=back]').addEventListener('click', () => render('admin'));
    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      email = emailInput.value.trim();
      if (!email) return render('reset-email', { error: 'Enter your administrator email.' });
      const btn = node.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const out = await quad.adminResetRequest(email);
        render('reset-code', { notice: out.message });
      } catch (err) {
        render('reset-email', { error: message(err) });
      }
    });
    setTimeout(() => emailInput.focus(), 0);
    return node;
  }

  function resetCodeStep({ error, notice } = {}) {
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Check your inbox</h1>
          <p class="auth-sub">${safe(notice || `Enter the code we sent to ${email}.`)}</p>

          <label class="auth-field"><span class="auth-label">6-digit code</span>
            <input class="auth-input auth-code" name="code" inputmode="numeric" autocomplete="one-time-code"
                   maxlength="6" placeholder="——————" required></label>

          ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
          <button class="auth-btn" type="submit">Continue</button>
          <button class="auth-link" type="button" data-act="back">Back to sign in</button>
        </form>
      </div>`);

    const codeInput = node.querySelector('input');
    node.querySelector('[data-act=back]').addEventListener('click', () => render('admin'));
    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = codeInput.value.replace(/\D/g, '');
      if (code.length !== 6) return render('reset-code', { error: 'Enter the 6-digit code from the email.' });
      const btn = node.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        const out = await quad.adminResetVerify(email, code);
        resetToken = out.token;
        render('reset-new');
      } catch (err) {
        render('reset-code', { error: message(err) });
      }
    });
    setTimeout(() => codeInput.focus(), 0);
    return node;
  }

  function resetNewStep({ error } = {}) {
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Choose a new password</h1>
          <p class="auth-sub">At least 12 characters. You will still need your authenticator code to sign in.</p>

          <label class="auth-field"><span class="auth-label">New password</span>
            <input class="auth-input" name="password" type="password" autocomplete="new-password"
                   maxlength="200" required></label>
          <label class="auth-field"><span class="auth-label">New password again</span>
            <input class="auth-input" name="again" type="password" autocomplete="new-password"
                   maxlength="200" required></label>

          ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
          <button class="auth-btn" type="submit">Save password</button>
          <button class="auth-link" type="button" data-act="back">Back to sign in</button>
        </form>
      </div>`);

    const [pw, again] = node.querySelectorAll('input');
    node.querySelector('[data-act=back]').addEventListener('click', () => { resetToken = null; render('admin'); });
    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (pw.value !== again.value) return render('reset-new', { error: 'The two passwords do not match.' });
      const btn = node.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const out = await quad.adminResetComplete(resetToken, pw.value);
        resetToken = null;
        render('admin', { error: out.message });
      } catch (err) {
        render('reset-new', { error: message(err) });
      }
    });
    setTimeout(() => pw.focus(), 0);
    return node;
  }

  /* ---------- Counter -----------------------------------------------------
     Cafeteria staff, and only cafeteria staff. The code is issued by an
     administrator and read out; no SMS gateway and no mailbox is involved,
     which is what lets a counter open on a deployment with no third-party
     services at all. */
  function enrolStep({ error } = {}) {
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Counter sign-in</h1>
          <p class="auth-sub">Enter the number and code your campus administrator gave you.</p>
          <label class="auth-field">
            <span class="auth-label">Mobile number</span>
            <div class="auth-phone">
              <span class="auth-cc">+91</span>
              <input class="auth-input" name="phone" type="tel" inputmode="numeric"
                     autocomplete="tel" maxlength="10" placeholder="00000 00000" required>
            </div>
          </label>
          <label class="auth-field">
            <span class="auth-label">Enrolment code</span>
            <input class="auth-input auth-enrol" name="code" autocomplete="one-time-code"
                   maxlength="14" placeholder="XXXX-XXXX-XXXX" required>
          </label>
          ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
          <button class="auth-btn" type="submit">Sign in</button>
          <p class="auth-fine">Each code works once and then expires. Ask your administrator for a new one.</p>
        </form>
      </div>`);

    const [phoneInput, codeInput] = node.querySelectorAll('input');
    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      const digits = phoneInput.value.replace(/\D/g, '');
      if (digits.length !== 10) return render('enrol', { error: 'Enter a 10-digit mobile number.' });
      if (!codeInput.value.trim()) return render('enrol', { error: 'Enter the code you were given.' });
      const btn = node.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const out = await quad.enrol('+91' + digits, codeInput.value);
        onSignedIn ? onSignedIn(out) : (location.href = surfaceUrl(out.surface));
      } catch (err) {
        render('enrol', { error: message(err) });
      }
    });
    setTimeout(() => phoneInput.focus(), 0);
    return node;
  }
}

const surfaceUrl = (s) => ({ admin: '../admin/', counter: '../shop/', web: '../web/' }[s] || '../web/');

function message(err) {
  if (err instanceof Offline) return 'Cannot reach the ECHO ECHO server.';
  if (err instanceof ApiError) return err.detail ? `${err.message} — ${err.detail}` : err.message;
  return err.message || 'Something went wrong.';
}
