/* ==========================================================================
   CAMPUS CONTROL'S LIVE CHECK (GET /admin/changes, server/src/routes/live.js)

   * A stamp moves when that area's records change, by whoever changed them:
     a café closed (the counter), a dish edited, an order placed and moved
     on (the student site), a draft saved, a verification decided.
   * It does not move when nothing changed, so an idle page is not reloaded.
   * An administrator gets only the areas their permissions read; a student
     or a signed-out caller gets nothing; the answer is never cached.
   * The unread count is mine, and moves with my notifications.
   Synthetic accounts only.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem } from './helpers/db.mjs';
import { makeApp, client, sessionFor } from './helpers/api.mjs';

process.env.ADMIN_PASSKEY_REQUIRED = 'true';
let app, pool, defaults;
let nth = 0;
const phone = () => `+9196300${String(10000 + nth++).slice(-5)}`;
const as = async (u, method = 'admin_totp') => client(app, await sessionFor(pool, u.id, { method }));

before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.live@stu.upes.ac.in';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  ({ defaults } = await import('../src/services/site-config.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE admin_account');
});

const stamps = async (c) => {
  const r = await c.get('/admin/changes');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

test('each stamp moves with its own records, and only then', async () => {
  const owner = await makeUser(pool, { phone: phone(), name: 'Owner Live', roles: ['platform_owner'] });
  const student = await makeUser(pool, { phone: phone(), name: 'Student Live' });
  const v = await makeVendor(pool, { name: 'Live Café', slug: 'live-cafe' });
  const dish = await makeItem(pool, v.id, { name: 'Maggi', paise: 6000 });
  const c = await as(owner);

  const s0 = await stamps(c);
  assert.deepEqual(Object.keys(s0.stamps).sort(), ['cafes', 'menu', 'orders', 'partners', 'site', 'users']);
  assert.ok(!Number.isNaN(Date.parse(s0.at)));
  assert.deepEqual((await stamps(c)).stamps, s0.stamps, 'nothing changed: nothing moves');

  const moved = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]).sort();

  /* The counter closes the café. */
  await pool.query(`UPDATE vendor SET is_open = false WHERE id = $1`, [v.id]);
  const s1 = await stamps(c);
  assert.deepEqual(moved(s0.stamps, s1.stamps), ['cafes']);

  /* A dish goes out of stock. */
  await pool.query(`UPDATE menu_item SET available = false WHERE id = $1`, [dish.id]);
  const s2 = await stamps(c);
  assert.deepEqual(moved(s1.stamps, s2.stamps), ['menu']);

  /* A student places an order, and it moves on. */
  const o = (await pool.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise)
     VALUES ('LIVE1', $1, $2, 'pickup', 'awaiting_payment', 6000, 6000) RETURNING id`, [student.id, v.id])).rows[0];
  await pool.query(`INSERT INTO order_event (order_id, from_state, to_state, actor_role) VALUES ($1, NULL, 'awaiting_payment', 'student')`, [o.id]);
  const s3 = await stamps(c);
  assert.deepEqual(moved(s2.stamps, s3.stamps), ['orders']);
  await pool.query(`UPDATE food_order SET state = 'confirmed' WHERE id = $1`, [o.id]);
  await pool.query(`INSERT INTO order_event (order_id, from_state, to_state, actor_role) VALUES ($1, 'awaiting_payment', 'confirmed', 'system')`, [o.id]);
  const s4 = await stamps(c);
  assert.deepEqual(moved(s3.stamps, s4.stamps), ['orders'], 'a state change moves it too');

  /* Website draft saved through the real API. */
  const cfg = defaults(); cfg.hero.heading = 'Live check heading';
  assert.equal((await c.put('/admin/site/draft', { config: cfg, revision: 0 })).status, 200);
  const s5 = await stamps(c);
  assert.deepEqual(moved(s4.stamps, s5.stamps), ['site']);

  /* A new student signs up. */
  await makeUser(pool, { phone: phone(), name: 'Another Student' });
  const s6 = await stamps(c);
  assert.deepEqual(moved(s5.stamps, s6.stamps), ['users']);
});

test('the unread count is mine and follows my notifications', async () => {
  const owner = await makeUser(pool, { phone: phone(), name: 'Owner Live', roles: ['platform_owner'] });
  const other = await makeUser(pool, { phone: phone(), name: 'Other Admin', roles: ['platform_owner'] });
  const c = await as(owner);
  assert.equal((await stamps(c)).unread, 0);
  for (const u of [owner, owner, other]) {
    await pool.query(`INSERT INTO notification (user_id, kind, channel, title, state) VALUES ($1, 'order_ready', 'inapp', 'Hi', 'sent')`, [u.id]);
  }
  assert.equal((await stamps(c)).unread, 2);
  assert.equal((await c.post('/notifications/read', {})).status, 200);
  assert.equal((await stamps(c)).unread, 0);
});

test('permissions decide which areas are reported; nobody else gets an answer', async () => {
  const editor = await makeUser(pool, { phone: phone(), name: 'Editor', roles: ['platform_admin'] });
  await pool.query(`INSERT INTO admin_account (user_id, status, permissions, activated_at) VALUES ($1,'active',$2,now())`,
    [editor.id, ['cafeterias.view', 'website.customize']]);
  const r = await stamps(await as(editor));
  assert.deepEqual(Object.keys(r.stamps).sort(), ['cafes', 'site'], 'only what this administrator may read');

  const owner = await makeUser(pool, { phone: phone(), name: 'Owner Live', roles: ['platform_owner'] });
  const res = await (await as(owner)).get('/admin/changes');
  assert.equal(res.headers['cache-control'], 'private, no-store');

  const student = await makeUser(pool, { phone: phone(), name: 'Student Live' });
  assert.equal((await (await as(student, 'code')).get('/admin/changes')).status, 403);
  /* A platform role on an email-code session is withheld, so it is no admin here. */
  assert.equal((await (await as(owner, 'code')).get('/admin/changes')).status, 403);
  assert.equal((await client(app, null).get('/admin/changes')).status, 401);
});
