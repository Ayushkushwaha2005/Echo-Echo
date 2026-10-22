/* ==========================================================================
   THE SCHEDULED PROBE (tools/keep-warm.mjs, .github/workflows/keep-warm.yml)

   The failure measured on 21 Oct 2026 (run 39605893655, and every scheduled
   run since 15 Oct): the job asked https://echoecho.tech/api/health/, got a
   308 to www, and curl -f counted that as success, so liveness was never
   measured; /ready then answered 503 because migration 031_saved_places.sql
   had shipped in code but had not been applied to production.

   These pin the corrected semantics: a redirect is a failure, a pending
   migration is a permanent failure that names the file, and only a cold
   start or a database blip is retried, a bounded number of times.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeHealth, judgeReady, probe, run, summary } from '../../tools/keep-warm.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const resp = (status, body, headers = {}) => ({
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
/* A fetch that answers from a script, one entry per call, and records URLs. */
const scripted = (...answers) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  f.calls = calls;
  return f;
};
const noSleep = async () => {};
const READY = { ready: true, checks: { database: { ok: true }, migrations: { ok: true, applied: 31, pending: [] }, data: { ok: true } } };
const PENDING_031 = { ready: false, checks: { database: { ok: true }, migrations: { ok: false, applied: 30, pending: ['031_saved_places.sql'] }, data: { ok: true } } };
const DB_DOWN = { ready: false, checks: { database: { ok: false, error: 'connect ETIMEDOUT' } } };

test('a 308 is not liveness: the apex redirect is a permanent failure naming the target', () => {
  const v = judgeHealth({ status: 308, location: 'https://www.echoecho.tech/api/health/', ms: 90 });
  assert.equal(v.ok, false);
  assert.equal(v.transient, false);
  assert.match(v.reason, /308 redirect to https:\/\/www\.echoecho\.tech\/api\/health\//);
});

test('liveness passes only on 200 with ok:true', () => {
  assert.equal(judgeHealth({ status: 200, json: { ok: true, commit: 'abc' }, ms: 5 }).ok, true);
  assert.equal(judgeHealth({ status: 200, json: null, ms: 5 }).ok, false, 'an HTML 200 from an edge is not the API');
  assert.equal(judgeHealth({ status: 404, json: null, ms: 5 }).transient, false);
  assert.equal(judgeHealth({ status: 502, json: null, ms: 5 }).transient, true, 'a cold-start 502 is worth waiting for');
  assert.equal(judgeHealth({ status: 0, error: 'ECONNRESET', ms: 5 }).transient, true);
});

test('a pending migration is a permanent readiness failure that names the file and the next action', () => {
  const v = judgeReady({ status: 503, json: PENDING_031, ms: 300 });
  assert.equal(v.ok, false);
  assert.equal(v.transient, false, 'retrying cannot apply a migration');
  assert.match(v.reason, /031_saved_places\.sql/);
  assert.match(v.reason, /RUNBOOK/);
});

test('an unreachable database is transient; seed rows in production are not', () => {
  assert.equal(judgeReady({ status: 503, json: DB_DOWN, ms: 5 }).transient, true);
  const seeded = { ready: false, checks: { database: { ok: true }, migrations: { ok: true, pending: [] }, data: { ok: false, developmentSeedRows: 3 } } };
  const v = judgeReady({ status: 503, json: seeded, ms: 5 });
  assert.equal(v.transient, false);
  assert.match(v.reason, /3 development seed rows/);
});

test('a 503 with no readiness body (cold start, edge page) is transient; ready:true is a pass', () => {
  assert.equal(judgeReady({ status: 503, json: null, ms: 5 }).transient, true);
  assert.equal(judgeReady({ status: 200, json: READY, ms: 5 }).ok, true);
  assert.equal(judgeReady({ status: 200, json: { ready: false, checks: {} }, ms: 5 }).ok, false, 'a 200 without ready:true is not ready');
});

test('transient failures are retried with backoff, then recover', async () => {
  const f = scripted(resp(502, 'Bad Gateway'), resp(503, '<html>'), resp(200, { ok: true, commit: 'x' }));
  const slept = [];
  const v = await probe('https://h/api/health/', judgeHealth, { fetchImpl: f, sleep: async (ms) => slept.push(ms) });
  assert.equal(v.ok, true);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(slept, [5000, 15000]);
  assert.equal(f.calls[0].init.redirect, 'manual', 'redirects are never followed silently');
  assert.ok(f.calls[0].init.signal, 'every attempt has a timeout');
});

test('retries are bounded: a persistent transient failure stops after the configured attempts', async () => {
  const f = scripted(new TypeError('fetch failed'));
  const v = await probe('https://h/api/health/', judgeHealth, { fetchImpl: f, sleep: noSleep, retry: { attempts: 4, delaysMs: [1, 2, 3], timeoutMs: 1000 } });
  assert.equal(v.ok, false);
  assert.equal(f.calls.length, 4);
  assert.equal(v.attempts.length, 4);
});

test('a permanent failure is not retried', async () => {
  const f = scripted(resp(503, PENDING_031));
  const v = await probe('https://h/api/ready/', judgeReady, { fetchImpl: f, sleep: noSleep });
  assert.equal(f.calls.length, 1);
  assert.equal(v.transient, false);
});

test('a hung request is cut off by the per-attempt timeout', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
  }));
  const v = await probe('https://h/api/health/', judgeHealth, { fetchImpl: hang, sleep: noSleep, retry: { attempts: 1, delaysMs: [], timeoutMs: 20 } });
  assert.equal(v.ok, false);
  assert.match(v.reason, /timed out after 20 ms/);
});

test('run() probes liveness and readiness separately; the 21 Oct state reports both causes', async () => {
  const f = scripted(resp(200, { ok: true, commit: '883bea0501fde51972be6e79bac50018bccc3a7b' }), resp(503, PENDING_031));
  const r = await run('https://www.echoecho.tech/api/', { fetchImpl: f, sleep: noSleep, log: () => {} });
  assert.deepEqual(f.calls.map((c) => c.url), ['https://www.echoecho.tech/api/health/', 'https://www.echoecho.tech/api/ready/']);
  assert.equal(r.health.ok, true);
  assert.equal(r.ready.ok, false);
  assert.equal(r.ok, false);
  const md = summary('https://www.echoecho.tech/api', r);
  assert.match(md, /NOT healthy/);
  assert.match(md, /031_saved_places\.sql/);
});

test('keep-warm.yml probes the canonical host through the script, not a bare curl', () => {
  const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'keep-warm.yml'), 'utf8');
  assert.match(wf, /node tools\/keep-warm\.mjs https:\/\/www\.echoecho\.tech\/api/);
  assert.doesNotMatch(wf, /https:\/\/echoecho\.tech\//, 'the apex host answers 308 and would never reach the API');
  assert.match(wf, /timeout-minutes:\s*\d+/);
  assert.match(wf, /concurrency:/, 'overlapping late scheduled runs must not pile up');
});

/* ---- the deploy-time migration gate (tools/migration-gate.mjs) ---------- */
import { unapplied, shippedMigrations } from '../../tools/migration-gate.mjs';

test('the migration gate names a migration the running service lacks (the 15 Oct deploy)', () => {
  const shipped = ['029_a.sql', '030_tulips_menu.sql', '031_saved_places.sql'];
  assert.deepEqual(unapplied(shipped, { applied: 30, latest: '030_tulips_menu.sql', pending: [] }).files, ['031_saved_places.sql'],
    'a new file in the commit is caught before deploy, while the OLD code is still green');
  assert.deepEqual(unapplied(shipped, { applied: 31, latest: '031_saved_places.sql', pending: [] }).files, []);
  assert.deepEqual(unapplied(shipped, { applied: 2, pending: [] }).files, ['031_saved_places.sql'],
    'a service from before `latest` existed: counted in order');
  assert.equal(unapplied(shipped, undefined).known, false, 'an unreachable database is not "nothing pending"');
});

test('every shipped migration is numbered, so lexical order is apply order', () => {
  const files = shippedMigrations();
  assert.ok(files.length >= 31);
  for (const f of files) assert.match(f, /^\d{3}_[a-z0-9_]+\.sql$/);
});

test('deploy.yml runs the migration gate before it asks Render to deploy', () => {
  const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const gate = wf.indexOf('node tools/migration-gate.mjs');
  const deploy = wf.indexOf('/deploys"');
  assert.ok(gate > 0, 'the gate is a step');
  assert.ok(gate < deploy, 'and it runs before the deploy call');
});
