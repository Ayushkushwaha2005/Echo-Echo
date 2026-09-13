/* ==========================================================================
   BUNDLE SMOKE — every built surface actually runs

   Catches what a syntax check cannot: a module the build did not copy, an
   import of a name that is not exported, or anything that throws while a
   surface's modules evaluate and its first screen renders.

   This test used to look for `dist/frisco-web.html` and friends — a single
   self-contained HTML file with the whole app inlined in one <script>. That
   was the PROTOTYPE's artifact shape (see prototype/build.sh, which still
   emits prototype/dist/frisco.html) and it was carried over when the product
   build was written. It is not what Quad ships.

   Quad's production artifact is deliberately not a bundle. `build.mjs` copies
   the ES modules into dist/ and injects the API base, so what ships is what
   you read. The artifact is therefore three pages —

     dist/web/index.html      + dist/web/src/app.js
     dist/admin/index.html    + dist/admin/src/app.js
     dist/shop/index.html     + dist/shop/src/app.js

   — each pulling dist/packages/** and dist/brand/** as real modules. So the
   test follows the artifact rather than the artifact being reshaped to suit
   the test: it reads each built index.html, finds the entry module the way a
   browser would, and imports it so the whole dist/ graph evaluates for real.

   Each surface runs in its own process (tests/helpers/surface-run.mjs),
   because ES modules evaluate in the realm that imports them: sharing one
   process would let one surface's globals, module cache and failures leak
   into the next.
   ========================================================================== */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const runner = join(here, 'helpers', 'surface-run.mjs');

const SURFACES = [
  ['web', 'the student site'],
  ['admin', 'Campus Control'],
  ['shop', 'Counter'],
];

let fails = 0;

if (!existsSync(join(root, 'dist'))) {
  console.log('  FAIL  dist/ does not exist — run `node build.mjs` first');
  process.exit(1);
}

for (const [surface, label] of SURFACES) {
  const r = spawnSync(process.execPath, [runner, surface],
                      { encoding: 'utf8', cwd: root });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status === 0) {
    console.log(`  PASS  ${label} (dist/${surface}) evaluated and rendered without throwing`);
  } else {
    console.log(`  FAIL  ${label} (dist/${surface})`);
    for (const line of out.split('\n')) console.log(`        ${line}`);
    fails++;
  }
}

console.log(fails ? `\n${fails} surface(s) failed to run` : '\nAll surfaces execute cleanly');
process.exit(fails ? 1 : 0);
