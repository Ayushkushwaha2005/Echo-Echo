/* ==========================================================================
   DEVELOPMENT SEED — NOT PRODUCTION DATA
   ==========================================================================

   Refuses to run when NODE_ENV=production. Everything it writes is real
   structure a real admin would otherwise type in by hand: three cafeterias,
   their menus, and the campus location tree.

   What it deliberately does NOT create:
     · ratings or reviews — those come from delivered orders only, so the
       surfaces show "No ratings yet" until somebody actually orders
     · orders, deliveries or earnings
     · students, partners or admins other than the configured owner
     · any verification case

   CAMPUS DATA PROVENANCE
   ----------------------
   UPES Bidholi's internal block naming is not published in a form that can
   be cited. What is publicly documented is the set of schools (SoE, SoCS,
   SoD, SoHST, SoB, SoLS), a central library, a football ground, basketball
   and volleyball courts, and on-campus boys'/girls' hostels. Those are
   seeded with source='public_source'.

   Everything requiring precision that is NOT published — hostel block
   letters, floor and room numbers, GPS coordinates, distances — is seeded
   as source='unverified_seed' with lat/lng NULL, or not seeded at all. An
   administrator must confirm them in Campus Control before delivery is
   sensible. The boundary polygon is left EMPTY on purpose: live location
   returns "no boundary configured" until somebody walks the perimeter or
   traces it from a map, which is honest, where an invented polygon would
   silently accept or reject students at the wrong places.
   ========================================================================== */
import { pool } from './index.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

const c = await pool.connect();
const node = async (parent, kind, name, opts = {}) => (await c.query(
  `INSERT INTO campus_node (parent_id, kind, name, detail, aliases, deliverable,
                            delivery_enabled, source, source_note, sort)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
  [parent, kind, name, opts.detail || null, opts.aliases || [], !!opts.deliverable,
   opts.deliveryEnabled !== false, opts.source || 'unverified_seed',
   opts.note || null, opts.sort || 0])).rows[0].id;

try {
  await c.query('BEGIN');

  const seeded = await c.query(`SELECT count(*)::int AS n FROM campus_node`);
  if (seeded.rows[0].n > 0) {
    console.log('Campus already has locations — skipping seed.');
    await c.query('ROLLBACK');
    process.exit(0);
  }

  /* ---- campus ---------------------------------------------------------- */
  const SRC = { source: 'public_source', note: 'UPES Bidholi campus facility documented in public sources; exact internal naming to be confirmed by an administrator.' };

  const acad = await node(null, 'zone', 'Academic Area', {
    ...SRC, aliases: ['academic', 'acad', 'class', 'classroom', 'college block'], sort: 1 });
  /* Schools are publicly named; their building layout is not. Seeded as
     deliverable at building level so delivery works without inventing rooms. */
  for (const [name, aliases] of [
    ['School of Computer Science', ['socs', 'cs block', 'computer science']],
    ['School of Engineering', ['soe', 'engineering block']],
    ['School of Design', ['sod', 'design block']],
    ['School of Health Sciences & Technology', ['sohst', 'health sciences']],
    ['School of Business', ['sob', 'business block']],
    ['School of Law', ['sols', 'law block']],
  ]) await node(acad, 'building', name, { ...SRC, aliases, deliverable: true });

  const lib = await node(null, 'zone', 'Library', {
    ...SRC, aliases: ['library', 'lib', 'central library'], deliverable: true, sort: 2,
    note: 'Central library documented publicly; internal floors not published.' });

  const grnd = await node(null, 'zone', 'Sports Ground', {
    ...SRC, aliases: ['ground', 'maidan', 'field', 'sports'], sort: 3 });
  await node(grnd, 'spot', 'Football Ground', { ...SRC, aliases: ['football', 'football field'], deliverable: true });
  await node(grnd, 'spot', 'Basketball Court', { ...SRC, aliases: ['basketball', 'bb court'], deliverable: true });
  await node(grnd, 'spot', 'Volleyball Court', { ...SRC, aliases: ['volleyball'], deliverable: true });

  /* Hostels: existence is public, block naming is not. Container only —
     an admin adds the real blocks. Nothing is invented below this. */
  await node(null, 'zone', 'Hostel Area', {
    aliases: ['hostel', 'hostels'], sort: 4,
    note: 'On-campus hostels are publicly documented but individual block names are not. ' +
          'Add the real blocks in Campus Control before enabling hostel delivery.',
    deliveryEnabled: false });

  await node(null, 'zone', 'Auditorium', { ...SRC, aliases: ['auditorium', 'audi'], deliverable: true, sort: 5 });

  console.log('✓ campus seeded (provenance recorded; no coordinates invented)');

  /* ---- vendors --------------------------------------------------------- */
  const vendor = async (slug, name, kind) => (await c.query(
    `INSERT INTO vendor (slug, name, kind, prep_minutes, is_open, accepting)
     VALUES ($1,$2,$3,10,false,false) RETURNING id`, [slug, name, kind])).rows[0].id;

  const frisco = await vendor('frisco', 'Frisco', 'Fast food & beverages');
  const chai   = await vendor('chai-garam', 'Chai Garam', 'Tea & snacks');
  const tulips = await vendor('tulips', 'Tulips', 'North Indian & meals');

  const item = (v, name, rupees, opts = {}) => c.query(
    `INSERT INTO menu_item (vendor_id, name, description, price_paise, veg, prep_minutes, tags, aliases)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [v, name, opts.desc || null, Math.round(rupees * 100), opts.veg ?? true,
     opts.prep || null, opts.tags || [], opts.aliases || []]);

  /* Descriptions are plain statements of what the dish is. Nothing here is
     a rating, a price claim beyond the menu price, or a photo. */
  await item(frisco, 'Veg Burger', 90, { tags: ['burger'], aliases: ['burger', 'veg burger'], prep: 8, desc: 'Crisp vegetable patty, lettuce, onion and mint mayo in a toasted bun.' });
  await item(frisco, 'Chicken Burger', 130, { veg: false, tags: ['burger'], aliases: ['chicken burger'], prep: 10, desc: 'Crumb-fried chicken fillet with slaw and house sauce.' });
  await item(frisco, 'Paneer Tikka Wrap', 110, { tags: ['wrap'], aliases: ['paneer wrap', 'wrap'], prep: 8, desc: 'Tandoori paneer, onion and mint chutney rolled in a soft wrap.' });
  await item(frisco, 'French Fries', 60, { tags: ['snack'], aliases: ['fries'], prep: 6, desc: 'Salted, crisp-fried potato fries.' });
  await item(frisco, 'Peri Peri Fries', 80, { tags: ['snack', 'spicy'], aliases: ['peri peri', 'spicy fries'], prep: 6, desc: 'Fries tossed in peri peri seasoning.' });
  await item(frisco, 'Cheese Garlic Bread', 80, { tags: ['snack'], aliases: ['garlic bread'], prep: 7, desc: 'Toasted garlic bread topped with melted cheese.' });
  await item(frisco, 'Cold Coffee', 70, { tags: ['beverage', 'cold'], aliases: ['cold coffee', 'coffee'], prep: 5, desc: 'Blended with milk and ice, lightly sweet.' });
  await item(frisco, 'Chocolate Shake', 90, { tags: ['beverage', 'cold'], aliases: ['shake', 'chocolate shake'], prep: 5, desc: 'Thick chocolate milkshake.' });

  await item(chai, 'Masala Chai', 20, { tags: ['beverage', 'tea'], aliases: ['chai', 'tea'], prep: 4, desc: 'Milk tea brewed with ginger, cardamom and clove.' });
  await item(chai, 'Ginger Tea', 25, { tags: ['beverage', 'tea'], aliases: ['adrak chai', 'ginger tea'], prep: 4, desc: 'Strong milk tea with fresh ginger.' });
  await item(chai, 'Cold Coffee', 60, { tags: ['beverage', 'cold'], aliases: ['cold coffee'], prep: 5, desc: 'Chilled and frothy, made to order.' });
  await item(chai, 'Veg Sandwich', 50, { tags: ['snack'], aliases: ['sandwich'], prep: 6, desc: 'Grilled three-layer sandwich with green chutney.' });
  await item(chai, 'Maggi', 45, { tags: ['snack'], aliases: ['maggi', 'noodles'], prep: 8, desc: 'Masala noodles, cooked fresh.' });
  await item(chai, 'Samosa', 20, { tags: ['snack'], aliases: ['samosa'], prep: 2, desc: 'Potato and pea filling in a crisp pastry, with chutney.' });
  await item(chai, 'Bun Maska', 30, { tags: ['snack'], aliases: ['bun maska'], prep: 3, desc: 'Soft bun with a generous layer of butter.' });
  await item(chai, 'Vada Pav', 35, { tags: ['snack'], aliases: ['vada pav'], prep: 4, desc: 'Spiced potato vada in a pav with dry garlic chutney.' });
  await item(chai, 'Aloo Paratha', 60, { tags: ['meal'], aliases: ['paratha', 'aloo paratha'], prep: 10, desc: 'Two stuffed parathas with curd and pickle.' });

  await item(tulips, 'Rajma Chawal', 110, { tags: ['meal', 'filling'], aliases: ['rajma', 'rajma chawal'], prep: 12, desc: 'Slow-cooked kidney bean curry with steamed rice.' });
  await item(tulips, 'Chole Bhature', 120, { tags: ['meal', 'filling'], aliases: ['chole', 'bhature'], prep: 14, desc: 'Spiced chickpea curry with two fried bhature.' });
  await item(tulips, 'Paneer Butter Masala', 150, { tags: ['meal', 'filling'], aliases: ['paneer'], prep: 15, desc: 'Paneer in a tomato and butter gravy. Pair with naan or rice.' });
  await item(tulips, 'Dal Makhani Thali', 140, { tags: ['meal', 'thali', 'filling'], aliases: ['thali', 'dal makhani'], prep: 15, desc: 'Dal makhani, seasonal sabzi, rice, two rotis and salad.' });
  await item(tulips, 'Chicken Curry Thali', 180, { veg: false, tags: ['meal', 'thali'], aliases: ['chicken thali'], prep: 18, desc: 'Home-style chicken curry, rice, two rotis and salad.' });
  await item(tulips, 'Jeera Rice', 80, { tags: ['meal', 'rice'], aliases: ['jeera rice'], prep: 8, desc: 'Basmati rice tempered with cumin.' });
  await item(tulips, 'Butter Naan', 25, { tags: ['meal', 'bread'], aliases: ['naan'], prep: 6, desc: 'Tandoor naan brushed with butter.' });
  await item(tulips, 'Sweet Lassi', 50, { tags: ['beverage', 'cold'], aliases: ['lassi'], prep: 4, desc: 'Chilled sweet yoghurt drink.' });
  await item(tulips, 'Gulab Jamun', 40, { tags: ['dessert', 'sweet'], aliases: ['gulab jamun'], prep: 2, desc: 'Two warm gulab jamun in syrup.' });

  console.log('✓ 3 cafeterias, 26 menu items (closed; an owner must open them)');
  console.log('  no ratings, orders, students or partners created — those must be real');

  await c.query('COMMIT');
} catch (e) {
  await c.query('ROLLBACK');
  console.error(e);
  process.exit(1);
} finally {
  c.release();
  await pool.end();
}
