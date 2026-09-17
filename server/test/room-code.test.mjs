/* ==========================================================================
   UPES BIDHOLI ROOM PLATE CODES

   The convention is <block><floor><room>, read from the right: the last two
   digits are the room, the digit before them is the floor, everything before
   that is the block.

   The six worked examples below are the authoritative business rule. The rest
   of this file is about the other half of the job — that a plate nobody could
   read properly is REFUSED rather than turned into a plausible-looking
   destination. An invented room number is worse than a missing one: a missing
   one is visibly missing.
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomCode, parseRoomCodes, formatRoomLabel } from '../src/services/room-code.js';

/* ---------- the authoritative examples ------------------------------------- */

const CASES = [
  { code: '1001', block: 1, floor: 0, room: '01', label: 'Block 1, Room 01' },
  { code: '1006', block: 1, floor: 0, room: '06', label: 'Block 1, Room 06' },
  { code: '1104', block: 1, floor: 1, room: '04', label: 'Block 1, Floor 1, Room 04' },
  { code: '9204', block: 9, floor: 2, room: '04', label: 'Block 9, Floor 2, Room 04' },
  { code: '11011', block: 11, floor: 0, room: '11', label: 'Block 11, Room 11' },
  { code: '11012', block: 11, floor: 0, room: '12', label: 'Block 11, Room 12' },
];

for (const c of CASES) {
  test(`${c.code} parses to ${c.label}`, () => {
    const r = parseRoomCode(c.code);
    assert.equal(r.ok, true, `${c.code} should parse`);
    assert.equal(r.block, c.block);
    assert.equal(r.floor, c.floor);
    assert.equal(r.room, c.room);
    assert.equal(r.label, c.label);
    assert.equal(r.code, c.code, 'the original plate is preserved verbatim');
  });
}

test('2002 — the fourth confirmed plate', () => {
  const r = parseRoomCode('2002');
  assert.deepEqual(
    { ok: r.ok, block: r.block, floor: r.floor, room: r.room, label: r.label },
    { ok: true, block: 2, floor: 0, room: '02', label: 'Block 2, Room 02' },
  );
});

test('11217 parses, but parsing is not verification', () => {
  const r = parseRoomCode('11217');
  assert.equal(r.ok, true);
  assert.equal(r.block, 11);
  assert.equal(r.floor, 2);
  assert.equal(r.room, '17');
  assert.equal(r.label, 'Block 11, Floor 2, Room 17');
  /* This plate was read once at reduced resolution. The parser has no opinion
     about that; it stays UNCONFIRMED in the data, and migration 016 keeps an
     unconfirmed node undeliverable. */
});

/* ---------- a one-digit and a two-digit block never collide ----------------- */

test('block is taken from the left of a fixed three-digit tail, so 1104 is not block 11', () => {
  const four = parseRoomCode('1104');
  const five = parseRoomCode('11011');
  assert.equal(four.block, 1, '1104 is block 1, floor 1, room 04');
  assert.equal(five.block, 11, '11011 is block 11, floor 0, room 11');
});

test('the floor digit is what separates the examples that look alike', () => {
  assert.equal(parseRoomCode('1001').floor, 0);
  assert.equal(parseRoomCode('1104').floor, 1);
  assert.equal(parseRoomCode('9204').floor, 2);
});

/* ---------- floor 0 is never given a name ----------------------------------- */

test('a floor digit of 0 is reported but not labelled', () => {
  const r = parseRoomCode('1001');
  assert.equal(r.floor, 0);
  assert.equal(r.floorExplicit, false);
  assert.ok(!/floor/i.test(r.label), 'the label must not claim a floor the plate does not name');
  assert.ok(!/ground/i.test(r.label), 'and must not invent the word "Ground"');
});

test('a floor digit above 0 is labelled', () => {
  const r = parseRoomCode('9204');
  assert.equal(r.floorExplicit, true);
  assert.match(r.label, /Floor 2/);
});

/* ---------- malformed input is refused, never coerced ----------------------- */

const REFUSED = [
  ['200?', 'not_digits', 'the illegible plate photographed on a roller shutter'],
  ['', 'empty', 'empty string'],
  ['   ', 'empty', 'whitespace only'],
  [null, 'empty', 'null'],
  [undefined, 'empty', 'undefined'],
  ['101', 'wrong_length', 'three digits is too short to hold block, floor and room'],
  ['11', 'wrong_length', 'two digits'],
  ['123456', 'wrong_length', 'six digits would need a three-digit block'],
  ['01234', 'block_leading_zero', 'a zero-padded block would make two codes mean one block'],
  ['11O11', 'not_digits', 'letter O instead of zero — a classic misread'],
  ['1104a', 'not_digits', 'trailing letter'],
  ['11-011', 'not_digits', 'punctuation'],
  ['1.104', 'not_digits', 'decimal point'],
  ['-1104', 'not_digits', 'negative'],
];

for (const [input, reason, why] of REFUSED) {
  test(`refuses ${JSON.stringify(input)} — ${why}`, () => {
    const r = parseRoomCode(input);
    assert.equal(r.ok, false, 'must not parse');
    assert.equal(r.reason, reason);
    assert.ok(r.message && r.message.length > 0, 'a refusal carries a reason a human can act on');
    assert.equal(r.block, undefined, 'no block is guessed');
    assert.equal(r.floor, undefined, 'no floor is guessed');
    assert.equal(r.room, undefined, 'no room is guessed');
  });
}

test('surrounding whitespace is tolerated, inner characters are not', () => {
  assert.equal(parseRoomCode('  11011  ').ok, true);
  assert.equal(parseRoomCode('11 011').ok, false);
});

test('a number is accepted as well as a string', () => {
  const r = parseRoomCode(1104);
  assert.equal(r.ok, true);
  assert.equal(r.block, 1);
  assert.equal(r.floor, 1);
  assert.equal(r.room, '04');
});

test('the room keeps its leading zero rather than becoming a number', () => {
  const r = parseRoomCode('1001');
  assert.equal(r.room, '01');
  assert.notEqual(r.room, 1);
  assert.equal(typeof r.room, 'string');
});

/* ---------- batches keep the refusals visible ------------------------------- */

test('a batch separates usable plates from refused ones and loses nothing', () => {
  const input = ['1001', '200?', '11011', '123456', '9204'];
  const { parsed, refused } = parseRoomCodes(input);
  assert.equal(parsed.length, 3);
  assert.equal(refused.length, 2);
  assert.equal(parsed.length + refused.length, input.length, 'nothing is dropped silently');
  assert.deepEqual(parsed.map((r) => r.code), ['1001', '11011', '9204']);
  assert.deepEqual(refused.map((r) => r.code), ['200?', '123456']);
});

/* ---------- the label helper ------------------------------------------------ */

test('formatRoomLabel omits floor 0 and includes any other floor', () => {
  assert.equal(formatRoomLabel({ block: 11, floor: 0, room: '11' }), 'Block 11, Room 11');
  assert.equal(formatRoomLabel({ block: 11, floor: 2, room: '17' }), 'Block 11, Floor 2, Room 17');
});

/* ---------- every plate in the committed evidence file ---------------------- */

test('every plate recorded as confirmed in the evidence CSV parses to its recorded parts', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const csv = readFileSync(join(here, '..', '..', 'docs', 'campus', 'bidholi-observed-room-codes.csv'), 'utf8');
  const lines = csv.split(/\r?\n/).filter((l) => l.trim()).slice(1);

  let checked = 0;
  for (const line of lines) {
    const [sourceCode, block, floor, room, confidence] = line.split(',');
    if (confidence !== 'confirmed') continue;      // probable/unresolved are not asserted
    const r = parseRoomCode(sourceCode);
    assert.equal(r.ok, true, `${sourceCode} should parse`);
    assert.equal(r.block, Number(block), `${sourceCode} block`);
    assert.equal(r.floor, Number(floor), `${sourceCode} floor`);
    assert.equal(r.room, room, `${sourceCode} room`);
    checked++;
  }
  assert.ok(checked >= 7, `expected at least 7 confirmed plates, checked ${checked}`);
});

test('the unresolved plate in the evidence CSV is not parseable, which is why it is unresolved', () => {
  assert.equal(parseRoomCode('200?').ok, false);
});
