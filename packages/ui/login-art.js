/* ==========================================================================
   ECHO ECHO — CAMPUS CONTROL SIGN-IN: THE ANIMATED LAYOUT

   A plain-JS/CSS port of the "modern animated sign-in" the owner supplied
   (trials pics/logos animation/animation.txt): the ripple, the orbiting
   logos around a gradient title, BoxReveal on each line of the form, the
   input hover glow, the bottom-gradient button and the password eye.
   Same numbers as the original (ripple 11 circles from 100 px, +70 px each;
   orbit radii, sizes, delays and directions per icon), no React, no motion
   library, no Tailwind. Used by the Employee / Admin sign-in only; the
   student site and the counter keep their own screens.

   Logos are local files in brand/orbit (small copies; the originals stay out
   of the site). Sentinel X had no logo, so its mark is an original drawing.
   With prefers-reduced-motion the layout is the same and nothing moves.
   ========================================================================== */
const asset = (name) => new URL(`../../brand/orbit/${name}`, import.meta.url).href;

const LOGOS = {
  echo: { src: asset('echoecho-128.webp'), alt: 'ECHO ECHO' },
  edu: { src: asset('edusentinel-128.webp'), alt: 'EduSentinel' },
  sx: { src: asset('sentinel-x.svg'), alt: 'Sentinel X' },
  anygo: { src: asset('anygo-128.webp'), alt: 'AnyGo' },
};
/* [logo, size px, radius px, delay s, reverse] — the original's eight. */
const ORBIT = [
  ['echo', 30, 100, 10, false], ['edu', 50, 210, 10, false], ['sx', 50, 210, 20, false],
  ['anygo', 30, 150, 20, true], ['sx', 30, 150, 10, true], ['echo', 50, 270, 10, true],
  ['anygo', 50, 270, 60, true], ['edu', 50, 320, 20, false],
];

let art = null;
/* The left half, built once and reused, so moving between sign-in steps does
   not restart the orbit. */
function leftArt() {
  if (art) return art;
  const ripple = Array.from({ length: 11 }, (_, i) => `<span class="al-ring${i === 10 ? ' dashed' : ''}" style="--s:${100 + i * 70}px;--o:${(0.24 - i * 0.03).toFixed(2)};--d:${(i * 0.06).toFixed(2)}s;--b:${(5 + i * 5) / 100}"></span>`).join('');
  const orbit = ORBIT.map(([k, size, r, delay, rev]) => `
    <span class="al-orbit${rev ? ' rev' : ''}" style="--r:${r};--delay:${-delay};--size:${size}px">
      <img src="${LOGOS[k].src}" alt="" width="${size}" height="${size}" decoding="async"></span>`).join('');
  const t = document.createElement('template');
  t.innerHTML = `<aside class="al-art" aria-hidden="true">
    <div class="al-ripple">${ripple}</div>
    <div class="al-stage"><span class="al-title">ECHO ECHO</span>${orbit}</div>
    <p class="al-family">ECHO ECHO · EduSentinel · Sentinel X · AnyGo</p>
  </aside>`;
  art = t.content.firstElementChild;
  return art;
}

/* Wraps a sign-in card in the two-column layout and animates it in. */
export function animatedShell(node) {
  const card = node.querySelector('.auth-card') || node;
  const screen = document.createElement('div');
  screen.className = 'al-screen';
  const main = document.createElement('main');
  main.className = 'al-main';
  card.classList.add('al-card');
  /* BoxReveal: each line of the card is covered, then uncovered. */
  [...card.children].forEach((child, i) => {
    if (child.matches('input[type=hidden]')) return;
    const wrap = document.createElement('div');
    wrap.className = 'al-reveal';
    wrap.style.setProperty('--i', i);
    child.replaceWith(wrap);
    wrap.append(child, Object.assign(document.createElement('span'), { className: 'al-cover' }));
  });
  card.querySelectorAll('.auth-input').forEach(glow);
  card.querySelectorAll('input[type=password]').forEach(eye);
  card.querySelectorAll('.auth-btn').forEach((b) => {
    b.classList.add('al-btn');
    b.append(Object.assign(document.createElement('span'), { className: 'al-btn-line' }));
  });
  /* The step's own node goes in whole: its listeners (submit, back, forgot)
     are on it, so the card must stay inside it. */
  node.classList.add('al-step');
  main.append(node);
  screen.append(leftArt(), main);
  return screen;
}

/* The input's hover glow: a 100 px radial light that follows the pointer. */
function glow(input) {
  const ring = document.createElement('span');
  ring.className = 'al-glow';
  input.replaceWith(ring);
  ring.append(input);
  ring.addEventListener('pointermove', (e) => {
    const r = ring.getBoundingClientRect();
    ring.style.setProperty('--x', `${e.clientX - r.left}px`);
    ring.style.setProperty('--y', `${e.clientY - r.top}px`);
  });
  ring.addEventListener('pointerenter', () => ring.classList.add('on'));
  ring.addEventListener('pointerleave', () => ring.classList.remove('on'));
}

/* Show / hide the password, keeping focus and caret in the field. */
function eye(input) {
  const holder = input.closest('.al-glow') || input.parentElement;
  holder.classList.add('al-has-eye');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'al-eye';
  b.setAttribute('aria-label', 'Show password');
  b.setAttribute('aria-pressed', 'false');
  const ICON_SHOW = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ICON_HIDE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0112 5c6.4 0 10 7 10 7a17.6 17.6 0 01-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a10.4 10.4 0 005.4-1.6"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/></svg>';
  b.innerHTML = ICON_SHOW;
  b.addEventListener('click', () => {
    const show = input.type === 'password';
    const [s, e] = [input.selectionStart, input.selectionEnd];
    input.type = show ? 'text' : 'password';
    b.innerHTML = show ? ICON_HIDE : ICON_SHOW;
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    b.setAttribute('aria-pressed', String(show));
    input.focus();
    try { input.setSelectionRange(s, e); } catch { /* not every type allows it */ }
  });
  holder.append(b);
}
