/* ==========================================================================
   ECHO ECHO — A PARTNER SHARING THEIR POSITION

   One watchPosition for the delivery, not a fresh GPS wake-up on a timer. A fix
   goes to the server when the partner has really moved, and at a slow heartbeat
   when they have not, so the viewer can tell "standing still" from "gone quiet".

   What this deliberately does not do: simulate movement, fall back to a network
   or IP position, or send a fix it knows is old. If the phone stops giving
   positions, viewers see the last one age and go grey.

   The browser objects are passed in, so these rules are tested without a phone.
   Whether a real phone behaves this way with its screen locked is a separate
   question that only a phone can answer: see docs/DELIVERY-TRACKING.md.
   ========================================================================== */
export const MIN_SEND_MS = 5_000;
export const HEARTBEAT_MS = 20_000;
export const MIN_MOVE_M = 10;
/* No fix from the phone for this long, and the partner is told. */
export const SILENT_AFTER_MS = 30_000;
/* The server refuses older than 120 s. Do not even try. */
export const MAX_FIX_AGE_MS = 120_000;

export function metresBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/* Should this fix be sent, given the last one that was? */
export function shouldSend(fix, last, now) {
  if (now - fix.takenAt > MAX_FIX_AGE_MS) return false;
  if (!last) return true;
  if (fix.takenAt <= last.takenAt) return false;
  const since = now - last.sentAt;
  if (since < MIN_SEND_MS) return false;
  return since >= HEARTBEAT_MS || metresBetween(last, fix) >= MIN_MOVE_M;
}

export function createPositionShare({
  orderId, start, send, clear, onChange,
  geolocation = globalThis.navigator?.geolocation,
  wakeLock = globalThis.navigator?.wakeLock,
  doc = globalThis.document,
  now = () => Date.now(),
  setTimer = setInterval, clearTimer = clearInterval,
}) {
  const state = { status: 'idle', sentAt: null, fixAt: null, error: null, wakeLocked: false };
  let watchId = null, last = null, lock = null, timer = null, inFlight = false, stopped = true;

  const emit = () => onChange?.({ ...state });

  const acquireLock = async () => {
    if (!wakeLock || lock || stopped) return;
    try {
      lock = await wakeLock.request('screen');
      state.wakeLocked = true;
      lock.addEventListener?.('release', () => { lock = null; state.wakeLocked = false; emit(); });
    } catch { state.wakeLocked = false; }   // low battery or a hidden page: sharing still works
  };
  const onVisibility = () => {
    if (doc?.visibilityState === 'visible') acquireLock();
  };

  const stopWatching = () => {
    if (watchId !== null) geolocation?.clearWatch(watchId);
    watchId = null;
    if (timer) clearTimer(timer);
    timer = null;
    doc?.removeEventListener?.('visibilitychange', onVisibility);
    lock?.release?.().catch?.(() => {});
    lock = null; state.wakeLocked = false;
  };

  const onFix = async (pos) => {
    if (stopped) return;
    const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, takenAt: pos.timestamp };
    state.fixAt = now();
    if (state.status === 'silent' || state.error?.code === 'unavailable') { state.status = 'sharing'; state.error = null; emit(); }
    if (inFlight || !shouldSend(fix, last, now())) return;
    inFlight = true;
    try {
      await send({ orderId, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, takenAt: fix.takenAt });
      last = { ...fix, sentAt: now() };
      state.sentAt = last.sentAt; state.error = null;
      if (state.status !== 'sharing') state.status = 'sharing';
    } catch (e) {
      if (e?.code === 'sharing_not_started' || e?.status === 403) {
        /* The delivery ended or was reassigned. Nothing more will be accepted. */
        stopped = true; stopWatching();
        state.status = 'ended'; state.error = null;
      } else if (e?.status !== 409) {
        /* 409 is the server refusing an out-of-order fix: nothing is wrong. */
        state.error = { code: globalThis.navigator?.onLine === false ? 'offline' : 'upload', message: e?.message || 'Unknown error' };
      }
    } finally { inFlight = false; }
    emit();
  };

  const onError = (err) => {
    if (stopped) return;
    if (err.code === err.PERMISSION_DENIED) {
      /* Denied, or revoked part-way: stop, and remove what the server holds. */
      stopped = true; stopWatching();
      state.status = 'denied'; state.error = { code: 'denied', message: 'Location permission was denied' };
      Promise.resolve(clear?.('permission_revoked')).catch(() => {});
    } else {
      state.error = { code: 'unavailable', message: 'Your location is unavailable' };
    }
    emit();
  };

  return {
    state,
    async begin() {
      if (!stopped) return;
      if (!geolocation) {
        state.status = 'denied'; state.error = { code: 'unsupported', message: 'This browser cannot share location' };
        emit();
        return;
      }
      state.status = 'starting'; state.error = null; emit();
      try {
        await start(orderId);
      } catch (e) {
        state.status = 'idle'; state.error = { code: 'upload', message: e?.message || 'Could not start sharing' };
        emit();
        return;
      }
      stopped = false;
      state.status = 'sharing'; state.fixAt = now();
      watchId = geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, timeout: 20_000, maximumAge: 5_000 });
      timer = setTimer(() => {
        if (!stopped && state.fixAt && now() - state.fixAt > SILENT_AFTER_MS && state.status === 'sharing') { state.status = 'silent'; emit(); }
      }, 5_000);
      doc?.addEventListener?.('visibilitychange', onVisibility);
      await acquireLock();
      emit();
    },
    /* The partner stopping, or the delivery leaving this screen. */
    async end({ tellServer = true, reason = 'partner' } = {}) {
      const wasSharing = !stopped;
      stopped = true; stopWatching();
      state.status = 'idle'; state.error = null;
      emit();
      if (tellServer && wasSharing) await clear?.(reason);
    },
  };
}
