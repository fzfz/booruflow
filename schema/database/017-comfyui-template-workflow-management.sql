-- v0.50.0 ComfyUI 模板修订、静态检查、运行参数和模型资产结构。
BEGIN IMMEDIATE;

CREATE TABLE comfyui_template_revisions (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES comfyui_templates(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  parent_revision_id INTEGER REFERENCES comfyui_template_revisions(id) ON DELETE SET NULL,
  workflow_json TEXT NOT NULL CHECK (json_valid(workflow_json) AND json_type(workflow_json) = 'object'),
  workflow_sha256 TEXT CHECK (workflow_sha256 IS NULL OR length(workflow_sha256) = 64 AND workflow_sha256 NOT GLOB '*[^0-9a-f]*'),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('legacy_backfill', 'builtin_import', 'create', 'manual_update', 'static_repair')),
  repair_operations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(repair_operations_json) AND json_type(repair_operations_json) = 'array'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(template_id, revision_number)
);
CREATE INDEX comfyui_template_revisions_template_id_idx ON comfyui_template_revisions(template_id, revision_number DESC);
CREATE INDEX comfyui_template_revisions_sha256_idx ON comfyui_template_revisions(workflow_sha256);

CREATE TRIGGER comfyui_template_revision_immutable_before_update
BEFORE UPDATE ON comfyui_template_revisions
BEGIN SELECT RAISE(ABORT, 'template revisions are immutable'); END;

CREATE TABLE comfyui_template_current_revisions (
  template_id INTEGER PRIMARY KEY REFERENCES comfyui_templates(id) ON DELETE CASCADE,
  revision_id INTEGER NOT NULL UNIQUE REFERENCES comfyui_template_revisions(id) ON DELETE CASCADE
);

CREATE TRIGGER comfyui_template_current_revision_before_insert
BEFORE INSERT ON comfyui_template_current_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM comfyui_template_revisions
  WHERE id = NEW.revision_id AND template_id = NEW.template_id
)
BEGIN SELECT RAISE(ABORT, 'current template revision must belong to template'); END;

CREATE TRIGGER comfyui_template_current_revision_before_update
BEFORE UPDATE OF template_id, revision_id ON comfyui_template_current_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM comfyui_template_revisions
  WHERE id = NEW.revision_id AND template_id = NEW.template_id
)
BEGIN SELECT RAISE(ABORT, 'current template revision must belong to template'); END;

INSERT INTO comfyui_template_revisions(
  template_id, revision_number, workflow_json, workflow_sha256,
  change_kind, repair_operations_json, created_at
)
SELECT id, 1, template_json, NULL, 'legacy_backfill', '[]', created_at
FROM comfyui_templates;

INSERT INTO comfyui_template_current_revisions(template_id, revision_id)
SELECT template_id, id FROM comfyui_template_revisions;

CREATE TABLE comfyui_template_sources (
  source_key TEXT PRIMARY KEY CHECK (length(trim(source_key)) > 0),
  template_id INTEGER NOT NULL REFERENCES comfyui_templates(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('builtin_workflow', 'database_record', 'user_created')),
  source_label TEXT NOT NULL CHECK (length(trim(source_label)) > 0),
  source_version TEXT NOT NULL CHECK (length(trim(source_version)) > 0),
  original_workflow_sha256 TEXT NOT NULL CHECK (length(original_workflow_sha256) = 64 AND original_workflow_sha256 NOT GLOB '*[^0-9a-f]*'),
  imported_workflow_sha256 TEXT NOT NULL CHECK (length(imported_workflow_sha256) = 64 AND imported_workflow_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z')
);
CREATE INDEX comfyui_template_sources_template_id_idx ON comfyui_template_sources(template_id);
CREATE INDEX comfyui_template_sources_imported_sha256_idx ON comfyui_template_sources(imported_workflow_sha256);

CREATE TABLE comfyui_model_assets (
  id INTEGER PRIMARY KEY,
  base_model_id INTEGER REFERENCES generation_base_models(id) ON DELETE SET NULL,
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('checkpoint', 'unet', 'clip', 'vae', 'lora', 'controlnet', 'upscaler', 'dit', 'other')),
  normalized_file_name TEXT NOT NULL CHECK (length(trim(normalized_file_name)) > 0 AND normalized_file_name NOT LIKE '%\\%'),
  file_format TEXT NOT NULL CHECK (file_format IN ('safetensors', 'ckpt', 'pt', 'pth', 'bin', 'gguf', 'onnx', 'dduf', 'diffusers', 'other')),
  precision_or_quantization TEXT NOT NULL CHECK (precision_or_quantization IN ('none', 'fp16', 'bf16', 'fp8', 'int8', 'int4', 'nf4', 'other')),
  resolution_state TEXT NOT NULL CHECK (resolution_state IN ('registered', 'unresolved')),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(asset_kind, normalized_file_name)
);
CREATE INDEX comfyui_model_assets_base_model_id_idx ON comfyui_model_assets(base_model_id);
CREATE INDEX comfyui_model_assets_resolution_state_idx ON comfyui_model_assets(resolution_state, asset_kind);

CREATE TABLE comfyui_template_asset_references (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES comfyui_templates(id) ON DELETE CASCADE,
  revision_id INTEGER NOT NULL REFERENCES comfyui_template_revisions(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES comfyui_model_assets(id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL CHECK (length(node_id) > 0),
  node_type TEXT NOT NULL CHECK (length(node_type) > 0),
  input_name TEXT NOT NULL CHECK (length(input_name) > 0),
  raw_reference TEXT NOT NULL CHECK (length(raw_reference) > 0),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(revision_id, node_id, input_name, raw_reference)
);
CREATE INDEX comfyui_template_asset_references_template_id_idx ON comfyui_template_asset_references(template_id);
CREATE INDEX comfyui_template_asset_references_asset_id_idx ON comfyui_template_asset_references(asset_id);

CREATE TRIGGER comfyui_template_asset_reference_before_insert
BEFORE INSERT ON comfyui_template_asset_references
WHEN NOT EXISTS (
  SELECT 1 FROM comfyui_template_revisions
  WHERE id = NEW.revision_id AND template_id = NEW.template_id
)
BEGIN SELECT RAISE(ABORT, 'template asset revision must belong to template'); END;

CREATE TABLE comfyui_template_validation_reports (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES comfyui_templates(id) ON DELETE CASCADE,
  revision_id INTEGER NOT NULL UNIQUE REFERENCES comfyui_template_revisions(id) ON DELETE CASCADE,
  workflow_sha256 TEXT NOT NULL CHECK (length(workflow_sha256) = 64 AND workflow_sha256 NOT GLOB '*[^0-9a-f]*'),
  management_state TEXT NOT NULL CHECK (management_state IN ('static_valid', 'repair_review', 'static_invalid')),
  workflow_version REAL,
  errors_json TEXT NOT NULL CHECK (json_valid(errors_json) AND json_type(errors_json) = 'array'),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array'),
  repair_candidates_json TEXT NOT NULL CHECK (json_valid(repair_candidates_json) AND json_type(repair_candidates_json) = 'array'),
  stats_json TEXT NOT NULL CHECK (json_valid(stats_json) AND json_type(stats_json) = 'object'),
  checked_at TEXT NOT NULL CHECK (checked_at GLOB '????-??-??T??:??:??*Z')
);
CREATE INDEX comfyui_template_validation_reports_template_id_idx ON comfyui_template_validation_reports(template_id, checked_at DESC);
CREATE INDEX comfyui_template_validation_reports_state_idx ON comfyui_template_validation_reports(management_state);

CREATE TRIGGER comfyui_template_validation_report_before_insert
BEFORE INSERT ON comfyui_template_validation_reports
WHEN NOT EXISTS (
  SELECT 1 FROM comfyui_template_revisions
  WHERE id = NEW.revision_id
    AND template_id = NEW.template_id
    AND workflow_sha256 = NEW.workflow_sha256
)
BEGIN SELECT RAISE(ABORT, 'validation report must match template revision'); END;

CREATE TABLE comfyui_template_runtime_configs (
  template_id INTEGER PRIMARY KEY REFERENCES comfyui_templates(id) ON DELETE CASCADE,
  revision_id INTEGER NOT NULL REFERENCES comfyui_template_revisions(id) ON DELETE CASCADE,
  workflow_sha256 TEXT NOT NULL CHECK (length(workflow_sha256) = 64 AND workflow_sha256 NOT GLOB '*[^0-9a-f]*'),
  config_revision INTEGER NOT NULL CHECK (config_revision >= 1),
  dimension_strategy TEXT NOT NULL CHECK (dimension_strategy IN ('direct_width_height', 'direct_resolution_preset', 'direct_aspect_megapixels')),
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json) AND json_type(parameters_json) = 'array'),
  bindings_json TEXT NOT NULL CHECK (json_valid(bindings_json) AND json_type(bindings_json) = 'array'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);

CREATE TRIGGER comfyui_template_runtime_config_before_insert
BEFORE INSERT ON comfyui_template_runtime_configs
WHEN NOT EXISTS (
  SELECT 1 FROM comfyui_template_revisions
  WHERE id = NEW.revision_id
    AND template_id = NEW.template_id
    AND workflow_sha256 = NEW.workflow_sha256
)
BEGIN SELECT RAISE(ABORT, 'runtime config must match template revision'); END;

CREATE TRIGGER comfyui_template_runtime_config_before_update
BEFORE UPDATE OF template_id, revision_id, workflow_sha256 ON comfyui_template_runtime_configs
WHEN NOT EXISTS (
  SELECT 1 FROM comfyui_template_revisions
  WHERE id = NEW.revision_id
    AND template_id = NEW.template_id
    AND workflow_sha256 = NEW.workflow_sha256
)
BEGIN SELECT RAISE(ABORT, 'runtime config must match template revision'); END;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (17, '017-comfyui-template-workflow-management', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 17;
COMMIT;
