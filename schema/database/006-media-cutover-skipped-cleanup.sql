-- 停机迁移中跳过的非图片字节不进入受控媒体目录；本迁移删除其目录记录并修复受影响封面。
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS media_cutover_skipped(image_id INTEGER PRIMARY KEY);
DELETE FROM item_images WHERE id IN (SELECT image_id FROM media_cutover_skipped);

UPDATE works
SET cover_media_path = (
  SELECT i.media_path FROM characters c JOIN item_images i ON i.owner_kind = 'character' AND i.owner_id = c.id
  WHERE c.work_id = works.id ORDER BY c.name_normalized COLLATE BINARY, c.id, i.sort_order, i.id LIMIT 1
)
WHERE cover_media_path IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM item_images i LEFT JOIN characters c ON i.owner_kind = 'character' AND c.id = i.owner_id
  WHERE i.media_path = works.cover_media_path AND ((i.owner_kind = 'work' AND i.owner_id = works.id) OR c.work_id = works.id)
);
UPDATE characters
SET cover_media_path = (
  SELECT i.media_path FROM item_images i WHERE i.owner_kind = 'character' AND i.owner_id = characters.id ORDER BY i.sort_order, i.id LIMIT 1
)
WHERE cover_media_path IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM item_images i WHERE i.media_path = characters.cover_media_path AND i.owner_kind = 'character' AND i.owner_id = characters.id
);
UPDATE styles
SET cover_media_path = (
  SELECT i.media_path FROM item_images i WHERE i.owner_kind = 'style' AND i.owner_id = styles.id ORDER BY i.sort_order, i.id LIMIT 1
)
WHERE cover_media_path IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM item_images i WHERE i.media_path = styles.cover_media_path AND i.owner_kind = 'style' AND i.owner_id = styles.id
);

DROP TABLE media_cutover_skipped;
INSERT INTO schema_migrations(version, name, applied_at)
VALUES (6, '006-media-cutover-skipped-cleanup', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
PRAGMA user_version = 6;
COMMIT;
