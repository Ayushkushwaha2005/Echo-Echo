/* ==========================================================================
   ECHO ECHO — CAMPUS CONTROL ORDER VIEWS (pure helpers)

   The decisions behind the Orders page, kept free of the DOM so they can be
   tested on their own:

     · which tab asks the server for which orders
     · which row actions an order offers to THIS administrator. The server
       decides again on every call; this only avoids offering a button the
       server would refuse
     · a customer's avatar: their initials on a tint chosen from their name
       (students have no profile photo in this product)
     · the Graph View: a smooth line through real figures, with axis ticks
   ========================================================================== */

/* All Order / Summary / Completed / Cancelled, as in the reference. */
export const ORDER_TABS = [
  ['all', 'All Order'], ['summary', 'Summary'], ['completed', 'Completed'], ['cancelled', 'Cancelled'],
];
export const TAB_STATE = { all: '', completed: 'delivered', cancelled: 'cancelled,refunded' };

const CARRYING = ['assigned', 'picked_up'];
const REFUNDABLE_STATES = ['confirmed', 'preparing', 'ready', 'assigned', 'picked_up', 'delivered', 'cancelled'];

/**
 * The row menu. `can(permission)` answers for the signed-in administrator.
 * Every entry maps to an existing, server-checked endpoint or a read-only
 * view; nothing here changes an order's state on its own.
 */
export function orderActions(o, can) {
  const out = [];
  if (can('orders.view')) out.push({ act: 'openOrder', label: 'View details' });
  if (can('orders.view')) out.push({ act: 'orderTimeline', label: 'Timeline' });
  if (o.fulfilment === 'delivery' && CARRYING.includes(o.state) && can('orders.view')) {
    out.push({ act: 'goDeliveries', label: 'Live delivery status' });
  }
  /* A refund is offered only for an order whose payment was confirmed and
     that is not already refunded; the refund endpoint re-checks the amount,
     the provider and the permission. */
  if (can('orders.override') && o.payment_status === 'paid' && REFUNDABLE_STATES.includes(o.state)) {
    out.push({ act: 'refund', label: 'Refund', danger: true });
  }
  out.push({ act: 'copyCode', label: 'Copy order code' });
  return out;
}

/* Initials and a tint from the palette, stable for the same name. */
const TINTS = ['#DEBDCD', '#AAB1CB', '#C8B9C3', '#9E97AC'];
export function avatarFor(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return { initials, tint: TINTS[h % TINTS.length] };
}

/* Round axis maximum: 1, 2, 2.5 or 5 times a power of ten, at least the data. */
export function niceMax(v) {
  if (!(v > 0)) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * Geometry for the Graph View line chart, in an SVG viewBox of w × h with
 * room for axis labels. Returns the smooth path, the points (for hover), the
 * four horizontal gridlines with their values and the x labels to show.
 */
export function chartGeometry(series, value, { w = 640, h = 280, left = 44, right = 12, top = 24, bottom = 30 } = {}) {
  const n = series.length;
  const vals = series.map(value);
  const max = niceMax(Math.max(0, ...vals));
  const iw = w - left - right, ih = h - top - bottom;
  const x = (i) => left + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v) => top + ih - (v / max) * ih;
  const pts = vals.map((v, i) => ({ x: x(i), y: y(v), v, at: series[i].at }));
  /* Monotone cubic (Fritsch–Carlson) so the curve is smooth like the
     reference but never overshoots below zero or above a real peak. */
  let d = '';
  if (pts.length === 1) d = `M${pts[0].x},${pts[0].y}`;
  else if (pts.length > 1) {
    const dx = pts.slice(1).map((p, i) => p.x - pts[i].x);
    const sl = pts.slice(1).map((p, i) => (p.y - pts[i].y) / dx[i]);
    const m = pts.map((_, i) => (i === 0 ? sl[0] : i === pts.length - 1 ? sl[i - 1]
      : sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2));
    for (let i = 0; i < sl.length; i++) {
      if (sl[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / sl[i], b = m[i + 1] / sl[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * sl[i]; m[i + 1] = t * b * sl[i]; }
    }
    d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const h3 = dx[i] / 3;
      d += ` C${(pts[i].x + h3).toFixed(1)},${(pts[i].y + m[i] * h3).toFixed(1)} ${(pts[i + 1].x - h3).toFixed(1)},${(pts[i + 1].y - m[i + 1] * h3).toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
    }
  }
  const grid = [0, 1, 2, 3, 4].map((k) => ({ v: (max * k) / 4, y: y((max * k) / 4) }));
  /* At most 6 x labels, evenly spaced, always including the last point. */
  const step = Math.max(1, Math.ceil(n / 6));
  const labels = pts.filter((_, i) => i % step === 0 || i === n - 1)
    .filter((p, i, a) => i === a.length - 1 || a[a.length - 1].x - p.x > iw / 12);
  const peak = pts.reduce((best, p) => (p.v > (best?.v ?? -1) ? p : best), null);
  return { d, pts, grid, labels, max, peak, box: { w, h, left, right, top, bottom } };
}
