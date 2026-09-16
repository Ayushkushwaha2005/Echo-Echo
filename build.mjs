/* ==========================================================================
   QUAD — PRODUCTION BUILD

   Copies the three surfaces into dist/ with their assets, injects the API
   base, and then AUDITS the output. The audit is the point: it fails the
   build if anything on the forbidden list reaches a bundle.

     node build.mjs                         # dev build, localhost API
     QUAD_API_BASE=https://api.quad.app node build.mjs --production
   ========================================================================== */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const PRODUCTION = process.argv.includes('--production');
/* `same-origin` is an explicit choice, not an empty default: the surfaces are
   served from the same origin as the API, so nothing is injected and
   client.js falls back to location.origin. That is the arrangement a static
   host with a rewrite to the API uses, and it is the only one where a
   SameSite=Lax session cookie reaches the API at all. */
const SAME_ORIGIN = process.env.QUAD_API_BASE === 'same-origin';
const API_BASE = SAME_ORIGIN ? ''
  : process.env.QUAD_API_BASE || (PRODUCTION ? null : 'http://localhost:8080');

if (PRODUCTION && API_BASE === null) {
  console.error('✗ QUAD_API_BASE must be set for a production build '
    + '(an https URL, or "same-origin" when the API is served from this origin).');
  process.exit(1);
}
if (PRODUCTION && !SAME_ORIGIN && !/^https:\/\//.test(API_BASE)) {
  console.error(`✗ QUAD_API_BASE must be https in production (got ${API_BASE}).`);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/* The surfaces are plain ES modules, so a build is a copy plus the runtime
   config. No bundler: fewer moving parts, and what ships is what you read. */
/* The prototype data layer is reference material, not product. It is never
   copied, so a stray import fails loudly at build time instead of quietly
   shipping an in-memory fallback. */
const PROTOTYPE_MODULES = ['api.js', 'catalog.js', 'campus.js', 'auth.js', 'config.js']
  .map((f) => join('packages', 'data', f));

for (const dir of ['packages', 'brand', 'web', 'admin', 'shop']) {
  cpSync(join(root, dir), join(dist, dir), {
    recursive: true,
    filter: (src) => !PROTOTYPE_MODULES.some((m) => src.endsWith(m)),
  });
}

/* Inject the API base and drop the dev default. */
for (const surface of ['web', 'admin', 'shop']) {
  const p = join(dist, surface, 'index.html');
  let html = readFileSync(p, 'utf8');
  html = html.replace(
    /window\.QUAD_API_BASE = window\.QUAD_API_BASE \|\| '[^']*';/,
    `window.QUAD_API_BASE = ${JSON.stringify(API_BASE)};`);
  writeFileSync(p, html);
}

/* The brand favicon at the site root, from the one logo source. */
const { favicon } = await import('./brand/logo.js');
writeFileSync(join(dist, 'favicon.svg'), favicon());

/* Static-server config (read by `serve`, used by `npm run web`). Each surface
   loads its modules by relative path, so /web without the slash would resolve
   ./src/app.js against / and render a blank page: redirect to the folder.
   Production hosting (see docs/DEPLOY.md) needs the same three redirects. */
writeFileSync(join(dist, 'serve.json'), JSON.stringify({
  /* cleanUrls stays at its default: it is also what makes a folder serve its
     index.html. Folder listings are never shown. */
  directoryListing: false,
  /* serve strips a trailing slash before matching redirects, so a
     /web -> /web/ rule would loop; trailingSlash adds it to folders instead. */
  trailingSlash: true,
  redirects: [
    { source: '/', destination: '/web/', type: 302 },
    /* Browsers ask for /favicon.ico on their own; answer with the brand mark. */
    { source: '/favicon.ico', destination: '/favicon.svg', type: 301 },
  ],
  headers: [{
    source: '**/*',
    headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Cache-Control', value: 'no-cache' },
    ],
  }],
}, null, 2));

/* ---------- the audit ----------------------------------------------------
   Each rule is one of the production-readiness promises, checked against
   the bytes that would actually be served. */
const FORBIDDEN = [
  [/\bfrisco-dev\b/i, 'development password'],
  [/DEV_DEMO_PASSWORD/, 'demo password reference'],
  [/seedDemoCredentials/, 'demo credential seeding'],
  [/SHOW_DEMO_ACCOUNTS/, 'demo account listing'],
  [/AUTH_ENABLED/, 'client-side auth switch'],
  [/\b123456\b/, 'hardcoded OTP'],
  [/Simulate being on campus/i, 'fake GPS control'],
  [/\bsk_live_|\bsk_test_|rzp_live_[A-Za-z0-9]|AKIA[0-9A-Z]{16}/, 'API key or secret'],
  [/ANTHROPIC_API_KEY|RAZORPAY_KEY_SECRET|TWILIO_AUTH_TOKEN|COOKIE_SECRET/, 'server secret name'],
  [/from '\.\.\/\.\.\/packages\/data\/(api|catalog|campus|auth|config)\.js'/,
   'import of the in-memory prototype data layer'],
  [/★\s*4\.\d|rating:\s*4\.\d/, 'hardcoded rating'],
  [/localhost/, 'localhost reference', { productionOnly: true }],
];

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const files = walk(dist).filter((f) => /\.(js|html|css|mjs)$/.test(f));
const findings = [];

for (const file of files) {
  const rel = relative(dist, file).replace(/\\/g, '/');
  /* The prototype folder is reference material and is not served. */
  if (rel.startsWith('prototype/')) continue;
  const src = readFileSync(file, 'utf8');
  for (const [re, label, opts] of FORBIDDEN) {
    if (opts?.productionOnly && !PRODUCTION) continue;
    const m = src.match(re);
    if (m) findings.push({ rel, label, snippet: m[0].slice(0, 60) });
  }
}

/* Prove nothing that IS shipped references the modules we refused to copy. */
for (const file of walk(dist).filter((f) => /\.(js|mjs|html)$/.test(f))) {
  const rel = relative(dist, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  for (const gone of ['data/api.js', 'data/catalog.js', 'data/campus.js',
                      'data/auth.js', 'data/config.js']) {
    if (src.includes(gone)) {
      findings.push({ rel, label: `references removed prototype module ${gone}`, snippet: gone });
    }
  }
}

console.log(`\nQuad build — ${PRODUCTION ? 'PRODUCTION' : 'development'}`);
console.log(`API base: ${API_BASE}`);
console.log(`${files.length} files in dist/`);

if (findings.length) {
  console.error(`\n✗ Build audit FAILED — ${findings.length} finding(s):\n`);
  for (const f of findings) console.error(`   ${f.rel}\n      ${f.label}: ${f.snippet}`);
  console.error('\nNothing on that list may reach a production bundle.\n');
  process.exit(1);
}

console.log('\n✓ Build audit passed:');
console.log('   no demo credentials, no dev password, no hardcoded OTP');
console.log('   no fake GPS control, no hardcoded rating');
console.log('   no secrets or secret names');
console.log('   no prototype data-layer imports; those modules are not shipped');
if (PRODUCTION) console.log('   no localhost references; API base is https');
console.log('');
