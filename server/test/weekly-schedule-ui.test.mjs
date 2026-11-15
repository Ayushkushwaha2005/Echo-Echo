/* ==========================================================================
   WEEKLY SCHEDULE EDITOR AND THE SHARED SWITCHES (front end)

   * The editor's actions (packages/ui/weekly-hours.js): set all open/closed,
     apply hours to chosen days, copy a day, closed days keep their hours,
     the same problems the server refuses, and a summary worded exactly as
     the student site's (services/hours.js).
   * The two switches built from the owner's supplied components
     (packages/ui/switch.js, packages/ui/theme-switch.js): their markup,
     variants, numbers and accessibility, and that every screen uses them.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as W from '../../packages/ui/weekly-hours.js';
import { Switch, playHapticFeedback } from '../../packages/ui/switch.js';
import { weekLabel, parseWeeklyHours } from '../src/services/hours.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const ADMIN = read('../../admin/src/app.js');
const WEB = read('../../web/src/app.js');
const SHOP = read('../../shop/src/app.js');
const CSS = read('../../packages/design-system/components.css');
const THEME = read('../../packages/ui/theme-switch.js');

const blank = () => W.weekFrom({});
const nine = (week, days) => W.applyHours(week, days, '09:00', '17:00');

/* ---------------- the editor -------------------------------------------- */

test('a café\'s existing week loads as it is; an unscheduled café invents nothing', () => {
  const legacy = W.weekFrom({ open_days: [1, 2, 3, 4, 5, 6], opens_at: '08:00:00', closes_at: '18:00:00' });
  assert.deepEqual(legacy.map((e) => e.open), [true, true, true, true, true, true, false]);
  assert.ok(legacy.every((e) => e.opens === '08:00' && e.closes === '18:00'), 'Sunday keeps the hours, closed');
  assert.equal(W.hasSchedule({ open_days: [1], opens_at: '08:00', closes_at: '18:00' }), true);
  const none = blank();
  assert.ok(none.every((e) => !e.open && e.opens === null && e.closes === null));
  assert.equal(W.hasSchedule({}), false);
  const stored = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: d, open: d === 4, opens: '10:00', closes: '20:00' }));
  assert.deepEqual(W.weekFrom({ weekly_hours: stored, open_days: [1] }), stored, 'weekly_hours wins');
});

test('closing a day keeps its hours; opening it again brings them back', () => {
  let w = nine(blank(), [3]);
  w = W.setDayOpen(w, 3, false);
  assert.deepEqual(w[2], { day: 3, open: false, opens: '09:00', closes: '17:00' });
  w = W.setDayOpen(w, 3, true);
  assert.deepEqual(w[2], { day: 3, open: true, opens: '09:00', closes: '17:00' });
});

test('apply hours to selected days; copy one day to others; all open; all closed', () => {
  let w = nine(blank(), [1, 2, 5]);
  assert.deepEqual(w.filter((e) => e.open).map((e) => e.day), [1, 2, 5]);
  w = W.setDayHours(w, 4, { opens: '10:00', closes: '20:00' });
  w = W.setDayOpen(w, 4, true);
  w = W.copyDay(w, 4, [6, 7]);
  assert.deepEqual(w.slice(5).map((e) => [e.open, e.opens, e.closes]), [[true, '10:00', '20:00'], [true, '10:00', '20:00']]);
  const closed = W.setAll(w, false);
  assert.ok(closed.every((e) => !e.open));
  assert.deepEqual(closed.map((e) => e.opens), w.map((e) => e.opens), 'all closed keeps every day\'s hours');
  const reopened = W.setAll(closed, true);
  assert.deepEqual(reopened.map((e) => [e.opens, e.closes]), w.map((e) => [e.opens || '09:00', e.closes || '17:00']),
    'all open keeps each day\'s own hours; a day that never had any borrows the first day\'s');
  /* copying never changes the source day, and the input week is never mutated */
  const before = JSON.stringify(w);
  W.copyDay(w, 1, [1, 2]);
  assert.equal(JSON.stringify(w), before);
});

test('the editor refuses what the server refuses, and nothing more', () => {
  const cases = [
    blank(),
    nine(blank(), [1, 2, 3]),
    W.setDayOpen(blank(), 2, true),                                 // open without hours
    W.setDayHours(W.setDayOpen(nine(blank(), [1]), 1, true), 1, { closes: '09:00' }), // same times
    W.applyHours(blank(), [5], '18:00', '02:00'),                   // overnight is fine
  ];
  for (const w of cases) {
    let server = null;
    try { parseWeeklyHours(w); } catch (m) { server = m; }
    const ui = W.problems(w);
    assert.equal(ui.length > 0, server !== null, JSON.stringify(w));
    if (server) assert.equal(ui[0].message, server);
  }
});

test('the summary reads exactly as the student site, for many weeks', () => {
  const times = [['08:00', '18:00'], ['10:00', '20:00'], ['18:00', '02:00'], ['09:30', '17:45']];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 300; k++) {
    const week = [1, 2, 3, 4, 5, 6, 7].map((d) => {
      const [o, c] = times[rnd(times.length)];
      return { day: d, open: rnd(3) > 0, opens: o, closes: c };
    });
    assert.equal(W.summary(week), weekLabel(week));
  }
  assert.equal(W.summary(blank()), 'Closed every day');
  assert.equal(W.isOvernight({ opens: '18:00', closes: '02:00' }), true);
  assert.equal(W.isOvernight({ opens: '08:00', closes: '18:00' }), false);
});

test('Edit café carries the weekly editor and only sends a week that changed', () => {
  const edit = ADMIN.slice(ADMIN.indexOf('editVendor: async'), ADMIN.indexOf('/* ---- the weekly schedule\'s own actions'));
  assert.match(edit, /\$\{WeeklyEditor\(v\)\}/);
  assert.doesNotMatch(edit, /field\('opensAt'/, 'the single pair of hours is replaced');
  assert.match(edit, /\.\.\.\(week \? \{ weeklyHours: week \} : \{\}\)/);
  const editor = ADMIN.slice(ADMIN.indexOf('const WeeklyEditor'), ADMIN.indexOf('const wkBox'));
  for (const a of ['data-act="wkAll" data-v="1"', 'data-act="wkAll" data-v="0"', 'data-act="wkApply"', 'data-act="wkCopy"', 'data-act="wkSave"'])
    assert.ok(editor.includes(a), a);
  assert.match(editor, /Switch\(\{ checked: e\.open, showIcons: true/, 'each day uses the Icon Mode switch');
  assert.match(editor, /\$\{e\.open \? '' : 'disabled'\}/, 'closed days disable their times');
  assert.match(ADMIN, /for \(const e of week\) \{[\s\S]*?i\.disabled = !e\.open;/, 'and keep the values');
  for (const fn of ['wkAll', 'wkApply', 'wkCopy', 'wkSave']) assert.match(ADMIN, new RegExp(`  ${fn}: \\(t\\) =>`));
});

/* ---------------- the switches ----------------------------------------- */

test('Switch: the supplied structure, variants and an accessible real checkbox', () => {
  const plain = Switch({ name: 'deliveryEnabled', checked: true, label: 'Offers delivery' });
  assert.match(plain, /<label class="m3s-field">/);
  assert.match(plain, /<input type="checkbox" role="switch" class="m3s-input" name="deliveryEnabled" checked>/);
  for (const part of ['m3s-track', 'm3s-slide', 'm3s-handle', 'm3s-halo']) assert.ok(plain.includes(part), part);
  assert.doesNotMatch(plain, /m3s-icon/, 'Standard has no icons');
  const icons = Switch({ showIcons: true, ariaLabel: 'Monday open' });
  assert.match(icons, /m3s-icons/);
  assert.match(icons, /aria-label="Monday open"/);
  assert.match(icons, /m3s-icon-on[\s\S]*M20 6 9 17l-5-5/, 'Check when on');
  assert.match(icons, /m3s-icon-off[\s\S]*M18 6 6 18/, 'X when off');
  const danger = Switch({ variant: 'destructive', checkedIcon: '<svg id="lock"/>', uncheckedIcon: '<svg id="unlock"/>' });
  assert.match(danger, /m3s-destructive/);
  assert.match(danger, /id="lock"[\s\S]*id="unlock"/, 'custom icons');
  assert.match(Switch({ size: 'sm' }), /m3s-sm/);
  assert.match(Switch({ disabled: true }), /is-disabled[\s\S]*disabled/);
  assert.match(Switch({ haptic: 'heavy' }), /data-haptic="heavy"/);
  assert.doesNotMatch(Switch({}), /data-haptic/, 'no sound unless asked');
  assert.doesNotThrow(() => playHapticFeedback('none'));
  assert.match(Switch({ attrs: 'data-path="x"', label: 'x' }), /data-path="x"/);
  assert.doesNotMatch(Switch({ name: '"><script>' }), /<script>/, 'attributes are escaped');
});

test('Switch styles keep the supplied numbers, focus ring and reduced motion', () => {
  const css = CSS.slice(CSS.indexOf('SWITCH (packages/ui/switch.js)'), CSS.indexOf('LIGHT / DARK SWITCH'));
  assert.match(css, /cubic-bezier\(0\.175, 0\.885, 0\.32, 1\.275\)/);
  assert.match(css, /height: 32px; width: 52px/);
  assert.match(css, /translateX\(20px\)/);
  assert.match(css, /width: 16px; height: 16px; margin-left: 2px/);
  assert.match(css, /width: 24px; height: 24px; margin-left: 0/);
  assert.match(css, /width: 28px; height: 28px; margin-left: -2px/);
  assert.match(css, /min-width: 48px; min-height: 48px/);
  assert.match(css, /\.m3s-input:focus-visible \+ \.m3s-track \{ box-shadow/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*transition: none/);
});

test('the light/dark switch keeps the supplied look and motion, once per screen, everywhere', () => {
  const css = CSS.slice(CSS.indexOf('LIGHT / DARK SWITCH'));
  assert.match(css, /height: 64px; width: 104px; border-radius: 9999px; padding: 6px/);
  assert.match(css, /radial-gradient\(ellipse at top left, #ffffff 0%, #f1f5f9 40%, #cbd5e1 100%\)/);
  assert.match(css, /radial-gradient\(ellipse at top left, #1e293b 0%, #0f172a 40%, #020617 100%\)/);
  assert.match(css, /height: 44px; width: 44px/);
  assert.match(THEME, /-300 \* \(x - to\) - 20 \* v/, 'framer-motion spring: stiffness 300, damping 20');
  assert.match(THEME, /const TRAVEL = 46;/);
  assert.match(THEME, /dark \? 0\.5 : 0\.6 \+ i \* 0\.1/, 'particle durations');
  assert.match(THEME, /role="switch" aria-checked="\$\{dark\}"/);
  assert.match(THEME, /aria-label="Switch to \$\{dark \? 'light' : 'dark'\} mode"/);
  assert.match(THEME, /localStorage\.setItem\(KEY, next\)/, 'the choice persists');
  /* one theme control per app, near the profile */
  assert.equal((WEB.match(/\$\{ThemeSwitch\(/g) || []).length, 1);
  assert.doesNotMatch(WEB, /data-act="theme"/, 'the old header button and the Appearance row are gone');
  assert.equal((ADMIN.match(/\$\{ThemeSwitch\(/g) || []).length, 1);
  assert.match(ADMIN, /\$\{ThemeSwitch\(\{ className: 'cc-theme' \}\)\}\s*<div class="cc-profile">/);
  assert.doesNotMatch(ADMIN, /Light or dark/);
  assert.match(ADMIN, /bindThemeSwitch\(\{ storageKey: ADMIN_THEME_KEY \}\)/, 'Campus Control keeps its own saved choice');
  assert.doesNotMatch(SHOP, /data-act="theme"/);
  /* settings that are on/off use the shared switch; acknowledgements stay ticks */
  assert.match(ADMIN, /const check = \(name, label, on\) => Switch\(/);
  assert.match(SHOP, /const check = \(name, label, on\) => Switch\(/);
  assert.match(ADMIN, /\$\{ack\('confirm'/);
  assert.match(ADMIN, /const wBool = [^\n]*Switch\(/);
});
