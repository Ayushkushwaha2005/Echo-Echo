/* ==========================================================================
   ECHO ECHO — THE RULES THAT DECIDE AN ORDER

   Four things changed about ordering, and each is a rule the server has to
   enforce on its own, because a browser is not a place to keep a rule:

     · a student must have confirmed they are physically on campus
     · every order carries a delivery contact number
     · a delivery order carries a complete, frozen campus address
     · the platform fee is charged on every order, and the delivery partner's
       earning steps up on a bigger basket

   All of it is checked through the real routes, against a real database.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem, makeCampus, setTerms, campusId,
} from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

let app, pool, campus, vendor, item;
const anon = () => client(app);

before(async () => {
  /* config.js refuses to build an app with no platform owner configured. */
  process.env.PLATFORM_OWNER_EMAIL = 'owner@stu.upes.ac.in';
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });

beforeEach(async () => {
  await truncateAll(pool);
  campus = await makeCampus(pool);
  vendor = await makeVendor(pool, { name: 'Frisco', slug: 'frisco' });
  item = await makeItem(pool, vendor.id, { name: 'Thali', paise: 10000 });
});

const student = async (opts = {}) => {
  const u = await makeUser(pool, { phone: '+919700000001', name: 'Test Student', ...opts });
  return u;
};
const as = async (u, sessionOpts) => client(app, await sessionFor(pool, u.id, sessionOpts));

const order = (extra = {}) => ({
  vendorId: vendor.id, lines: [{ itemId: item.id, qty: 1 }],
  fulfilment: 'delivery', destinationId: campus.blockB.id, ...extra,
});

/* ========================= the live-location gate ======================== */

test('a session that has not confirmed its location cannot order', async () => {
  const c = await as(await student(), { onCampus: false });
  const r = await c.post('/orders/draft', order());
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'location_required');
  assert.match(r.body.error, /Confirm you are on campus/);
});

test('confirming the location opens ordering, and the verdict is the server\'s', async () => {
  const u = await student();
  const c = await as(u, { onCampus: false });
  assert.equal((await c.post('/orders/draft', order())).status, 403);

  const fix = await c.post('/campus/presence', { lat: 30.42, lng: 77.97, accuracy: 8 });
  assert.equal(fix.status, 200, JSON.stringify(fix.body));
  assert.equal(fix.body.confirmed, true);

  assert.equal((await c.post('/orders/draft', order())).status, 200, 'now it can order');
});

test('the location check fails closed on every way it can go wrong', async () => {
  const c = await as(await student(), { onCampus: false });
  const cases = [
    ['far outside the boundary', { lat: 28.6139, lng: 77.2090, accuracy: 5 }],
    ['accuracy not reported', { lat: 30.42, lng: 77.97 }],
    ['accuracy far too poor', { lat: 30.42, lng: 77.97, accuracy: 5000 }],
    ['no coordinates at all', { accuracy: 5 }],
    ['null coordinates', { lat: null, lng: null, accuracy: 5 }],
  ];
  for (const [why, body] of cases) {
    const r = await c.post('/campus/presence', body);
    assert.ok(r.status >= 400, `${why}: must be refused, got ${r.status}`);
    const after = await pool.query(
      `SELECT count(*)::int n FROM session WHERE user_id IS NOT NULL AND campus_presence_at IS NOT NULL`);
    assert.equal(after.rows[0].n, 0, `${why}: nothing may be recorded on the session`);
  }
  assert.equal((await c.post('/orders/draft', order())).status, 403, 'still cannot order');
});

test('a browser cannot simply assert it is on campus', async () => {
  const c = await as(await student(), { onCampus: false });
  /* There is no field, on any ordering request, that says "I am on campus". */
  const r = await c.post('/orders/draft',
    order({ onCampus: true, campusPresence: true, location: { confirmed: true } }));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'location_required');
});

test('a location confirmed on one campus does not unlock another', async () => {
  const u = await student();
  const c = await as(u, { onCampus: false });
  await c.post('/campus/presence', { lat: 30.42, lng: 77.97, accuracy: 8 });
  /* The student's profile moves to the campus that is not in service. */
  await pool.query(`UPDATE app_user SET campus_site_id = $2 WHERE id = $1`,
    [u.id, await campusId(pool, 'upes-kandholi')]);
  const r = await c.post('/orders/draft', order());
  assert.equal(r.status, 403);
  assert.ok(['location_required', 'forbidden'].includes(r.body.code), JSON.stringify(r.body));
});

/* ===================== the delivery contact number ====================== */

test('an order with no contact number anywhere is refused', async () => {
  /* A student who signed in with their mailbox and has never given a number:
     the account has an identity, but nothing to ring. */
  const u = await student({ contactPhone: null });
  await pool.query(
    `UPDATE app_user SET phone = NULL, student_email = 'nocontact@stu.upes.ac.in',
            student_email_verified_at = now() WHERE id = $1`, [u.id]);
  const c = await as(u);
  const r = await c.post('/orders/draft', order());
  assert.equal(r.status, 400);
  assert.match(r.body.error, /delivery contact number/i);
});

test('a contact number that is not a real Indian mobile is refused', async () => {
  const c = await as(await student());
  for (const bad of ['12345', '+911234567890', '9999999999999', 'not a number', '+915000000000']) {
    const r = await c.post('/orders/draft', order({ contactPhone: bad }));
    assert.equal(r.status, 400, `"${bad}" should be refused`);
  }
});

test('the contact number is stored on the order and remembered for the next one', async () => {
  const c = await as(await student({ contactPhone: null }));
  const r = await c.post('/orders/draft', order({ contactPhone: '9812345678' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await pool.query(`SELECT delivery_contact_phone FROM food_order WHERE id = $1`, [r.body.id]);
  assert.equal(row.rows[0].delivery_contact_phone, '+919812345678');

  /* The second order does not have to type it again. */
  const again = await c.post('/orders/draft', order());
  assert.equal(again.status, 200);
  const row2 = await pool.query(`SELECT delivery_contact_phone FROM food_order WHERE id = $1`, [again.body.id]);
  assert.equal(row2.rows[0].delivery_contact_phone, '+919812345678');
});

test('the contact number never becomes a way to sign in', async () => {
  const c = await as(await student({ contactPhone: null }));
  await c.post('/orders/draft', order({ contactPhone: '9812345678' }));
  /* There is no endpoint that will take it. */
  const r = await anon().post('/auth/otp/send', { phone: '+919812345678' });
  assert.equal(r.status, 410);
  assert.equal(r.headers['set-cookie'], undefined);
});

/* ======================= the full campus address ======================== */

test('a delivery order freezes the whole campus path, not just a name', async () => {
  const c = await as(await student());
  const r = await c.post('/orders/draft', order({
    landmark: 'Next to the stationery shop',
    instructions: 'Ring when you reach the gate',
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { rows } = await pool.query(
    `SELECT destination_id, destination_snapshot, delivery_landmark, delivery_instructions
       FROM food_order WHERE id = $1`, [r.body.id]);
  const o = rows[0];
  assert.equal(o.destination_id, campus.blockB.id, 'the configured location is still the destination');
  assert.ok(o.destination_snapshot, 'a snapshot must be frozen onto the order');
  assert.ok(Array.isArray(o.destination_snapshot.path) && o.destination_snapshot.path.length >= 2,
    'the snapshot carries the path down the campus tree');
  assert.ok(o.destination_snapshot.label.includes(campus.blockB.name));
  assert.equal(o.delivery_landmark, 'Next to the stationery shop');
  assert.equal(o.delivery_instructions, 'Ring when you reach the gate');
});

test('renaming a building does not rewrite where an old order went', async () => {
  const c = await as(await student());
  const r = await c.post('/orders/draft', order());
  const before = (await pool.query(`SELECT destination_snapshot FROM food_order WHERE id = $1`, [r.body.id]))
    .rows[0].destination_snapshot;
  await pool.query(`UPDATE campus_node SET name = 'Renamed Next Term' WHERE id = $1`, [campus.blockB.id]);
  const after = (await pool.query(`SELECT destination_snapshot FROM food_order WHERE id = $1`, [r.body.id]))
    .rows[0].destination_snapshot;
  assert.deepEqual(after, before, 'the frozen address is frozen');
});

test('a landmark cannot stand in for a campus destination', async () => {
  const c = await as(await student());
  /* Free text refines a confirmed location; it can never replace one, so
     there is still no way to express an off-campus address. */
  const r = await c.post('/orders/draft',
    order({ destinationId: undefined, landmark: '221B Baker Street, London' }));
  assert.ok(r.status >= 400, 'a delivery with no campus destination must be refused');
});

test('landmark and instructions are ignored on a collection order', async () => {
  const c = await as(await student());
  const r = await c.post('/orders/draft', order({
    fulfilment: 'pickup', destinationId: undefined,
    landmark: 'somewhere', instructions: 'something',
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { rows } = await pool.query(
    `SELECT delivery_landmark, delivery_instructions, destination_snapshot
       FROM food_order WHERE id = $1`, [r.body.id]);
  assert.equal(rows[0].delivery_landmark, null);
  assert.equal(rows[0].delivery_instructions, null);
  assert.equal(rows[0].destination_snapshot, null);
});

/* ============================ the money ================================= */

test('the platform fee is charged on every order, whatever the basket', async () => {
  await setTerms(pool, { platform_fee_flat_paise: 1000, delivery_fee_paise: 1500,
                         delivery_earning_paise: 1000 });
  const c = await as(await student());
  for (const qty of [1, 3]) {
    const r = await c.post('/orders/draft',
      { ...order(), lines: [{ itemId: item.id, qty }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const f = (await pool.query(`SELECT * FROM order_financials WHERE order_id = $1`, [r.body.id])).rows[0];
    assert.equal(f.platform_fee_paise, 1000, `flat 10.00 on a basket of ${qty}`);
    assert.equal(f.customer_total_paise, 10000 * qty + 1000 + 1500);
  }
});

test('the platform fee is charged on a collection order too', async () => {
  await setTerms(pool, { platform_fee_flat_paise: 1000, delivery_fee_paise: 1500 });
  const c = await as(await student());
  const r = await c.post('/orders/draft', order({ fulfilment: 'pickup', destinationId: undefined }));
  const f = (await pool.query(`SELECT * FROM order_financials WHERE order_id = $1`, [r.body.id])).rows[0];
  assert.equal(f.platform_fee_paise, 1000);
  assert.equal(f.delivery_fee_paise, 0, 'nothing is charged for a delivery that does not happen');
  assert.equal(f.customer_total_paise, 11000);
});

test('a client cannot talk the server out of the platform fee', async () => {
  await setTerms(pool, { platform_fee_flat_paise: 1000, delivery_fee_paise: 1500 });
  const c = await as(await student());
  const r = await c.post('/orders/draft', {
    ...order(),
    platformFee: 0, platform_fee_paise: 0, platformFeeFlatPaise: 0,
    total_paise: 1, customer_total_paise: 1, discountPaise: 99999,
  });
  assert.equal(r.status, 200);
  const f = (await pool.query(`SELECT * FROM order_financials WHERE order_id = $1`, [r.body.id])).rows[0];
  assert.equal(f.platform_fee_paise, 1000, 'the fee comes from the policy, not the request');
  assert.equal(f.discount_paise, 0);
});

test('the delivery partner earns the base amount, and more above the threshold', async () => {
  await setTerms(pool, {
    delivery_fee_paise: 1500,
    delivery_earning_paise: 1000,
    delivery_earning_high_paise: 1500,
    delivery_earning_threshold_paise: 30000,
  });
  const c = await as(await student());
  const earningFor = async (qty) => {
    const r = await c.post('/orders/draft', { ...order(), lines: [{ itemId: item.id, qty }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (await pool.query(`SELECT delivery_earning_paise FROM order_financials WHERE order_id = $1`,
      [r.body.id])).rows[0].delivery_earning_paise;
  };
  assert.equal(await earningFor(1), 1000, '100.00 of food: the base earning');
  assert.equal(await earningFor(2), 1000, '200.00: still below the threshold');
  assert.equal(await earningFor(3), 1500, '300.00: exactly at the threshold pays the higher amount');
  assert.equal(await earningFor(5), 1500, '500.00: above it');
});

test('with no threshold configured there is one flat earning', async () => {
  await setTerms(pool, { delivery_fee_paise: 1500, delivery_earning_paise: 1000 });
  const c = await as(await student());
  const r = await c.post('/orders/draft', { ...order(), lines: [{ itemId: item.id, qty: 9 }] });
  const f = (await pool.query(`SELECT delivery_earning_paise FROM order_financials WHERE order_id = $1`,
    [r.body.id])).rows[0];
  assert.equal(f.delivery_earning_paise, 1000);
});

test('a collection order pays no delivery earning at any basket size', async () => {
  await setTerms(pool, { delivery_earning_paise: 1000, delivery_earning_high_paise: 1500,
                         delivery_earning_threshold_paise: 30000 });
  const c = await as(await student());
  const r = await c.post('/orders/draft',
    { ...order(), fulfilment: 'pickup', destinationId: undefined, lines: [{ itemId: item.id, qty: 5 }] });
  const f = (await pool.query(`SELECT delivery_earning_paise FROM order_financials WHERE order_id = $1`,
    [r.body.id])).rows[0];
  assert.equal(f.delivery_earning_paise, 0);
});

test('the published fees match what an order is actually charged', async () => {
  await setTerms(pool, { platform_fee_flat_paise: 1000, delivery_fee_paise: 1500 });
  const quoted = await anon().get('/pricing/current');
  assert.equal(quoted.status, 200);
  assert.equal(quoted.body.platformFeeFlatPaise, 1000);
  assert.equal(quoted.body.deliveryFeePaise, 1500);

  const c = await as(await student());
  const r = await c.post('/orders/draft', order());
  const f = (await pool.query(`SELECT * FROM order_financials WHERE order_id = $1`, [r.body.id])).rows[0];
  assert.equal(f.platform_fee_paise, quoted.body.platformFeeFlatPaise);
  assert.equal(f.delivery_fee_paise, quoted.body.deliveryFeePaise);
});

test('the fee quote carries nothing about commission or partner pay', async () => {
  await setTerms(pool, { commission_bps: 500, delivery_earning_paise: 1000 });
  const r = await anon().get('/pricing/current');
  const body = JSON.stringify(r.body);
  for (const leak of ['commission', 'earning', 'cafeteria', 'payable']) {
    assert.ok(!body.toLowerCase().includes(leak), `the customer quote leaked "${leak}"`);
  }
});

/* ===================== who sees which numbers =========================== */

test('a customer sees what they paid, not how it was split up', async () => {
  await setTerms(pool, { commission_bps: 500, platform_fee_flat_paise: 1000,
                         delivery_fee_paise: 1500, delivery_earning_paise: 1000 });
  const u = await student();
  const c = await as(u);
  const r = await c.post('/orders/draft', order());
  const view = await c.get(`/orders/${r.body.id}`);
  assert.equal(view.status, 200);
  const f = view.body.financials;
  assert.equal(f.platform_fee_paise, 1000, 'they can see the fee they were charged');
  assert.equal(f.customer_total_paise, 12500);
  for (const internal of ['cafeteria_payable_paise', 'platform_gross_paise',
                          'commission_paise', 'delivery_earning_paise']) {
    assert.equal(f[internal], undefined, `a customer must not see ${internal}`);
  }
  assert.equal(view.body.ledger, undefined, 'no ledger for a customer');
});

test('a delivery partner sees their earning and nobody else\'s share', async () => {
  await setTerms(pool, { commission_bps: 500, platform_fee_flat_paise: 1000,
                         delivery_fee_paise: 1500, delivery_earning_paise: 1000 });
  const cust = await student();
  const partner = await makeUser(pool, { phone: '+919700000002', name: 'Partner P',
    roles: ['student', 'delivery_partner'] });
  const r = await (await as(cust)).post('/orders/draft', order());
  await pool.query(`UPDATE food_order SET partner_id = $2, state = 'assigned' WHERE id = $1`,
    [r.body.id, partner.id]);

  const view = await (await as(partner)).get(`/orders/${r.body.id}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.earning.paise, 1000, 'the partner is told what they earn');
  const f = view.body.financials;
  assert.equal(f.delivery_earning_paise, 1000);
  for (const internal of ['cafeteria_payable_paise', 'platform_gross_paise',
                          'commission_paise', 'customer_total_paise']) {
    assert.equal(f[internal], undefined, `a partner must not see ${internal}`);
  }
});

test('the earning rule is visible to a partner, and comes from the server', async () => {
  await setTerms(pool, { delivery_earning_paise: 1000, delivery_earning_high_paise: 1500,
                         delivery_earning_threshold_paise: 30000 });
  const partner = await makeUser(pool, { phone: '+919700000003', name: 'Partner Q',
    roles: ['student', 'delivery_partner'] });
  const r = await (await as(partner)).get('/partner/earning-rule');
  assert.equal(r.status, 200);
  assert.equal(r.body.basePaise, 1000);
  assert.equal(r.body.higherPaise, 1500);
  assert.equal(r.body.thresholdPaise, 30000);
});

/* ========================== no cash on delivery ========================== */

test('there is no cash-on-delivery path anywhere in ordering', async () => {
  const c = await as(await student());
  /* Asking for it by name changes nothing: a draft is unpaid either way, and
     only a verified gateway webhook can confirm an order. */
  for (const attempt of [{ paymentMethod: 'cod' }, { paymentMethod: 'cash' },
                         { payment: 'cash_on_delivery' }, { cod: true }]) {
    const r = await c.post('/orders/draft', { ...order(), ...attempt });
    if (r.status === 200) {
      const row = await pool.query(`SELECT state FROM food_order WHERE id = $1`, [r.body.id]);
      assert.equal(row.rows[0].state, 'draft', 'no request may produce a confirmed, unpaid order');
    }
  }
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'food_order'`);
  const names = cols.rows.map((x) => x.column_name);
  for (const forbidden of ['cod', 'cash_on_delivery', 'pay_on_delivery', 'payment_mode']) {
    assert.ok(!names.includes(forbidden), `food_order must not have ${forbidden}`);
  }
});
