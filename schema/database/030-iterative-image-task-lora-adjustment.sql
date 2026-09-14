-- Persist the accepted LoRA-adjustment result independently from the prompt result.
-- The result is a task-owned snapshot; it has no relation to mutable catalog rows.
BEGIN IMMEDIATE;

ALTER TABLE iterative_image_task_rounds
  ADD COLUMN lora_adjustment_result_json TEXT
  CHECK (lora_adjustment_result_json IS NULL OR json_valid(lora_adjustment_result_json));

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (30, '030-iterative-image-task-lora-adjustment', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 30;
COMMIT;
