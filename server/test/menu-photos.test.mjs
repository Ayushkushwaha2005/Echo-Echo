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

const MEDIA = fileURLToPath(new URL('../../packages/media/', import.meta.url));
const fileOf = (url) => fileURLToPath(url);

/* [name, veg] for every dish, exactly as GET /vendors/:id/menu returned it. */
const LIVE_MENU = [
  /* Chai Garam, 67 dishes */
  ["Cold Coffee", true], ["Cold Mocha Coffee", true], ["Extra Strong Cold Coffee", true], ["Adrak Chai", true],
  ["Chai Garam Special", true], ["Elaichi Chai", true], ["Haldi Chai", true], ["Kali Mirch Chai", true],
  ["Kulhad Tea", true], ["Mini Kulhad", true], ["Tulsi Chai", true], ["Adrak Elaichi", true],
  ["Adrak Tulsi", true], ["Dalchini Adrak", true], ["Gur Elaichi", true], ["Kulhad Double Flavour", true],
  ["Saunf Elaichi", true], ["Black Darjeeling", true], ["Black Darjeeling with Lemon Honey", true], ["Chamomile", true],
  ["Green Tea", true], ["Green Tea with Lemon Honey", true], ["Jasmine Green Tea", true], ["Cheese Corn Pasta", true],
  ["Chicken Mix Pasta", false], ["Chicken Pasta", false], ["Chicken Tandoori Pasta", false], ["Mix Sauce Pasta", true],
  ["Pink Pasta", true], ["Punjabi Pasta", true], ["Tandoori Sauce Pasta", true], ["Veg Corn Pasta", true],
  ["Veg Pasta (White/Red)", true], ["Chicken Wrap", false], ["Egg Wrap", false], ["Paneer Wrap", true],
  ["Tandoori Chicken Wrap", false], ["Tandoori Veg Wrap", true], ["Veg Corn Wrap", true], ["Veg Wrap", true],
  ["Chicken Maggi", false], ["Chilli Garlic Maggi", true], ["Plain Maggi", true], ["Tandoori Maggi", true],
  ["Veg Maggi", true], ["American Corn Sandwich", true], ["Cheese Garlic Sandwich", true], ["Chicken Sandwich", false],
  ["Paneer Sandwich", true], ["Paneer Twister", true], ["Peanut Butter Sandwich", true], ["Tandoori Paneer Sandwich", true],
  ["Tandoori Sandwich", null], ["Tomato Cheese Sandwich", true], ["Veg Sandwich", true], ["Corn Chaat", true],
  ["Hot and Sour Soup", true], ["Masala Oats", true], ["Sweet Corn Soup", true], ["Thick Tomato Soup", true],
  ["Veg Oats", true], ["Cheese Fries", true], ["Chicken Nuggets (5 pcs)", false], ["Classic Fries", true],
  ["Peri Peri Fries", true], ["Veg Fingers (5 pcs)", true], ["Veg Nuggets (5 pcs)", true],
  /* Tulips, 24 dishes */
  ["Blueberry Lassi", null], ["Cold Coffee", null], ["Hazelnut Coffee", null], ["Lemon Ice Tea", null],
  ["Nimbupani Masala", null], ["Peach Ice Tea", null], ["Choco Vanilla Softy", null], ["Chocolate Softy", null],
  ["Vanilla Softy", null], ["Chocolate Sundae", null], ["Mango Sundae", null], ["Strawberry Sundae", null],
  ["Blue Lagoon Slush", null], ["Mojito Green Slush", null], ["Chicken Salami Salad Hot Dog", false], ["Chicken Seekh Kebab Hot Dog", false],
  ["Chilly Paneer Hot Dog", true], ["Pasta Bun Hot Dog", true], ["Batata Vada Sandwich", true], ["Cheese Salad Sandwich", true],
  ["Chicken Afghani Spread Sandwich", false], ["Chicken Ham n Cheese Sandwich", false], ["Chicken Keema Rice Bowl", false], ["Rajma Masala Rice Bowl", true],
];
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
