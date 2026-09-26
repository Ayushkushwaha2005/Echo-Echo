/* ==========================================================================
   ECHO ECHO — ONE FRESH LOCATION READING FROM THIS DEVICE

   The standard Geolocation API, used the way a phone needs it:

   - enableHighAccuracy: true, so a phone switches its GPS on instead of
     answering from Wi-Fi or the mobile network alone;
   - maximumAge: 0, so the browser may not hand back a cached position;
   - watchPosition for a short window rather than one getCurrentPosition.
     A phone's FIRST answer is usually its coarse network estimate, sent
     before the GPS has locked; the precise reading arrives a few seconds
     later. Watching briefly and keeping the best reading gets that one.
     The watch is always cleared, and nothing keeps listening afterwards.

   Nothing here decides anything. The reading - latitude, longitude,
   accuracy in metres and the device's timestamp - is handed back exactly as
   the device reported it, and the server alone judges whether it is precise
   enough and on campus. There is no IP lookup, no default coordinate, and no
   rounding of a poor reading into a good one: a laptop that can only place
   itself to ~200 m by Wi-Fi reports ~200 m, and is refused for it.
   ========================================================================== */

/* Stop watching early once a reading is this good: a phone outdoors reaches
   it in seconds, and waiting longer would only delay the student. */
export const GOOD_ENOUGH_M = 20;

const rank = (f) => (Number.isFinite(f.accuracy) && f.accuracy >= 0 ? f.accuracy : Infinity);

export class GeoError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param opts.maxWaitMs   how long to keep improving the reading
 * @param opts.goodEnoughM stop as soon as a reading is at least this precise
 * @param opts.onReading   (fix) => void, for "best so far: ±N m" progress
 * @param opts.geolocation injectable for tests; defaults to the browser's
 * @param opts.now         injectable clock for tests
 * @returns {Promise<{lat:number,lng:number,accuracy:number,timestamp:number}>}
 */
export function freshFix({ maxWaitMs = 12_000, goodEnoughM = GOOD_ENOUGH_M, onReading = null,
                           geolocation = globalThis.navigator?.geolocation, now = () => Date.now() } = {}) {
  return new Promise((resolve, reject) => {
    if (!geolocation) {
      reject(new GeoError('unsupported', 'This browser cannot share your location.'));
      return;
    }
    const started = now();
    let best = null, watchId = null, timer = null, settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (watchId !== null) geolocation.clearWatch(watchId);
      clearTimeout(timer);
      fn();
    };
    const finish = () => settle(() => (best ? resolve(best)
      : reject(new GeoError('timeout', 'Finding your location took too long. Try again outdoors.'))));

    watchId = geolocation.watchPosition((pos) => {
      /* A reading stamped before this request began is a cached one, whatever
         maximumAge said. Wait for a fresh one. (Only when the stamp is a real
         epoch time: a browser with an odd clock must not lose every reading.) */
      if (pos.timestamp > 1e12 && pos.timestamp < started - 1000) return;
      const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude,
                    accuracy: pos.coords.accuracy, timestamp: pos.timestamp };
      if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return;
      if (!best || rank(fix) < rank(best)) best = fix;
      onReading?.(best);
      if (rank(best) <= goodEnoughM) finish();
    }, (err) => {
      if (err.code === 1) {
        settle(() => reject(new GeoError('denied',
          'Location permission was denied. Allow location for this site in your browser settings and try again.')));
      } else if (best) {
        finish();                         // keep the good reading already taken
      } else if (err.code === 2) {
        settle(() => reject(new GeoError('unavailable',
          'Your location is unavailable right now. Turn on location (GPS) and try again, ideally outdoors.')));
      } else {
        finish();
      }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs });

    timer = setTimeout(finish, maxWaitMs);
  });
}
