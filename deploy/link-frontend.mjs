/* ==========================================================================
   ECHO ECHO — point the Vercel surfaces at the API, in one step.

     node deploy/link-frontend.mjs 20-197-1-2.sslip.io
     node deploy/link-frontend.mjs https://api.echoecho.tech
     node deploy/link-frontend.mjs --check          (report, change nothing)

   WHY THIS EXISTS AS A SCRIPT

   Connecting the two halves is three edits that only work together, and any
   one of them alone leaves sign-in broken in a way that looks like the
   server being down:

     1. vercel.json gains  /api/:path*  ->  https://<api host>/:path*
     2. the Vercel environment variable QUAD_API_BASE becomes  /api
     3. the API's WEB_ORIGIN (deploy/server.env, on the VM) names the exact
        Vercel origin, or the CSRF check refuses every write

   This script does (1) and prints exactly what to do for (2) and (3). It
   does not touch any secret and it does not deploy.

   WHY A REWRITE RATHER THAN CALLING THE API HOST DIRECTLY

   The session cookie is SameSite=Lax. A browser decides "same site" by
   registrable domain, and vercel.app is on the Public Suffix List, so
   echo-echo-nu.vercel.app and any API host are different sites: the cookie
   is simply never sent. CORS does not change that - it governs whether a
   request is permitted, not whether the cookie rides along. Routing the API
   through a path on the SAME origin is the only arrangement where the
   cookie survives without weakening it to SameSite=None.
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(root, 'vercel.json');
const PREFIX = '/api';

const die = (msg) => { console.error(`\n  x ${msg}\n`); process.exit(1); };

/* ---------- what the API host is --------------------------------------- */
function normaliseHost(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) die('Give the API host, e.g. 20-197-1-2.sslip.io or https://api.echoecho.tech');
  if (/^http:\/\//i.test(raw)) {
    die('The API must be https. Caddy terminates TLS on the VM; plain http would '
      + 'strip the Secure session cookie and the server refuses to start without it.');
  }
  const withScheme = /^https:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try { url = new URL(withScheme); } catch { die(`"${input}" is not a hostname or an https URL.`); }
  if (url.pathname !== '/' || url.search || url.hash) {
    die('Give the API ORIGIN only - no path, query or fragment.');
  }
  if (!/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.')) {
    die(`"${url.hostname}" does not look like a public hostname.`);
  }
  if (/^localhost$|^127\.|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    die(`"${url.hostname}" cannot carry a public TLS certificate. Use a name that resolves `
      + 'to the VM: a domain you own, or the dashed-IP form <ip>.sslip.io.');
  }
  return url.origin;
}

/* ---------- read the current state -------------------------------------- */
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const existing = (config.rewrites || []).find((r) => r.source === `${PREFIX}/:path*`);

const args = process.argv.slice(2);
if (args[0] === '--check' || args.length === 0) {
  console.log('\nECHO ECHO — frontend/API link\n');
  console.log(`  vercel.json rewrite : ${existing ? existing.destination : 'NOT SET'}`);
  if (!existing) {
    console.log('\n  The surfaces have no route to the API. Every call answers with the');
    console.log('  static host\'s 404, which the sign-in screen reports as "Cannot reach');
    console.log('  the ECHO ECHO server" - the same message as a genuine outage.\n');
    console.log('  Once the API host exists:  node deploy/link-frontend.mjs <api host>\n');
    process.exit(args[0] === '--check' ? 0 : 1);
  }
  console.log(`\n  Surfaces must be built with QUAD_API_BASE=${PREFIX}.\n`);
  process.exit(0);
}

const origin = normaliseHost(args[0]);

/* ---------- write the rewrite ------------------------------------------- */
/* Vercel evaluates rewrites in order and stops at the first match, so the API
   prefix has to come before anything broader. It is the only entry today;
   unshift keeps that true if more are added later. */
const rewrite = { source: `${PREFIX}/:path*`, destination: `${origin}/:path*` };
config.rewrites = [rewrite, ...(config.rewrites || []).filter((r) => r.source !== rewrite.source)];
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

console.log(`\n  ok  vercel.json: ${PREFIX}/:path*  ->  ${origin}/:path*`);
if (existing && existing.destination !== rewrite.destination) {
  console.log(`      (was ${existing.destination})`);
}

console.log(`
  Two things this script deliberately does NOT do, because both need
  credentials it should never hold:

  1. The Vercel environment variable. Without it the build still injects an
     empty API base and the browser calls /auth/... at the site root, which
     the static host answers with a redirect and then a 404.

       vercel env rm  QUAD_API_BASE production
       vercel env add QUAD_API_BASE production      # value: ${PREFIX}
       git add vercel.json && git commit && git push      # redeploys

  2. WEB_ORIGIN on the VM. The API's CSRF check refuses any cookie-bearing
     write whose Origin it does not recognise, so the Vercel origin must be
     named exactly, with no trailing slash:

       deploy/server.env:  WEB_ORIGIN=https://echo-echo-nu.vercel.app
       docker compose up -d

  Then verify from a terminal, not from the browser:

     curl -s https://echo-echo-nu.vercel.app${PREFIX}/health
     curl -s https://echo-echo-nu.vercel.app${PREFIX}/ready | head -c 400
`);
