-- v0.2 文生图资源与 ComfyUI 管理结构。
-- 本迁移在根目录 schema/database/001 至 007 已完成后执行。
BEGIN IMMEDIATE;

CREATE TABLE generation_base_models (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);

CREATE TABLE artist_prompt_strings (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL UNIQUE CHECK (length(trim(title)) > 0 AND length(title) <= 20),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  artist_string TEXT NOT NULL CHECK (length(trim(artist_string)) > 0),
  base_model_id INTEGER REFERENCES generation_base_models(id) ON DELETE SET NULL,
  cover_media_path TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);
CREATE INDEX artist_prompt_strings_base_model_id_idx
  ON artist_prompt_strings(base_model_id);

CREATE TABLE artist_prompt_string_styles (
  artist_prompt_string_id INTEGER NOT NULL REFERENCES artist_prompt_strings(id) ON DELETE CASCADE,
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  PRIMARY KEY (artist_prompt_string_id, style_id)
);
CREATE INDEX artist_prompt_string_styles_style_id_idx
  ON artist_prompt_string_styles(style_id);

CREATE TABLE generation_models (
  id INTEGER PRIMARY KEY,
  base_model_id INTEGER NOT NULL REFERENCES generation_base_models(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
  file_format TEXT NOT NULL CHECK (file_format IN ('safetensors', 'ckpt', 'pt', 'pth', 'bin', 'gguf', 'onnx', 'dduf', 'diffusers', 'other')),
  precision_or_quantization TEXT NOT NULL CHECK (precision_or_quantization IN ('none', 'fp16', 'bf16', 'fp8', 'int8', 'int4', 'nf4', 'other')),
  author TEXT,
  version TEXT,
  release_url TEXT CHECK (release_url IS NULL OR release_url GLOB 'http://*' OR release_url GLOB 'https://*'),
  published_at TEXT CHECK (published_at IS NULL OR published_at GLOB '????-??-??'),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  usage TEXT NOT NULL CHECK (length(trim(usage)) > 0),
  skill_name TEXT,
  cover_media_path TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);
CREATE UNIQUE INDEX generation_models_identity_uq
  ON generation_models(base_model_id, file_name, file_format, precision_or_quantization, COALESCE(version, ''));
CREATE INDEX generation_models_base_model_id_idx ON generation_models(base_model_id);

CREATE TABLE generation_loras (
  id INTEGER PRIMARY KEY,
  base_model_id INTEGER NOT NULL REFERENCES generation_base_models(id) ON DELETE CASCADE,
  model_id INTEGER NOT NULL REFERENCES generation_models(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
  file_format TEXT NOT NULL CHECK (file_format IN ('safetensors', 'ckpt', 'pt', 'pth', 'bin', 'gguf', 'onnx', 'dduf', 'diffusers', 'other')),
  precision_or_quantization TEXT NOT NULL CHECK (precision_or_quantization IN ('none', 'fp16', 'bf16', 'fp8', 'int8', 'int4', 'nf4', 'other')),
  author TEXT,
  version TEXT,
  release_url TEXT CHECK (release_url IS NULL OR release_url GLOB 'http://*' OR release_url GLOB 'https://*'),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  usage TEXT NOT NULL CHECK (length(trim(usage)) > 0),
  cover_media_path TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);
CREATE UNIQUE INDEX generation_loras_identity_uq
  ON generation_loras(base_model_id, model_id, file_name, file_format, precision_or_quantization, COALESCE(version, ''));
CREATE INDEX generation_loras_base_model_id_idx ON generation_loras(base_model_id);
CREATE INDEX generation_loras_model_id_idx ON generation_loras(model_id);

CREATE TABLE comfyui_instances (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  url TEXT NOT NULL UNIQUE CHECK (url GLOB 'http://*' OR url GLOB 'https://*'),
  credential_type TEXT NOT NULL DEFAULT 'none' CHECK (credential_type IN ('none', 'http_basic', 'bearer')),
  credential_ciphertext TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  is_valid INTEGER NOT NULL DEFAULT 0 CHECK (is_valid IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  CHECK ((credential_type = 'none' AND credential_ciphertext IS NULL) OR (credential_type IN ('http_basic', 'bearer') AND length(trim(credential_ciphertext)) > 0)),
  CHECK (is_enabled = 0 OR is_valid = 1)
);
CREATE INDEX comfyui_instances_valid_enabled_idx ON comfyui_instances(is_valid, is_enabled);

CREATE TABLE comfyui_templates (
  id INTEGER PRIMARY KEY,
  base_model_id INTEGER NOT NULL REFERENCES generation_base_models(id) ON DELETE CASCADE,
  model_id INTEGER NOT NULL REFERENCES generation_models(id) ON DELETE CASCADE,
  lora_id INTEGER REFERENCES generation_loras(id) ON DELETE CASCADE,
  template_type TEXT NOT NULL CHECK (template_type IN ('text_to_image', 'text_to_image_lora', 'text_to_image_hires_fix', 'text_to_image_second_pass', 'text_to_video', 'image_to_image', 'image_to_video', 'video_to_video', 'style_transfer', 'controlnet', 'inpainting', 'outpainting', 'upscale', 'face_detailer', 'other')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  template_json TEXT NOT NULL CHECK (json_valid(template_json) AND json_type(template_json) = 'object'),
  cover_media_path TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);
CREATE INDEX comfyui_templates_base_model_id_idx ON comfyui_templates(base_model_id);
CREATE INDEX comfyui_templates_model_id_idx ON comfyui_templates(model_id);
CREATE INDEX comfyui_templates_lora_id_idx ON comfyui_templates(lora_id);

CREATE TRIGGER generation_loras_model_base_model_before_insert
BEFORE INSERT ON generation_loras
WHEN NOT EXISTS (SELECT 1 FROM generation_models WHERE id = NEW.model_id AND base_model_id = NEW.base_model_id)
BEGIN SELECT RAISE(ABORT, 'generation_lora model must belong to base model'); END;
CREATE TRIGGER generation_loras_model_base_model_before_update
BEFORE UPDATE OF base_model_id, model_id ON generation_loras
WHEN NOT EXISTS (SELECT 1 FROM generation_models WHERE id = NEW.model_id AND base_model_id = NEW.base_model_id)
BEGIN SELECT RAISE(ABORT, 'generation_lora model must belong to base model'); END;

CREATE TRIGGER comfyui_templates_ecosystem_before_insert
BEFORE INSERT ON comfyui_templates
WHEN NOT EXISTS (SELECT 1 FROM generation_models WHERE id = NEW.model_id AND base_model_id = NEW.base_model_id)
  OR (NEW.lora_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM generation_loras WHERE id = NEW.lora_id AND base_model_id = NEW.base_model_id AND model_id = NEW.model_id))
BEGIN SELECT RAISE(ABORT, 'comfyui template references must belong to one model ecosystem'); END;
CREATE TRIGGER comfyui_templates_ecosystem_before_update
BEFORE UPDATE OF base_model_id, model_id, lora_id ON comfyui_templates
WHEN NOT EXISTS (SELECT 1 FROM generation_models WHERE id = NEW.model_id AND base_model_id = NEW.base_model_id)
  OR (NEW.lora_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM generation_loras WHERE id = NEW.lora_id AND base_model_id = NEW.base_model_id AND model_id = NEW.model_id))
BEGIN SELECT RAISE(ABORT, 'comfyui template references must belong to one model ecosystem'); END;

CREATE TRIGGER comfyui_instances_connection_change_before_update
BEFORE UPDATE OF url, credential_type, credential_ciphertext ON comfyui_instances
WHEN NEW.is_valid <> 0 OR NEW.is_enabled <> 0
BEGIN SELECT RAISE(ABORT, 'changed comfyui connection must be invalid and disabled'); END;

DROP TRIGGER IF EXISTS item_images_owner_exists_before_insert;
DROP TRIGGER IF EXISTS item_images_owner_immutable_before_update;
DROP TRIGGER IF EXISTS item_images_id_immutable_before_update;
DROP TRIGGER IF EXISTS item_images_media_path_immutable_before_update;
DROP TRIGGER IF EXISTS works_cover_media_path_must_belong_before_update;
DROP TRIGGER IF EXISTS characters_cover_media_path_must_belong_before_update;
DROP TRIGGER IF EXISTS styles_cover_media_path_must_belong_before_update;
DROP TRIGGER IF EXISTS works_delete_images_after_delete;
DROP TRIGGER IF EXISTS characters_delete_images_after_delete;
DROP TRIGGER IF EXISTS styles_delete_images_after_delete;

CREATE TABLE item_images_next (
  id INTEGER PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('work', 'character', 'style', 'model', 'lora', 'artist_prompt_string', 'template')),
  owner_id INTEGER NOT NULL,
  source_id TEXT,
  source_url TEXT,
  content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) > 0),
  media_path TEXT NOT NULL UNIQUE CHECK (length(trim(media_path)) > 0 AND media_path NOT LIKE '/%' AND media_path NOT LIKE '%..%' AND media_path NOT LIKE '%\\%' ESCAPE '\'),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(owner_kind, owner_id, sort_order)
);
INSERT INTO item_images_next(id, owner_kind, owner_id, source_id, source_url, content_hash, media_path, sort_order, created_at, updated_at)
SELECT id, owner_kind, owner_id, source_id, source_url, content_hash, media_path, sort_order, created_at, updated_at FROM item_images;
DROP TABLE item_images;
ALTER TABLE item_images_next RENAME TO item_images;

CREATE UNIQUE INDEX item_images_owner_source_url_uq ON item_images(owner_kind, owner_id, source_url) WHERE source_url IS NOT NULL;
CREATE INDEX item_images_content_hash_idx ON item_images(content_hash);
CREATE INDEX item_images_owner_idx ON item_images(owner_kind, owner_id);
CREATE UNIQUE INDEX item_images_template_single_cover_uq ON item_images(owner_kind, owner_id) WHERE owner_kind = 'template';

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
CREATE TRIGGER item_images_owner_immutable_before_update BEFORE UPDATE OF owner_kind, owner_id ON item_images
BEGIN SELECT RAISE(ABORT, 'item_images owner is immutable'); END;
CREATE TRIGGER item_images_id_immutable_before_update BEFORE UPDATE OF id ON item_images WHEN NEW.id <> OLD.id
BEGIN SELECT RAISE(ABORT, 'item_images id is immutable'); END;
CREATE TRIGGER item_images_media_path_immutable_before_update BEFORE UPDATE OF media_path ON item_images WHEN NEW.media_path IS NOT OLD.media_path
BEGIN SELECT RAISE(ABORT, 'item_images media_path is immutable'); END;

CREATE TRIGGER generation_models_delete_images_after_delete AFTER DELETE ON generation_models
BEGIN DELETE FROM item_images WHERE owner_kind = 'model' AND owner_id = OLD.id; END;
CREATE TRIGGER generation_loras_delete_images_after_delete AFTER DELETE ON generation_loras
BEGIN DELETE FROM item_images WHERE owner_kind = 'lora' AND owner_id = OLD.id; END;
CREATE TRIGGER artist_prompt_strings_delete_images_after_delete AFTER DELETE ON artist_prompt_strings
BEGIN DELETE FROM item_images WHERE owner_kind = 'artist_prompt_string' AND owner_id = OLD.id; END;
CREATE TRIGGER comfyui_templates_delete_images_after_delete AFTER DELETE ON comfyui_templates
BEGIN DELETE FROM item_images WHERE owner_kind = 'template' AND owner_id = OLD.id; END;
CREATE TRIGGER works_delete_images_after_delete AFTER DELETE ON works
BEGIN DELETE FROM item_images WHERE owner_kind = 'work' AND owner_id = OLD.id; END;
CREATE TRIGGER characters_delete_images_after_delete AFTER DELETE ON characters
BEGIN DELETE FROM item_images WHERE owner_kind = 'character' AND owner_id = OLD.id; END;
CREATE TRIGGER styles_delete_images_after_delete AFTER DELETE ON styles
BEGIN DELETE FROM item_images WHERE owner_kind = 'style' AND owner_id = OLD.id; END;

CREATE TRIGGER generation_models_cover_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON generation_models WHEN NEW.cover_media_path IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'model cover media path must belong to model') WHERE NOT EXISTS (SELECT 1 FROM item_images WHERE media_path = NEW.cover_media_path AND owner_kind = 'model' AND owner_id = NEW.id); END;
CREATE TRIGGER generation_loras_cover_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON generation_loras WHEN NEW.cover_media_path IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'lora cover media path must belong to lora') WHERE NOT EXISTS (SELECT 1 FROM item_images WHERE media_path = NEW.cover_media_path AND owner_kind = 'lora' AND owner_id = NEW.id); END;
CREATE TRIGGER artist_prompt_strings_cover_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON artist_prompt_strings WHEN NEW.cover_media_path IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'artist prompt string cover media path must belong to artist prompt string') WHERE NOT EXISTS (SELECT 1 FROM item_images WHERE media_path = NEW.cover_media_path AND owner_kind = 'artist_prompt_string' AND owner_id = NEW.id); END;
CREATE TRIGGER comfyui_templates_cover_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON comfyui_templates WHEN NEW.cover_media_path IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'template cover media path must belong to template') WHERE NOT EXISTS (SELECT 1 FROM item_images WHERE media_path = NEW.cover_media_path AND owner_kind = 'template' AND owner_id = NEW.id); END;

CREATE TRIGGER generation_models_cover_image_delete_before_delete
BEFORE DELETE ON item_images WHEN OLD.owner_kind = 'model' AND EXISTS (SELECT 1 FROM generation_models WHERE id = OLD.owner_id AND cover_media_path = OLD.media_path)
BEGIN SELECT RAISE(ABORT, 'clear model cover before deleting its image'); END;
CREATE TRIGGER generation_loras_cover_image_delete_before_delete
BEFORE DELETE ON item_images WHEN OLD.owner_kind = 'lora' AND EXISTS (SELECT 1 FROM generation_loras WHERE id = OLD.owner_id AND cover_media_path = OLD.media_path)
BEGIN SELECT RAISE(ABORT, 'clear lora cover before deleting its image'); END;
CREATE TRIGGER artist_prompt_strings_cover_image_delete_before_delete
BEFORE DELETE ON item_images WHEN OLD.owner_kind = 'artist_prompt_string' AND EXISTS (SELECT 1 FROM artist_prompt_strings WHERE id = OLD.owner_id AND cover_media_path = OLD.media_path)
BEGIN SELECT RAISE(ABORT, 'clear artist prompt string cover before deleting its image'); END;
CREATE TRIGGER comfyui_templates_cover_image_delete_before_delete
BEFORE DELETE ON item_images WHEN OLD.owner_kind = 'template' AND EXISTS (SELECT 1 FROM comfyui_templates WHERE id = OLD.owner_id AND cover_media_path = OLD.media_path)
BEGIN SELECT RAISE(ABORT, 'clear template cover before deleting its image'); END;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (8, '008-generation-resources', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 8;
COMMIT;
