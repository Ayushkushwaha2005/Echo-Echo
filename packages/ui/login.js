/* ==========================================================================
   QUAD — LOGIN GATEWAY

   One gateway for every role. The server decides where you land — there is
   no role picker, because a role is not a client-side choice.

   Two real ways in, and neither ever fakes anything:

     phone → OTP            needs an SMS gateway
     phone → enrolment code needs nothing at all; an administrator issues
                            the code and delivers it in person

   If no SMS provider is configured we do not render a Send OTP button that
   cannot send. We show the enrolment path instead, because it genuinely
   works — which is how staff and administrators can run the platform on a
   deployment with no third-party services whatsoever.
   ========================================================================== */
import { quad, ApiError, Offline } from '../data/client.js';
import { lockup } from '../../brand/logo.js';

/* Server messages and typed input are text, never markup. */
const safe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

export async function mountLogin(root, { onSignedIn, surface = 'admin' } = {}) {
  root.innerHTML = '';
  let status;
  try {
    status = await quad.authStatus();
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

  let phone = '';
  let email = '';
  /* Campus Control leads with the passkey. Counter leads with the enrolment
     code its staff are given. Student-email sign-in is offered on both, for
     an administrator's first set-up or recovery. */
  render(surface === 'admin' ? 'choose' : !status.otp.configured ? 'enrol' : 'phone',
         { smsUnavailable: !status.otp.configured });

  function render(step, ctx = {}) {
    root.innerHTML = '';
    root.append(step === 'phone' ? phoneStep(ctx)
              : step === 'enrol' ? enrolStep({ smsUnavailable: !status.otp.configured, ...ctx })
              : step === 'choose' ? chooseStep(ctx)
              : step === 'email' ? emailStep(ctx)
              : step === 'emailcode' ? emailCodeStep(ctx)
              : codeStep(ctx));
  }

  function chooseStep({ error } = {}) {
    const node = el(`
      <div class="auth-screen">
        <div class="auth-card">
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Campus Control</h1>
          <p class="auth-sub">Sign in with your passkey — fingerprint, face or device PIN.</p>
          ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
          <button class="auth-btn" type="button" data-act="passkey">Sign in with passkey</button>
          <button class="auth-link" type="button" data-act="email">First time or lost your device? Use your student email</button>
          <button class="auth-link" type="button" data-act="enrol">I have an enrolment code</button>
          <p class="auth-fine">Your fingerprint, face and PIN never leave your device. ECHO ECHO stores only a public key.</p>
        </div>
      </div>`);
    node.querySelector('[data-act=email]').onclick = () => render('email');
    node.querySelector('[data-act=enrol]').onclick = () => render('enrol');
    const btn = node.querySelector('[data-act=passkey]');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Waiting for your device…';
      try {
        const { passkeySignIn } = await import('./passkey.js');
        const out = await passkeySignIn();
        onSignedIn ? onSignedIn(out) : (location.href = surfaceUrl(out.surface));
      } catch (err) {
        const { passkeyError } = await import('./passkey.js');
        render('choose', { error: passkeyError(err) });
      }
    };
    return node;
  }

  function emailStep({ error } = {}) {
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Student email</h1>
          <p class="auth-sub">We email a 6-digit code to your university mailbox. Administrators then set up or confirm their passkey.</p>
          <label class="auth-field"><span class="auth-label">University student email</span>
            <input class="auth-input" name="email" type="email" autocomplete="email" autocapitalize="none"
                   spellcheck="false" maxlength="254" placeholder="name.12345@${(status.email?.domains || ['stu.upes.ac.in'])[0]}" value="${safe(email)}"></label>
          ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
          ${status.email?.configured ? '<button class="auth-btn" type="submit">Email me a code</button>'
            : '<p class="auth-error">Email sign-in is not configured on this server.</p>'}
          <button class="auth-link" type="button" data-act="back">Back</button>
        </form>
      </div>`);
    node.querySelector('[data-act=back]').onclick = () => render(surface === 'admin' ? 'choose' : 'enrol');
    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      email = node.querySelector('input').value.trim();
      const btn = node.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Sending…';
      try { const out = await quad.sendEmailCode(email); email = out.email; render('emailcode'); }
      catch (err) { render('email', { error: message(err) }); }
    });
    setTimeout(() => node.querySelector('input').focus(), 0);
    return node;
  }

  function emailCodeStep({ error } = {}) {
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Check your inbox</h1>
          <p class="auth-sub">Enter the 6-digit code sent to <b>${safe(email)}</b>. It expires in 10 minutes.</p>
          <label class="auth-field"><span class="auth-label">Verification code</span>
            <input class="auth-input auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="——————"></label>
          ${error ? `<p class="auth-error" role="alert">${safe(error)}</p>` : ''}
          <button class="auth-btn" type="submit">Verify</button>
          <button class="auth-link" type="button" data-act="back">Use a different email</button>
        </form>
      </div>`);
    node.querySelector('[data-act=back]').onclick = () => render('email');
    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = node.querySelector('input').value.replace(/\D/g, '');
      if (code.length !== 6) return render('emailcode', { error: 'Enter the 6-digit code.' });
      const btn = node.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Verifying…';
      try { const out = await quad.verifyEmailCode(email, code); onSignedIn ? onSignedIn(out) : location.reload(); }
      catch (err) { render('emailcode', { error: message(err) }); }
    });
    setTimeout(() => node.querySelector('input').focus(), 0);
    return node;
  }

  /* The provider-free path. An administrator issues the code and reads it
     out; no SMS gateway is involved at any point. */
  function enrolStep({ error, smsUnavailable } = {}) {
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Enrolment code</h1>
          <p class="auth-sub">
            ${smsUnavailable
              ? 'Text-message sign-in is not available on this deployment. Staff and ' +
                'administrators can sign in with a code issued by an administrator.'
              : 'If an administrator gave you a code, enter it with your number.'}
          </p>
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
          ${error ? `<p class="auth-error">${safe(error)}</p>` : ''}
          <button class="auth-btn" type="submit">Sign in</button>
          ${smsUnavailable ? '' :
            '<button class="auth-link" type="button" data-act="usePhone">Use a text message instead</button>'}
          <p class="auth-fine">Codes work once and expire. Ask an administrator for a new one.</p>
        </form>
      </div>`);

    const [phoneInput, codeInput] = node.querySelectorAll('input');
    const btn = node.querySelector('button[type=submit]');
    node.querySelector('[data-act=usePhone]')?.addEventListener('click', () => render('phone'));

    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      const digits = phoneInput.value.replace(/\D/g, '');
      if (digits.length !== 10) {
        return render('enrol', { error: 'Enter a 10-digit mobile number.', smsUnavailable });
      }
      if (!codeInput.value.trim()) {
        return render('enrol', { error: 'Enter the code you were given.', smsUnavailable });
      }
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const out = await quad.enrol('+91' + digits, codeInput.value);
        onSignedIn ? onSignedIn(out) : (location.href = surfaceUrl(out.surface));
      } catch (err) {
        render('enrol', { error: message(err), smsUnavailable });
      }
    });
    setTimeout(() => phoneInput.focus(), 0);
    return node;
  }

  function phoneStep({ error } = {}) {
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Welcome</h1>
          <p class="auth-sub">Continue with your phone number.</p>
          <label class="auth-field">
            <span class="auth-label">Mobile number</span>
            <div class="auth-phone">
              <span class="auth-cc">+91</span>
              <input class="auth-input" name="phone" type="tel" inputmode="numeric"
                     autocomplete="tel" maxlength="10" placeholder="00000 00000" required>
            </div>
          </label>
          ${error ? `<p class="auth-error">${safe(error)}</p>` : ''}
          <button class="auth-btn" type="submit">Send OTP</button>
          <p class="auth-fine">You'll get a 6-digit code by SMS. Standard rates apply.</p>
          <button class="auth-link" type="button" data-act="useEnrol">I have an enrolment code</button>
        </form>
      </div>`);

    const input = node.querySelector('input');
    const btn = node.querySelector('button[type=submit]');
    node.querySelector('[data-act=useEnrol]').addEventListener('click', () => render('enrol'));
    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      const digits = input.value.replace(/\D/g, '');
      if (digits.length !== 10) return render('phone', { error: 'Enter a 10-digit mobile number.' });
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        phone = '+91' + digits;
        const out = await quad.sendOtp(phone);
        render('code', { resendAfter: out.resendAfterSeconds });
      } catch (err) {
        render('phone', { error: message(err) });
      }
    });
    setTimeout(() => input.focus(), 0);
    return node;
  }

  function codeStep({ error, resendAfter = 45 } = {}) {
    const pretty = phone.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2');
    const node = el(`
      <div class="auth-screen">
        <form class="auth-card" novalidate>
          ${lockup({ height: 30 })}
          <h1 class="auth-title">Verify your number</h1>
          <p class="auth-sub">We sent a 6-digit code to <b>${safe(pretty)}</b>.</p>
          <label class="auth-field">
            <span class="auth-label">Verification code</span>
            <input class="auth-input auth-code" name="code" inputmode="numeric"
                   autocomplete="one-time-code" maxlength="6" placeholder="——————" required>
          </label>
          ${error ? `<p class="auth-error">${safe(error)}</p>` : ''}
          <button class="auth-btn" type="submit">Verify</button>
          <div class="auth-alt">
            <button class="auth-link" type="button" data-act="back">Change number</button>
            <button class="auth-link" type="button" data-act="resend" disabled>Resend in ${resendAfter}s</button>
          </div>
        </form>
      </div>`);

    const input = node.querySelector('input');
    const btn = node.querySelector('button[type=submit]');
    const resend = node.querySelector('[data-act=resend]');

    let left = resendAfter;
    const tick = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(tick); resend.disabled = false; resend.textContent = 'Resend code'; }
      else resend.textContent = `Resend in ${left}s`;
    }, 1000);

    node.querySelector('[data-act=back]').onclick = () => { clearInterval(tick); render('phone'); };
    resend.onclick = async () => {
      resend.disabled = true;
      try { const out = await quad.sendOtp(phone); clearInterval(tick); render('code', { resendAfter: out.resendAfterSeconds }); }
      catch (err) { clearInterval(tick); render('code', { error: message(err) }); }
    };

    node.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = input.value.replace(/\D/g, '');
      if (code.length !== 6) return render('code', { error: 'Enter the 6-digit code.', resendAfter: left });
      btn.disabled = true; btn.textContent = 'Verifying…';
      try {
        const out = await quad.verifyOtp(phone, code);
        clearInterval(tick);
        /* The server said where this account belongs. The client obeys. */
        onSignedIn ? onSignedIn(out) : (location.href = surfaceUrl(out.surface));
      } catch (err) {
        render('code', { error: message(err), resendAfter: left });
      }
    });
    setTimeout(() => input.focus(), 0);
    return node;
  }
}

const surfaceUrl = (s) => ({ admin: '../admin/', counter: '../shop/', web: '../web/' }[s] || '../web/');

function message(err) {
  if (err instanceof Offline) return 'Cannot reach the ECHO ECHO server.';
  if (err instanceof ApiError) return err.detail ? `${err.message} — ${err.detail}` : err.message;
  return err.message || 'Something went wrong.';
}
