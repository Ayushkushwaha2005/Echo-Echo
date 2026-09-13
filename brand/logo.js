/* ==========================================================================
   QUAD — LOGO SYSTEM

   The mark is a quadrangle: four blocks around an open centre, the shape of
   a campus courtyard seen from above. Three sides are solid and one is
   drawn as an opening — the gate. It reads as architecture rather than as
   food, delivery or AI, which is the point: the platform is the campus,
   the cafeterias are the tenants.

   It is built from four rectangles on a 32-unit grid, so it stays crisp at
   16px favicon size where a detailed mark would turn to mush. Every variant
   below is the same geometry — nothing is redrawn per size.

   currentColor throughout, so the monochrome variants are the same file
   with a different inherited colour rather than separate assets.
   ========================================================================== */

/* The mark alone. `open` draws the gate; solid=false is the outline form. */
export function mark({ size = 32, gate = true, accent = 'var(--rose-500, #E0567A)' } = {}) {
  return `
<svg viewBox="0 0 32 32" width="${size}" height="${size}" fill="none"
     xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <!-- north range -->
  <rect x="4"  y="4"  width="24" height="6" rx="1.5" fill="currentColor"/>
  <!-- west range -->
  <rect x="4"  y="12" width="6"  height="16" rx="1.5" fill="currentColor"/>
  <!-- east range -->
  <rect x="22" y="12" width="6"  height="16" rx="1.5" fill="currentColor"/>
  <!-- south range, broken by the gate: the courtyard is enterable -->
  ${gate
    ? `<rect x="12" y="22" width="4" height="6" rx="1.5" fill="${accent}"/>`
    : `<rect x="12" y="22" width="16" height="6" rx="1.5" fill="currentColor"/>`}
</svg>`.trim();
}

/* Primary lockup: mark + wordmark. */
export function lockup({ height = 28, accent = 'var(--rose-500, #E0567A)' } = {}) {
  return `
<svg viewBox="0 0 172 32" height="${height}" fill="none"
     xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ECHO ECHO">
  <rect x="4"  y="4"  width="24" height="6"  rx="1.5" fill="currentColor"/>
  <rect x="4"  y="12" width="6"  height="16" rx="1.5" fill="currentColor"/>
  <rect x="22" y="12" width="6"  height="16" rx="1.5" fill="currentColor"/>
  <rect x="12" y="22" width="4"  height="6"  rx="1.5" fill="${accent}"/>
  <text x="40" y="24" font-family="Bricolage Grotesque, Manrope, system-ui, sans-serif"
        font-size="21" font-weight="800" letter-spacing="-0.6" fill="currentColor">ECHO ECHO</text>
</svg>`.trim();
}

/* Favicon: heavier strokes so the shape survives 16px. */
export const favicon = () => `
<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <rect width="32" height="32" rx="7" fill="#1C1917"/>
  <rect x="6"  y="6"  width="20" height="5" rx="1.2" fill="#FAF7F2"/>
  <rect x="6"  y="13" width="5"  height="13" rx="1.2" fill="#FAF7F2"/>
  <rect x="21" y="13" width="5"  height="13" rx="1.2" fill="#FAF7F2"/>
  <rect x="13" y="21" width="4"  height="5"  rx="1.2" fill="#E0567A"/>
</svg>`.trim();

/* Monochrome — for print, embossing, and any single-ink context. */
export const monochrome = (size = 32) => mark({ size, accent: 'currentColor' });

/* Variants differ only by the colour they inherit. */
export const onLight = (size) => `<span style="color:#1C1917">${mark({ size })}</span>`;
export const onDark  = (size) => `<span style="color:#FAF7F2">${mark({ size })}</span>`;

/* Data-URI favicon, so no extra network request and no separate file to
   keep in sync with the mark above. */
export const faviconDataUri = () =>
  'data:image/svg+xml,' + encodeURIComponent(favicon());
