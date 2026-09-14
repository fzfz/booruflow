PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

DROP TABLE session_character_selections;
DROP TABLE session_style_selections;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (25, '025-remove-session-selections', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 25;
COMMIT;
