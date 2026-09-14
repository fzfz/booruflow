-- Persist iterative image task metadata, immutable resource snapshots and the first prompt round.
-- Resource identifiers are snapshots only: source catalog rows remain mutable and deletable.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

-- Keep the saved base-model identity for every session. Only homepage sessions retain
-- a live source relation; iterative sessions use their immutable source snapshot after
-- the catalog row is deleted.
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
  base_model_id INTEGER NOT NULL CHECK (base_model_id > 0),
  homepage_base_model_id INTEGER GENERATED ALWAYS AS (
    CASE WHEN session_type = 'homepage_chat' THEN base_model_id ELSE NULL END
  ) STORED REFERENCES generation_base_models(id) ON DELETE RESTRICT,
  base_model_snapshot_json TEXT CHECK (base_model_snapshot_json IS NULL OR json_valid(base_model_snapshot_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  CHECK (
    (session_type = 'homepage_chat' AND base_model_id = homepage_base_model_id AND homepage_base_model_id IS NOT NULL
      AND max_rounds = 3 AND rounds_used <= 3
      AND ((status = 'active' AND rounds_used < 3) OR (status = 'exhausted' AND rounds_used = 3)))
    OR
    (session_type = 'iterative_prompt' AND homepage_base_model_id IS NULL AND max_rounds IS NULL AND status = 'active'
      AND json_type(base_model_snapshot_json, '$.id') = 'integer'
      AND json_extract(base_model_snapshot_json, '$.id') > 0
      AND json_type(base_model_snapshot_json, '$.name') = 'text'
      AND length(trim(json_extract(base_model_snapshot_json, '$.name'))) > 0)
  )
);

INSERT INTO sessions_next(
  id, title, session_type, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
  pi_session_file, committed_leaf_id, base_model_id, base_model_snapshot_json, created_at, updated_at
)
SELECT sessions.id, sessions.title, sessions.session_type, sessions.status, sessions.max_rounds, sessions.rounds_used,
  sessions.pi_instance_id, sessions.pi_session_id, sessions.pi_session_file, sessions.committed_leaf_id,
  sessions.base_model_id,
  CASE WHEN sessions.session_type = 'iterative_prompt'
    THEN json_object('id', sessions.base_model_id, 'name', generation_base_models.name)
    ELSE NULL END,
  sessions.created_at, sessions.updated_at
FROM sessions
JOIN generation_base_models ON generation_base_models.id = sessions.base_model_id;

DROP TABLE sessions;
ALTER TABLE sessions_next RENAME TO sessions;

CREATE INDEX sessions_updated_at_idx ON sessions(updated_at DESC);
CREATE INDEX sessions_pi_session_id_idx ON sessions(pi_session_id);
CREATE INDEX sessions_base_model_id_idx ON sessions(base_model_id);

CREATE TABLE iterative_image_tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  original_prompt TEXT NOT NULL CHECK (length(trim(original_prompt)) > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelling', 'cancelled')),
  current_stage TEXT NOT NULL DEFAULT 'prompt' CHECK (length(trim(current_stage)) > 0),
  base_model_id INTEGER NOT NULL CHECK (base_model_id > 0),
  model_id INTEGER NOT NULL CHECK (model_id > 0),
  template_id INTEGER NOT NULL CHECK (template_id > 0),
  template_revision_id INTEGER NOT NULL CHECK (template_revision_id > 0),
  runtime_config_revision INTEGER NOT NULL CHECK (runtime_config_revision > 0),
  instance_id INTEGER NOT NULL CHECK (instance_id > 0),
  fixed_parameters_json TEXT NOT NULL CHECK (json_valid(fixed_parameters_json)),
  resource_snapshot_json TEXT NOT NULL CHECK (json_valid(resource_snapshot_json)),
  iterative_prompt_session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);

CREATE INDEX iterative_image_tasks_status_stage_idx
  ON iterative_image_tasks(status, current_stage, updated_at DESC, id DESC);
CREATE INDEX iterative_image_tasks_base_model_idx
  ON iterative_image_tasks(base_model_id, updated_at DESC, id DESC);

CREATE TABLE iterative_image_task_skills (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES iterative_image_tasks(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL CHECK (length(trim(skill_name)) > 0),
  skill_kind TEXT NOT NULL CHECK (length(trim(skill_kind)) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(task_id, skill_name)
);

CREATE INDEX iterative_image_task_skills_task_idx
  ON iterative_image_task_skills(task_id, id);

CREATE TABLE iterative_image_task_loras (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES iterative_image_tasks(id) ON DELETE CASCADE,
  source_lora_id INTEGER NOT NULL CHECK (source_lora_id > 0),
  selection_order INTEGER NOT NULL CHECK (selection_order > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(task_id, selection_order),
  UNIQUE(task_id, source_lora_id)
);

CREATE INDEX iterative_image_task_loras_task_idx
  ON iterative_image_task_loras(task_id, selection_order);

CREATE TABLE iterative_image_task_rounds (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES iterative_image_tasks(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number > 0),
  stage TEXT NOT NULL CHECK (length(trim(stage)) > 0),
  status TEXT NOT NULL CHECK (status IN ('prompt_succeeded', 'active', 'failed')),
  user_text TEXT NOT NULL CHECK (length(trim(user_text)) > 0),
  prompt_result_json TEXT CHECK (prompt_result_json IS NULL OR json_valid(prompt_result_json)),
  final_prompt_text TEXT CHECK (final_prompt_text IS NULL OR length(trim(final_prompt_text)) > 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(task_id, round_number)
);

CREATE INDEX iterative_image_task_rounds_task_idx
  ON iterative_image_task_rounds(task_id, round_number);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (28, '028-iterative-image-tasks', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 28;
COMMIT;
PRAGMA foreign_keys = ON;
