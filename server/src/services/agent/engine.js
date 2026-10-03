/* ==========================================================================
   ECHO ECHO — ASK ECHO ECHO: THE CONVERSATION

   A task-oriented dialogue agent that runs inside the API process: no model
   API, no external service, no per-message cost. It is an orchestrator over
   the server's own facts and never the source of any of them:

     menu, availability   the menu_item rows the route reads for this request
     café open/closed     statusOf(), the server's clock in campus time
     every rupee          quote() with the live pricing policy — the same
                          function that prices the real draft at checkout

   What it can produce is a PROPOSAL: items, quantities, café, pickup or
   delivery, and the server's figures for them. When the student says yes,
   it hands that proposal to the normal checkout screen, where the server
   builds the real draft (re-reading every price) and the student chooses
   the delivery spot and pays through the gateway. Nothing here writes to
   the database, takes payment, applies a discount, changes a price, a
   schedule, a permission, a delivery assignment or a ledger entry.

   State is rebuilt every request by replaying the student's own messages
   in order. Assistant turns sent by the browser are never read, so a
   crafted "the assistant said it costs ₹1" cannot enter the conversation.
   ========================================================================== */
import {
  normalise, tokens, segments, matchItem, indexItem, pickOption, mentionedVendor, INTENT, sameWord, stem, FILLER,
} from './nlu.js';

const money = (p) => `₹${(p / 100).toFixed(p % 100 ? 2 : 0)}`;
const MAX_QTY = 20;                // buildDraft refuses more on one line
const fresh = () => ({ vendorId: null, lines: [], fulfilment: null, stated: false, pending: null, last: null });

/**
 * Run a conversation.
 * @param userTexts  the student's messages, oldest first
 * @param ctx        { vendors, items, quote(vendorId, subtotalPaise, fulfilment), signedIn, orderBlock }
 * @returns          { reply, proposal, action, suggestions } for the last message
 */
export function converse(userTexts, ctx) {
  const items = ctx.items.map(indexItem);
  const world = {
    ...ctx, items,
    item: (id) => items.find((i) => i.id === id),
    vendor: (id) => ctx.vendors.find((v) => v.id === id),
    /* Café words that are also dish words ("chai" in Chai Garam). */
    itemWords: new Set(items.flatMap((i) => tokens(i.name).map(stem))),
  };
  let state = fresh();
  let out = null;
  for (const text of userTexts) ({ state, out } = step(state, String(text || '').slice(0, 500), world));
  return out || { reply: helpLine(), proposal: null, action: null, suggestions: [] };
}

const helpLine = () =>
  'Tell me what you want and how many, the way you would say it at the counter. For example: "2 cold coffee aur ek veg sandwich". You can also ask for the menu.';

/* ---- one message ---------------------------------------------------------- */

function step(prev, text, w) {
  let st = prev.done ? fresh() : { ...prev, lines: prev.lines.map((l) => ({ ...l })) };
  const s = normalise(text);
  const notes = [];
  const say = (reply, extra = {}) => ({ state: st, out: { reply, proposal: null, action: null, suggestions: [], ...extra } });

  if (!s) return say(helpLine());

  /* An answer to "which one did you mean?" */
  if (st.pending?.kind === 'pick') {
    const options = st.pending.options.map(w.item).filter(Boolean);
    /* "Tulips wali" picks the one option from that café. */
    const cafe = mentionedVendor(text, w.vendors, w.items)?.vendor;
    const fromCafe = cafe ? options.filter((o) => o.vendor_id === cafe.id) : [];
    const chosen = fromCafe.length === 1 ? fromCafe[0] : pickOption(text, options);
    if (chosen) {
      /* "2" here picks option 2; only "2 adrak chai" also says how many. */
      const named = segments(text, options).find((g) => g.qty && itemContent(g.words.join(' ')));
      const qty = named?.qty ?? st.pending.qty ?? 1;
      const queue = st.pending.queue || [];
      st.pending = null;
      add(st, chosen, qty, w, notes);
      if (queue.length) return askPick(st, queue[0], queue.slice(1), w, notes);
      return proposal(st, w, notes);
    }
  }

  if (INTENT.reset(s)) {
    st = fresh();
    return say('Okay, cleared. What would you like?');
  }

  const content = itemContent(s);
  if (st.pending?.kind === 'confirm' && INTENT.yes(s) && !content) return checkout(st, w);
  if (st.pending?.kind === 'confirm' && INTENT.no(s) && !content) {
    st.pending = null;
    return say('No problem. Tell me what to change: add something, take something out, or say pickup or delivery.',
      { suggestions: ['Show the menu'] });
  }

  if (INTENT.policy(s)) {
    /* A yes after this is not a yes to a discount: the figures are shown
       again first, unchanged, and confirmed from there. */
    if (st.pending?.kind === 'confirm') st.pending = null;
    return say('I can\'t change prices, add discounts, assign a delivery partner or issue refunds. Prices are exactly what the café charges, and payment always happens on the checkout screen. For a problem with an order, use Help on that order.');
  }
  if (INTENT.status(s)) {
    return say('Your orders and where they are right now are on the Orders tab.', { suggestions: ['Open my orders'] });
  }

  /* Pickup or delivery, said anywhere in the message. */
  if (INTENT.pickup(s)) { st.fulfilment = 'pickup'; st.stated = true; }
  else if (INTENT.delivery(s)) { st.fulfilment = 'delivery'; st.stated = true; }

  const named = mentionedVendor(text, w.vendors, w.items);
  let target = named?.vendor || null;
  /* A café with no menu yet cannot be ordered from; say so and look
     everywhere else instead of failing silently. */
  if (target && !w.items.some((i) => i.vendor_id === target.id) && !INTENT.menu(s)) {
    notes.push(`${target.name} hasn't put its menu on ECHO ECHO yet.`);
    target = null;
  }
  const stripped = named ? withoutVendor(text, named, w) : text;

  if (INTENT.menu(s)) return say(...menuReply(stripped, target || w.vendor(st.vendorId), w));

  const segs = segments(stripped, w.items).filter((g) => g.words.length || g.qty);
  const pool = target ? w.items.filter((i) => i.vendor_id === target.id)
    : st.vendorId ? w.items.filter((i) => i.vendor_id === st.vendorId) : w.items;

  if (!segs.some((g) => itemContent(g.words.join(' ')))) {
    /* A number with no dish is about the last one added: "make it 3" sets
       it, "ek aur" / "one more" adds to it. */
    const qty = segs.find((g) => g.qty)?.qty ?? (/ (another|one more) /.test(` ${s} `) ? 1 : null);
    if (qty && st.last && st.lines.some((l) => l.itemId === st.last)) {
      if (/ (aur|more|another|extra|bhi|add) /.test(` ${s} `) && !INTENT.setQty(s)) add(st, w.item(st.last), qty, w, notes);
      else setQty(st, w.item(st.last), qty, notes);
      return proposal(st, w, notes);
    }
    if (named && !st.lines.length) return say(...menuReply('', target, w));
    if (INTENT.thanks(s)) return say('Anytime.');
    if (INTENT.greeting(s)) return say(`Hi! What can I get you?\n\n${statusLines(w)}`, { suggestions: ['Show the menu'] });
    if ((INTENT.pickup(s) || INTENT.delivery(s)) && st.lines.length) return proposal(st, w, notes);
    if (INTENT.yes(s) && st.lines.length) return proposal(st, w, notes);
    return say(helpLine(), { suggestions: ['Show the menu'] });
  }

  const asking = INTENT.price(s) && !INTENT.yes(s);
  const removing = INTENT.remove(s);
  const setting = INTENT.setQty(s) && !removing;
  const picks = [];
  const priceLines = [];
  for (const g of segs) {
    if (!itemContent(g.words.join(' '))) continue;
    let m = matchItem(g.words, pool);
    /* Not on this café's menu: is it on another one? */
    if (m.kind === 'none' && pool !== w.items && !target) {
      const anywhere = matchItem(g.words, w.items);
      if (anywhere.kind === 'match') m = anywhere;
    }
    const phrase = g.words.filter((x) => itemContent(x)).join(' ');
    if (m.kind === 'none') {
      const near = m.near.filter((i) => i.available !== false).slice(0, 3);
      notes.push(`I couldn't find "${phrase}" on ${target ? target.name + '\'s' : 'the'} menu.${
        near.length ? ` Closest: ${near.map((i) => `${i.name} ${money(i.price_paise)}`).join(', ')}.` : ''}`);
      continue;
    }
    if (m.kind === 'ambiguous') { picks.push({ qty: g.qty, options: m.options.map((o) => o.id), phrase }); continue; }
    const item = m.item;
    if (asking) { priceLines.push(`${item.name}: ${money(item.price_paise)} at ${w.vendor(item.vendor_id)?.name}`); continue; }
    if (removing) { remove(st, item, g.qty, notes); continue; }
    if (setting && st.lines.some((l) => l.itemId === item.id) && g.qty) { setQty(st, item, g.qty, notes); continue; }
    add(st, item, g.qty ?? 1, w, notes);
  }

  if (asking) {
    const ambiguous = picks.map((p) => `${cap(p.phrase)}: ${p.options.map(w.item).map((i) => `${i.name} ${money(i.price_paise)}`).join(', ')}`);
    const lines = [...priceLines, ...ambiguous];
    return say([...lines, ...notes].join('\n') || helpLine());
  }
  /* Once the order has a café, a dish both cafés sell means this café's. */
  for (const p of picks) {
    if (!st.vendorId) continue;
    const here = p.options.filter((id) => w.item(id).vendor_id === st.vendorId);
    if (here.length) p.options = here;
  }
  for (const p of picks.filter((x) => x.options.length === 1 && !removing)) add(st, w.item(p.options[0]), p.qty ?? 1, w, notes);
  const open = picks.filter((x) => x.options.length > 1);
  if (open.length && !removing) return askPick(st, open[0], open.slice(1), w, notes);
  if (picks.length && removing) {
    const inBasket = picks[0].options.filter((id) => st.lines.some((l) => l.itemId === id));
    if (inBasket.length === 1) remove(st, w.item(inBasket[0]), picks[0].qty, notes);
    else notes.push(`Which ${picks[0].phrase} should I take out?`);
  }
  if (st.lines.length) return proposal(st, w, notes);
  return say(notes.join('\n') || helpLine(), { suggestions: ['Show the menu'] });
}

/* ---- the basket ------------------------------------------------------------- */

function add(st, item, qty, w, notes) {
  const vendor = w.vendor(item.vendor_id);
  if (st.vendorId && item.vendor_id !== st.vendorId) {
    notes.push(`${item.name} is from ${vendor?.name}, and this order is from ${w.vendor(st.vendorId)?.name}. One café per order: say "clear" to start a ${vendor?.name} order instead.`);
    return;
  }
  if (item.available === false) { notes.push(`${item.name} is sold out right now.`); return; }
  st.vendorId = item.vendor_id;
  const line = st.lines.find((l) => l.itemId === item.id);
  const next = Math.min(MAX_QTY, (line?.qty || 0) + Math.max(1, qty || 1));
  if ((line?.qty || 0) + (qty || 1) > MAX_QTY) notes.push(`${MAX_QTY} is the most of one item in a single order.`);
  if (line) line.qty = next; else st.lines.push({ itemId: item.id, qty: next });
  st.last = item.id;
}

function setQty(st, item, qty, notes) {
  const line = st.lines.find((l) => l.itemId === item.id);
  if (!line) return;
  line.qty = Math.min(MAX_QTY, Math.max(1, qty));
  if (qty > MAX_QTY) notes.push(`${MAX_QTY} is the most of one item in a single order.`);
  st.last = item.id;
}

function remove(st, item, qty, notes) {
  const line = st.lines.find((l) => l.itemId === item.id);
  if (!line) { notes.push(`${item.name} isn't in this order.`); return; }
  if (qty && qty < line.qty) line.qty -= qty;
  else st.lines = st.lines.filter((l) => l !== line);
  notes.push(qty && line.qty > 0 && st.lines.includes(line) ? `Okay, ${line.qty} × ${item.name} now.` : `Took out ${item.name}.`);
  if (!st.lines.length) { st.vendorId = null; st.pending = null; }
}

/* ---- replies --------------------------------------------------------------- */

function askPick(st, pick, queue, w, notes) {
  st.pending = { kind: 'pick', options: pick.options, qty: pick.qty, queue };
  const options = pick.options.map(w.item);
  if (st.lines.length) notes.push(`So far: ${st.lines.map((l) => `${l.qty} × ${w.item(l.itemId).name}`).join(', ')}.`);
  /* When the choices span cafés, say which café each one is from. */
  const many = new Set(options.map((i) => i.vendor_id)).size > 1;
  const list = options.map((i, n) => `${n + 1}. ${i.name} — ${money(i.price_paise)}${
    many ? ` (${w.vendor(i.vendor_id)?.name})` : ''}${i.available === false ? ' (sold out)' : ''}`).join('\n');
  return {
    state: st,
    out: {
      reply: [...notes, `Which ${pick.phrase}${pick.qty > 1 ? ` (${pick.qty})` : ''}?\n${list}`].join('\n\n'),
      proposal: null, action: null,
      suggestions: many ? [] : options.filter((i) => i.available !== false).slice(0, 4).map((i) => i.name),
    },
  };
}

/** The server's figures for what is in the basket now. */
export function priced(st, w) {
  const vendor = w.vendor(st.vendorId);
  const fulfilment = vendor?.delivery_enabled === false ? 'pickup' : (st.fulfilment || 'delivery');
  const lines = st.lines.map((l) => {
    const i = w.item(l.itemId);
    return { itemId: i.id, name: i.name, qty: l.qty, unit_paise: i.price_paise, line_paise: i.price_paise * l.qty };
  });
  const subtotal = lines.reduce((a, l) => a + l.line_paise, 0);
  const q = w.quote(vendor.id, subtotal, fulfilment);
  return { vendor, fulfilment, lines, quote: q };
}

function proposal(st, w, notes) {
  const { vendor, fulfilment, lines, quote: q } = priced(st, w);
  const body = [
    ...lines.map((l) => `${l.qty} × ${l.name} — ${money(l.line_paise)}`),
    '',
    `Food subtotal: ${money(q.food_subtotal_paise)}`,
    fulfilment === 'delivery' ? `Delivery: ${money(q.delivery_fee_paise)}` : 'Pickup: no delivery fee',
    `Platform fee: ${money(q.platform_fee_paise)}`,
    ...(q.tax_paise ? [`Tax: ${money(q.tax_paise)}`] : []),
    ...(q.commission_mode === 'charge_to_customer' && q.commission_paise ? [`Service charge: ${money(q.commission_paise)}`] : []),
    `Total: ${money(q.customer_total_paise)}`,
  ];
  const open = vendor.status?.open !== false;
  const how = vendor.delivery_enabled === false ? `${vendor.name} is pickup only.`
    : fulfilment === 'delivery'
      ? (st.stated ? 'Delivered on campus; you choose the exact spot at checkout.'
        : 'Delivered on campus; you choose the exact spot at checkout. Say "pickup" to collect it yourself.')
      : `You collect it from ${vendor.name}.`;
  st.pending = open ? { kind: 'confirm' } : null;
  const lead = [...notes, `${notes.length ? 'Your order' : 'Sure'}, from ${vendor.name}:`].join('\n\n');
  const tail = [how, open ? 'Want me to continue to checkout?' : closedLine(vendor)].join('\n\n');
  return {
    state: st,
    out: {
      reply: `${lead}\n${body.join('\n')}\n\n${tail}`,
      /* The same words, split around the bill so a screen can set the
         figures as a bill. The figures themselves are in `proposal`. */
      parts: { lead, tail },
      proposal: {
        vendorId: vendor.id, vendorName: vendor.name, open, fulfilment, lines,
        subtotal_paise: q.food_subtotal_paise, delivery_fee_paise: q.delivery_fee_paise,
        platform_fee_paise: q.platform_fee_paise, tax_paise: q.tax_paise, total_paise: q.customer_total_paise,
      },
      action: null,
      suggestions: open
        ? ['Continue to checkout', ...(vendor.delivery_enabled === false ? [] : [fulfilment === 'delivery' ? 'Pickup instead' : 'Deliver instead'])]
        : ['Show the menu'],
    },
  };
}

function checkout(st, w) {
  const p = proposal(st, w, []);
  const vendor = w.vendor(st.vendorId);
  if (!p.out.proposal.open) return p;
  if (w.orderBlock) {
    st.pending = null;
    return { state: st, out: { reply: `I can't send this to checkout: ${w.orderBlock.replace(/\.?$/, '.')}`,
                              proposal: p.out.proposal, action: null, suggestions: [] } };
  }
  st.done = true;
  st.pending = null;
  return {
    state: st,
    out: {
      reply: `Done, it's in your cart. ${cap(`${w.signedIn ? '' : 'sign in with your college email, then '}${
        p.out.proposal.fulfilment === 'delivery' ? 'choose where it should come and ' : ''}pay on the checkout screen.`)} Nothing is charged until you pay there.`,
      proposal: p.out.proposal,
      action: { type: 'checkout', vendorId: vendor.id, fulfilment: p.out.proposal.fulfilment,
                lines: p.out.proposal.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })) },
      suggestions: [],
    },
  };
}

function menuReply(text, vendor, w) {
  const vendors = vendor ? [vendor] : w.vendors;
  const itemsOf = (v) => w.items.filter((i) => i.vendor_id === v.id);
  const catsOf = (v) => [...new Set(itemsOf(v).map((i) => i.category || 'Menu'))];
  const priceList = (list) => list.map((i) => `${i.name} — ${money(i.price_paise)}${i.available === false ? ' (sold out)' : ''}`).join('\n');
  /* "pasta kya hai" — just that section, every item with its price. */
  const words = tokens(text).filter((t) => itemContent(t));
  const sections = [];
  if (words.length) {
    for (const v of vendors) {
      for (const c of catsOf(v).filter((c) => tokens(c).some((ct) => words.some((x) => sameWord(x, ct))))) {
        sections.push(`${v.name} · ${c}\n${priceList(itemsOf(v).filter((i) => (i.category || 'Menu') === c))}`);
      }
    }
  }
  if (!sections.length) {
    for (const v of vendors) {
      const its = itemsOf(v);
      if (!its.length) { sections.push(`${v.name} · ${v.status?.line || ''}\nNo menu on ECHO ECHO yet.`); continue; }
      sections.push(`${v.name} · ${v.status?.line || ''}\n${catsOf(v).map((c) => {
        const inCat = its.filter((i) => (i.category || 'Menu') === c);
        const from = Math.min(...inCat.map((i) => i.price_paise));
        return `${c}: ${inCat.slice(0, 3).map((i) => i.name).join(', ')}${inCat.length > 3 ? ` and ${inCat.length - 3} more` : ''} (from ${money(from)})`;
      }).join('\n')}`);
    }
  }
  const hint = vendors.some((v) => itemsOf(v).length) ? '\n\nAsk for anything by name, like "1 cold coffee".' : '';
  return [`${sections.join('\n\n')}${hint}`, { suggestions: [] }];
}

/* "Chai Garam is closed right now (opens Mon 8 AM), so ..." */
function closedLine(vendor) {
  const [state, when] = String(vendor.status?.line || 'Closed').split(' · ');
  return when ? `${vendor.name} is ${lowerFirst(state)} right now (${when}), so this can't go to checkout yet.`
    : `${vendor.name}: ${lowerFirst(state)}, so this can't go to checkout yet.`;
}

const statusLines = (w) => w.vendors.map((v) => `${v.name}: ${v.status?.line || ''}`).join('\n');

/* ---- small helpers ------------------------------------------------------------ */

/* Whether text names something beyond order-talk ("yes", "bhej do", "2"). */
const ORDER_TALK = /^(yes|y|yeah|yep|yup|ya|haan|haa|han|ha|hanji|ji|ok|okay|okk|k|sure|confirm|confirmed|checkout|check|out|continue|proceed|done|go|ahead|theek|thik|hai|h|chalo|chal|perfect|place|it|order|kar|karo|do|de|dena|bhej|bhejo|bhejdo|bhejna|please|pls|plz|bhai|no|nope|nah|nahi|nahin|na|not|now|ruko|wait|abhi|mat|pickup|pick|up|collect|delivery|deliver|instead|self|khud|le|lunga|jaunga|lungi|jaungi|takeaway|take|away|make|that|change|to|the|a|an|me|i|want|need|chahiye|chaiye|aur|and|ek|one|two|three|\d+|thanks|thank|you|u|shukriya|hi|hello|hey|menu|kya|show|list|dikhao|price|kitne|kitna|cost|how|much|rate|remove|hata|hatao|nikal|delete|minus|cancel|clear|from|se|at|pe|par|room|hostel|ground|block|library|counter|mein|ko|for|my|mujhe|of|is|what|whats|there|available|options|sab|kuch|wala|wali|vala|vali|one|ones|wahi|same|again|phir|fir|more|extra)$/;
function itemContent(text) {
  return tokens(text).some((t) => !FILLER.has(t) && !ORDER_TALK.test(t) && !ORDER_TALK.test(stem(t)));
}

function withoutVendor(text, named, w) {
  const words = tokens(text);
  const skip = new Set();
  const name = [...named.words];
  /* The café's name as a phrase, plus the "se"/"from" that points at it. */
  words.forEach((t, i) => {
    if (name.some((n) => sameWord(t, n)) && name.length > 1) {
      const span = name.length;
      const slice = words.slice(i, i + span);
      if (slice.length === span && slice.every((x, k) => sameWord(x, tokens(named.vendor.name)[k] || name[k]))) {
        for (let k = i; k < i + span; k++) skip.add(k);
      }
    }
  });
  const distinctive = [...named.words].filter((n) => !w.itemWords.has(stem(n)));
  words.forEach((t, i) => { if (distinctive.some((n) => sameWord(t, n))) skip.add(i); });
  words.forEach((t, i) => { if (['se', 'from', 'at', 'wala', 'wali'].includes(t) && (skip.has(i - 1) || skip.has(i + 1))) skip.add(i); });
  return words.filter((_, i) => !skip.has(i)).join(' ');
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s) => s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
