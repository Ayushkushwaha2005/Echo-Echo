/* ==========================================================================
   ECHO ECHO — WHAT A FAILED REQUEST MEANS, AND WHETHER TO TRY AGAIN

     failure(e, what)        -> { kind, title, detail, retryable, status }
     retrying(fn, options)   -> fn's answer, after at most `attempts` tries

   A screen that says "Cannot reach the server" for every problem leaves the
   person guessing, and a Try again that cannot help (an expired session, a
   refusal, a missing route) is a broken button. So each failure is named for
   what it is - no connection, the server is waking up or slow, signed out,
   not allowed, an endpoint this server does not have, a server error - and
   only the ones another attempt can fix are retried.

   Retries are bounded (a few attempts, doubling waits with jitter, capped),
   cancellable, and never a loop: once they run out the screen says so and
   offers Try again, and recovers by itself only on a real signal (the
   connection coming back, the page becoming visible, the next refresh).
   ========================================================================== */
import { ApiError, Offline } from './client.js';

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function failure(e, what = 'this') {
  if (e instanceof Offline) {
    if (e.code === 'cancelled') return { kind: 'cancelled', title: 'Cancelled', detail: '', retryable: false };
    if (e.code === 'timeout') {
      return { kind: 'timeout', retryable: true, title: 'The ECHO ECHO server is taking too long to answer',
        detail: `It may be starting up after a quiet period, which can take a little while. ${what} will load as soon as it answers.` };
    }
    return { kind: 'offline', retryable: true, title: 'Cannot reach the ECHO ECHO server',
      detail: 'Check your internet connection. This tries again by itself when the connection is back.' };
  }
  if (e instanceof ApiError) {
    const s = e.status;
    if (s === 401 || e.code === 'unauthenticated' || e.code === 'admin_signin_required') {
      return { kind: 'signed_out', status: s, retryable: false, title: 'Your session has ended',
        detail: 'Sign in again to continue. Nothing you had already sent is lost.' };
    }
    if (s === 403) {
      return { kind: 'forbidden', status: s, retryable: false, title: e.message || 'You do not have access to this',
        detail: e.detail || 'Your account is not allowed to see this. An administrator can change your access.' };
    }
    if (s === 404 && e.code === 'route_missing') {
      return { kind: 'missing', status: s, retryable: false, title: e.message, detail: e.detail || '' };
    }
    if (s === 404 && e.code?.startsWith?.('http_')) {
      return { kind: 'missing', status: s, retryable: false, title: `ECHO ECHO could not find ${what.toLowerCase()} (404)`,
        detail: 'The address answered, but not with the ECHO ECHO server. The API address this page uses may be misconfigured.' };
    }
    if (RETRY_STATUS.has(s)) {
      return { kind: 'server', status: s, retryable: true,
        title: s >= 502 ? `ECHO ECHO is temporarily unavailable (${s})` : s === 429 ? 'Too many requests just now' : `Something went wrong on the server (${s})`,
        detail: e.detail || 'This is on our side, not yours. It tries again by itself.' };
    }
    return { kind: 'refused', status: s, retryable: false, title: e.message, detail: e.detail || '' };
  }
  return { kind: 'unknown', retryable: false, title: e?.message || 'Something went wrong', detail: '' };
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new Offline('Request cancelled', 'cancelled')); }, { once: true });
});

/** Calls fn(attempt) until it answers, a failure is not retryable, or the attempts run out. */
export async function retrying(fn, { attempts = 3, baseMs = 1000, maxMs = 8000, signal, onRetry, sleep = pause, what } = {}) {
  for (let n = 1; ; n++) {
    if (signal?.aborted) throw new Offline('Request cancelled', 'cancelled');
    try {
      return await fn(n);
    } catch (e) {
      const f = failure(e, what);
      if (!f.retryable || n >= attempts || signal?.aborted) throw e;
      const wait = Math.min(maxMs, baseMs * 2 ** (n - 1)) * (0.75 + Math.random() * 0.5);
      onRetry?.({ attempt: n + 1, of: attempts, waitMs: Math.round(wait), failure: f });
      await sleep(wait, signal);
    }
  }
}
