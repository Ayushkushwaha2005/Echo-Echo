/* ==========================================================================
   ECHO ECHO — GOOGLE MAPS for the delivery partner and Campus Control

   Maps JavaScript API with Advanced Markers. Used only where the server's
   tracking or fleet answer says `maps.provider === 'google'`; everything
   else - and any failure here - keeps the OpenStreetMap map in map.js.

   Billing rule this file is built around: Google charges per map CREATED
   (one "Dynamic Maps" load), not per marker move. So a screen creates its
   map once (createLiveMap), keeps the element, and every later update calls
   controller.update(...) or .setSelf(...), which only move markers and
   redraw route lines on the map that already exists.

   Routes come from the server (Routes API, WALK, Essentials), already
   encoded; this file never calls a Google web service itself, and no other
   Google library (Places, Geocoding, Directions) is loaded.
   ========================================================================== */

let loading = null;

/* ---------- Google failing AFTER a map is on screen ------------------------
   A refused key, an exhausted daily quota or billing trouble does not stop
   the script loading: Google then calls gm_authFailure and/or paints its own
   "can't load Google Maps correctly" box inside the map. Either way the map
   is useless, so every screen showing one is told (onGoogleFailure) and
   swaps to the OpenStreetMap map for the rest of the visit. */
let failed = false;
const failureListeners = new Set();
export function onGoogleFailure(fn) {
  if (failed) { queueMicrotask(fn); return () => {}; }
  failureListeners.add(fn);
  return () => failureListeners.delete(fn);
}
export const googleFailed = () => failed;
function reportFailure() {
  if (failed) return;
  failed = true;
  for (const fn of failureListeners) { try { fn(); } catch { /* one screen's handler must not stop the others */ } }
  failureListeners.clear();
}
/* Google's error box, inside a map container. */
function watchForErrorBox(el) {
  const check = () => (el.querySelector('.gm-err-container, .gm-err-message') ? (reportFailure(), true) : false);
  if (check()) return;
  const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
  mo.observe(el, { childList: true, subtree: true });
}

/* One <script> per page, whatever the number of maps. Rejects on network
   failure, a refused key (gm_authFailure), or a timeout, so the caller can
   fall back to the OpenStreetMap map. */
export function loadGoogleMaps(cfg, { timeoutMs = 12000 } = {}) {
  if (failed) return Promise.reject(new Error('Google Maps is unavailable for this visit'));
  if (globalThis.google?.maps?.importLibrary) return Promise.resolve(globalThis.google.maps);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Google Maps did not load in time')), timeoutMs);
    globalThis.gm_authFailure = () => { clearTimeout(timer); reportFailure(); reject(new Error('Google Maps refused the key for this site')); };
    globalThis.__echoGoogleMapsReady = () => { clearTimeout(timer); resolve(globalThis.google.maps); };
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({
      key: cfg.browserKey, v: 'weekly', loading: 'async', libraries: 'marker,geometry',
      callback: '__echoGoogleMapsReady', language: 'en', region: 'IN',
    });
    s.async = true;
    s.onerror = () => { clearTimeout(timer); reject(new Error('Could not reach Google Maps')); };
    document.head.append(s);
  }).catch((e) => { loading = null; throw e; });
  return loading;
}

const FRESH_S = 60;
const STALE_S = 300;

const ICONS = {
  pickup: '<path d="M7 3v8a2 2 0 0 0 2 2h0v8M11 3v6M9 3v6M17 21V3c-2 1-3 3-3 6v4h3"/>',
  destination: '<path d="M12 21s-6-5.7-6-11a6 6 0 0 1 12 0c0 5.3-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  partner: '<circle cx="13" cy="4" r="2"/><path d="M9 21l2-6 3 3v3M7 12l3-4 4 1 3 3M10 8l-1 5"/>',
};

function injectStyles() {
  if (document.getElementById('echo-gmap-css')) return;
  const st = document.createElement('style');
  st.id = 'echo-gmap-css';
  st.textContent = `
  .eg-pin{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;border:2px solid #fff;
    box-shadow:0 2px 6px rgba(0,0,0,.35);color:#fff;transition:background .3s}
  .eg-pin svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .eg-pin.pickup{background:#1C1917}.eg-pin.destination{background:#E0567A}
  .eg-pin.partner{background:#2F7D5F;width:34px;height:34px}
  .eg-pin.partner.stale{background:#8C7A7E}.eg-pin.partner.alert{box-shadow:0 0 0 4px rgba(217,119,6,.55),0 2px 6px rgba(0,0,0,.35)}
  .eg-pin.partner.self{background:#2563EB}
  .eg-tag{position:absolute;top:36px;left:50%;transform:translateX(-50%);white-space:nowrap;background:#fff;color:#1C1917;
    font:700 11px/1.2 system-ui,sans-serif;padding:2px 7px;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,.3)}
  .eg-wrap{position:relative}
  .eg-info{font:13px/1.4 system-ui,sans-serif;color:#1C1917;max-width:240px}
  .eg-info b{display:block;margin-bottom:2px}.eg-info .warn{color:#B45309}`;
  document.head.append(st);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pinElement(kind, { label = '', extra = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'eg-wrap';
  wrap.innerHTML = `<div class="eg-pin ${kind} ${extra}" role="img" aria-label="${esc(label || kind)}">
    <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind === 'self' ? 'partner' : kind] || ''}</svg></div>
    ${label ? `<span class="eg-tag">${esc(label)}</span>` : ''}`;
  return wrap;
}

export const walkText = (route) => (route?.distanceM
  ? `${route.distanceM < 1000 ? `${Math.round(route.distanceM / 10) * 10} m` : `${(route.distanceM / 1000).toFixed(1)} km`} · about ${Math.max(1, Math.round(route.durationS / 60))} min walk`
  : '');

/* Google Maps app/website walking directions. A plain link: no key, no API. */
export const directionsUrl = (to, from = null) => 'https://www.google.com/maps/dir/?' + new URLSearchParams({
  api: '1', destination: `${to.lat},${to.lng}`, travelmode: 'walking', ...(from ? { origin: `${from.lat},${from.lng}` } : {}),
});

/**
 * Create the one map for a screen.
 *
 * @param el   the container (kept by the caller and re-attached on re-render)
 * @param cfg  { browserKey, mapId } from the server's `maps` answer
 * @returns controller:
 *   update(deliveries, { selfOrderId })  draw / move everything, in place
 *   setSelf({lat,lng,accuracy})          the partner's own phone position
 *   focus(orderId)                       pan to one delivery
 *   fitAll()                             fit every point
 */
export async function createLiveMap(el, cfg, { center = null, boundary = null, onSelect = null } = {}) {
  const maps = await loadGoogleMaps(cfg);
  const [{ Map, InfoWindow, Polyline, Polygon, LatLngBounds }, { AdvancedMarkerElement }, geometry] = await Promise.all([
    maps.importLibrary('maps'), maps.importLibrary('marker'), maps.importLibrary('geometry')]);
  injectStyles();
  el.classList.add('echo-gmap');
  const map = new Map(el, {
    mapId: cfg.mapId || 'DEMO_MAP_ID',
    center: center || { lat: 30.4163, lng: 77.9686 },
    zoom: 17,
    mapTypeId: 'hybrid',
    mapTypeControl: true,
    mapTypeControlOptions: { mapTypeIds: ['roadmap', 'satellite', 'hybrid'] },
    streetViewControl: false,
    fullscreenControl: true,
    clickableIcons: false,
    gestureHandling: 'cooperative',
  });
  watchForErrorBox(el);
  const info = new InfoWindow();
  const markers = new globalThis.Map();   // key -> { marker, kind, anim }
  const lines = new globalThis.Map();     // orderId -> Polyline
  let fitted = false;
  let selfPos = null;
  let selfOrder = null;
  let last = [];

  if (boundary?.polygon?.length) {
    new Polygon({ map, paths: boundary.polygon.map(([lat, lng]) => ({ lat, lng })),
      strokeColor: '#E0567A', strokeOpacity: 0.8, strokeWeight: 1.5, fillOpacity: 0.03, clickable: false });
  }

  /* Glide a marker to its new position instead of jumping. */
  function glide(rec, to) {
    const from = rec.marker.position;
    const a = from ? { lat: typeof from.lat === 'function' ? from.lat() : from.lat, lng: typeof from.lng === 'function' ? from.lng() : from.lng } : to;
    if (rec.anim) cancelAnimationFrame(rec.anim);
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = k * (2 - k);
      rec.marker.position = { lat: a.lat + (to.lat - a.lat) * e, lng: a.lng + (to.lng - a.lng) * e };
      rec.anim = k < 1 ? requestAnimationFrame(step) : null;
    };
    rec.anim = requestAnimationFrame(step);
  }

  function place(key, kind, pos, { label, extra, title, html, orderId }) {
    let rec = markers.get(key);
    const content = pinElement(kind === 'self' ? 'partner' : kind, { label, extra: `${extra || ''}${kind === 'self' ? ' self' : ''}` });
    if (!rec) {
      const marker = new AdvancedMarkerElement({ map, position: pos, content, title, zIndex: kind === 'partner' || kind === 'self' ? 30 : 10 });
      rec = { marker, kind, html, orderId };
      marker.addListener('click', () => {
        info.setContent(`<div class="eg-info">${rec.html}</div>`);
        info.open({ map, anchor: marker });
        if (rec.orderId) onSelect?.(rec.orderId);
      });
      markers.set(key, rec);
    } else {
      rec.marker.content = content;
      rec.marker.title = title;
      rec.html = html;
      if (kind === 'partner' || kind === 'self') glide(rec, pos); else rec.marker.position = pos;
    }
    rec.seen = true;
  }

  function drawRoute(d) {
    let line = lines.get(d.orderId);
    const path = d.route?.polyline ? geometry.encoding.decodePath(d.route.polyline) : null;
    if (!path) { line?.setMap(null); lines.delete(d.orderId); return; }
    const style = { strokeColor: d.alerts?.some((a) => a.code === 'off_route') ? '#D97706' : '#2563EB', strokeOpacity: 0.9, strokeWeight: 5 };
    if (!line) { line = new Polyline({ map, path, clickable: false, ...style }); lines.set(d.orderId, line); }
    else { line.setPath(path); line.setOptions(style); }
    line.seen = true;
  }

  function update(deliveries = [], { selfOrderId = null } = {}) {
    last = deliveries;
    selfOrder = selfOrderId;
    for (const r of markers.values()) r.seen = false;
    for (const l of lines.values()) l.seen = false;
    for (const d of deliveries) {
      const head = `<b>${esc(d.code || 'Delivery')}${d.partnerName ? ` · ${esc(d.partnerName)}` : ''}</b>`;
      const walk = walkText(d.route);
      if (d.pickup) {
        place(`${d.orderId}:pickup`, 'pickup', d.pickup, { label: d.pickup.name, title: `Pick-up: ${d.pickup.name}`,
          html: `${head}Pick-up: ${esc(d.pickup.name)}`, orderId: d.orderId });
      }
      if (d.destination) {
        place(`${d.orderId}:destination`, 'destination', d.destination, { title: `Drop: ${d.destination.name || ''}`,
          html: `${head}Drop: ${esc(d.destination.name || 'Delivery spot')}${d.address ? `<br>${esc(typeof d.address === 'string' ? d.address : d.address.label || '')}` : ''}`, orderId: d.orderId });
      }
      const isSelf = selfOrderId && d.orderId === selfOrderId;
      const pos = isSelf && selfPos ? selfPos : d.partner;
      const age = isSelf && selfPos ? 0 : d.partner?.ageSeconds;
      if (pos && (age == null || age <= STALE_S)) {
        const alerts = d.alerts || [];
        place(`${d.orderId}:partner`, isSelf ? 'self' : 'partner', { lat: pos.lat, lng: pos.lng }, {
          label: isSelf ? 'You' : (d.partnerName ? d.partnerName.split(/\s+/)[0] : d.code),
          extra: `${age > FRESH_S ? 'stale' : ''} ${alerts.length ? 'alert' : ''}`,
          title: isSelf ? 'Your position' : 'Delivery partner',
          orderId: d.orderId,
          html: `${head}${esc(d.state === 'assigned' ? 'Heading to the café' : 'On the way to the student')}`
            + `${age != null ? `<br>Position ${age < 60 ? `${Math.max(1, age)} s` : `${Math.round(age / 60)} min`} old` : ''}`
            + `${walk ? `<br>${esc(walk)}` : ''}`
            + alerts.map((a) => `<br><span class="warn">${esc(a.text)}</span>`).join(''),
        });
      }
      drawRoute(d);
    }
    for (const [k, r] of markers) if (!r.seen) { r.marker.map = null; markers.delete(k); }
    for (const [k, l] of lines) if (!l.seen) { l.setMap(null); lines.delete(k); }
    if (!fitted) fitAll();
  }

  function points(list = last) {
    const out = [];
    for (const d of list) for (const p of [d.pickup, d.destination, d.partner]) if (p) out.push(p);
    if (selfPos) out.push(selfPos);
    return out;
  }
  function fitAll(list) {
    const pts = points(list);
    if (!pts.length) return;
    fitted = true;
    if (pts.length === 1) { map.setCenter(pts[0]); map.setZoom(18); return; }
    const b = new LatLngBounds();
    for (const p of pts) b.extend(p);
    map.fitBounds(b, 48);
  }

  return {
    map,
    update,
    setSelf(fix) {
      selfPos = fix ? { lat: Number(fix.lat), lng: Number(fix.lng) } : null;
      if (selfOrder) update(last, { selfOrderId: selfOrder });
    },
    focus(orderId) {
      const d = last.find((x) => x.orderId === orderId);
      if (d) fitAll([d]);
    },
    fitAll: () => fitAll(),
    destroy() { for (const r of markers.values()) r.marker.map = null; for (const l of lines.values()) l.setMap(null); markers.clear(); lines.clear(); },
  };
}

/* ==========================================================================
   THE STUDENT'S DELIVERY-SPOT PICKER (checkout), on Google Maps

   The same controller as drawPickerMap in map.js - sync / refresh / setBase /
   base / focusLive / focusPin / destroy - so the checkout code, the
   POST /campus/pin check and the order's own re-validation are untouched.
   It draws only what GET /campus/map sent: the active outline, the
   confirmed delivery points (grouped exactly as map.js groups them), the
   student's pin, and their phone's accepted reading with its accuracy.

   Billing: one map load when the picker is first opened. The caller keeps
   this controller for the rest of the visit, so closing and reopening the
   sheet, or every re-render while it is open, reuses the same map.
   ========================================================================== */
export async function createPickerMap(el, data, { onTap, onSelect, ...state } = {}) {
  const { destinationMarkers } = await import('./map.js');
  const maps = await loadGoogleMaps(data.maps);
  const [{ Map, InfoWindow, Polygon, Circle, LatLngBounds }, { AdvancedMarkerElement }, core] = await Promise.all([
    maps.importLibrary('maps'), maps.importLibrary('marker'), maps.importLibrary('core')]);
  const { ControlPosition } = core;
  injectStyles();
  injectPickerStyles();
  el.classList.add('echo-gmap');
  const poly = data.boundary.polygon.map(([lat, lng]) => ({ lat, lng }));
  const bounds = new LatLngBounds();
  for (const p of poly) bounds.extend(p);
  const pad = (b, k) => {
    const ne = b.getNorthEast(), sw = b.getSouthWest();
    const dl = (ne.lat() - sw.lat()) * k, dg = (ne.lng() - sw.lng()) * k;
    return { north: ne.lat() + dl, south: sw.lat() - dl, east: ne.lng() + dg, west: sw.lng() - dg };
  };
  const map = new Map(el, {
    mapId: data.maps.mapId || 'DEMO_MAP_ID',
    center: data.boundary.center ? { lat: data.boundary.center[0], lng: data.boundary.center[1] } : poly[0],
    zoom: 16,
    mapTypeId: 'hybrid',
    mapTypeControl: true,
    mapTypeControlOptions: { mapTypeIds: ['roadmap', 'satellite', 'hybrid'], position: ControlPosition.TOP_RIGHT },
    streetViewControl: false,
    fullscreenControl: false,
    clickableIcons: false,
    gestureHandling: 'greedy',
    restriction: { latLngBounds: pad(bounds, 0.6), strictBounds: false },
  });
  watchForErrorBox(el);
  new Polygon({ map, paths: poly, clickable: false, strokeColor: '#E0567A', strokeOpacity: 0.95,
    strokeWeight: 2, fillColor: '#E0567A', fillOpacity: 0.07 });

  const info = new InfoWindow();
  const byId = new globalThis.Map((data.destinations || []).map((d) => [d.id, d]));
  const choose = (id) => { const d = byId.get(id); if (d) onSelect?.(d); };
  const groups = destinationMarkers(data.destinations);
  const destEl = (g, chosen) => {
    const w = document.createElement('div');
    w.className = 'eg-wrap';
    w.innerHTML = `<div class="eg-dest${chosen ? ' sel' : ''}" role="button" aria-label="${esc(g.label)}">${chosen ? '✓' : g.ids.length > 1 ? g.ids.length : ''}</div>`
      + `<span class="eg-tag ${g.labelSide === 'bottom' ? '' : 'up'}">${esc(g.label)}</span>`;
    return w;
  };
  const markers = groups.map((g) => {
    const m = new AdvancedMarkerElement({ map, position: { lat: g.lat, lng: g.lng }, content: destEl(g, false), title: g.label, zIndex: 20 });
    m.addListener('click', () => {
      if (g.ids.length === 1) return choose(g.ids[0]);
      /* Two points too close to tap apart: ask which, by name. */
      const box = document.createElement('div');
      box.className = 'eg-info';
      box.innerHTML = g.ids.map((id, i) => `<button type="button" class="btn btn-secondary btn-sm" style="display:block;width:100%;margin:4px 0" data-dest-id="${esc(id)}">${esc(g.names[i])}</button>`).join('');
      box.addEventListener('click', (e) => { const b = e.target.closest('[data-dest-id]'); if (b) { info.close(); choose(b.dataset.destId); } });
      info.setContent(box);
      info.open({ map, anchor: m });
      return null;
    });
    return { g, m };
  });

  let tapped = null, liveDot = null, liveRing = null, lastLive = null;
  const pinEl = (status) => {
    const w = document.createElement('div');
    w.className = `eg-spot ${status}`;
    w.setAttribute('aria-label', status === 'refused' ? 'Your delivery spot: outside the campus delivery area'
      : status === 'checking' ? 'Your delivery spot (checking)' : 'Your delivery spot. Drag to move it.');
    w.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg>';
    return w;
  };

  /* "My location" and "Pin the centre", bottom-left by the thumb. */
  const lower = document.createElement('div');
  lower.className = 'echo-map-tools echo-map-tools-low';
  lower.style.margin = '10px';
  lower.innerHTML = '<button type="button" class="echo-map-recentre" aria-label="Centre the map on my location" style="display:none">◎ My location</button>'
    + '<button type="button" class="echo-map-recentre echo-map-pincentre" aria-label="Put the delivery pin at the centre of the map">+ Pin the centre</button>';
  const [recentre, pinCentre] = lower.querySelectorAll('button');
  map.controls[ControlPosition.LEFT_BOTTOM].push(lower);
  const cross = document.createElement('div');
  cross.className = 'echo-map-cross';
  cross.setAttribute('aria-hidden', 'true');
  el.append(cross);

  const num = (v) => (typeof v === 'function' ? v() : v);
  function sync({ pin: at = null, pinStatus = 'ok', selectedId = null, live = null } = {}) {
    if (at) {
      if (tapped) { tapped.position = { lat: at.lat, lng: at.lng }; tapped.content = pinEl(pinStatus); } else {
        /* Draggable: a phone's reading or a first tap is rarely exactly the spot. */
        tapped = new AdvancedMarkerElement({ map, position: { lat: at.lat, lng: at.lng }, content: pinEl(pinStatus),
          gmpDraggable: true, title: 'Your delivery spot', zIndex: 100 });
        tapped.addListener('dragend', () => { const p = tapped.position; onTap?.(num(p.lat), num(p.lng)); });
      }
    } else if (tapped) { tapped.map = null; tapped = null; }
    for (const { g, m } of markers) m.content = destEl(g, Boolean(selectedId && g.ids.includes(selectedId)));
    if (live && Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
      lastLive = live;
      const c = { lat: live.lat, lng: live.lng };
      if (!liveDot) {
        liveRing = new Circle({ map, center: c, radius: live.accuracy || 0, clickable: false,
          strokeColor: '#2563EB', strokeOpacity: 0.5, strokeWeight: 1, fillColor: '#2563EB', fillOpacity: 0.12 });
        const d = document.createElement('div');
        d.className = 'eg-live';
        liveDot = new AdvancedMarkerElement({ map, position: c, content: d, zIndex: 50 });
      } else { liveDot.position = c; liveRing.setCenter(c); liveRing.setRadius(live.accuracy || 0); }
      liveDot.title = `Your phone, roughly (±${Math.round(live.accuracy || 0)} m)`;
      recentre.style.display = '';
    } else {
      lastLive = null;
      if (liveDot) { liveDot.map = null; liveRing.setMap(null); liveDot = null; liveRing = null; }
      recentre.style.display = 'none';
    }
  }
  const zoomTo = (p) => { map.panTo(p); if (map.getZoom() < 17) map.setZoom(17); };
  function focusLive() { if (lastLive) zoomTo({ lat: lastLive.lat, lng: lastLive.lng }); }
  const focusPin = (at) => { if (at) zoomTo({ lat: at.lat, lng: at.lng }); };
  recentre.addEventListener('click', (e) => { e.stopPropagation(); focusLive(); });
  pinCentre.addEventListener('click', (e) => { e.stopPropagation(); const c = map.getCenter(); onTap?.(c.lat(), c.lng()); });

  /* A tap on the map itself (not a marker or control) is the student's own point. */
  map.addListener('click', (e) => { if (e.latLng) onTap?.(e.latLng.lat(), e.latLng.lng()); });
  map.fitBounds(bounds, 16);
  sync(state);

  const toGoogle = { default: 'roadmap', satellite: 'hybrid' };
  return {
    map,
    sync,
    refresh: () => {},   // Google re-measures its container itself
    setBase: (name) => { if (toGoogle[name]) map.setMapTypeId(toGoogle[name]); return name; },
    base: () => (map.getMapTypeId() === 'roadmap' ? 'default' : 'satellite'),
    focusLive,
    focusPin,
    destroy: () => { for (const { m } of markers) m.map = null; if (tapped) tapped.map = null; },
    markers: groups,
    provider: 'google',
  };
}

function injectPickerStyles() {
  if (document.getElementById('echo-gpick-css')) return;
  const st = document.createElement('style');
  st.id = 'echo-gpick-css';
  st.textContent = `
  .eg-dest{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#2F7D5F;border:3px solid #fff;
    box-shadow:0 1px 5px rgba(0,0,0,.4);color:#fff;font:800 11px/1 system-ui,sans-serif;cursor:pointer}
  .eg-dest.sel{background:#1F5E46;width:28px;height:28px;box-shadow:0 0 0 4px rgba(47,125,95,.35),0 1px 5px rgba(0,0,0,.4)}
  .eg-tag.up{top:auto;bottom:28px}
  .eg-spot{width:38px;height:38px;cursor:grab;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
  .eg-spot svg{width:38px;height:38px;fill:#E0567A;stroke:#fff;stroke-width:1.5}
  .eg-spot.refused svg{fill:#8A817C}.eg-spot.checking svg{opacity:.6}
  .eg-live{width:16px;height:16px;border-radius:50%;background:#2563EB;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)}`;
  document.head.append(st);
}
