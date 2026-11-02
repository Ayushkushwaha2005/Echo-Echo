/* ==========================================================================
   ECHO ECHO - SESSION DISPLAY HELPERS

   A readable device name from a browser string, for people looking at their
   sessions. It is a label, not evidence: a client can send any browser string.
   ========================================================================== */
import { createHash } from 'node:crypto';

/* Identifies one session to the screen without revealing its token or its
   stored hash, and cannot be turned back into either. */
export const sessionHandle = (tokenHash) =>
  createHash('sha256').update(`session-handle:${tokenHash}`).digest('hex').slice(0, 20);

export function deviceName(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux' : 'Unknown system';
  return `${browser} on ${os}`;
}
