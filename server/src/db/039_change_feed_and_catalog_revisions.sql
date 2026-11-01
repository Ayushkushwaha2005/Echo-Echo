-- ===========================================================================
-- ECHO ECHO - migration 039: the change feed and catalogue revisions
--
-- change_event is one append-only feed: "area X changed, and here is a number
-- that only goes up". It holds no record contents. Triggers write it, so it is
-- in the same transaction as the change by construction and no route can forget
-- it. Triggers cover only catalogue, partner and website tables; orders keep
-- reading order_event, so nothing here can affect a payment transaction.
-- ===========================================================================
CREATE TABLE change_event (
  id        bigserial PRIMARY KEY,
  area      text NOT NULL,
  record_id text,
  actor_id  uuid,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_event_area ON change_event (area, id DESC);

CREATE FUNCTION change_event_append_only() RETURNS trigger AS $$
BEGIN
  -- Pruning old rows is the sweeper's job; rewriting history is nobody's.
  IF TG_OP = 'DELETE' AND OLD.at < now() - interval '1 day' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'change_event is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER change_event_append_only BEFORE UPDATE OR DELETE ON change_event
  FOR EACH ROW EXECUTE FUNCTION change_event_append_only();

CREATE FUNCTION log_change() RETURNS trigger AS $$
DECLARE
  rid text;
  who uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN rid := to_jsonb(OLD)->>TG_ARGV[1]; ELSE rid := to_jsonb(NEW)->>TG_ARGV[1]; END IF;
  BEGIN who := nullif(current_setting('app.actor_id', true), '')::uuid; EXCEPTION WHEN others THEN who := NULL; END;
  INSERT INTO change_event (area, record_id, actor_id) VALUES (TG_ARGV[0], rid, who);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER vendor_change AFTER INSERT OR UPDATE OR DELETE ON vendor
  FOR EACH ROW EXECUTE FUNCTION log_change('cafes', 'id');
CREATE TRIGGER menu_item_change AFTER INSERT OR UPDATE OR DELETE ON menu_item
  FOR EACH ROW EXECUTE FUNCTION log_change('menu', 'id');
CREATE TRIGGER category_change AFTER INSERT OR UPDATE OR DELETE ON category
  FOR EACH ROW EXECUTE FUNCTION log_change('menu', 'id');
CREATE TRIGGER partner_profile_change AFTER INSERT OR UPDATE OR DELETE ON partner_profile
  FOR EACH ROW EXECUTE FUNCTION log_change('partners', 'user_id');
CREATE TRIGGER partner_consent_change AFTER INSERT OR UPDATE ON partner_policy_consent
  FOR EACH ROW EXECUTE FUNCTION log_change('partners', 'user_id');
CREATE TRIGGER support_case_change AFTER INSERT OR UPDATE ON support_case
  FOR EACH ROW EXECUTE FUNCTION log_change('support', 'id');
CREATE TRIGGER support_message_change AFTER INSERT ON support_message
  FOR EACH ROW EXECUTE FUNCTION log_change('support', 'case_id');
CREATE TRIGGER review_change AFTER INSERT OR UPDATE OR DELETE ON review
  FOR EACH ROW EXECUTE FUNCTION log_change('reviews', 'id');
CREATE TRIGGER delivery_incident_change AFTER INSERT OR UPDATE ON delivery_incident
  FOR EACH ROW EXECUTE FUNCTION log_change('incidents', 'id');
CREATE TRIGGER campus_node_change AFTER INSERT OR UPDATE OR DELETE ON campus_node
  FOR EACH ROW EXECUTE FUNCTION log_change('locations', 'id');

-- Catalogue revisions. A form sends back the revision it loaded; a stale form
-- gets a 409 instead of overwriting newer work. Opening, closing and sold-out
-- are operational and instant: they do not move the revision, so flipping one
-- cannot invalidate somebody's open form.
ALTER TABLE vendor ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE menu_item ADD COLUMN revision integer NOT NULL DEFAULT 1;

-- Only the fields an editor changes. No payment or settlement column is copied.
CREATE TABLE catalog_version (
  id         bigserial PRIMARY KEY,
  entity     text NOT NULL CHECK (entity IN ('vendor','menu_item')),
  entity_id  uuid NOT NULL,
  revision   integer NOT NULL,
  snapshot   jsonb NOT NULL,
  actor_id   uuid,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalog_version_entity ON catalog_version (entity, entity_id, revision DESC);

CREATE FUNCTION catalog_version_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'catalog_version is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER catalog_version_append_only BEFORE UPDATE ON catalog_version
  FOR EACH ROW EXECUTE FUNCTION catalog_version_append_only();

CREATE FUNCTION bump_catalog_revision() RETURNS trigger AS $$
DECLARE
  fields text[] := TG_ARGV;
  before jsonb := '{}';
  after  jsonb := '{}';
  f text;
  who uuid;
BEGIN
  FOREACH f IN ARRAY fields LOOP
    before := before || jsonb_build_object(f, to_jsonb(OLD)->f);
    after  := after  || jsonb_build_object(f, to_jsonb(NEW)->f);
  END LOOP;
  IF before IS NOT DISTINCT FROM after THEN RETURN NEW; END IF;
  NEW.revision := OLD.revision + 1;
  BEGIN who := nullif(current_setting('app.actor_id', true), '')::uuid; EXCEPTION WHEN others THEN who := NULL; END;
  INSERT INTO catalog_version (entity, entity_id, revision, snapshot, actor_id)
  VALUES (CASE TG_TABLE_NAME WHEN 'vendor' THEN 'vendor' ELSE 'menu_item' END, NEW.id, NEW.revision, after, who);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER vendor_revision BEFORE UPDATE ON vendor FOR EACH ROW
  EXECUTE FUNCTION bump_catalog_revision('name','kind','description','campus_node_id','opens_at','closes_at',
    'prep_minutes','delivery_enabled','staff_can_deliver','contact_phone','contact_public','photo_asset','active','campus_site_id');
CREATE TRIGGER menu_item_revision BEFORE UPDATE ON menu_item FOR EACH ROW
  EXECUTE FUNCTION bump_catalog_revision('name','description','price_paise','veg','prep_minutes','tags','aliases',
    'category_id','photo_asset','active');
