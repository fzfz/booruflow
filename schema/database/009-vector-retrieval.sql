-- v0.12 可检索对象的 SQLite 向量派生数据；原始业务记录不由本迁移修改。
BEGIN IMMEDIATE;

CREATE TABLE vector_spaces (
  id INTEGER PRIMARY KEY,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('work', 'character', 'style', 'prompt_term')),
  embedding_model TEXT NOT NULL CHECK (length(trim(embedding_model)) > 0),
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  distance_metric TEXT NOT NULL CHECK (distance_metric = 'cosine'),
  normalization TEXT NOT NULL CHECK (normalization = 'l2'),
  text_projection_version TEXT NOT NULL CHECK (length(trim(text_projection_version)) > 0),
  chunking_version TEXT NOT NULL CHECK (length(trim(chunking_version)) > 0),
  status TEXT NOT NULL CHECK (status IN ('building', 'active', 'failed', 'retired')),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  activated_at TEXT CHECK (activated_at IS NULL OR activated_at GLOB '????-??-??T??:??:??*Z'),
  failed_at TEXT CHECK (failed_at IS NULL OR failed_at GLOB '????-??-??T??:??:??*Z'),
  CHECK ((status = 'active' AND activated_at IS NOT NULL) OR (status <> 'active' AND activated_at IS NULL))
);
CREATE UNIQUE INDEX vector_spaces_one_active_kind_uq ON vector_spaces(object_kind) WHERE status = 'active';
CREATE INDEX vector_spaces_kind_status_idx ON vector_spaces(object_kind, status);

CREATE TABLE vector_entries (
  id INTEGER PRIMARY KEY,
  vector_space_id INTEGER NOT NULL REFERENCES vector_spaces(id) ON DELETE CASCADE,
  object_id INTEGER NOT NULL CHECK (object_id > 0),
  chunk_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (chunk_ordinal >= 0),
  embedding_f32 BLOB NOT NULL CHECK (length(embedding_f32) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(vector_space_id, object_id, chunk_ordinal)
);
CREATE INDEX vector_entries_space_object_idx ON vector_entries(vector_space_id, object_id);

CREATE TABLE vector_maintenance_tasks (
  id INTEGER PRIMARY KEY,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('work', 'character', 'style', 'prompt_term')),
  object_id INTEGER CHECK (object_id IS NULL OR object_id > 0),
  vector_space_id INTEGER REFERENCES vector_spaces(id) ON DELETE SET NULL,
  task_kind TEXT NOT NULL CHECK (task_kind IN ('backfill', 'upsert', 'delete', 'rebuild')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'failed', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT CHECK (next_attempt_at IS NULL OR next_attempt_at GLOB '????-??-??T??:??:??*Z'),
  error_category TEXT CHECK (error_category IS NULL OR error_category IN ('timeout', 'unavailable', 'rate_limited', 'sqlite_busy', 'protocol', 'input', 'data')),
  error_message TEXT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  completed_at TEXT CHECK (completed_at IS NULL OR completed_at GLOB '????-??-??T??:??:??*Z'),
  CHECK ((task_kind IN ('backfill', 'rebuild') AND object_id IS NULL) OR (task_kind IN ('upsert', 'delete') AND object_id IS NOT NULL))
);
CREATE INDEX vector_maintenance_tasks_dispatch_idx ON vector_maintenance_tasks(status, next_attempt_at, id);
CREATE INDEX vector_maintenance_tasks_object_idx ON vector_maintenance_tasks(object_kind, object_id, status);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (9, '009-vector-retrieval', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 9;
COMMIT;
