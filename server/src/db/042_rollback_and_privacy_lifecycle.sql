-- ===========================================================================
-- ECHO ECHO - migration 042: restoring a menu edit, approval of a website
-- publish, and the full life of a deletion request. Additive.
--
-- catalog_version only stored the state AFTER an edit, so the state before the
-- first edit could never be restored. The first edit now also records where it
-- started from. Records edited before this migration keep what they have.
-- ===========================================================================
CREATE OR REPLACE FUNCTION bump_catalog_revision() RETURNS trigger AS $$
DECLARE
  fields text[] := TG_ARGV;
  before jsonb := '{}';
  after  jsonb := '{}';
  f text;
  who uuid;
  kind text := CASE TG_TABLE_NAME WHEN 'vendor' THEN 'vendor' ELSE 'menu_item' END;
BEGIN
  FOREACH f IN ARRAY fields LOOP
    before := before || jsonb_build_object(f, to_jsonb(OLD)->f);
    after  := after  || jsonb_build_object(f, to_jsonb(NEW)->f);
  END LOOP;
  IF before IS NOT DISTINCT FROM after THEN RETURN NEW; END IF;
  NEW.revision := OLD.revision + 1;
  BEGIN who := nullif(current_setting('app.actor_id', true), '')::uuid; EXCEPTION WHEN others THEN who := NULL; END;
  IF NOT EXISTS (SELECT 1 FROM catalog_version WHERE entity = kind AND entity_id = NEW.id) THEN
    INSERT INTO catalog_version (entity, entity_id, revision, snapshot, actor_id)
    VALUES (kind, NEW.id, OLD.revision, before, NULL);
  END IF;
  INSERT INTO catalog_version (entity, entity_id, revision, snapshot, actor_id)
  VALUES (kind, NEW.id, NEW.revision, after, who);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

INSERT INTO approval_policy (action_type, enabled) VALUES ('site.publish', false)
  ON CONFLICT (action_type) DO NOTHING;

ALTER TABLE data_request DROP CONSTRAINT data_request_status_check;
ALTER TABLE data_request ADD CONSTRAINT data_request_status_check
  CHECK (status IN ('open','in_review','completed','declined','cancelled'));
ALTER TABLE data_request ADD COLUMN review_started_at timestamptz;
ALTER TABLE data_request ADD COLUMN reviewed_by uuid REFERENCES app_user(id);
DROP INDEX data_request_one_open;
CREATE UNIQUE INDEX data_request_one_open ON data_request (user_id, kind) WHERE status IN ('open','in_review');
