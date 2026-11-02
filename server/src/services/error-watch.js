/* ==========================================================================
   ECHO ECHO - UNEXPECTED SERVER ERRORS

   Counts 500s in this process and emails the owner when they cluster, so a broken
   release is heard about without anyone reading logs. It holds a route pattern and a
   time, never a request body, a person or an error message. It restarts empty with
   the process, so it complements an external uptime monitor and does not replace one.
   ========================================================================== */
import { alertOwnerAsync } from './alerts.js';

const WINDOW_MS = 5 * 60 * 1000;
const ALERT_AT = 5;
let recent = [];

export function recordServerError(route, now = Date.now()) {
  recent = recent.filter((e) => now - e.at < WINDOW_MS);
  recent.push({ at: now, route: String(route || 'unknown').slice(0, 120) });
  if (recent.length === ALERT_AT) {
    const routes = [...new Set(recent.map((e) => e.route))];
    alertOwnerAsync('server_errors', `${ALERT_AT} server errors in 5 minutes`, ['Routes:', ...routes, '', 'Check System Health and the Render logs.']);
  }
}

export function serverErrorSummary(now = Date.now()) {
  recent = recent.filter((e) => now - e.at < WINDOW_MS);
  return { lastFiveMinutes: recent.length, routes: [...new Set(recent.map((e) => e.route))] };
}

export const resetServerErrors = () => { recent = []; };
