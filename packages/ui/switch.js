/* ==========================================================================
   ECHO ECHO — SWITCH  (from the owner's material-design-3-switch.tsx)

   The supplied React component, rebuilt for this project's string-template
   screens without React, Tailwind, cva or lucide-react:

   * the same structure: a <label> with a visually hidden checkbox (the real
     control, so forms, keyboard and screen readers work), a track, a handle
     container that slides on the spring curve, the handle, optional
     morphing icons and the hover / press halo;
   * the same numbers: 52×32 track (40×24 small), 2 px border, 16 → 24 px
     handle (12 → 16 small), 28 px while pressed, 20 px travel (16 small),
     300 ms on cubic-bezier(0.175, 0.885, 0.32, 1.275), 48 px touch target;
   * the same variants: primary, destructive; sizes default and sm; icons
     (Check / X by default, or any SVG given); haptic 'heavy' | 'light' |
     'none' (default none: the sound plays only where a screen asks for it).

   React state became CSS: `checked` is the input's :checked, `isPressed` is
   :active, `isHovered` is :hover. The haptic sound needs script, installed
   once by bindSwitches().

   The Tailwind colour names map to this design system's tokens in
   components.css (.m3s): primary → --accent, destructive → --danger, muted
   → --surface-2, border → --line-strong, foreground → --text.
   ========================================================================== */

const attr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* lucide-react icons used by the source and its demo, as inline SVG (ISC). */
const svg = (body, size, stroke = 2, fill = 'none') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
export const SWITCH_ICONS = {
  check: (size = 14) => svg('<path d="M20 6 9 17l-5-5"/>', size, 4),
  x: (size = 14) => svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', size, 4),
  lock: (size = 12) => svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>', size),
  unlock: (size = 12) => svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>', size),
  sun: (size = 14) => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>', size, 2, 'currentColor'),
  moon: (size = 14) => svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', size, 2, 'currentColor'),
};

/**
 * One switch, as HTML.
 *   name, checked, disabled, id         the checkbox's own attributes
 *   attrs                               more attributes for the checkbox (string)
 *   variant: 'primary' | 'destructive'
 *   size: 'default' | 'sm'
 *   showIcons                           Check / X in the handle
 *   checkedIcon, uncheckedIcon          SVG strings instead
 *   haptic: 'heavy' | 'light' | 'none'
 *   label                               visible text beside the switch
 *   ariaLabel                           accessible name when there is no label
 *   className                           extra class on the track
 */
export function Switch({
  name = '', checked = false, disabled = false, id = '', attrs = '',
  variant = 'primary', size = 'default', showIcons = false, checkedIcon = '', uncheckedIcon = '',
  haptic = 'none', label = '', ariaLabel = '', className = '',
} = {}) {
  const small = size === 'sm';
  const icons = showIcons || checkedIcon || uncheckedIcon;
  const iconPx = small ? 10 : 14;
  const input = `<input type="checkbox" role="switch" class="m3s-input"${name ? ` name="${attr(name)}"` : ''}${id ? ` id="${attr(id)}"` : ''}`
    + `${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}${haptic !== 'none' ? ` data-haptic="${attr(haptic)}"` : ''}`
    + `${ariaLabel && !label ? ` aria-label="${attr(ariaLabel)}"` : ''}${attrs ? ` ${attrs}` : ''}>`;
  const sw = `<span class="m3s m3s-${variant === 'destructive' ? 'destructive' : 'primary'}${small ? ' m3s-sm' : ''}${icons ? ' m3s-icons' : ''}${disabled ? ' is-disabled' : ''}">
    ${input}<span class="m3s-track${className ? ` ${attr(className)}` : ''}" aria-hidden="true"><span class="m3s-slide">
      <span class="m3s-handle">${icons ? `<span class="m3s-icon-box">
        <span class="m3s-icon m3s-icon-on">${checkedIcon || SWITCH_ICONS.check(iconPx)}</span>
        <span class="m3s-icon m3s-icon-off">${uncheckedIcon || SWITCH_ICONS.x(iconPx)}</span></span>` : ''}</span>
      <span class="m3s-halo"></span></span></span></span>`;
  return label
    ? `<label class="m3s-field${disabled ? ' is-disabled' : ''}">${sw}<span class="m3s-text">${label}</span></label>`
    : `<label class="m3s-solo">${sw}</label>`;
}

/* ---- the audio haptic engine, exactly as supplied -------------------------- */
export function playHapticFeedback(type) {
  if (type === 'none' || !type || typeof window === 'undefined') return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    const now = ctx.currentTime;
    if (type === 'heavy') {
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(180, now);
      oscillator.frequency.exponentialRampToValueAtTime(40, now + 0.15);
      gainNode.gain.setValueAtTime(0.4, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
      oscillator.start(now);
      oscillator.stop(now + 0.15);
    } else {
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(800, now);
      gainNode.gain.setValueAtTime(0.15, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.08);
      oscillator.start(now);
      oscillator.stop(now + 0.08);
    }
    oscillator.onended = () => ctx.close?.();
  } catch (e) {
    console.error('Audio haptic failed', e);
  }
}

/* Installed once per page: plays the sound for switches that ask for it. */
let bound = false;
export function bindSwitches(doc = typeof document === 'undefined' ? null : document) {
  if (bound || !doc) return;
  bound = true;
  doc.addEventListener('change', (e) => {
    const t = e.target;
    if (t?.classList?.contains('m3s-input') && t.dataset.haptic && !t.disabled) playHapticFeedback(t.dataset.haptic);
  });
}
