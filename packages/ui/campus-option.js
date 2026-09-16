/* ==========================================================================
   ECHO ECHO — THE CAMPUS OPTION

   One campus, as one selectable thing. It exists as its own module for one
   reason: "a campus that is not in service yet cannot be chosen" is a rule,
   and a rule that is spelled out twice in two screens is a rule that will
   eventually be true in one of them.

   Both the sign-in step and the profile setup step render through here, and
   the rule is tested here, once.

   `available` is the SERVER's word for whether the campus is in service. It
   is never computed in the browser, and the server refuses orders for a
   campus it did not mark available whatever the markup ends up saying — this
   module decides what the screen offers, not what the platform permits.
   ========================================================================== */

/* Text, never markup: a campus name arrives from the database. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * One campus card.
 *
 * An available campus is a <button>: focusable, clickable, keyboard
 * activatable, and carrying the data-act the screen's click handler reads.
 *
 * An unavailable one is a plain <div>. Not a disabled button — nothing to
 * focus, nothing to press, no data-act to dispatch, and `pointer-events:none`
 * from `.is-disabled` on top. There is deliberately no path from this card to
 * the next screen, by pointer or by keyboard.
 *
 * @param c          a campus row from GET /campuses
 * @param opts.act   the data-act an AVAILABLE card dispatches
 * @param opts.selected  whether this campus is the current choice
 * @param opts.openLabel  the badge wording for an available campus
 * @param opts.note  an optional line under an available campus
 */
export function campusOption(c, { act, selected = false, openLabel = 'Open', note = '' } = {}) {
  const name = esc(c.name);

  if (!c.available) {
    return `
      <div class="loccard is-disabled" role="radio" aria-checked="false" aria-disabled="true" tabindex="-1">
        <span class="row g2" style="justify-content:space-between;width:100%">
          <span class="t-h3">${name}</span>
          <span class="badge badge-closed">Coming soon</span>
        </span>
      </div>`;
  }

  return `
    <button type="button" class="loccard" role="radio" data-act="${esc(act)}" data-id="${esc(c.id)}"
            aria-checked="${selected}" aria-pressed="${selected}"
            style="width:100%;text-align:left">
      <span class="row g2" style="justify-content:space-between;width:100%">
        <span class="t-h3">${name}</span>
        <span class="badge badge-open">${esc(openLabel)}</span>
      </span>
      ${note ? `<span class="t-xs muted">${esc(note)}</span>` : ''}
    </button>`;
}
