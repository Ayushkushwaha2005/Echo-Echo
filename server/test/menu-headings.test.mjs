/* ==========================================================================
   MENU CATEGORY HEADINGS (student site, every café)
   Every section of a café's menu opens with the same highlighted heading: a
   real <h2> with the category name and how many dishes follow, in a section
   the category chips can jump to. No category is singled out.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const WEB = read('../../web/src/app.js');
const CSS = read('../../packages/design-system/web.css');
const menu = WEB.slice(WEB.indexOf('function ScrMenu()'), WEB.indexOf('/* ===================== STUDENT: cart / checkout'));

test('every category is rendered with the same heading, not a caption', () => {
  assert.match(menu, /cats\.map\(\(cat, i\) => \{/, 'one template for all categories');
  assert.match(menu, /<section class="menusec" id="cat-\$\{i\}" aria-labelledby="cat-\$\{i\}-h">/);
  assert.match(menu, /<h2 class="menucat" id="cat-\$\{i\}-h"><span class="menucat-name">\$\{esc\(cat\)\}<\/span>/);
  assert.match(menu, /\$\{inCat\.length\} \$\{inCat\.length === 1 \? 'item' : 'items'\}/);
  assert.doesNotMatch(menu, /\$\{Label\(cat\)\}/, 'the small caption is gone');
  assert.doesNotMatch(menu, /Sundae|Slush|Hot Dog/, 'no category is special-cased');
  /* the chips still jump to the sections */
  assert.match(WEB, /document\.getElementById\(`cat-\$\{a\.cat\}`\)/);
});

test('the heading style: display face, accent pill from theme tokens, separated sections', () => {
  const css = CSS.slice(CSS.indexOf('menu category headings'));
  assert.match(css, /\.menucat-name \{[^}]*background: var\(--accent-soft\); color: var\(--accent-text\)/);
  assert.match(css, /font-family: var\(--font-display\)[^;]*; font-size: 1\.125rem; font-weight: 700/);
  assert.match(css, /\.menusec \+ \.menusec \{ border-top: 1px solid var\(--line\)/);
  assert.match(css, /scroll-margin-top/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, 'colours come from theme tokens, so light and dark both work');
});
