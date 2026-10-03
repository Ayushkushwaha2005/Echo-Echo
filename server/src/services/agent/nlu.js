/* ==========================================================================
   ECHO ECHO — ASK ECHO ECHO: LANGUAGE UNDERSTANDING

   The ordering assistant runs on ECHO ECHO's own server with no model API
   behind it. This file turns what a student types — English, Hindi in Latin
   script, or the mix of both most of campus actually writes — into
   structured requests: which items, how many, from which café, delivered or
   collected, confirm or change. It reads the LIVE menu passed in by the
   caller and knows nothing about dishes on its own: every item it can name
   is a row the server just read.

   Pure functions only. The conversation logic is in engine.js.
   ========================================================================== */

/* ---- text ---------------------------------------------------------------- */

export function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')    // café -> cafe
    .replace(/[’'`]/g, '')
    .replace(/(\d)\s*[x×*]\b/g, '$1 ')                     // 2x -> 2
    .replace(/\b[x×*]\s*(\d)/g, ' $1')                     // x2 -> 2
    .replace(/[^a-z0-9₹&+,;.?!/ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const tokens = (s) => normalise(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);

/* A word's plain form for matching: "sandwiches" ~ "sandwich", "momos" ~
   "momo", and the spellings students actually type for the same thing. */
const SPELLING = {
  tea: 'chai', chay: 'chai', chaai: 'chai', chaay: 'chai',
  coffe: 'coffee', cofee: 'coffee', kofi: 'coffee', coffie: 'coffee',
  sandwhich: 'sandwich', sandwitch: 'sandwich', sandwic: 'sandwich', sanwich: 'sandwich',
  maggie: 'maggi', magi: 'maggi', maagi: 'maggi',
  frys: 'fries', fry: 'fries', chips: 'fries',
  panir: 'paneer', paner: 'paneer',
  chiken: 'chicken', chikn: 'chicken', chkn: 'chicken',
  elaichi: 'elaichi', ilaichi: 'elaichi', elachi: 'elaichi', ilaychi: 'elaichi',
  adrak: 'adrak', adrakh: 'adrak', ginger: 'adrak',
  kulhad: 'kulhad', kulhar: 'kulhad', kullad: 'kulhad', kulad: 'kulhad',
  thanda: 'cold', thandi: 'cold',
};
export function stem(w) {
  let s = SPELLING[w] || w;
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && /(ch|sh|x)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return SPELLING[s] || s;
}

/* Damerau-Levenshtein distance, capped: only small typos are ever accepted. */
function distance(a, b, cap = 2) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Whether two words are the same word, allowing a typo in a long one. */
export function sameWord(a, b) {
  const x = stem(a), y = stem(b);
  if (x === y) return true;
  if (/\d/.test(x) || /\d/.test(y)) return false;
  const n = Math.min(x.length, y.length);
  if (n < 4) return false;
  return distance(x, y) <= (n >= 7 ? 2 : 1);
}

/* ---- numbers ----------------------------------------------------------- */

const NUMBER = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  couple: 2, single: 1,
  ek: 1, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, che: 6,
  saat: 7, sat: 7, aath: 8, ath: 8, nau: 9, das: 10,
};
const ORDINAL = {
  first: 1, '1st': 1, pehla: 1, pehli: 1, pahla: 1, pahli: 1, pehle: 1,
  second: 2, '2nd': 2, doosra: 2, dusra: 2, doosri: 2, dusri: 2,
  third: 3, '3rd': 3, teesra: 3, tisra: 3, teesri: 3,
  fourth: 4, '4th': 4, chautha: 4, fifth: 5, '5th': 5, last: -1, aakhri: -1,
};

/* Words that carry no item meaning in an order. "do" is Hindi for two, and
   also the "give" in "bhej do": it is only a number when an item follows. */
export const FILLER = new Set(`
  i im me my mujhe mereko muje mujhko humko hume hum we us please pls plz plss kindly bhai bro yaar
  dost sir want wanna need needs would like love get give gimme can could will lets let have
  chahiye chaiye chahie chaahiye chiye mangta mangao manga mangwa mangwana mangwao
  de dena dedo dijiye dijie do dona la lao laa lana lado bhej bhejo bhejna bhejdo bhijwa bhijwao
  order orders karo kar kardo krdo krna karna kr kijiye karde karden
  the a an some for of to at in on pe par per mein mai ko ka ki ke se from with
  hai h hain ho tha thi bhi just only also and aur plus then fir phir or
  plate plates pcs pc piece pieces cup cups glass glasses nos no number qty quantity
  ok okay hello hi hey please yes yeah haan han ha
  dunga dungi lunga lungi lenge denge karunga karungi jaunga jaungi chalega chalegi bhi toh to
  haal chaal kaise kaisa kaisi kaisey sup hii heyy
  kam less more extra zyada jyada aur hata hatao hatado nikal nikaal nikalo remove delete minus drop
  make change instead bas sirf
`.split(/\s+/).filter(Boolean));
/* Kept as content when they are part of a dish name the menu actually has
   ("Green Tea with Lemon Honey", "Hot and Sour Soup"). */
const SOFT = new Set(['with', 'and']);

export function quantityAt(toks, i) {
  const t = toks[i];
  if (/^\d{1,3}$/.test(t)) return Number(t);
  if (t === 'do') {
    /* "do cold coffee" = 2; "bhej do", "de do", trailing "do" = give. */
    const prev = toks[i - 1], next = toks[i + 1];
    if (!next || FILLER.has(next) || ['de', 'bhej', 'kar', 'la', 'karo', 'dedo'].includes(prev)) return null;
    return 2;
  }
  return NUMBER[t] ?? null;
}

/* ---- the menu as something to match against ----------------------------- */

/** Precompute an item's matchable words: the name without "(5 pcs)" etc. */
export function indexItem(item) {
  const names = [item.name, ...(item.aliases || [])];
  return {
    ...item,
    keys: names.map((n) => tokens(String(n).replace(/\([^)]*\)/g, ' ')).filter((w) => !FILLER.has(w) || SOFT.has(w)))
      .filter((k) => k.length),
  };
}

/**
 * Score one phrase against one item. Recall: how much of the dish's name the
 * student said. Precision: how much of what they said is the dish.
 */
function score(words, item) {
  let best = { f: 0, recall: 0, precision: 0 };
  for (const key of item.keys) {
    const significant = key.filter((w) => !SOFT.has(w));
    const hitKey = key.filter((k) => words.some((w) => sameWord(w, k)));
    const hitWords = words.filter((w) => key.some((k) => sameWord(w, k)));
    if (!hitKey.some((k) => !SOFT.has(k))) continue;   // "with" alone is not a match
    const recall = hitKey.length / key.length;
    const precision = words.length ? hitWords.length / words.length : 0;
    const f = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
    /* A one-word dish ("Chamomile") said in full is exact even if the
       student added a word we do not know. */
    const bonus = significant.length && significant.every((k) => words.some((w) => sameWord(w, k))) ? 0.05 : 0;
    if (f + bonus > best.f) best = { f: f + bonus, recall, precision };
  }
  return best;
}

/**
 * Find what a phrase means on the given menu.
 *   { kind: 'match', item } | { kind: 'ambiguous', options } | { kind: 'none', near }
 */
export function matchItem(words, items) {
  const content = words.filter((w) => !FILLER.has(w) || SOFT.has(w));
  if (!content.filter((w) => !SOFT.has(w)).length) return { kind: 'none', near: [] };
  const ranked = items.map((item) => ({ item, ...score(content, item) }))
    .filter((r) => r.f > 0).sort((a, b) => b.f - a.f || a.item.price_paise - b.item.price_paise);
  if (!ranked.length) return { kind: 'none', near: [] };
  const [top, second] = ranked;
  const exact = ranked.filter((r) => r.recall === 1 && r.precision === 1);
  if (exact.length === 1) return { kind: 'match', item: exact[0].item };
  if (top.f >= 0.5 && (!second || top.f - second.f >= 0.15) && top.recall >= 0.5) return { kind: 'match', item: top.item };
  const close = ranked.filter((r) => r.f >= Math.max(0.4, top.f - 0.15));
  if (close.length && top.f >= 0.4) return { kind: 'ambiguous', options: close.slice(0, 6).map((r) => r.item) };
  return { kind: 'none', near: ranked.slice(0, 3).map((r) => r.item) };
}

/* ---- splitting an order into its parts ---------------------------------- */

const SEPARATOR = /\s*(?:,|;|\+|&|\band\b|\baur\b|\bplus\b|\balso\b|\bthen\b|\bphir\b|\bfir\b|\bsath\b|\bsaath\b)\s*/;

/**
 * "2 cold coffee aur ek veg sandwich chahiye" ->
 *   [{ qty: 2, words: ['cold','coffee'] }, { qty: 1, words: ['veg','sandwich'] }]
 * Dish names that themselves contain a separator ("Hot and Sour Soup") are
 * protected first, using the menu the caller passes in.
 */
export function segments(text, items = []) {
  let s = normalise(text);
  const protectedNames = items.map((i) => normalise(String(i.name).replace(/\([^)]*\)/g, ' ')).trim())
    .filter((n) => SEPARATOR.test(` ${n} `) && /\s/.test(n));
  for (const n of protectedNames) s = s.replace(n, n.replace(/ /g, '_'));
  const parts = s.split(SEPARATOR).flatMap((p) => p.split(/[.?!]+/));
  const out = [];
  let carry = null;
  for (const part of parts) {
    const toks = part.replace(/_/g, ' ').replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);
    /* "2 cold coffee 1 sandwich" has no separator: split at each number
       that follows other words. */
    let cur = { qty: null, words: [] };
    const flush = () => { if (cur.words.length || cur.qty !== null) out.push(cur); cur = { qty: null, words: [] }; };
    toks.forEach((t, i) => {
      const n = quantityAt(toks, i);
      if (n !== null) {
        const named = cur.words.some((w) => !FILLER.has(w));
        /* "veg nuggets 2": a number after the dish, with nothing named
           after it, is that dish's quantity. */
        const restNamed = toks.slice(i + 1).some((t, k) => !FILLER.has(t) && quantityAt(toks, i + 1 + k) === null);
        if (named && cur.qty === null && !restNamed) { cur.qty = n; return; }
        if (named) flush();
        if (cur.qty === null) cur.qty = n;
        return;
      }
      cur.words.push(t);
    });
    flush();
  }
  /* A bare number ("ek aur") belongs to the next part that names something. */
  const merged = [];
  for (const seg of out) {
    const named = seg.words.some((w) => !FILLER.has(w) || SOFT.has(w));
    if (!named) { carry = seg.qty ?? carry; continue; }
    merged.push({ qty: seg.qty ?? carry ?? null, words: seg.words });
    carry = null;
  }
  if (carry !== null) merged.push({ qty: carry, words: [] });
  return merged;
}

/* ---- what kind of message is this --------------------------------------- */

const has = (s, re) => re.test(` ${s} `);
export const INTENT = {
  greeting: (s) => has(s, /^ (hi|hii+|hello|hey|heyy+|namaste|namaskar|yo|hola|good (morning|afternoon|evening)|kya haal|sup) /) &&
    tokens(s).length <= 4,
  thanks: (s) => has(s, / (thanks|thank you|thank u|thanku|thx|ty|shukriya|dhanyavad|dhanyawad) /),
  reset: (s) => has(s, /^ (clear|reset|start over|start again|new order|cancel|cancel (it|all|everything|order|the order)|sab (hata|cancel|hatao)|kuch nahi chahiye|rehne do|chhodo|chodo)( do| karo| kar do)? $/),
  yes: (s) => has(s, / (yes|y|yeah|yep|yup|ya|yah|haan|haa|han|ha|hanji|haanji|ji|ok|okay|okk|k|sure|confirm|confirmed|checkout|check out|continue|proceed|done|go ahead|theek hai|thik hai|thik h|theek h|chalo|chal|perfect|place it|order it|order kar do|kar do|book) /),
  no: (s) => has(s, /^ (no|nope|nah|nahi|nahin|na|not now|ruko|wait|abhi nahi|mat karo)( |$)/),
  menu: (s) => has(s, / (menu|kya kya|kya hai|kya milta|kya milega|what do you have|whats there|what is there|whats available|what is available|options|show me|dikhao|dikha do|list) /),
  price: (s) => has(s, / (kitne|kitna|kitni|kitne ka|price|prices|cost|costs|how much|rate|rates|kya rate|daam) /),
  remove: (s) => has(s, / (remove|hata|hatao|hata do|hatado|nikal|nikaal|nikalo|delete|minus|drop|nahi chahiye|nai chahiye|mat bhejo|without|cancel|kam karo|kam kar do|kam kardo|kam|less) /),
  setQty: (s) => has(s, / (make it|make that|change to|kar do|karo|instead) /),
  pickup: (s) => has(s, / (pickup|pick up|pick it up|collect|le lunga|le jaunga|le lungi|le jaungi|khud|takeaway|take away|self pickup|counter se) /),
  delivery: (s) => has(s, / (deliver|delivery|bhej|bhejo|bhejdo|bhej do|bhejna|room pe|room par|hostel|block|ground pe|library|bhijwa) /),
  policy: (s) => has(s, / (discount|coupon|promo|free|sasta|cheaper|price kam|kam price|daam kam|refund|paise wapas|money back|assign|partner|change (the )?(price|timing|time)|skip payment|without paying|pay later|cash) /),
  status: (s) => has(s, / (where is my order|order status|kab aayega|kab ayega|kahan hai|track) /),
};

/** "1", "the second one", "pehla", or an option's own name. */
export function pickOption(text, options) {
  const toks = tokens(text);
  for (const t of toks) {
    if (/^\d$/.test(t) && Number(t) >= 1 && Number(t) <= options.length) return options[Number(t) - 1];
    if (t in ORDINAL) return ORDINAL[t] === -1 ? options[options.length - 1] : options[ORDINAL[t] - 1] || null;
  }
  const m = matchItem(toks.filter((t) => !/^\d+$/.test(t)), options.map(indexItem));
  return m.kind === 'match' ? options.find((o) => o.id === m.item.id) : null;
}

/** A café named in the message: its full name, or a word only it uses. */
export function mentionedVendor(text, vendors, items) {
  const toks = tokens(text);
  const itemWords = new Set(items.flatMap((i) => tokens(i.name).map(stem)));
  for (const v of vendors) {
    const words = tokens(v.name).filter((w) => !['cafe', 'canteen', 'the', 'stall', 'counter'].includes(w));
    const full = words.length && words.every((w) => toks.some((t) => sameWord(t, w)));
    const distinctive = words.filter((w) => !itemWords.has(stem(w)));
    if (full || distinctive.some((w) => toks.some((t) => sameWord(t, w)))) {
      return { vendor: v, words: new Set([...words, ...distinctive]) };
    }
  }
  return null;
}
