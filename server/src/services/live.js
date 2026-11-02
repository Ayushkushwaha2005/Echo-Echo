/* ==========================================================================
   ECHO ECHO - LIVE NOTIFICATIONS (Server-Sent Events)

   A stream says THAT something changed, never what. Clients refetch through
   the same authorised APIs they always used, and keep polling as a fallback,
   so a stream that dies costs a few seconds of freshness and nothing else.

   Off unless LIVE_STREAMS_ENABLED=true: an open stream keeps a free instance
   awake, and whether the Vercel proxy passes a long response has not been
   measured. While off, the stream routes answer 204, which tells a browser's
   EventSource to stop retrying, and everything keeps working by polling.

   In-process fan-out, enough for one instance. change_event is the source of
   truth, so a second instance would still see every change through its own poll.
   ========================================================================== */
import { q } from '../db/index.js';

export const HEARTBEAT_MS = 25_000;
export const POLL_MS = 2_000;
export const MAX_STREAMS = 500;
export const MAX_STREAMS_PER_PEER = 20;

export const streamsEnabled = () => process.env.LIVE_STREAMS_ENABLED === 'true';

const clients = new Set();
const perPeer = new Map();
let timer = null;
let lastId = null;

const send = (c, event, data, id) => {
  try {
    c.raw.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { closeClient(c); }
};

export function closeClient(c, finalEvent) {
  if (!clients.has(c)) return;
  if (finalEvent) { try { c.raw.write(`event: ${finalEvent}\ndata: {}\n\n`); } catch { /* already gone */ } }
  clients.delete(c);
  clearInterval(c.heartbeat);
  clearInterval(c.recheckTimer);
  const n = (perPeer.get(c.peer) || 1) - 1;
  if (n > 0) perPeer.set(c.peer, n); else perPeer.delete(c.peer);
  try { c.raw.end(); } catch { /* already gone */ }
  if (!clients.size && timer) { clearInterval(timer); timer = null; lastId = null; }
}

export const canOpenStream = (peer) => clients.size < MAX_STREAMS && (perPeer.get(peer) || 0) < MAX_STREAMS_PER_PEER;

async function pollFeed() {
  const wanted = [...clients].filter((c) => c.areas);
  if (!wanted.length) return;
  if (lastId === null) return;   // still reading the starting point
  const { rows } = await q(`SELECT id, area FROM change_event WHERE id > $1 ORDER BY id LIMIT 500`, [lastId]);
  if (!rows.length) return;
  lastId = Number(rows.at(-1).id);
  const latest = new Map(rows.map((r) => [r.area, Number(r.id)]));
  for (const c of wanted) {
    for (const [area, version] of latest) if (c.areas.includes(area)) send(c, 'change', { area, version }, version);
  }
}

/* Opens a stream on a hijacked reply. `recheck`, if given, runs periodically
   and returns false to end the stream: that is how a revoked session or a
   finished delivery loses access while connected. */
export function openStream(req, reply, { areas = null, orderId = null, recheck = null, recheckMs = 15_000, sinceId = null } = {}) {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'private, no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  });
  raw.write(': connected\n\nretry: 5000\n\n');
  const c = { raw, areas, orderId, peer: req.peerKey || req.ip };
  clients.add(c);
  perPeer.set(c.peer, (perPeer.get(c.peer) || 0) + 1);
  c.heartbeat = setInterval(() => { try { raw.write(': keep-alive\n\n'); } catch { closeClient(c); } }, HEARTBEAT_MS);
  c.heartbeat.unref?.();
  if (recheck) {
    c.recheckTimer = setInterval(async () => {
      let ok = false;
      try { ok = await recheck(); } catch { ok = false; }
      if (!ok) closeClient(c, 'end');
    }, recheckMs);
    c.recheckTimer.unref?.();
  }
  req.raw.on('close', () => closeClient(c));
  if (areas && !timer) {
    /* Read the starting point now, not at the first tick: a change in between
       would otherwise be skipped for this client. */
    q(`SELECT coalesce(max(id),0) AS m FROM change_event`).then(({ rows }) => { if (lastId === null) lastId = Number(rows[0].m); }).catch(() => {});
    timer = setInterval(() => { pollFeed().catch(() => {}); }, POLL_MS);
    timer.unref?.();
  }
  /* Catch up a reconnecting client: only area and version, as always. */
  if (areas && sinceId != null) {
    q(`SELECT area, max(id) AS id FROM change_event WHERE id > $1 AND area = ANY($2) GROUP BY area`, [sinceId, areas])
      .then(({ rows }) => { for (const r of rows) send(c, 'change', { area: r.area, version: Number(r.id) }, Number(r.id)); })
      .catch(() => {});
  }
  return c;
}

/* A new position: viewers of this order refetch. No coordinate is ever sent. */
export function publishPosition(orderId) {
  for (const c of clients) if (c.orderId === orderId) send(c, 'position', { orderId });
}

/* Ends every stream following this order. */
export function endOrderStreams(orderId) {
  for (const c of [...clients]) if (c.orderId === orderId) closeClient(c, 'end');
}

export function closeAllStreams() {
  for (const c of [...clients]) closeClient(c);
}

export const liveStats = () => ({ streams: clients.size });
