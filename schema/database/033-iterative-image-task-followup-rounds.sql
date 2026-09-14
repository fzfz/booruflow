-- Keep at most one unfinished round for each iterative image task.
-- A media/active round is terminal only after the existing ComfyUI output
-- transaction has accepted its result media; every other round remains
-- unfinished and blocks another follow-up round.
BEGIN IMMEDIATE;

CREATE UNIQUE INDEX iterative_image_task_one_unfinished_round_idx
  ON iterative_image_task_rounds(task_id)
  WHERE NOT (stage = 'media' AND status = 'active');

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (33, '033-iterative-image-task-followup-rounds', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 33;
COMMIT;
