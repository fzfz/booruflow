-- 管理页媒体基础：作品也可直接拥有图片，并保存三类对象的显式封面选择。
BEGIN IMMEDIATE;

ALTER TABLE works ADD COLUMN cover_image_id INTEGER;

DROP TRIGGER item_images_owner_exists_before_insert;
DROP TRIGGER item_images_owner_immutable_before_update;
DROP TRIGGER item_images_id_immutable_before_update;
DROP TRIGGER item_images_cannot_delete_cover_before_delete;
DROP TRIGGER characters_cover_must_belong_before_insert;
DROP TRIGGER characters_cover_must_belong_before_update;
DROP TRIGGER styles_cover_must_belong_before_insert;
DROP TRIGGER styles_cover_must_belong_before_update;
DROP TRIGGER characters_delete_images_after_delete;
DROP TRIGGER styles_delete_images_after_delete;

CREATE TABLE item_images_next (
  id INTEGER PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('work', 'character', 'style')),
  owner_id INTEGER NOT NULL,
  source_id TEXT,
  source_url TEXT,
  content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) > 0),
  local_path TEXT NOT NULL CHECK (length(trim(local_path)) > 0),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TEXT NOT NULL CHECK (created_at GLOB '????-??-??T??:??:??*Z'),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '????-??-??T??:??:??*Z')
);

INSERT INTO item_images_next(id, owner_kind, owner_id, source_id, source_url, content_hash, local_path, sort_order, created_at, updated_at)
SELECT id, owner_kind, owner_id, source_id, source_url, content_hash, local_path, sort_order, created_at, updated_at
FROM item_images;

DROP TABLE item_images;
ALTER TABLE item_images_next RENAME TO item_images;

CREATE UNIQUE INDEX item_images_owner_sort_order_uq ON item_images(owner_kind, owner_id, sort_order);
CREATE UNIQUE INDEX item_images_local_path_uq ON item_images(local_path);
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
BEGIN
  SELECT RAISE(ABORT, 'item_images owner is immutable');
END;

CREATE TRIGGER item_images_id_immutable_before_update
BEFORE UPDATE OF id ON item_images
WHEN NEW.id <> OLD.id
BEGIN
  SELECT RAISE(ABORT, 'item_images id is immutable');
END;

CREATE TRIGGER item_images_cannot_delete_cover_before_delete
BEFORE DELETE ON item_images
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM works WHERE cover_image_id = OLD.id)
      THEN RAISE(ABORT, 'clear or replace work cover before deleting image')
    WHEN EXISTS (SELECT 1 FROM characters WHERE cover_image_id = OLD.id)
      THEN RAISE(ABORT, 'clear or replace character cover before deleting image')
    WHEN EXISTS (SELECT 1 FROM styles WHERE cover_image_id = OLD.id)
      THEN RAISE(ABORT, 'clear or replace style cover before deleting image')
  END;
END;

CREATE TRIGGER works_cover_must_belong_before_update
BEFORE UPDATE OF cover_image_id ON works
WHEN NEW.cover_image_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'work cover image must belong to work')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE id = NEW.cover_image_id AND owner_kind = 'work' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER characters_cover_must_belong_before_insert
BEFORE INSERT ON characters
WHEN NEW.cover_image_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'character cover image must belong to character')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE id = NEW.cover_image_id AND owner_kind = 'character' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER characters_cover_must_belong_before_update
BEFORE UPDATE OF cover_image_id ON characters
WHEN NEW.cover_image_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'character cover image must belong to character')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE id = NEW.cover_image_id AND owner_kind = 'character' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER styles_cover_must_belong_before_insert
BEFORE INSERT ON styles
WHEN NEW.cover_image_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'style cover image must belong to style')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE id = NEW.cover_image_id AND owner_kind = 'style' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER styles_cover_must_belong_before_update
BEFORE UPDATE OF cover_image_id ON styles
WHEN NEW.cover_image_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'style cover image must belong to style')
  WHERE NOT EXISTS (
    SELECT 1 FROM item_images
    WHERE id = NEW.cover_image_id AND owner_kind = 'style' AND owner_id = NEW.id
  );
END;

CREATE TRIGGER works_delete_images_after_delete
AFTER DELETE ON works
BEGIN
  DELETE FROM item_images WHERE owner_kind = 'work' AND owner_id = OLD.id;
END;

CREATE TRIGGER characters_delete_images_after_delete
AFTER DELETE ON characters
BEGIN
  DELETE FROM item_images WHERE owner_kind = 'character' AND owner_id = OLD.id;
END;

CREATE TRIGGER styles_delete_images_after_delete
AFTER DELETE ON styles
BEGIN
  DELETE FROM item_images WHERE owner_kind = 'style' AND owner_id = OLD.id;
END;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (2, '002-management-media', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

PRAGMA user_version = 2;
COMMIT;
