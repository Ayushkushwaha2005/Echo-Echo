/* ==========================================================================
   FRISCO — SEED DATA
   Shaped exactly like the tables in the roadmap (§2). In production these
   arrive from the API; nothing here is hardcoded into a screen. Adding a
   cafeteria = pushing a row into CAFETERIAS + MENU. No component changes.
   All money is integer paise, per the roadmap's "money is integers" rule.
   ========================================================================== */

export const CONFIG = {
  college: 'Sunview Institute of Technology',
  emailDomain: 'campus.edu.in',
  currency: '₹',
};

/* pricing_config — versioned rows in production, read at order time */
export const PRICING = {
  delivery_fee_paise: 1500,       // ₹15
  partner_base_payout_paise: 1000, // ₹10
  partner_peak_bonus_paise: 500,   // +₹5 during peak
  cash_float_cap_paise: 50000,     // ₹500
};

/* service_windows — global campus window; outlets may narrow it */
export const SERVICE_WINDOW = { opens: '08:00', closes: '18:00' };

/* campus_locations — THE WHITELIST. There is no free-text address anywhere
   in this UI, by design (roadmap §4). Off-campus is unrepresentable. */
export const LOCATIONS = [
  { id: 'loc_lib',   name: 'Library',           type: 'library',     zone: 'Z1', glyph: '📚', detail: 'Central Library · Reading Hall 2', accepts_delivery: true },
  { id: 'loc_ab',    name: 'Academic Block',    type: 'classroom',   zone: 'Z1', glyph: '🏫', detail: 'Rooms & lecture theatres',        accepts_delivery: true, rooms: ['AB-101', 'AB-204', 'LT-3', 'LT-5'] },
  { id: 'loc_grnd',  name: 'Ground',            type: 'ground',      zone: 'Z2', glyph: '🏀', detail: 'Basketball court & main field',   accepts_delivery: true },
  { id: 'loc_lab',   name: 'Labs',              type: 'lab',         zone: 'Z1', glyph: '🧪', detail: 'CS, Electronics & Mech labs',     accepts_delivery: true, rooms: ['CS Lab 2', 'EC Lab 1', 'Workshop'] },
  { id: 'loc_aud',   name: 'Auditorium',        type: 'auditorium',  zone: 'Z2', glyph: '🎤', detail: 'Main auditorium & foyer',         accepts_delivery: true },
  { id: 'loc_hostel',name: 'Hostels',           type: 'hostel',      zone: 'Z3', glyph: '🏠', detail: 'On-campus blocks A–D',            accepts_delivery: true, rooms: ['Block A', 'Block B', 'Block C', 'Girls Block D'] },
];

/* cafeterias — Frisco, Chai Garam, Tulips are ROWS. A fourth is an admin
   form submission, not a code change. `mark` gives each its own identity. */
export const CAFETERIAS = [
  {
    id: 'caf_frisco', name: 'Frisco', slug: 'frisco', kind: 'Campus Cafe',
    mark: 'F', markBg: 'var(--rose-500)', heroBg: 'var(--rose-100)',
    location: 'Academic Block, Ground Floor', zone: 'Z1',
    is_open: true, prep_minutes: 8, rating: 4.6, orders_today: 132,
    tags: ['Burgers', 'Coffee', 'Fast bites'],
    staff_can_deliver: true,
  },
  {
    id: 'caf_chai', name: 'Chai Garam', slug: 'chai-garam', kind: 'Tea & Snacks',
    mark: 'CG', markBg: 'var(--coral-500)', heroBg: 'var(--warn-bg)',
    location: 'Near Ground, Kiosk 2', zone: 'Z2',
    is_open: true, prep_minutes: 4, rating: 4.8, orders_today: 210,
    tags: ['Chai', 'Maggi', 'Samosa'],
    staff_can_deliver: false,
  },
  {
    id: 'caf_tulips', name: 'Tulips', slug: 'tulips', kind: 'Cafe & Meals',
    mark: 'T', markBg: 'var(--open-500)', heroBg: 'var(--ok-bg)',
    location: 'Hostel Block B, Ground', zone: 'Z3',
    is_open: true, prep_minutes: 14, rating: 4.4, orders_today: 76,
    tags: ['Thali', 'Rolls', 'North Indian'],
    staff_can_deliver: true,
  },
];

/* menu_items — `aliases` is what the AI agent resolves against (roadmap §13).
   Staff maintain them; the agent never invents an item. */
export const MENU = [
  // ---- Frisco ----
  { id: 'itm_cc',   caf: 'caf_frisco', cat: 'Cold Drinks', name: 'Cold Coffee',     desc: 'Double shot, thick shake style, served chilled', price: 5000, veg: true, glyph: '🥤', available: true,  popular: true,  tags: ['cold','sweet'], aliases: ['cc','thandi coffee','iced coffee','cold coffe'],
    options: [{ group: 'Size', choices: [{ label: 'Regular', delta: 0 }, { label: 'Large', delta: 1500 }] }, { group: 'Sugar', choices: [{ label: 'Normal', delta: 0 }, { label: 'Less sugar', delta: 0 }] }] },
  { id: 'itm_vb',   caf: 'caf_frisco', cat: 'Burgers',     name: 'Veg Burger',      desc: 'Crumb-fried patty, mint mayo, toasted bun',      price: 9000, veg: true, glyph: '🍔', available: true,  popular: true,  tags: ['filling'], aliases: ['burger','veg burgur','patty burger'],
    options: [{ group: 'Add-ons', choices: [{ label: 'None', delta: 0 }, { label: 'Extra cheese', delta: 2000 }, { label: 'Double patty', delta: 3500 }] }] },
  { id: 'itm_fr',   caf: 'caf_frisco', cat: 'Sides',       name: 'Fries',           desc: 'Salted, crisp-fried. Peri-peri on request',      price: 6000, veg: true, glyph: '🍟', available: true,  popular: true,  tags: ['spicy','crispy'], aliases: ['french fries','finger chips'],
    options: [{ group: 'Seasoning', choices: [{ label: 'Salted', delta: 0 }, { label: 'Peri-peri', delta: 1000 }] }] },
  { id: 'itm_vs',   caf: 'caf_frisco', cat: 'Sandwiches',  name: 'Veg Sandwich',    desc: 'Grilled, three-layer, coriander chutney',        price: 5500, veg: true, glyph: '🥪', available: true,  popular: false, tags: ['light'], aliases: ['sandwich','grill sandwich'] },
  { id: 'itm_pz',   caf: 'caf_frisco', cat: 'Burgers',     name: 'Paneer Zinger',   desc: 'Spiced paneer, slaw, hot sauce',                 price: 11000, veg: true, glyph: '🌯', available: false, popular: false, tags: ['spicy','filling'], aliases: ['zinger','paneer burger'] },
  { id: 'itm_ct',   caf: 'caf_frisco', cat: 'Cold Drinks', name: 'Iced Tea',        desc: 'Lemon, lightly sweet',                           price: 4000, veg: true, glyph: '🧋', available: true,  popular: false, tags: ['cold'], aliases: ['ice tea','lemon tea cold'] },

  // ---- Chai Garam ----
  { id: 'itm_chai', caf: 'caf_chai', cat: 'Chai',    name: 'Masala Chai',   desc: 'Kadak, elaichi + adrak, cutting or full',  price: 1500, veg: true, glyph: '☕', available: true, popular: true,  tags: ['hot'], aliases: ['chai','tea','cutting'],
    options: [{ group: 'Size', choices: [{ label: 'Cutting', delta: 0 }, { label: 'Full', delta: 700 }] }] },
  { id: 'itm_sam',  caf: 'caf_chai', cat: 'Snacks',  name: 'Samosa',        desc: 'Aloo-matar, fried to order, imli chutney',  price: 2000, veg: true, glyph: '🥟', available: true, popular: true,  tags: ['spicy','filling'], aliases: ['samose','singhara'] },
  { id: 'itm_mag',  caf: 'caf_chai', cat: 'Snacks',  name: 'Masala Maggi',  desc: 'Butter, extra masala, onion & chilli',      price: 4500, veg: true, glyph: '🍜', available: true, popular: true,  tags: ['spicy','filling','hot'], aliases: ['maggi','noodles'],
    options: [{ group: 'Style', choices: [{ label: 'Plain', delta: 0 }, { label: 'Cheese', delta: 2000 }, { label: 'Extra spicy', delta: 0 }] }] },
  { id: 'itm_bm',   caf: 'caf_chai', cat: 'Snacks',  name: 'Bun Maska',     desc: 'Toasted bun, thick butter',                 price: 2500, veg: true, glyph: '🥐', available: true, popular: false, tags: ['light'], aliases: ['bun','maska bun'] },
  { id: 'itm_ccg',  caf: 'caf_chai', cat: 'Cold',    name: 'Cold Coffee',   desc: 'Kiosk style, quick pour, less sweet',       price: 4000, veg: true, glyph: '🥤', available: true, popular: false, tags: ['cold','sweet'], aliases: ['cc','thandi coffee'] },
  { id: 'itm_vp',   caf: 'caf_chai', cat: 'Snacks',  name: 'Vada Pav',      desc: 'Dry garlic chutney, fried mirchi on side',  price: 3000, veg: true, glyph: '🍔', available: true, popular: false, tags: ['spicy','filling'], aliases: ['vadapav'] },

  // ---- Tulips ----
  { id: 'itm_pr',   caf: 'caf_tulips', cat: 'Rolls',  name: 'Paneer Roll',   desc: 'Tandoori paneer, onion, pudina, in a flaky paratha', price: 8000, veg: true,  glyph: '🌯', available: true, popular: true,  tags: ['filling','spicy'], aliases: ['paneer wrap','roll','paneer kathi'] },
  { id: 'itm_th',   caf: 'caf_tulips', cat: 'Meals',  name: 'Veg Thali',     desc: '2 sabzi, dal, 4 roti, rice, salad, sweet',           price: 12000, veg: true, glyph: '🍛', available: true, popular: true,  tags: ['filling'], aliases: ['thali','full meal','khana'] },
  { id: 'itm_rc',   caf: 'caf_tulips', cat: 'Meals',  name: 'Rajma Chawal',  desc: 'Slow-cooked rajma, jeera rice, achar',               price: 9000, veg: true,  glyph: '🍚', available: true, popular: false, tags: ['filling'], aliases: ['rajma','rajma rice'] },
  { id: 'itm_er',   caf: 'caf_tulips', cat: 'Rolls',  name: 'Egg Roll',      desc: 'Double egg, green chutney, crisp onion',             price: 7000, veg: false, glyph: '🌯', available: true, popular: false, tags: ['filling','spicy'], aliases: ['anda roll','egg wrap'] },
  { id: 'itm_lassi',caf: 'caf_tulips', cat: 'Drinks', name: 'Sweet Lassi',   desc: 'Thick, chilled, malai on top',                       price: 5000, veg: true,  glyph: '🥛', available: false, popular: false, tags: ['cold','sweet'], aliases: ['lassi'] },
];

export const MENU_CATEGORIES = (cafId) =>
  [...new Set(MENU.filter((m) => m.caf === cafId).map((m) => m.cat))];

/* Signed-in student — from the roadmap's users + user_roles tables */
export const ME = {
  id: 'usr_1', name: 'Ayush Kumar', first: 'Ayush',
  roll: '23BCS1043', email: 'ayush.k23@campus.edu.in',
  phone: '+91 •••• ••4417', initials: 'AK',
  tier: 2, verified: true,
  roles: ['student', 'delivery_partner'],
  joined: 'Aug 2026',
};

/* delivery_partners — the partner profile for the same human */
export const PARTNER = {
  online: false,
  rating: 4.9,
  reliability: 94,
  deliveries_today: 6,
  earnings_today_paise: 9000,
  earnings_week_paise: 47500,
  deliveries_total: 128,
  cash_held_paise: 12000,
  verification: 'approved',
};

export const PARTNER_HISTORY = [
  { code: 'F1836', from: 'Frisco',     to: 'Library',        payout: 1500, at: '1:42 PM', status: 'delivered' },
  { code: 'F1829', from: 'Chai Garam', to: 'Ground',         payout: 1000, at: '1:11 PM', status: 'delivered' },
  { code: 'F1821', from: 'Frisco',     to: 'Academic Block', payout: 1500, at: '12:48 PM', status: 'delivered' },
  { code: 'F1814', from: 'Tulips',     to: 'Hostels',        payout: 1000, at: '12:20 PM', status: 'delivered' },
  { code: 'F1802', from: 'Chai Garam', to: 'Labs',           payout: 1000, at: '11:36 AM', status: 'delivered' },
  { code: 'F1791', from: 'Frisco',     to: 'Ground',         payout: 1000, at: '10:04 AM', status: 'delivered' },
];

/* Live queue for the cafeteria console */
export const STAFF_QUEUE = [
  { code: 'F1842', status: 'placed',    fulfilment: 'delivery', loc: 'Ground', placed: '2 min ago', items: [{ q: 2, n: 'Cold Coffee' }, { q: 1, n: 'Veg Burger' }], total: 20000, pay: 'online' },
  { code: 'F1841', status: 'placed',    fulfilment: 'pickup',   loc: null,     placed: '3 min ago', items: [{ q: 1, n: 'Veg Sandwich' }, { q: 1, n: 'Iced Tea' }], total: 9500, pay: 'cash' },
  { code: 'F1839', status: 'preparing', fulfilment: 'delivery', loc: 'Library', placed: '6 min ago', items: [{ q: 3, n: 'Fries' }, { q: 2, n: 'Cold Coffee' }], total: 29500, pay: 'online' },
  { code: 'F1838', status: 'preparing', fulfilment: 'delivery', loc: 'AB-204', placed: '8 min ago', items: [{ q: 1, n: 'Veg Burger' }], total: 10500, pay: 'cash' },
  { code: 'F1835', status: 'ready',     fulfilment: 'pickup',   loc: null,     placed: '11 min ago', items: [{ q: 2, n: 'Veg Sandwich' }], total: 11000, pay: 'online', pickupCode: '7412' },
  { code: 'F1834', status: 'ready',     fulfilment: 'delivery', loc: 'Hostels', placed: '12 min ago', items: [{ q: 1, n: 'Cold Coffee' }, { q: 1, n: 'Fries' }], total: 12500, pay: 'online', partner: 'Ishita R.' },
];

/* Recent orders for the student's history */
export const RECENT_ORDERS = [
  { code: 'F1826', caf: 'caf_chai',   items: '2 × Masala Chai, 2 × Samosa', total: 8500,  when: 'Yesterday, 4:20 PM', status: 'delivered', loc: 'Library' },
  { code: 'F1799', caf: 'caf_frisco', items: '1 × Veg Burger, 1 × Fries',   total: 16500, when: 'Mon, 1:05 PM',      status: 'delivered', loc: 'Ground' },
  { code: 'F1780', caf: 'caf_tulips', items: '1 × Veg Thali',               total: 12000, when: 'Sun, 8:40 PM',      status: 'collected', loc: null },
];

/* Admin: pending partner verifications & open reports */
export const VERIFICATIONS = [
  { name: 'Rhea Menon',   roll: '24BEC2210', tier: 'Tier 2', submitted: '18 min ago', doc: 'ID card + phone' },
  { name: 'Karan Bisht',  roll: '23BME1187', tier: 'Tier 2', submitted: '1 hr ago',   doc: 'ID card + phone' },
  { name: 'Simran Kaur',  roll: '25BCS3004', tier: 'Tier 1', submitted: '3 hr ago',   doc: 'Roster match' },
];

export const REPORTS = [
  { id: 'RPT-114', cat: 'Late cancellation', subject: 'Student · 23BCS0912', detail: '3rd cancellation after accept this week', sev: 'warn' },
  { id: 'RPT-113', cat: 'Order tampering',   subject: 'Partner · Nikhil S.',  detail: 'Seal reported broken on arrival',        sev: 'danger' },
  { id: 'RPT-111', cat: 'Unsettled cash',    subject: 'Partner · Aman T.',    detail: '₹640 outstanding for 31 hours',          sev: 'warn' },
];

export const FLAGS = [
  { key: 'ai_ordering',   label: 'AI ordering',        desc: 'Natural-language ordering agent', on: true },
  { key: 'cash_payments', label: 'Cash payments',      desc: 'Cash on delivery & on collection', on: true },
  { key: 'delivery',      label: 'Delivery',           desc: 'Master switch for all delivery',   on: true },
  { key: 'new_orders',    label: 'Accepting orders',   desc: 'Campus-wide kill switch',          on: true },
];

/* Suggested prompts for the agent's entry screen */
export const AI_SUGGESTIONS = [
  'Ground pe 2 cold coffee aur ek veg burger bhej do',
  'Mujhe ₹150 ke andar kuch spicy aur filling chahiye',
  '2 chai aur 4 samosa library mein',
  'Kuch light chahiye, class ke beech mein',
];
