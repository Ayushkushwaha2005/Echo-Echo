/* ==========================================================================
   NOTIFICATION CENTRE (GET /notifications, POST /notifications/read)

   * The unread count is the server's own count, not the length of a page.
   * Pages are newest first; `before` continues without repeats; `more` says
     whether to offer older ones.
   * Marking one as read touches only that one, and only if it is mine;
     omitting the id marks all of mine; a malformed id is a 400, not a 500.
   Synthetic accounts only.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser } from './helpers/db.mjs';
import { makeApp, client, sessionFor } from './helpers/api.mjs';

let app, pool;
let nth = 0;
const phone = () => `+9196900${String(10000 + nth++).slice(-5)}`;

before(async () => {
  await startDb();
  Object.assign(process.env, { COOKIE_SECRET: 'test-secret-that-is-at-least-32-chars-long', PLATFORM_OWNER_EMAIL: 'owner.notes@stu.upes.ac.in' });
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(() => truncateAll(pool));

async function seed(userId, n) {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO notification (user_id, kind, channel, title, state, created_at)
       VALUES ($1, 'order_ready', 'inapp', $2, 'sent', now() - make_interval(mins => $3))`, [userId, `Notice ${i}`, i]);
  }
}

test('unread count, paging and marking read are the caller\'s own', async () => {
  const me = await makeUser(pool, { phone: phone(), name: 'Me Person' });
  const other = await makeUser(pool, { phone: phone(), name: 'Other Person' });
  await seed(me.id, 23);
  await seed(other.id, 2);
  const c = client(app, await sessionFor(pool, me.id));

  const p1 = (await c.get('/notifications?limit=15')).body;
  assert.equal(p1.notifications.length, 15);
  assert.equal(p1.unread, 23, 'the whole count, not the page');
  assert.equal(p1.more, true);
  assert.equal(p1.notifications[0].title, 'Notice 0', 'newest first');
  const p2 = (await c.get(`/notifications?limit=15&before=${encodeURIComponent(p1.notifications.at(-1).created_at)}`)).body;
  assert.equal(p2.notifications.length, 8);
  assert.equal(p2.more, false);
  const ids = new Set([...p1.notifications, ...p2.notifications].map((n) => n.id));
  assert.equal(ids.size, 23, 'no repeats across pages');

  const theirs = (await pool.query(`SELECT id FROM notification WHERE user_id = $1 LIMIT 1`, [other.id])).rows[0].id;
  assert.equal((await c.post('/notifications/read', { id: theirs })).status, 200);
  assert.equal((await pool.query(`SELECT read_at FROM notification WHERE id = $1`, [theirs])).rows[0].read_at, null, 'not mine: untouched');
  assert.equal((await c.post('/notifications/read', { id: 'not-an-id' })).status, 400);

  assert.equal((await c.post('/notifications/read', { id: p1.notifications[0].id })).status, 200);
  assert.equal((await c.get('/notifications?limit=1')).body.unread, 22);
  assert.equal((await c.post('/notifications/read', {})).status, 200);
  assert.equal((await c.get('/notifications?limit=1')).body.unread, 0);
  const otherUnread = (await pool.query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL`, [other.id])).rows[0].n;
  assert.equal(otherUnread, 2, 'mark all is mine only');
  assert.equal((await client(app).get('/notifications')).status, 401);
});
