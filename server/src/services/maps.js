/* ==========================================================================
   ECHO ECHO — WHICH MAP A SCREEN DRAWS

   Google Maps for the delivery partner's screen and Campus Control's fleet
   map, when GOOGLE_MAPS_BROWSER_KEY is set; otherwise the OpenStreetMap map
   in packages/ui/map.js, exactly as before.

   The browser key is not a secret: Google requires it in the page, and it is
   locked in Google Cloud to the Maps JavaScript API and to ECHO ECHO's own
   websites. It is still kept out of the source and the build, alongside the
   other optional map key (ARCGIS_BASEMAP_TOKEN, services/campus.js), so it
   can be rotated in one place. The Routes key (GOOGLE_ROUTES_API_KEY) never
   leaves the server.

   GOOGLE_MAPS_MAP_ID is the Map ID that Advanced Markers require; Google's
   public DEMO_MAP_ID is used when none is configured.
   ========================================================================== */
export function mapsConfig(env = process.env) {
  const key = String(env.GOOGLE_MAPS_BROWSER_KEY || '').trim();
  if (!key) return { provider: 'osm' };
  return { provider: 'google', browserKey: key, mapId: String(env.GOOGLE_MAPS_MAP_ID || '').trim() || 'DEMO_MAP_ID' };
}
