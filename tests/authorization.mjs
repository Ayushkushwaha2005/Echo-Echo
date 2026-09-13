/* ==========================================================================
   Authorization tests — run with AUTH_ENABLED unset/false (the current mode).
   Covers the admin / shopkeeper / student / partner matrices, photo & price
   management, archive-not-delete, and historical price snapshots.
   ========================================================================== */
import { api, authorize, userById, USERS, runPermissionTests } from '../packages/data/api.js';
import { VENDORS, ITEMS, ORDER_HISTORY, PRICING } from '../packages/data/catalog.js';
import { CONFIG_FLAGS } from '../packages/data/config.js';
import { requireVendorAccess, ROLES, SURFACE_ROLES } from '../packages/data/auth.js';

let fails = 0, count = 0;
const ok = (c, m) => { count++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const allows = (m, fn) => { try { fn(); ok(true, m); } catch (e) { ok(false, `${m} — unexpectedly denied: ${e.message}`); } };
const denies = (m, fn) => { try { fn(); ok(false, `${m} — was ALLOWED`); } catch (e) { ok(true, `${m} → ${e.name}: ${e.message}`); } };

const admin   = userById('usr_admin');
const support = userById('usr_support');
const frisco  = userById('usr_owner_frisco');
const staff   = userById('usr_staff_frisco');
const chai    = userById('usr_owner_chai');
const student = userById('usr_1');           // student + delivery_partner
const partnerOnly = { id: 'usr_p', name: 'P', role: 'delivery_partner', roles: ['delivery_partner'] };

console.log(`\n=== Mode: AUTH_ENABLED=${CONFIG_FLAGS.AUTH_ENABLED} ===`);

console.log('\n== Baseline capability matrix ==');
for (const t of runPermissionTests()) ok(t.ok, `${t.name} → ${t.got}`);

console.log('\n== ADMIN: cafeteria management ==');
let v4;
allows('Admin adds a cafeteria', () => { v4 = api.createVendor(admin, { name: 'Nescafe Corner', kind: 'Coffee', zone: 'z_acad' }); });
ok(v4 && v4.active && !v4.is_open, 'New cafeteria is created active but closed');
allows('Admin edits a cafeteria', () => api.updateVendor(admin, v4.id, { kind: 'Coffee & bakes' }));
allows('Admin assigns an owner', () => api.updateVendor(admin, v4.id, { owner: 'usr_owner_frisco' }));
allows('Admin sets operating hours', () => api.updateVendor(admin, v4.id, { hours: { opens: '09:00', closes: '17:00' } }));
allows('Admin sets staff_can_deliver', () => api.updateVendor(admin, v4.id, { staff_can_deliver: true }));
allows('Admin archives a cafeteria', () => api.archiveVendor(admin, v4.id));
ok(VENDORS.some((x) => x.id === v4.id), 'Archived cafeteria row still exists (no destructive delete)');
allows('Admin restores a cafeteria', () => api.restoreVendor(admin, v4.id));

console.log('\n== ADMIN: food across ALL cafeterias ==');
for (const vid of ['caf_frisco', 'caf_chai', 'caf_tulips']) {
  const item = ITEMS.find((i) => i.caf === vid);
  allows(`Admin edits ${VENDORS.find((v) => v.id === vid).name} menu`, () => api.updateItem(admin, item.id, { desc: item.desc }));
}
let newItem;
allows('Admin adds food', () => { newItem = api.createItem(admin, 'caf_chai', { name: 'Test Bhaji', price: 40, cat: 'Snacks', aliases: 'bhaji' }); });
ok(newItem.price === 4000, 'Price stored as paise (₹40 → 4000)');
allows('Admin changes price', () => api.updateItem(admin, newItem.id, { price: 45 }));
ok(ITEMS.find((i) => i.id === newItem.id).price === 4500, 'Price updated to 4500 paise');
allows('Admin uploads a food photo', () => api.setItemPhoto(admin, newItem.id, { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', alt: 'Test Bhaji', filename: 'bhaji.png' }));
ok(!!ITEMS.find((i) => i.id === newItem.id).photo, 'Photo is attached to the actual menu row');
ok(ITEMS.find((i) => i.id === newItem.id).photoAlt === 'Test Bhaji', 'Photo alt text stored');
denies('Admin uploads a non-image', () => api.setItemPhoto(admin, newItem.id, { dataUrl: 'data:text/html,<script>' }));
denies('Admin uploads an oversized image', () => api.setItemPhoto(admin, newItem.id, { dataUrl: 'data:image/png;base64,' + 'A'.repeat(4_000_000) }));
allows('Admin sets item options', () => api.setItemOptions(admin, newItem.id, [{ group: 'Size', choices: [{ label: 'Half', delta: 0 }, { label: 'Full', delta: 1500 }] }]));
allows('Admin archives food', () => api.archiveItem(admin, newItem.id));
ok(ITEMS.some((i) => i.id === newItem.id), 'Archived food row still exists (no destructive delete)');
allows('Admin restores food', () => api.restoreItem(admin, newItem.id));

console.log('\n== ADMIN: campus, users, delivery ==');
let node;
allows('Admin adds a campus location', () => { node = api.createNode(admin, { parent: 'z_acad', kind: 'building', name: 'Block T', deliverable: true }); });
allows('Admin edits a campus location', () => api.updateNode(admin, node.id, { detail: 'Temporary block' }));
allows('Admin archives a campus location', () => api.archiveNode(admin, node.id));
allows('Admin reads users', () => api.users(admin));
allows('Admin changes a user role', () => api.setUserRoles(admin, 'usr_3', ['student', 'delivery_partner']));
allows('Admin suspends a user', () => api.setUserStatus(admin, 'usr_3', 'suspended'));
allows('Admin reinstates a user', () => api.setUserStatus(admin, 'usr_3', 'active'));
allows('Admin verifies a partner', () => api.verifyPartner(admin, 'usr_3', true));
allows('Admin reads every order', () => api.allOrders(admin));
allows('Admin inspects an order with its event history', () => api.inspectOrder(admin, 'F1842'));
ok(api.inspectOrder(admin, 'F1842').events.length >= 2, 'Order inspection returns the event trail');
allows('Admin changes the delivery fee', () => api.setPricing(admin, 'delivery_fee_paise', 1500));
allows('Admin changes partner payout', () => api.setPricing(admin, 'partner_base_payout_paise', 1000));

console.log('\n== SHOPKEEPER: Frisco owner CAN, on Frisco only ==');
const fItem = ITEMS.find((i) => i.caf === 'caf_frisco' && i.active);
allows('Frisco owner edits Frisco menu', () => api.updateItem(frisco, fItem.id, { desc: fItem.desc }));
let fNew;
allows('Frisco owner adds Frisco food', () => { fNew = api.createItem(frisco, 'caf_frisco', { name: 'Test Wrap', price: 70, cat: 'Burgers' }); });
allows('Frisco owner changes Frisco price', () => api.updateItem(frisco, fNew.id, { price: 75 }));
ok(ITEMS.find((i) => i.id === fNew.id).price === 7500, 'Owner price change applied (₹75)');
allows('Frisco owner updates a Frisco food photo', () => api.setItemPhoto(frisco, fNew.id, { dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', alt: 'Wrap' }));
allows('Frisco owner sets Frisco availability', () => api.setAvailability(frisco, fNew.id, false));
allows('Frisco owner deactivates Frisco food', () => api.archiveItem(frisco, fNew.id));
allows('Frisco owner manages Frisco hours', () => api.updateVendor(frisco, 'caf_frisco', { hours: { opens: '08:00', closes: '18:00' } }));
allows('Frisco owner reads Frisco orders', () => api.orders(frisco));

console.log('\n== SHOPKEEPER: Frisco owner CANNOT reach other outlets ==');
const cItem = ITEMS.find((i) => i.caf === 'caf_chai');
const tItem = ITEMS.find((i) => i.caf === 'caf_tulips');
denies('Frisco owner edits Chai Garam food', () => api.updateItem(frisco, cItem.id, { desc: 'x' }));
denies('Frisco owner edits Tulips food', () => api.updateItem(frisco, tItem.id, { desc: 'x' }));
denies('Frisco owner changes a Tulips price', () => api.updateItem(frisco, tItem.id, { price: 1 }));
denies('Frisco owner uploads a Tulips photo', () => api.setItemPhoto(frisco, tItem.id, { dataUrl: 'data:image/png;base64,AA' }));
denies('Frisco owner archives Tulips food', () => api.archiveItem(frisco, tItem.id));
denies('Frisco owner adds food to Chai Garam', () => api.createItem(frisco, 'caf_chai', { name: 'X', price: 10 }));
denies('Frisco owner edits the Tulips outlet', () => api.updateVendor(frisco, 'caf_tulips', { is_open: false }));
denies('Frisco owner reads Tulips orders', () => authorize(frisco, 'order.read', 'caf_tulips'));
denies('Frisco owner hits a Tulips resource URL directly', () => requireVendorAccess(frisco, 'caf_tulips'));
ok(api.orders(frisco).every((o) => o.caf === 'caf_frisco'), 'Row isolation: owner order list contains only own rows');
ok(api.vendors(frisco).every((v) => v.id === 'caf_frisco'), 'Row isolation: owner vendor list contains only own outlet');

console.log('\n== SHOPKEEPER: admin-only settings are refused ==');
denies('Frisco owner creates a cafeteria', () => api.createVendor(frisco, { name: 'Rogue' }));
denies('Frisco owner archives their own outlet', () => api.archiveVendor(frisco, 'caf_frisco'));
denies('Frisco owner edits campus locations', () => api.createNode(frisco, { kind: 'zone', name: 'Rogue zone' }));
denies('Frisco owner reads platform users', () => api.users(frisco));
denies('Frisco owner changes platform pricing', () => api.setPricing(frisco, 'delivery_fee_paise', 1));
denies('Frisco owner reads all orders', () => api.allOrders(frisco));
denies('Frisco owner verifies a partner', () => api.verifyPartner(frisco, 'usr_3', true));
denies('Chai owner edits Frisco food', () => api.updateItem(chai, fItem.id, { desc: 'x' }));

console.log('\n== CAFETERIA STAFF ==');
allows('Staff toggles availability at own outlet', () => api.setAvailability(staff, fItem.id, true));
allows('Staff transitions an order at own outlet', () => api.transitionOrder(staff, 'F1842', 'preparing'));
denies('Staff changes a price', () => api.updateItem(staff, fItem.id, { price: 1 }));
denies('Staff adds food', () => api.createItem(staff, 'caf_frisco', { name: 'X', price: 1 }));
denies('Staff uploads a photo', () => api.setItemPhoto(staff, fItem.id, { dataUrl: 'data:image/png;base64,AA' }));
denies('Staff archives food', () => api.archiveItem(staff, fItem.id));
denies('Staff manages staff', () => authorize(staff, 'staff.manage', 'caf_frisco'));
denies('Staff touches another outlet', () => api.setAvailability(staff, cItem.id, false));

console.log('\n== STUDENT ==');
denies('Student edits food', () => api.updateItem(student, fItem.id, { desc: 'x' }));
denies('Student changes a price', () => api.updateItem(student, fItem.id, { price: 1 }));
denies('Student adds food', () => api.createItem(student, 'caf_frisco', { name: 'X', price: 1 }));
denies('Student uploads a food photo', () => api.setItemPhoto(student, fItem.id, { dataUrl: 'data:image/png;base64,AA' }));
denies('Student edits a cafeteria', () => api.updateVendor(student, 'caf_frisco', { is_open: false }));
denies('Student creates a cafeteria', () => api.createVendor(student, { name: 'X' }));
denies('Student edits campus locations', () => api.createNode(student, { kind: 'zone', name: 'X' }));
denies('Student reads platform users', () => api.users(student));
denies('Student reads all orders', () => api.allOrders(student));
denies('Student changes platform pricing', () => api.setPricing(student, 'delivery_fee_paise', 0));
ok(!SURFACE_ROLES.admin.includes('student'), 'Student role is not on the admin surface list');
ok(!SURFACE_ROLES.counter.includes('student'), 'Student role is not on the counter surface list');

console.log('\n== DELIVERY PARTNER ==');
denies('Partner edits a menu', () => api.updateItem(partnerOnly, fItem.id, { desc: 'x' }));
denies('Partner changes a price', () => api.updateItem(partnerOnly, fItem.id, { price: 1 }));
denies('Partner reaches admin capabilities', () => api.createVendor(partnerOnly, { name: 'X' }));
denies('Partner reads platform users', () => api.users(partnerOnly));
denies("Partner reads another partner's record", () => authorize(partnerOnly, 'delivery.read', 'usr_other'));
allows('Partner reads their own delivery record', () => authorize(partnerOnly, 'delivery.read', 'usr_p'));
ok(!SURFACE_ROLES.admin.includes('delivery_partner'), 'Partner role is not on the admin surface list');

console.log('\n== MULTI-ROLE ==');
ok((student.roles || []).length === 2, 'Ayush holds student + delivery_partner');
allows('Multi-role user keeps the union of their capabilities', () => authorize(student, 'delivery.accept', 'usr_1'));
denies('Multi-role user gains nothing extra', () => api.users(student));

console.log('\n== SUPPORT ==');
allows('Support reads all orders', () => api.allOrders(support));
allows('Support inspects an order', () => api.inspectOrder(support, 'F1842'));
denies('Support edits a menu', () => api.updateItem(support, fItem.id, { desc: 'x' }));
denies('Support creates a cafeteria', () => api.createVendor(support, { name: 'X' }));
denies('Support changes campus locations', () => api.createNode(support, { kind: 'zone', name: 'X' }));

console.log('\n== PLATFORM OWNER vs ADMIN ==');
const owner = { id: 'usr_owner_primary', name: 'Owner', role: 'platform_owner', roles: ['platform_owner'] };
allows('Owner may grant admin', () => authorize(owner, 'admin.grant'));
denies('Admin may not grant admin', () => authorize(admin, 'admin.grant'));
denies('Admin cannot promote someone to platform_admin', () => api.setUserRoles(admin, 'usr_3', ['platform_admin']));
allows('Owner can promote someone to platform_admin', () => api.setUserRoles(owner, 'usr_3', ['platform_admin']));
api.setUserRoles(owner, 'usr_3', ['student']);   // restore

console.log('\n== HISTORICAL ORDERS ARE IMMUTABLE ==');
const burger = ITEMS.find((i) => i.id === 'itm_vb');
const past = ORDER_HISTORY.find((o) => o.code === 'F1799');
const lineBefore = past.items.find((x) => x.id === 'itm_vb');
const snapshotBefore = lineBefore.unit;
const totalBefore = past.total;
ok(snapshotBefore === 9000, `Historical line holds its own unit price (₹${snapshotBefore / 100})`);
api.updateItem(frisco, 'itm_vb', { price: 95 });
ok(burger.price === 9500, 'Menu price changed to ₹95');
ok(lineBefore.unit === snapshotBefore, `Historical unit price unchanged (still ₹${lineBefore.unit / 100})`);
ok(past.total === totalBefore, `Historical total unchanged (still ₹${past.total / 100})`);
ok(lineBefore.name === 'Veg Burger', 'Historical line keeps its own item name snapshot');
api.archiveItem(frisco, 'itm_vb');
ok(lineBefore.unit === snapshotBefore && lineBefore.name === 'Veg Burger', 'Archiving the item does not disturb history');
api.restoreItem(frisco, 'itm_vb');
api.updateItem(frisco, 'itm_vb', { price: 90 });
api.archiveVendor(admin, 'caf_frisco');
ok(past.cafName === 'Frisco', 'Archiving the whole outlet does not disturb history');
api.restoreVendor(admin, 'caf_frisco');

console.log('\n== ROLE REGISTRY ==');
for (const r of ['student', 'delivery_partner', 'vendor_staff', 'vendor_owner', 'platform_admin', 'support', 'platform_owner']) {
  ok(!!ROLES[r], `Role defined: ${r}`);
}

console.log(`\n${fails === 0 ? `ALL ${count} CHECKS PASSED` : `${fails} of ${count} FAILED`}`);
process.exit(fails ? 1 : 0);
