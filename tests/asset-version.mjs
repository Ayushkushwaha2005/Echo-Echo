/* ==========================================================================
   ASSET VERSIONING — a page only ever runs modules from its own deployment

   The failure this guards, measured on 16 Oct 2026: the campus location
   modal of a page opened before a deploy asked for
   /_v/a5ff3b9fd514/packages/ui/map.js on first use, and got the 404 page
   (text/html) because the deploy had replaced /_v/ with /_v/479aed949e6a/.
   The fix is that every module a page can import, the late ones included,
   is preloaded with the page. This checks the built dist/ that ships:

     - dist/version.json names the one build in dist/_v/
     - each page references that build only, never an unversioned asset
     - every module reachable from each entry - static and dynamic - exists
       in that build and is preloaded by the page (the map in particular)
     - vercel.json caches _v/ forever and the pages and version.json never

   Run after `node build.mjs` (CI runs it on the as-deployed build).
   ========================================================================== */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
let fails = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); fails++; };
const check = (cond, pass, fail = pass) => (cond ? ok(pass) : bad(fail));

if (!existsSync(join(dist, 'version.json'))) {
  bad('dist/version.json does not exist - run `node build.mjs` first');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8'));
const builds = readdirSync(join(dist, '_v'));
check(/^[0-9a-f]{12}$/.test(version) && builds.length === 1 && builds[0] === version,
  `dist/version.json names the only build in dist/_v (${version})`,
  `dist/version.json says ${version}, dist/_v holds ${builds.join(', ')}`);
const assets = join(dist, '_v', version);

/* Everything a module can import, read the way the browser resolves it. */
const IMPORTS = /^\s*(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|^\s*import\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gm;
function reachable(entry) {
  const seen = new Set();
  const missing = [];
  const visit = (file) => {
    if (seen.has(file)) return;
    if (!existsSync(file)) { missing.push(relative(assets, file).replace(/\\/g, '/')); return; }
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORTS)) visit(join(dirname(file), m[1] || m[2] || m[3]));
  };
  visit(entry);
  return { files: [...seen].map((f) => relative(assets, f).replace(/\\/g, '/')), missing };
}

const LATE = { web: ['packages/ui/map.js', 'packages/ui/load-module.js'],
               admin: ['packages/ui/map.js', 'packages/ui/login.js'],
               shop: ['packages/ui/login.js'] };

for (const surface of ['web', 'admin', 'shop']) {
  const html = readFileSync(join(dist, surface, 'index.html'), 'utf8');
  const named = [...html.matchAll(/_v\/([0-9a-f]+)\//g)].map((m) => m[1]);
  check(named.length > 0 && named.every((v) => v === version),
    `${surface}: every asset reference is /_v/${version}/`,
    `${surface}: references builds ${[...new Set(named)].join(', ')}, expected only ${version}`);
  const unversioned = html.match(/(?:src|href)="\.\.\/(?:packages|brand|web|admin|shop)\//);
  check(!unversioned, `${surface}: no unversioned asset reference`, `${surface}: unversioned ${unversioned?.[0]}`);

  const entry = /<script type="module" src="\.\.\/_v\/[0-9a-f]+\/([^"]+)"/.exec(html)?.[1];
  if (!entry) { bad(`${surface}: no module entry script`); continue; }
  const { files, missing } = reachable(join(assets, entry));
  check(!missing.length, `${surface}: all ${files.length} reachable modules are in the build`,
    `${surface}: missing from the build: ${missing.join(', ')}`);
  const preloaded = new Set([...html.matchAll(/<link rel="modulepreload" href="\.\.\/_v\/[0-9a-f]+\/([^"]+)">/g)].map((m) => m[1]));
  const notPreloaded = files.filter((f) => !preloaded.has(f));
  check(!notPreloaded.length, `${surface}: every reachable module, static or dynamic, is preloaded with the page`,
    `${surface}: not preloaded, so it would be fetched late and can outlive its deployment: ${notPreloaded.join(', ')}`);
  for (const f of LATE[surface]) check(preloaded.has(f), `${surface}: ${f} is preloaded`);
}

/* The served headers, evaluated the way Vercel matches `source`. */
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const cacheFor = (path) => {
  let value = null;
  for (const rule of vercel.headers) {
    if (!new RegExp(`^${rule.source}$`).test(path)) continue;
    const h = rule.headers.find((x) => x.key.toLowerCase() === 'cache-control');
    if (h) value = h.value;
  }
  return value;
};
check(/immutable/.test(cacheFor(`/_v/${version}/packages/ui/map.js`) || ''),
  '/_v/** is cached as immutable', `/_v/** Cache-Control: ${cacheFor(`/_v/${version}/packages/ui/map.js`)}`);
for (const p of ['/web/', '/web/index.html', '/admin/', '/shop/', '/version.json', '/web/config.js']) {
  check(cacheFor(p) === 'no-cache', `${p} is revalidated on every load (no-cache)`, `${p} Cache-Control: ${cacheFor(p)}`);
}

console.log(fails ? `\n${fails} asset-version check(s) failed` : '\nEvery page runs only its own deployment\'s modules');
process.exit(fails ? 1 : 0);
