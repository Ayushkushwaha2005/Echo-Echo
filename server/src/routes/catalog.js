/* ==========================================================================
   QUAD — CATALOG

   Vendors, menus, prices, photos and ratings.

   Two things worth knowing:

   * Ratings are computed from the review table with COUNT alongside AVG,
     and the API returns `rating: null` when there are none. There is no
     seeded 4.8 anywhere. Surfaces render "No ratings yet" from that null.
   * A price change writes menu_price_history and updates menu_item, but
     never touches order_item — historical orders carry their own snapshot.
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { authorize, can, BadRequest, NotFound } from '../auth/rbac.js';
import { audit } from '../audit.js';

/* The owning vendor of a resource is always re-read from the database.
   Trusting a vendorId from the request body would defeat the scope check. */
async function vendorOfItem(id) {
  const r = await one(`SELECT vendor_id FROM menu_item WHERE id = $1`, [id]);
  if (!r) throw NotFound('No such menu item');
  return r.vendor_id;
}

const RATING = `
  (SELECT json_build_object(
     'average', round(avg(stars)::numeric, 2),
     'count', count(*)::int,
     'distribution', json_build_object(
        '1', count(*) FILTER (WHERE stars = 1), '2', count(*) FILTER (WHERE stars = 2),
        '3', count(*) FILTER (WHERE stars = 3), '4', count(*) FILTER (WHERE stars = 4),
        '5', count(*) FILTER (WHERE stars = 5)))
     FROM review r WHERE `;

export default async function catalogRoutes(app) {
  /* ---------- vendors ---------------------------------------------------- */
  app.get('/vendors', async (req) => {
    const all = req.query?.includeArchived === 'true';
    if (all) authorize(req.actor, 'vendor.update');
    /* Outlets are listed per campus. A signed-in student sees their own
       campus unless they ask for another one explicitly; a campus that is
       not in service lists its outlets with ordering closed. */
    const campusId = req.query?.campusId || null;
    const { rows } = await q(
      `SELECT v.id, v.slug, v.name, v.kind, v.description, v.photo_asset,
              v.campus_node_id, v.opens_at, v.closes_at, v.is_open, v.accepting,
              v.delivery_enabled, v.prep_minutes, v.active, v.campus_site_id,
              cs.name AS campus_name, cs.service_status AS campus_service_status,
              ${RATING} r.vendor_id = v.id AND NOT r.hidden) AS rating
         FROM vendor v LEFT JOIN campus_site cs ON cs.id = v.campus_site_id
        WHERE ($1::boolean OR v.active)
          AND ($2::uuid IS NULL OR v.campus_site_id = $2)
        ORDER BY v.active DESC, v.name`, [all, campusId]);
    return { vendors: rows.map(shapeRating) };
  });

  app.get('/vendors/:id/menu', async (req) => {
    const v = await one(`SELECT * FROM vendor WHERE id = $1`, [req.params.id]);
    if (!v) throw NotFound('No such cafeteria');
    /* Staff see unavailable and archived rows; customers do not. */
    const privileged = req.actor && (
      req.actor.vendorIds.includes(v.id) ||
      can(req.actor, 'menu.read'));
    const { rows } = await q(
      `SELECT i.id, i.name, i.description, i.price_paise, i.veg, i.prep_minutes,
              i.tags, i.aliases, i.available, i.active, i.photo_asset,
              c.name AS category,
              ${RATING} r.item_id = i.id AND NOT r.hidden) AS rating
         FROM menu_item i LEFT JOIN category c ON c.id = i.category_id
        WHERE i.vendor_id = $1 AND ($2::boolean OR i.active)
        ORDER BY c.sort NULLS LAST, i.name`, [v.id, !!privileged]);
    return { vendor: v, items: rows.map(shapeRating) };
  });

  app.post('/vendors', async (req) => {
    authorize(req.actor, 'vendor.create');
    const b = req.body || {};
    if (!b.name) throw BadRequest('Cafeteria name is required');
    const slug = String(b.slug || b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    /* Every outlet belongs to a campus. With exactly one campus in service,
       that is the default; otherwise the administrator must say which. */
    let campusSiteId = b.campusSiteId || null;
    if (!campusSiteId) {
      const live = (await q(`SELECT id FROM campus_site WHERE service_status = 'active'`)).rows;
      if (live.length !== 1) throw BadRequest('Choose the campus this cafeteria is on');
      campusSiteId = live[0].id;
    } else if (!(await one(`SELECT 1 FROM campus_site WHERE id = $1`, [campusSiteId]))) {
      throw BadRequest('No such campus');
    }
    const row = await one(
      `INSERT INTO vendor (slug, name, kind, description, campus_node_id,
                           opens_at, closes_at, prep_minutes, staff_can_deliver, delivery_enabled,
                           campus_site_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [slug, b.name, b.kind || 'Campus outlet', b.description || null, b.campusNodeId || null,
       b.opensAt || null, b.closesAt || null, b.prepMinutes || 10,
       !!b.staffCanDeliver, b.deliveryEnabled !== false, campusSiteId]);
    await audit(req, { action: 'vendor.create', resource: 'vendor', resourceId: row.id,
                       outcome: 'ok', detail: { name: row.name } });
    /* Created closed. The owner opens it — the platform does not decide
       that an outlet is trading. */
    return row;
  });

  app.patch('/vendors/:id', async (req) => {
    authorize(req.actor, 'vendor.update', { vendorId: req.params.id });
    const b = req.body || {};
    const map = { name: b.name, kind: b.kind, description: b.description,
                  campus_node_id: b.campusNodeId, opens_at: b.opensAt, closes_at: b.closesAt,
                  is_open: b.isOpen, accepting: b.accepting, prep_minutes: b.prepMinutes,
                  delivery_enabled: b.deliveryEnabled, staff_can_deliver: b.staffCanDeliver };
    /* Archiving is a separate, admin-only action — an owner cannot make
       their outlet vanish from the platform's records. */
    if (b.active !== undefined) authorize(req.actor, 'vendor.archive');
    if (b.active !== undefined) map.active = b.active;
    /* The business contact shown to customers. Personal numbers do not
       belong here; the counter owner decides whether it is public. */
    if (b.contactPhone !== undefined) {
      const raw = String(b.contactPhone || '').trim();
      if (raw && !/^\+?[0-9 ()-]{8,16}$/.test(raw)) throw BadRequest('Enter a valid business phone number');
      map.contact_phone = raw || null;
    }
    if (b.contactPublic !== undefined) map.contact_public = !!b.contactPublic;
    /* Where orders are collected from: a location on the outlet's own campus. */
    if (b.campusNodeId) {
      const node = await one(
        `SELECT n.id FROM campus_node n JOIN vendor v ON v.campus_site_id = n.campus_site_id
          WHERE n.id = $1 AND v.id = $2 AND n.active`, [b.campusNodeId, req.params.id]);
      if (!node) throw BadRequest('Choose a pickup point on this cafeteria\'s campus');
    }
    /* Moving an outlet to another campus is a platform decision. */
    if (b.campusSiteId !== undefined) {
      authorize(req.actor, 'vendor.create');
      if (!(await one(`SELECT 1 FROM campus_site WHERE id = $1`, [b.campusSiteId]))) throw BadRequest('No such campus');
      map.campus_site_id = b.campusSiteId;
    }

    const set = [], vals = [];
    for (const [k, v] of Object.entries(map)) {
      if (v !== undefined) { vals.push(v); set.push(`${k} = $${vals.length}`); }
    }
    if (!set.length) throw BadRequest('Nothing to update');
    vals.push(req.params.id);
    const row = await one(`UPDATE vendor SET ${set.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    if (!row) throw NotFound('No such cafeteria');
    await audit(req, { action: 'vendor.update', resource: 'vendor', resourceId: row.id, outcome: 'ok',
                       detail: { changed: Object.keys(map).filter((k) => map[k] !== undefined) } });
    return row;
  });

  /* ---------- menu items -------------------------------------------------- */
  app.post('/vendors/:id/menu', async (req) => {
    authorize(req.actor, 'menu.create', { vendorId: req.params.id });
    const b = req.body || {};
    if (!b.name) throw BadRequest('Item name is required');
    const paise = toPaise(b.price);
    const row = await one(
      `INSERT INTO menu_item (vendor_id, category_id, name, description, price_paise,
                              veg, prep_minutes, tags, aliases, available, photo_asset)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, b.categoryId || null, b.name, b.description || null, paise,
       b.veg ?? null, b.prepMinutes || null, b.tags || [], b.aliases || [],
       b.available !== false, b.photoAsset || null]);
    await q(`INSERT INTO menu_price_history (item_id, old_paise, new_paise, changed_by)
             VALUES ($1, NULL, $2, $3)`, [row.id, paise, req.actor.id]);
    await audit(req, { action: 'menu.create', resource: 'menu_item', resourceId: row.id,
                       outcome: 'ok', detail: { name: row.name, vendor: req.params.id } });
    return row;
  });

  app.patch('/menu/:id', async (req) => {
    const vendorId = await vendorOfItem(req.params.id);
    const b = req.body || {};

    /* Distinct capabilities: staff may flip availability but not price. */
    if (b.price !== undefined) authorize(req.actor, 'menu.price', { vendorId });
    if (b.available !== undefined) authorize(req.actor, 'menu.availability', { vendorId });
    if (b.photoAsset !== undefined) authorize(req.actor, 'menu.photo', { vendorId });
    const other = ['name', 'description', 'veg', 'prepMinutes', 'tags', 'aliases', 'categoryId', 'active']
      .some((k) => b[k] !== undefined);
    if (other) authorize(req.actor, 'menu.update', { vendorId });

    return tx(async (c) => {
      const cur = (await c.query(`SELECT * FROM menu_item WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!cur) throw NotFound('No such menu item');

      const map = { name: b.name, description: b.description, veg: b.veg,
                    prep_minutes: b.prepMinutes, tags: b.tags, aliases: b.aliases,
                    category_id: b.categoryId, available: b.available, active: b.active,
                    photo_asset: b.photoAsset };
      if (b.price !== undefined) map.price_paise = toPaise(b.price);

      const set = [], vals = [];
      for (const [k, v] of Object.entries(map)) {
        if (v !== undefined) { vals.push(v); set.push(`${k} = $${vals.length}`); }
      }
      if (!set.length) throw BadRequest('Nothing to update');
      vals.push(req.params.id);
      const row = (await c.query(
        `UPDATE menu_item SET ${set.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals)).rows[0];

      if (map.price_paise !== undefined && map.price_paise !== cur.price_paise) {
        await c.query(
          `INSERT INTO menu_price_history (item_id, old_paise, new_paise, changed_by)
           VALUES ($1,$2,$3,$4)`, [row.id, cur.price_paise, map.price_paise, req.actor.id]);
        await audit(req, { action: 'menu.price', resource: 'menu_item', resourceId: row.id,
                           outcome: 'ok', detail: { from: cur.price_paise, to: map.price_paise } });
      }
      await audit(req, { action: 'menu.update', resource: 'menu_item', resourceId: row.id, outcome: 'ok' });
      return row;
    });
  });

  app.get('/menu/:id/price-history', async (req) => {
    const vendorId = await vendorOfItem(req.params.id);
    authorize(req.actor, 'menu.update', { vendorId });
    const { rows } = await q(
      `SELECT h.old_paise, h.new_paise, h.changed_at, u.name AS changed_by
         FROM menu_price_history h LEFT JOIN app_user u ON u.id = h.changed_by
        WHERE h.item_id = $1 ORDER BY h.changed_at DESC`, [req.params.id]);
    return { history: rows };
  });

  /* ---------- search (also the AI's search_menu tool) --------------------- */
  app.get('/menu/search', async (req) => {
    const term = String(req.query?.q || '').trim();
    const maxPaise = req.query?.maxPrice ? toPaise(req.query.maxPrice) : null;
    if (term.length < 2 && !maxPaise) return { items: [] };
    const { rows } = await q(
      `SELECT i.id, i.name, i.description, i.price_paise, i.veg, i.available,
              i.tags, i.prep_minutes, v.id AS vendor_id, v.name AS vendor_name,
              v.is_open, v.accepting,
              ${RATING} r.item_id = i.id AND NOT r.hidden) AS rating
         FROM menu_item i JOIN vendor v ON v.id = i.vendor_id
        WHERE i.active AND v.active
          AND ($1 = '' OR i.name ILIKE $2 OR EXISTS (
                SELECT 1 FROM unnest(i.aliases) a WHERE a ILIKE $2)
              OR EXISTS (SELECT 1 FROM unnest(i.tags) t WHERE t ILIKE $2))
          AND ($3::int IS NULL OR i.price_paise <= $3)
        ORDER BY i.available DESC, i.price_paise
        LIMIT 40`, [term, `%${term}%`, maxPaise]);
    return { items: rows.map(shapeRating) };
  });
}

/* ₹ to paise, via integers only — no float ever holds money. */
export function toPaise(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw BadRequest('Enter a price like 95 or 95.50');
  const [r, p = ''] = s.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}

/* count 0 → rating null. The surfaces key "No ratings yet" off this. */
function shapeRating(row) {
  const r = row.rating;
  row.rating = r && r.count > 0
    ? { average: Number(r.average), count: r.count, distribution: r.distribution }
    : null;
  return row;
}
