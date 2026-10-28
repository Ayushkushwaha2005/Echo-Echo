/* ==========================================================================
   ECHO ECHO — WEBSITE CUSTOMIZATION API

   Public (no session):
     GET  /site/config          the PUBLISHED configuration, and nothing else
     GET  /site/version         just its version number, for cheap polling

   Campus Control (permission-checked here, not by the screen):
     GET  /admin/site                    draft, live version, options
     POST /admin/site/validate           check a configuration, change nothing
     PUT  /admin/site/draft              save the shared draft (optimistic)
     POST /admin/site/draft/reset        draft := what is live
     POST /admin/site/publish            draft -> new live version
     POST /admin/site/rollback           an earlier version -> new live version
     GET  /admin/site/versions           publication history
     GET  /admin/site/versions/:version  one published configuration

   The rules that matter:
     · a draft is never served publicly; /site/config reads only the version
       the live pointer names
     · publishing re-validates the draft, writes the version and moves the
       pointer in ONE transaction - a failure leaves the old version live
     · a save or publish naming a stale draft revision is a 409, so two
       administrators cannot silently overwrite each other
     · publish and rollback need a recent password + authenticator
       confirmation, like every other action that changes the live product
   ========================================================================== */
import { q, one, tx } from '../db/index.js';
import { authorize, can, BadRequest, NotFound, Conflict, HttpError } from '../auth/rbac.js';
import { assertRecentPasskey } from '../auth/passkey-policy.js';
import { audit } from '../audit.js';
import {
  validate, checkReferences, defaults, SCHEMA_VERSION, FONTS, DENSITIES, APPEARANCES, TONES,
  HOME_SECTIONS, ROUTES, LIMITS,
} from '../services/site-config.js';

const Invalid = (problems) => Object.assign(
  new HttpError(400, 'invalid_config', 'The website settings have problems',
    problems.slice(0, 3).map((p) => `${p.path} ${p.problem}`).join('; ')),
  { problems });

/** Full check: shape first, then what only the database can confirm. */
async function check(config, runner = { q }) {
  const v = validate(config);
  if (!v.ok) return v;
  const refs = await checkReferences(v.config, runner);
  return refs.length ? { ok: false, problems: refs } : v;
}

const revisionOf = (body) => {
  const r = Number(body?.revision);
  if (!Number.isInteger(r) || r < 0) throw BadRequest('revision must be the draft revision you started from');
  return r;
};

/* The live configuration as visitors receive it. Scheduled or switched-off
   banners are dropped on the server's clock; featured dishes are resolved to
   what a menu would show (active dish, active café), so featuring something
   cannot make it orderable or reveal an archived row. */
async function publicView() {
  const row = await one(
    `SELECT v.version, v.config, v.published_at FROM site_config_live l
       JOIN site_config_version v ON v.version = l.version WHERE l.id`);
  if (!row) return { version: 0, publishedAt: null, config: null, featuredItems: [] };
  const now = Date.now();
  const config = { ...row.config };
  config.banners = (config.banners || []).filter((b) => b.active
    && (!b.startsAt || Date.parse(b.startsAt) <= now) && (!b.endsAt || Date.parse(b.endsAt) > now));
  const ids = config.featured?.itemIds || [];
  const featuredItems = ids.length ? (await q(
    `SELECT i.id, i.vendor_id AS "vendorId", i.name, i.price_paise AS "pricePaise", i.veg,
            i.available, i.photo_asset AS "photoAsset", v.name AS "vendorName"
       FROM menu_item i JOIN vendor v ON v.id = i.vendor_id
      WHERE i.id = ANY($1::uuid[]) AND i.active AND v.active`, [ids])).rows
    .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)) : [];
  return { version: row.version, publishedAt: row.published_at, config, featuredItems };
}

async function liveRow(c = { query: q }) {
  return (await c.query(
    `SELECT v.version, v.config, v.published_at, v.note, v.kind, u.name AS published_by_name
       FROM site_config_live l JOIN site_config_version v ON v.version = l.version
       LEFT JOIN app_user u ON u.id = v.published_by WHERE l.id`)).rows[0] || null;
}

/* Move the live pointer to a new version. Runs inside the caller's
   transaction; the exclusive lock serialises concurrent publishes so two
   cannot both claim the same version number. */
async function publishVersion(c, { config, actorId, note, kind, from }) {
  await c.query('LOCK TABLE site_config_live IN EXCLUSIVE MODE');
  const next = (await c.query(`SELECT COALESCE(max(version), 0) + 1 AS v FROM site_config_version`)).rows[0].v;
  await c.query(
    `INSERT INTO site_config_version (version, config, schema, note, kind, rolled_back_from, published_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [next, config, SCHEMA_VERSION, note || null, kind, from || null, actorId]);
  await c.query(
    `INSERT INTO site_config_live (id, version, updated_at) VALUES (true, $1, now())
     ON CONFLICT (id) DO UPDATE SET version = $1, updated_at = now()`, [next]);
  return next;
}

const noteOf = (body) => {
  const n = body?.note == null ? '' : String(body.note).trim();
  if (n.length > 200) throw BadRequest('The note can be at most 200 characters');
  return n;
};

export default async function siteRoutes(app) {
  /* ---------- public -------------------------------------------------------- */
  app.get('/site/config', async (req, reply) => {
    /* Browsers revalidate every time; the CDN in front (vercel.json) holds
       it for a few seconds, which is what bounds publish-to-visible time. */
    reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
    return publicView();
  });

  app.get('/site/version', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
    const row = await one(`SELECT version FROM site_config_live WHERE id`);
    return { version: row?.version || 0 };
  });

  /* ---------- Campus Control ------------------------------------------------ */
  app.get('/admin/site', async (req) => {
    authorize(req.actor, 'site.read');
    const live = await liveRow();
    const draft = await one(
      `SELECT d.config, d.revision, d.base_version, d.updated_at, u.name AS updated_by_name
         FROM site_config_draft d LEFT JOIN app_user u ON u.id = d.updated_by WHERE d.id`);
    return {
      draft: draft
        ? { config: draft.config, revision: draft.revision, baseVersion: draft.base_version,
            updatedAt: draft.updated_at, updatedBy: draft.updated_by_name }
        /* Nothing saved yet: start from what is live, or from the shipped
           website. Revision 0 means "no draft row exists". */
        : { config: live?.config || defaults(), revision: 0, baseVersion: live?.version || null,
            updatedAt: null, updatedBy: null },
      live: live ? { version: live.version, config: live.config, publishedAt: live.published_at,
                     publishedBy: live.published_by_name, note: live.note, kind: live.kind } : null,
      defaults: defaults(),
      options: { fonts: FONTS, densities: DENSITIES, appearances: APPEARANCES, tones: TONES,
                 sections: HOME_SECTIONS, routes: ROUTES, limits: LIMITS, schema: SCHEMA_VERSION },
      can: { edit: can(req.actor, 'site.draft'), publish: can(req.actor, 'site.publish') },
    };
  });

  app.post('/admin/site/validate', async (req) => {
    authorize(req.actor, 'site.read');
    const v = await check(req.body?.config);
    return { ok: v.ok, problems: v.problems };
  });

  app.put('/admin/site/draft', async (req) => {
    authorize(req.actor, 'site.draft');
    const revision = revisionOf(req.body);
    const v = await check(req.body?.config);
    if (!v.ok) throw Invalid(v.problems);

    const live = await one(`SELECT version FROM site_config_live WHERE id`);
    const saved = revision === 0
      ? await one(
        `INSERT INTO site_config_draft (id, config, revision, base_version, updated_by)
         VALUES (true, $1, 1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING revision, updated_at`,
        [v.config, live?.version || null, req.actor.id])
      : await one(
        `UPDATE site_config_draft SET config = $1, revision = revision + 1, updated_by = $2, updated_at = now()
          WHERE id AND revision = $3 RETURNING revision, updated_at`,
        [v.config, req.actor.id, revision]);
    if (!saved) {
      const cur = await one(
        `SELECT d.revision, d.updated_at, u.name FROM site_config_draft d
           LEFT JOIN app_user u ON u.id = d.updated_by WHERE d.id`);
      throw Conflict('Someone else saved the draft first',
        `${cur?.name || 'Another administrator'} saved revision ${cur?.revision} at ${cur?.updated_at?.toISOString?.() || 'an earlier time'}. Reload the draft to see their changes before saving yours.`);
    }
    await audit(req, { action: 'site.draft.save', resource: 'site_config', resourceId: 'draft',
                       outcome: 'ok', detail: { revision: saved.revision } });
    return { revision: saved.revision, updatedAt: saved.updated_at, config: v.config };
  });

  app.post('/admin/site/draft/reset', async (req) => {
    authorize(req.actor, 'site.draft');
    const revision = revisionOf(req.body);
    const live = await liveRow();
    const config = live?.config || defaults();
    const saved = revision === 0
      ? await one(
        `INSERT INTO site_config_draft (id, config, revision, base_version, updated_by)
         VALUES (true, $1, 1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING revision, updated_at`,
        [config, live?.version || null, req.actor.id])
      : await one(
        `UPDATE site_config_draft SET config = $1, revision = revision + 1, base_version = $2,
                updated_by = $3, updated_at = now()
          WHERE id AND revision = $4 RETURNING revision, updated_at`,
        [config, live?.version || null, req.actor.id, revision]);
    if (!saved) throw Conflict('Someone else saved the draft first', 'Reload the draft, then reset it.');
    await audit(req, { action: 'site.draft.reset', resource: 'site_config', resourceId: 'draft',
                       outcome: 'ok', detail: { toVersion: live?.version || 0 } });
    return { revision: saved.revision, updatedAt: saved.updated_at, config };
  });

  app.post('/admin/site/publish', async (req) => {
    authorize(req.actor, 'site.publish');
    assertRecentPasskey(req.actor, 'publishing the website');
    const revision = revisionOf(req.body);
    const note = noteOf(req.body);

    const version = await tx(async (c) => {
      const d = (await c.query(`SELECT config, revision FROM site_config_draft WHERE id FOR UPDATE`)).rows[0];
      if (!d) throw Conflict('There is no saved draft to publish', 'Save the draft first.');
      if (d.revision !== revision) {
        throw Conflict('The draft changed since you loaded it',
          `You are publishing revision ${revision}; the saved draft is revision ${d.revision}. Reload and check it first.`);
      }
      /* Re-checked inside the transaction: a café archived or an image
         deleted since the draft was saved stops the publish here. */
      const v = await check(d.config, { q: (t, p) => c.query(t, p) });
      if (!v.ok) throw Invalid(v.problems);
      const n = await publishVersion(c, { config: v.config, actorId: req.actor.id, note, kind: 'publish' });
      await c.query(`UPDATE site_config_draft SET base_version = $1 WHERE id`, [n]);
      return n;
    });
    await audit(req, { action: 'site.publish', resource: 'site_config', resourceId: String(version),
                       outcome: 'ok', detail: { version, revision, note: note || null } });
    return { version, publishedAt: new Date().toISOString() };
  });

  app.post('/admin/site/rollback', async (req) => {
    authorize(req.actor, 'site.publish');
    assertRecentPasskey(req.actor, 'rolling the website back');
    const target = Number(req.body?.version);
    if (!Number.isInteger(target) || target < 1) throw BadRequest('version must be a published version number');
    const note = noteOf(req.body);

    const version = await tx(async (c) => {
      const old = (await c.query(`SELECT config FROM site_config_version WHERE version = $1`, [target])).rows[0];
      if (!old) throw NotFound(`Version ${target} was never published`);
      const live = (await c.query(`SELECT version FROM site_config_live WHERE id`)).rows[0];
      if (live?.version === target) throw Conflict(`Version ${target} is already live`);
      /* An old version can name a café or image that has since gone. */
      const v = await check(old.config, { q: (t, p) => c.query(t, p) });
      if (!v.ok) throw Invalid(v.problems);
      return publishVersion(c, { config: v.config, actorId: req.actor.id,
                                 note: note || `Rolled back to version ${target}`, kind: 'rollback', from: target });
    });
    await audit(req, { action: 'site.rollback', resource: 'site_config', resourceId: String(version),
                       outcome: 'ok', detail: { version, restored: target } });
    return { version, restored: target };
  });

  app.get('/admin/site/versions', async (req) => {
    authorize(req.actor, 'site.read');
    const { rows } = await q(
      `SELECT v.version, v.kind, v.note, v.rolled_back_from AS "rolledBackFrom", v.published_at AS "publishedAt",
              u.name AS "publishedBy", (l.version = v.version) AS live
         FROM site_config_version v LEFT JOIN app_user u ON u.id = v.published_by
         LEFT JOIN site_config_live l ON l.id
        ORDER BY v.version DESC LIMIT 100`);
    return { versions: rows.map((r) => ({ ...r, live: !!r.live })) };
  });

  app.get('/admin/site/versions/:version', async (req) => {
    authorize(req.actor, 'site.read');
    const n = Number(req.params.version);
    if (!Number.isInteger(n) || n < 1) throw BadRequest('version must be a number');
    const row = await one(`SELECT version, config, published_at FROM site_config_version WHERE version = $1`, [n]);
    if (!row) throw NotFound(`Version ${n} was never published`);
    return { version: row.version, config: row.config, publishedAt: row.published_at };
  });
}
