-- v0.81.0 Issue #275：把迁移 035 数据库原子转换为六类固定向量空间。
--
-- 本文件由 generation-resource-vector-migration.mjs 在同一 SQLite 连接上
-- 准备 TEMP 数据后执行。TEMP 表保存迁移前四类向量快照、两张源表快照和
-- 两类已经在事务外完成的 Embedding；TEMP 表不属于永久数据库 Schema。
BEGIN IMMEDIATE;

ALTER TABLE vector_spaces RENAME TO vector_spaces_035;
ALTER TABLE vector_entries RENAME TO vector_entries_035;

CREATE TABLE vector_spaces (
  object_kind TEXT PRIMARY KEY NOT NULL CHECK (object_kind IN (
    'work', 'character', 'style', 'prompt_term',
    'generation_lora', 'artist_prompt_string'
  )),
  embedding_model TEXT NOT NULL CHECK (length(trim(embedding_model)) > 0),
  dimension INTEGER NOT NULL CHECK (dimension > 0)
);

CREATE TABLE vector_entries (
  object_kind TEXT NOT NULL CHECK (object_kind IN (
    'work', 'character', 'style', 'prompt_term',
    'generation_lora', 'artist_prompt_string'
  )) REFERENCES vector_spaces(object_kind) ON DELETE CASCADE,
  object_id INTEGER NOT NULL CHECK (object_id > 0),
  embedding_f32 BLOB NOT NULL CHECK (length(embedding_f32) > 0),
  PRIMARY KEY (object_kind, object_id)
);

INSERT INTO vector_spaces(object_kind, embedding_model, dimension)
SELECT object_kind, embedding_model, dimension
FROM migration_036_vector_spaces_035;

INSERT INTO vector_spaces(object_kind, embedding_model, dimension)
VALUES
  (
    'generation_lora',
    COALESCE((SELECT embedding_model FROM migration_036_generation_lora_vectors LIMIT 1), '__unconfigured__'),
    COALESCE((SELECT dimension FROM migration_036_generation_lora_vectors LIMIT 1), 1)
  ),
  (
    'artist_prompt_string',
    COALESCE((SELECT embedding_model FROM migration_036_artist_prompt_string_vectors LIMIT 1), '__unconfigured__'),
    COALESCE((SELECT dimension FROM migration_036_artist_prompt_string_vectors LIMIT 1), 1)
  );

INSERT INTO vector_entries(object_kind, object_id, embedding_f32)
SELECT object_kind, object_id, embedding_f32
FROM migration_036_vector_entries_035;

INSERT INTO vector_entries(object_kind, object_id, embedding_f32)
SELECT 'generation_lora', object_id, embedding_f32
FROM migration_036_generation_lora_vectors;

INSERT INTO vector_entries(object_kind, object_id, embedding_f32)
SELECT 'artist_prompt_string', object_id, embedding_f32
FROM migration_036_artist_prompt_string_vectors;

DROP TABLE vector_entries_035;
DROP TABLE vector_spaces_035;

CREATE TRIGGER generation_loras_delete_vector_entries_after_delete
AFTER DELETE ON generation_loras
BEGIN
  DELETE FROM vector_entries
  WHERE object_kind = 'generation_lora' AND object_id = OLD.id;
END;

CREATE TRIGGER artist_prompt_strings_delete_vector_entries_after_delete
AFTER DELETE ON artist_prompt_strings
BEGIN
  DELETE FROM vector_entries
  WHERE object_kind = 'artist_prompt_string' AND object_id = OLD.id;
END;

-- SQLite 没有独立的事务断言语句。这个临时表把所有迁移不变量变成
-- NOT NULL + CHECK 约束；任一值为 0 都会让当前事务失败并回滚。
CREATE TEMP TABLE migration_036_assertions (
  old_spaces_preserved INTEGER NOT NULL CHECK (old_spaces_preserved = 1),
  old_entries_preserved INTEGER NOT NULL CHECK (old_entries_preserved = 1),
  source_lora_snapshot_stable INTEGER NOT NULL CHECK (source_lora_snapshot_stable = 1),
  source_artist_snapshot_stable INTEGER NOT NULL CHECK (source_artist_snapshot_stable = 1),
  lora_vectors_match_source INTEGER NOT NULL CHECK (lora_vectors_match_source = 1),
  artist_vectors_match_source INTEGER NOT NULL CHECK (artist_vectors_match_source = 1),
  lora_space_configuration_matches INTEGER NOT NULL CHECK (lora_space_configuration_matches = 1),
  artist_space_configuration_matches INTEGER NOT NULL CHECK (artist_space_configuration_matches = 1),
  lora_embedding_lengths_valid INTEGER NOT NULL CHECK (lora_embedding_lengths_valid = 1),
  artist_embedding_lengths_valid INTEGER NOT NULL CHECK (artist_embedding_lengths_valid = 1),
  six_spaces_present INTEGER NOT NULL CHECK (six_spaces_present = 1),
  lora_trigger_present INTEGER NOT NULL CHECK (lora_trigger_present = 1),
  artist_trigger_present INTEGER NOT NULL CHECK (artist_trigger_present = 1),
  foreign_keys_valid INTEGER NOT NULL CHECK (foreign_keys_valid = 1),
  integrity_check_valid INTEGER NOT NULL CHECK (integrity_check_valid = 1)
);

INSERT INTO migration_036_assertions(
  old_spaces_preserved,
  old_entries_preserved,
  source_lora_snapshot_stable,
  source_artist_snapshot_stable,
  lora_vectors_match_source,
  artist_vectors_match_source,
  lora_space_configuration_matches,
  artist_space_configuration_matches,
  lora_embedding_lengths_valid,
  artist_embedding_lengths_valid,
  six_spaces_present,
  lora_trigger_present,
  artist_trigger_present,
  foreign_keys_valid,
  integrity_check_valid
)
SELECT
  CASE WHEN
    (SELECT COUNT(*) FROM vector_spaces WHERE object_kind IN ('work', 'character', 'style', 'prompt_term'))
      = (SELECT COUNT(*) FROM migration_036_vector_spaces_035)
    AND NOT EXISTS (
      SELECT 1
      FROM migration_036_vector_spaces_035 AS old
      LEFT JOIN vector_spaces AS current ON current.object_kind = old.object_kind
      WHERE current.object_kind IS NULL
        OR current.embedding_model <> old.embedding_model
        OR current.dimension <> old.dimension
    )
    AND NOT EXISTS (
      SELECT 1
      FROM vector_spaces AS current
      LEFT JOIN migration_036_vector_spaces_035 AS old ON old.object_kind = current.object_kind
      WHERE current.object_kind IN ('work', 'character', 'style', 'prompt_term')
        AND old.object_kind IS NULL
    )
    THEN 1 ELSE 0 END,
  CASE WHEN
    (SELECT COUNT(*) FROM vector_entries WHERE object_kind IN ('work', 'character', 'style', 'prompt_term'))
      = (SELECT COUNT(*) FROM migration_036_vector_entries_035)
    AND NOT EXISTS (
      SELECT 1
      FROM migration_036_vector_entries_035 AS old
      LEFT JOIN vector_entries AS current
        ON current.object_kind = old.object_kind AND current.object_id = old.object_id
      WHERE current.object_kind IS NULL OR current.embedding_f32 IS NOT old.embedding_f32
    )
    AND NOT EXISTS (
      SELECT 1
      FROM vector_entries AS current
      LEFT JOIN migration_036_vector_entries_035 AS old
        ON old.object_kind = current.object_kind AND old.object_id = current.object_id
      WHERE current.object_kind IN ('work', 'character', 'style', 'prompt_term')
        AND old.object_kind IS NULL
    )
    THEN 1 ELSE 0 END,
  CASE WHEN
    (SELECT COUNT(*) FROM generation_loras) = (SELECT COUNT(*) FROM migration_036_generation_lora_vectors)
    AND NOT EXISTS (
      SELECT 1 FROM generation_loras AS source
      LEFT JOIN migration_036_generation_lora_vectors AS snapshot
        ON snapshot.object_id = source.id AND snapshot.source_updated_at = source.updated_at
      WHERE snapshot.object_id IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM migration_036_generation_lora_vectors AS snapshot
      LEFT JOIN generation_loras AS source
        ON source.id = snapshot.object_id AND source.updated_at = snapshot.source_updated_at
      WHERE source.id IS NULL
    )
    THEN 1 ELSE 0 END,
  CASE WHEN
    (SELECT COUNT(*) FROM artist_prompt_strings) = (SELECT COUNT(*) FROM migration_036_artist_prompt_string_vectors)
    AND NOT EXISTS (
      SELECT 1 FROM artist_prompt_strings AS source
      LEFT JOIN migration_036_artist_prompt_string_vectors AS snapshot
        ON snapshot.object_id = source.id AND snapshot.source_updated_at = source.updated_at
      WHERE snapshot.object_id IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM migration_036_artist_prompt_string_vectors AS snapshot
      LEFT JOIN artist_prompt_strings AS source
        ON source.id = snapshot.object_id AND source.updated_at = snapshot.source_updated_at
      WHERE source.id IS NULL
    )
    THEN 1 ELSE 0 END,
  CASE WHEN
    (SELECT COUNT(*) FROM vector_entries WHERE object_kind = 'generation_lora')
      = (SELECT COUNT(*) FROM migration_036_generation_lora_vectors)
    AND NOT EXISTS (
      SELECT 1 FROM migration_036_generation_lora_vectors AS staged
      LEFT JOIN vector_entries AS current
        ON current.object_kind = 'generation_lora'
       AND current.object_id = staged.object_id
       AND current.embedding_f32 IS staged.embedding_f32
      WHERE current.object_id IS NULL
    )
    THEN 1 ELSE 0 END,
  CASE WHEN
    (SELECT COUNT(*) FROM vector_entries WHERE object_kind = 'artist_prompt_string')
      = (SELECT COUNT(*) FROM migration_036_artist_prompt_string_vectors)
    AND NOT EXISTS (
      SELECT 1 FROM migration_036_artist_prompt_string_vectors AS staged
      LEFT JOIN vector_entries AS current
        ON current.object_kind = 'artist_prompt_string'
       AND current.object_id = staged.object_id
       AND current.embedding_f32 IS staged.embedding_f32
      WHERE current.object_id IS NULL
    )
    THEN 1 ELSE 0 END,
  CASE WHEN
    (SELECT COUNT(*) FROM migration_036_generation_lora_vectors) = 0
    AND EXISTS (
      SELECT 1 FROM vector_spaces
      WHERE object_kind = 'generation_lora'
        AND embedding_model = '__unconfigured__'
        AND dimension = 1
    )
    OR (SELECT COUNT(*) FROM migration_036_generation_lora_vectors) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM migration_036_generation_lora_vectors AS staged
      WHERE NOT EXISTS (
        SELECT 1 FROM vector_spaces AS current
        WHERE current.object_kind = 'generation_lora'
          AND current.embedding_model = staged.embedding_model
          AND current.dimension = staged.dimension
      )
    )
    THEN 1 ELSE 0 END,
  CASE WHEN
    (SELECT COUNT(*) FROM migration_036_artist_prompt_string_vectors) = 0
    AND EXISTS (
      SELECT 1 FROM vector_spaces
      WHERE object_kind = 'artist_prompt_string'
        AND embedding_model = '__unconfigured__'
        AND dimension = 1
    )
    OR (SELECT COUNT(*) FROM migration_036_artist_prompt_string_vectors) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM migration_036_artist_prompt_string_vectors AS staged
      WHERE NOT EXISTS (
        SELECT 1 FROM vector_spaces AS current
        WHERE current.object_kind = 'artist_prompt_string'
          AND current.embedding_model = staged.embedding_model
          AND current.dimension = staged.dimension
      )
    )
    THEN 1 ELSE 0 END,
  CASE WHEN NOT EXISTS (
    SELECT 1
    FROM (
      SELECT 'generation_lora' AS object_kind, embedding_f32 FROM migration_036_generation_lora_vectors
      UNION ALL
      SELECT object_kind, embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora'
    ) AS vectors
    JOIN vector_spaces AS spaces ON spaces.object_kind = vectors.object_kind
    WHERE length(vectors.embedding_f32) <> spaces.dimension * 4
  ) THEN 1 ELSE 0 END,
  CASE WHEN NOT EXISTS (
    SELECT 1
    FROM (
      SELECT 'artist_prompt_string' AS object_kind, embedding_f32 FROM migration_036_artist_prompt_string_vectors
      UNION ALL
      SELECT object_kind, embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string'
    ) AS vectors
    JOIN vector_spaces AS spaces ON spaces.object_kind = vectors.object_kind
    WHERE length(vectors.embedding_f32) <> spaces.dimension * 4
  ) THEN 1 ELSE 0 END,
  CASE WHEN
    (SELECT COUNT(*) FROM vector_spaces) = 6
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT 'work' AS object_kind UNION ALL
        SELECT 'character' UNION ALL
        SELECT 'style' UNION ALL
        SELECT 'prompt_term' UNION ALL
        SELECT 'generation_lora' UNION ALL
        SELECT 'artist_prompt_string'
      ) AS expected
      LEFT JOIN vector_spaces AS current ON current.object_kind = expected.object_kind
      WHERE current.object_kind IS NULL
    )
    THEN 1 ELSE 0 END,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'trigger' AND name = 'generation_loras_delete_vector_entries_after_delete'
  ) THEN 1 ELSE 0 END,
  CASE WHEN EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type = 'trigger' AND name = 'artist_prompt_strings_delete_vector_entries_after_delete'
  ) THEN 1 ELSE 0 END,
  CASE WHEN NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END,
  CASE WHEN (SELECT integrity_check FROM pragma_integrity_check LIMIT 1) = 'ok' THEN 1 ELSE 0 END;

DROP TABLE migration_036_assertions;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (36, '036-generation-resource-vectors', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 36;
COMMIT;
