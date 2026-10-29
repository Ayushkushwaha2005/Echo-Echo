/* ==========================================================================
   WHAT A FAILED REQUEST MEANS, AND WHETHER TO TRY AGAIN (packages/data/retry.js)

   Team Chat used to say "Cannot reach the server" for everything. Each kind
   of failure now has its own meaning, and only those another attempt can
   fix are retried - a few times, with growing waits, cancellably:
     * no connection, a timeout, a 5xx/429 from the server: retried
     * signed out, refused, a route this server does not have, a 404 from
       something that is not the API: not retried, and said plainly
   The requests are the real client (packages/data/client.js) against a
   stubbed fetch, so the statuses and bodies are exactly what a browser
   would hand it.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.QUAD_API_BASE = '/api';
const { quad, staffRequests } = await import('../../packages/data/client.js');
const { failure, retrying } = await import('../../packages/data/retry.js');
staffRequests();

/* Answers fetch with the given responses in turn (a function throws, a number delays). */
function serve(...answers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (typeof a === 'function') return a(init);
    return new Response(a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body),
      { status: a.status, headers: { 'content-type': typeof a.body === 'string' ? 'text/html' : 'application/json' } });
  };
  return calls;
}
const ok = { status: 200, body: { conversations: [{ id: 'c1', audience: 'staff', members: [] }], me: 'u1' } };
const empty = { status: 200, body: { conversations: [], me: 'u1' } };
const noNetwork = () => { throw new TypeError('Failed to fetch'); };
const kindOf = async (...answers) => {
  serve(...answers);
  return quad.chatConversations().then(() => 'ok', (e) => failure(e, 'Your conversations'));
};
const instant = { sleep: async () => {} };

test('each failure is named for what it is', async () => {
  const f = {
    offline: await kindOf(noNetwork),
    signedOut: await kindOf({ status: 401, body: { error: 'Sign in required', code: 'unauthenticated' } }),
    forbidden: await kindOf({ status: 403, body: { error: 'Only ECHO ECHO staff can start conversations', code: 'forbidden' } }),
    origin: await kindOf({ status: 403, body: { error: 'Cross-origin request rejected', code: 'forbidden' } }),
    route: await kindOf({ status: 404, body: { message: 'Route GET:/chat/conversations/ not found', error: 'Not Found', statusCode: 404 } }),
    host404: await kindOf({ status: 404, body: '<html>The page could not be found</html>' }),
    s500: await kindOf({ status: 500, body: { error: 'Something went wrong', code: 'internal' } }),
    s502: await kindOf({ status: 502, body: '<html>Bad gateway</html>' }),
    s429: await kindOf({ status: 429, body: { error: 'Too many requests', code: 'rate_limited' } }),
  };
  assert.equal(f.offline.kind, 'offline'); assert.equal(f.offline.retryable, true);
  assert.equal(f.signedOut.kind, 'signed_out'); assert.equal(f.signedOut.retryable, false);
  assert.match(f.signedOut.title, /session has ended/);
  assert.equal(f.forbidden.kind, 'forbidden'); assert.equal(f.forbidden.retryable, false);
  assert.equal(f.origin.kind, 'forbidden');
  assert.match(f.origin.title, /cannot be saved from this address/i, 'the wrong-address refusal keeps its own wording');
  assert.equal(f.route.kind, 'missing'); assert.match(f.route.detail, /\/chat\/conversations/);
  assert.equal(f.host404.kind, 'missing'); assert.equal(f.host404.status, 404);
  assert.match(f.host404.title, /could not find your conversations \(404\)/);
  assert.equal(f.s500.kind, 'server'); assert.equal(f.s500.retryable, true); assert.match(f.s500.title, /500/);
  assert.equal(f.s502.kind, 'server'); assert.match(f.s502.title, /temporarily unavailable \(502\)/);
  assert.equal(f.s429.retryable, true);
  const titles = Object.values(f).map((x) => x.title);
  assert.equal(titles.filter((t) => /cannot reach/i.test(t)).length, 1, '"Cannot reach" only for no connection');
});

test('a slow answer is waited for; one past the limit is a timeout, not "cannot reach"', async () => {
  serve(() => new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(empty.body), { status: 200 })), 150)));
  const t0 = Date.now();
  const r = await quad.chatConversations(undefined, { timeoutMs: 2000 });
  assert.deepEqual(r.conversations, []);
  assert.ok(Date.now() - t0 >= 140, 'a slow answer still arrives');

  serve((init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
  const e = await quad.chatConversations(undefined, { timeoutMs: 50 }).catch((x) => x);
  const f = failure(e, 'Your conversations');
  assert.equal(f.kind, 'timeout'); assert.equal(f.retryable, true);
  assert.match(f.title, /taking too long/);
});

test('retryable failures are retried a bounded number of times, then reported', async () => {
  const calls = serve(noNetwork, { status: 503, body: '<html>unavailable</html>' }, ok);
  const seen = [];
  const r = await retrying(() => quad.chatConversations(), { ...instant, onRetry: (x) => seen.push([x.attempt, x.failure.kind]) });
  assert.equal(r.conversations.length, 1, 'recovers once the server answers');
  assert.equal(calls.length, 3);
  assert.deepEqual(seen, [[2, 'offline'], [3, 'server']]);

  const again = serve(noNetwork);
  await assert.rejects(retrying(() => quad.chatConversations(), { ...instant, attempts: 3 }));
  assert.equal(again.length, 3, 'three attempts and no more: never a loop');
});

test('an empty list is an answer, not a failure', async () => {
  serve(empty);
  const r = await retrying(() => quad.chatConversations(), instant);
  assert.deepEqual(r.conversations, []);
});

test('what another attempt cannot fix is not retried', async () => {
  for (const a of [{ status: 401, body: { error: 'Sign in required', code: 'unauthenticated' } },
                   { status: 403, body: { error: 'Not allowed', code: 'forbidden' } },
                   { status: 404, body: '<html>missing</html>' },
                   { status: 400, body: { error: 'audience must be staff, partners or cafes' } }]) {
    const calls = serve(a);
    await assert.rejects(retrying(() => quad.chatConversations(), instant));
    assert.equal(calls.length, 1, `status ${a.status}: one request only`);
  }
});

test('a cancelled request stops retrying and is not reported as a failure', async () => {
  const ctl = new AbortController();
  serve((init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
  const p = retrying(() => quad.chatConversations(undefined, { signal: ctl.signal }), { signal: ctl.signal });
  setTimeout(() => ctl.abort('cancelled'), 20);
  const e = await p.catch((x) => x);
  assert.equal(failure(e).kind, 'cancelled');

  /* Cancelled while waiting between attempts, too. */
  const ctl2 = new AbortController();
  const calls = serve(noNetwork);
  const p2 = retrying(() => quad.chatConversations(), { signal: ctl2.signal, baseMs: 10_000 });
  setTimeout(() => ctl2.abort('cancelled'), 20);
  assert.equal(failure(await p2.catch((x) => x)).kind, 'cancelled');
  assert.equal(calls.length, 1);
});

test('the waits grow and are capped', async () => {
  serve(noNetwork);
  const waits = [];
  await retrying(() => quad.chatConversations(), { attempts: 6, baseMs: 1000, maxMs: 4000, sleep: async (ms) => { waits.push(ms); } }).catch(() => {});
  assert.equal(waits.length, 5);
  assert.ok(waits[0] >= 750 && waits[0] <= 1250);
  assert.ok(waits[1] >= 1500 && waits[1] <= 2500);
  assert.ok(waits.every((w) => w <= 5000), 'never more than the cap (with jitter)');
});
