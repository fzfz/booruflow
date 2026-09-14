import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { createCatalogRepository } from '../../../app/catalog/catalog-repository.mjs';
import { createMaintenanceService } from '../../../app/maintenance/maintenance-service.mjs';
import { createMediaStorage } from '../../../app/media/media-storage.mjs';

const NOW = '2026-08-01T00:00:00Z';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1, 229, 39, 212, 162, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

function insertFixture(database) {
  database.prepare('INSERT OR IGNORE INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('Media foundation base', NOW, NOW);
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
    VALUES (1, 'Work', 'work', '[]', 1, ?, ?)` ).run(NOW, NOW);
  database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
    VALUES (2, 1, 'Character', 'character', '[]', 'ink', 1, ?, ?)` ).run(NOW, NOW);
  database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
    VALUES (3, 1, 'Style', '[]', 'paper', NULL, NULL)` ).run();
}

test('media storage writes UUID-sharded paths with a five-digit cryptographic suffix', () => {
  const root = mkdtempSync(join(tmpdir(), 'noobai-media-foundation-'));
  const storage = createMediaStorage({
    mediaRoot: join(root, 'media'),
    makeId: () => '01234567-89ab-4def-8123-456789abcdef',
    makeRandomDigits: () => '54321'
  });

  const [entry] = storage.stageFiles([{ bytes: png, media_type: 'image/png' }]);
  assert.match(entry.media_path, /^images\/01\/01234567-89ab-4def-8123-456789abcdef-54321\.png$/u);
  assert.equal(entry.local_path, undefined);
  assert.equal(existsSync(entry.finalPath), false);
  storage.commit([entry]);
  assert.equal(existsSync(entry.finalPath), true);
  storage.discard([entry]);
});

test('database and service store media paths and return path-only image snapshots', () => {
  const database = openCatalogDatabase();
  const root = mkdtempSync(join(tmpdir(), 'noobai-media-service-'));
  insertFixture(database);
  const storage = createMediaStorage({ mediaRoot: join(root, 'media') });
  const service = createMaintenanceService({ database, mediaStorage: storage });
  try {
    const uploaded = service.uploadImages('character', 2, [{ bytes: png, media_type: 'image/png' }]);
    const image = uploaded.images[0];
    assert.deepEqual(Object.keys(image).sort(), ['id', 'media_path', 'sort_order']);
    assert.match(image.media_path, /^images\/[0-9a-f]{2}\/[0-9a-f-]{36}-\d{5}\.png$/u);
    assert.deepEqual({ ...database.prepare('SELECT media_path, source_url FROM item_images WHERE id = ?').get(image.id) }, {
      media_path: image.media_path,
      source_url: null
    });
    assert.throws(() => database.prepare(`INSERT INTO item_images(owner_kind, owner_id, source_id, source_url, content_hash, media_path, sort_order, created_at, updated_at)
      VALUES ('character', 2, NULL, NULL, 'other-hash', ?, 99, ?, ?)` ).run(image.media_path, NOW, NOW), /UNIQUE/u);
    assert.throws(
      () => database.prepare('UPDATE item_images SET media_path = ? WHERE id = ?').run('images/01/changed.png', image.id),
      /immutable/u
    );
    assert.throws(
      () => database.prepare('INSERT INTO item_images(owner_kind, owner_id, source_id, source_url, content_hash, media_path, sort_order, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)')
        .run('character', 2, 'https://source.invalid/image.png', 'absolute-path', '/absolute.png', 100, NOW, NOW),
      /CHECK/u
    );

    const selected = service.setCover('character', 2, { id: image.id });
    assert.equal(selected.cover_media_path, image.media_path);
    assert.equal(selected.owner_kind, 'character');
    assert.equal(selected.owner_id, 2);
    assert.equal('kind' in selected, false);
    assert.equal('item_id' in selected, false);
    assert.equal(database.prepare('SELECT cover_media_path FROM characters WHERE id = 2').get().cover_media_path, image.media_path);
    assert.equal('cover_image_id' in selected, false);
    assert.equal('effective_cover_path' in selected, false);

    const repository = createCatalogRepository(database);
    const character = repository.getCharacter(2);
    assert.equal(character.cover_media_path, image.media_path);
    assert.equal('cover_image_id' in character, false);
    assert.equal(character.image_count, 1);
  } finally {
    database.close();
  }
});

test('media path uniqueness refuses a collision without replacing the existing file', () => {
  const root = mkdtempSync(join(tmpdir(), 'noobai-media-collision-'));
  const fixedId = '01234567-89ab-4def-8123-456789abcdef';
  const alternateId = '11234567-89ab-4def-8123-456789abcdef';
  let idCalls = 0;
  const storage = createMediaStorage({
    mediaRoot: join(root, 'media'),
    makeId: () => {
      idCalls += 1;
      return idCalls <= 2 ? fixedId : alternateId;
    },
    makeRandomDigits: () => '54321'
  });
  const [first] = storage.stageFiles([{ bytes: png, media_type: 'image/png' }]);
  storage.commit([first]);
  const [staged] = storage.stageFiles([{ bytes: png, media_type: 'image/png' }].map((file) => file));
  writeFileSync(staged.finalPath, Buffer.from('existing-file'));
  assert.throws(() => storage.commit([staged]), /existing media file/u);
  assert.deepEqual(readFileSync(staged.finalPath), Buffer.from('existing-file'));
  storage.discard([staged]);
  assert.deepEqual(readFileSync(first.finalPath), png);

  const collisionStorage = createMediaStorage({
    mediaRoot: join(root, 'collision-media'),
    makeId: () => fixedId,
    makeRandomDigits: () => '54321'
  });
  const [collision] = collisionStorage.stageFiles([{ bytes: png, media_type: 'image/png' }]);
  collisionStorage.commit([collision]);
  assert.throws(() => collisionStorage.stageFiles([{ bytes: png, media_type: 'image/png' }]), /unique media path/u);
});
