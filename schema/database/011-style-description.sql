-- 画风可选的自然语言描述；历史 styles 行保持 NULL。
BEGIN IMMEDIATE;

ALTER TABLE styles ADD COLUMN style_description TEXT;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (11, '011-style-description', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 11;
COMMIT;
