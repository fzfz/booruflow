-- Issue #210：把 styles 迁移为按文生图底模归属的七字段目录对象。
-- app/database/style-schema-migration.mjs 在执行本文件前完成逐条数据清理，
-- 并负责 BEGIN IMMEDIATE、校验和最终 COMMIT；本文件只包含换表和 ledger 语句。

DROP TRIGGER IF EXISTS styles_id_immutable_before_update;
DROP TRIGGER IF EXISTS styles_cover_media_path_must_belong_before_update;
DROP TRIGGER IF EXISTS styles_delete_images_after_delete;
DROP TRIGGER IF EXISTS item_images_owner_exists_before_insert;

CREATE TABLE styles_next (
  id INTEGER PRIMARY KEY,
  base_model_id INTEGER NOT NULL REFERENCES generation_base_models(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'),
  prompt_text TEXT NOT NULL CHECK (length(trim(prompt_text)) > 0),
  style_description TEXT,
  cover_media_path TEXT
    CHECK (cover_media_path IS NULL OR (length(trim(cover_media_path)) > 0 AND cover_media_path NOT LIKE '/%' AND cover_media_path NOT LIKE '%..%' AND cover_media_path NOT LIKE '%\\%' ESCAPE '\')),
  UNIQUE (base_model_id, name)
);

INSERT INTO styles_next(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
SELECT styles.id,
  CASE styles.source_version
    WHEN 'ANIMA' THEN (SELECT id FROM generation_base_models WHERE name = 'anima')
    WHEN 'WAI' THEN (SELECT id FROM generation_base_models WHERE name = 'wai')
  END,
  styles.name,
  styles.aliases_json,
  styles.prompt_text,
  styles.style_description,
  styles.cover_media_path
FROM styles;

DROP TABLE styles;
ALTER TABLE styles_next RENAME TO styles;

CREATE INDEX styles_name_idx ON styles(name COLLATE BINARY);

CREATE TRIGGER item_images_owner_exists_before_insert
BEFORE INSERT ON item_images
BEGIN
  SELECT CASE
    WHEN NEW.owner_kind = 'work' AND NOT EXISTS (SELECT 1 FROM works WHERE id = NEW.owner_id) THEN RAISE(ABORT, 'item_images owner work does not exist')
    WHEN NEW.owner_kind = 'character' AND NOT EXISTS (SELECT 1 FROM characters WHERE id = NEW.owner_id) THEN RAISE(ABORT, 'item_images owner character does not exist')
    WHEN NEW.owner_kind = 'style' AND NOT EXISTS (SELECT 1 FROM styles WHERE id = NEW.owner_id) THEN RAISE(ABORT, 'item_images owner style does not exist')
    WHEN NEW.owner_kind = 'model' AND NOT EXISTS (SELECT 1 FROM generation_models WHERE id = NEW.owner_id) THEN RAISE(ABORT, 'item_images owner model does not exist')
    WHEN NEW.owner_kind = 'lora' AND NOT EXISTS (SELECT 1 FROM generation_loras WHERE id = NEW.owner_id) THEN RAISE(ABORT, 'item_images owner lora does not exist')
    WHEN NEW.owner_kind = 'artist_prompt_string' AND NOT EXISTS (SELECT 1 FROM artist_prompt_strings WHERE id = NEW.owner_id) THEN RAISE(ABORT, 'item_images owner artist prompt string does not exist')
    WHEN NEW.owner_kind = 'template' AND NOT EXISTS (SELECT 1 FROM comfyui_templates WHERE id = NEW.owner_id) THEN RAISE(ABORT, 'item_images owner template does not exist')
  END;
END;

CREATE TRIGGER styles_id_immutable_before_update
BEFORE UPDATE OF id ON styles
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'styles id is immutable');
END;

CREATE TRIGGER styles_cover_media_path_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON styles
WHEN NEW.cover_media_path IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'style cover media path must belong to style')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE media_path = NEW.cover_media_path AND owner_kind = 'style' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER styles_delete_images_after_delete
AFTER DELETE ON styles
BEGIN
  DELETE FROM item_images WHERE owner_kind = 'style' AND owner_id = OLD.id;
END;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (15, '015-style-base-model', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 15;
