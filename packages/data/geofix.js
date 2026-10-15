/* ==========================================================================
   ECHO ECHO — ONE FRESH LOCATION READING FROM THIS DEVICE

   The standard Geolocation API, used the way a phone needs it:

   - enableHighAccuracy: true, so a phone switches its GPS on instead of
     answering from Wi-Fi or the mobile network alone;
   - maximumAge: 0, so the browser should not hand back a cached position;
   - watchPosition for a short window rather than one getCurrentPosition.
     A phone's FIRST answer is usually its coarse network estimate, sent
     before the GPS has locked; the precise reading arrives a few seconds
     later. Watching briefly and keeping the best reading gets that one.
     The watch is always cleared, and nothing keeps listening afterwards.

   Three things that made students on campus fail before (Oct 2026):

   - the clock started BEFORE the permission prompt was answered, so a
     student who took ten seconds to read Safari's prompt had already "timed
     out". The improvement window now starts at the device's first answer;
     until then the browser's own `timeout` (which by specification excludes
     the time spent on the prompt) and a long safety cap apply;
   - a single POSITION_UNAVAILABLE ended the attempt. iPhones report it
     routinely while the GPS is still acquiring (Core Location's "location
     unknown, keep waiting"), so it is now treated as transient until the
     window closes;
   - a reading stamped even one second before the request was thrown away
     as "cached". A device whose location clock trails the page clock (GNSS
     time against a drifting system clock) lost EVERY reading that way. Only
     a reading that arrives at once AND is stamped well in the past is
     treated as a cached one now; anything the device computes after we
     asked is fresh, whatever its stamp says.

   Nothing here decides anything. The reading - latitude, longitude,
   accuracy in metres and the device's timestamp - is handed back exactly as
   the device reported it, and the server alone judges whether it is precise
   enough and on campus. There is no IP lookup, no default coordinate, and no
   rounding of a poor reading into a good one: a laptop that can only place
   itself to ~200 m by Wi-Fi reports ~200 m.
   ========================================================================== */

/* Stop watching early once a reading is this good: a phone outdoors reaches
   it in seconds, and waiting longer would only delay the student. */
export const GOOD_ENOUGH_M = 20;
/* A reading that arrives within this long of asking is the browser answering
   from memory if it is also stamped more than STALE_MS before the request. */
export const CACHED_WITHIN_MS = 1500;
export const STALE_MS = 30_000;

const rank = (f) => (Number.isFinite(f.accuracy) && f.accuracy >= 0 ? f.accuracy : Infinity);

export class GeoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/* What to do when location is blocked, for the device in hand. The browser
   cannot re-ask once a site is blocked; only the student can unblock it. */
export function deniedHelp(ua = globalThis.navigator?.userAgent || '') {
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return 'Location is blocked for this site. On iPhone: Settings → Privacy & Security → Location Services → '
      + 'Safari Websites → "While Using the App", then tap the "aA" button in the address bar → Website Settings → '
      + 'Location → Allow, and try again.';
  }
  if (/Android/i.test(ua)) {
    return 'Location is blocked for this site. Tap the icon left of the address bar → Permissions → Location → Allow, '
      + 'check that Location is on in your phone\'s quick settings, and try again.';
  }
  return 'Location is blocked for this site. Click the icon left of the address bar, set Location to Allow, '
    + 'and try again. You can also choose your spot on the map instead.';
}

/* The browser's current answer for this site, without prompting:
   'granted' | 'prompt' | 'denied' | 'unknown'. Safari before 16 and some
   in-app browsers cannot say; that is 'unknown', not a refusal. */
export async function permissionState(permissions = globalThis.navigator?.permissions) {
  try {
    const s = await permissions?.query?.({ name: 'geolocation' });
    return ['granted', 'prompt', 'denied'].includes(s?.state) ? s.state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * @param opts.maxWaitMs        how long to keep improving after the first answer
 * @param opts.permissionWaitMs safety cap while the permission prompt is open
 * @param opts.goodEnoughM      stop as soon as a reading is at least this precise
 * @param opts.onReading        (fix) => void, for "best so far: ±N m" progress
 * @param opts.geolocation      injectable for tests; defaults to the browser's
 * @param opts.secure           injectable; defaults to window.isSecureContext
 * @param opts.now              injectable clock for tests
 * @returns {Promise<{lat:number,lng:number,accuracy:number,timestamp:number}>}
 */
export function freshFix({ maxWaitMs = 15_000, permissionWaitMs = 60_000, goodEnoughM = GOOD_ENOUGH_M,
                           onReading = null, geolocation = globalThis.navigator?.geolocation,
                           secure = globalThis.isSecureContext, now = () => Date.now() } = {}) {
  return new Promise((resolve, reject) => {
    /* Browsers expose geolocation only to secure (HTTPS) pages. */
    if (secure === false) {
      reject(new GeoError('insecure', 'Location only works on the secure (https://) address of this site.'));
      return;
    }
    if (!geolocation) {
      reject(new GeoError('unsupported', 'This browser cannot share your location. Choose your spot on the map instead.'));
      return;
    }
    const started = now();
    let best = null, watchId = null, refine = null, cap = null, settled = false, sawUnavailable = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (watchId !== null) geolocation.clearWatch(watchId);
      clearTimeout(refine); clearTimeout(cap);
      fn();
    };
    const finish = () => settle(() => {
      if (best) resolve(best);
      else if (sawUnavailable) {
        reject(new GeoError('unavailable',
          'Your phone could not work out where you are. Turn on Location (GPS), step outside or near a window, '
          + 'and try again, or choose your spot on the map.'));
      } else {
        reject(new GeoError('timeout',
          'Finding your location took too long. Try again near a window or outdoors, or choose your spot on the map.'));
      }
    });
    /* The improvement window opens at the device's first answer. */
    const answered = () => { if (!refine) refine = setTimeout(finish, maxWaitMs); };

    watchId = geolocation.watchPosition((pos) => {
      answered();
      const stamp = pos.timestamp;
      const cachedLooking = Number.isFinite(stamp) && stamp > 1e12 && stamp < started - STALE_MS;
      if (cachedLooking && now() - started < CACHED_WITHIN_MS) return;   // the browser's memory, not a reading
      const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude,
                    accuracy: pos.coords.accuracy, timestamp: stamp };
      if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return;
      if (!best || rank(fix) < rank(best)) best = fix;
      onReading?.(best);
      if (rank(best) <= goodEnoughM) finish();
    }, (err) => {
      if (err?.code === 1) {
        settle(() => reject(new GeoError('denied', deniedHelp())));
        return;
      }
      answered();
      if (err?.code === 2) sawUnavailable = true;   // transient on iPhone: keep watching
      else finish();                                // 3: the browser's own timeout
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs });

    cap = setTimeout(finish, maxWaitMs + permissionWaitMs);
  });
}
