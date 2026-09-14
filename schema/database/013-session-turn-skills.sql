-- 保存每个成功聊天轮次实际使用的项目 Skill；历史会话按迁移前固定 WAI 行为回填。
BEGIN IMMEDIATE;

CREATE TABLE session_turn_skills (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  skill_name TEXT NOT NULL,
  PRIMARY KEY (session_id, round_number)
);

WITH RECURSIVE successful_rounds(session_id, round_number, rounds_used) AS (
  SELECT id, 1, rounds_used FROM sessions WHERE rounds_used > 0
  UNION ALL
  SELECT session_id, round_number + 1, rounds_used
  FROM successful_rounds
  WHERE round_number < rounds_used
)
INSERT INTO session_turn_skills(session_id, round_number, skill_name)
SELECT session_id, round_number, 'wai-sdxl-prompt-builder'
FROM successful_rounds
ORDER BY session_id, round_number;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (13, '013-session-turn-skills', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 13;
COMMIT;
