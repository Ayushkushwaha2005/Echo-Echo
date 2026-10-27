-- ============================================================================
-- ECHO ECHO - migration 033: website customization (draft, versions, live)
--
-- The public website's ordinary content and appearance - the hero, the
-- announcement bar, the home sections and their order, featured cafés and
-- dishes, banners, the footer, the page title, theme colours, logo and
-- favicon - become data an authorised administrator edits in Campus Control
-- instead of source code.
--
-- Three tables, each with one job:
--
--   site_config_version  every configuration that was ever PUBLISHED, in
--                        order. A row is never edited after insert, so the
--                        history is the history. Rolling back publishes a
--                        copy of an old version as a new version.
--   site_config_live     one row: which version visitors get. Publishing
--                        inserts a version and moves this pointer in ONE
--                        transaction, so the site is never half-updated.
--   site_config_draft    one row: the shared working copy. `revision` goes
--                        up on every save; a save that names an older
--                        revision is refused instead of overwriting a
--                        colleague's work.
--
-- Additive only. Until somebody publishes, there is no live row and the
-- website renders exactly what it rendered before this migration.
-- ============================================================================

CREATE TABLE site_config_version (
  version       int PRIMARY KEY CHECK (version > 0),
  config        jsonb NOT NULL,
  schema        int NOT NULL DEFAULT 1,
  note          text CHECK (length(note) <= 200),
  -- 'publish' for a draft that was published, 'rollback' for a copy of an
  -- earlier version; rolled_back_from names that version.
  kind          text NOT NULL DEFAULT 'publish' CHECK (kind IN ('publish', 'rollback')),
  rolled_back_from int REFERENCES site_config_version(version),
  published_by  uuid REFERENCES app_user(id),
  published_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_config_live (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  version    int NOT NULL REFERENCES site_config_version(version),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_config_draft (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  config       jsonb NOT NULL,
  revision     int NOT NULL DEFAULT 1 CHECK (revision > 0),
  -- The published version this draft started from, to say "changed since".
  base_version int REFERENCES site_config_version(version),
  updated_by   uuid REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Logo, favicon, hero and banner images. Public once referenced, like food
-- photos; uploading one needs the website.customize permission.
ALTER TABLE asset DROP CONSTRAINT asset_kind_check;
ALTER TABLE asset ADD CONSTRAINT asset_kind_check
  CHECK (kind IN ('id_front','id_back','food_photo','vendor_photo','partner_photo','site_image'));
