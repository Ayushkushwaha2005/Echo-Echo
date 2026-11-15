/* ==========================================================================
   ECHO ECHO — WEEKLY HOURS, AS CAMPUS CONTROL EDITS THEM

   The week is seven entries, Monday first, exactly as the server stores it
   (vendor.weekly_hours, migration 046):
     { day: 1..7, open: boolean, opens: 'HH:MM' | null, closes: 'HH:MM' | null }

   Pure functions only, so the editor's actions are tested once
   (server/test/weekly-schedule-ui.test.mjs). The server re-checks every
   week it is sent (services/hours.js parseWeeklyHours) and stays the only
   judge of whether a café is open; the summary here uses the same wording
   as the student site.
   ========================================================================== */

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = (t) => (t == null || t === '' ? null : String(t).slice(0, 5));
const copy = (week) => week.map((e) => ({ ...e }));

/**
 * The week a café has now. From weekly_hours, or from the older open_days with
 * one pair of hours; a café with no schedule gets seven closed days carrying
 * its old pair of hours if it has one (so nothing is invented).
 */
export function weekFrom(v = {}) {
  if (Array.isArray(v.weekly_hours) && v.weekly_hours.length === 7) {
    return v.weekly_hours.map((e, i) => ({ day: i + 1, open: !!e?.open, opens: hhmm(e?.opens), closes: hhmm(e?.closes) }));
  }
  const days = Array.isArray(v.open_days) ? v.open_days.map(Number) : [];
  return SHORT.map((_, i) => ({ day: i + 1, open: days.includes(i + 1) && !!v.opens_at && !!v.closes_at,
                               opens: hhmm(v.opens_at), closes: hhmm(v.closes_at) }));
}
/** Whether the café has a weekly schedule at all. */
export const hasSchedule = (v = {}) => (Array.isArray(v.weekly_hours) && v.weekly_hours.length === 7)
  || (Array.isArray(v.open_days) && v.open_days.length > 0 && !!v.opens_at && !!v.closes_at);

export const isOvernight = (e) => !!(e.opens && e.closes && e.closes < e.opens);

/** One day open or closed. Closing a day keeps its hours for later. */
export function setDayOpen(week, day, open) {
  return copy(week).map((e) => (e.day === day ? { ...e, open } : e));
}
/** One day's hours. */
export function setDayHours(week, day, { opens, closes }) {
  return copy(week).map((e) => (e.day === day ? { ...e, ...(opens !== undefined ? { opens: hhmm(opens) } : {}),
                                                         ...(closes !== undefined ? { closes: hhmm(closes) } : {}) } : e));
}
/** The same hours on the chosen days, which are opened. */
export function applyHours(week, days, opens, closes) {
  const set = new Set(days.map(Number));
  return copy(week).map((e) => (set.has(e.day) ? { ...e, open: true, opens: hhmm(opens), closes: hhmm(closes) } : e));
}
/** One day's open/closed and hours copied onto the chosen days. */
export function copyDay(week, from, days) {
  const src = week.find((e) => e.day === Number(from));
  const set = new Set(days.map(Number));
  return copy(week).map((e) => (set.has(e.day) && e.day !== src.day ? { ...e, open: src.open, opens: src.opens, closes: src.closes } : e));
}
/**
 * Every day open, or every day closed. Closing keeps the hours. Opening a day
 * that has never had hours gives it the hours of the first day that has some.
 */
export function setAll(week, open) {
  const donor = week.find((e) => e.open && e.opens && e.closes) || week.find((e) => e.opens && e.closes);
  return copy(week).map((e) => (open && !(e.opens && e.closes) && donor
    ? { ...e, open, opens: donor.opens, closes: donor.closes } : { ...e, open }));
}

/** What the server would refuse, per day: [{ day, message }]. */
export function problems(week) {
  const out = [];
  for (const e of week) {
    const name = DAY_NAMES[e.day - 1];
    for (const t of [e.opens, e.closes]) if (t && !TIME.test(t)) out.push({ day: e.day, message: `${name}: times are HH:MM` });
    if (e.open && (!e.opens || !e.closes)) out.push({ day: e.day, message: `${name}: set an opening and a closing time, or mark it closed` });
    else if (e.open && e.opens === e.closes) out.push({ day: e.day, message: `${name}: opening and closing times are the same` });
  }
  return out;
}

/* ---- the summary, in the student site's words (services/hours.js) --------- */
const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
const clock = (t) => {
  const m = mins(t), h = Math.floor(m / 60), mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
};
export const rangeOf = (e) => `${clock(e.opens)}–${clock(e.closes)}`;
function runsOf(set) {
  const runs = []; let start = null;
  for (let d = 1; d <= 8; d++) {
    if (d <= 7 && set.has(d)) { if (start === null) start = d; }
    else if (start !== null) { runs.push(start === d - 1 ? SHORT[start - 1] : `${SHORT[start - 1]}–${SHORT[d - 2]}`); start = null; }
  }
  return runs.join(', ');
}
/** "Mon–Tue 8 AM–6 PM · Thu 10 AM–8 PM · Wed, Sun closed" */
export function summary(week) {
  const groups = new Map();
  for (const e of week.filter((x) => x.open && x.opens && x.closes)) {
    const k = rangeOf(e);
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(e.day);
  }
  const open = [...groups].map(([k, set]) => `${runsOf(set)} ${k}`).join(' · ');
  const closed = week.filter((x) => !(x.open && x.opens && x.closes)).map((x) => SHORT[x.day - 1]);
  if (!open) return 'Closed every day';
  return closed.length ? `${open} · ${closed.join(', ')} closed` : open;
}
