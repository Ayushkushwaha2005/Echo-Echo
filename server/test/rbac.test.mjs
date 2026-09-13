/* Authorization matrix. These are the rules that were previously only
   enforced in a browser bundle; each case here is one that a hand-crafted
   API request would otherwise get away with. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize, can, assertGrantable, landingSurface } from '../src/auth/rbac.js';

const VA = '11111111-1111-1111-1111-111111111111';
const VB = '22222222-2222-2222-2222-222222222222';

const actor = (roles, vendorIds = [], id = 'u1') => ({ id, roles, vendorIds, status: 'active' });
const owner   = actor(['platform_owner']);
const admin   = actor(['platform_admin']);
const support = actor(['support']);
const friscoOwner = actor(['vendor_owner'], [VA], 'u-frisco');
const friscoStaff = actor(['vendor_staff'], [VA], 'u-staff');
const student = actor(['student'], [], 'u-student');
const partner = actor(['student', 'delivery_partner'], [], 'u-partner');

test('admin can do everything on the platform matrix', () => {
  for (const a of ['vendor.create', 'menu.price', 'campus.archive', 'order.read_all',
                   'user.suspend', 'verification.decide', 'flags.update', 'audit.read']) {
    assert.ok(can(admin, a), `admin should hold ${a}`);
  }
});

test('shopkeeper may edit their own cafeteria', () => {
  assert.ok(can(friscoOwner, 'menu.price', { vendorId: VA }));
  assert.ok(can(friscoOwner, 'menu.create', { vendorId: VA }));
});

test('shopkeeper may NOT edit another cafeteria', () => {
  assert.throws(() => authorize(friscoOwner, 'menu.price', { vendorId: VB }), /not yours/);
  assert.throws(() => authorize(friscoOwner, 'menu.create', { vendorId: VB }), /not yours/);
});

test('a vendor-scoped action with no resource is refused, not waved through', () => {
  assert.throws(() => authorize(friscoOwner, 'menu.price', {}), /Scope check failed/);
});

test('counter staff may flip availability but not price', () => {
  assert.ok(can(friscoStaff, 'menu.availability', { vendorId: VA }));
  assert.throws(() => authorize(friscoStaff, 'menu.price', { vendorId: VA }), /cannot perform/);
});

test('student cannot reach admin or counter capabilities', () => {
  for (const a of ['user.role.grant', 'vendor.create', 'menu.price', 'order.read_all',
                   'verification.decide', 'flags.update']) {
    assert.throws(() => authorize(student, a, { vendorId: VA }), /cannot perform/, a);
  }
});

test('partner cannot edit menus and cannot read others deliveries', () => {
  assert.throws(() => authorize(partner, 'menu.update', { vendorId: VA }), /cannot perform/);
  assert.throws(() => authorize(partner, 'delivery.read', { ownerId: 'someone-else' }), /not yours/);
  assert.ok(can(partner, 'delivery.read', { ownerId: 'u-partner' }));
});

test('support can look but not reconfigure', () => {
  assert.ok(can(support, 'order.read_all'));
  assert.ok(can(support, 'audit.read'));
  assert.throws(() => authorize(support, 'menu.price', { vendorId: VA }), /cannot perform/);
  assert.throws(() => authorize(support, 'vendor.create'), /cannot perform/);
});

test('a suspended account is refused before any capability is considered', () => {
  const susp = { ...admin, status: 'suspended' };
  assert.throws(() => authorize(susp, 'order.read_all'), /suspended/);
});

test('an anonymous caller is 401, not 403', () => {
  assert.throws(() => authorize(null, 'order.read'), (e) => e.status === 401);
});

test('multi-role users get the union of capabilities', () => {
  const both = actor(['student', 'vendor_owner'], [VA]);
  assert.ok(can(both, 'order.create'));
  assert.ok(can(both, 'menu.price', { vendorId: VA }));
  assert.throws(() => authorize(both, 'menu.price', { vendorId: VB }), /not yours/);
});

/* --- privilege escalation --- */
test('platform_owner can never be granted over the API', () => {
  assert.throws(() => assertGrantable(owner, 'platform_owner'), /cannot be granted/);
  assert.throws(() => assertGrantable(admin, 'platform_owner'), /cannot be granted/);
});

test('an admin cannot grant platform roles — only the owner can', () => {
  assert.throws(() => assertGrantable(admin, 'platform_admin'), /Only the platform owner/);
  assert.throws(() => assertGrantable(admin, 'support'), /Only the platform owner/);
  assert.doesNotThrow(() => assertGrantable(owner, 'platform_admin'));
});

test('an admin may still grant vendor and partner roles', () => {
  assert.doesNotThrow(() => assertGrantable(admin, 'vendor_owner'));
  assert.doesNotThrow(() => assertGrantable(admin, 'delivery_partner'));
});

/* --- routing --- */
test('landing surface is derived from role rank, not chosen by the client', () => {
  assert.equal(landingSurface(['student']), 'web');
  assert.equal(landingSurface(['student', 'delivery_partner']), 'web');
  assert.equal(landingSurface(['vendor_owner']), 'counter');
  assert.equal(landingSurface(['vendor_staff']), 'counter');
  assert.equal(landingSurface(['support']), 'admin');
  assert.equal(landingSurface(['platform_admin']), 'admin');
  assert.equal(landingSurface(['platform_owner']), 'admin');
});
