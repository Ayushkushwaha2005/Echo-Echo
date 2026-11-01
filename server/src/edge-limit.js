/* ==========================================================================
   ECHO ECHO — THE EDGE LIMIT

   Every per-IP rate limit keys on req.ip, which behind TRUST_PROXY=true is
   the LEFT-MOST X-Forwarded-For entry. Measured on 14 Oct 2026 against the
   live API: a request sent straight to the Render hostname with a forged
   X-Forwarded-For lands in a fresh bucket every time, so the per-IP limits
   on sign-in codes could be sidestepped by changing one header.

   That key is still right for an honest browser (it is the student's own
   address when the request came through Vercel, which overwrites the
   header), so it stays. This adds a second, looser limit on the same
   routes keyed by the address the EDGE vouches for: the header named in
   EDGE_CLIENT_IP_HEADER (on Render, Cloudflare's cf-connecting-ip, which a
   client cannot set: Cloudflare refused a forged one with 403). A caller
   who forges X-Forwarded-For gets fresh inner buckets but always the same
   edge bucket, so the most it can send is the edge cap, not unlimited.

   With no header configured, or the header absent on a request, the edge
   key falls back to req.ip: exactly today's behaviour, never worse, and
   never one shared bucket for every student.

   In-memory and per instance, like @fastify/rate-limit's own store.
   ========================================================================== */
import { isIP } from 'node:net';
import { HTTP, RATE_LIMITS } from './config.js';
import { TooMany } from './auth/rbac.js';

/** The address the edge vouches for, and where it came from. */
export function edgePeer(req, header = HTTP.edgeClientIpHeader) {
  if (header) {
    const v = String(req.headers[header] || '').split(',')[0].trim();
    if (isIP(v)) return { ip: v, source: 'edge' };
  }
  return { ip: req.ip, source: 'request' };
}

const windows = new Map();   // key -> { count, resetAt }
let sweptAt = 0;
function sweep(now) {
  if (now - sweptAt < 60_000) return;
  sweptAt = now;
  for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
}

const parseWindow = (w) => {
  const m = /^(\d+)\s*(second|minute|hour)/.exec(String(w || ''));
  if (!m) return RATE_LIMITS.windowMinutes * 60_000;
  return Number(m[1]) * { second: 1000, minute: 60_000, hour: 3_600_000 }[m[2]];
};

/** Test hook: forget every window. */
export function resetEdgeLimits() { windows.clear(); }

/* onRequest hook. Applies to every route that carries an ordinary per-IP
   rateLimit, unless it opts out with edgeLimit: false. A route keyed per
   account (withdrawals) is not an IP limit and is left alone. Routes with no
   limit of their own stay unlimited here. Behind one proxy address the edge key
   could be shared by a whole campus, which is why this cap is looser than the
   route's own by edgeMultiplier. */
export async function edgeLimitHook(req, reply) {
  const cfg = req.routeOptions?.config;
  const rl = cfg?.rateLimit;
  if (cfg?.edgeLimit === false || !rl || typeof rl !== 'object' || rl.keyGenerator) return;
  const windowMs = typeof rl.timeWindow === 'number' ? rl.timeWindow : parseWindow(rl.timeWindow);
  const cap = Math.max(1, Math.round(rl.max * RATE_LIMITS.edgeMultiplier));
  const now = Date.now();
  sweep(now);
  const key = `${req.routeOptions.url}|${edgePeer(req).ip}`;
  let w = windows.get(key);
  if (!w || w.resetAt <= now) { w = { count: 0, resetAt: now + windowMs }; windows.set(key, w); }
  w.count += 1;
  if (w.count > cap) {
    reply.header('retry-after', Math.ceil((w.resetAt - now) / 1000));
    throw TooMany('Too many requests from this network', 'Wait a few minutes and try again.');
  }
}
