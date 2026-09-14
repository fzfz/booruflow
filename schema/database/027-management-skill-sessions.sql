-- Persist one Pi session per domain owner and selected management Skill.
BEGIN IMMEDIATE;

CREATE TABLE management_skill_sessions (
  id INTEGER PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (length(trim(owner_kind)) > 0),
  owner_id INTEGER NOT NULL CHECK (owner_id > 0),
  skill_name TEXT NOT NULL CHECK (length(trim(skill_name)) > 0),
  pi_instance_id TEXT NOT NULL CHECK (length(trim(pi_instance_id)) > 0),
  pi_session_id TEXT NOT NULL CHECK (length(trim(pi_session_id)) > 0),
  pi_session_file TEXT NOT NULL UNIQUE CHECK (length(trim(pi_session_file)) > 0),
  committed_leaf_id TEXT CHECK (committed_leaf_id IS NULL OR length(trim(committed_leaf_id)) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(owner_kind, owner_id, skill_name)
);

CREATE INDEX management_skill_sessions_owner_idx
  ON management_skill_sessions(owner_kind, owner_id, skill_name);
CREATE INDEX management_skill_sessions_updated_at_idx
  ON management_skill_sessions(updated_at DESC);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (27, '027-management-skill-sessions', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 27;
COMMIT;
