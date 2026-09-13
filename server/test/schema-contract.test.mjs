/* ==========================================================================
   SCHEMA CONTRACT — what the LIVE database actually enforces.

   Read from the PostgreSQL catalog, not from the .sql files. The point is
   to prove that correctness rests on database constraints rather than on
   application code remembering to check things: if someone bypasses the API
   entirely and writes to the tables, these are the rules that still hold.
   ========================================================================== */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb } from './helpers/db.mjs';

let pool;

before(async () => {
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
});
after(async () => { await pool?.end(); await stopDb(); });

const rows = async (sql, params) => (await pool.query(sql, params)).rows;

/* Every entity the brief requires to be persistent. */
const REQUIRED_TABLES = [
  'app_user', 'user_role', 'session', 'otp_challenge',
  'verification_case', 'asset',
  'vendor', 'category', 'menu_item', 'menu_price_history',
  'campus_node', 'campus_boundary',
  'food_order', 'order_item', 'order_event',
  'payment', 'payment_webhook', 'refund',
  'partner_profile', 'delivery_offer',
  'review', 'support_case', 'support_message',
  'notification', 'audit_log', 'feature_flag', 'platform_config',
];

test('every required entity exists as a real table', async () => {
  const present = (await rows(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'`)).map((r) => r.table_name);
  for (const t of REQUIRED_TABLES) {
    assert.ok(present.includes(t), `missing table: ${t}`);
  }
});

test('foreign keys wire the graph together, with no orphan-able core rows', async () => {
  const fks = await rows(
    `SELECT tc.table_name AS child, kcu.column_name AS col,
            ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`);
  const has = (child, col, parent) =>
    fks.some((f) => f.child === child && f.col === col && f.parent === parent);

  /* The relationships that carry the product's integrity. */
  assert.ok(has('user_role', 'user_id', 'app_user'), 'roles must belong to a real user');
  assert.ok(has('user_role', 'vendor_id', 'vendor'), 'vendor roles must name a real cafeteria');
  assert.ok(has('session', 'user_id', 'app_user'), 'a session must belong to a real user');
  assert.ok(has('menu_item', 'vendor_id', 'vendor'), 'an item must belong to a real cafeteria');
  assert.ok(has('food_order', 'customer_id', 'app_user'));
  assert.ok(has('food_order', 'vendor_id', 'vendor'));
  assert.ok(has('food_order', 'destination_id', 'campus_node'),
    'a destination MUST be a configured campus location');
  assert.ok(has('order_item', 'order_id', 'food_order'));
  assert.ok(has('order_item', 'item_id', 'menu_item'));
  assert.ok(has('payment', 'order_id', 'food_order'));
  assert.ok(has('refund', 'payment_id', 'payment'));
  assert.ok(has('delivery_offer', 'order_id', 'food_order'));
  assert.ok(has('delivery_offer', 'partner_id', 'app_user'));
  assert.ok(has('review', 'order_id', 'food_order'));
  assert.ok(has('review', 'order_item_id', 'order_item'),
    'an item review must be anchored to a purchased line');
  assert.ok(has('campus_node', 'parent_id', 'campus_node'), 'locations must form a real tree');
});

test('the order table has no column capable of holding an off-campus address', async () => {
  const cols = (await rows(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='food_order'`)).map((r) => r.column_name);
  for (const forbidden of ['address', 'address_text', 'lat', 'lng', 'latitude', 'longitude',
                           'location_text', 'destination_text', 'place']) {
    assert.ok(!cols.includes(forbidden), `food_order must not have "${forbidden}"`);
  }
  assert.ok(cols.includes('destination_id'), 'the only destination is a campus_node reference');
});

test('CHECK constraints enforce the value domains, not application code', async () => {
  const checks = await rows(
    `SELECT rel.relname AS tbl, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE c.contype='c' AND n.nspname='public'`);
  const on = (tbl, re) => checks.some((c) => c.tbl === tbl && re.test(c.def));

  assert.ok(on('app_user', /phone/i), 'phone format is enforced by the database');
  assert.ok(on('user_role', /platform_owner/), 'the role vocabulary is a database constraint');
  assert.ok(on('user_role', /vendor_owner.*vendor_id IS NOT NULL|vendor_id IS NOT NULL.*vendor_owner/s),
    'a vendor role without a cafeteria must be unrepresentable');
  assert.ok(on('food_order', /draft|confirmed|delivered/), 'order states are constrained');
  assert.ok(on('food_order', /delivery.*destination_id|destination_id.*delivery/s),
    'a delivery order must carry a destination');
  assert.ok(on('order_item', /qty > 0/), 'quantities must be positive');
  assert.ok(on('menu_item', /price_paise >= 0/), 'prices cannot be negative');
  assert.ok(on('review', /stars/), 'star ratings are bounded by the database');
  assert.ok(on('payment', /paid|failed/), 'payment states are constrained');
});

test('unique constraints make the concurrency rules structural', async () => {
  const idx = await rows(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public'`);
  const has = (re) => idx.some((i) => re.test(i.indexdef));

  assert.ok(has(/UNIQUE.*delivery_offer.*order_id.*WHERE.*accepted/s),
    'only one accepted delivery offer per order');
  assert.ok(has(/UNIQUE.*review.*order_item_id/s), 'one review per purchased line');
  assert.ok(has(/UNIQUE.*review.*order_id.*WHERE.*vendor_id/s), 'one vendor review per order');
  assert.ok(has(/UNIQUE.*verification_case.*user_id.*WHERE/s), 'one open verification case per user');
  assert.ok(has(/UNIQUE.*refund.*payment_id.*WHERE/s), 'one live refund per payment');
  assert.ok(has(/UNIQUE.*app_user.*phone/s), 'phone numbers are unique');
  assert.ok(has(/UNIQUE.*user_role_identity/s), 'a role is held once per user per cafeteria');
  assert.ok(has(/UNIQUE.*payment_webhook/s) ||
            idx.some((i) => /payment_webhook_pkey/.test(i.indexname)),
    'webhook events are idempotent by primary key');
});

test('indexes exist on the columns the product actually queries by', async () => {
  const idx = (await rows(`SELECT indexdef FROM pg_indexes WHERE schemaname='public'`))
    .map((r) => r.indexdef);
  const covers = (tbl, col) => idx.some((d) => d.includes(` ON public.${tbl} `) && d.includes(col));
  assert.ok(covers('food_order', 'customer_id'), 'order history by customer');
  assert.ok(covers('food_order', 'vendor_id'), 'the counter queue');
  assert.ok(covers('menu_item', 'vendor_id'), 'menu by cafeteria');
  assert.ok(covers('audit_log', 'at'), 'audit log is time-ordered');
  assert.ok(covers('campus_node', 'parent_id'), 'campus tree traversal');
  assert.ok(covers('session', 'user_id'), 'session lookup');
});

test('money is integer paise everywhere — no float can hold a price', async () => {
  const cols = await rows(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema='public'
        AND (column_name LIKE '%paise%' OR column_name LIKE '%price%'
             OR column_name LIKE '%amount%' OR column_name LIKE '%total%')`);
  assert.ok(cols.length >= 8, 'the money columns should be found');
  for (const c of cols) {
    assert.ok(['integer', 'bigint'].includes(c.data_type),
      `${c.table_name}.${c.column_name} is ${c.data_type}; money must be an integer type`);
  }
});
