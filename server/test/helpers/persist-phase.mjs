/* ==========================================================================
   One phase of the persistence test, run as its OWN process.

   Separate processes are the point. Re-importing the modules inside a single
   process would reuse the same connection pool and the same module graph, so
   "the data is still there" could just mean "the objects are still in this
   heap". A fresh process has neither, so anything it can read came from
   PostgreSQL on disk.

     node test/helpers/persist-phase.mjs create
     node test/helpers/persist-phase.mjs verify
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const stateFile = join(here, '..', '..', 'var', 'persist-state.json');

process.env.PLATFORM_OWNER_PHONE ||= '+919000000000';
process.env.COOKIE_SECRET ||= 'test-secret-that-is-at-least-32-chars-long';
process.env.WEB_ORIGIN ||= 'http://localhost:3000';
process.env.SWEEPER = 'off';
process.env.NODE_ENV = 'test';

const { pool } = await import('../../src/db/index.js');
const { build } = await import('../../src/index.js');
const app = await build();

const ORIGIN = 'http://localhost:3000';
async function session(userId) {
  const token = randomBytes(32).toString('base64url');
  /* Signed in AND on campus: the live-location check is part of signing in,
     so a fixture session that is about to order has passed it. */
  await pool.query(
    `INSERT INTO session (token_hash, user_id, expires_at, campus_presence_at, campus_presence_site_id)
     VALUES ($1,$2, now() + interval '720 minutes', now(),
             (SELECT campus_site_id FROM app_user WHERE id = $2))`,
    [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}
function client(token) {
  const headers = { origin: ORIGIN, 'content-type': 'application/json' };
  if (token) headers.cookie = `quad_session=${token}`;
  const call = async (method, url, payload) => {
    const res = await app.inject({ method, url, headers, payload });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return { get: (u) => call('GET', u), post: (u, p) => call('POST', u, p),
           patch: (u, p) => call('PATCH', u, p), put: (u, p) => call('PUT', u, p) };
}

/* Business entities: these must be byte-for-byte identical after a restart.
   Sessions and the audit log are deliberately NOT here — verifying creates a
   session and reading the admin endpoints writes audit rows, so comparing
   them strictly would be asserting that the test did nothing, not that the
   data persisted. They are checked separately, as floors. */
const COUNTS = `
  SELECT (SELECT count(*) FROM app_user)::int         AS users,
         (SELECT count(*) FROM user_role)::int        AS roles,
         (SELECT count(*) FROM vendor)::int           AS vendors,
         (SELECT count(*) FROM menu_item)::int        AS items,
         (SELECT count(*) FROM campus_node)::int      AS nodes,
         (SELECT count(*) FROM food_order)::int       AS orders,
         (SELECT count(*) FROM order_item)::int       AS lines,
         (SELECT count(*) FROM order_event)::int      AS events,
         (SELECT count(*) FROM review)::int           AS reviews,
         (SELECT count(*) FROM menu_price_history)::int AS prices`;

const FLOORS = `
  SELECT (SELECT count(*) FROM audit_log)::int AS audit,
         (SELECT count(*) FROM session)::int   AS sessions`;

const mode = process.argv[2];

try {
  if (mode === 'create') {
    /* ---- an admin, a cafeteria, a menu, a campus, an order, a review ---- */
    const admin = (await pool.query(
      `INSERT INTO app_user (phone,name) VALUES ('+919500000001','Restart Admin') RETURNING *`)).rows[0];
    await pool.query(`INSERT INTO user_role (user_id,role) VALUES ($1,'platform_admin')`, [admin.id]);
    const ca = client(await session(admin.id));

    const caf = (await ca.post('/vendors', { name: 'Persistence Cafe', kind: 'Test outlet' })).body;
    await ca.patch(`/vendors/${caf.id}`, { isOpen: true, accepting: true });
    const item = (await ca.post(`/vendors/${caf.id}/menu`,
      { name: 'Filter Coffee', price: '45', veg: true })).body;

    const zone = (await ca.post('/campus/nodes', { kind: 'zone', name: 'Restart Zone' })).body;
    const spot = (await ca.post('/campus/nodes',
      { kind: 'building', name: 'Restart Block', parentId: zone.id, deliverable: true,
        lat: 30.42, lng: 77.97 /* test position inside the fixture polygon below */ })).body;

    /* Delivery needs a confirmed campus boundary. */
    await pool.query(
      `INSERT INTO campus_boundary (name, polygon, campus_site_id, status, active, source, verified_at)
       VALUES ('Restart Campus', '[[30.41,77.96],[30.41,77.98],[30.43,77.98],[30.43,77.96]]',
               (SELECT id FROM campus_site WHERE slug = 'upes-bidholi'), 'active', true, 'test fixture', now())`);
    const stu = (await pool.query(
      `INSERT INTO app_user (phone,name,student_status,campus_site_id,contact_phone)
       VALUES ('+919500000002','Restart Student','approved',
               (SELECT id FROM campus_site WHERE slug = 'upes-bidholi'),
               '+919810000501') RETURNING *`)).rows[0];
    await pool.query(`INSERT INTO user_role (user_id,role) VALUES ($1,'student')`, [stu.id]);
    const studentToken = await session(stu.id);
    const cs = client(studentToken);

    const order = (await cs.post('/orders/draft', {
      vendorId: caf.id, lines: [{ itemId: item.id, qty: 3 }],
      fulfilment: 'delivery', destinationId: spot.id })).body;
    assert.equal(order.total_paise, 13500, '3 × ₹45, priced by the server');

    /* Deliver it so a real review can exist, then review it. */
    await pool.query(`UPDATE food_order SET state='delivered' WHERE id=$1`, [order.id]);
    const line = (await pool.query(`SELECT * FROM order_item WHERE order_id=$1`, [order.id])).rows[0];
    const rv = await cs.post('/reviews',
      { orderId: order.id, orderItemId: line.id, stars: 4, body: 'Real review.' });
    assert.equal(rv.status, 200, 'the review must be created');

    /* Change the price AFTER the order: the snapshot must outlive it. */
    await ca.patch(`/menu/${item.id}`, { price: '60' });

    await ca.put('/admin/config/support_phone', { value: '+919000000123' });
    await ca.put('/admin/flags/delivery', { enabled: true });

    const counts = (await pool.query(COUNTS)).rows[0];
    const floors = (await pool.query(FLOORS)).rows[0];
    assert.ok(floors.audit > 0, 'admin actions must have been audited');

    writeFileSync(stateFile, JSON.stringify({
      adminId: admin.id, studentId: stu.id, studentToken,
      cafId: caf.id, cafName: caf.name, itemId: item.id,
      zoneId: zone.id, spotId: spot.id,
      orderId: order.id, orderCode: order.code, orderTotal: order.total_paise,
      counts, floors,
    }, null, 2));
    console.log('CREATE OK', JSON.stringify(counts));

  } else if (mode === 'verify') {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));

    /* Nothing lost, nothing spontaneously added. */
    const counts = (await pool.query(COUNTS)).rows[0];
    assert.deepEqual(counts, s.counts, 'business entity counts must be identical after the restart');
    const floors = (await pool.query(FLOORS)).rows[0];
    assert.ok(floors.audit >= s.floors.audit, 'the audit log must not shrink');
    assert.ok(floors.sessions >= s.floors.sessions, 'sessions must not vanish');

    const ca = client(await session(s.adminId));

    const vendors = await ca.get('/vendors');
    assert.ok(vendors.body.vendors.some((v) => v.id === s.cafId && v.name === s.cafName),
      'the cafeteria survived');

    const menu = await ca.get(`/vendors/${s.cafId}/menu`);
    const item = menu.body.items.find((i) => i.id === s.itemId);
    assert.ok(item, 'the menu item survived');
    assert.equal(item.price_paise, 6000, 'the NEW price survived');
    assert.deepEqual(item.rating, { average: 4, count: 1,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 } },
      'the rating is computed from the real persisted review');

    const order = await ca.get(`/orders/${s.orderId}`);
    assert.equal(order.body.order.code, s.orderCode);
    assert.equal(order.body.order.total_paise, s.orderTotal, 'the frozen total survived');
    assert.equal(order.body.items[0].unit_paise_snapshot, 4500,
      'the order still carries ₹45, not the current ₹60');
    assert.ok(order.body.events.length > 0, 'the order event history survived');

    const nodes = await ca.get(`/campus/destinations?parent=${s.zoneId}`);
    assert.ok(nodes.body.nodes.some((n) => n.id === s.spotId), 'the campus location survived');

    const cfg = (await pool.query(
      `SELECT value #>> '{}' AS v FROM platform_config WHERE key='support_phone'`)).rows[0];
    assert.equal(cfg.v, '+919000000123', 'platform configuration survived');
    const flag = (await pool.query(
      `SELECT enabled FROM feature_flag WHERE key='delivery'`)).rows[0];
    assert.equal(flag.enabled, true, 'the feature flag survived');

    const audit = await ca.get('/admin/audit');
    assert.ok(audit.body.entries.some((e) => e.action === 'vendor.create'),
      'the audit log survived');

    const hist = await ca.get(`/menu/${s.itemId}/price-history`);
    assert.equal(hist.body.history.length, 2);
    assert.equal(hist.body.history[0].new_paise, 6000);
    assert.equal(hist.body.history[0].old_paise, 4500);

    /* A session issued BEFORE the restart must still authenticate — sessions
       live in PostgreSQL, not in the previous process's memory. */
    const pre = client(s.studentToken);
    const me = await pre.get('/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.authenticated, true, 'a pre-restart session is still valid');
    assert.equal(me.body.user.id, s.studentId);

    console.log('VERIFY OK', JSON.stringify(counts));

  } else {
    throw new Error(`unknown phase "${mode}"`);
  }
  await app.close();
  await pool.end();
  process.exit(0);
} catch (e) {
  console.error('PHASE FAILED:', e.message);
  try { await app.close(); await pool.end(); } catch { /* shutting down anyway */ }
  process.exit(1);
}
