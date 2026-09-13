/* ==========================================================================
   FRISCO — VENDOR CATALOGUE
   Vendors and menu items are rows. Nothing in any UI names a cafeteria.
   Adding outlet #4 is a push into VENDORS via the admin portal.

   Deactivation, never deletion: `active:false` hides a vendor or item from
   ordering while every historical order that references it still resolves.
   ========================================================================== */

export const VENDORS = [
  {
    id: 'caf_frisco', name: 'Frisco', slug: 'frisco', kind: 'Campus Cafe',
    mark: 'F', markBg: 'var(--rose-500)', heroBg: 'var(--rose-100)',
    zone: 'z_acad', location: 'Academic Block, Ground Floor',
    active: true, is_open: true, accepting: true,
    prep_minutes: 8, rating: 4.6, orders_today: 132,
    tags: ['Burgers', 'Coffee', 'Fast bites'],
    staff_can_deliver: true,
    hours: { opens: '08:00', closes: '18:00' },
    owner: 'usr_owner_frisco',
    staff: ['usr_staff_frisco'],
  },
  {
    id: 'caf_chai', name: 'Chai Garam', slug: 'chai-garam', kind: 'Tea & Snacks',
    mark: 'CG', markBg: 'var(--coral-500)', heroBg: 'var(--warn-bg)',
    zone: 'z_grnd', location: 'Near Ground, Kiosk 2',
    active: true, is_open: true, accepting: true,
    prep_minutes: 4, rating: 4.8, orders_today: 210,
    tags: ['Chai', 'Maggi', 'Samosa'],
    staff_can_deliver: false,
    hours: { opens: '08:00', closes: '18:00' },
    owner: 'usr_owner_chai',
    staff: [],
  },
  {
    id: 'caf_tulips', name: 'Tulips', slug: 'tulips', kind: 'Cafe & Meals',
    mark: 'T', markBg: 'var(--open-500)', heroBg: 'var(--ok-bg)',
    zone: 'z_hostel', location: 'Hostel Block B, Ground',
    active: true, is_open: true, accepting: true,
    prep_minutes: 14, rating: 4.4, orders_today: 76,
    tags: ['Thali', 'Rolls', 'North Indian'],
    staff_can_deliver: true,
    hours: { opens: '09:00', closes: '18:00' },
    owner: 'usr_owner_tulips',
    staff: [],
  },
];

/* Palette offered when admin creates a new outlet — keeps new vendors inside
   the approved identity instead of letting anyone pick arbitrary colours. */
export const VENDOR_PALETTE = [
  { markBg: 'var(--rose-500)',  heroBg: 'var(--rose-100)',  label: 'Rose' },
  { markBg: 'var(--coral-500)', heroBg: 'var(--warn-bg)',   label: 'Coral' },
  { markBg: 'var(--open-500)',  heroBg: 'var(--ok-bg)',     label: 'Green' },
  { markBg: 'var(--ink-800)',   heroBg: 'var(--cream-300)', label: 'Ink' },
  { markBg: 'var(--rose-700)',  heroBg: 'var(--accent-soft)', label: 'Deep rose' },
];

export const ITEMS = [
  // ---- Frisco ----
  { id: 'itm_cc', caf: 'caf_frisco', cat: 'Cold Drinks', name: 'Cold Coffee', desc: 'Double shot, thick shake style, served chilled', price: 5000, veg: true, glyph: '🥤', available: true, active: true, popular: true, prep: 4, tags: ['cold', 'sweet'], aliases: ['cc', 'thandi coffee', 'iced coffee', 'cold coffe'],
    options: [{ group: 'Size', choices: [{ label: 'Regular', delta: 0 }, { label: 'Large', delta: 1500 }] }, { group: 'Sugar', choices: [{ label: 'Normal', delta: 0 }, { label: 'Less sugar', delta: 0 }] }] },
  { id: 'itm_vb', caf: 'caf_frisco', cat: 'Burgers', name: 'Veg Burger', desc: 'Crumb-fried patty, mint mayo, toasted bun', price: 9000, veg: true, glyph: '🍔', available: true, active: true, popular: true, prep: 8, tags: ['filling'], aliases: ['burger', 'veg burgur', 'patty burger'],
    options: [{ group: 'Add-ons', choices: [{ label: 'None', delta: 0 }, { label: 'Extra cheese', delta: 2000 }, { label: 'Double patty', delta: 3500 }] }] },
  { id: 'itm_fr', caf: 'caf_frisco', cat: 'Sides', name: 'Fries', desc: 'Salted, crisp-fried. Peri-peri on request', price: 6000, veg: true, glyph: '🍟', available: true, active: true, popular: true, prep: 5, tags: ['spicy', 'crispy'], aliases: ['french fries', 'finger chips'],
    options: [{ group: 'Seasoning', choices: [{ label: 'Salted', delta: 0 }, { label: 'Peri-peri', delta: 1000 }] }] },
  { id: 'itm_vs', caf: 'caf_frisco', cat: 'Sandwiches', name: 'Veg Sandwich', desc: 'Grilled, three-layer, coriander chutney', price: 5500, veg: true, glyph: '🥪', available: true, active: true, popular: false, prep: 6, tags: ['light'], aliases: ['sandwich', 'grill sandwich'] },
  { id: 'itm_pz', caf: 'caf_frisco', cat: 'Burgers', name: 'Paneer Zinger', desc: 'Spiced paneer, slaw, hot sauce', price: 11000, veg: true, glyph: '🌯', available: false, active: true, popular: false, prep: 9, tags: ['spicy', 'filling'], aliases: ['zinger', 'paneer burger'] },
  { id: 'itm_ct', caf: 'caf_frisco', cat: 'Cold Drinks', name: 'Iced Tea', desc: 'Lemon, lightly sweet', price: 4000, veg: true, glyph: '🧋', available: true, active: true, popular: false, prep: 3, tags: ['cold'], aliases: ['ice tea', 'lemon tea cold'] },

  // ---- Chai Garam ----
  { id: 'itm_chai', caf: 'caf_chai', cat: 'Chai', name: 'Masala Chai', desc: 'Kadak, elaichi + adrak, cutting or full', price: 1500, veg: true, glyph: '☕', available: true, active: true, popular: true, prep: 3, tags: ['hot'], aliases: ['chai', 'tea', 'cutting'],
    options: [{ group: 'Size', choices: [{ label: 'Cutting', delta: 0 }, { label: 'Full', delta: 700 }] }] },
  { id: 'itm_sam', caf: 'caf_chai', cat: 'Snacks', name: 'Samosa', desc: 'Aloo-matar, fried to order, imli chutney', price: 2000, veg: true, glyph: '🥟', available: true, active: true, popular: true, prep: 4, tags: ['spicy', 'filling'], aliases: ['samose', 'singhara'] },
  { id: 'itm_mag', caf: 'caf_chai', cat: 'Snacks', name: 'Masala Maggi', desc: 'Butter, extra masala, onion & chilli', price: 4500, veg: true, glyph: '🍜', available: true, active: true, popular: true, prep: 7, tags: ['spicy', 'filling', 'hot'], aliases: ['maggi', 'noodles'],
    options: [{ group: 'Style', choices: [{ label: 'Plain', delta: 0 }, { label: 'Cheese', delta: 2000 }, { label: 'Extra spicy', delta: 0 }] }] },
  { id: 'itm_bm', caf: 'caf_chai', cat: 'Snacks', name: 'Bun Maska', desc: 'Toasted bun, thick butter', price: 2500, veg: true, glyph: '🥐', available: true, active: true, popular: false, prep: 2, tags: ['light'], aliases: ['bun', 'maska bun'] },
  { id: 'itm_ccg', caf: 'caf_chai', cat: 'Cold', name: 'Cold Coffee', desc: 'Kiosk style, quick pour, less sweet', price: 4000, veg: true, glyph: '🥤', available: true, active: true, popular: false, prep: 3, tags: ['cold', 'sweet'], aliases: ['cc', 'thandi coffee'] },
  { id: 'itm_vp', caf: 'caf_chai', cat: 'Snacks', name: 'Vada Pav', desc: 'Dry garlic chutney, fried mirchi on side', price: 3000, veg: true, glyph: '🍔', available: true, active: true, popular: false, prep: 4, tags: ['spicy', 'filling'], aliases: ['vadapav'] },

  // ---- Tulips ----
  { id: 'itm_pr', caf: 'caf_tulips', cat: 'Rolls', name: 'Paneer Roll', desc: 'Tandoori paneer, onion, pudina, in a flaky paratha', price: 8000, veg: true, glyph: '🌯', available: true, active: true, popular: true, prep: 9, tags: ['filling', 'spicy'], aliases: ['paneer wrap', 'roll', 'paneer kathi'] },
  { id: 'itm_th', caf: 'caf_tulips', cat: 'Meals', name: 'Veg Thali', desc: '2 sabzi, dal, 4 roti, rice, salad, sweet', price: 12000, veg: true, glyph: '🍛', available: true, active: true, popular: true, prep: 15, tags: ['filling'], aliases: ['thali', 'full meal', 'khana'] },
  { id: 'itm_rc', caf: 'caf_tulips', cat: 'Meals', name: 'Rajma Chawal', desc: 'Slow-cooked rajma, jeera rice, achar', price: 9000, veg: true, glyph: '🍚', available: true, active: true, popular: false, prep: 10, tags: ['filling'], aliases: ['rajma', 'rajma rice'] },
  { id: 'itm_er', caf: 'caf_tulips', cat: 'Rolls', name: 'Egg Roll', desc: 'Double egg, green chutney, crisp onion', price: 7000, veg: false, glyph: '🌯', available: true, active: true, popular: false, prep: 8, tags: ['filling', 'spicy'], aliases: ['anda roll', 'egg wrap'] },
  { id: 'itm_lassi', caf: 'caf_tulips', cat: 'Drinks', name: 'Sweet Lassi', desc: 'Thick, chilled, malai on top', price: 5000, veg: true, glyph: '🥛', available: false, active: true, popular: false, prep: 4, tags: ['cold', 'sweet'], aliases: ['lassi'] },
];

export const PRICING = {
  delivery_fee_paise: 1500,
  partner_base_payout_paise: 1000,
  partner_peak_bonus_paise: 500,
  cash_float_cap_paise: 50000,
};

export const SERVICE_WINDOW = { opens: '08:00', closes: '18:00' };

export const CONFIG = {
  college: 'Sunview Institute of Technology',
  emailDomain: 'campus.edu.in',
  currency: '₹',
};

/* ==========================================================================
   HISTORICAL ORDERS — PRICE SNAPSHOTS
   Each line carries `name` and `unit` frozen at the moment the order was
   confirmed. Nothing here is looked up live, so a shopkeeper changing a menu
   price — or archiving an item, or archiving the whole outlet — cannot alter
   what someone was charged. `id` is kept only as a soft reference for
   re-ordering; if it no longer resolves, the snapshot still renders.
   ========================================================================== */
export const ORDER_HISTORY = [
  { code: 'F1826', caf: 'caf_chai', cafName: 'Chai Garam', when: 'Yesterday, 4:20 PM', status: 'delivered', node: 'f_lib_1',
    items: [{ id: 'itm_chai', name: 'Masala Chai', q: 2, unit: 1500 }, { id: 'itm_sam', name: 'Samosa', q: 2, unit: 2000 }],
    subtotal: 7000, fee: 1500, total: 8500 },
  { code: 'F1799', caf: 'caf_frisco', cafName: 'Frisco', when: 'Mon, 1:05 PM', status: 'delivered', node: 's_grnd_bb',
    items: [{ id: 'itm_vb', name: 'Veg Burger', q: 1, unit: 9000 }, { id: 'itm_fr', name: 'Fries', q: 1, unit: 6000 }],
    subtotal: 15000, fee: 1500, total: 16500 },
  { code: 'F1780', caf: 'caf_tulips', cafName: 'Tulips', when: 'Sun, 8:40 PM', status: 'collected', node: null,
    items: [{ id: 'itm_th', name: 'Veg Thali', q: 1, unit: 12000 }],
    subtotal: 12000, fee: 0, total: 12000 },
];

/* order_events — the append-only audit trail admin inspects per order. */
export const ORDER_EVENTS = [
  { code: 'F1842', at: '12:41:02', from: null, to: 'placed', actor: 'Ayush Kumar', actorType: 'student', note: 'Paid online · UPI' },
  { code: 'F1842', at: '12:41:44', from: 'placed', to: 'accepted', actor: 'Pooja Nair', actorType: 'vendor_staff', note: 'Accepted at counter' },
  { code: 'F1842', at: '12:42:10', from: 'accepted', to: 'preparing', actor: 'Pooja Nair', actorType: 'vendor_staff', note: '' },
  { code: 'F1839', at: '12:36:20', from: null, to: 'placed', actor: 'Ishita Rao', actorType: 'student', note: 'Paid online · UPI' },
  { code: 'F1839', at: '12:37:05', from: 'placed', to: 'accepted', actor: 'Pooja Nair', actorType: 'vendor_staff', note: '' },
  { code: 'F1839', at: '12:38:51', from: 'accepted', to: 'preparing', actor: 'Pooja Nair', actorType: 'vendor_staff', note: '' },
  { code: 'F1834', at: '12:30:11', from: null, to: 'placed', actor: 'Rhea Menon', actorType: 'student', note: 'Paid online · UPI' },
  { code: 'F1834', at: '12:31:02', from: 'placed', to: 'accepted', actor: 'Ravi Sethi', actorType: 'vendor_owner', note: '' },
  { code: 'F1834', at: '12:39:40', from: 'preparing', to: 'ready', actor: 'Ravi Sethi', actorType: 'vendor_owner', note: '' },
  { code: 'F1834', at: '12:40:18', from: 'ready', to: 'assigned', actor: 'system', actorType: 'system', note: 'Offer accepted by Ishita R. · locked' },
];

export const LIVE_ORDERS = [
  { code: 'F1842', caf: 'caf_frisco', status: 'placed', fulfilment: 'delivery', node: 's_grnd_bb', placed: '2 min ago', items: [{ id: 'itm_cc', q: 2 }, { id: 'itm_vb', q: 1 }], total: 20000, pay: 'online' },
  { code: 'F1841', caf: 'caf_frisco', status: 'placed', fulfilment: 'pickup', node: null, placed: '3 min ago', items: [{ id: 'itm_vs', q: 1 }, { id: 'itm_ct', q: 1 }], total: 9500, pay: 'cash' },
  { code: 'F1839', caf: 'caf_frisco', status: 'preparing', fulfilment: 'delivery', node: 'f_lib_1', placed: '6 min ago', items: [{ id: 'itm_fr', q: 3 }, { id: 'itm_cc', q: 2 }], total: 29500, pay: 'online' },
  { code: 'F1838', caf: 'caf_frisco', status: 'preparing', fulfilment: 'delivery', node: 's_b_204', placed: '8 min ago', items: [{ id: 'itm_vb', q: 1 }], total: 10500, pay: 'cash' },
  { code: 'F1835', caf: 'caf_frisco', status: 'ready', fulfilment: 'pickup', node: null, placed: '11 min ago', items: [{ id: 'itm_vs', q: 2 }], total: 11000, pay: 'online', pickupCode: '7412' },
  { code: 'F1834', caf: 'caf_frisco', status: 'ready', fulfilment: 'delivery', node: 'b_h_b', placed: '12 min ago', items: [{ id: 'itm_cc', q: 1 }, { id: 'itm_fr', q: 1 }], total: 12500, pay: 'online', partner: 'Ishita R.' },
  { code: 'C2201', caf: 'caf_chai', status: 'placed', fulfilment: 'delivery', node: 's_lab_cs2', placed: '1 min ago', items: [{ id: 'itm_chai', q: 4 }, { id: 'itm_sam', q: 4 }], total: 15500, pay: 'cash' },
  { code: 'T3310', caf: 'caf_tulips', status: 'preparing', fulfilment: 'delivery', node: 'f_h_a2', placed: '9 min ago', items: [{ id: 'itm_th', q: 1 }], total: 13500, pay: 'online' },
];
