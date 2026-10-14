/* ==========================================================================
   ECHO ECHO — THE LOGO

   The owner-approved artwork is brand/logo/echoecho-logo-original.jpeg,
   kept byte-for-byte. Every file this module points at was derived from it
   by tools/logo-assets.py: resizes of the whole logo, and resizes of ONE
   square crop of it (the chef's head and hat) for sizes where the whole
   logo cannot be read, such as favicons and a 28 px mark. Nothing is
   redrawn, recoloured or restyled here.

   URLs are resolved against this module, so they work unchanged in the
   source tree and in the content-hashed build folder.
   ========================================================================== */
const asset = (name) => new URL(`./logo/${name}`, import.meta.url).href;

export const BRAND_NAME = 'ECHO ECHO';
export const LOGO_ALT = 'ECHO ECHO logo: a chef robot with a burger, fries, pizza and bubble tea, "Good Food, Better Vibes"';

/* The whole logo. `size` is the rendered square edge in CSS pixels. */
export function logo({ size = 160, alt = LOGO_ALT, className = 'brand-logo', eager = false } = {}) {
  const src = size > 160 ? asset('echoecho-logo-640.webp') : asset('echoecho-logo-320.webp');
  return `<img class="${className}" src="${src}" width="${size}" height="${size}" alt="${alt}"`
    + ` decoding="async"${eager ? ' fetchpriority="high"' : ' loading="lazy"'}>`;
}

/* The chef-head crop. Decorative by default: it sits beside the name. */
export function mark({ size = 32, alt = '' } = {}) {
  const src = size > 48 ? asset('echoecho-mark-192.webp') : asset('echoecho-mark-96.webp');
  return `<img class="brand-mark" src="${src}" width="${size}" height="${size}" alt="${alt}"`
    + `${alt ? '' : ' aria-hidden="true"'} decoding="async">`;
}

/* The whole logo + name, for every navbar (student site header, Counter and
   Campus Control rails). The complete artwork is shown, scaled down with
   object-fit: contain, never the head crop and never clipped: the name next
   to it carries the legibility at this size. */
export function lockup({ height = 28 } = {}) {
  return `<span class="brand-lockup" style="--brand-h:${height}px">`
    + logo({ size: height, alt: '', className: 'brand-logo brand-logo-nav', eager: true })
    + `<span class="brand-name">${BRAND_NAME}</span></span>`;
}

/* Root-level icons, copied to the site root by build.mjs. */
export const ICON_FILES = ['favicon.ico', 'favicon-32.png', 'icon-192.png', 'apple-touch-icon.png', 'og-image.jpg'];
