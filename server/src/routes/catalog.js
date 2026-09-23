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
import { authorize, can, BadRequest, NotFound, HttpError } from '../auth/rbac.js';
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
              i.category_id, c.name AS category,
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
    const b = req.body || {};
    /* Opening, closing and pausing orders is its own capability, so it can be
       held without the right to rename the outlet or move its pickup point. */
    const TOGGLES = ['isOpen', 'accepting'];
    const keys = Object.keys(b).filter((k) => b[k] !== undefined);
    if (keys.length && keys.every((k) => TOGGLES.includes(k))) {
      authorize(req.actor, 'vendor.toggle', { vendorId: req.params.id });
    } else {
      authorize(req.actor, 'vendor.update', { vendorId: req.params.id });
    }
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
    if (!String(b.name || '').trim()) throw BadRequest('Item name is required');
    const paise = toPaise(b.price);
    await assertCategoryOf(b.categoryId, req.params.id);
    const row = await one(
      `INSERT INTO menu_item (vendor_id, category_id, name, description, price_paise,
                              veg, prep_minutes, tags, aliases, available, photo_asset)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, b.categoryId || null, String(b.name).trim(), b.description || null, paise,
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
    if (b.active !== undefined) authorize(req.actor, 'menu.archive', { vendorId });
    const other = ['name', 'description', 'veg', 'prepMinutes', 'tags', 'aliases', 'categoryId']
      .some((k) => b[k] !== undefined);
    if (other) authorize(req.actor, 'menu.update', { vendorId });
    if (b.name !== undefined && !String(b.name || '').trim()) throw BadRequest('Item name is required');
    await assertCategoryOf(b.categoryId, vendorId);

    return tx(async (c) => {
      const cur = (await c.query(`SELECT * FROM menu_item WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!cur) throw NotFound('No such menu item');

      const map = { name: b.name, description: b.description, veg: b.veg,
                    prep_minutes: b.prepMinutes, tags: b.tags, aliases: b.aliases,
                    category_id: b.categoryId === '' ? null : b.categoryId,
                    available: b.available, active: b.active,
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

  /* Deleting is for a mistake: an item nobody has ever ordered. Anything that
     appears on an order stays, because the order, its receipt and any review
     point at it; that item is archived instead, which hides it from students
     and keeps the history whole. The database enforces this too: order_item
     references menu_item with no cascade. */
  app.delete('/menu/:id', async (req) => {
    const vendorId = await vendorOfItem(req.params.id);
    authorize(req.actor, 'menu.archive', { vendorId });
    return tx(async (c) => {
      const cur = (await c.query(`SELECT id, name, photo_asset FROM menu_item WHERE id = $1 FOR UPDATE`,
        [req.params.id])).rows[0];
      if (!cur) throw NotFound('No such menu item');
      const used = (await c.query(
        `SELECT (SELECT count(*) FROM order_item WHERE item_id = $1)
              + (SELECT count(*) FROM review WHERE item_id = $1) AS n`, [cur.id])).rows[0];
      if (Number(used.n) > 0) {
        throw new HttpError(409, 'item_has_orders', 'This item has been ordered, so it cannot be deleted',
          'Archive it instead: it disappears from the menu and its order history stays intact.');
      }
      await c.query(`DELETE FROM menu_price_history WHERE item_id = $1`, [cur.id]);
      await c.query(`DELETE FROM menu_item WHERE id = $1`, [cur.id]);
      await audit(req, { action: 'menu.delete', resource: 'menu_item', resourceId: cur.id,
                         outcome: 'ok', detail: { name: cur.name, vendor: vendorId } });
      return { deleted: true, id: cur.id };
    });
  });

  /* ---------- categories ------------------------------------------------------
     A cafeteria's own sections ("Chai", "Snacks"). They belong to one outlet,
     are named by its owner, and are never shared across outlets. */
  app.get('/vendors/:id/categories', async (req) => {
    if (!(await one(`SELECT 1 FROM vendor WHERE id = $1`, [req.params.id]))) throw NotFound('No such cafeteria');
    const { rows } = await q(
      `SELECT c.id, c.name, c.sort,
              (SELECT count(*)::int FROM menu_item i WHERE i.category_id = c.id AND i.active) AS items
         FROM category c WHERE c.vendor_id = $1 ORDER BY c.sort, c.name`, [req.params.id]);
    return { categories: rows };
  });

  app.post('/vendors/:id/categories', async (req) => {
    authorize(req.actor, 'menu.update', { vendorId: req.params.id });
    const name = categoryName(req.body?.name);
    if (!(await one(`SELECT 1 FROM vendor WHERE id = $1`, [req.params.id]))) throw NotFound('No such cafeteria');
    if (await one(`SELECT 1 FROM category WHERE vendor_id = $1 AND lower(name) = lower($2)`, [req.params.id, name])) {
      throw BadRequest('This cafeteria already has a category with that name');
    }
    const sort = Number.isInteger(req.body?.sort) ? req.body.sort
      : (await one(`SELECT coalesce(max(sort), -1) + 1 AS n FROM category WHERE vendor_id = $1`, [req.params.id])).n;
    const row = await one(`INSERT INTO category (vendor_id, name, sort) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, name, sort]);
    await audit(req, { action: 'menu.category.create', resource: 'category', resourceId: row.id,
                       outcome: 'ok', detail: { name, vendor: req.params.id } });
    return row;
  });

  app.patch('/categories/:id', async (req) => {
    const cat = await categoryById(req.params.id);
    authorize(req.actor, 'menu.update', { vendorId: cat.vendor_id });
    const b = req.body || {};
    const name = b.name !== undefined ? categoryName(b.name) : cat.name;
    if (await one(
      `SELECT 1 FROM category WHERE vendor_id = $1 AND lower(name) = lower($2) AND id <> $3`,
      [cat.vendor_id, name, cat.id])) {
      throw BadRequest('This cafeteria already has a category with that name');
    }
    const sort = Number.isInteger(b.sort) ? b.sort : cat.sort;
    const row = await one(`UPDATE category SET name = $1, sort = $2 WHERE id = $3 RETURNING *`, [name, sort, cat.id]);
    await audit(req, { action: 'menu.category.update', resource: 'category', resourceId: cat.id, outcome: 'ok' });
    return row;
  });

  /* Removing a category never removes food: its items become uncategorised. */
  app.delete('/categories/:id', async (req) => {
    const cat = await categoryById(req.params.id);
    authorize(req.actor, 'menu.update', { vendorId: cat.vendor_id });
    const moved = await tx(async (c) => {
      const r = await c.query(`UPDATE menu_item SET category_id = NULL WHERE category_id = $1`, [cat.id]);
      await c.query(`DELETE FROM category WHERE id = $1`, [cat.id]);
      return r.rowCount;
    });
    await audit(req, { action: 'menu.category.delete', resource: 'category', resourceId: cat.id,
                       outcome: 'ok', detail: { name: cat.name, itemsUncategorised: moved } });
    return { deleted: true, itemsUncategorised: moved };
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function categoryById(id) {
  const cat = UUID.test(String(id)) ? await one(`SELECT * FROM category WHERE id = $1`, [id]) : null;
  if (!cat) throw NotFound('No such category');
  return cat;
}

/* A category named on an item must belong to that item's own cafeteria.
   Without this, an owner could file their dish under another outlet's
   category id: a cross-tenant write that the FK alone would allow. */
async function assertCategoryOf(categoryId, vendorId) {
  if (categoryId === undefined || categoryId === null || categoryId === '') return;
  const ok = UUID.test(String(categoryId))
    && await one(`SELECT 1 FROM category WHERE id = $1 AND vendor_id = $2`, [categoryId, vendorId]);
  if (!ok) throw BadRequest("Choose one of this cafeteria's own categories");
}

function categoryName(v) {
  const name = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw BadRequest('Category name is required');
  if (name.length > 40) throw BadRequest('Keep the category name under 40 characters');
  return name;
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
