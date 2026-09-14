-- 作品封面可以引用作品自身图片，或关联角色的实际媒体路径。
BEGIN IMMEDIATE;

DROP TRIGGER works_cover_media_path_must_belong_before_update;
CREATE TRIGGER works_cover_media_path_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON works
WHEN NEW.cover_media_path IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'work cover media path must belong to work or its character')
  WHERE NOT EXISTS (
    SELECT 1
    FROM item_images i
    LEFT JOIN characters c ON i.owner_kind = 'character' AND c.id = i.owner_id
    WHERE i.media_path = NEW.cover_media_path
      AND ((i.owner_kind = 'work' AND i.owner_id = NEW.id) OR c.work_id = NEW.id)
  );
END;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (4, '004-work-cover-character-fallback', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

PRAGMA user_version = 4;
COMMIT;
