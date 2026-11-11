/* ==========================================================================
   QUAD — COLLECTION PROVIDERS: shared helpers

   Money conversion, error shaping and constant-time comparison used by every
   collection adapter. Nothing in here names a gateway, and nothing in here
   touches the database: an adapter reports what its provider said, and the
   caller decides what that means against the ledger.
   ========================================================================== */
import { timingSafeEqual } from 'node:crypto';

/* ---------- exact money conversion --------------------------------------
   Integer paise in, decimal-rupee STRING out. No float multiplication, no
   toFixed on a computed double. `11500` -> "115.00". */
export function paiseToRupeeString(paise) {
  if (!Number.isInteger(paise) || paise < 0) {
    throw new Error(`paiseToRupeeString: not a non-negative integer paise value: ${paise}`);
  }
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

/* The inverse, and the more dangerous direction: this reads a number a
   provider chose. It is deliberately strict — anything that is not a plain
   decimal with at most two places is refused rather than coerced, because a
   silently coerced amount is a silently wrong settlement. Returns null on
   anything it will not vouch for, and null never compares equal to an
   expected amount, so an unparseable amount fails closed. */
export function rupeesToPaise(value) {
  if (value === null || value === undefined) return null;
  /* A JSON number is accepted only when it is exactly representable to two
     decimal places; 115 and 115.5 are fine, 115.005 is not. */
  const s = typeof value === 'number'
    ? (Number.isFinite(value) ? value.toFixed(3) : '')
    : String(value).trim();
  const m = /^(\d{1,12})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] || '').padEnd(3, '0');
  /* A third decimal place that is not zero is a real amount we cannot
     represent. Refuse it instead of rounding someone's money. */
  if (frac[2] !== '0') return null;
  return Number(m[1]) * 100 + Number(frac.slice(0, 2));
}


export function providerError(name, res, text) {
  const err = new Error(`${name} ${res.status}: ${String(text).slice(0, 300)}`);
  err.providerStatus = res.status;
  err.retryable = res.status === 429 || res.status >= 500;
  return err;
}

/* Constant-time compare that does not leak length through an early return
   shape different from a mismatch. */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) {
    /* Still do a compare so timing does not distinguish "wrong length" from
       "wrong bytes"; the result is discarded. */
    timingSafeEqual(y, y);
    return false;
  }
  return timingSafeEqual(x, y);
}

/* Cashfree's order_note: plain text, at most 200 characters. The café name is
   reduced to letters, digits and simple punctuation, so one accented
   character can never get an order refused ("Café Frisco" -> "Cafe Frisco"). */
export function orderNote(code, vendorName) {
  const cafe = String(vendorName || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9 &'.-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cafe ? `ECHO ECHO order ${code} from ${cafe}` : `ECHO ECHO order ${code}`;
}
