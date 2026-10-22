/* ==========================================================================
   ECHO ECHO — the scheduled liveness + readiness probe (keep-warm.yml).

     node tools/keep-warm.mjs https://www.echoecho.tech/api

   Two questions, answered separately, because they fail for different
   reasons and need different people:

     liveness   GET /health/  is the API process running?  (no database)
     readiness  GET /ready/   does the database answer, is every shipped
                              migration applied, is the data production-safe?

   Failure classes, decided from what the server actually said:

     transient  network error, timeout, 429, 502/503/504 without a readiness
                verdict, database unreachable: a cold start or a blip.
                Retried with bounded backoff (attempts and delays below).
     permanent  a redirect (the job is pointed at a non-canonical host and is
                not reaching the API at all), a 4xx, a pending migration,
                development seed rows in production. Retrying cannot fix any
                of them, so they are reported at once with the next action.

   Nothing is ever turned into a pass: a pending migration fails this probe
   until someone applies it. Output names checks and migration files only;
   /ready carries no personal data and no secret, and neither does this.
   ========================================================================== */

export const RETRY = { attempts: 4, delaysMs: [5000, 15000, 30000], timeoutMs: 60000 };

const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

/* One GET with a hard per-attempt timeout. Redirects are NOT followed: the
   apex domain answers 308, and a probe that counts a 308 as "up" never
   reaches the API (that is exactly how the old job reported health it had
   not measured). */
async function get(url, { fetchImpl, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, { redirect: 'manual', signal: ctrl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* an edge error page is not JSON */ }
    return { status: res.status, location: res.headers.get('location'), json, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : (e.cause?.code || e.message), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/* Liveness verdict for one response. */
export function judgeHealth(r) {
  if (r.status === 0) return { ok: false, transient: true, reason: `no response (${r.error})` };
  if (r.status >= 300 && r.status < 400) {
    return { ok: false, transient: false,
      reason: `${r.status} redirect to ${r.location || '(no location)'}: the probe is not reaching the API; point it at the canonical host` };
  }
  if (r.status === 200 && r.json?.ok === true) return { ok: true, reason: `200 in ${r.ms} ms, commit ${String(r.json.commit || 'unknown').slice(0, 12)}` };
  if (TRANSIENT_STATUS.has(r.status) || r.status >= 500) return { ok: false, transient: true, reason: `HTTP ${r.status}` };
  return { ok: false, transient: false, reason: `HTTP ${r.status}${r.json ? '' : ' (not JSON)'}` };
}

/* Readiness verdict. A 503 WITH a readiness body is the server's own
   diagnosis; only a database it cannot reach is worth waiting for. */
export function judgeReady(r) {
  if (r.status === 0) return { ok: false, transient: true, reason: `no response (${r.error})` };
  if (r.status >= 300 && r.status < 400) {
    return { ok: false, transient: false, reason: `${r.status} redirect to ${r.location || '(no location)'}: point the probe at the canonical host` };
  }
  const c = r.json?.checks;
  if (r.status === 200 && r.json?.ready === true) {
    return { ok: true, reason: `200 in ${r.ms} ms, ${c?.migrations?.applied ?? '?'} migrations applied, none pending` };
  }
  if (!c) {
    return TRANSIENT_STATUS.has(r.status) || r.status >= 500
      ? { ok: false, transient: true, reason: `HTTP ${r.status} without a readiness report (cold start or edge error)` }
      : { ok: false, transient: false, reason: `HTTP ${r.status} without a readiness report` };
  }
  const problems = [];
  let transient = false;
  if (c.database && !c.database.ok) { problems.push(`database unreachable${c.database.error ? `: ${c.database.error}` : ''}`); transient = true; }
  const pending = c.migrations?.pending || [];
  if (pending.length) {
    problems.push(`migrations pending: ${pending.join(', ')}. Apply them to production with the owner's approval `
      + '(docs/RUNBOOK.md, "Migrations"); the probe stays red until they are applied');
    transient = false;
  }
  if (c.data && c.data.ok === false) { problems.push(`${c.data.developmentSeedRows} development seed rows in production`); transient = false; }
  if (!problems.length) problems.push(`HTTP ${r.status}, ready=${r.json?.ready}`);
  /* A database blip is only transient when it is the ONLY problem. */
  return { ok: false, transient: transient && problems.length === 1, reason: problems.join('; ') };
}

/* Run one probe with bounded retries on transient verdicts only. */
export async function probe(url, judge, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retry = RETRY, log = () => {} } = {}) {
  const attempts = [];
  for (let i = 0; i < retry.attempts; i++) {
    const r = await get(url, { fetchImpl, timeoutMs: retry.timeoutMs });
    const v = judge(r);
    attempts.push({ status: r.status, ms: r.ms, reason: v.reason });
    log(`  attempt ${i + 1}: ${v.ok ? 'ok' : v.transient ? 'transient' : 'permanent'} (${v.reason})`);
    if (v.ok || !v.transient || i === retry.attempts - 1) return { ...v, attempts };
    await sleep(retry.delaysMs[Math.min(i, retry.delaysMs.length - 1)]);
  }
  /* unreachable: the loop always returns on its last attempt */
  return { ok: false, transient: true, reason: 'no attempts', attempts };
}

export async function run(base, opts = {}) {
  const b = base.replace(/\/$/, '');
  const log = opts.log || console.log;
  log(`liveness  ${b}/health/`);
  const health = await probe(`${b}/health/`, judgeHealth, { ...opts, log });
  log(`readiness ${b}/ready/`);
  const ready = await probe(`${b}/ready/`, judgeReady, { ...opts, log });
  return { ok: health.ok && ready.ok, health, ready };
}

/* Markdown for $GITHUB_STEP_SUMMARY. */
export function summary(base, result) {
  const row = (name, v) => `| ${name} | ${v.ok ? 'pass' : v.transient ? 'fail (transient, retries exhausted)' : 'fail (permanent)'} | ${v.attempts.length} | ${v.reason.replace(/\|/g, '/')} |`;
  return [`### keep-warm: ${result.ok ? 'healthy' : 'NOT healthy'}`, '', `Target: \`${base}\``, '',
    '| Probe | Result | Attempts | Detail |', '|---|---|---|---|',
    row('liveness /health/', result.health), row('readiness /ready/', result.ready), ''].join('\n');
}

const { pathToFileURL } = await import('node:url');
/* exitCode, not exit(): exiting with fetch sockets still open trips a libuv
   assertion on Windows. */
async function main() {
  const base = process.argv[2];
  if (!base) { console.error('usage: node tools/keep-warm.mjs <api base url>'); return 2; }
  const result = await run(base);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(base, result));
  }
  for (const [name, v] of [['Liveness', result.health], ['Readiness', result.ready]]) {
    if (!v.ok) console.log(`::error title=${name} failed::${v.reason}`);
  }
  console.log(result.ok ? 'healthy' : 'NOT healthy');
  return result.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
