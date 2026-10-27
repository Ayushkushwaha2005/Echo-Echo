/* ==========================================================================
   WEBSITE CUSTOMIZATION (routes/site.js, services/site-config.js)

   * Only the PUBLISHED configuration is public; a draft never is.
   * Saving, publishing and rolling back are permission-checked on the
     server, need an administrator session, and publish/rollback need a
     recent confirmation.
   * Invalid settings are refused with the field that is wrong.
   * Publishing is atomic: a failure leaves the previous version live.
   * Two administrators cannot silently overwrite each other's draft.
   * Every publish and rollback is in the audit log.
   Synthetic users, cafés and settings only.
   ========================================================================== */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDb, stopDb, truncateAll, makeUser, makeVendor, makeItem } from './helpers/db.mjs';
import { makeApp, sessionFor, client } from './helpers/api.mjs';

/* Production refuses platform roles to email-code sessions; use that rule. */
process.env.ADMIN_PASSKEY_REQUIRED = 'true';

let app, pool, defaults, validate, contrast, owner, editor, publisher, legacyAdmin, student, nth = 0;
const phone = () => `+9196400${String(10000 + nth++).slice(-5)}`;
const as = async (u, method = 'admin_totp') => client(app, await sessionFor(pool, u.id, { method }));
const withPermissions = (u, perms) => pool.query(
  `INSERT INTO admin_account (user_id, status, permissions, activated_at) VALUES ($1,'active',$2, now())
   ON CONFLICT (user_id) DO UPDATE SET permissions = $2`, [u.id, perms]);
const draftWith = (patch = {}) => {
  const c = defaults();
  c.hero.heading = 'Hot food, fast';
  return Object.assign(c, patch);
};
const save = async (who, config, revision) => who.put('/admin/site/draft', { config, revision });
async function saveAndPublish(who, config, note) {
  const cur = (await who.get('/admin/site')).body.draft.revision;
  const s = await save(who, config, cur);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return who.post('/admin/site/publish', { revision: s.body.revision, note });
}

before(async () => {
  process.env.PLATFORM_OWNER_EMAIL = 'owner.7@stu.upes.ac.in';
  await startDb();
  ({ pool } = await import('../src/db/index.js'));
  ({ defaults, validate, contrast } = await import('../src/services/site-config.js'));
  app = await makeApp();
});
after(async () => { await app?.close(); await pool?.end(); await stopDb(); });
beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE admin_account');
  owner = await makeUser(pool, { phone: phone(), name: 'Owner One', roles: ['platform_owner'] });
  editor = await makeUser(pool, { phone: phone(), name: 'Editor One', roles: ['platform_admin'] });
  publisher = await makeUser(pool, { phone: phone(), name: 'Publisher One', roles: ['platform_admin'] });
  legacyAdmin = await makeUser(pool, { phone: phone(), name: 'Legacy Admin', roles: ['platform_admin'] });
  student = await makeUser(pool, { phone: phone(), name: 'Student One' });
  await withPermissions(editor, ['website.customize']);
  await withPermissions(publisher, ['website.customize', 'website.publish']);
});

/* ---------- the public side ------------------------------------------------ */

test('before anything is published the public endpoint says so and carries no settings', async () => {
  const anon = client(app, null);
  const r = await anon.get('/site/config');
  assert.equal(r.status, 200);
  assert.deepEqual({ version: r.body.version, config: r.body.config }, { version: 0, config: null });
  assert.equal((await anon.get('/site/version')).body.version, 0);
});

test('a saved draft is never served publicly', async () => {
  const me = await as(publisher);
  assert.equal((await save(me, draftWith({ hero: { ...defaults().hero, heading: 'SECRET DRAFT' } }), 0)).status, 200);
  const pub = await client(app, null).get('/site/config');
  assert.equal(pub.body.version, 0);
  assert.ok(!JSON.stringify(pub.body).includes('SECRET DRAFT'));
  /* There is no public path to the draft at all. */
  assert.equal((await client(app, null).get('/admin/site')).status, 401);
});

test('the public view carries only website settings: no publisher, no draft, no ids of people', async () => {
  const me = await as(owner);
  assert.equal((await saveAndPublish(me, draftWith(), 'first')).status, 200);
  const r = await client(app, null).get('/site/config');
  assert.equal(r.body.version, 1);
  assert.deepEqual(Object.keys(r.body).sort(), ['config', 'featuredItems', 'publishedAt', 'version']);
  const text = JSON.stringify(r.body);
  for (const leak of [owner.id, 'Owner One', 'revision', 'published_by', 'note']) {
    assert.ok(!text.includes(leak), `public view must not contain ${leak}`);
  }
  assert.equal(r.body.config.hero.heading, 'Hot food, fast');
});

/* ---------- who may do what ------------------------------------------------ */

test('a student, an anonymous visitor and an admin without the permission are refused', async () => {
  const cfg = draftWith();
  const anon = client(app, null);
  assert.equal((await anon.put('/admin/site/draft', { config: cfg, revision: 0 })).status, 401);
  for (const u of [student, legacyAdmin]) {
    const c = await as(u, u === student ? 'code' : 'admin_totp');
    assert.equal((await c.get('/admin/site')).status, 403, u.name);
    assert.equal((await save(c, cfg, 0)).status, 403, u.name);
    assert.equal((await c.post('/admin/site/publish', { revision: 1 })).status, 403, u.name);
    assert.equal((await c.post('/admin/site/rollback', { version: 1 })).status, 403, u.name);
  }
});

test('the owner signed in with only an email code cannot touch the draft', async () => {
  const c = await as(owner, 'code');
  const r = await save(c, draftWith(), 0);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'admin_signin_required');
});

test('website.customize can save a draft but cannot publish or roll back', async () => {
  const c = await as(editor);
  const s = await save(c, draftWith(), 0);
  assert.equal(s.status, 200);
  const p = await c.post('/admin/site/publish', { revision: s.body.revision });
  assert.equal(p.status, 403);
  assert.equal((await client(app, null).get('/site/version')).body.version, 0);
  const view = (await c.get('/admin/site')).body;
  assert.deepEqual(view.can, { edit: true, publish: false });
});

test('a granted publisher can publish, and loses it the moment the grant is revoked', async () => {
  const c = await as(publisher);
  assert.equal((await saveAndPublish(c, draftWith(), 'by publisher')).status, 200);
  await withPermissions(publisher, ['website.customize']);
  /* Same open session: the permission is read per request. */
  const r = await saveAndPublish(c, draftWith({ seo: { ...defaults().seo, title: 'Changed' } }));
  assert.equal(r.status, 403);
  assert.equal((await client(app, null).get('/site/version')).body.version, 1);
});

test('publishing needs a recent confirmation', async () => {
  const token = await sessionFor(pool, publisher.id, { method: 'admin_totp' });
  await pool.query(`UPDATE session SET passkey_verified_at = now() - interval '2 hours' WHERE user_id = $1`, [publisher.id]);
  const c = client(app, token);
  const s = await save(c, draftWith(), 0);
  assert.equal(s.status, 200, 'saving a draft does not need it');
  const p = await c.post('/admin/site/publish', { revision: s.body.revision });
  assert.equal(p.status, 403);
  assert.equal(p.body.code, 'reauth_required');
});

test('new website permissions are not given to existing administrators implicitly', async () => {
  const { ROLE_DEFAULT_PERMISSIONS, GRANTABLE_KEYS } = await import('../src/auth/permissions.js');
  assert.ok(GRANTABLE_KEYS.includes('website.publish'), 'the owner can grant it');
  assert.ok(!ROLE_DEFAULT_PERMISSIONS.platform_admin.includes('website.customize'));
  assert.ok(!ROLE_DEFAULT_PERMISSIONS.platform_admin.includes('website.publish'));
  assert.ok(!ROLE_DEFAULT_PERMISSIONS.support.some((k) => k.startsWith('website.')));
});

/* ---------- validation ----------------------------------------------------- */

test('invalid settings are refused with the field that is wrong', async () => {
  const c = await as(owner);
  const cases = [
    [(x) => { x.theme.accent = 'red'; }, 'theme.accent'],
    [(x) => { x.theme.css = 'body{display:none}'; }, 'theme.css'],
    [(x) => { x.hero.primaryLink = 'javascript:alert(1)'; }, 'hero.primaryLink'],
    [(x) => { x.hero.primaryLink = 'http://example.com'; }, 'hero.primaryLink'],
    [(x) => { x.hero.primaryLink = '#/admin'; }, 'hero.primaryLink'],
    [(x) => { x.footer.links = [{ label: 'x', link: 'data:text/html,hi' }]; }, 'footer.links.0.link'],
    [(x) => { x.hero.heading = 'x'.repeat(91); }, 'hero.heading'],
    [(x) => { x.home.sections = x.home.sections.slice(1); }, 'home.sections'],
    [(x) => { x.featured.cafeIds = ['not-an-id']; }, 'featured.cafeIds'],
    [(x) => { x.theme.text = '#FAF7F3'; }, 'theme.text'],   // unreadable on the page
    [(x) => { x.announcement.enabled = true; x.announcement.text = ''; }, 'announcement.text'],
    [(x) => { x.banners = [{ id: 'a', title: 'A', body: '', imageAsset: null, link: '', linkLabel: '', active: true,
                             startsAt: '2026-11-02T00:00:00Z', endsAt: '2026-11-01T00:00:00Z' }]; }, 'banners.0.endsAt'],
    [(x) => { x.brand.logoAsset = '00000000-0000-4000-8000-000000000000'; }, 'images'],
  ];
  for (const [mutate, path] of cases) {
    const cfg = draftWith(); mutate(cfg);
    const r = await save(c, cfg, 0);
    assert.equal(r.status, 400, path);
    assert.equal(r.body.code, 'invalid_config');
    assert.ok(r.body.problems.some((p) => p.path === path), `${path}: ${JSON.stringify(r.body.problems)}`);
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site_config_draft`)).rows[0].n, 0, 'nothing was saved');
});

test('the validator keeps text as text and normalises colours', () => {
  const cfg = draftWith();
  cfg.hero.heading = '  <script>alert(1)</script>  ';
  cfg.theme.accent = '#c8425f';
  const v = validate(cfg);
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.config.hero.heading, '<script>alert(1)</script>', 'stored as text; the website escapes it');
  assert.equal(v.config.theme.accent, '#C8425F');
  assert.ok(contrast('#1A1416', '#FAF7F3') > 4.5);
});

test('the shipped defaults are valid and mean "no change"', () => {
  const v = validate(defaults());
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.ok(Object.values(v.config.theme).every((x) => x === null));
});

/* ---------- concurrency and atomicity -------------------------------------- */

test('two administrators editing the same revision: the second save is a conflict, not an overwrite', async () => {
  const a = await as(owner);
  const b = await as(publisher);
  const first = await save(a, draftWith(), 0);
  assert.equal(first.status, 200);
  const rev = first.body.revision;
  const mine = await save(a, draftWith({ seo: { ...defaults().seo, title: 'Owner title' } }), rev);
  assert.equal(mine.status, 200);
  const theirs = await save(b, draftWith({ seo: { ...defaults().seo, title: 'Publisher title' } }), rev);
  assert.equal(theirs.status, 409);
  assert.match(theirs.body.detail, /Owner One saved revision/);
  const draft = (await a.get('/admin/site')).body.draft;
  assert.equal(draft.config.seo.title, 'Owner title');
});

test('publishing a stale revision is refused and changes nothing', async () => {
  const c = await as(owner);
  const s = await save(c, draftWith(), 0);
  await save(c, draftWith({ seo: { ...defaults().seo, title: 'Newer' } }), s.body.revision);
  const p = await c.post('/admin/site/publish', { revision: s.body.revision });
  assert.equal(p.status, 409);
  assert.equal((await client(app, null).get('/site/version')).body.version, 0);
});

test('a publish that fails validation leaves the previous version live, with no partial version', async () => {
  const c = await as(owner);
  const V = await makeVendor(pool, { name: 'Featured Cafe', slug: 'featured-cafe' });
  assert.equal((await saveAndPublish(c, draftWith(), 'v1')).status, 200);
  const cfg = draftWith({ featured: { heading: 'Featured', cafeIds: [V.id], itemIds: [] } });
  cfg.hero.heading = 'Version two';
  const s = await save(c, cfg, (await c.get('/admin/site')).body.draft.revision);
  assert.equal(s.status, 200);
  /* The café is archived after the draft was saved. */
  await pool.query(`UPDATE vendor SET active = false WHERE id = $1`, [V.id]);
  const p = await c.post('/admin/site/publish', { revision: s.body.revision });
  assert.equal(p.status, 400);
  assert.ok(p.body.problems.some((x) => x.path === 'featured.cafeIds'));
  const pub = (await client(app, null).get('/site/config')).body;
  assert.equal(pub.version, 1);
  assert.equal(pub.config.hero.heading, 'Hot food, fast');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site_config_version`)).rows[0].n, 1);
});

/* ---------- publish, rollback, audit --------------------------------------- */

test('publish then roll back: the old settings come back as a new version, and both are audited', async () => {
  const c = await as(owner);
  assert.equal((await saveAndPublish(c, draftWith(), 'v1')).status, 200);
  const two = draftWith(); two.hero.heading = 'Second look';
  assert.equal((await saveAndPublish(c, two, 'v2')).status, 200);
  assert.equal((await client(app, null).get('/site/config')).body.config.hero.heading, 'Second look');

  const rb = await c.post('/admin/site/rollback', { version: 1 });
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.deepEqual(rb.body, { version: 3, restored: 1 });
  const pub = (await client(app, null).get('/site/config')).body;
  assert.equal(pub.version, 3);
  assert.equal(pub.config.hero.heading, 'Hot food, fast');

  const hist = (await c.get('/admin/site/versions')).body.versions;
  assert.deepEqual(hist.map((v) => [v.version, v.kind, v.live]), [[3, 'rollback', true], [2, 'publish', false], [1, 'publish', false]]);
  assert.equal(hist[0].rolledBackFrom, 1);
  assert.equal(hist[0].publishedBy, 'Owner One');

  const log = (await pool.query(
    `SELECT action, resource_id, actor_id FROM audit_log WHERE action IN ('site.publish','site.rollback') ORDER BY at`)).rows;
  assert.deepEqual(log.map((r) => [r.action, r.resource_id]), [['site.publish', '1'], ['site.publish', '2'], ['site.rollback', '3']]);
  assert.ok(log.every((r) => r.actor_id === owner.id));
  /* Rolling back to what is already live is refused. */
  assert.equal((await c.post('/admin/site/rollback', { version: 3 })).status, 409);
  assert.equal((await c.post('/admin/site/rollback', { version: 99 })).status, 404);
});

test('reset to last published replaces the draft with the live settings', async () => {
  const c = await as(owner);
  assert.equal((await saveAndPublish(c, draftWith(), 'v1')).status, 200);
  const changed = draftWith(); changed.hero.heading = 'Unpublished idea';
  const s = await save(c, changed, (await c.get('/admin/site')).body.draft.revision);
  const r = await c.post('/admin/site/draft/reset', { revision: s.body.revision });
  assert.equal(r.status, 200);
  assert.equal(r.body.config.hero.heading, 'Hot food, fast');
  assert.equal((await c.get('/admin/site')).body.draft.config.hero.heading, 'Hot food, fast');
});

test('banners follow their switch and schedule; featured dishes resolve to active menu rows only', async () => {
  const c = await as(owner);
  const V = await makeVendor(pool, { name: 'Dish Cafe', slug: 'dish-cafe' });
  const live = await makeItem(pool, V.id, { name: 'Masala Dosa', paise: 9000 });
  const gone = await makeItem(pool, V.id, { name: 'Old Dish', paise: 5000 });
  const day = 86400000;
  const b = (id, extra) => ({ id, title: id, body: '', imageAsset: null, link: '', linkLabel: '', active: true,
                              startsAt: null, endsAt: null, ...extra });
  const cfg = draftWith({
    featured: { heading: 'Try these', cafeIds: [V.id], itemIds: [gone.id, live.id] },
    banners: [b('now'), b('off', { active: false }),
              b('later', { startsAt: new Date(Date.now() + day).toISOString() }),
              b('ended', { endsAt: new Date(Date.now() - day).toISOString() })],
  });
  assert.equal((await saveAndPublish(c, cfg)).status, 200);
  await pool.query(`UPDATE menu_item SET active = false WHERE id = $1`, [gone.id]);
  const pub = (await client(app, null).get('/site/config')).body;
  assert.deepEqual(pub.config.banners.map((x) => x.id), ['now']);
  assert.deepEqual(pub.featuredItems.map((x) => x.name), ['Masala Dosa']);
  assert.equal(pub.featuredItems[0].pricePaise, 9000);
});

/* ---------- the browser's copy ---------------------------------------------- */

test('the website carries the same defaults as the server, so an unpublished site is unchanged', async () => {
  const web = await import('../../packages/data/site-config.js');
  assert.deepEqual(JSON.parse(JSON.stringify(web.DEFAULTS)), JSON.parse(JSON.stringify(defaults())));
  const { HOME_SECTIONS } = await import('../src/services/site-config.js');
  assert.deepEqual(web.SECTIONS, HOME_SECTIONS);
});

test('a theme becomes custom properties on :root and nothing else, whatever it is given', async () => {
  const { themeCss, effective } = await import('../../packages/data/site-config.js');
  assert.equal(themeCss(defaults().theme), '', 'the shipped theme adds no CSS');
  const css = themeCss({ accent: '#2F6F8F', background: '#FFFFFF', buttonRadius: 6, font: 'Inter', density: 'compact' });
  assert.match(css, /^:root\{[^{}]*\}$/);
  assert.match(css, /--accent:#2F6F8F/);
  assert.match(css, /--r-btn:6px/);
  assert.match(css, /--font-ui:"Inter"/);
  /* Anything that is not a validated token value is ignored, never echoed. */
  const hostile = themeCss({ accent: 'red;}body{display:none', background: 'url(javascript:x)', buttonRadius: '6px;}',
                             font: 'Comic Sans"}', density: 'tiny' });
  assert.equal(hostile, '');
  /* An older stored version missing a section keeps every section. */
  const e = effective({ home: { title: 'x', sections: [{ key: 'cafes', visible: false }] } });
  assert.equal(e.home.sections.length, 7);
  assert.equal(e.home.sections[0].key, 'cafes');
});

test('the admin order list names the partner only to someone who may see partners', async () => {
  const V = await makeVendor(pool, { name: 'Ops Cafe', slug: 'ops-cafe' });
  const cust = await makeUser(pool, { phone: phone(), name: 'Ops Customer' });
  const rider = await makeUser(pool, { phone: phone(), name: 'Rider Name', roles: ['student', 'delivery_partner'] });
  await pool.query(
    `INSERT INTO food_order (code, customer_id, vendor_id, fulfilment, state, subtotal_paise, total_paise, partner_id,
                             destination_snapshot, delivery_contact_phone, destination_kind, spot_lat, spot_lng)
     VALUES ('OPS1',$1,$2,'delivery','picked_up',9000,10000,$3,'{"name":"Block 4"}','+919999900002','manual_map_spot',30.417,77.968)`,
    [cust.id, V.id, rider.id]);
  const ordersOnly = await makeUser(pool, { phone: phone(), name: 'Orders Only', roles: ['platform_admin'] });
  await withPermissions(ordersOnly, ['orders.view']);
  const a = (await (await as(ordersOnly)).get('/admin/orders?state=picked_up')).body.orders[0];
  assert.equal(a.has_partner, true);
  assert.equal(a.partner_name, null, 'no partners.view: not named');
  const b = (await (await as(owner)).get('/admin/orders?state=picked_up')).body.orders[0];
  assert.equal(b.partner_name, 'Rider Name');
});
