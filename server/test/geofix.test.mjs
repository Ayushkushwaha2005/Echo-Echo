/* ==========================================================================
   THE BROWSER'S LOCATION READING (packages/data/geofix.js)

   Driven with a scripted stand-in for navigator.geolocation: each test says
   what the device reports and when, and checks what the page would send to
   the server. The server's own verdict on those readings is tested in
   campus-address.test.mjs.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshFix, GOOD_ENOUGH_M, deniedHelp, permissionState } from '../../packages/data/geofix.js';

const T0 = 1_790_000_000_000;   // a real epoch-ms clock reading

/* A device that reports `script` readings: [{ after, accuracy, lat?, lng?, stamp? } | { after, error }]. */
function device(script) {
  const calls = { options: null, cleared: [], watching: false };
  const timers = [];
  const geolocation = {
    watchPosition(ok, fail, options) {
      calls.options = options;
      calls.watching = true;
      for (const r of script) {
        timers.push(setTimeout(() => {
          if (!calls.watching) return;
          if (r.error) fail({ code: r.error });
          else ok({ coords: { latitude: r.lat ?? 30.416895, longitude: r.lng ?? 77.968128, accuracy: r.accuracy },
                    timestamp: r.stamp ?? T0 + r.after });
        }, r.after));
      }
      return 7;
    },
    clearWatch(id) { calls.cleared.push(id); calls.watching = false; timers.forEach(clearTimeout); },
  };
  return { geolocation, calls };
}
const run = (script, opts = {}) => {
  const d = device(script);
  return { d, fix: freshFix({ geolocation: d.geolocation, now: () => T0, maxWaitMs: 400, permissionWaitMs: 200, ...opts }) };
};

test('asks for a fresh, high-accuracy reading: GPS on, no cached position', async () => {
  const { d, fix } = run([{ after: 5, accuracy: 10 }]);
  await fix;
  assert.equal(d.calls.options.enableHighAccuracy, true);
  assert.equal(d.calls.options.maximumAge, 0);
  assert.deepEqual(d.calls.cleared, [7], 'the watch is cleared: nothing keeps listening');
});

test('hands back latitude, longitude, accuracy in metres and the device timestamp, unaltered', async () => {
  const f = await run([{ after: 5, accuracy: 10, lat: 30.4168951, lng: 77.9681283 }]).fix;
  assert.deepEqual(f, { lat: 30.4168951, lng: 77.9681283, accuracy: 10, timestamp: T0 + 5 });
});

for (const accuracy of [10, 30, 100, 212]) {
  test(`a ${accuracy} m reading is reported as ${accuracy} m - never improved, never replaced`, async () => {
    const f = await run([{ after: 5, accuracy }]).fix;
    assert.equal(f.accuracy, accuracy);
    assert.equal(f.lat, 30.416895);
  });
}

test('a phone\'s coarse first answer is replaced by its GPS lock', async () => {
  const { d, fix } = run([{ after: 5, accuracy: 212 }, { after: 40, accuracy: 65 }, { after: 80, accuracy: 8 },
                          { after: 300, accuracy: 3 }]);
  const f = await fix;
  assert.equal(f.accuracy, 8, 'stops as soon as a reading is good enough');
  assert.ok(8 <= GOOD_ENOUGH_M);
  assert.equal(d.calls.watching, false);
});

test('a laptop that only ever manages 212 m gets 212 m, after the wait', async () => {
  const started = Date.now();
  const f = await run([{ after: 5, accuracy: 212 }, { after: 60, accuracy: 240 }]).fix;
  assert.equal(f.accuracy, 212, 'the best reading, still honestly poor');
  assert.ok(Date.now() - started >= 350, 'it waited for a better one before giving up');
});

test('a cached reading from before the request is ignored', async () => {
  const f = await run([{ after: 5, accuracy: 5, stamp: T0 - 60_000, lat: 28.6 }, { after: 20, accuracy: 25 }]).fix;
  assert.equal(f.accuracy, 25);
  assert.equal(f.lat, 30.416895, 'the stale position (elsewhere) was not used');
});

test('only a stale reading, then nothing: refused, not guessed', async () => {
  await assert.rejects(run([{ after: 5, accuracy: 5, stamp: T0 - 60_000 }]).fix, { code: 'timeout' });
});

test('permission denied, no location, and no Geolocation API are refusals with a reason', async () => {
  await assert.rejects(run([{ after: 5, error: 1 }]).fix, { code: 'denied' });
  await assert.rejects(run([{ after: 5, error: 2 }]).fix, { code: 'unavailable' });
  await assert.rejects(run([]).fix, { code: 'timeout' });
  await assert.rejects(freshFix({ geolocation: undefined }), { code: 'unsupported' });
  /* A transient error after a good reading keeps the reading. */
  assert.equal((await run([{ after: 5, accuracy: 40 }, { after: 20, error: 2 }]).fix).accuracy, 40);
});

test('a reading without a usable accuracy never outranks one with it', async () => {
  const f = await run([{ after: 5, accuracy: NaN }, { after: 20, accuracy: 60 }]).fix;
  assert.equal(f.accuracy, 60);
});

/* ================= the October 2026 root causes =========================== */

test('a slow answer to the permission prompt is not a timeout: the window opens at the first reading', async () => {
  /* The student reads Safari's prompt for longer than the whole improvement
     window; the first reading only arrives after that. */
  const f = await run([{ after: 650, accuracy: 30 }], { permissionWaitMs: 2000 }).fix;
  assert.equal(f.accuracy, 30);
});

test('iPhone\'s transient "position unavailable" while the GPS warms up does not end the attempt', async () => {
  const f = await run([{ after: 5, error: 2 }, { after: 60, error: 2 }, { after: 120, accuracy: 18 }]).fix;
  assert.equal(f.accuracy, 18);
});

test('a reading stamped a few seconds behind the page clock (device clock skew) is kept', async () => {
  const f = await run([{ after: 5, accuracy: 12, stamp: T0 - 4000 }]).fix;
  assert.equal(f.accuracy, 12, 'not discarded as "cached"');
});

test('a reading computed after we asked is fresh even when its stamp is minutes behind', async () => {
  const real0 = Date.now();
  const f = await run([{ after: 1600, accuracy: 15, stamp: T0 - 300_000 }],
    { now: () => T0 + (Date.now() - real0), maxWaitMs: 2500, permissionWaitMs: 500 }).fix;
  assert.equal(f.accuracy, 15);
});

test('an insecure page is told why, and nothing is asked of the device', async () => {
  const { d, fix } = run([{ after: 5, accuracy: 10 }], { secure: false });
  await assert.rejects(fix, { code: 'insecure' });
  assert.equal(d.calls.options, null, 'watchPosition was never called');
});

test('a blocked site gets instructions for the device in hand', async () => {
  assert.match(deniedHelp('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'),
    /Settings → Privacy & Security → Location Services/);
  assert.match(deniedHelp('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129.0 Mobile'), /Permissions → Location/);
  assert.match(deniedHelp('Mozilla/5.0 (Windows NT 10.0) Chrome/129.0'), /address bar/);
  await assert.rejects(run([{ after: 5, error: 1 }]).fix, (e) => e.code === 'denied' && /blocked/.test(e.message));
});

test('the permission state is read without prompting, and "cannot say" is not a refusal', async () => {
  assert.equal(await permissionState({ query: async () => ({ state: 'denied' }) }), 'denied');
  assert.equal(await permissionState({ query: async () => ({ state: 'granted' }) }), 'granted');
  assert.equal(await permissionState({ query: async () => { throw new TypeError('geolocation'); } }), 'unknown');
  assert.equal(await permissionState(undefined), 'unknown');
});
