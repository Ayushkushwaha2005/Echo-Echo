/* ==========================================================================
   ECHO ECHO — LOAD-TIME MEASUREMENT

     node tools/perf-check.mjs [url] [--runs 3] [--chrome <path>]

   Opens the page in a real headless Chrome over the DevTools protocol, with
   an empty profile (a first visit), then reloads it (a returning visit), and
   reports what a person actually waits for:

     · first contentful paint (the shell is on screen)
     · the moment the app's own shell has rendered into #app
     · every request, when it started and ended, grouped by origin, so API
       latency (Render, possibly waking from sleep) is reported SEPARATELY
       from the static site (Vercel)

   No dependency: Node's built-in WebSocket speaks the protocol.
   ========================================================================== */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i > -1 ? args[i + 1] : d; };
const URL_ = args.find((a) => /^https?:/.test(a)) || 'https://echo-echo-nu.vercel.app/';
const RUNS = Number(opt('runs', 3));
const CHROME = opt('chrome', [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p)));
if (!CHROME) { console.error('✗ No Chrome found; pass --chrome <path>'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'echo-perf-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map(); const listeners = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) listeners.forEach((l) => l(m));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const close = async () => { ws.close(); proc.kill(); await sleep(300); try { rmSync(profile, { recursive: true, force: true }); } catch {} };
  return { send, on: (f) => listeners.push(f), close };
}

async function measure(page, reload) {
  const reqs = new Map();
  let t0 = null;
  page.on((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      if (t0 === null) t0 = m.params.timestamp;
      reqs.set(m.params.requestId, { url: m.params.request.url, start: m.params.timestamp, type: m.params.type });
    } else if (m.method === 'Network.responseReceived') {
      const r = reqs.get(m.params.requestId);
      if (r) { r.status = m.params.response.status; r.cached = m.params.response.fromDiskCache || m.params.response.fromMemoryCache; }
    } else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
      const r = reqs.get(m.params.requestId);
      if (r) { r.end = m.params.timestamp; r.bytes = m.params.encodedDataLength || 0; }
    }
  });
  if (reload) await page.send('Page.reload', {}); else await page.send('Page.navigate', { url: URL_ });

  /* Wait for the app to paint, then for the network to go quiet. */
  const deadline = Date.now() + 60_000;
  let shellAt = null, quietSince = Date.now(), lastCount = 0;
  while (Date.now() < deadline) {
    await sleep(100);
    const { result } = await page.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const app = document.getElementById('app');
      const p = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
      return { shell: !!(app && app.children.length), fcp: p ? p.startTime : null,
               text: app ? app.innerText.slice(0, 80).replace(/\\s+/g, ' ') : '',
               nav: performance.getEntriesByType('navigation')[0]?.toJSON?.() || null,
               url: location.href };
    })()` }).catch(() => ({ result: {} }));
    const v = result.value || {};
    if (v.shell && shellAt === null) shellAt = { ...v, wall: Date.now() };
    const open = [...reqs.values()].filter((r) => r.end === undefined).length;
    if (reqs.size !== lastCount || open) { lastCount = reqs.size; quietSince = Date.now(); }
    if (shellAt && !open && Date.now() - quietSince > 1500) break;
  }
  const { result } = await page.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const p = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
    const shell = window.__echoShellAt ?? null;
    return { fcp: p ? Math.round(p.startTime) : null, dcl: Math.round(n.domContentLoadedEventEnd),
             load: Math.round(n.loadEventEnd), ttfb: Math.round(n.responseStart),
             text: document.getElementById('app')?.innerText.slice(0, 60).replace(/\\s+/g, ' ') };
  })()` });
  const list = [...reqs.values()].filter((r) => r.end).map((r) => ({
    ...r, s: Math.round((r.start - t0) * 1000), e: Math.round((r.end - t0) * 1000),
  }));
  return { ...result.value, reqs: list };
}

function report(label, m) {
  const origin = new URL(URL_).origin;
  const api = m.reqs.filter((r) => r.url.startsWith(`${origin}/api/`));
  const statics = m.reqs.filter((r) => r.url.startsWith(origin) && !r.url.startsWith(`${origin}/api/`));
  const third = m.reqs.filter((r) => !r.url.startsWith(origin) && !r.url.startsWith('data:'));
  const kb = (xs) => (xs.reduce((a, r) => a + (r.bytes || 0), 0) / 1024).toFixed(1);
  const lastEnd = (xs) => xs.length ? Math.max(...xs.map((r) => r.e)) : 0;
  console.log(`\n${label}`);
  console.log(`  TTFB ${m.ttfb} ms · FCP ${m.fcp} ms · DOMContentLoaded ${m.dcl} ms · load ${m.load} ms`);
  console.log(`  static (Vercel): ${statics.length} req, ${kb(statics)} KB on the wire, done by ${lastEnd(statics)} ms`
    + ` (${statics.filter((r) => r.cached).length} from cache, ${statics.filter((r) => r.status === 304).length} revalidated 304)`);
  console.log(`  third-party:     ${third.length} req, ${kb(third)} KB, done by ${lastEnd(third)} ms`);
  console.log(`  API (Render):    ${api.length} req, slowest ${api.length ? Math.max(...api.map((r) => r.e - r.s)) : 0} ms, done by ${lastEnd(api)} ms`);
  for (const r of m.reqs.sort((a, b) => a.s - b.s)) {
    console.log(`    ${String(r.s).padStart(6)} → ${String(r.e).padStart(6)} ms  ${String(r.status ?? '').padEnd(3)} ${r.cached ? 'cache' : '     '} ${r.url.replace(origin, '').slice(0, 90)}`);
  }
  console.log(`  on screen: "${m.text}"`);
}

const summary = [];
for (let i = 1; i <= RUNS; i++) {
  const page = await launch();
  await page.send('Network.enable'); await page.send('Page.enable'); await page.send('Runtime.enable');
  const first = await measure(page, false);
  const again = await measure(page, true);
  await page.close();
  if (i === 1) { report(`first visit (empty cache) — run ${i}`, first); report(`returning visit — run ${i}`, again); }
  summary.push({ run: i, firstFcp: first.fcp, firstDcl: first.dcl, repeatFcp: again.fcp, repeatDcl: again.dcl,
                 firstStaticDone: Math.max(0, ...first.reqs.filter((r) => !r.url.includes('/api/')).map((r) => r.e)),
                 apiDone: Math.max(0, ...first.reqs.filter((r) => r.url.includes('/api/')).map((r) => r.e)) });
}
console.log('\nsummary (ms)'); console.table(summary);
