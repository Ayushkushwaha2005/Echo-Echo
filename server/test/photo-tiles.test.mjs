/* ==========================================================================
   ECHO ECHO — THE PHOTO FRAMES THE STUDENT SITE DRAWS

   packages/ui/photo-tiles.js is the markup web/src/app.js puts on the café
   cards, in each café's menu header, and beside every dish. These check what
   it actually emits, not just the lookups behind it:

   * a café card and a café header carry that café's own photograph (and not
     the other café's), over the café mark that shows if it cannot load
   * every dish on the live menus renders with its mapped photo, not just
     the monogram; a photo the counter uploaded wins
   * an image that fails to load is dropped and remembered, and the next
     render draws the mark or monogram with the card intact
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cafePhoto, dishPhoto } from '../../packages/media/photos.js';
import { CafPhoto, DishTile, dishImage, hasCafPhoto, onImageError, failedImg } from '../../packages/ui/photo-tiles.js';
import { LIVE_MENU } from './fixtures/live-menu.mjs';

const CAFES = {
  tulips: { slug: 'tulips', heroBg: 'var(--ok-bg)', markBg: 'var(--open-500)', mark: 'T' },
  'chai-garam': { slug: 'chai-garam', heroBg: 'var(--warn-bg)', markBg: 'var(--coral-500)', mark: 'CG' },
};
const assetUrl = (id) => `/api/assets/${id}`;
const imgSrcs = (html) => [...html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);

/* A minimal <img> as the capturing error listener sees it. */
function brokenImg(src, { fallback = true, inPicture = false } = {}) {
  const removed = [];
  const picture = { remove: () => removed.push('picture') };
  const img = {
    tagName: 'IMG',
    hasAttribute: (a) => a === 'data-fallback' && fallback,
    getAttribute: (a) => (a === 'src' ? src : null),
    closest: (sel) => (sel === 'picture' && inPicture ? picture : null),
    remove: () => removed.push('img'),
  };
  return { event: { target: img }, removed };
}

test.beforeEach(() => failedImg.clear());

test('a café card shows that café\'s own photograph over its mark', () => {
  for (const [slug, c] of Object.entries(CAFES)) {
    const p = cafePhoto(slug);
    const html = CafPhoto(c);
    assert.ok(hasCafPhoto(c), slug);
    assert.match(html, /<picture>/, `${slug}: no <picture>`);
    assert.deepEqual(imgSrcs(html), [p.src], `${slug}: card <img>`);
    assert.ok(html.includes(`srcset="${p.srcset}"`), `${slug}: srcset`);
    assert.ok(html.includes(`object-position:${p.position}`), `${slug}: framing`);
    assert.ok(html.includes('loading="lazy"'), `${slug}: a card photo is lazy`);
    assert.match(html, new RegExp(`<span class="cafmark"[^>]*>${c.mark}</span>`), `${slug}: mark underneath`);
    const other = slug === 'tulips' ? 'chai-garam-cafe' : 'tulips-cafe';
    assert.ok(!html.includes(other), `${slug}: shows the other café's photo`);
  }
});

test('a café header shows the photograph eagerly, in the 2:1 header frame', () => {
  for (const [slug, c] of Object.entries(CAFES)) {
    const html = CafPhoto(c, { slot: 2, sizes: [100, 100, 45], eager: true, cls: 'cafphoto cafhero-photo' });
    assert.match(html, /class="cafphoto cafhero-photo"/);
    assert.deepEqual(imgSrcs(html), [cafePhoto(slug, 2).src]);
    assert.ok(html.includes('fetchpriority="high"') && !html.includes('loading="lazy"'), `${slug}: eager`);
    assert.ok(html.includes(`${slug === 'tulips' ? 'tulips' : 'chai-garam'}-cafe-`), slug);
  }
});

test('a café with no photograph draws only its mark', () => {
  const c = { slug: 'frisco', heroBg: 'var(--rose-100)', markBg: 'var(--rose-500)', mark: 'F' };
  assert.equal(hasCafPhoto(c), false);
  const html = CafPhoto(c);
  assert.equal(imgSrcs(html).length, 0);
  assert.match(html, /<span class="cafmark"[^>]*>F<\/span>/);
});

test('every live dish renders its mapped photo, with the monogram beneath', () => {
  for (const [name] of LIVE_MENU) {
    const html = DishTile({ name }, assetUrl);
    assert.match(html, /^<div class="item-thumb has-photo">/, `${name}: no photo tile`);
    assert.deepEqual(imgSrcs(html), [dishPhoto(name).src], `${name}: wrong photo`);
    assert.match(html, /alt="Illustrative photo: /, `${name}: marked illustrative`);
    assert.match(html, /<span class="dish-mono" aria-hidden="true">[A-Z0-9]{1,2}<\/span>/, `${name}: monogram`);
    assert.ok(html.includes('data-fallback'), `${name}: no fallback hook`);
  }
});

test('a photo the counter uploaded wins over the stock photo', () => {
  const m = { name: 'Cold Coffee', photo_asset: 'a1b2' };
  assert.deepEqual(dishImage(m, assetUrl), { src: '/api/assets/a1b2', alt: 'Cold Coffee', illustrative: false });
  assert.deepEqual(imgSrcs(DishTile(m, assetUrl)), ['/api/assets/a1b2']);
});

test('a dish photo that fails to load falls back to the monogram, card intact', () => {
  const name = 'Chocolate Sundae';
  const src = dishPhoto(name).src;
  const { event, removed } = brokenImg(src);
  onImageError(event);
  assert.deepEqual(removed, ['img'], 'the broken <img> is removed');
  const html = DishTile({ name }, assetUrl);
  assert.equal(imgSrcs(html).length, 0, 'not retried on the next render');
  assert.equal(html, '<div class="item-thumb"><span class="dish-mono">CS</span></div>');
  /* Other dishes are unaffected. */
  assert.equal(imgSrcs(DishTile({ name: 'Mango Sundae' }, assetUrl)).length, 1);
});

test('a café photo that fails to load falls back to the café mark', () => {
  const c = CAFES.tulips;
  const { event, removed } = brokenImg(cafePhoto('tulips').src, { inPicture: true });
  onImageError(event);
  assert.deepEqual(removed, ['picture'], 'the whole <picture> goes');
  const html = CafPhoto(c);
  assert.ok(!html.includes('<picture>'));
  assert.match(html, /<span class="cafmark"[^>]*>T<\/span>/);
  assert.ok(CafPhoto(CAFES['chai-garam']).includes('<picture>'), 'the other café still has its photo');
});

test('only fallback-marked images are handled; other errors are left alone', () => {
  const { event, removed } = brokenImg('/brand/logo.png', { fallback: false });
  onImageError(event);
  onImageError({ target: { tagName: 'SCRIPT' } });
  onImageError({ target: null });
  assert.deepEqual(removed, []);
  assert.equal(failedImg.size, 0);
});
