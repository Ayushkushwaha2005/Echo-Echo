/* ==========================================================================
   ECHO ECHO — PASSKEYS IN THE BROWSER

   The browser's WebAuthn API does the work: it asks the device to verify the
   person (fingerprint, face, Windows Hello, device PIN) and returns a signed
   response. This module only converts between the server's JSON and the
   binary shapes navigator.credentials expects, and renders the step.
   Nothing biometric is ever seen by this code or sent anywhere.
   ========================================================================== */
import { quad, ApiError } from '../data/client.js';
import { esc } from './kit.js';
import { lockup } from '../../brand/logo.js';

const toBuf = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0)).buffer;
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysSupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

function assertionJSON(cred) {
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
    response: {
      clientDataJSON: toB64u(cred.response.clientDataJSON),
      authenticatorData: toB64u(cred.response.authenticatorData),
      signature: toB64u(cred.response.signature),
      userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : null,
    },
  };
}

async function getAssertion(opts) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: toBuf(opts.challenge), rpId: opts.rpId, timeout: opts.timeout,
      userVerification: opts.userVerification,
      allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
    },
  });
  if (!cred) throw new Error('No passkey was used');
  return assertionJSON(cred);
}

/* Human wording for the errors the WebAuthn API throws. */
export function passkeyError(e) {
  if (e instanceof ApiError) return e.detail ? `${e.message} — ${e.detail}` : e.message;
  if (e?.name === 'NotAllowedError') return 'The passkey request was cancelled or timed out.';
  if (e?.name === 'InvalidStateError') return 'This device already has a passkey for this account.';
  if (e?.name === 'SecurityError') return 'Passkeys only work on the official ECHO ECHO address over HTTPS.';
  return e?.message || 'The passkey could not be used.';
}

export async function passkeySignIn() {
  const opts = await quad.passkeyLoginOptions();
  return quad.passkeyLoginVerify(await getAssertion(opts));
}

export async function passkeyReauth() {
  const opts = await quad.passkeyReauthOptions();
  return quad.passkeyReauthVerify(await getAssertion(opts));
}

export async function registerPasskey({ inviteCode, label }) {
  const o = await quad.passkeyRegisterOptions(inviteCode);
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: toBuf(o.challenge), rp: o.rp,
      user: { ...o.user, id: toBuf(o.user.id) },
      pubKeyCredParams: o.pubKeyCredParams, timeout: o.timeout, attestation: o.attestation,
      authenticatorSelection: o.authenticatorSelection,
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
    },
  });
  if (!cred) throw new Error('No passkey was created');
  return quad.passkeyRegisterVerify({
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type,
    response: {
      clientDataJSON: toB64u(cred.response.clientDataJSON),
      attestationObject: toB64u(cred.response.attestationObject),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
  }, { inviteCode, label });
}

const guessLabel = () => {
  const ua = navigator.userAgent || '';
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android'
    : /Mac OS/.test(ua) ? 'Mac' : 'This device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '';
  return `${os}${br ? ` · ${br}` : ''}`;
};

/**
 * The step between an email-code sign-in and Campus Control: confirm with an
 * existing passkey, set up the first one with an invite, or recover.
 */
export async function mountPasskeyStep(root, { onDone }) {
  let status;
  try { status = await quad.passkeyStatus(); } catch (e) { status = { error: passkeyError(e) }; }
  let mode = status.recoverySession ? 'register' : status.credentials?.length ? 'confirm' : 'register';
  let error = status.error || '';
  let codes = null;

  const draw = () => {
    const unsupported = !passkeysSupported();
    root.innerHTML = `
      <div class="auth-screen"><div class="auth-card">
        ${lockup({ height: 28 })}
        ${codes ? `
          <h1 class="auth-title">Save your recovery codes</h1>
          <p class="auth-sub">Each code works once, only to set up a new passkey if you lose this device. Store them offline — they are not shown again.</p>
          <div class="sunken" style="padding:14px;display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;font-family:var(--font-mono);font-size:.95rem" aria-label="Recovery codes">
            ${codes.map((c) => `<span>${esc(c)}</span>`).join('')}
          </div>
          <label class="row" style="gap:8px;margin-top:12px;align-items:flex-start"><input type="checkbox" id="pk-saved" style="margin-top:3px">
            <span class="t-sm">I have saved these codes somewhere safe.</span></label>
          <button class="auth-btn" data-pk="continue" disabled>Continue to Campus Control</button>`
        : mode === 'confirm' ? `
          <h1 class="auth-title">Confirm it is you</h1>
          <p class="auth-sub">Campus Control needs your passkey — your fingerprint, face or device PIN. It never leaves this device.</p>
          ${error ? `<p class="auth-error" role="alert">${esc(error)}</p>` : ''}
          <button class="auth-btn" data-pk="confirm" ${unsupported ? 'disabled' : ''}>Use my passkey</button>
          <button class="auth-link" data-pk="to-recover">I lost my passkey device</button>`
        : mode === 'recover' ? `
          <h1 class="auth-title">Use a recovery code</h1>
          <p class="auth-sub">Enter one of the recovery codes you saved when you first set up your passkey. You will then register a new passkey, and the old ones stop working.</p>
          <label class="auth-field"><span class="auth-label">Recovery code</span>
            <input class="auth-input" id="pk-recovery" autocomplete="off" autocapitalize="characters" maxlength="11" placeholder="XXXXX-XXXXX"></label>
          ${error ? `<p class="auth-error" role="alert">${esc(error)}</p>` : ''}
          <button class="auth-btn" data-pk="recover">Continue</button>
          <button class="auth-link" data-pk="to-confirm">Back</button>`
        : `
          <h1 class="auth-title">${status.recoverySession ? 'Set up a new passkey' : 'Set up your passkey'}</h1>
          <p class="auth-sub">${status.recoverySession
            ? 'Recovery accepted. Register a passkey on this device now; your previous passkeys will be revoked.'
            : 'Administrators sign in with a passkey. Enter the one-time invite code you were given, then confirm with your fingerprint, face or device PIN.'}</p>
          ${status.recoverySession ? '' : `<label class="auth-field"><span class="auth-label">Invite code</span>
            <input class="auth-input" id="pk-invite" autocomplete="one-time-code" autocapitalize="characters" maxlength="14" placeholder="XXXX-XXXX-XXXX"></label>`}
          <label class="auth-field"><span class="auth-label">Name this device</span>
            <input class="auth-input" id="pk-label" maxlength="60" value="${esc(guessLabel())}"></label>
          ${error ? `<p class="auth-error" role="alert">${esc(error)}</p>` : ''}
          <button class="auth-btn" data-pk="register" ${unsupported ? 'disabled' : ''}>Create passkey</button>
          ${status.recoverySession ? '' : '<button class="auth-link" data-pk="to-recover">I already had a passkey and lost it</button>'}`}
        ${unsupported && !codes ? '<p class="auth-fine">This browser does not support passkeys. Use a current version of Chrome, Edge, Safari or Firefox.</p>' : ''}
        <button class="auth-link" data-pk="signout">Sign out</button>
      </div></div>`;
    root.querySelector('#pk-saved')?.addEventListener('change', (e) => {
      root.querySelector('[data-pk=continue]').disabled = !e.target.checked;
    });
  };

  root.onclick = async (e) => {
    const b = e.target.closest('[data-pk]');
    if (!b || b.disabled) return;
    const act = b.dataset.pk;
    if (act === 'signout') { await quad.logout().catch(() => {}); return location.reload(); }
    if (act === 'continue') return onDone();
    if (act.startsWith('to-')) { mode = act.slice(3); error = ''; return draw(); }
    const label = b.textContent; b.disabled = true; b.textContent = 'Waiting for your device…';
    try {
      if (act === 'confirm') { await passkeyReauth(); return onDone(); }
      if (act === 'recover') {
        await quad.recoveryVerify(root.querySelector('#pk-recovery').value);
        status = await quad.passkeyStatus(); mode = 'register'; error = ''; return draw();
      }
      if (act === 'register') {
        const out = await registerPasskey({
          inviteCode: root.querySelector('#pk-invite')?.value || undefined,
          label: root.querySelector('#pk-label').value,
        });
        if (out.recoveryCodes) { codes = out.recoveryCodes; return draw(); }
        return onDone();
      }
    } catch (err) {
      error = passkeyError(err); b.disabled = false; b.textContent = label; draw();
    }
  };
  draw();
}
