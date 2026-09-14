-- 为聊天会话固定保存文生图底模；既有会话按唯一 WAI 会话 Skill 映射回填。
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE sessions_next (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '新会话' CHECK (length(trim(title)) > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted')),
  max_rounds INTEGER NOT NULL DEFAULT 3 CHECK (max_rounds = 3),
  rounds_used INTEGER NOT NULL DEFAULT 0 CHECK (rounds_used BETWEEN 0 AND max_rounds),
  pi_instance_id TEXT NOT NULL CHECK (length(trim(pi_instance_id)) > 0),
  pi_session_id TEXT NOT NULL CHECK (length(trim(pi_session_id)) > 0),
  pi_session_file TEXT NOT NULL UNIQUE CHECK (length(trim(pi_session_file)) > 0),
  committed_leaf_id TEXT CHECK (committed_leaf_id IS NULL OR length(trim(committed_leaf_id)) > 0),
  base_model_id INTEGER NOT NULL REFERENCES generation_base_models(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  CHECK ((status = 'active' AND rounds_used < max_rounds) OR (status = 'exhausted' AND rounds_used = max_rounds))
);

CREATE TRIGGER sessions_base_model_migration_guard
BEFORE INSERT ON sessions_next
WHEN EXISTS (SELECT 1 FROM sessions)
  AND (SELECT COUNT(*) FROM (
    SELECT DISTINCT generation_models.base_model_id
    FROM generation_models
    WHERE trim(generation_models.skill_name) = 'wai-sdxl-prompt-builder'
  )) <> 1
BEGIN
  SELECT RAISE(ABORT, '012 migration requires exactly one WAI session Skill mapping for existing sessions');
END;

WITH wai_base_models AS (
  SELECT DISTINCT generation_models.base_model_id
  FROM generation_models
  WHERE trim(generation_models.skill_name) = 'wai-sdxl-prompt-builder'
)
INSERT INTO sessions_next(
  id, title, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
  pi_session_file, committed_leaf_id, base_model_id, created_at, updated_at
)
SELECT id, title, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
  pi_session_file, committed_leaf_id, (SELECT base_model_id FROM wai_base_models), created_at, updated_at
FROM sessions;

DROP TRIGGER sessions_base_model_migration_guard;
DROP TABLE sessions;
ALTER TABLE sessions_next RENAME TO sessions;

CREATE INDEX sessions_updated_at_idx ON sessions(updated_at DESC);
CREATE INDEX sessions_pi_session_id_idx ON sessions(pi_session_id);
CREATE INDEX sessions_base_model_id_idx ON sessions(base_model_id);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (12, '012-session-base-model', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 12;
COMMIT;
PRAGMA foreign_keys = ON;
