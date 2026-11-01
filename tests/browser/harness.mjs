/* ==========================================================================
   Browser-test stack: the real production bundle, the real API, a disposable
   PostgreSQL, and synthetic data only. Nothing here talks to any real service.

   The static server applies the headers from vercel.json, including the enforced
   CSP on Campus Control and Counter, so a policy violation really blocks in these
   tests the way it would in production. Email goes to a local stub.
   ========================================================================== */
import { createServer, request } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dist = join(root, 'dist');
export const WEB_PORT = 4173;
const STUB_PORT = 4175;
const API_PORT = 4174;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json' };

const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const headerRules = vercel.headers.map((h) => ({ re: new RegExp(`^${h.source.replace(/\(\.\*\)/g, '.*')}$`), headers: h.headers }));

export const mailbox = [];

function startStub() {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(mailbox)); }
        mailbox.push(JSON.parse(raw || '{}'));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: `m${mailbox.length}` }));
      });
    }).listen(STUB_PORT, '127.0.0.1', () => resolve(s));
  });
}

function startStatic() {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) {
        const up = request({ host: '127.0.0.1', port: API_PORT, path: url.pathname.slice(4) + url.search, method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
        up.on('error', () => { res.statusCode = 502; res.end(); });
        return req.pipe(up);
      }
      for (const rule of headerRules) if (rule.re.test(url.pathname)) for (const h of rule.headers) res.setHeader(h.key, h.value);
      let p = join(dist, decodeURIComponent(url.pathname));
      try {
        if ((await stat(p)).isDirectory()) p = join(p, 'index.html');
        res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream');
        res.end(await readFile(p));
      } catch { res.statusCode = 404; res.end('not found'); }
    }).listen(WEB_PORT, '127.0.0.1', () => resolve(s));
  });
}

export async function startStack() {
  const { startDb } = await import('../../server/test/helpers/db.mjs');
  await startDb();
  Object.assign(process.env, {
    NODE_ENV: 'test', SWEEPER: 'off', PORT: String(API_PORT), WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}`,
    COOKIE_SECRET: 'browser-test-secret-at-least-32-characters', ADMIN_TOTP_KEY: 'browser-test-totp-key-0123456789abcdef',
    ADMIN_PASSKEY_REQUIRED: 'true', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'ECHO ECHO <verify@echo.test>',
    RESEND_BASE_URL: `http://127.0.0.1:${STUB_PORT}`, ADMIN_PUBLIC_URL: `http://127.0.0.1:${WEB_PORT}/admin/`,
    TRUST_PROXY: 'false', LIVE_STREAMS_ENABLED: 'false', RATE_LIMIT_DISABLED: 'true',
  });
  const stub = await startStub();
  const { build } = await import('../../server/src/index.js');
  const app = await build();
  await app.listen({ port: API_PORT, host: '127.0.0.1' });
  const web = await startStatic();
  return { app, web, stub };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startStack();
  console.log(`browser-test stack ready on http://127.0.0.1:${WEB_PORT}`);
}
