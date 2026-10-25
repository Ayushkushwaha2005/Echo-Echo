/* ==========================================================================
   ECHO ECHO — CAFÉ AND DISH PHOTO MARKUP

   The frames the student site draws photos in: a café's photograph on its
   card and in its menu header, and a dish's photo beside it on the menu.
   They live here rather than in web/src/app.js so the markup the site ships
   can be checked without a browser (server/test/photo-tiles.test.mjs, and
   tests/media-paths.mjs against the built dist/).

   Every frame draws its fallback (the café mark, the dish monogram) first
   and the photo over it, so a photo that fails to load leaves the card or
   tile as it was before photos existed, never an empty box or a broken icon.
   ========================================================================== */
import { esc } from './kit.js';
import { cafePhoto, dishPhoto } from '../media/photos.js';

/* Images that failed to load this session. render() rebuilds the DOM, so a
   broken photo is remembered and the next render draws the fallback (the
   monogram or the café mark, which always sits underneath) straight away. */
export const failedImg = new Set();
export const imgOk = (src) => src && !failedImg.has(src);

/* Installed by the site as a capturing 'error' listener on the document. */
export function onImageError(e) {
  const img = e.target;
  if (img?.tagName !== 'IMG' || !img.hasAttribute('data-fallback')) return;
  failedImg.add(img.getAttribute('src'));
  (img.closest('picture') || img).remove();
}

/* A dish's photo: the counter's own upload when there is one, otherwise a
   stock photo matched to the name (marked illustrative), otherwise none.
   `assetUrl` turns an uploaded asset id into its URL. */
export function dishImage(m, assetUrl) {
  if (m.photo_asset) {
    const src = assetUrl(m.photo_asset);
    return imgOk(src) ? { src, alt: m.name, illustrative: false } : null;
  }
  const p = dishPhoto(m.name);
  return p && imgOk(p.src) ? { src: p.src, alt: `Illustrative photo: ${p.alt}`, illustrative: true } : null;
}

/* The dish's monogram in the display face — the same treatment the
   cafeteria marks use. It stays under the photo, so a photo that fails to
   load leaves the tile exactly as it was before photos existed. */
export const dishMono = (name) => {
  const words = String(name || '?').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
};
export const DishTile = (i, assetUrl) => {
  const ph = dishImage(i, assetUrl);
  return `<div class="item-thumb${ph ? ' has-photo' : ''}"><span class="dish-mono"${ph ? ' aria-hidden="true"' : ''}>${esc(dishMono(i.name))}</span>${ph
    ? `<img class="thumb-photo" src="${esc(ph.src)}" alt="${esc(ph.alt)}" width="84" height="84" loading="lazy" decoding="async" data-fallback>` : ''}</div>`;
};

/* The café's own photograph in a frame of aspect `slot`, over its tint and
   mark (what shows if the photo cannot load). `vw` is how much of the
   viewport the frame spans at each breakpoint, for the browser's pick. */
export const CafPhoto = (c, { slot = 16 / 9, sizes = [100, 50, 33], eager = false, cls = 'cafphoto' } = {}) => {
  const p = cafePhoto(c.slug, slot);
  const img = p && imgOk(p.src) ? p : null;
  const sz = sizes.map((v) => Math.round(v * (img?.scale || 1)));
  return `<div class="${cls}" style="background:${c.heroBg}">
    <span class="cafmark" style="background:${c.markBg}" aria-hidden="true">${esc(c.mark)}</span>
    ${img ? `<picture>
      <source type="${img.type}" srcset="${img.srcset}" sizes="(max-width: 719px) ${sz[0]}vw, (max-width: 1023px) ${sz[1]}vw, ${sz[2]}vw">
      <img src="${img.src}" alt="${esc(img.alt)}" width="${img.width}" height="${img.height}" style="object-position:${img.position}"
        decoding="async" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} data-fallback></picture>` : ''}
  </div>`;
};
export const hasCafPhoto = (c) => !!cafePhoto(c.slug);
