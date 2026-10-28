/* ==========================================================================
   ECHO ECHO — WHERE CHANGES MAY BE MADE FROM

   The server accepts a signed-in change only from the origins in its
   WEB_ORIGIN (render.yaml); everything else is refused with 403 "Cross-
   origin request rejected". Every Vercel deployment also has its own
   address (echo-echo-<id>-….vercel.app). A production build opened there
   shows live data but can save nothing, which is how a display-name save
   failed on 28 Oct 2026.

   build.mjs writes each surface's config.js from this file:
     · QUAD_DEPLOY = { env, canonical, writeHosts } for the page to read
       (host names, not URLs: they are compared, never fetched)
     · for Campus Control and the counter, in a PRODUCTION deployment only:
       an address that is not on the list is sent to the same page on the
       canonical address before anything loads. A preview stays where it
       is (it must not become production), and says plainly that it cannot
       change live data when a save is refused (packages/data/client.js).
   The student site is left exactly as it is.
   ========================================================================== */

/* The address the owner and staff use. echoecho.tech answers with a 308 to it. */
export const CANONICAL_ORIGIN = 'https://www.echoecho.tech';
export const REDIRECT_SURFACES = ['admin', 'shop'];

/** The WEB_ORIGIN list from render.yaml, the same value production runs. */
export function writeOrigins(renderYaml) {
  const v = /^\s*- key: WEB_ORIGIN[ \t]*\r?\n[ \t]*value: *(\S+)/m.exec(renderYaml)?.[1];
  if (!v) throw new Error('render.yaml has no WEB_ORIGIN value');
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/* Runs first on the page (a classic script, before the module entry). */
const REDIRECT = `(function (d) {
  /* A production build on an address the server does not accept changes
     from (a deployment's own *.vercel.app URL): open the same page on the
     ECHO ECHO address instead, before anything loads. */
  if (d.env === 'production' && (location.protocol !== 'https:' || d.writeHosts.indexOf(location.host) < 0)) {
    location.replace(d.canonical + location.pathname + location.search + location.hash);
  }
})(window.QUAD_DEPLOY);
`;

/** The text of <surface>/config.js. */
export function configJs({ apiBase, surface, env, origins, canonical = CANONICAL_ORIGIN }) {
  const deploy = { env: env || 'local', canonical, writeHosts: origins.map((o) => new URL(o).host) };
  return `/* Written by build.mjs. Nothing secret is ever placed here. */
window.QUAD_API_BASE = ${JSON.stringify(apiBase)};
window.QUAD_DEPLOY = ${JSON.stringify(deploy)};
${REDIRECT_SURFACES.includes(surface) ? REDIRECT : ''}`;
}
