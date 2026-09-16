/* ==========================================================================
   ECHO ECHO — A CAMPUS THAT IS NOT IN SERVICE CANNOT BE CHOSEN

   Bidholi takes orders. Kandholi is listed, because it is real and students
   look for it, and it is plainly marked as not open yet — but it must behave
   like a disabled option, not an available one that happens to say so.

   "Disabled" here is not a styling claim. The card is rendered as a plain
   element rather than a button, which is what actually removes every route
   forward: nothing to click, nothing to focus, nothing to activate with
   Enter or Space, and no data-act for the screen's click handler to
   dispatch. A greyed-out <button> would still be all four of those things.

   The server refusing to take a Kandholi order is tested in trust.test.mjs;
   this is about the screen never offering it in the first place.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { campusOption } from '../../packages/ui/campus-option.js';

const BIDHOLI = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Bidholi Campus',
  collegeName: 'UPES — University of Petroleum and Energy Studies',
  available: true,
};
const KANDHOLI = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Kandholi Campus',
  collegeName: 'UPES — University of Petroleum and Energy Studies',
  available: false,
  message: 'Service coming soon for Kandholi Campus.',
};

/* ---------- Bidholi is a real, working choice ----------------------------- */

test('an available campus is a button the student can actually press', async () => {
  const html = campusOption(BIDHOLI, { act: 'pickObCampus' });
  assert.match(html, /<button/, 'an available campus must be a button');
  assert.match(html, /data-act="pickObCampus"/, 'it must dispatch the pick action');
  assert.match(html, new RegExp(`data-id="${BIDHOLI.id}"`));
  assert.match(html, /Bidholi Campus/);
  assert.doesNotMatch(html, /is-disabled/);
  assert.doesNotMatch(html, /aria-disabled/);
});

test('the selected campus is the one marked selected, in both screens', async () => {
  for (const act of ['pickObCampus', 'pickCampus']) {
    assert.match(campusOption(BIDHOLI, { act, selected: true }), /aria-checked="true"/);
    assert.match(campusOption(BIDHOLI, { act, selected: false }), /aria-checked="false"/);
  }
});

/* ---------- Kandholi is visible and inert --------------------------------- */

test('Kandholi is shown, and shown as coming soon', async () => {
  const html = campusOption(KANDHOLI, { act: 'pickObCampus' });
  assert.match(html, /Kandholi Campus/, 'it must still be listed — students look for it');
  assert.match(html, /Coming soon/);
});

test('Kandholi is not a button, so there is nothing to click or key-activate', async () => {
  const html = campusOption(KANDHOLI, { act: 'pickObCampus' });
  assert.doesNotMatch(html, /<button/,
    'a disabled button is still focusable and clickable — it must not be a button at all');
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, /tabindex="-1"/, 'it must not be reachable by keyboard');
  assert.match(html, /is-disabled/, 'the class that removes pointer events');
});

test('Kandholi carries no action for the click handler to dispatch', async () => {
  for (const act of ['pickObCampus', 'pickCampus']) {
    const html = campusOption(KANDHOLI, { act });
    assert.doesNotMatch(html, /data-act=/,
      'with no data-act there is no route to the next screen, however the card is hit');
    assert.doesNotMatch(html, /data-id=/);
  }
});

test('Kandholi never renders as selected, whatever it is passed', async () => {
  const html = campusOption(KANDHOLI, { act: 'pickObCampus', selected: true });
  assert.match(html, /aria-checked="false"/,
    'an unavailable campus has no selected state, even if asked for one');
  assert.doesNotMatch(html, /aria-pressed="true"/);
});

/* ---------- the rule is the server's, not the screen's -------------------- */

test('availability comes from the server field, not from the campus name', async () => {
  /* The same campus, flipped by the server, flips the card. Nothing here
     hard-codes "Kandholi": when the campus opens, this card opens with it. */
  const opened = campusOption({ ...KANDHOLI, available: true }, { act: 'pickObCampus' });
  assert.match(opened, /<button/);
  assert.match(opened, /data-act="pickObCampus"/);

  const closed = campusOption({ ...BIDHOLI, available: false }, { act: 'pickObCampus' });
  assert.doesNotMatch(closed, /<button/);
  assert.doesNotMatch(closed, /data-act=/);
});

test('a campus name is escaped, not interpolated as markup', async () => {
  const nasty = campusOption(
    { id: 'x', name: '<img src=x onerror=alert(1)>', available: false }, { act: 'pickObCampus' });
  assert.doesNotMatch(nasty, /<img/);
  assert.match(nasty, /&lt;img/);
});
