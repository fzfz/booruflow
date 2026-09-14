BEGIN IMMEDIATE;
CREATE TABLE data_import_batches (
  id TEXT PRIMARY KEY NOT NULL,
  committed_at TEXT NOT NULL
);
INSERT INTO schema_migrations(version, name, applied_at)
VALUES (40, '040-data-import-batches', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 40;
COMMIT;
