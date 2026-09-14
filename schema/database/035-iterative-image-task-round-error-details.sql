-- Preserve structured template-admission details for iterative task rounds that
-- fail before a ComfyUI run row can be created.
BEGIN IMMEDIATE;

ALTER TABLE iterative_image_task_rounds
  ADD COLUMN error_details_json TEXT
  CHECK (error_details_json IS NULL OR (json_valid(error_details_json) AND json_type(error_details_json) = 'object'));

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (35, '035-iterative-image-task-round-error-details', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 35;
COMMIT;
