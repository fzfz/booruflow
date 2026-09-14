-- v0.87.0：模型与 LoRA 文件属性允许使用配置建议值之外的非空字符串。
BEGIN IMMEDIATE;

CREATE TABLE generation_models_next (
  id INTEGER PRIMARY KEY,
  base_model_id INTEGER NOT NULL REFERENCES generation_base_models(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
  file_format TEXT NOT NULL CHECK (
    file_format = trim(file_format)
    AND length(file_format) > 0
    AND length(file_format) <= 64
    AND instr(file_format, char(0)) = 0
    AND file_format NOT GLOB ('*[' || char(1) || char(2) || char(3) || char(4) || char(5) || char(6) || char(7) || char(8) || char(9) || char(10) || char(11) || char(12) || char(13) || char(14) || char(15) || char(16) || char(17) || char(18) || char(19) || char(20) || char(21) || char(22) || char(23) || char(24) || char(25) || char(26) || char(27) || char(28) || char(29) || char(30) || char(31) || char(127) || ']*')
  ),
  precision_or_quantization TEXT NOT NULL CHECK (
    precision_or_quantization = trim(precision_or_quantization)
    AND length(precision_or_quantization) > 0
    AND length(precision_or_quantization) <= 64
    AND instr(precision_or_quantization, char(0)) = 0
    AND precision_or_quantization NOT GLOB ('*[' || char(1) || char(2) || char(3) || char(4) || char(5) || char(6) || char(7) || char(8) || char(9) || char(10) || char(11) || char(12) || char(13) || char(14) || char(15) || char(16) || char(17) || char(18) || char(19) || char(20) || char(21) || char(22) || char(23) || char(24) || char(25) || char(26) || char(27) || char(28) || char(29) || char(30) || char(31) || char(127) || ']*')
  ),
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

CREATE TABLE generation_loras_next (
  id INTEGER PRIMARY KEY,
  base_model_id INTEGER NOT NULL REFERENCES generation_base_models(id) ON DELETE CASCADE,
  model_id INTEGER NOT NULL REFERENCES generation_models_next(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
  file_format TEXT NOT NULL CHECK (
    file_format = trim(file_format)
    AND length(file_format) > 0
    AND length(file_format) <= 64
    AND instr(file_format, char(0)) = 0
    AND file_format NOT GLOB ('*[' || char(1) || char(2) || char(3) || char(4) || char(5) || char(6) || char(7) || char(8) || char(9) || char(10) || char(11) || char(12) || char(13) || char(14) || char(15) || char(16) || char(17) || char(18) || char(19) || char(20) || char(21) || char(22) || char(23) || char(24) || char(25) || char(26) || char(27) || char(28) || char(29) || char(30) || char(31) || char(127) || ']*')
  ),
  precision_or_quantization TEXT NOT NULL CHECK (
    precision_or_quantization = trim(precision_or_quantization)
    AND length(precision_or_quantization) > 0
    AND length(precision_or_quantization) <= 64
    AND instr(precision_or_quantization, char(0)) = 0
    AND precision_or_quantization NOT GLOB ('*[' || char(1) || char(2) || char(3) || char(4) || char(5) || char(6) || char(7) || char(8) || char(9) || char(10) || char(11) || char(12) || char(13) || char(14) || char(15) || char(16) || char(17) || char(18) || char(19) || char(20) || char(21) || char(22) || char(23) || char(24) || char(25) || char(26) || char(27) || char(28) || char(29) || char(30) || char(31) || char(127) || ']*')
  ),
  author TEXT,
  version TEXT,
  release_url TEXT CHECK (release_url IS NULL OR release_url GLOB 'http://*' OR release_url GLOB 'https://*'),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  usage TEXT NOT NULL CHECK (length(trim(usage)) > 0),
  cover_media_path TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  trigger_words_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(trigger_words_json) AND json_type(trigger_words_json) = 'array'),
  weight REAL NOT NULL DEFAULT 1.0
    CHECK (typeof(weight) IN ('integer', 'real'))
);

CREATE TABLE comfyui_templates_next (
  id INTEGER PRIMARY KEY,
  base_model_id INTEGER NOT NULL REFERENCES generation_base_models(id) ON DELETE CASCADE,
  model_id INTEGER NOT NULL REFERENCES generation_models_next(id) ON DELETE CASCADE,
  lora_id INTEGER REFERENCES generation_loras_next(id) ON DELETE CASCADE,
  template_type TEXT NOT NULL CHECK (template_type IN ('text_to_image', 'text_to_image_lora', 'text_to_image_hires_fix', 'text_to_image_second_pass', 'text_to_video', 'image_to_image', 'image_to_video', 'video_to_video', 'style_transfer', 'controlnet', 'inpainting', 'outpainting', 'upscale', 'face_detailer', 'other')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  template_json TEXT NOT NULL CHECK (json_valid(template_json) AND json_type(template_json) = 'object'),
  cover_media_path TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);

INSERT INTO generation_models_next
SELECT id, base_model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, published_at, description, usage, skill_name,
  cover_media_path, created_at, updated_at
FROM generation_models;

INSERT INTO generation_loras_next
SELECT id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
  author, version, release_url, description, usage, cover_media_path,
  created_at, updated_at, trigger_words_json, weight
FROM generation_loras;

INSERT INTO comfyui_templates_next
SELECT id, base_model_id, model_id, lora_id, template_type, title, template_json,
  cover_media_path, created_at, updated_at
FROM comfyui_templates;

DROP TRIGGER item_images_owner_exists_before_insert;
DROP TRIGGER generation_models_cover_image_delete_before_delete;
DROP TRIGGER generation_loras_cover_image_delete_before_delete;
DROP TRIGGER comfyui_templates_cover_image_delete_before_delete;

DROP TABLE comfyui_templates;
DROP TABLE generation_loras;
DROP TABLE generation_models;

ALTER TABLE generation_models_next RENAME TO generation_models;
ALTER TABLE generation_loras_next RENAME TO generation_loras;
ALTER TABLE comfyui_templates_next RENAME TO comfyui_templates;

CREATE UNIQUE INDEX generation_models_identity_uq
  ON generation_models(base_model_id, file_name, file_format, precision_or_quantization, COALESCE(version, ''));
CREATE INDEX generation_models_base_model_id_idx ON generation_models(base_model_id);
CREATE UNIQUE INDEX generation_loras_identity_uq
  ON generation_loras(base_model_id, model_id, file_name, file_format, precision_or_quantization, COALESCE(version, ''));
CREATE INDEX generation_loras_base_model_id_idx ON generation_loras(base_model_id);
CREATE INDEX generation_loras_model_id_idx ON generation_loras(model_id);
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

CREATE TRIGGER generation_models_delete_images_after_delete AFTER DELETE ON generation_models
BEGIN DELETE FROM item_images WHERE owner_kind = 'model' AND owner_id = OLD.id; END;
CREATE TRIGGER generation_loras_delete_images_after_delete AFTER DELETE ON generation_loras
BEGIN DELETE FROM item_images WHERE owner_kind = 'lora' AND owner_id = OLD.id; END;
CREATE TRIGGER comfyui_templates_delete_images_after_delete AFTER DELETE ON comfyui_templates
BEGIN DELETE FROM item_images WHERE owner_kind = 'template' AND owner_id = OLD.id; END;

CREATE TRIGGER generation_models_cover_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON generation_models WHEN NEW.cover_media_path IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'model cover media path must belong to model') WHERE NOT EXISTS (SELECT 1 FROM item_images WHERE media_path = NEW.cover_media_path AND owner_kind = 'model' AND owner_id = NEW.id); END;
CREATE TRIGGER generation_loras_cover_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON generation_loras WHEN NEW.cover_media_path IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'lora cover media path must belong to lora') WHERE NOT EXISTS (SELECT 1 FROM item_images WHERE media_path = NEW.cover_media_path AND owner_kind = 'lora' AND owner_id = NEW.id); END;
CREATE TRIGGER comfyui_templates_cover_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON comfyui_templates WHEN NEW.cover_media_path IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'template cover media path must belong to template') WHERE NOT EXISTS (SELECT 1 FROM item_images WHERE media_path = NEW.cover_media_path AND owner_kind = 'template' AND owner_id = NEW.id); END;

CREATE TRIGGER generation_models_cover_image_delete_before_delete
BEFORE DELETE ON item_images WHEN OLD.owner_kind = 'model' AND EXISTS (SELECT 1 FROM generation_models WHERE id = OLD.owner_id AND cover_media_path = OLD.media_path)
BEGIN SELECT RAISE(ABORT, 'clear model cover before deleting its image'); END;
CREATE TRIGGER generation_loras_cover_image_delete_before_delete
BEFORE DELETE ON item_images WHEN OLD.owner_kind = 'lora' AND EXISTS (SELECT 1 FROM generation_loras WHERE id = OLD.owner_id AND cover_media_path = OLD.media_path)
BEGIN SELECT RAISE(ABORT, 'clear lora cover before deleting its image'); END;
CREATE TRIGGER comfyui_templates_cover_image_delete_before_delete
BEFORE DELETE ON item_images WHEN OLD.owner_kind = 'template' AND EXISTS (SELECT 1 FROM comfyui_templates WHERE id = OLD.owner_id AND cover_media_path = OLD.media_path)
BEGIN SELECT RAISE(ABORT, 'clear template cover before deleting its image'); END;

CREATE TRIGGER generation_loras_delete_vector_entries_after_delete
AFTER DELETE ON generation_loras
BEGIN
  DELETE FROM vector_entries
  WHERE object_kind = 'generation_lora' AND object_id = OLD.id;
END;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (39, '039-generation-resource-file-attributes', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 39;

COMMIT;
