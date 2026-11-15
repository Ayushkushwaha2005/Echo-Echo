/* ==========================================================================
   ECHO ECHO — A CAFÉ'S WEEKLY HOURS

   vendor.weekly_hours (migration 046): seven days, Monday first, each open or
   closed with its own opening and closing time, read in the café's timezone
   (vendor.timezone, Asia/Kolkata by default) from the SERVER clock. A café
   from before 046 may carry only open_days (ISO weekday, 1 = Monday ..
   7 = Sunday) with one opens_at / closes_at for every open day; weekOf()
   reads either, and both give the same answers for the same hours.

   A scheduled café opens and closes by its schedule alone: nobody has to
   switch it on at 8 AM. `is_open` is not consulted for it. `accepting` is
   the emergency stop: when it is off the café is closed whatever the hour,
   and the schedule takes over again the moment it is back on.

   No weekly schedule means the café has no schedule, and its own is_open /
   accepting switches decide, as before. Delivery has no hours of its own.

   manual_availability (migration 045) puts a scheduled café under the
   administrator's Open/Closed switch instead: the hours are ignored.
   ========================================================================== */

const TZ = 'Asia/Kolkata';
const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The café's zone if this server's Intl knows it, else campus time. */
export function zoneOf(v) {
  const z = v?.timezone;
  if (!z) return TZ;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); return z; } catch { return TZ; }
}

/** Local ISO weekday and minutes past midnight, in `tz` (campus time by default). */
export function campusClock(now = new Date(), tz = TZ) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { weekday: WEEKDAY[p.weekday], minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const clock = (t) => {
  const m = mins(t), h = Math.floor(m / 60), mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
};
const hhmm = (t) => (t == null || t === '' ? null : String(t).slice(0, 5));
const range = (e) => `${clock(e.opens)}–${clock(e.closes)}`;

/**
 * The café's week as seven entries, Monday first:
 *   [{ day: 1..7, open, opens: 'HH:MM' | null, closes: 'HH:MM' | null }]
 * null: the café has no weekly schedule.
 */
export function weekOf(v) {
  if (Array.isArray(v.weekly_hours) && v.weekly_hours.length === 7) {
    return v.weekly_hours.map((e, i) => {
      const opens = hhmm(e?.opens), closes = hhmm(e?.closes);
      /* A day without both times cannot be open. */
      return { day: i + 1, open: !!e?.open && !!opens && !!closes, opens, closes };
    });
  }
  const days = Array.isArray(v.open_days) ? v.open_days.map(Number) : null;
  if (!days?.length || !v.opens_at || !v.closes_at) return null;
  return DAY.map((_, i) => ({ day: i + 1, open: days.includes(i + 1), opens: hhmm(v.opens_at), closes: hhmm(v.closes_at) }));
}

/* "Mon–Sat 8 AM–6 PM · Sun closed": runs of open days, grouped by their hours. */
function runsOf(set) {
  const runs = []; let start = null;
  for (let d = 1; d <= 8; d++) {
    if (d <= 7 && set.has(d)) { if (start === null) start = d; }
    else if (start !== null) { runs.push(start === d - 1 ? DAY[start - 1] : `${DAY[start - 1]}–${DAY[d - 2]}`); start = null; }
  }
  return runs.join(', ');
}
function labelParts(week) {
  const groups = new Map();
  for (const e of week.filter((x) => x.open)) {
    const k = range(e);
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(e.day);
  }
  const open = [...groups].map(([k, set]) => `${runsOf(set)} ${k}`).join(' · ');
  const closed = week.filter((x) => !x.open).map((x) => DAY[x.day - 1]);
  return { open, closed: closed.length ? `${closed.join(', ')} closed` : '' };
}
export function weekLabel(week) {
  const { open, closed } = labelParts(week);
  if (!open) return 'Closed every day';
  return closed ? `${open} · ${closed}` : open;
}

/* Which day's hours cover this minute, if any. Overnight hours (closing before
   opening, e.g. 18:00-02:00) carry past midnight into the next morning, so
   Friday 18:00-02:00 still covers Saturday 01:30 even if Saturday is closed.
   Equal opening and closing times are not hours. */
function sessionAt(week, { weekday, minutes }) {
  const today = week[weekday - 1];
  if (today.open) {
    const o = mins(today.opens), c = mins(today.closes);
    if ((c > o && minutes >= o && minutes < c) || (c < o && minutes >= o)) return today;
  }
  const y = week[(weekday + 5) % 7];
  if (y.open && mins(y.closes) < mins(y.opens) && minutes < mins(y.closes)) return y;
  return null;
}

/**
 * The schedule as the student sees it, and whether it allows an order now.
 *   { scheduled, label, week: [{ day, open, hours }], inHours, closedReason, timezone }
 */
export function hoursOf(v, now = new Date()) {
  const days = weekOf(v);
  if (!days) {
    return { scheduled: false, label: null, week: null, inHours: true, closedReason: null };
  }
  const tz = zoneOf(v);
  const at = campusClock(now, tz);
  const week = days.map((e) => ({ day: DAY[e.day - 1], open: e.open, hours: e.open ? range(e) : 'Closed' }));
  /* Manual override: the hours are shown for information but decide nothing. */
  if (v.manual_availability) {
    return { scheduled: true, manual: true, label: weekLabel(days), week, timezone: tz, inHours: true, closedReason: null };
  }
  const inHours = !!sessionAt(days, at);
  const today = days[at.weekday - 1];
  const openPart = labelParts(days).open;
  const closedReason = inHours ? null
    : !today.open ? (openPart ? `Closed today (${DAY[at.weekday - 1]}). Open ${openPart}.` : 'Closed every day.')
      : `Open today ${range(today)}.`;
  return { scheduled: true, label: weekLabel(days), week, timezone: tz, inHours, closedReason };
}

/** Whether a student can order from this café right now. */
export function orderableNow(v, now = new Date()) {
  return statusOf(v, now).open;
}

/** When a scheduled café next opens: "8 AM", "tomorrow 8 AM" or "Mon 8 AM". */
function nextOpening(week, { weekday, minutes }) {
  for (let ahead = 0; ahead <= 7; ahead++) {
    const e = week[(weekday - 1 + ahead) % 7];
    if (!e.open || (ahead === 0 && minutes >= mins(e.opens))) continue;
    return ahead === 0 ? clock(e.opens) : ahead === 1 ? `tomorrow ${clock(e.opens)}` : `${DAY[e.day - 1]} ${clock(e.opens)}`;
  }
  return null;
}

/**
 * The one answer to "can I order from this café now?", with the line a
 * student reads. The server computes it; the browser's clock is never asked.
 *   { open, state: 'open' | 'closed' | 'paused' | 'inactive', line }
 */
export function statusOf(v, now = new Date()) {
  if (v.active === false) return { open: false, state: 'inactive', line: 'No longer on ECHO ECHO' };
  /* Manual availability override: the administrator's Open/Closed is the
     source of truth and the weekly hours are not consulted at all - not the
     day, not the time, not overnight or midnight boundaries. `accepting`
     still works as the emergency pause. */
  if (v.manual_availability) {
    if (!v.is_open) return { open: false, state: 'closed', manual: true, line: 'Closed right now' };
    if (!v.accepting) return { open: false, state: 'paused', manual: true, line: 'Not taking orders right now' };
    return { open: true, state: 'open', manual: true, line: 'Open now' };
  }
  const week = weekOf(v);
  if (!week) {
    const open = Boolean(v.is_open && v.accepting);
    return { open, state: open ? 'open' : 'closed', line: open ? 'Open now' : 'Closed right now' };
  }
  if (!v.accepting) return { open: false, state: 'paused', line: 'Not taking orders right now' };
  const at = campusClock(now, zoneOf(v));
  const session = sessionAt(week, at);
  if (session) return { open: true, state: 'open', line: `Open · closes ${clock(session.closes)}` };
  const next = nextOpening(week, at);
  return { open: false, state: 'closed', line: next ? `Closed · opens ${next}` : 'Closed' };
}

/* ---------- validating a weekly schedule sent by Campus Control ------------ */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Checks and normalises a PATCH body's weeklyHours. Returns the seven stored
 * entries, or null to remove the schedule. Throws a message string when the
 * week cannot be saved.
 */
export function parseWeeklyHours(input) {
  if (input === null) return null;
  if (!Array.isArray(input) || input.length !== 7) throw 'weeklyHours must list all seven days, Monday first';
  return input.map((e, i) => {
    const name = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i];
    if (!e || typeof e !== 'object') throw `${name}: missing`;
    if (e.day !== undefined && Number(e.day) !== i + 1) throw `${name} is out of order`;
    if (typeof e.open !== 'boolean') throw `${name}: say whether it is open`;
    const opens = e.opens == null || e.opens === '' ? null : String(e.opens).slice(0, 5);
    const closes = e.closes == null || e.closes === '' ? null : String(e.closes).slice(0, 5);
    for (const t of [opens, closes]) if (t !== null && !TIME.test(t)) throw `${name}: times are HH:MM, 24-hour`;
    if (e.open) {
      if (!opens || !closes) throw `${name}: set an opening and a closing time, or mark it closed`;
      if (opens === closes) throw `${name}: opening and closing times are the same`;
    }
    return { day: i + 1, open: e.open, opens, closes };
  });
}

/** The older columns kept in step with a weekly schedule, for anything that still reads them. */
export function legacyColumns(week) {
  if (!week) return { open_days: null };
  const open = week.filter((e) => e.open);
  return {
    open_days: open.length ? open.map((e) => e.day) : null,
    opens_at: open[0]?.opens ?? undefined,
    closes_at: open[0]?.closes ?? undefined,
  };
}
