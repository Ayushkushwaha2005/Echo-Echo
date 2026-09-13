/* Phone normalisation, the ID-verification triage rules, order-state
   machine legality, and the geo boundary test. All pure functions. */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused';

const { normalisePhone } = await import('../src/services/otp.js');
const { triage, assessQuality, extractFields } = await import('../src/services/verification.js');
const { pointInPolygon, metresBetween } = await import('../src/services/campus.js');
const { TRANSITIONS } = await import('../src/routes/orders.js');

/* ---------- phone ---------- */
test('phone numbers normalise to E.164', () => {
  assert.equal(normalisePhone('9876543210'), '+919876543210');
  assert.equal(normalisePhone('09876543210'), '+919876543210');
  assert.equal(normalisePhone('+91 98765 43210'), '+919876543210');
  assert.equal(normalisePhone('+44 7700 900123'), '+447700900123');
});

test('bad phone numbers are refused', () => {
  for (const bad of ['', '123', 'abcdefghij', '98765432101234567890', null]) {
    assert.throws(() => normalisePhone(bad));
  }
});

/* ---------- verification triage ---------- */
const goodQuality = { ok: true, notes: [] };

test('triage never returns approved — approval is a human act', () => {
  const cases = [
    [[], { status: 'match' }],
    [[], { status: 'skipped' }],
    [[{ level: 'good', code: 'roll_match' }], { status: 'match' }],
  ];
  for (const [signals, roster] of cases) {
    assert.notEqual(triage(signals, roster).state, 'approved');
  }
});

test('a clean submission with a roster match still only reaches pending', () => {
  const out = triage([{ level: 'good', code: 'roll_match' }], { status: 'match' });
  assert.equal(out.state, 'pending');
  assert.match(out.reason, /24 hours/);
});

test('high-severity signals force manual review', () => {
  for (const code of ['duplicate_image', 'roll_already_approved', 'roll_mismatch']) {
    const out = triage([{ level: 'high', code }], { status: 'match' });
    assert.equal(out.state, 'needs_review');
    assert.match(out.reason, new RegExp(code));
  }
});

test('a roster miss forces manual review', () => {
  assert.equal(triage([], { status: 'no_match' }).state, 'needs_review');
});

test('a skipped roster check does not become a pass', () => {
  const out = triage([], { status: 'skipped', reason: 'no_roster_source' });
  assert.equal(out.state, 'pending');   // pending, never approved
});

test('image quality gate rejects unusable submissions', () => {
  assert.equal(assessQuality({ bytes: 10_000, width: 900, height: 600 }).ok, false);
  assert.equal(assessQuality({ bytes: 300_000, width: 300, height: 200 }).ok, false);
  assert.equal(assessQuality({ bytes: 300_000, width: 1600, height: 1000 }).ok, true);
});

test('field extraction returns null rather than guessing', () => {
  const f = extractFields('SOME UNRELATED TEXT\nNO FIELDS HERE');
  assert.equal(f.name, null);
  assert.equal(f.roll, null);
  const g = extractFields('Name: Asha Verma\nRoll No: 23BCS1043\nUPES');
  assert.equal(g.name, 'Asha Verma');
  assert.equal(g.roll, '23BCS1043');
});

/* ---------- order state machine ---------- */
test('only the payment gateway can confirm an order', () => {
  assert.deepEqual(TRANSITIONS.confirmed.by, ['system']);
  assert.deepEqual(TRANSITIONS.confirmed.from, ['awaiting_payment']);
});

test('an order cannot skip from draft to delivered or confirmed', () => {
  assert.ok(!TRANSITIONS.delivered.from.includes('draft'));
  assert.ok(!TRANSITIONS.confirmed.from.includes('draft'));
  assert.ok(!TRANSITIONS.preparing.from.includes('draft'));
});

test('delivery requires having been picked up or ready', () => {
  for (const s of TRANSITIONS.delivered.from) {
    assert.ok(['picked_up', 'ready'].includes(s));
  }
});

/* ---------- campus geometry ---------- */
const square = [[10, 10], [10, 20], [20, 20], [20, 10]];

test('points inside and outside a boundary are distinguished', () => {
  assert.equal(pointInPolygon(15, 15, square), true);
  assert.equal(pointInPolygon(5, 15, square), false);
  assert.equal(pointInPolygon(15, 25, square), false);
  assert.equal(pointInPolygon(30, 30, square), false);
});

test('distance maths is sane', () => {
  assert.equal(Math.round(metresBetween([0, 0], [0, 0])), 0);
  const d = metresBetween([28.6141, 77.2094], [28.6151, 77.2094]);
  assert.ok(d > 100 && d < 120, `expected ~111m, got ${d}`);
});
