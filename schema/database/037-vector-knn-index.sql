CREATE VIRTUAL TABLE vector_knn_index USING vec0(
  object_kind TEXT partition key,
  object_id INTEGER,
  embedding FLOAT[1024]
);

INSERT INTO vector_knn_index(object_kind, object_id, embedding)
SELECT object_kind, object_id, embedding_f32
FROM vector_entries
ORDER BY object_kind, object_id;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (37, '037-vector-knn-index', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 37;
