-- Persist request identities for the three iterative-image-task asynchronous writes.
-- The request row is claimed before Pi or ComfyUI work; its task/round identity is
-- completed in the same transaction that creates the corresponding domain row.
BEGIN IMMEDIATE;

CREATE TABLE iterative_image_task_write_requests (
  id INTEGER PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('createIterativeImageTask', 'createIterativeImageTaskRound', 'retryIterativeImageTask')),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  request_json TEXT NOT NULL CHECK (json_valid(request_json) AND json_type(request_json) = 'object'),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  task_id INTEGER REFERENCES iterative_image_tasks(id) ON DELETE CASCADE,
  round_id INTEGER REFERENCES iterative_image_task_rounds(id) ON DELETE CASCADE,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(request_id),
  CHECK (operation = 'createIterativeImageTask' OR round_id IS NOT NULL OR status IN ('pending', 'failed')),
  CHECK ((status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL)
    OR (status <> 'failed' AND error_code IS NULL AND error_message IS NULL)),
  CHECK (status <> 'completed' OR task_id IS NOT NULL)
);

CREATE INDEX iterative_image_task_write_requests_task_idx
  ON iterative_image_task_write_requests(task_id, operation, id);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (34, '034-iterative-image-task-write-idempotency', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 34;
COMMIT;
