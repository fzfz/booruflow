-- 后续兼容修复：恢复 005 已发布的作品、角色和画风封面归属校验触发器。
BEGIN IMMEDIATE;

CREATE TRIGGER works_cover_media_path_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON works
WHEN NEW.cover_media_path IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'work cover media path must belong to work or its character')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images i LEFT JOIN characters c ON i.owner_kind = 'character' AND c.id = i.owner_id
    WHERE i.media_path = NEW.cover_media_path AND ((i.owner_kind = 'work' AND i.owner_id = NEW.id) OR c.work_id = NEW.id)
  );
END;
CREATE TRIGGER characters_cover_media_path_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON characters
WHEN NEW.cover_media_path IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'character cover media path must belong to character')
  WHERE NOT EXISTS (SELECT 1 FROM item_images WHERE media_path = NEW.cover_media_path AND owner_kind = 'character' AND owner_id = NEW.id);
END;
CREATE TRIGGER styles_cover_media_path_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON styles
WHEN NEW.cover_media_path IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'style cover media path must belong to style')
  WHERE NOT EXISTS (SELECT 1 FROM item_images WHERE media_path = NEW.cover_media_path AND owner_kind = 'style' AND owner_id = NEW.id);
END;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (10, '010-restore-media-cover-triggers', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
PRAGMA user_version = 10;
COMMIT;
