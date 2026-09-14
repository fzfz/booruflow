-- Persist the first iterative-image round's prepared Workflow/API JSON and
-- typed ComfyUI output media without changing the historical run tables.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE comfyui_runs_next (
  id INTEGER PRIMARY KEY,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('template_runtime_test', 'iterative_image_round')),
  run_name TEXT NOT NULL CHECK (length(trim(run_name)) > 0),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  template_id INTEGER REFERENCES comfyui_templates(id) ON DELETE SET NULL,
  template_name TEXT NOT NULL CHECK (length(trim(template_name)) > 0),
  model_id INTEGER REFERENCES generation_models(id) ON DELETE SET NULL,
  model_name TEXT NOT NULL CHECK (length(trim(model_name)) > 0),
  instance_id INTEGER REFERENCES comfyui_instances(id) ON DELETE SET NULL,
  instance_name TEXT NOT NULL CHECK (length(trim(instance_name)) > 0),
  iterative_image_task_id INTEGER REFERENCES iterative_image_tasks(id) ON DELETE CASCADE,
  iterative_image_task_round_id INTEGER REFERENCES iterative_image_task_rounds(id) ON DELETE CASCADE,
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision >= 1),
  workflow_sha256 TEXT NOT NULL CHECK (length(workflow_sha256) = 64 AND workflow_sha256 NOT GLOB '*[^0-9a-f]*'),
  runtime_config_revision INTEGER NOT NULL CHECK (runtime_config_revision >= 1),
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json) AND json_type(parameters_json) = 'object'),
  parameters_sha256 TEXT NOT NULL CHECK (length(parameters_sha256) = 64 AND parameters_sha256 NOT GLOB '*[^0-9a-f]*'),
  prompt_text TEXT CHECK (prompt_text IS NULL OR length(trim(prompt_text)) > 0),
  workflow_json TEXT CHECK (workflow_json IS NULL OR json_valid(workflow_json) AND json_type(workflow_json) = 'object'),
  api_workflow_json TEXT CHECK (api_workflow_json IS NULL OR json_valid(api_workflow_json) AND json_type(api_workflow_json) = 'object'),
  output_node_ids_json TEXT CHECK (output_node_ids_json IS NULL OR json_valid(output_node_ids_json) AND json_type(output_node_ids_json) = 'array'),
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
  CHECK ((run_kind = 'template_runtime_test' AND iterative_image_task_id IS NULL AND iterative_image_task_round_id IS NULL AND prompt_text IS NULL)
    OR (run_kind = 'iterative_image_round' AND iterative_image_task_id IS NOT NULL AND iterative_image_task_round_id IS NOT NULL AND prompt_text IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'failed') AND finished_at IS NOT NULL) OR (status NOT IN ('succeeded', 'failed') AND finished_at IS NULL)),
  CHECK ((status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL) OR (status <> 'failed' AND error_code IS NULL AND error_message IS NULL)),
  CHECK ((status IN ('succeeded', 'failed') AND callback_status IN ('pending', 'delivered', 'failed')) OR (status NOT IN ('succeeded', 'failed') AND callback_status = 'not_ready'))
);

INSERT INTO comfyui_runs_next(
  id, run_kind, run_name, request_id, request_sha256,
  template_id, template_name, model_id, model_name, instance_id, instance_name,
  workflow_revision, workflow_sha256, runtime_config_revision,
  parameters_json, parameters_sha256, status, remote_status, remote_queue_number,
  remote_queue_position, prompt_id, progress_json, result_json, error_code, error_message,
  callback_id, callback_status, callback_attempts, callback_error_message,
  next_poll_at, next_callback_at, created_at, updated_at, submitted_at,
  remote_started_at, finished_at, callback_delivered_at
)
SELECT id, run_kind, run_name, request_id, request_sha256,
  template_id, template_name, model_id, model_name, instance_id, instance_name,
  workflow_revision, workflow_sha256, runtime_config_revision,
  parameters_json, parameters_sha256, status, remote_status, remote_queue_number,
  remote_queue_position, prompt_id, progress_json, result_json, error_code, error_message,
  callback_id, callback_status, callback_attempts, callback_error_message,
  next_poll_at, next_callback_at, created_at, updated_at, submitted_at,
  remote_started_at, finished_at, callback_delivered_at
FROM comfyui_runs;

CREATE TABLE comfyui_run_outputs_next (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES comfyui_runs_next(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL CHECK (length(trim(node_id)) > 0),
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
  output_index INTEGER NOT NULL CHECK (output_index >= 0),
  remote_filename TEXT NOT NULL CHECK (length(trim(remote_filename)) > 0 AND remote_filename NOT LIKE '%/%' AND remote_filename NOT LIKE '%\\%' AND remote_filename NOT LIKE '%..%'),
  remote_subfolder TEXT NOT NULL CHECK (remote_subfolder NOT LIKE '/%' AND remote_subfolder NOT LIKE '%\\%' AND remote_subfolder NOT LIKE '%..%'),
  remote_type TEXT NOT NULL CHECK (remote_type = 'output'),
  media_path TEXT NOT NULL UNIQUE CHECK (length(trim(media_path)) > 0 AND media_path NOT LIKE '/%' AND media_path NOT LIKE '%\\%' AND media_path NOT LIKE '%..%'),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm')),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 1),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(run_id, node_id, media_kind, output_index)
);

INSERT INTO comfyui_run_outputs_next(
  id, run_id, node_id, media_kind, output_index, remote_filename, remote_subfolder,
  remote_type, media_path, content_hash, media_type, byte_length, created_at
)
SELECT id, run_id, node_id, 'image', output_index, remote_filename, remote_subfolder,
  remote_type, media_path, content_hash, media_type, byte_length, created_at
FROM comfyui_run_outputs;

DROP TABLE comfyui_run_outputs;
DROP TABLE comfyui_runs;
ALTER TABLE comfyui_runs_next RENAME TO comfyui_runs;
ALTER TABLE comfyui_run_outputs_next RENAME TO comfyui_run_outputs;

CREATE INDEX comfyui_runs_due_idx ON comfyui_runs(status, next_poll_at, id);
CREATE INDEX comfyui_runs_callback_due_idx ON comfyui_runs(callback_status, next_callback_at, id);
CREATE INDEX comfyui_runs_created_at_idx ON comfyui_runs(created_at DESC, id DESC);
CREATE INDEX comfyui_runs_template_filter_idx ON comfyui_runs(template_name, created_at DESC);
CREATE INDEX comfyui_runs_model_filter_idx ON comfyui_runs(model_name, created_at DESC);
CREATE INDEX comfyui_runs_iterative_task_idx ON comfyui_runs(iterative_image_task_id, iterative_image_task_round_id, created_at DESC);
CREATE INDEX comfyui_run_outputs_run_id_idx ON comfyui_run_outputs(run_id, output_index);

ALTER TABLE comfyui_template_runtime_configs ADD COLUMN expected_output_node_ids_json TEXT
  CHECK (expected_output_node_ids_json IS NULL OR json_valid(expected_output_node_ids_json) AND json_type(expected_output_node_ids_json) = 'array');

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (29, '029-comfyui-iterative-runs-media', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 29;
COMMIT;
PRAGMA foreign_keys = ON;
