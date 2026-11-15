/* ==========================================================================
   WEEKLY CAFÉ SCHEDULE (migration 046)

   Seven days, each open or closed with its own hours, read in the café's
   timezone. The schedule decides the student site, the menu, search, the
   cart, the order check and the assistant alike (all through statusOf), and
   it never touches the manual override or the emergency pause.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';
import { hoursOf, statusOf, weekOf, campusClock, parseWeeklyHours } from '../src/services/hours.js';

const M046 = fs.readFileSync(fileURLToPath(new URL('../src/db/046_weekly_cafe_hours.sql', import.meta.url)), 'utf8');
const BACKFILL = M046.slice(M046.indexOf('UPDATE vendor v'));
const at = (iso) => new Date(iso);   // UTC; IST is +05:30

/* The owner's example week. */
const EXAMPLE = [
  { day: 1, open: true, opens: '08:00', closes: '18:00' },
  { day: 2, open: true, opens: '08:00', closes: '18:00' },
  { day: 3, open: false, opens: '08:00', closes: '18:00' },
  { day: 4, open: true, opens: '10:00', closes: '20:00' },
  { day: 5, open: true, opens: '08:00', closes: '22:00' },
  { day: 6, open: true, opens: '09:00', closes: '17:00' },
  { day: 7, open: false, opens: null, closes: null },
];
const cafe = (weekly_hours, extra = {}) => ({ weekly_hours, is_open: false, accepting: true, manual_availability: false, ...extra });

/* ---------------- the rule itself ---------------------------------------- */

test('every day has its own hours; closed days are closed (16-22 Nov 2026 is Mon-Sun)', () => {
  const v = cafe(EXAMPLE);
  const open = (iso) => statusOf(v, at(iso)).open;
  /* Monday 08:00 IST = 02:30 UTC */
  assert.equal(open('2026-11-16T02:29:00Z'), false, 'Mon 07:59');
  assert.equal(open('2026-11-16T02:30:00Z'), true, 'Mon 08:00');
  assert.equal(open('2026-11-16T12:29:00Z'), true, 'Mon 17:59');
  assert.equal(open('2026-11-16T12:30:00Z'), false, 'Mon 18:00');
  assert.equal(open('2026-11-18T06:30:00Z'), false, 'Wednesday is closed at noon');
  assert.equal(open('2026-11-19T04:00:00Z'), false, 'Thu 09:30, opens at 10');
  assert.equal(open('2026-11-19T13:30:00Z'), true, 'Thu 19:00');
  assert.equal(open('2026-11-20T16:00:00Z'), true, 'Fri 21:30');
  assert.equal(open('2026-11-20T16:30:00Z'), false, 'Fri 22:00');
  assert.equal(open('2026-11-21T11:00:00Z'), true, 'Sat 16:30');
  assert.equal(open('2026-11-21T11:30:00Z'), false, 'Sat 17:00');
  assert.equal(open('2026-11-22T06:30:00Z'), false, 'Sunday');
});

test('the student lines: label, week, closing time of today, next opening', () => {
  const v = cafe(EXAMPLE);
  const h = hoursOf(v, at('2026-11-18T06:30:00Z'));
  assert.equal(h.label, 'Mon–Tue 8 AM–6 PM · Thu 10 AM–8 PM · Fri 8 AM–10 PM · Sat 9 AM–5 PM · Wed, Sun closed');
  assert.deepEqual(h.week.map((d) => d.hours),
    ['8 AM–6 PM', '8 AM–6 PM', 'Closed', '10 AM–8 PM', '8 AM–10 PM', '9 AM–5 PM', 'Closed']);
  assert.match(h.closedReason, /^Closed today \(Wed\)\. Open Mon–Tue 8 AM–6 PM/);
  assert.equal(statusOf(v, at('2026-11-18T06:30:00Z')).line, 'Closed · opens tomorrow 10 AM');
  assert.equal(statusOf(v, at('2026-11-20T16:00:00Z')).line, 'Open · closes 10 PM');
  assert.equal(statusOf(v, at('2026-11-21T12:00:00Z')).line, 'Closed · opens Mon 8 AM', 'Sat after 5 PM, Sun closed');
  assert.equal(hoursOf(v, at('2026-11-19T04:00:00Z')).closedReason, 'Open today 10 AM–8 PM.');
});

test('overnight hours carry past midnight, even into a closed day, and stop at closing', () => {
  const week = EXAMPLE.map((e) => ({ ...e }));
  week[4] = { day: 5, open: true, opens: '18:00', closes: '02:00' };   // Friday 6 PM - 2 AM
  week[5] = { day: 6, open: false, opens: '09:00', closes: '17:00' };  // Saturday closed
  const v = cafe(week);
  assert.equal(statusOf(v, at('2026-11-20T12:29:00Z')).open, false, 'Fri 17:59');
  assert.equal(statusOf(v, at('2026-11-20T12:30:00Z')).open, true, 'Fri 18:00');
  assert.equal(statusOf(v, at('2026-11-20T18:29:00Z')).open, true, 'Fri 23:59');
  const sat0130 = statusOf(v, at('2026-11-20T20:00:00Z'));
  assert.deepEqual([sat0130.open, sat0130.line], [true, 'Open · closes 2 AM'], 'Sat 01:30 is still Friday night');
  assert.equal(statusOf(v, at('2026-11-20T20:30:00Z')).open, false, 'Sat 02:00');
  /* Thursday's ordinary hours do not spill into Friday morning */
  assert.equal(statusOf(v, at('2026-11-19T20:00:00Z')).open, false, 'Fri 01:30');
});

test('the café timezone decides the day and the hour', () => {
  const week = Array.from({ length: 7 }, (_, i) => ({ day: i + 1, open: true, opens: '09:00', closes: '17:00' }));
  const instant = at('2026-11-16T10:00:00Z');   // 15:30 Mon in Kolkata, 10:00 in London, 05:00 in New York
  assert.equal(statusOf(cafe(week), instant).open, true, 'Kolkata by default');
  assert.equal(statusOf(cafe(week, { timezone: 'Europe/London' }), instant).open, true);
  assert.equal(statusOf(cafe(week, { timezone: 'America/New_York' }), instant).open, false);
  /* across midnight: Sunday 23:30 in Kolkata is Sunday 18:00 in London */
  const sunOnly = week.map((e) => ({ ...e, open: e.day === 7, opens: '00:00', closes: '23:59' }));
  const t = at('2026-11-22T18:00:00Z');   // Sun 23:30 in Kolkata, Mon 03:00 in Tokyo
  assert.equal(statusOf(cafe(sunOnly), t).open, true);
  assert.equal(statusOf(cafe(sunOnly, { timezone: 'Asia/Tokyo' }), t).open, false, 'Mon 03:00 in Tokyo');
  assert.equal(statusOf(cafe(sunOnly, { timezone: 'Not/AZone' }), t).open, true, 'an unknown zone reads as campus time');
  assert.equal(campusClock(t, 'Asia/Tokyo').weekday, 1);
});

test('manual override and emergency pause stay independent of the schedule', () => {
  const allDay = Array.from({ length: 7 }, (_, i) => ({ day: i + 1, open: true, opens: '00:00', closes: '23:59' }));
  const noDay = allDay.map((e) => ({ ...e, open: false }));
  const t = at('2026-11-18T06:30:00Z');
  assert.equal(statusOf(cafe(noDay, { manual_availability: true, is_open: true }), t).open, true, 'manual Open allows ordering');
  assert.equal(statusOf(cafe(allDay, { manual_availability: true, is_open: false }), t).open, false, 'manual Closed blocks it');
  assert.equal(statusOf(cafe(allDay, { accepting: false }), t).state, 'paused', 'the pause closes a scheduled café');
  assert.equal(statusOf(cafe(allDay, { manual_availability: true, is_open: true, accepting: false }), t).state, 'paused');
  assert.equal(statusOf(cafe(noDay), t).line, 'Closed', 'closed every day');
  assert.equal(hoursOf(cafe(noDay), t).label, 'Closed every day');
});

test('a week saved from the old columns answers exactly as the old columns did', () => {
  const legacy = { open_days: [1, 2, 3, 4, 5, 6], opens_at: '08:00:00', closes_at: '18:00:00', is_open: true, accepting: true };
  const overnight = { open_days: [1, 3, 5], opens_at: '18:00:00', closes_at: '02:00:00', is_open: true, accepting: true };
  for (const old of [legacy, overnight]) {
    const week = weekOf(old);
    for (let h = 0; h < 24 * 8; h += 0.5) {
      const t = new Date(Date.UTC(2026, 10, 15, 18, 30) + h * 3600_000);
      assert.deepEqual(statusOf({ ...old, weekly_hours: week }, t), statusOf(old, t), t.toISOString());
      assert.deepEqual(hoursOf({ ...old, weekly_hours: week }, t), hoursOf(old, t), t.toISOString());
    }
  }
  assert.equal(hoursOf(legacy).label, 'Mon–Sat 8 AM–6 PM · Sun closed');
});

test('what Campus Control may save', () => {
  assert.deepEqual(parseWeeklyHours(EXAMPLE), EXAMPLE);
  assert.equal(parseWeeklyHours(null), null);
  assert.throws(() => parseWeeklyHours(EXAMPLE.slice(0, 6)), /all seven days/);
  assert.throws(() => parseWeeklyHours(EXAMPLE.map((e, i) => (i === 0 ? { ...e, opens: null } : e))), /Monday: set an opening/);
  assert.throws(() => parseWeeklyHours(EXAMPLE.map((e, i) => (i === 3 ? { ...e, closes: '10:00' } : e))), /Thursday: opening and closing/);
  assert.throws(() => parseWeeklyHours(EXAMPLE.map((e, i) => (i === 1 ? { ...e, opens: '25:00' } : e))), /HH:MM/);
  assert.throws(() => parseWeeklyHours(EXAMPLE.map((e, i) => (i === 1 ? { ...e, open: 'yes' } : e))), /Tuesday/);
  /* a closed day may keep its hours, or have none */
  assert.deepEqual(parseWeeklyHours(EXAMPLE)[2], { day: 3, open: false, opens: '08:00', closes: '18:00' });
});

/* ---------------- the database and the API -------------------------------- */

let app, pool, nth = 0;
before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.46@stu.upes.ac.in';
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const admin = async () => {
  const u = await makeUser(pool, { phone: `+91966000${String(1000 + nth++).slice(-4)}`, name: 'Admin', roles: ['platform_admin'] });
  return client(app, await sessionFor(pool, u.id, { method: 'passkey' }));
};
const studentUser = () => makeUser(pool, { phone: `+91967000${String(1000 + nth++).slice(-4)}`, name: 'Student' });
const student = async () => client(app, await sessionFor(pool, (await studentUser()).id));
/* Today open all day and every other day closed, or the reverse, in campus time. */
const todayOnly = (open = true) => {
  const { weekday } = campusClock();
  return Array.from({ length: 7 }, (_, i) => ({ day: i + 1, open: (i + 1 === weekday) === open, opens: '00:00', closes: '23:59' }));
};
async function newCafe() {
  const v = await makeVendor(pool, { name: `Café ${nth}`, slug: `cafe-${nth++}` });
  const item = await makeItem(pool, v.id, { name: 'Masala Chai', paise: 2000 });
  return { v, item, order: { vendorId: v.id, lines: [{ itemId: item.id, qty: 1 }], fulfilment: 'delivery' } };
}
const row = async (id) => (await pool.query(
  `SELECT weekly_hours, timezone, open_days, to_char(opens_at,'HH24:MI') o, to_char(closes_at,'HH24:MI') c,
          is_open, accepting, manual_availability FROM vendor WHERE id = $1`, [id])).rows[0];

test('migration 046 copies every existing schedule day for day and leaves unscheduled cafés alone', async () => {
  const { v: a } = await newCafe(), { v: b } = await newCafe(), { v: c } = await newCafe();
  await pool.query(`UPDATE vendor SET open_days = '{1,2,3,4,5,6}', opens_at = '08:00', closes_at = '18:00', weekly_hours = NULL WHERE id = $1`, [a.id]);
  await pool.query(`UPDATE vendor SET open_days = '{5,6}', opens_at = '18:00', closes_at = '02:00', weekly_hours = NULL WHERE id = $1`, [b.id]);
  await pool.query(`UPDATE vendor SET open_days = NULL, weekly_hours = NULL WHERE id = $1`, [c.id]);
  const before = {};
  for (const id of [a.id, b.id, c.id]) before[id] = await row(id);
  await pool.query(BACKFILL);
  const ra = await row(a.id);
  assert.deepEqual(ra.weekly_hours, [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: d, open: d <= 6, opens: '08:00', closes: '18:00' })));
  assert.equal(ra.timezone, 'Asia/Kolkata');
  assert.deepEqual((await row(b.id)).weekly_hours.filter((e) => e.open).map((e) => [e.day, e.opens, e.closes]),
    [[5, '18:00', '02:00'], [6, '18:00', '02:00']]);
  assert.equal((await row(c.id)).weekly_hours, null, 'no schedule stays no schedule');
  for (const id of [a.id, b.id, c.id]) {
    const r = await row(id);
    for (const k of ['open_days', 'o', 'c', 'is_open', 'accepting', 'manual_availability']) assert.deepEqual(r[k], before[id][k], k);
    /* and every answer is the same, all week */
    const full = (await pool.query('SELECT * FROM vendor WHERE id = $1', [id])).rows[0];
    for (let h = 0; h < 24 * 7; h += 1) {
      const t = new Date(Date.UTC(2026, 10, 15, 18, 30) + h * 3600_000);
      assert.deepEqual(statusOf(full, t), statusOf({ ...full, weekly_hours: null }, t));
    }
  }
  await pool.query(BACKFILL);
  assert.deepEqual((await row(a.id)).weekly_hours, ra.weekly_hours, 'running it again changes nothing');
});

test('saving a week: stored day for day, old columns kept in step, switches untouched, audited', async () => {
  const { v } = await newCafe();
  const a = await admin();
  await pool.query(`UPDATE vendor SET is_open = false, accepting = false, manual_availability = false WHERE id = $1`, [v.id]);
  const r = await a.patch(`/vendors/${v.id}`, { weeklyHours: EXAMPLE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const saved = await row(v.id);
  assert.deepEqual(saved.weekly_hours, EXAMPLE);
  assert.deepEqual(saved.open_days, [1, 2, 4, 5, 6]);
  assert.deepEqual([saved.o, saved.c], ['08:00', '18:00']);
  assert.deepEqual([saved.is_open, saved.accepting, saved.manual_availability], [false, false, false], 'only the schedule changed');
  assert.equal(r.body.hours.label, 'Mon–Tue 8 AM–6 PM · Thu 10 AM–8 PM · Fri 8 AM–10 PM · Sat 9 AM–5 PM · Wed, Sun closed');
  const log = (await pool.query(`SELECT detail FROM audit_log WHERE action = 'vendor.update' AND resource_id = $1`, [v.id])).rows.at(-1);
  assert.deepEqual(log.detail.schedule.week, EXAMPLE);
  /* a refused week saves nothing */
  const bad = await a.patch(`/vendors/${v.id}`, { weeklyHours: EXAMPLE.map((e, i) => (i === 0 ? { ...e, closes: '08:00' } : e)) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Monday/);
  assert.deepEqual((await row(v.id)).weekly_hours, EXAMPLE);
  assert.equal((await a.patch(`/vendors/${v.id}`, { timezone: 'Mars/Olympus' })).status, 400);
  assert.equal((await a.patch(`/vendors/${v.id}`, { timezone: 'Asia/Dubai' })).status, 200);
  assert.equal((await row(v.id)).timezone, 'Asia/Dubai');
  /* a student cannot */
  assert.equal((await (await student()).patch(`/vendors/${v.id}`, { weeklyHours: EXAMPLE })).status, 403);
  /* removing the schedule hands the café back to its own switches */
  assert.equal((await a.patch(`/vendors/${v.id}`, { weeklyHours: null })).status, 200);
  const gone = await row(v.id);
  assert.deepEqual([gone.weekly_hours, gone.open_days], [null, null]);
});

test('student list, menu, search, assistant and the order check all follow the week', async () => {
  const { v, order } = await newCafe();
  const a = await admin();
  const stu = await studentUser();
  const s = client(app, await sessionFor(pool, stu.id));
  const { actorFromToken } = await import('../src/auth/session.js');
  const { TOOLS } = await import('../src/services/ai-tools.js');
  const actor = await actorFromToken(await sessionFor(pool, stu.id));
  const views = async () => ({
    list: (await s.get('/vendors?fresh=1')).body.vendors.find((x) => x.id === v.id).open_now,
    menu: (await s.get(`/vendors/${v.id}/menu`)).body.vendor.open_now,
    search: (await s.get('/menu/search?q=masala')).body.items.find((i) => i.vendor_id === v.id).open_now,
    assistant: (await TOOLS.search_cafeterias(actor, {})).cafeterias.find((x) => x.id === v.id).open,
  });

  await a.patch(`/vendors/${v.id}`, { weeklyHours: todayOnly(false) });
  assert.deepEqual(await views(), { list: false, menu: false, search: false, assistant: false });
  const refused = await s.post('/orders/draft', order);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /closed right now/);

  await a.patch(`/vendors/${v.id}`, { weeklyHours: todayOnly(true) });
  assert.deepEqual(await views(), { list: true, menu: true, search: true, assistant: true });
  const reached = await s.post('/orders/draft', order);
  assert.equal(reached.status, 400, 'past the hours check, stopped at the delivery spot');
  assert.match(reached.body.error, /delivery location/i);

  /* manual Closed wins over an open day; override off returns to the week */
  await a.patch(`/vendors/${v.id}`, { manualAvailability: true, isOpen: false });
  assert.equal((await views()).menu, false);
  await a.patch(`/vendors/${v.id}`, { manualAvailability: false });
  assert.equal((await views()).menu, true);
  /* the emergency pause survives a schedule change */
  await a.patch(`/vendors/${v.id}`, { accepting: false });
  await a.patch(`/vendors/${v.id}`, { weeklyHours: todayOnly(true) });
  assert.equal((await row(v.id)).accepting, false);
  assert.equal((await s.get(`/vendors/${v.id}/menu`)).body.vendor.status.state, 'paused');
});

test('the counter app\'s single pair of hours: unchanged leaves each day alone, changed applies to every day', async () => {
  const { v } = await newCafe();
  const a = await admin();
  await a.patch(`/vendors/${v.id}`, { weeklyHours: EXAMPLE });
  /* the form sends back the pair it was shown (Monday's, kept in opens_at/closes_at) */
  await a.patch(`/vendors/${v.id}`, { name: 'Renamed', opensAt: '08:00', closesAt: '18:00' });
  assert.deepEqual((await row(v.id)).weekly_hours, EXAMPLE);
  await a.patch(`/vendors/${v.id}`, { opensAt: '07:00', closesAt: '18:00' });
  const w = (await row(v.id)).weekly_hours;
  assert.deepEqual(w.map((e) => e.opens), ['07:00', '07:00', '07:00', '07:00', '07:00', '07:00', '07:00']);
  assert.deepEqual(w.map((e) => e.closes), EXAMPLE.map((e) => e.closes), 'closing times untouched');
  assert.deepEqual(w.map((e) => e.open), EXAMPLE.map((e) => e.open), 'open days untouched');
});
