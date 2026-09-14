-- Distinguish homepage chat sessions from task-owned iterative prompt sessions.
-- Existing rows are explicitly classified as homepage_chat.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE sessions_next (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '新会话' CHECK (length(trim(title)) > 0),
  session_type TEXT NOT NULL CHECK (session_type IN ('homepage_chat', 'iterative_prompt')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted')),
  max_rounds INTEGER CHECK (max_rounds IS NULL OR max_rounds > 0),
  rounds_used INTEGER NOT NULL DEFAULT 0 CHECK (rounds_used >= 0),
  pi_instance_id TEXT NOT NULL CHECK (length(trim(pi_instance_id)) > 0),
  pi_session_id TEXT NOT NULL CHECK (length(trim(pi_session_id)) > 0),
  pi_session_file TEXT NOT NULL UNIQUE CHECK (length(trim(pi_session_file)) > 0),
  committed_leaf_id TEXT CHECK (committed_leaf_id IS NULL OR length(trim(committed_leaf_id)) > 0),
  base_model_id INTEGER NOT NULL REFERENCES generation_base_models(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  CHECK (
    (session_type = 'homepage_chat' AND max_rounds = 3 AND rounds_used <= 3
      AND ((status = 'active' AND rounds_used < 3) OR (status = 'exhausted' AND rounds_used = 3)))
    OR
    (session_type = 'iterative_prompt' AND max_rounds IS NULL AND status = 'active')
  )
);

INSERT INTO sessions_next(
  id, title, session_type, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
  pi_session_file, committed_leaf_id, base_model_id, created_at, updated_at
)
SELECT id, title, 'homepage_chat', status, 3, rounds_used, pi_instance_id, pi_session_id,
  pi_session_file, committed_leaf_id, base_model_id, created_at, updated_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_next RENAME TO sessions;

CREATE INDEX sessions_updated_at_idx ON sessions(updated_at DESC);
CREATE INDEX sessions_pi_session_id_idx ON sessions(pi_session_id);
CREATE INDEX sessions_base_model_id_idx ON sessions(base_model_id);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (26, '026-session-types', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 26;
COMMIT;
PRAGMA foreign_keys = ON;
