/* ==========================================================================
   ECHO ECHO — CAFÉ AND DISH PHOTOS

   What the photo lookups promise, checked against the real menus:

   * every dish on the live menus (read from the production API on
     2026-10-25) has a photo, and the file it points at exists
   * a vegetarian dish never shows a picture of meat. The stock photos were
     chosen by their source titles as well as by eye ("Veggie Wrap", not
     "beef and bean"), and each carries a `meat` flag this test enforces
   * the same dish always gets the same photo
   * every stock photo is openly licensed and credited
   * the café photographs carry no EXIF, so no GPS position is published
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cafePhoto, dishPhoto, dishPhotoKey, DISH_PHOTOS, DISH_CREDITS } from '../../packages/media/photos.js';
import { LIVE_MENU } from './fixtures/live-menu.mjs';

const MEDIA = fileURLToPath(new URL('../../packages/media/', import.meta.url));
const fileOf = (url) => fileURLToPath(url);

const MEAT_WORDS = /\b(chicken|egg|keema|mutton|fish|ham|salami|prawn|seekh)\b/i;
const isVeg = ([name, veg]) => veg !== false && !MEAT_WORDS.test(name);

test('the fixture is the whole live menu: 91 dishes across both cafés', () => {
  assert.equal(LIVE_MENU.length, 91);
});

test('every live dish maps to a photo whose file exists', () => {
  const missing = LIVE_MENU.filter(([name]) => !dishPhoto(name));
  assert.deepEqual(missing.map(([n]) => n), []);
  for (const [name] of LIVE_MENU) {
    const p = dishPhoto(name);
    assert.ok(existsSync(fileOf(p.src)), `${name}: ${p.src} is not on disk`);
    assert.ok(p.alt.length > 8, `${name}: alt text`);
  }
});

test('a vegetarian dish never shows meat', () => {
  const wrong = LIVE_MENU.filter(isVeg)
    .map(([name]) => [name, dishPhotoKey(name)])
    .filter(([, key]) => DISH_PHOTOS[key].meat);
  assert.deepEqual(wrong, []);
});

test("a dish's photo never shows a different meat than the dish names", () => {
  /* Egg Wrap once showed a photo titled "Chicken Kathi Roll": no veg rule
     catches that, because the dish is not veg. The source title says what
     is in the picture, so a meat it names must be one the dish names too. */
  const MEATS = /\b(chicken|egg|keema|mutton|lamb|beef|pork|fish|ham|salami|bacon|sausage|prawn|shrimp|crab|turkey|chorizo|seekh)\b/gi;
  const wrong = [];
  for (const [name] of LIVE_MENU) {
    const key = dishPhotoKey(name);
    const dish = new Set((name.match(MEATS) || []).map((m) => m.toLowerCase()));
    const shown = (DISH_CREDITS[key].title.match(MEATS) || []).map((m) => m.toLowerCase());
    for (const m of shown) if (!dish.has(m)) wrong.push(`${name} -> ${key} ("${DISH_CREDITS[key].title}")`);
  }
  assert.deepEqual(wrong, []);
});

test('lookups are deterministic and ignore case and punctuation', () => {
  for (const [name] of LIVE_MENU) assert.equal(dishPhoto(name).src, dishPhoto(name).src);
  assert.equal(dishPhotoKey('chicken nuggets (5 PCS)'), dishPhotoKey('Chicken Nuggets (5 pcs)'));
  assert.equal(dishPhotoKey('  Veg Pasta (White/Red) '), dishPhotoKey('Veg Pasta (White/Red)'));
});

test('a new dish gets a photo only when its name says plainly what it is, veg-safe', () => {
  assert.equal(dishPhotoKey('Mystery Box'), null);
  assert.equal(dishPhotoKey(''), null);
  assert.equal(dishPhotoKey('Masala Fries'), 'fries');
  assert.equal(DISH_PHOTOS[dishPhotoKey('Paneer Tikka Roll')].meat, false);
  assert.equal(DISH_PHOTOS[dishPhotoKey('Corn Cheese Sandwich')].meat, false);
  assert.equal(DISH_PHOTOS[dishPhotoKey('Chicken Tikka Roll')].meat, true);
  /* A meat dish with no meat photo for its kind gets none, not a veg one. */
  assert.equal(dishPhotoKey('Chicken Soup'), null);
});

test('every stock photo is openly licensed, credited, and used', () => {
  const OPEN = ['cc0', 'pdm', 'by', 'by-sa'];
  const used = new Set(LIVE_MENU.map(([n]) => dishPhotoKey(n)));
  for (const key of Object.keys(DISH_PHOTOS)) {
    const c = DISH_CREDITS[key];
    assert.ok(c, `${key}: no credit`);
    assert.ok(OPEN.includes(c.license), `${key}: licence ${c.license}`);
    assert.match(c.url, /^https:\/\//, `${key}: source link`);
    assert.match(c.licenseUrl, /^https:\/\/creativecommons\.org\//, `${key}: licence link`);
    assert.ok(c.title && c.creator, `${key}: title and creator`);
    assert.ok(used.has(key), `${key}: credited but no dish uses it`);
  }
  const files = readdirSync(`${MEDIA}dishes`).map((f) => f.replace(/\.webp$/, ''));
  assert.deepEqual(files.sort(), Object.keys(DISH_PHOTOS).sort(), 'files on disk = photos listed');
});

test('both cafés have their own photograph; an unknown café has none', () => {
  for (const slug of ['tulips', 'chai-garam']) {
    const p = cafePhoto(slug);
    assert.ok(p, slug);
    assert.ok(existsSync(fileOf(p.src)), `${slug} fallback jpg`);
    for (const part of p.srcset.split(', ')) {
      const [url, w] = part.split(' ');
      assert.match(w, /^\d+w$/);
      assert.ok(existsSync(fileOf(url)), `${slug}: ${url}`);
    }
    assert.ok(p.alt.includes(slug === 'tulips' ? 'Tulips' : 'Chai Garam'));
    assert.ok(p.scale >= 1);
  }
  assert.notEqual(cafePhoto('tulips').src, cafePhoto('chai-garam').src);
  assert.equal(cafePhoto('frisco'), null);
  assert.equal(cafePhoto(undefined), null);
});

test('no published café photo carries EXIF (the originals hold a GPS fix)', () => {
  for (const f of readdirSync(`${MEDIA}cafes`)) {
    const b = readFileSync(`${MEDIA}cafes/${f}`);
    if (f.endsWith('.webp')) assert.equal(b.indexOf('EXIF', 12), -1, `${f}: EXIF chunk`);
    else assert.equal(b.indexOf('Exif\0'), -1, `${f}: Exif APP1`);
  }
});
