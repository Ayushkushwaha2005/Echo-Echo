/* ==========================================================================
   INTEGRATION — real PostgreSQL

   These tests exist to prove the claims the schema makes. Where the last
   pass asserted "the FK makes this impossible" by reading SQL, here the
   database is actually asked to break its own rules, and refuses.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus }
  from './helpers/db.mjs';

let pool, buildDraft, transition, campus, acceptOffer, assignDelivery, toPaise;

before(async () => {
  await startDb({ port: 55433 });
  process.env.PLATFORM_OWNER_PHONE = '+919000000000';
  ({ pool } = await import('../src/db/index.js'));
  ({ buildDraft, transition } = await import('../src/routes/orders.js'));
  campus = await import('../src/services/campus.js');
  ({ acceptOffer, assignDelivery } = await import('../src/services/delivery.js'));
  ({ toPaise } = await import('../src/routes/catalog.js'));
});
after(async () => { await pool?.end(); await stopDb(); });
beforeEach(async () => { await truncateAll(pool); });

const tx = async (fn) => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
};

/* ======================= campus boundary ================================= */

test('an order cannot reference a location that does not exist', async () => {
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco' });
  const i = await makeItem(pool, v.id, { name: 'Burger', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111111', name: 'A' });
  await assert.rejects(
    () => tx((c) => buildDraft(c, {
      customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }],
      fulfilment: 'delivery', destinationId: '00000000-0000-0000-0000-000000000009' })),
    /Unknown delivery location/);
});

test('delivery to a DISABLED location is refused by the server', async () => {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'Frisco', slug: 'frisco' });
  const i = await makeItem(pool, v.id, { name: 'Burger', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111112', name: 'A' });
  await assert.rejects(
    () => tx((c) => buildDraft(c, {
      customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }],
      fulfilment: 'delivery', destinationId: n.disabled.id })),
    /Delivery is currently unavailable/);
});

test('delivery to an ARCHIVED location is refused', async () => {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111113', name: 'A' });
  await assert.rejects(
    () => tx((c) => buildDraft(c, {
      customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }],
      fulfilment: 'delivery', destinationId: n.archived.id })),
    /archived/);
});

test('a container node is not a delivery destination', async () => {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111114', name: 'A' });
  await assert.rejects(
    () => tx((c) => buildDraft(c, {
      customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }],
      fulfilment: 'delivery', destinationId: n.zone.id })),
    /area, not a delivery point/);
});

test('the database itself rejects a delivery order with no destination', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const u = await makeUser(pool, { phone: '+919111111115', name: 'A' });
  /* Bypassing the application entirely — the CHECK constraint holds. */
  await assert.rejects(
    () => pool.query(
      `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, destination_id)
       VALUES ('X1',$1,$2,'delivery',NULL)`, [u.id, v.id]),
    (e) => e.code === '23514');
});

test('there is no column in which an off-campus address could be stored', async () => {
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'food_order'`);
  const names = rows.map((r) => r.column_name);
  for (const forbidden of ['address', 'address_text', 'lat', 'lng', 'location_text', 'destination_text']) {
    assert.ok(!names.includes(forbidden), `food_order must not have ${forbidden}`);
  }
  assert.ok(names.includes('destination_id'));
});

/* ======================= price snapshots ================================= */

test('a price change does not alter a historical order', async () => {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'Veg Burger', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111116', name: 'A' });

  const order = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }],
    fulfilment: 'delivery', destinationId: n.blockB.id }));
  assert.equal(order.total_paise, 9000);

  await pool.query(`UPDATE menu_item SET price_paise = 9500 WHERE id = $1`, [i.id]);

  const line = (await pool.query(`SELECT * FROM order_item WHERE order_id = $1`, [order.id])).rows[0];
  assert.equal(line.unit_paise_snapshot, 9000, 'old order keeps ₹90');
  assert.equal(line.name_snapshot, 'Veg Burger');
  const after = (await pool.query(`SELECT total_paise FROM food_order WHERE id=$1`, [order.id])).rows[0];
  assert.equal(after.total_paise, 9000);

  /* A NEW order picks up the new price. */
  const order2 = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }],
    fulfilment: 'pickup' }));
  assert.equal(order2.total_paise, 9500);
});

test('archiving an item and a vendor leaves history resolvable', async () => {
  const v = await makeVendor(pool, { name: 'Tulips', slug: 'tulips' });
  const i = await makeItem(pool, v.id, { name: 'Thali', paise: 14000 });
  const u = await makeUser(pool, { phone: '+919111111117', name: 'A' });
  const o = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 2 }], fulfilment: 'pickup' }));

  await pool.query(`UPDATE menu_item SET active=false WHERE id=$1`, [i.id]);
  await pool.query(`UPDATE vendor SET active=false WHERE id=$1`, [v.id]);

  const row = (await pool.query(
    `SELECT o.code, o.total_paise, v.name AS vendor, oi.name_snapshot, oi.unit_paise_snapshot
       FROM food_order o JOIN vendor v ON v.id=o.vendor_id
       JOIN order_item oi ON oi.order_id=o.id WHERE o.id=$1`, [o.id])).rows[0];
  assert.equal(row.vendor, 'Tulips');
  assert.equal(row.name_snapshot, 'Thali');
  assert.equal(row.unit_paise_snapshot, 14000);
  assert.equal(row.total_paise, 28000);
});

test('an item that goes unavailable after the draft blocks a NEW draft', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111118', name: 'A' });
  await pool.query(`UPDATE menu_item SET available=false WHERE id=$1`, [i.id]);
  await assert.rejects(
    () => tx((c) => buildDraft(c, {
      customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' })),
    /unavailable right now/);
});

test('a closed cafeteria cannot take an order', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f', open: false });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111119', name: 'A' });
  await assert.rejects(
    () => tx((c) => buildDraft(c, {
      customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' })),
    /not accepting orders/);
});

test('a client-supplied price is ignored entirely', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111120', name: 'A' });
  const o = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id,
    /* The attacker's payload. */
    lines: [{ itemId: i.id, qty: 1, price: 1, price_paise: 100, unit_paise_snapshot: 100 }],
    fulfilment: 'pickup' }));
  assert.equal(o.total_paise, 9000);
});

/* ======================= order state machine ============================= */

test('an order cannot skip from draft to delivered', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111121', name: 'A' });
  const o = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' }));
  await assert.rejects(() => tx((c) => transition(c, o.id, 'delivered', null)),
                       /cannot go from draft to delivered/);
  await assert.rejects(() => tx((c) => transition(c, o.id, 'confirmed', null)),
                       /cannot go from draft to confirmed/);
});

test('the database rejects an order state that is not in the enum', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const u = await makeUser(pool, { phone: '+919111111122', name: 'A' });
  await assert.rejects(
    () => pool.query(
      `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state)
       VALUES ('X2',$1,$2,'pickup','paid_definitely')`, [u.id, v.id]),
    (e) => e.code === '23514');
});

test('every transition writes an event row', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111123', name: 'A' });
  const o = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' }));
  await tx((c) => transition(c, o.id, 'awaiting_payment', null));
  await tx((c) => transition(c, o.id, 'confirmed', null));
  await tx((c) => transition(c, o.id, 'preparing', null));
  const { rows } = await pool.query(
    `SELECT to_state FROM order_event WHERE order_id=$1 ORDER BY at, id`, [o.id]);
  assert.deepEqual(rows.map((r) => r.to_state),
                   ['draft', 'awaiting_payment', 'confirmed', 'preparing']);
});

/* ======================= reviews ======================================== */

async function deliveredOrder(phone) {
  const v = await makeVendor(pool, { name: 'F', slug: 'f' + phone.slice(-3) });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone, name: 'A' });
  const o = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' }));
  await pool.query(`UPDATE food_order SET state='delivered' WHERE id=$1`, [o.id]);
  const li = (await pool.query(`SELECT * FROM order_item WHERE order_id=$1`, [o.id])).rows[0];
  return { u, v, i, o, li };
}

test('a review must be anchored to a purchased line — the FK enforces it', async () => {
  const { u, o } = await deliveredOrder('+919111111124');
  const other = await makeVendor(pool, { name: 'Other', slug: 'other' });
  const ghost = await makeItem(pool, other.id, { name: 'Never bought', paise: 5000 });
  /* No order_item_id: the partial unique index does not fire, but the
     review is still tied to an order the reviewer owns. Reviewing an item
     with a fabricated order_item_id fails on the foreign key. */
  await assert.rejects(
    () => pool.query(
      `INSERT INTO review (user_id, order_id, order_item_id, item_id, stars)
       VALUES ($1,$2,'00000000-0000-0000-0000-000000000001',$3,5)`, [u.id, o.id, ghost.id]),
    (e) => e.code === '23503');
});

test('duplicate item review on the same line is rejected by the index', async () => {
  const { u, o, li, i } = await deliveredOrder('+919111111125');
  await pool.query(
    `INSERT INTO review (user_id, order_id, order_item_id, item_id, stars)
     VALUES ($1,$2,$3,$4,5)`, [u.id, o.id, li.id, i.id]);
  await assert.rejects(
    () => pool.query(
      `INSERT INTO review (user_id, order_id, order_item_id, item_id, stars)
       VALUES ($1,$2,$3,$4,1)`, [u.id, o.id, li.id, i.id]),
    (e) => e.code === '23505');
});

test('duplicate vendor review on the same order is rejected', async () => {
  const { u, o, v } = await deliveredOrder('+919111111126');
  await pool.query(`INSERT INTO review (user_id, order_id, vendor_id, stars)
                    VALUES ($1,$2,$3,4)`, [u.id, o.id, v.id]);
  await assert.rejects(
    () => pool.query(`INSERT INTO review (user_id, order_id, vendor_id, stars)
                      VALUES ($1,$2,$3,2)`, [u.id, o.id, v.id]),
    (e) => e.code === '23505');
});

test('a review must target exactly one of item or vendor', async () => {
  const { u, o, v, li, i } = await deliveredOrder('+919111111127');
  await assert.rejects(
    () => pool.query(
      `INSERT INTO review (user_id, order_id, order_item_id, item_id, vendor_id, stars)
       VALUES ($1,$2,$3,$4,$5,5)`, [u.id, o.id, li.id, i.id, v.id]),
    (e) => e.code === '23514');
});

test('star ratings outside 1..5 are rejected', async () => {
  const { u, o, v } = await deliveredOrder('+919111111128');
  for (const bad of [0, 6, -1]) {
    await assert.rejects(
      () => pool.query(`INSERT INTO review (user_id, order_id, vendor_id, stars)
                        VALUES ($1,$2,$3,$4)`, [u.id, o.id, v.id, bad]),
      (e) => e.code === '23514');
  }
});

test('ratings aggregate to null when there are none', async () => {
  const v = await makeVendor(pool, { name: 'Fresh', slug: 'fresh' });
  const r = (await pool.query(
    `SELECT count(*)::int AS n, avg(stars) AS a FROM review WHERE vendor_id=$1`, [v.id])).rows[0];
  assert.equal(r.n, 0);
  assert.equal(r.a, null, 'no ratings must aggregate to NULL, never to a number');
});

/* ======================= delivery assignment ============================= */

async function readyDeliveryOrder(phones) {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'F', slug: 'fd' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const cust = await makeUser(pool, { phone: phones.cust, name: 'Cust' });
  const o = await tx((c) => buildDraft(c, {
    customerId: cust.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }],
    fulfilment: 'delivery', destinationId: n.blockB.id }));
  await pool.query(`UPDATE food_order SET state='ready' WHERE id=$1`, [o.id]);

  const partners = [];
  for (const p of phones.partners) {
    const u = await makeUser(pool, { phone: p, name: 'P' + p.slice(-2),
      roles: ['student', 'delivery_partner'], studentStatus: 'approved' });
    await pool.query(
      `INSERT INTO partner_profile (user_id, status, online) VALUES ($1,'approved',true)`, [u.id]);
    partners.push(u);
  }
  return { o, partners, cust, v };
}

test('only ONE partner can accept an order — the index settles the race', async () => {
  const { o, partners } = await readyDeliveryOrder({
    cust: '+919111111130', partners: ['+919111111131', '+919111111132'] });
  await assignDelivery(o.id);
  const offers = (await pool.query(
    `SELECT * FROM delivery_offer WHERE order_id=$1 ORDER BY partner_id`, [o.id])).rows;
  assert.equal(offers.length, 2);

  /* Both accept simultaneously. */
  const results = await Promise.allSettled(
    offers.map((of) => acceptOffer(of.id, of.partner_id)));
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one acceptance must succeed');
  assert.equal(failed.length, 1);

  const accepted = (await pool.query(
    `SELECT count(*)::int AS n FROM delivery_offer
      WHERE order_id=$1 AND state='accepted'`, [o.id])).rows[0];
  assert.equal(accepted.n, 1);

  const order = (await pool.query(`SELECT * FROM food_order WHERE id=$1`, [o.id])).rows[0];
  assert.equal(order.state, 'assigned');
  assert.ok(order.partner_id);
});

test('the customer is never offered their own delivery', async () => {
  const n = await makeCampus(pool);
  const v = await makeVendor(pool, { name: 'F', slug: 'fx' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  /* A student who is also an approved, online partner orders for themselves. */
  const u = await makeUser(pool, { phone: '+919111111133', name: 'Both',
    roles: ['student', 'delivery_partner'], studentStatus: 'approved' });
  await pool.query(
    `INSERT INTO partner_profile (user_id, status, online) VALUES ($1,'approved',true)`, [u.id]);
  const o = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }],
    fulfilment: 'delivery', destinationId: n.blockB.id }));
  await pool.query(`UPDATE food_order SET state='ready' WHERE id=$1`, [o.id]);
  const out = await assignDelivery(o.id);
  assert.equal(out.offered, 0);
  assert.equal(out.note, 'no_partner_available');
});

test('an unverified or offline partner is not eligible', async () => {
  const { o } = await readyDeliveryOrder({ cust: '+919111111134', partners: [] });
  const offline = await makeUser(pool, { phone: '+919111111135', name: 'Off',
    roles: ['student', 'delivery_partner'], studentStatus: 'approved' });
  await pool.query(`INSERT INTO partner_profile (user_id,status,online)
                    VALUES ($1,'approved',false)`, [offline.id]);
  const unverified = await makeUser(pool, { phone: '+919111111136', name: 'Unv',
    roles: ['student', 'delivery_partner'], studentStatus: 'unverified' });
  await pool.query(`INSERT INTO partner_profile (user_id,status,online)
                    VALUES ($1,'approved',true)`, [unverified.id]);
  const pending = await makeUser(pool, { phone: '+919111111137', name: 'Pend',
    roles: ['student'], studentStatus: 'approved' });
  await pool.query(`INSERT INTO partner_profile (user_id,status,online)
                    VALUES ($1,'pending',true)`, [pending.id]);

  const out = await assignDelivery(o.id);
  assert.equal(out.offered, 0, 'none of these three is eligible');
});

/* ======================= payments ======================================= */

test('a duplicate webhook event is absorbed by the primary key', async () => {
  const v = await makeVendor(pool, { name: 'F', slug: 'fw' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111140', name: 'A' });
  const o = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' }));
  await pool.query(
    `INSERT INTO payment (order_id, provider, provider_order_id, amount_paise, status)
     VALUES ($1,'razorpay','order_x',$2,'pending')`, [o.id, o.total_paise]);

  const first = await pool.query(
    `INSERT INTO payment_webhook (provider,event_id,payload) VALUES ('razorpay','evt_1','{}')
     ON CONFLICT DO NOTHING RETURNING event_id`);
  const second = await pool.query(
    `INSERT INTO payment_webhook (provider,event_id,payload) VALUES ('razorpay','evt_1','{}')
     ON CONFLICT DO NOTHING RETURNING event_id`);
  assert.equal(first.rowCount, 1);
  assert.equal(second.rowCount, 0, 'the replay must do nothing');
});

test('only one IN-FLIGHT refund can exist per payment', async () => {
  /* The rule changed with the ledger: a payment may accumulate several
     COMPLETED refunds, because a partial refund has to be followed by
     another. What may never happen is two refunds in flight at once, and
     the route caps the running total at what was captured. */
  const v = await makeVendor(pool, { name: 'F', slug: 'fr' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111141', name: 'A' });
  const o = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' }));
  const p = (await pool.query(
    `INSERT INTO payment (order_id, provider, amount_paise, status)
     VALUES ($1,'razorpay',$2,'paid') RETURNING *`, [o.id, o.total_paise])).rows[0];

  const add = (amount, state) => pool.query(
    `INSERT INTO refund (order_id,payment_id,amount_paise,reason,requested_by,state)
     VALUES ($1,$2,$3,'r',$4,$5)`, [o.id, p.id, amount, u.id, state]);

  await add(4000, 'completed');
  await add(3000, 'completed');          // a second partial refund is legitimate
  const done = await pool.query(
    `SELECT count(*)::int AS n FROM refund WHERE payment_id = $1`, [p.id]);
  assert.equal(done.rows[0].n, 2);

  await add(1000, 'processing');
  await assert.rejects(() => add(1000, 'requested'), (e) => e.code === '23505',
    'but only one may be in flight');
});

test('an idempotency key cannot produce two refunds on one payment', async () => {
  const v = await makeVendor(pool, { name: 'G', slug: 'gr' });
  const i = await makeItem(pool, v.id, { name: 'B', paise: 9000 });
  const u = await makeUser(pool, { phone: '+919111111142', name: 'A' });
  const o = await tx((c) => buildDraft(c, {
    customerId: u.id, vendorId: v.id, lines: [{ itemId: i.id, qty: 1 }], fulfilment: 'pickup' }));
  const p = (await pool.query(
    `INSERT INTO payment (order_id, provider, amount_paise, status)
     VALUES ($1,'razorpay',$2,'paid') RETURNING *`, [o.id, o.total_paise])).rows[0];
  const add = () => pool.query(
    `INSERT INTO refund (order_id,payment_id,amount_paise,reason,requested_by,state,idempotency_key)
     VALUES ($1,$2,100,'r',$3,'completed','same-key')`, [o.id, p.id, u.id]);
  await add();
  await assert.rejects(add, (e) => e.code === '23505');
});

/* ======================= verification =================================== */

test('a user can only have one open verification case', async () => {
  const u = await makeUser(pool, { phone: '+919111111150', name: 'A' });
  await pool.query(`INSERT INTO verification_case (user_id, state) VALUES ($1,'pending')`, [u.id]);
  await assert.rejects(
    () => pool.query(`INSERT INTO verification_case (user_id, state) VALUES ($1,'pending')`, [u.id]),
    (e) => e.code === '23505');
  /* But a decided case does not block a resubmission. */
  await pool.query(`UPDATE verification_case SET state='rejected' WHERE user_id=$1`, [u.id]);
  await pool.query(`INSERT INTO verification_case (user_id, state) VALUES ($1,'pending')`, [u.id]);
  const n = (await pool.query(
    `SELECT count(*)::int AS n FROM verification_case WHERE user_id=$1`, [u.id])).rows[0];
  assert.equal(n.n, 2);
});

test('the 24-hour SLA is set by the schema, not the application', async () => {
  const u = await makeUser(pool, { phone: '+919111111151', name: 'A' });
  const k = (await pool.query(
    `INSERT INTO verification_case (user_id) VALUES ($1) RETURNING *`, [u.id])).rows[0];
  const hours = (new Date(k.sla_due_at) - new Date(k.submitted_at)) / 3_600_000;
  assert.ok(Math.abs(hours - 24) < 0.1, `expected ~24h, got ${hours}`);
});

/* ======================= roles ========================================== */

test('a vendor role without a cafeteria is rejected, and vice versa', async () => {
  const u = await makeUser(pool, { phone: '+919111111160', name: 'A' });
  await assert.rejects(
    () => pool.query(`INSERT INTO user_role (user_id, role) VALUES ($1,'vendor_owner')`, [u.id]),
    (e) => e.code === '23514');
  const v = await makeVendor(pool, { name: 'F', slug: 'fv' });
  await assert.rejects(
    () => pool.query(`INSERT INTO user_role (user_id, role, vendor_id)
                      VALUES ($1,'student',$2)`, [u.id, v.id]),
    (e) => e.code === '23514');
});

test('a phone number is unique and must be E.164', async () => {
  await makeUser(pool, { phone: '+919111111161', name: 'A' });
  await assert.rejects(
    () => pool.query(`INSERT INTO app_user (phone) VALUES ('+919111111161')`),
    (e) => e.code === '23505');
  await assert.rejects(
    () => pool.query(`INSERT INTO app_user (phone) VALUES ('9111111162')`),
    (e) => e.code === '23514');
});

/* ======================= campus resolution ============================== */

test('"block b" is ambiguous and returns both, deliverable', async () => {
  await makeCampus(pool);
  const out = await campus.resolvePhrase('bhai block b pe bhej do');
  assert.equal(out.ambiguous, true);
  assert.equal(out.matches.length, 2);
  const paths = out.matches.map((m) => m.path).sort();
  assert.deepEqual(paths, ['Academic Area — Block B', 'Hostel Area — Block B']);
});

test('"hostel a block 2" resolves to exactly the deepest node', async () => {
  const n = await makeCampus(pool);
  const out = await campus.resolvePhrase('hostel a block 2 mein bhej');
  assert.equal(out.ambiguous, false);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].id, n.hostelA2.id);
  assert.equal(out.matches[0].path, 'Hostel Area — Hostel A — Block 2');
});

test('a phrase matching nothing invents nothing', async () => {
  await makeCampus(pool);
  const out = await campus.resolvePhrase('deliver to my house in dehradun city');
  assert.equal(out.matches.length, 0);
});

test('a GPS fix inside the boundary returns candidates; outside returns none', async () => {
  await makeCampus(pool);
  const inside = await campus.resolveFix(30.4160, 77.9680, { accuracy: 10 });
  assert.equal(inside.inside, true);
  assert.ok(inside.candidates.length >= 1);

  const outside = await campus.resolveFix(28.6139, 77.2090, { accuracy: 10 });   // Delhi
  assert.equal(outside.inside, false);
  assert.equal(outside.reason, 'outside_campus');
  assert.equal(outside.candidates.length, 0);
});

test('an archived location disappears from search and resolution', async () => {
  await makeCampus(pool);
  const before = await campus.resolvePhrase('old canteen');
  await pool.query(`UPDATE campus_node SET active=true WHERE name='Old Canteen'`);
  const after = await campus.resolvePhrase('old canteen');
  assert.equal(before.matches.length, 0, 'archived node must not resolve');
  assert.equal(after.matches.length, 1, 'restoring it makes it resolvable again');
});
