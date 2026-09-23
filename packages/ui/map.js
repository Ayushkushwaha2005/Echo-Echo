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

/* A round pin, drawn in CSS rather than fetched as an image, so the map has
   no second network dependency and matches the product's palette. */
const pin = (L, colour, glyph, title) => L.divIcon({
  className: 'echo-pin-wrap',
  html: `<span class="echo-pin" style="--pin:${colour}" title="${title}">${glyph}</span>`,
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

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    /* Required by the OSM tile usage policy. */
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

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
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

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

/** What to tell someone when there is no partner marker. */
export const partnerVisibilityNote = (v) => ({
  no_partner_yet: 'No delivery partner has picked this up yet.',
  hidden_until_pickup: 'You will see your partner on the map once they have collected your order.',
  not_reported_yet: 'Your partner has collected the order. Their position will appear shortly.',
  visible: null,
}[v] ?? null);

const escapeText = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
