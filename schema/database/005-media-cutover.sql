-- 停机媒体迁移：本文件只能由 app/database/media-cutover.mjs 在文件移动计划已落盘后执行。
BEGIN IMMEDIATE;

DROP TRIGGER IF EXISTS item_images_media_path_immutable_before_update;
DROP TRIGGER IF EXISTS works_cover_media_path_must_belong_before_update;
DROP TRIGGER IF EXISTS characters_cover_media_path_must_belong_before_update;
DROP TRIGGER IF EXISTS styles_cover_media_path_must_belong_before_update;

UPDATE item_images
SET media_path = (SELECT target_path FROM media_cutover_paths WHERE image_id = item_images.id);

UPDATE works
SET cover_media_path = COALESCE(
  (SELECT p.target_path FROM media_cutover_paths p JOIN item_images i ON i.id = p.image_id
   LEFT JOIN characters c ON i.owner_kind = 'character' AND c.id = i.owner_id
   WHERE p.source_path = works.cover_media_path
     AND ((i.owner_kind = 'work' AND i.owner_id = works.id) OR c.work_id = works.id)),
  (SELECT i.media_path FROM characters c JOIN item_images i ON i.owner_kind = 'character' AND i.owner_id = c.id
   WHERE c.work_id = works.id ORDER BY c.name_normalized COLLATE BINARY, c.id, i.sort_order, i.id LIMIT 1)
);
UPDATE characters
SET cover_media_path = COALESCE(
  (SELECT p.target_path FROM media_cutover_paths p JOIN item_images i ON i.id = p.image_id
   WHERE p.source_path = characters.cover_media_path AND i.owner_kind = 'character' AND i.owner_id = characters.id),
  (SELECT i.media_path FROM item_images i WHERE i.owner_kind = 'character' AND i.owner_id = characters.id ORDER BY i.sort_order, i.id LIMIT 1)
);
UPDATE styles
SET cover_media_path = COALESCE(
  (SELECT p.target_path FROM media_cutover_paths p JOIN item_images i ON i.id = p.image_id
   WHERE p.source_path = styles.cover_media_path AND i.owner_kind = 'style' AND i.owner_id = styles.id),
  (SELECT i.media_path FROM item_images i WHERE i.owner_kind = 'style' AND i.owner_id = styles.id ORDER BY i.sort_order, i.id LIMIT 1)
);

DROP TRIGGER IF EXISTS item_images_cannot_delete_cover_before_delete;
DROP TRIGGER IF EXISTS works_cover_must_belong_before_update;
DROP TRIGGER IF EXISTS characters_cover_must_belong_before_insert;
DROP TRIGGER IF EXISTS characters_cover_must_belong_before_update;
DROP TRIGGER IF EXISTS styles_cover_must_belong_before_insert;
DROP TRIGGER IF EXISTS styles_cover_must_belong_before_update;
DROP TRIGGER IF EXISTS works_delete_images_after_delete;
DROP TRIGGER IF EXISTS characters_delete_images_after_delete;
DROP TRIGGER IF EXISTS styles_delete_images_after_delete;
CREATE TABLE item_images_next (
  id INTEGER PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('work', 'character', 'style')),
  owner_id INTEGER NOT NULL,
  source_id TEXT,
  source_url TEXT,
  content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) > 0),
  media_path TEXT NOT NULL UNIQUE CHECK (length(trim(media_path)) > 0 AND media_path NOT LIKE '/%' AND media_path NOT LIKE '%..%' AND media_path NOT LIKE '%\\%' ESCAPE '\'),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z'),
  UNIQUE(owner_kind, owner_id, sort_order)
);
INSERT INTO item_images_next(id, owner_kind, owner_id, source_id, source_url, content_hash, media_path, sort_order, created_at, updated_at)
SELECT id, owner_kind, owner_id, source_id, source_url, content_hash, media_path, sort_order, created_at, updated_at
FROM item_images;
DROP TABLE item_images;
ALTER TABLE item_images_next RENAME TO item_images;

CREATE UNIQUE INDEX item_images_owner_source_url_uq
  ON item_images(owner_kind, owner_id, source_url) WHERE source_url IS NOT NULL;
CREATE INDEX item_images_content_hash_idx ON item_images(content_hash);
CREATE INDEX item_images_owner_idx ON item_images(owner_kind, owner_id);

CREATE TRIGGER item_images_owner_exists_before_insert
BEFORE INSERT ON item_images
BEGIN
  SELECT CASE
    WHEN NEW.owner_kind = 'work' AND NOT EXISTS (SELECT 1 FROM works WHERE id = NEW.owner_id)
      THEN RAISE(ABORT, 'item_images owner work does not exist')
    WHEN NEW.owner_kind = 'character' AND NOT EXISTS (SELECT 1 FROM characters WHERE id = NEW.owner_id)
      THEN RAISE(ABORT, 'item_images owner character does not exist')
    WHEN NEW.owner_kind = 'style' AND NOT EXISTS (SELECT 1 FROM styles WHERE id = NEW.owner_id)
      THEN RAISE(ABORT, 'item_images owner style does not exist')
  END;
END;
CREATE TRIGGER item_images_owner_immutable_before_update
BEFORE UPDATE OF owner_kind, owner_id ON item_images
BEGIN SELECT RAISE(ABORT, 'item_images owner is immutable'); END;
CREATE TRIGGER item_images_id_immutable_before_update
BEFORE UPDATE OF id ON item_images
WHEN NEW.id <> OLD.id
BEGIN SELECT RAISE(ABORT, 'item_images id is immutable'); END;
CREATE TRIGGER item_images_media_path_immutable_before_update
BEFORE UPDATE OF media_path ON item_images
WHEN NEW.media_path IS NOT OLD.media_path
BEGIN SELECT RAISE(ABORT, 'item_images media_path is immutable'); END;
CREATE TRIGGER works_delete_images_after_delete
AFTER DELETE ON works
BEGIN DELETE FROM item_images WHERE owner_kind = 'work' AND owner_id = OLD.id; END;
CREATE TRIGGER characters_delete_images_after_delete
AFTER DELETE ON characters
BEGIN DELETE FROM item_images WHERE owner_kind = 'character' AND owner_id = OLD.id; END;
CREATE TRIGGER styles_delete_images_after_delete
AFTER DELETE ON styles
BEGIN DELETE FROM item_images WHERE owner_kind = 'style' AND owner_id = OLD.id; END;
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

ALTER TABLE works DROP COLUMN cover_image_id;
ALTER TABLE characters DROP COLUMN cover_image_id;
ALTER TABLE styles DROP COLUMN cover_image_id;
DROP TABLE media_cutover_paths;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (5, '005-media-cutover', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
PRAGMA user_version = 5;
COMMIT;
