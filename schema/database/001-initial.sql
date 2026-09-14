-- 角色与画风提示词聊天站：首版 SQLite 结构
-- 所有时间字段均保存 UTC RFC3339 文本，例如 2026-07-26T12:34:56Z。
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA trusted_schema = OFF;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL CHECK (applied_at GLOB '????-??-??T??:??:??*Z')
);

CREATE TABLE works (
  id INTEGER PRIMARY KEY,
  source_id TEXT,
  source_url TEXT,
  source_version TEXT,
  source_updated_at TEXT CHECK (source_updated_at IS NULL OR source_updated_at GLOB '????-??-??T??:??:??*Z'),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  name_normalized TEXT NOT NULL CHECK (length(trim(name_normalized)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
  category_name TEXT,
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);

CREATE UNIQUE INDEX works_source_id_uq ON works(source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX works_name_normalized_without_source_uq
  ON works(name_normalized) WHERE source_id IS NULL;
CREATE INDEX works_name_normalized_idx ON works(name_normalized);

CREATE TABLE characters (
  id INTEGER PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  source_id TEXT,
  source_url TEXT,
  source_version TEXT,
  source_updated_at TEXT CHECK (source_updated_at IS NULL OR source_updated_at GLOB '????-??-??T??:??:??*Z'),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  name_normalized TEXT NOT NULL CHECK (length(trim(name_normalized)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
  prompt_text TEXT NOT NULL CHECK (length(trim(prompt_text)) > 0),
  cover_image_id INTEGER,
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);

CREATE UNIQUE INDEX characters_source_id_uq ON characters(source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX characters_work_name_normalized_without_source_uq
  ON characters(work_id, name_normalized) WHERE source_id IS NULL;
CREATE INDEX characters_work_id_idx ON characters(work_id);
CREATE INDEX characters_name_normalized_idx ON characters(name_normalized);

CREATE TABLE styles (
  id INTEGER PRIMARY KEY,
  source_id TEXT,
  source_url TEXT,
  source_version TEXT,
  source_updated_at TEXT CHECK (source_updated_at IS NULL OR source_updated_at GLOB '????-??-??T??:??:??*Z'),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  name_normalized TEXT NOT NULL CHECK (length(trim(name_normalized)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
  category_name TEXT,
  prompt_text TEXT NOT NULL CHECK (length(trim(prompt_text)) > 0),
  cover_image_id INTEGER,
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);

CREATE UNIQUE INDEX styles_source_id_uq ON styles(source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX styles_name_normalized_without_source_uq
  ON styles(name_normalized) WHERE source_id IS NULL;
CREATE INDEX styles_name_normalized_idx ON styles(name_normalized);

CREATE TABLE item_images (
  id INTEGER PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('character', 'style')),
  owner_id INTEGER NOT NULL,
  source_id TEXT,
  source_url TEXT,
  content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) > 0),
  local_path TEXT NOT NULL CHECK (length(trim(local_path)) > 0),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);

CREATE UNIQUE INDEX item_images_owner_sort_order_uq ON item_images(owner_kind, owner_id, sort_order);
CREATE UNIQUE INDEX item_images_local_path_uq ON item_images(local_path);
CREATE UNIQUE INDEX item_images_owner_source_url_uq
  ON item_images(owner_kind, owner_id, source_url) WHERE source_url IS NOT NULL;
CREATE INDEX item_images_content_hash_idx ON item_images(content_hash);
CREATE INDEX item_images_owner_idx ON item_images(owner_kind, owner_id);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '新会话' CHECK (length(trim(title)) > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted')),
  max_rounds INTEGER NOT NULL DEFAULT 3 CHECK (max_rounds = 3),
  rounds_used INTEGER NOT NULL DEFAULT 0 CHECK (rounds_used BETWEEN 0 AND max_rounds),
  pi_instance_id TEXT NOT NULL CHECK (length(trim(pi_instance_id)) > 0),
  pi_session_id TEXT NOT NULL CHECK (length(trim(pi_session_id)) > 0),
  pi_session_file TEXT NOT NULL UNIQUE CHECK (length(trim(pi_session_file)) > 0),
  committed_leaf_id TEXT CHECK (committed_leaf_id IS NULL OR length(trim(committed_leaf_id)) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  CHECK ((status = 'active' AND rounds_used < max_rounds) OR (status = 'exhausted' AND rounds_used = max_rounds))
);

CREATE INDEX sessions_updated_at_idx ON sessions(updated_at DESC);
CREATE INDEX sessions_pi_session_id_idx ON sessions(pi_session_id);

CREATE TABLE pi_session_orphans (
  id INTEGER PRIMARY KEY,
  pi_instance_id TEXT,
  pi_session_id TEXT,
  pi_session_file TEXT,
  pi_leaf_id TEXT,
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'cleanup_pending')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  last_attempt_at TEXT CHECK (last_attempt_at IS NULL OR last_attempt_at GLOB '????-??-??T??:??:??*Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z')
);

CREATE INDEX pi_session_orphans_status_created_idx
  ON pi_session_orphans(status, created_at);

CREATE TABLE session_work_selections (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 29),
  PRIMARY KEY (session_id, work_id),
  UNIQUE (session_id, position)
);

CREATE TABLE session_character_selections (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 29),
  PRIMARY KEY (session_id, character_id),
  UNIQUE (session_id, position)
);

CREATE TABLE session_style_selections (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 29),
  PRIMARY KEY (session_id, style_id),
  UNIQUE (session_id, position)
);

CREATE INDEX session_character_selections_character_session_idx
  ON session_character_selections(character_id, session_id);
CREATE INDEX session_style_selections_style_session_idx
  ON session_style_selections(style_id, session_id);
CREATE INDEX session_work_selections_work_session_idx
  ON session_work_selections(work_id, session_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  target_type TEXT NOT NULL CHECK (length(trim(target_type)) > 0),
  target_id INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '????-??-??T??:??:??*Z')
);

CREATE INDEX audit_events_target_idx ON audit_events(target_type, target_id, occurred_at DESC);

CREATE TRIGGER item_images_owner_exists_before_insert
BEFORE INSERT ON item_images
BEGIN
  SELECT CASE
    WHEN NEW.owner_kind = 'character' AND NOT EXISTS (SELECT 1 FROM characters WHERE id = NEW.owner_id)
      THEN RAISE(ABORT, 'item_images owner character does not exist')
    WHEN NEW.owner_kind = 'style' AND NOT EXISTS (SELECT 1 FROM styles WHERE id = NEW.owner_id)
      THEN RAISE(ABORT, 'item_images owner style does not exist')
  END;
END;

CREATE TRIGGER item_images_owner_immutable_before_update
BEFORE UPDATE OF owner_kind, owner_id ON item_images
BEGIN
  SELECT RAISE(ABORT, 'item_images owner is immutable');
END;

CREATE TRIGGER item_images_id_immutable_before_update
BEFORE UPDATE OF id ON item_images
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'item_images id is immutable');
END;

CREATE TRIGGER works_id_immutable_before_update
BEFORE UPDATE OF id ON works
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'works id is immutable');
END;

CREATE TRIGGER characters_id_immutable_before_update
BEFORE UPDATE OF id ON characters
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'characters id is immutable');
END;

CREATE TRIGGER styles_id_immutable_before_update
BEFORE UPDATE OF id ON styles
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'styles id is immutable');
END;

CREATE TRIGGER item_images_cannot_delete_cover_before_delete
BEFORE DELETE ON item_images
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM characters WHERE cover_image_id = OLD.id)
      THEN RAISE(ABORT, 'clear or replace character cover before deleting image')
    WHEN EXISTS (SELECT 1 FROM styles WHERE cover_image_id = OLD.id)
      THEN RAISE(ABORT, 'clear or replace style cover before deleting image')
  END;
END;

CREATE TRIGGER characters_cover_must_belong_before_insert
BEFORE INSERT ON characters
WHEN NEW.cover_image_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'character cover image must belong to character')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE id = NEW.cover_image_id AND owner_kind = 'character' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER characters_cover_must_belong_before_update
BEFORE UPDATE OF cover_image_id ON characters
WHEN NEW.cover_image_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'character cover image must belong to character')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE id = NEW.cover_image_id AND owner_kind = 'character' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER styles_cover_must_belong_before_insert
BEFORE INSERT ON styles
WHEN NEW.cover_image_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'style cover image must belong to style')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE id = NEW.cover_image_id AND owner_kind = 'style' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER styles_cover_must_belong_before_update
BEFORE UPDATE OF cover_image_id ON styles
WHEN NEW.cover_image_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'style cover image must belong to style')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE id = NEW.cover_image_id AND owner_kind = 'style' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER characters_delete_images_after_delete
AFTER DELETE ON characters
BEGIN
  DELETE FROM item_images WHERE owner_kind = 'character' AND owner_id = OLD.id;
END;

CREATE TRIGGER styles_delete_images_after_delete
AFTER DELETE ON styles
BEGIN
  DELETE FROM item_images WHERE owner_kind = 'style' AND owner_id = OLD.id;
END;

INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
VALUES (1, '001-initial', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

PRAGMA user_version = 1;
