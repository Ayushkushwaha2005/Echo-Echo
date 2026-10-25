/* ==========================================================================
   MEDIA PATHS — every café and dish photo the built site asks for ships

   The photo URLs are not strings in the source: packages/media/photos.js
   resolves each one against its own module URL at runtime, so a static
   scan of dist/ cannot see them. This imports the photo frames FROM the
   built dist/ (the copy Vercel serves under /_v/<build>/) and renders them
   the way the site does, then checks every URL they emit:

     - it resolves inside dist/_v/<build>/packages/media/ and the file exists,
       with the exact name and case (Vercel's file system is case-sensitive)
     - as a site path it is /_v/<build>/packages/media/..., which vercel.json
       serves as a static file (its only rewrite is /api/)
     - the shipped photo modules name no drive, localhost or temp path

   Run after `node build.mjs` (CI runs it on the as-deployed build).
   ========================================================================== */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LIVE_MENU } from '../server/test/fixtures/live-menu.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
let fails = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); fails++; };

if (!existsSync(join(dist, 'version.json'))) {
  console.log('  FAIL  dist/ has no build — run `node build.mjs` first');
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8'));
const build = join(dist, '_v', version);
const media = join(build, 'packages', 'media');

const tiles = await import(pathToFileURL(join(build, 'packages', 'ui', 'photo-tiles.js')).href);

/* The site renders these: a card and a header per café, a tile per dish. */
const cafes = [
  { slug: 'tulips', heroBg: '', markBg: '', mark: 'T' },
  { slug: 'chai-garam', heroBg: '', markBg: '', mark: 'CG' },
];
const html = [
  ...cafes.map((c) => tiles.CafPhoto(c)),
  ...cafes.map((c) => tiles.CafPhoto(c, { slot: 2, sizes: [100, 100, 45], eager: true, cls: 'cafphoto cafhero-photo' })),
  ...LIVE_MENU.map(([name]) => tiles.DishTile({ name }, (id) => `/api/assets/${id}`)),
].join('\n');

const urls = new Set();
for (const [, src] of html.matchAll(/\ssrc="([^"]+)"/g)) urls.add(src);
for (const [, set] of html.matchAll(/\ssrcset="([^"]+)"/g)) for (const part of set.split(', ')) urls.add(part.split(' ')[0]);

const pictures = (html.match(/<picture>/g) || []).length;
const thumbs = (html.match(/class="thumb-photo"/g) || []).length;
pictures === 4 ? ok('both café cards and both café headers carry a photograph')
  : bad(`expected 4 café photos (2 cards, 2 headers), rendered ${pictures}`);
thumbs === LIVE_MENU.length ? ok(`all ${LIVE_MENU.length} live dishes render a photo`)
  : bad(`${LIVE_MENU.length - thumbs} live dish(es) render no photo`);

let missing = 0, outside = 0;
for (const u of urls) {
  if (!u.startsWith('file:')) { bad(`not a module-relative URL: ${u}`); continue; }
  const f = fileURLToPath(u);
  const rel = relative(media, f);
  if (rel.startsWith('..')) { outside++; bad(`outside the build's media folder: ${f}`); continue; }
  /* existsSync is case-insensitive on Windows and macOS; the listing is not. */
  if (!existsSync(f) || !readdirSync(dirname(f)).includes(basename(f))) { missing++; bad(`not in dist (exact name): ${rel}`); }
}
if (!missing && !outside) {
  const sitePath = '/' + relative(dist, fileURLToPath([...urls][0])).split('\\').join('/');
  ok(`${urls.size} photo files exist in the build, served as e.g. ${sitePath}`);
}

const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const capture = (vercel.rewrites || []).filter((r) => !r.source.startsWith('/api/'));
capture.length ? bad(`vercel.json rewrites other than /api/: ${capture.map((r) => r.source).join(', ')}`)
  : ok('vercel.json rewrites only /api/, so /_v/ photos are served as files');

/* A drive letter is one letter before ":\" or ":/", so "https://" is not one. */
const LEAK = /(?<![A-Za-z])[A-Za-z]:[\\/]|localhost|127\.0\.0\.1|\/tmp\/|AppData/;
for (const f of [join(media, 'photos.js'), join(build, 'packages', 'ui', 'photo-tiles.js')]) {
  const hit = readFileSync(f, 'utf8').match(LEAK);
  hit ? bad(`${relative(dist, f)} names a local path: ${hit[0]}`) : ok(`${relative(dist, f)} names no local path`);
}

console.log(fails ? `\n${fails} media path check(s) failed` : '\nEvery photo the site renders ships with it');
process.exit(fails ? 1 : 0);
