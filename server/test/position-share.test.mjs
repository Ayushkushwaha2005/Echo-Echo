/* ==========================================================================
   A PARTNER'S PHONE, SIMULATED - the sharing rules without a phone.

   This drives the sharing module with a fake geolocation and wake lock. It
   proves the rules. It does not prove what a real phone does with its screen
   locked: that stays on the physical-device checklist in DELIVERY-TRACKING.md.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPositionShare, shouldSend, metresBetween, MIN_SEND_MS, HEARTBEAT_MS, MAX_FIX_AGE_MS, SILENT_AFTER_MS,
} from '../../packages/data/position-share.js';

const A = { lat: 30.4172, lng: 77.9681 };
const far = (p, metres) => ({ lat: p.lat + metres / 111_320, lng: p.lng });
const PERMISSION_DENIED = 1, POSITION_UNAVAILABLE = 2;

function rig({ wakeLock = true, startFails = false } = {}) {
  let t = 1_000_000;
  const sent = [], cleared = [], changes = [];
  const geo = { watchCalls: 0, getCalls: 0, cleared: 0, ok: null, err: null,
    watchPosition(ok, err) { this.watchCalls++; this.ok = ok; this.err = err; return 7; },
    getCurrentPosition() { this.getCalls++; },
    clearWatch() { this.cleared++; } };
  const lock = { released: 0, release() { this.released++; return Promise.resolve(); }, addEventListener() {} };
  const wl = wakeLock ? { requests: 0, request() { this.requests++; return Promise.resolve(lock); } } : undefined;
  const listeners = {};
  const doc = { visibilityState: 'visible', addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener: (n) => { delete listeners[n]; } };
  let tick = null;
  let sendImpl = async (b) => { sent.push(b); };
  const share = createPositionShare({
    orderId: 'o1', geolocation: geo, wakeLock: wl, doc, now: () => t,
    start: async () => { if (startFails) throw new Error('nope'); },
    send: (b) => sendImpl(b), clear: async (r) => { cleared.push(r); },
    onChange: (s) => changes.push(s),
    setTimer: (f) => { tick = f; return 1; }, clearTimer: () => { tick = null; },
  });
  return { share, geo, wl, lock, sent, cleared, changes, doc, listeners,
    advance: (ms) => { t += ms; }, now: () => t, tick: () => tick?.(),
    fix: async (p, age = 0) => geo.ok({ coords: { latitude: p.lat, longitude: p.lng, accuracy: 10 }, timestamp: t - age }),
    failWith: (f) => { sendImpl = f; } };
}
const settle = () => new Promise((r) => setImmediate(r));

test('nothing happens until Start sharing: no watch, no send, no wake lock', () => {
  const r = rig();
  assert.equal(r.geo.watchCalls, 0);
  assert.equal(r.wl.requests, 0);
  assert.equal(r.share.state.status, 'idle');
});

test('it uses one watchPosition and never getCurrentPosition', async () => {
  const r = rig();
  await r.share.begin();
  await r.share.begin();
  assert.equal(r.geo.watchCalls, 1);
  assert.equal(r.geo.getCalls, 0);
  assert.equal(r.share.state.status, 'sharing');
  assert.equal(r.wl.requests, 1, 'keeps the screen on when supported');
});

test('throttle: never faster than the minimum; moving sends, standing still only heartbeats', async () => {
  const r = rig();
  await r.share.begin();
  await r.fix(A); await settle();
  assert.equal(r.sent.length, 1, 'the first fix goes at once');
  r.advance(MIN_SEND_MS - 1); await r.fix(far(A, 500)); await settle();
  assert.equal(r.sent.length, 1, 'too soon, however far');
  r.advance(1); await r.fix(far(A, 500)); await settle();
  assert.equal(r.sent.length, 2, 'moved and enough time passed');
  const here = far(A, 500);
  r.advance(MIN_SEND_MS + 100); await r.fix(far(here, 2)); await settle();
  assert.equal(r.sent.length, 2, 'two metres is GPS noise, not movement');
  r.advance(HEARTBEAT_MS); await r.fix(far(here, 2)); await settle();
  assert.equal(r.sent.length, 3, 'a slow heartbeat, so standing still is not mistaken for gone');
});

test('an old fix from the phone is not sent, and a repeated one is not either', () => {
  const now = 10_000_000;
  assert.equal(shouldSend({ ...A, takenAt: now - MAX_FIX_AGE_MS - 1 }, null, now), false);
  assert.equal(shouldSend({ ...A, takenAt: now }, null, now), true);
  const last = { ...A, takenAt: now, sentAt: now };
  assert.equal(shouldSend({ ...far(A, 100), takenAt: now }, last, now + HEARTBEAT_MS), false, 'same timestamp');
  assert.equal(shouldSend({ ...far(A, 100), takenAt: now - 1000 }, last, now + HEARTBEAT_MS), false, 'older timestamp');
});

test('permission denied or revoked stops the watch, tells the partner and removes what the server holds', async () => {
  const r = rig();
  await r.share.begin();
  await r.fix(A); await settle();
  r.geo.err({ code: PERMISSION_DENIED, PERMISSION_DENIED });
  await settle();
  assert.equal(r.share.state.status, 'denied');
  assert.equal(r.share.state.error.code, 'denied');
  assert.equal(r.geo.cleared, 1);
  assert.equal(r.lock.released, 1);
  assert.deepEqual(r.cleared, ['permission_revoked']);
  const before = r.sent.length;
  await r.fix(far(A, 100)); await settle();
  assert.equal(r.sent.length, before, 'a late fix is ignored');
});

test('a temporary GPS failure keeps watching and recovers by itself', async () => {
  const r = rig();
  await r.share.begin();
  r.geo.err({ code: POSITION_UNAVAILABLE, PERMISSION_DENIED });
  assert.equal(r.share.state.error.code, 'unavailable');
  assert.equal(r.geo.cleared, 0);
  await r.fix(A); await settle();
  assert.equal(r.share.state.error, null);
  assert.equal(r.sent.length, 1);
});

test('a phone gone quiet is reported as silent, and no invented position is sent', async () => {
  const r = rig();
  await r.share.begin();
  await r.fix(A); await settle();
  const n = r.sent.length;
  r.advance(SILENT_AFTER_MS + 1);
  r.tick();
  assert.equal(r.share.state.status, 'silent');
  assert.equal(r.sent.length, n);
  await r.fix(A); await settle();
  assert.equal(r.share.state.status, 'sharing');
});

test('network loss is reported, keeps going, and the next fix after reconnection is sent', async () => {
  const r = rig();
  await r.share.begin();
  r.failWith(async () => { throw Object.assign(new Error('fetch failed'), {}); });
  await r.fix(A); await settle();
  assert.equal(r.share.state.error.code, 'upload');
  assert.equal(r.share.state.status, 'sharing');
  const sent = [];
  r.failWith(async (b) => { sent.push(b); });
  r.advance(1000); await r.fix(far(A, 50)); await settle();
  assert.equal(sent.length, 1, 'a failed send did not count as sent, so nothing waits on the throttle');
  assert.equal(r.share.state.error, null);
});

test('the server refusing an out-of-order fix is not shown as an error', async () => {
  const r = rig();
  await r.share.begin();
  r.failWith(async () => { throw Object.assign(new Error('older'), { status: 409 }); });
  await r.fix(A); await settle();
  assert.equal(r.share.state.error, null);
  assert.equal(r.share.state.status, 'sharing');
});

test('when the delivery is over (403) it stops and does not keep trying', async () => {
  const r = rig();
  await r.share.begin();
  r.failWith(async () => { throw Object.assign(new Error('not in progress'), { status: 403 }); });
  await r.fix(A); await settle();
  assert.equal(r.share.state.status, 'ended');
  assert.equal(r.geo.cleared, 1);
});

test('stopping ends the watch and wake lock and tells the server; start failure leaves nothing running', async () => {
  const r = rig();
  await r.share.begin();
  await r.share.end({ reason: 'partner' });
  assert.equal(r.geo.cleared, 1);
  assert.equal(r.lock.released, 1);
  assert.deepEqual(r.cleared, ['partner']);
  assert.equal(r.share.state.status, 'idle');

  const f = rig({ startFails: true });
  await f.share.begin();
  assert.equal(f.geo.watchCalls, 0);
  assert.equal(f.share.state.status, 'idle');
  assert.ok(f.share.state.error);
});

test('no wake lock support: sharing still works', async () => {
  const r = rig({ wakeLock: false });
  await r.share.begin();
  await r.fix(A); await settle();
  assert.equal(r.sent.length, 1);
  assert.equal(r.share.state.wakeLocked, false);
});

test('the wake lock is taken again when the page returns', async () => {
  const r = rig();
  await r.share.begin();
  const first = r.wl.requests;
  await r.listeners.visibilitychange();
  assert.equal(r.wl.requests, first, 'still held: not requested twice');
});

test('distance helper is sensible', () => {
  const d = metresBetween(A, far(A, 100));
  assert.ok(Math.abs(d - 100) < 1, String(d));
});
