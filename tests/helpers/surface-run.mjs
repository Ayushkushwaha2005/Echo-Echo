/* ==========================================================================
   Executes ONE built surface out of dist/, in its own process.

   The point of this file is to run the real shipped code. Quad has no
   bundler on purpose — `build.mjs` copies the ES modules and injects the API
   base, so what ships is what you read — which means the only honest way to
   smoke-test a build is to import its entry module and let the whole graph
   evaluate. That is what happens below, against dist/, never against the
   source tree.

   What that catches, and a syntax check cannot:
     · a module the build did not copy (ERR_MODULE_NOT_FOUND) — including the
       prototype data layer that build.mjs deliberately refuses to ship
     · an import of a name a module does not export
     · anything that throws while a surface's modules evaluate, or while the
       session gate renders its first screen

   Own process per surface because ES modules evaluate in the realm they are
   imported into: a shared process would let one surface's globals, module
   cache and failures leak into the next.

     node tests/helpers/surface-run.mjs web
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const surface = process.argv[2];
if (!['web', 'admin', 'shop'].includes(surface)) {
  console.error('usage: surface-run.mjs <web|admin|shop>');
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distSurface = join(root, 'dist', surface);
const indexPath = join(distSurface, 'index.html');

let html;
try {
  html = readFileSync(indexPath, 'utf8');
} catch {
  console.error(`no built surface at dist/${surface}/index.html — run \`node build.mjs\` first`);
  process.exit(1);
}

/* ---------- what the page promises ---------------------------------------
   These are assertions about the ARTIFACT, not the source: the build injects
   the API base and points at an entry module, and a bundle missing either
   would load into a blank page rather than fail loudly on its own. */
const apiBase = html.match(/window\.QUAD_API_BASE\s*=\s*(?:window\.QUAD_API_BASE\s*\|\|\s*)?'([^']*)'/)
             || html.match(/window\.QUAD_API_BASE\s*=\s*"([^"]*)"/);
if (!apiBase) {
  console.error(`dist/${surface}/index.html does not set window.QUAD_API_BASE`);
  process.exit(1);
}
const entry = html.match(/<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/);
if (!entry) {
  console.error(`dist/${surface}/index.html has no <script type="module"> entry point`);
  process.exit(1);
}

/* ---------- a permissive DOM ---------------------------------------------
   Every property access returns another chainable node, so a surface can
   render into it without a real DOM. It is deliberately not a DOM
   implementation: a missing method here shows up as a genuine failure to
   investigate, not something to paper over. */
function stubNode(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    innerHTML: '', outerHTML: '', textContent: '', value: '', files: null,
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [], childNodes: [], scrollTop: 0, scrollHeight: 0, checked: false, disabled: false,
    appendChild(n) { return n; }, removeChild(n) { return n; },
    append() {}, prepend() {}, replaceChildren() {}, replaceWith() {}, remove() {},
    insertAdjacentHTML() {}, cloneNode() { return stubNode(tag); },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    hasAttribute() { return false; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, submit() {}, reset() {},
    closest() { return null; }, contains() { return false; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  };
  node.parentElement = node;
  node.parentNode = node;
  node.firstElementChild = node;
  node.lastElementChild = node;
  /* el() builds a <template> and reads content.firstElementChild. */
  node.content = { firstElementChild: node, childNodes: [], cloneNode: () => stubNode(tag) };
  return node;
}

const documentStub = {
  documentElement: stubNode('html'),
  head: stubNode('head'),
  body: stubNode('body'),
  title: '',
  readyState: 'complete',
  getElementById: () => stubNode(),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => stubNode(tag),
  createElementNS: (_ns, tag) => stubNode(tag),
  createTextNode: () => stubNode('#text'),
  createDocumentFragment: () => stubNode('#fragment'),
  addEventListener() {}, removeEventListener() {},
};

/* /auth/me answering "not signed in" is the most useful stub there is: the
   gate then takes its real unauthenticated path and mounts the login view,
   so packages/ui/login.js is evaluated and rendered too. Every other call
   answers 401, which the client turns into an ApiError the surfaces already
   know how to render. */
const requested = [];
async function fetchStub(url, opts = {}) {
  const path = String(url).replace(apiBase[1], '');
  requested.push(`${opts.method || 'GET'} ${path}`);
  const body = path.startsWith('/auth/me')
    ? { authenticated: false }
    : { error: 'Sign in required', code: 'unauthenticated' };
  return {
    ok: path.startsWith('/auth/me'),
    status: path.startsWith('/auth/me') ? 200 : 401,
    headers: { get: () => 'application/json' },
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

const noop = () => {};

/* Node already defines some of these (`navigator`, `crypto`) as getter-only
   properties, so they are redefined rather than assigned. */
const define = (obj) => {
  for (const [k, v] of Object.entries(obj)) {
    Object.defineProperty(globalThis, k,
      { value: v, writable: true, configurable: true, enumerable: true });
  }
};

define({
  QUAD_API_BASE: apiBase[1],
  document: documentStub,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
  sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
  location: { origin: apiBase[1], href: apiBase[1] + '/', pathname: '/',
              search: '', hash: '', reload: noop, assign: noop, replace: noop },
  history: { length: 1, pushState: noop, replaceState: noop, back: noop },
  navigator: { geolocation: { getCurrentPosition: noop, watchPosition: noop },
               userAgent: 'quad-bundle-smoke', clipboard: { writeText: async () => {} } },
  crypto: webcrypto,
  fetch: fetchStub,
  FileReader: class { readAsDataURL() {} readAsText() {} },
  FormData: class { append() {} get() { return null; } entries() { return [][Symbol.iterator](); }
                    [Symbol.iterator]() { return [][Symbol.iterator](); } },
  Image: class { set src(_v) {} },
  alert: noop, confirm: () => false, prompt: () => null,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: clearTimeout,
});
define({ window: globalThis, self: globalThis });
globalThis.window.document = documentStub;

/* Anything the surface throws asynchronously — inside the gate, inside a
   render — must fail this test rather than vanish into the event loop. */
const asyncFailures = [];
process.on('unhandledRejection', (e) => asyncFailures.push(e));
process.on('uncaughtException', (e) => asyncFailures.push(e));

const entryUrl = pathToFileURL(join(distSurface, entry[1].replace(/^\.\//, ''))).href;
try {
  await import(entryUrl);
} catch (e) {
  console.error(`${surface}: ${e.code === 'ERR_MODULE_NOT_FOUND' ? 'missing module' : e.name}: ${e.message}`);
  process.exit(1);
}

/* Let the gate's promise chain run to completion before judging it. */
await new Promise((r) => setTimeout(r, 150));

if (asyncFailures.length) {
  console.error(`${surface}: ${asyncFailures.length} async failure(s) while rendering`);
  for (const e of asyncFailures.slice(0, 5)) console.error(`   ${e?.stack || e}`);
  process.exit(1);
}

/* A surface that never asked the server who you are has not actually
   started: it would mean the entry module evaluated but the gate did not
   run, which is exactly the kind of silent no-op this test exists to catch. */
if (!requested.some((r) => r.includes('/auth/me'))) {
  console.error(`${surface}: evaluated but never called /auth/me — the session gate did not run` +
                (requested.length ? ` (calls seen: ${requested.join(', ')})` : ''));
  process.exit(1);
}

console.log(`${surface} OK — ${requested.length} API call(s): ${requested.join(', ')}`);
process.exit(0);
