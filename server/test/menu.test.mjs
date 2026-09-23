/* ==========================================================================
   MENU MANAGEMENT — categories, archive, delete, open/accepting

   Everything a counter owner or an administrator does to a menu, over real
   HTTP, and everything the wrong person is refused. What a student sees is
   read back through the same public endpoint the student site uses, so
   "created in Counter → visible on the student site, with the server's
   price and availability" is asserted end to end.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool;
let n = 0;
const phone = () => `+9192100${String(++n).padStart(5, '0')}`;

before(async () => {
  await startDb();
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  process.env.COOKIE_SECRET = 'test-secret-that-is-at-least-32-chars-long';
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const anon = () => client(app);
const as = async (u) => client(app, await sessionFor(pool, u.id));

async function outlet(slug = 'frisco') {
  const v = await makeVendor(pool, { name: slug, slug });
  const owner = await makeUser(pool, { phone: phone(), name: 'Owner', roles: ['vendor_owner'], vendorId: v.id });
  const staff = await makeUser(pool, { phone: phone(), name: 'Staff', roles: ['vendor_staff'], vendorId: v.id });
  return { v, owner: await as(owner), staff: await as(staff) };
}

test('owner builds a categorised menu that the student site reads back from the server', async () => {
  const { v, owner } = await outlet();
  const cat = await owner.post(`/vendors/${v.id}/categories`, { name: '  Hot   drinks ' });
  assert.equal(cat.status, 200);
  assert.equal(cat.body.name, 'Hot drinks', 'whitespace is normalised');

  const item = await owner.post(`/vendors/${v.id}/menu`,
    { name: 'Masala tea', price: '15.50', categoryId: cat.body.id, available: true });
  assert.equal(item.status, 200);

  const menu = await anon().get(`/vendors/${v.id}/menu`);
  const seen = menu.body.items.find((i) => i.id === item.body.id);
  assert.equal(seen.price_paise, 1550, 'price comes from the server, in paise');
  assert.equal(seen.category, 'Hot drinks');
  assert.equal(seen.category_id, cat.body.id);
  assert.equal(seen.available, true);

  const cats = await anon().get(`/vendors/${v.id}/categories`);
  assert.deepEqual(cats.body.categories.map((c) => [c.name, c.items]), [['Hot drinks', 1]]);
});

test('a duplicate or empty category name is refused', async () => {
  const { v, owner } = await outlet();
  assert.equal((await owner.post(`/vendors/${v.id}/categories`, { name: 'Snacks' })).status, 200);
  assert.equal((await owner.post(`/vendors/${v.id}/categories`, { name: 'snacks' })).status, 400);
  assert.equal((await owner.post(`/vendors/${v.id}/categories`, { name: '   ' })).status, 400);
});

test("an item cannot be filed under another cafeteria's category", async () => {
  const a = await outlet('frisco');
  const b = await outlet('tulips');
  const theirs = (await b.owner.post(`/vendors/${b.v.id}/categories`, { name: 'Theirs' })).body;

  const create = await a.owner.post(`/vendors/${a.v.id}/menu`, { name: 'Burger', price: '90', categoryId: theirs.id });
  assert.equal(create.status, 400);

  const mine = await makeItem(pool, a.v.id, { name: 'Fries', paise: 6000 });
  assert.equal((await a.owner.patch(`/menu/${mine.id}`, { categoryId: theirs.id })).status, 400);
  assert.equal((await a.owner.patch(`/menu/${mine.id}`, { categoryId: 'not-a-uuid' })).status, 400);
});

test("one owner cannot rename or remove another cafeteria's categories", async () => {
  const a = await outlet('frisco');
  const b = await outlet('tulips');
  const theirs = (await b.owner.post(`/vendors/${b.v.id}/categories`, { name: 'Theirs' })).body;
  assert.equal((await a.owner.post(`/vendors/${b.v.id}/categories`, { name: 'Sneaky' })).status, 403);
  assert.equal((await a.owner.patch(`/categories/${theirs.id}`, { name: 'Mine' })).status, 403);
  assert.equal((await a.owner.del(`/categories/${theirs.id}`)).status, 403);
  const still = await pool.query(`SELECT name FROM category WHERE id = $1`, [theirs.id]);
  assert.equal(still.rows[0].name, 'Theirs');
});

test('removing a category keeps its food, uncategorised', async () => {
  const { v, owner } = await outlet();
  const cat = (await owner.post(`/vendors/${v.id}/categories`, { name: 'Snacks' })).body;
  const item = (await owner.post(`/vendors/${v.id}/menu`, { name: 'Samosa', price: '20', categoryId: cat.id })).body;
  const r = await owner.del(`/categories/${cat.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.itemsUncategorised, 1);
  const row = (await pool.query(`SELECT active, category_id FROM menu_item WHERE id = $1`, [item.id])).rows[0];
  assert.equal(row.active, true);
  assert.equal(row.category_id, null);
});

test('archive hides an item from students; restore brings it back', async () => {
  const { v, owner } = await outlet();
  const item = await makeItem(pool, v.id, { name: 'Wrap', paise: 8000 });
  assert.equal((await owner.patch(`/menu/${item.id}`, { active: false })).status, 200);
  assert.ok(!(await anon().get(`/vendors/${v.id}/menu`)).body.items.some((i) => i.id === item.id));
  assert.ok((await owner.get(`/vendors/${v.id}/menu`)).body.items.some((i) => i.id === item.id),
    'the owner still sees it, marked archived');
  assert.equal((await owner.patch(`/menu/${item.id}`, { active: true })).status, 200);
  assert.ok((await anon().get(`/vendors/${v.id}/menu`)).body.items.some((i) => i.id === item.id));
});

test('availability is read from the server by the student site', async () => {
  const { v, staff } = await outlet();
  const item = await makeItem(pool, v.id, { name: 'Wrap', paise: 8000 });
  assert.equal((await staff.patch(`/menu/${item.id}`, { available: false })).status, 200);
  const seen = (await anon().get(`/vendors/${v.id}/menu`)).body.items.find((i) => i.id === item.id);
  assert.equal(seen.available, false);
});

test('counter staff cannot archive, delete, or manage categories', async () => {
  const { v, staff } = await outlet();
  const item = await makeItem(pool, v.id, { name: 'Wrap', paise: 8000 });
  assert.equal((await staff.patch(`/menu/${item.id}`, { active: false })).status, 403);
  assert.equal((await staff.del(`/menu/${item.id}`)).status, 403);
  assert.equal((await staff.post(`/vendors/${v.id}/categories`, { name: 'X' })).status, 403);
  assert.equal((await staff.patch(`/vendors/${v.id}`, { isOpen: false })).status, 403);
  assert.equal((await pool.query(`SELECT active FROM menu_item WHERE id = $1`, [item.id])).rows[0].active, true);
});

test('an item nobody ordered can be deleted; an ordered one must be archived', async () => {
  const { v, owner } = await outlet();
  const fresh = (await owner.post(`/vendors/${v.id}/menu`, { name: 'Typo', price: '10' })).body;
  const r = await owner.del(`/menu/${fresh.id}`);
  assert.equal(r.status, 200);
  assert.equal((await pool.query(`SELECT 1 FROM menu_item WHERE id = $1`, [fresh.id])).rowCount, 0);

  const sold = await makeItem(pool, v.id, { name: 'Burger', paise: 9000 });
  const customer = await makeUser(pool, { phone: phone(), name: 'Student' });
  const o = (await pool.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise)
     VALUES ($1,$2,$3,'pickup','delivered',9000,9000) RETURNING id`,
    ['T' + randomBytes(3).toString('hex').toUpperCase(), customer.id, v.id])).rows[0];
  await pool.query(
    `INSERT INTO order_item (order_id, item_id, name_snapshot, unit_paise_snapshot, qty, line_paise)
     VALUES ($1,$2,'Burger',9000,1,9000)`, [o.id, sold.id]);
  const refused = await owner.del(`/menu/${sold.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'item_has_orders');
  assert.equal((await pool.query(`SELECT 1 FROM menu_item WHERE id = $1`, [sold.id])).rowCount, 1);
});

test('open and accepting are separate, and a closed or paused outlet is shown as not ordering', async () => {
  const { v, owner } = await outlet();
  assert.equal((await owner.patch(`/vendors/${v.id}`, { accepting: false })).status, 200);
  let seen = (await anon().get('/vendors')).body.vendors.find((x) => x.id === v.id);
  assert.equal(seen.is_open, true);
  assert.equal(seen.accepting, false);
  assert.equal((await owner.patch(`/vendors/${v.id}`, { isOpen: false, accepting: true })).status, 200);
  seen = (await anon().get('/vendors')).body.vendors.find((x) => x.id === v.id);
  assert.equal(seen.is_open, false);
  assert.equal(seen.accepting, true);
});

test('signed out, nothing on the menu can be changed', async () => {
  const { v } = await outlet();
  const item = await makeItem(pool, v.id, { name: 'Wrap', paise: 8000 });
  assert.equal((await anon().post(`/vendors/${v.id}/menu`, { name: 'X', price: '1' })).status, 401);
  assert.equal((await anon().post(`/vendors/${v.id}/categories`, { name: 'X' })).status, 401);
  assert.equal((await anon().del(`/menu/${item.id}`)).status, 401);
});
