BEGIN IMMEDIATE;

DROP TABLE IF EXISTS session_work_selections;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (16, '016-remove-session-work-selections', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 16;
COMMIT;
