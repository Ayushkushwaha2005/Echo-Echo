/* ==========================================================================
   ECHO ECHO — A MODULE THAT LOADS AFTER THE PAGE

   The build preloads every module a page can import (build.mjs), so a
   screen that opens the map later finds it already in the page, fetched
   from the same deployment as the page. This is the answer for the one case
   preloading cannot cover: the preload itself failed, and by the time the
   screen asks again a deploy has replaced the page's /_v/<hash>/ assets.

   Nothing is retried from another deployment: an old page running a new
   module is exactly the mix that must not happen. The error says what is
   true instead - this page is older than the site - and anything else is
   rethrown untouched, so a genuine failure is never relabelled.
   ========================================================================== */

export class StaleDeployment extends Error {
  constructor(pageVersion, liveVersion) {
    super('ECHO ECHO was updated while this page was open, so this part of it can no longer load. '
      + 'Reload the page to use the new version.');
    this.name = 'StaleDeployment';
    this.pageVersion = pageVersion;
    this.liveVersion = liveVersion;
  }
}

/* The content hash of the build a module URL belongs to: dist/_v/<hash>/. */
export function versionOf(url) {
  return /\/_v\/([0-9a-f]{12})\//.exec(String(url || ''))?.[1] || null;
}

/**
 * `load` is the caller's own arrow function around a dynamic import of a
 * literal relative path, so the build can see (and preload) the specifier. `pageUrl` is the caller's
 * import.meta.url, which names the build the page came from.
 */
export async function loadModule(load, pageUrl, { fetchImpl = globalThis.fetch } = {}) {
  try {
    return await load();
  } catch (e) {
    const mine = versionOf(pageUrl);
    if (!mine || typeof fetchImpl !== 'function') throw e;
    let live = null;
    try {
      const r = await fetchImpl('/version.json', { cache: 'no-store', credentials: 'same-origin' });
      if (r.ok) live = (await r.json())?.version || null;
    } catch { /* the original error is the one worth showing */ }
    if (live && live !== mine) throw new StaleDeployment(mine, live);
    throw e;
  }
}
