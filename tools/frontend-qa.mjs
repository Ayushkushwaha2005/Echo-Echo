/* ==========================================================================
   ECHO ECHO — static QA of the built surfaces.

     node build.mjs && node tools/frontend-qa.mjs

   What a browser would catch and this cannot: actual rendered layout. What
   this catches without a browser, on every push, is the set of failures that
   are decidable from the bytes:

     · a relative asset or module reference that does not resolve in dist/
     · a declaration that forces the page wider than a 390px phone
     · a surface with no (or a non-responsive) viewport meta
     · an API-key-shaped string in anything shipped to a browser

   The width rule is the fiddly one, so it is written narrowly on purpose.
   `max-width: 1180px` contains the substring "width: 1180px" and constrains
   nothing; a `min-width:` inside an `@media` query is how a layout adapts
   rather than how it overflows; and a wide `min-width` on a table inside a
   horizontally scrollable wrapper is the correct pattern for a data table.
   A loose regex reports all three and is then ignored, which is worse than
   no check at all.
   ========================================================================== */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

const dist = process.argv[2] || 'dist';
const PHONE_PX = 390;

if (!existsSync(dist)) {
  console.error(`x ${dist}/ does not exist. Run: node build.mjs`);
  process.exit(1);
}

const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = walk(dist).filter((f) => !f.includes('prototype'));
const rel = (f) => relative(dist, f).split('\\').join('/');
const findings = [];
const report = (label, list, okLine) => {
  if (list.length) {
    findings.push(...list.map((l) => `${label}: ${l}`));
    console.log(`\n  x ${label} (${list.length})`);
    for (const l of list) console.log(`      ${l}`);
  } else {
    console.log(`  + ${okLine}`);
  }
};

/* ---------- 1. broken references ---------------------------------------- */
const missing = [];
for (const f of files.filter((x) => /\.(html|js|mjs|css)$/.test(x))) {
  const src = readFileSync(f, 'utf8');
  const refs = [
    ...src.matchAll(/(?:src|href)\s*=\s*["']([^"'#?]+)["']/g),
    ...src.matchAll(/from\s+["'](\.[^"']+)["']/g),
    ...src.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g),
  ].map((m) => m[1]);
  for (const r of refs) {
    /* A template literal is a URL computed at runtime from server data; it
       has no file on disk to resolve and is not this check's business. */
    if (r.includes('${')) continue;
    if (/^(https?:|data:|blob:|mailto:|tel:|\/\/|#)/.test(r)) continue;
    const target = r.startsWith('/') ? join(dist, r) : resolve(dirname(f), r);
    if (!existsSync(target)) missing.push(`${rel(f)}  ->  ${r}`);
  }
}
report('broken reference', missing, 'every relative reference in the bundles resolves');

/* ---------- 2. layout that cannot fit a phone ---------------------------- */
const overflow = [];
for (const f of files.filter((x) => /\.(css|js|html)$/.test(x))) {
  const src = readFileSync(f, 'utf8');
  /* (^|[^-]) excludes max-width and min-width alike from the `width` arm;
     min-width gets its own arm so a media query can be told apart. */
  for (const m of src.matchAll(/(^|[^-a-z])(min-width|width)\s*:\s*(\d{3,5})px/g)) {
    const prop = m[2];
    const px = Number(m[3]);
    if (px <= PHONE_PX) continue;
    const before = src.slice(Math.max(0, m.index - 300), m.index);
    /* A breakpoint, not a box. */
    if (/@media[^{}]*$/.test(before)) continue;
    /* A wide child of a horizontally scrolling wrapper scrolls inside that
       wrapper; the page itself does not grow. */
    if (/overflow-x\s*:\s*auto[\s\S]{0,400}$/.test(before)) continue;
    overflow.push(`${rel(f)}: ${prop}: ${px}px`);
  }
}
report(`forces the page wider than ${PHONE_PX}px`, overflow,
  `no declaration forces the page wider than a ${PHONE_PX}px phone`);

/* ---------- 3. viewport meta --------------------------------------------- */
const viewport = [];
for (const s of ['web', 'admin', 'shop']) {
  const p = join(dist, s, 'index.html');
  if (!existsSync(p)) { viewport.push(`${s}: no index.html`); continue; }
  const v = readFileSync(p, 'utf8').match(/<meta[^>]+name=["']viewport["'][^>]*>/);
  if (!v) viewport.push(`${s}: no viewport meta - the phone will render it at desktop width`);
  else if (!/width\s*=\s*device-width/.test(v[0])) viewport.push(`${s}: ${v[0]}`);
}
report('viewport', viewport, 'every surface declares a device-width viewport');

/* ---------- 4. secrets in the bundle -------------------------------------- */
const leaky = [];
for (const f of files.filter((x) => /\.(js|mjs|html|css|json|svg)$/.test(x))) {
  const src = readFileSync(f, 'utf8');
  for (const re of [/re_[A-Za-z0-9_]{20,}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/,
                    /AIza[0-9A-Za-z_-]{30,}/, /rzp_(live|test)_[A-Za-z0-9]{10,}/,
                    /-----BEGIN [A-Z ]*PRIVATE KEY-----/]) {
    const m = src.match(re);
    if (m) leaky.push(`${rel(f)}: ${m[0].slice(0, 10)}...`);
  }
}
report('secret in a shipped file', leaky, 'no API-key-shaped string in anything served to a browser');

console.log('');
if (findings.length) {
  console.error(`x frontend QA FAILED - ${findings.length} finding(s).\n`);
  process.exit(1);
}
console.log(`+ frontend QA passed (${files.length} files in ${dist}/).\n`);
