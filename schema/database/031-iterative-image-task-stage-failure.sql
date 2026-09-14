-- Persist the public failure and retry state on each iterative image task round.
BEGIN IMMEDIATE;

ALTER TABLE iterative_image_task_rounds
  ADD COLUMN error_code TEXT
  CHECK (error_code IS NULL OR length(trim(error_code)) > 0);
ALTER TABLE iterative_image_task_rounds
  ADD COLUMN error_message TEXT
  CHECK (error_message IS NULL OR length(trim(error_message)) > 0);
ALTER TABLE iterative_image_task_rounds
  ADD COLUMN retry_operation TEXT
  CHECK (retry_operation IS NULL OR retry_operation IN ('retry_prompt', 'retry_lora_adjustment'));

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (31, '031-iterative-image-task-stage-failure', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 31;
COMMIT;
