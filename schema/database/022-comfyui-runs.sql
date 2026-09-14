-- v0.60.0 持久化 ComfyUI 运行、远端状态、输出图片和结果回调状态。
BEGIN IMMEDIATE;

CREATE TABLE comfyui_runs (
  id INTEGER PRIMARY KEY,
  run_kind TEXT NOT NULL CHECK (run_kind = 'template_runtime_test'),
  run_name TEXT NOT NULL CHECK (length(trim(run_name)) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  template_id INTEGER REFERENCES comfyui_templates(id) ON DELETE SET NULL,
  template_name TEXT NOT NULL CHECK (length(trim(template_name)) > 0),
  model_id INTEGER REFERENCES generation_models(id) ON DELETE SET NULL,
  model_name TEXT NOT NULL CHECK (length(trim(model_name)) > 0),
  instance_id INTEGER REFERENCES comfyui_instances(id) ON DELETE SET NULL,
  instance_name TEXT NOT NULL CHECK (length(trim(instance_name)) > 0),
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision >= 1),
  workflow_sha256 TEXT NOT NULL CHECK (length(workflow_sha256) = 64 AND workflow_sha256 NOT GLOB '*[^0-9a-f]*'),
  runtime_config_revision INTEGER NOT NULL CHECK (runtime_config_revision >= 1),
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json) AND json_type(parameters_json) = 'object'),
  parameters_sha256 TEXT NOT NULL CHECK (length(parameters_sha256) = 64 AND parameters_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'remote_pending', 'remote_running', 'downloading', 'succeeded', 'failed')),
  remote_status TEXT NOT NULL CHECK (remote_status IN ('not_submitted', 'pending', 'running', 'success', 'error', 'unknown')),
  remote_queue_number REAL,
  remote_queue_position INTEGER CHECK (remote_queue_position IS NULL OR remote_queue_position >= 0),
  prompt_id TEXT NOT NULL UNIQUE CHECK (length(prompt_id) = 36 AND prompt_id GLOB '????????-????-????-????-????????????' AND prompt_id NOT GLOB '*[^0-9a-f-]*'),
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json) AND json_type(progress_json) = 'object'),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json) AND json_type(result_json) = 'object'),
  error_code TEXT,
  error_message TEXT,
  callback_id TEXT NOT NULL UNIQUE CHECK (length(callback_id) = 36 AND callback_id GLOB '????????-????-????-????-????????????' AND callback_id NOT GLOB '*[^0-9a-f-]*'),
  callback_status TEXT NOT NULL CHECK (callback_status IN ('not_ready', 'pending', 'delivered', 'failed')),
  callback_attempts INTEGER NOT NULL DEFAULT 0 CHECK (callback_attempts >= 0),
  callback_error_message TEXT,
  next_poll_at TEXT CHECK (next_poll_at IS NULL OR next_poll_at GLOB '????-??-??T??:??:??*Z'),
  next_callback_at TEXT CHECK (next_callback_at IS NULL OR next_callback_at GLOB '????-??-??T??:??:??*Z'),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  submitted_at TEXT CHECK (submitted_at IS NULL OR submitted_at GLOB '????-??-??T??:??:??*Z'),
  remote_started_at TEXT CHECK (remote_started_at IS NULL OR remote_started_at GLOB '????-??-??T??:??:??*Z'),
  finished_at TEXT CHECK (finished_at IS NULL OR finished_at GLOB '????-??-??T??:??:??*Z'),
  callback_delivered_at TEXT CHECK (callback_delivered_at IS NULL OR callback_delivered_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(run_kind, request_id),
  CHECK ((status IN ('succeeded', 'failed') AND finished_at IS NOT NULL) OR (status NOT IN ('succeeded', 'failed') AND finished_at IS NULL)),
  CHECK ((status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL) OR (status <> 'failed' AND error_code IS NULL AND error_message IS NULL)),
  CHECK ((status IN ('succeeded', 'failed') AND callback_status IN ('pending', 'delivered', 'failed')) OR (status NOT IN ('succeeded', 'failed') AND callback_status = 'not_ready'))
);

CREATE INDEX comfyui_runs_due_idx ON comfyui_runs(status, next_poll_at, id);
CREATE INDEX comfyui_runs_callback_due_idx ON comfyui_runs(callback_status, next_callback_at, id);
CREATE INDEX comfyui_runs_created_at_idx ON comfyui_runs(created_at DESC, id DESC);
CREATE INDEX comfyui_runs_template_filter_idx ON comfyui_runs(template_name, created_at DESC);
CREATE INDEX comfyui_runs_model_filter_idx ON comfyui_runs(model_name, created_at DESC);

CREATE TABLE comfyui_run_outputs (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES comfyui_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL CHECK (length(trim(node_id)) > 0),
  output_index INTEGER NOT NULL CHECK (output_index >= 0),
  remote_filename TEXT NOT NULL CHECK (length(trim(remote_filename)) > 0 AND remote_filename NOT LIKE '%/%' AND remote_filename NOT LIKE '%\%' AND remote_filename NOT LIKE '%..%'),
  remote_subfolder TEXT NOT NULL CHECK (remote_subfolder NOT LIKE '/%' AND remote_subfolder NOT LIKE '%\%' AND remote_subfolder NOT LIKE '%..%'),
  remote_type TEXT NOT NULL CHECK (remote_type = 'output'),
  media_path TEXT NOT NULL UNIQUE CHECK (length(trim(media_path)) > 0 AND media_path NOT LIKE '/%' AND media_path NOT LIKE '%\%' AND media_path NOT LIKE '%..%'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(run_id, node_id, output_index)
);

CREATE INDEX comfyui_run_outputs_run_id_idx ON comfyui_run_outputs(run_id, output_index);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (22, '022-comfyui-runs', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 22;
COMMIT;
