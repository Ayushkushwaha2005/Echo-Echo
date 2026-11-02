/* ==========================================================================
   ECHO ECHO — FOLLOWING A LIVE STREAM

   A stream only says "something moved, look now". This never carries a record,
   and nothing depends on it: every caller keeps its own polling. If the server
   answers 204 (streams off), or the browser or a proxy cannot hold the
   connection, the browser gives up or retries by itself and the page simply
   keeps polling.

   Returns a function that stops following.
   ========================================================================== */
import { API_BASE } from './client.js';

export function followChanges(path, onEvent, { events = ['change'], EventSourceImpl = globalThis.EventSource } = {}) {
  if (typeof EventSourceImpl !== 'function') return () => {};
  let es;
  try {
    es = new EventSourceImpl(`${API_BASE}${path}`, { withCredentials: true });
  } catch { return () => {}; }
  const handler = (e) => {
    let data = null;
    try { data = JSON.parse(e.data); } catch { /* an event without a body still means look now */ }
    onEvent(data, e.type);
  };
  for (const name of events) es.addEventListener(name, handler);
  return () => es.close();
}
