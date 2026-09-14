-- 媒体基础链路：以不可变相对 media_path 和对象实际 cover_media_path 作为新写入契约。
BEGIN IMMEDIATE;

ALTER TABLE works ADD COLUMN cover_media_path TEXT
  CHECK (cover_media_path IS NULL OR (length(trim(cover_media_path)) > 0 AND cover_media_path NOT LIKE '/%' AND cover_media_path NOT LIKE '%..%' AND cover_media_path NOT LIKE '%\\%' ESCAPE '\'));
ALTER TABLE characters ADD COLUMN cover_media_path TEXT
  CHECK (cover_media_path IS NULL OR (length(trim(cover_media_path)) > 0 AND cover_media_path NOT LIKE '/%' AND cover_media_path NOT LIKE '%..%' AND cover_media_path NOT LIKE '%\\%' ESCAPE '\'));
ALTER TABLE styles ADD COLUMN cover_media_path TEXT
  CHECK (cover_media_path IS NULL OR (length(trim(cover_media_path)) > 0 AND cover_media_path NOT LIKE '/%' AND cover_media_path NOT LIKE '%..%' AND cover_media_path NOT LIKE '%\\%' ESCAPE '\'));
ALTER TABLE item_images ADD COLUMN media_path TEXT
  CHECK (media_path IS NULL OR (length(trim(media_path)) > 0 AND media_path NOT LIKE '/%' AND media_path NOT LIKE '%..%' AND media_path NOT LIKE '%\\%' ESCAPE '\'));

UPDATE item_images SET media_path = local_path WHERE media_path IS NULL;
UPDATE works
SET cover_media_path = (
  SELECT media_path FROM item_images
  WHERE item_images.id = works.cover_image_id
    AND item_images.owner_kind = 'work'
    AND item_images.owner_id = works.id
)
WHERE cover_image_id IS NOT NULL;
UPDATE characters
SET cover_media_path = (
  SELECT media_path FROM item_images
  WHERE item_images.id = characters.cover_image_id
    AND item_images.owner_kind = 'character'
    AND item_images.owner_id = characters.id
)
WHERE cover_image_id IS NOT NULL;
UPDATE styles
SET cover_media_path = (
  SELECT media_path FROM item_images
  WHERE item_images.id = styles.cover_image_id
    AND item_images.owner_kind = 'style'
    AND item_images.owner_id = styles.id
)
WHERE cover_image_id IS NOT NULL;

CREATE UNIQUE INDEX item_images_media_path_uq ON item_images(media_path) WHERE media_path IS NOT NULL;
CREATE INDEX item_images_media_path_idx ON item_images(media_path);

CREATE TRIGGER item_images_media_path_immutable_before_update
BEFORE UPDATE OF media_path ON item_images
WHEN NEW.media_path IS NOT OLD.media_path
BEGIN
  SELECT RAISE(ABORT, 'item_images media_path is immutable');
END;

CREATE TRIGGER works_cover_media_path_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON works
WHEN NEW.cover_media_path IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'work cover media path must belong to work')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE media_path = NEW.cover_media_path AND owner_kind = 'work' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER characters_cover_media_path_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON characters
WHEN NEW.cover_media_path IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'character cover media path must belong to character')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE media_path = NEW.cover_media_path AND owner_kind = 'character' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER styles_cover_media_path_must_belong_before_update
BEFORE UPDATE OF cover_media_path ON styles
WHEN NEW.cover_media_path IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'style cover media path must belong to style')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE media_path = NEW.cover_media_path AND owner_kind = 'style' AND owner_id = NEW.id
  );
END;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (3, '003-media-path-foundation', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

PRAGMA user_version = 3;
COMMIT;
