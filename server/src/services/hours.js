/* ==========================================================================
   ECHO ECHO — A CAFÉ'S WEEKLY HOURS

   vendor.open_days (ISO weekday, 1 = Monday .. 7 = Sunday) with opens_at /
   closes_at, all read in campus time (Asia/Kolkata). No open_days means the
   café has no schedule and its own open/accepting switch alone decides, as
   before. A schedule never opens a café whose switch is off; it only closes
   one outside its hours. Delivery has no hours of its own.
   ========================================================================== */

const TZ = 'Asia/Kolkata';
const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Campus-local ISO weekday and minutes past midnight. */
export function campusClock(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { weekday: WEEKDAY[p.weekday], minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const clock = (t) => {
  const m = mins(t), h = Math.floor(m / 60), mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

/** "Mon–Sat 8 AM–6 PM · Sun closed", from runs of open days. */
function label(days, opens, closes) {
  const set = new Set(days.map(Number));
  const runs = []; let start = null;
  for (let d = 1; d <= 8; d++) {
    if (d <= 7 && set.has(d)) { if (start === null) start = d; }
    else if (start !== null) { runs.push(start === d - 1 ? DAY[start - 1] : `${DAY[start - 1]}–${DAY[d - 2]}`); start = null; }
  }
  const closed = DAY.filter((_, i) => !set.has(i + 1));
  return `${runs.join(', ')} ${clock(opens)}–${clock(closes)}${closed.length ? ` · ${closed.join(', ')} closed` : ''}`;
}

/**
 * The schedule as the student sees it, and whether it allows an order now.
 *   { scheduled, label, week: [{ day, open, hours }], inHours, closedReason }
 */
export function hoursOf(v, now = new Date()) {
  const days = Array.isArray(v.open_days) ? v.open_days.map(Number) : null;
  if (!days?.length || !v.opens_at || !v.closes_at) {
    return { scheduled: false, label: null, week: null, inHours: true, closedReason: null };
  }
  const { weekday, minutes } = campusClock(now);
  const week = DAY.map((day, i) => ({ day, open: days.includes(i + 1),
    hours: days.includes(i + 1) ? `${clock(v.opens_at)}–${clock(v.closes_at)}` : 'Closed' }));
  const today = days.includes(weekday);
  const inHours = today && minutes >= mins(v.opens_at) && minutes < mins(v.closes_at);
  const closedReason = inHours ? null
    : !today ? `Closed today (${DAY[weekday - 1]}). Open ${label(days, v.opens_at, v.closes_at).split(' · ')[0]}.`
      : `Open today ${clock(v.opens_at)}–${clock(v.closes_at)}.`;
  return { scheduled: true, label: label(days, v.opens_at, v.closes_at), week, inHours, closedReason };
}

/** Whether a student can order from this café right now. */
export function orderableNow(v, now = new Date()) {
  return Boolean(v.active !== false && v.is_open && v.accepting && hoursOf(v, now).inHours);
}
