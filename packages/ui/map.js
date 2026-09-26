/* ==========================================================================
   ECHO ECHO — CAMPUS MAP

   OpenStreetMap tiles drawn with Leaflet. No Google Maps, no API key, no
   billing account, and nothing scraped: OSM tiles are served under the Open
   Database Licence and the attribution below is the condition of using them.

   The map draws only what the SERVER sent. It has no coordinates of its own
   and never guesses one: if a cafeteria or a delivery point has no surveyed
   position, it is absent from the map and the screen says so in words. That
   is the whole reason this file takes a `tracking` payload rather than an
   address — /orders/:id/tracking has already decided what this viewer may
   see, including whether the delivery partner's position is disclosed.

   Leaflet is fetched from a CDN on first use and never bundled, so a screen
   without a map costs nothing. If the CDN is unreachable the map degrades to
   a plain list of the same places, which is the information that mattered.
   ========================================================================== */

const LEAFLET_VERSION = '1.9.4';
const CDN = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}`;

/* Subresource Integrity. A third party serves this script into a page that
   holds the student's session, so "whatever the CDN sends today" is not an
   acceptable answer: a compromised or substituted file would run with full
   access to the surface. The browser hashes the bytes and refuses to execute
   anything that does not match, which turns a CDN compromise into the same
   outcome as the CDN being down - and that case is already handled, because
   onerror degrades the map to the plain list of the same places.
   These values are cdnjs's published SRI for 1.9.4, re-derived from the
   fetched bytes independently. Both must be updated together with the
   version above, or the map will simply stop loading. */
const SRI = {
  js: 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==',
  css: 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==',
};

let leafletPromise = null;

/* One load, shared by every map on the page. */
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${CDN}/leaflet.min.css`;
    css.integrity = SRI.css;
    /* SRI needs a CORS-enabled fetch; without this the browser cannot read
       the bytes to hash them and blocks the resource outright. */
    css.crossOrigin = 'anonymous';
    css.referrerPolicy = 'no-referrer';
    document.head.append(css);

    const js = document.createElement('script');
    js.src = `${CDN}/leaflet.min.js`;
    js.integrity = SRI.js;
    js.crossOrigin = 'anonymous';
    js.referrerPolicy = 'no-referrer';
    js.async = true;
    js.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet did not load')));
    /* Also fires when the integrity check fails, so a substituted file lands
       on the same degraded path as an unreachable CDN. */
    js.onerror = () => reject(new Error('Could not load the map library'));
    document.head.append(js);
  }).catch((e) => { leafletPromise = null; throw e; });
  return leafletPromise;
}

/* ---------- the tiles ------------------------------------------------------
   OpenStreetMap's own tile server, under its tile usage policy
   (https://operations.osmfoundation.org/policies/tiles/):

   - the documented HTTPS URL, tile.openstreetmap.org/{z}/{x}/{y}.png;
   - "© OpenStreetMap contributors" visible on the map, linked to the
     copyright page (Leaflet's attribution control, never hidden);
   - a Referer on every tile request. This is what broke the maps: the site
     sends `Referrer-Policy: no-referrer` on every page (so an order or
     session URL never leaks to a third party), which stripped the Referer
     from the tile images too, and OSM answers a browser tile request without
     one with its "Access blocked" image. The tile images alone opt back in
     with `strict-origin-when-cross-origin`, the browser's normal default:
     OSM receives only the site's origin (https://<host>/), never a path;
   - the browser's normal HTTP cache, honouring OSM's Cache-Control. No
     cache-busting parameters, no no-cache headers, no prefetching or bulk
     download, no retry loop: a tile that fails stays failed until the
     student pans back to it;
   - maxZoom 19, the deepest zoom OSM serves.

   The picker also limits panning to around the campus (maxBounds), so a
   session loads the few dozen tiles of one campus rather than wandering. */
export const OSM_TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  options: {
    maxZoom: 19,
    referrerPolicy: 'strict-origin-when-cross-origin',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};
const osmTiles = (L) => L.tileLayer(OSM_TILES.url, OSM_TILES.options);

/* A round pin, drawn in CSS rather than fetched as an image, so the map has
   no second network dependency and matches the product's palette. */
const pin = (L, colour, glyph, title) => L.divIcon({
  className: 'echo-pin-wrap',
  html: `<span class="echo-pin" style="--pin:${colour}" title="${escapeText(title)}">${escapeText(glyph)}</span>`,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

const PLACES = {
  pickup: { colour: '#1C1917', glyph: '🍴', label: 'Pick-up' },
  destination: { colour: '#E0567A', glyph: '📍', label: 'Delivering to' },
  partner: { colour: '#2F7D5F', glyph: '🛵', label: 'Your delivery partner' },
};

/**
 * Draw a tracking payload into `el`.
 *
 * @param el        the container element
 * @param tracking  the body of GET /orders/:id/tracking
 * @param opts.self optional { lat, lng } for "you are here" on the partner's
 *                  own screen — never sent anywhere by this function
 */
export async function drawTrackingMap(el, tracking, { self = null } = {}) {
  const points = [];
  if (tracking.pickup) points.push({ ...tracking.pickup, kind: 'pickup' });
  if (tracking.destination) points.push({ ...tracking.destination, kind: 'destination' });
  if (tracking.partner) points.push({ ...tracking.partner, kind: 'partner', name: 'Delivery partner' });
  if (self) points.push({ ...self, kind: 'partner', name: 'You' });

  if (!points.length) {
    el.innerHTML = `<div class="map-empty">
      <p class="t-sm muted">${escapeText(tracking.note
        || 'There is nothing to show on a map for this order yet.')}</p></div>`;
    return null;
  }

  let L;
  try {
    L = await loadLeaflet();
  } catch {
    /* No map library. Show the same places as text — the point was where
       things are, not that there be a picture of it. */
    el.innerHTML = `<div class="map-empty stack g2">
      <p class="t-sm muted">The map could not load. The places on this delivery are:</p>
      <ul class="t-sm" style="margin:0;padding-left:18px">
        ${points.map((p) => `<li>${escapeText(PLACES[p.kind].label)}: ${escapeText(p.name || '—')}</li>`).join('')}
      </ul></div>`;
    return null;
  }

  el.innerHTML = '';
  el.classList.add('echo-map');
  const map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });

  osmTiles(L).addTo(map);

  /* The confirmed campus outline, so it is obvious this is a campus-only
     service and where its edge is. */
  if (tracking.boundary?.polygon?.length) {
    L.polygon(tracking.boundary.polygon, {
      color: '#E0567A', weight: 1.5, opacity: 0.7, fillOpacity: 0.05, dashArray: '5,5',
    }).addTo(map).bindTooltip(tracking.boundary.name || 'Campus');
  }

  for (const p of points) {
    const spec = PLACES[p.kind];
    L.marker([p.lat, p.lng], { icon: pin(L, spec.colour, spec.glyph, spec.label) })
      .addTo(map)
      .bindPopup(`<b>${escapeText(spec.label)}</b><br>${escapeText(p.name || '')}`);
  }

  /* A straight line between the two ends of the journey. It is deliberately
     not a routed path: ECHO ECHO has no routing data for footpaths inside a
     campus, and drawing a road route across a quadrangle would be a
     confident picture of something untrue. */
  if (tracking.pickup && tracking.destination) {
    L.polyline([[tracking.pickup.lat, tracking.pickup.lng],
                [tracking.destination.lat, tracking.destination.lng]],
      { color: '#1C1917', weight: 2, opacity: 0.35, dashArray: '6,6' }).addTo(map);
  }

  const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
  if (points.length === 1) map.setView(bounds.getCenter(), 17);
  else map.fitBounds(bounds, { padding: [34, 34], maxZoom: 18 });

  /* Leaflet measures the container on creation; inside a screen that was
     still laying out, that measurement is wrong until the next frame. */
  requestAnimationFrame(() => map.invalidateSize());
  return map;
}

/**
 * Campus Control's map: every campus place the server holds a position for,
 * and every boundary outline, on OpenStreetMap.
 *
 * Nothing is placed that the server did not position. A place without lat/lng
 * is counted and named below the map instead - that includes every room,
 * because a door-plate photo records where the photographer stood in the
 * corridor, not where the room is. Pending places are drawn hollow so a
 * candidate cannot be mistaken for a confirmed hand-over point.
 *
 * @param el          the container element
 * @param nodes       GET /campus/tree nodes
 * @param boundaries  GET /admin/campuses/:id/boundaries (optional)
 */
export async function drawCampusMap(el, { nodes = [], boundaries = [] } = {}) {
  const placed = nodes.filter((n) => Number.isFinite(Number(n.lat)) && Number.isFinite(Number(n.lng))
    && n.lat !== null && n.lng !== null);
  const outlines = boundaries.filter((b) => b.status !== 'retired' && b.polygon?.length >= 3);
  if (!placed.length && !outlines.length) {
    el.innerHTML = `<div class="map-empty"><p class="t-sm muted">No campus place has a recorded position yet,
      and there is no boundary outline to draw.</p></div>`;
    return null;
  }
  let L;
  try {
    L = await loadLeaflet();
  } catch {
    el.innerHTML = `<div class="map-empty"><p class="t-sm muted">The map could not load.
      ${placed.length} place(s) have a recorded position; they are listed under Locations.</p></div>`;
    return null;
  }
  el.innerHTML = '';
  el.classList.add('echo-map');
  const map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  osmTiles(L).addTo(map);

  const bounds = [];
  for (const b of outlines) {
    const active = b.status === 'active';
    L.polygon(b.polygon, {
      color: active ? '#2F7D5F' : '#E0567A', weight: active ? 2 : 1.5, opacity: 0.8,
      fillOpacity: active ? 0.08 : 0.03, dashArray: active ? null : '6,5',
    }).addTo(map).bindTooltip(`${b.name} · ${active ? 'active boundary' : `${b.status}, not in force`}`);
    bounds.push(...b.polygon);
  }
  for (const n of placed) {
    const confirmed = n.verification === 'confirmed';
    L.circleMarker([Number(n.lat), Number(n.lng)], {
      radius: 7, weight: 2, color: confirmed ? '#2F7D5F' : '#B45309',
      fillColor: confirmed ? '#2F7D5F' : '#FFFFFF', fillOpacity: confirmed ? 0.85 : 0.9,
    }).addTo(map).bindPopup(`<b>${escapeText(n.name)}</b><br>${confirmed ? 'Confirmed' : 'Pending — not deliverable'}`
      + `${n.gps_accuracy_m ? ` · ±${escapeText(n.gps_accuracy_m)} m` : ''}`
      + `${n.source_note ? `<br><span style="font-size:11px">${escapeText(n.source_note)}</span>` : ''}`);
    bounds.push([Number(n.lat), Number(n.lng)]);
  }
  map.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom: 18 });
  requestAnimationFrame(() => map.invalidateSize());
  return map;
}

/* Delivery points closer together than this are drawn as ONE marker naming
   all of them. The Enrollment Office and The HUBBLE were recorded 12 m
   apart: as two pins they sit on top of each other at campus zoom and read
   as one unexplained dot. One marker, both names, is the honest picture. */
export const GROUP_WITHIN_M = 30;

const metres = (a, b) => {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

/**
 * Exactly the markers the student's picker draws for the destinations the
 * server sent: one per group of points within GROUP_WITHIN_M, placed at the
 * group's mean position and named after every member. Nothing else - no
 * room, no pending place, no field-photo reading - can appear, because
 * nothing else is in `destinations` (GET /campus/map sends only eligible
 * ones). Pure, so it is tested without a browser.
 */
export function destinationMarkers(destinations = []) {
  const groups = [];
  for (const d of destinations) {
    if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) continue;
    const g = groups.find((x) => x.members.some((m) => metres(m, d) <= GROUP_WITHIN_M));
    if (g) g.members.push(d); else groups.push({ members: [d] });
  }
  const out = groups.map(({ members }) => ({
    ids: members.map((m) => m.id),
    names: members.map((m) => m.name),
    label: members.map((m) => m.name).join(' · '),
    lat: members.reduce((t, m) => t + m.lat, 0) / members.length,
    lng: members.reduce((t, m) => t + m.lng, 0) / members.length,
    labelSide: 'top',
  }));
  /* Labels are always shown (a phone has no hover), so two markers side by
     side must not stack their labels on one line: going west to east, a
     marker whose western neighbour is close and level with it puts its label
     underneath instead. */
  const ordered = [...out].sort((a, b) => a.lng - b.lng);
  for (const [i, g] of ordered.entries()) {
    const clash = ordered.slice(0, i).some((w) => w.labelSide === 'top'
      && Math.abs(g.lat - w.lat) * 111_320 < 80
      && Math.abs(g.lng - w.lng) * 111_320 * Math.cos((g.lat * Math.PI) / 180) < 250);
    if (clash) g.labelSide = 'bottom';
  }
  return out;
}

/**
 * The student's delivery picker: the active campus outline, the confirmed
 * delivery points, the spot they tapped, and - only once the server has
 * accepted a live reading - where they are.
 *
 * A tap is only reported to `onTap(lat, lng)`; this function decides nothing.
 * The caller sends the point to the server (POST /campus/pin), which alone
 * says whether it is on campus and which delivery points are near it, and
 * then tells the map how the pin fared with sync(). Tapping outside the
 * outline is still reported: the server's refusal is what the student sees,
 * not a check made here that a modified page could skip.
 *
 * Returns a controller, so the page can update the map in place instead of
 * rebuilding it (and losing the student's zoom) on every change:
 *   sync({ pin, pinStatus, selectedId, live })
 *     pin        { lat, lng } or null - the student's tapped spot
 *     pinStatus  'checking' | 'ok' | 'refused'
 *     selectedId the chosen destination's id, highlighted
 *     live       { lat, lng, accuracy } of an ACCEPTED live reading, or null
 *   refresh()    re-measure after the container moved or resized
 *   destroy()
 *
 * @param el   the container element
 * @param data GET /campus/map: { boundary: { name, polygon, center }, destinations }
 */
export async function drawPickerMap(el, data, { onTap, ...state } = {}) {
  if (!data?.boundary?.polygon?.length) {
    el.innerHTML = `<div class="map-empty"><p class="t-sm muted">The campus map is not available yet.</p></div>`;
    return null;
  }
  let L;
  try {
    L = await loadLeaflet();
  } catch {
    el.innerHTML = `<div class="map-empty"><p class="t-sm muted">The map could not load. Choose a delivery point from the list below instead.</p></div>`;
    return null;
  }
  el.innerHTML = '';
  el.classList.add('echo-map');
  const map = L.map(el, {
    zoomControl: true, attributionControl: true, scrollWheelZoom: false,
    /* The map opens on the campus, never on the browser's idea of where the
       student is: the middle of the active outline first, then fitted to it. */
    center: data.boundary.center || data.boundary.polygon[0], zoom: 16,
  });
  osmTiles(L).addTo(map);

  const outline = L.polygon(data.boundary.polygon, {
    color: '#E0567A', weight: 2, opacity: 0.9, fillColor: '#E0567A', fillOpacity: 0.07, dashArray: '6,5',
    interactive: false,
  }).addTo(map);

  const groups = destinationMarkers(data.destinations);
  const markers = groups.map((g) => {
    const m = L.marker([g.lat, g.lng], {
      icon: pin(L, '#2F7D5F', g.ids.length > 1 ? String(g.ids.length) : '🍴', g.label),
      keyboard: true, title: g.label, riseOnHover: true,
    }).addTo(map)
      .bindTooltip(escapeText(g.label), { permanent: true, direction: g.labelSide,
        offset: g.labelSide === 'top' ? [0, -16] : [0, 16], className: 'echo-map-label' })
      .on('click', () => onTap?.(g.lat, g.lng));
    return { g, m };
  });

  let tapped = null, liveDot = null, liveRing = null;
  const PIN_LOOK = {
    checking: { colour: '#8A817C', glyph: '…', label: 'Checking this spot' },
    ok: { colour: '#E0567A', glyph: '📍', label: 'Your spot' },
    refused: { colour: '#8A817C', glyph: '✕', label: 'Outside the campus delivery area' },
  };
  const pinIcon = (status) => {
    const look = PIN_LOOK[status] || PIN_LOOK.ok;
    return pin(L, look.colour, look.glyph, look.label);
  };

  function sync({ pin: at = null, pinStatus = 'ok', selectedId = null, live = null } = {}) {
    if (at) {
      if (tapped) tapped.setLatLng([at.lat, at.lng]).setIcon(pinIcon(pinStatus));
      else tapped = L.marker([at.lat, at.lng], { icon: pinIcon(pinStatus), zIndexOffset: 1000, keyboard: false }).addTo(map);
    } else if (tapped) {
      tapped.remove(); tapped = null;
    }
    for (const { g, m } of markers) {
      const chosen = selectedId && g.ids.includes(selectedId);
      m.setIcon(pin(L, chosen ? '#E0567A' : '#2F7D5F',
        chosen ? '✓' : g.ids.length > 1 ? String(g.ids.length) : '🍴', g.label));
    }
    /* Where the student is: drawn only from a reading the server accepted,
       with its accuracy as a circle, so a ±20 m fix is not shown as a point. */
    if (live && Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
      if (liveDot) {
        liveDot.setLatLng([live.lat, live.lng]);
        liveRing.setLatLng([live.lat, live.lng]).setRadius(live.accuracy || 0);
      } else {
        liveRing = L.circle([live.lat, live.lng], { radius: live.accuracy || 0, color: '#2563EB', weight: 1,
          opacity: 0.5, fillColor: '#2563EB', fillOpacity: 0.12, interactive: false }).addTo(map);
        liveDot = L.circleMarker([live.lat, live.lng], { radius: 7, color: '#FFFFFF', weight: 3,
          fillColor: '#2563EB', fillOpacity: 1, interactive: false }).addTo(map);
      }
    } else if (liveDot) {
      liveDot.remove(); liveRing.remove(); liveDot = liveRing = null;
    }
  }

  map.on('click', (e) => onTap?.(e.latlng.lat, e.latlng.lng));

  const bounds = outline.getBounds();
  map.fitBounds(bounds, { padding: [16, 16], maxZoom: 18 });
  /* Keep the view on campus: a little room to pan around the edge, and no
     zooming out to the whole district. */
  map.setMaxBounds(bounds.pad(0.6));
  map.setMinZoom(Math.max(14, map.getZoom() - 1));
  sync(state);

  const refresh = () => map.invalidateSize();
  /* Leaflet measures the container on creation; inside a sheet that is
     still sliding in, that measurement is wrong until the next frame. */
  requestAnimationFrame(refresh);
  return { map, sync, refresh, destroy: () => map.remove(), markers: groups };
}

/** What to tell someone when there is no partner marker. */
export const partnerVisibilityNote = (v) => ({
  no_partner_yet: 'No delivery partner has picked this up yet.',
  hidden_until_pickup: 'You will see your partner on the map once they have collected your order.',
  not_reported_yet: 'Your partner has collected the order. Their position will appear shortly.',
  visible: null,
}[v] ?? null);

const escapeText = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
