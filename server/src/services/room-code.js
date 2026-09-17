/* ==========================================================================
   UPES BIDHOLI ROOM PLATE CODES

   A room plate at Bidholi encodes three things in one number:

       <block><floor><room>
                      └──── the LAST TWO digits are the room
               └─────────── the digit before them is the floor
       └────────────────── everything before that is the block

   Read from the right, so a one-digit block and a two-digit block both work
   without ambiguity:

       1001  ->  block 1,  floor 0, room 01      "Block 1, Room 01"
       1006  ->  block 1,  floor 0, room 06      "Block 1, Room 06"
       1104  ->  block 1,  floor 1, room 04      "Block 1, Floor 1, Room 04"
       2002  ->  block 2,  floor 0, room 02      "Block 2, Room 02"
       9204  ->  block 9,  floor 2, room 04      "Block 9, Floor 2, Room 04"
       11011 ->  block 11, floor 0, room 11      "Block 11, Room 11"
       11012 ->  block 11, floor 0, room 12      "Block 11, Room 12"
       11217 ->  block 11, floor 2, room 17      "Block 11, Floor 2, Room 17"

   A floor digit of 0 is not written into the label. The observed plates with
   a 0 there are at entrance level, but nothing in the evidence states what
   "0" is called, so this module does not name it. It reports `floor: 0` and
   `floorExplicit: false` and lets the label say only the block and the room.
   Calling it "Ground Floor" would be an invention.

   PARSING IS NOT VERIFICATION. This module turns a string into its parts and
   nothing more. Whether a plate was read correctly, whether that block is the
   block the caption suggested, and whether anybody may have food delivered
   there are all decided elsewhere:

     - a location is deliverable only when an administrator confirms it
       (migration 016: verification = 'confirmed' OR deliverable = false)
     - an unreadable or doubtful plate is stored UNCONFIRMED and is never
       promoted by this code

   Anything that is not exactly 4 or 5 digits is REFUSED rather than coerced.
   A refusal carries a reason so the importer can show it to a human.
   ========================================================================== */

/* Observed plates are 4 digits (one-digit block) or 5 (two-digit block).
   A 6-digit code would mean a three-digit block, which no evidence supports,
   so it is refused rather than guessed at. */
const MIN_DIGITS = 4;
const MAX_DIGITS = 5;

/** Parse a room plate. Returns `{ ok: true, ... }` or `{ ok: false, reason }`. */
export function parseRoomCode(input) {
  const raw = input === null || input === undefined ? '' : String(input);
  const code = raw.trim();

  if (!code) {
    return { ok: false, code: raw, reason: 'empty', message: 'No room code given.' };
  }
  if (!/^[0-9]+$/.test(code)) {
    return {
      ok: false,
      code,
      reason: 'not_digits',
      message: 'A room code is digits only. An unreadable plate must be recorded as unconfirmed, not guessed.',
    };
  }
  if (code.length < MIN_DIGITS || code.length > MAX_DIGITS) {
    return {
      ok: false,
      code,
      reason: 'wrong_length',
      message: `A room code is ${MIN_DIGITS} or ${MAX_DIGITS} digits (block, floor, then a two-digit room). This has ${code.length}.`,
    };
  }

  const room = code.slice(-2);
  const floor = Number(code.slice(-3, -2));
  const blockDigits = code.slice(0, -3);

  /* "01234" would be a block "01". Block numbers are not zero-padded on any
     observed plate, and accepting it would make two codes mean one block. */
  if (blockDigits.startsWith('0')) {
    return {
      ok: false,
      code,
      reason: 'block_leading_zero',
      message: 'The block part starts with 0, which no observed plate does.',
    };
  }

  const block = Number(blockDigits);
  if (!Number.isInteger(block) || block < 1) {
    return { ok: false, code, reason: 'block_out_of_range', message: 'The block part is not a positive number.' };
  }

  return {
    ok: true,
    code,
    block,
    floor,
    /* false when the plate's floor digit is 0 — see the header. */
    floorExplicit: floor > 0,
    room,
    label: formatRoomLabel({ block, floor, room }),
  };
}

/** "Block 1, Room 01" / "Block 9, Floor 2, Room 04". */
export function formatRoomLabel({ block, floor, room }) {
  const parts = [`Block ${block}`];
  if (floor > 0) parts.push(`Floor ${floor}`);
  parts.push(`Room ${room}`);
  return parts.join(', ');
}

/**
 * Parse a batch and split it into usable and refused, keeping the original
 * string on both sides. Callers import only `parsed`; `refused` is shown to an
 * administrator to re-read on site. Nothing is dropped silently.
 */
export function parseRoomCodes(codes) {
  const parsed = [];
  const refused = [];
  for (const c of codes) {
    const r = parseRoomCode(c);
    (r.ok ? parsed : refused).push(r);
  }
  return { parsed, refused };
}
