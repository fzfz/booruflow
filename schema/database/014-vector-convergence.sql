-- v0.12 Issue #209：收敛为四个固定向量配置行和单条向量条目。
-- 009 已发布文件保持不变；本迁移仅把旧派生数据转换为新的固定结构。
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

ALTER TABLE vector_spaces RENAME TO vector_spaces_legacy_009;
ALTER TABLE vector_entries RENAME TO vector_entries_legacy_009;

CREATE TABLE vector_spaces (
  object_kind TEXT PRIMARY KEY CHECK (object_kind IN ('work', 'character', 'style', 'prompt_term')),
  embedding_model TEXT NOT NULL CHECK (length(trim(embedding_model)) > 0),
  dimension INTEGER NOT NULL CHECK (dimension > 0)
);

CREATE TABLE vector_entries (
  object_kind TEXT NOT NULL REFERENCES vector_spaces(object_kind) ON DELETE CASCADE,
  object_id INTEGER NOT NULL CHECK (object_id > 0),
  embedding_f32 BLOB NOT NULL CHECK (length(embedding_f32) > 0),
  PRIMARY KEY (object_kind, object_id)
);

WITH object_kinds(object_kind) AS (
  VALUES ('work'), ('character'), ('style'), ('prompt_term')
)
INSERT INTO vector_spaces(object_kind, embedding_model, dimension)
SELECT object_kinds.object_kind,
  COALESCE((SELECT embedding_model FROM vector_spaces_legacy_009
    WHERE vector_spaces_legacy_009.object_kind = object_kinds.object_kind
      AND vector_spaces_legacy_009.status = 'active' LIMIT 1), '__unconfigured__'),
  COALESCE((SELECT dimension FROM vector_spaces_legacy_009
    WHERE vector_spaces_legacy_009.object_kind = object_kinds.object_kind
      AND vector_spaces_legacy_009.status = 'active' LIMIT 1), 1)
FROM object_kinds;

INSERT INTO vector_entries(object_kind, object_id, embedding_f32)
SELECT spaces.object_kind, entries.object_id, entries.embedding_f32
FROM vector_entries_legacy_009 AS entries
JOIN vector_spaces_legacy_009 AS spaces ON spaces.id = entries.vector_space_id
WHERE spaces.status = 'active'
  AND spaces.object_kind IN ('work', 'character', 'prompt_term')
  AND entries.chunk_ordinal = 0;

DROP TABLE vector_maintenance_tasks;
DROP TABLE vector_entries_legacy_009;
DROP TABLE vector_spaces_legacy_009;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (14, '014-vector-convergence', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 14;
COMMIT;
PRAGMA foreign_keys = ON;
