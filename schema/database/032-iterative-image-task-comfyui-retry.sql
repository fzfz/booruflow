-- Allow a persisted iterative image round to retry its Workflow and ComfyUI run.
-- Existing round records retain their prompt/LoRA failure state and all run facts.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE iterative_image_task_rounds_next (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES iterative_image_tasks(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  stage TEXT NOT NULL CHECK (length(trim(stage)) > 0),
  status TEXT NOT NULL CHECK (status IN ('prompt_succeeded', 'active', 'failed')),
  user_text TEXT NOT NULL CHECK (length(trim(user_text)) > 0),
  prompt_result_json TEXT CHECK (prompt_result_json IS NULL OR json_valid(prompt_result_json)),
  final_prompt_text TEXT CHECK (final_prompt_text IS NULL OR length(trim(final_prompt_text)) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  lora_adjustment_result_json TEXT CHECK (lora_adjustment_result_json IS NULL OR json_valid(lora_adjustment_result_json)),
  error_code TEXT CHECK (error_code IS NULL OR length(trim(error_code)) > 0),
  error_message TEXT CHECK (error_message IS NULL OR length(trim(error_message)) > 0),
  retry_operation TEXT CHECK (retry_operation IS NULL OR retry_operation IN ('retry_prompt', 'retry_lora_adjustment', 'retry_comfyui')),
  UNIQUE(task_id, round_number)
);

INSERT INTO iterative_image_task_rounds_next(
  id, task_id, round_number, stage, status, user_text, prompt_result_json,
  final_prompt_text, created_at, updated_at, lora_adjustment_result_json,
  error_code, error_message, retry_operation
)
SELECT id, task_id, round_number, stage, status, user_text, prompt_result_json,
  final_prompt_text, created_at, updated_at, lora_adjustment_result_json,
  error_code, error_message, retry_operation
FROM iterative_image_task_rounds;

DROP TABLE iterative_image_task_rounds;
ALTER TABLE iterative_image_task_rounds_next RENAME TO iterative_image_task_rounds;

CREATE INDEX iterative_image_task_rounds_task_idx
  ON iterative_image_task_rounds(task_id, round_number);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (32, '032-iterative-image-task-comfyui-retry', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 32;
COMMIT;
PRAGMA foreign_keys = ON;
