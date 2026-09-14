import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';

const timestamp = '2026-08-02T00:00:00Z';
const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);
const migrationDirectory = resolve(repositoryRoot, 'schema/database');

function insertBaseModel(database, id, name) {
  database.prepare(`INSERT INTO generation_base_models(id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)` ).run(id, name, timestamp, timestamp);
}

function insertModel(database, id, baseModelId, fileName) {
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (?, ?, ?, 'safetensors', 'fp16', 'model description', 'model usage', ?, ?)`)
    .run(id, baseModelId, fileName, timestamp, timestamp);
}

function insertWork(database, id, name) {
  database.prepare(`INSERT INTO works(
    id, name, name_normalized, aliases_json, is_available, created_at, updated_at
  ) VALUES (?, ?, ?, '[]', 1, ?, ?)` ).run(id, name, name.toLowerCase(), timestamp, timestamp);
}

function insertCharacter(database, id, workId, name) {
  database.prepare(`INSERT INTO characters(
    id, work_id, name, name_normalized, aliases_json, prompt_text,
    is_available, created_at, updated_at
  ) VALUES (?, ?, ?, ?, '[]', 'character prompt', 1, ?, ?)`)
    .run(id, workId, name, name.toLowerCase(), timestamp, timestamp);
}

function insertStyle(database, id, name, baseModelId = 1) {
  const columns = database.prepare('PRAGMA table_info(styles)').all().map(({ name: column }) => column);
  if (columns.includes('base_model_id')) {
    database.prepare(`INSERT INTO styles(
      id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
    ) VALUES (?, ?, ?, '[]', 'style prompt', NULL, NULL)`)
      .run(id, baseModelId, name);
    return;
  }
  database.prepare(`INSERT INTO styles(
    id, name, name_normalized, aliases_json, prompt_text,
    is_available, created_at, updated_at
  ) VALUES (?, ?, ?, '[]', 'style prompt', 1, ?, ?)`)
    .run(id, name, name.toLowerCase(), timestamp, timestamp);
}

function insertImage(database, id, ownerKind, ownerId, mediaPath, sortOrder = 0) {
  database.prepare(`INSERT INTO item_images(
    id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ownerKind, ownerId, `hash-${id}`, mediaPath, sortOrder, timestamp, timestamp);
}

function insertArtist(database, id, title, baseModelId = null) {
  database.prepare(`INSERT INTO artist_prompt_strings(
    id, title, description, artist_string, base_model_id, created_at, updated_at
  ) VALUES (?, ?, 'artist description', 'artist string', ?, ?, ?)`)
    .run(id, title, baseModelId, timestamp, timestamp);
}

function insertLora(database, id, baseModelId, modelId, fileName) {
  database.prepare(`INSERT INTO generation_loras(
    id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'safetensors', 'fp16', 'lora description', 'lora usage', ?, ?)`)
    .run(id, baseModelId, modelId, fileName, timestamp, timestamp);
}

function insertTemplate(database, id, baseModelId, modelId, loraId = null) {
  database.prepare(`INSERT INTO comfyui_templates(
    id, base_model_id, model_id, lora_id, template_type, title,
    template_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'text_to_image', ?, '{"nodes":[]}', ?, ?)`)
    .run(id, baseModelId, modelId, loraId, `Template ${id}`, timestamp, timestamp);
}

function insertInstance(database, id, url, credentialType = 'none', credentialCiphertext = null) {
  database.prepare(`INSERT INTO comfyui_instances(
    id, title, url, credential_type, credential_ciphertext,
    is_enabled, is_valid, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`)
    .run(id, `Instance ${id}`, url, credentialType, credentialCiphertext, timestamp, timestamp);
}

function seedResourceGraph(database, {
  baseModelId = 1,
  modelId = 1,
  loraId = 1,
  templateId = 1,
  artistId = 1,
  styleId = 1,
  imageOffset = 10
} = {}) {
  insertBaseModel(database, baseModelId, `Base ${baseModelId}`);
  insertModel(database, modelId, baseModelId, `model-${modelId}.safetensors`);
  insertLora(database, loraId, baseModelId, modelId, `lora-${loraId}.safetensors`);
  insertTemplate(database, templateId, baseModelId, modelId, loraId);
  insertArtist(database, artistId, `Artist ${artistId}`, baseModelId);
  insertStyle(database, styleId, `Style ${styleId}`, baseModelId);
  database.prepare('INSERT INTO artist_prompt_string_styles(artist_prompt_string_id, style_id) VALUES (?, ?)').run(artistId, styleId);
  insertImage(database, imageOffset, 'model', modelId, `model-${modelId}.png`);
  insertImage(database, imageOffset + 1, 'lora', loraId, `lora-${loraId}.png`);
  insertImage(database, imageOffset + 2, 'template', templateId, `template-${templateId}.png`);
  insertImage(database, imageOffset + 3, 'artist_prompt_string', artistId, `artist-${artistId}.png`);
  return {
    baseModelId,
    modelId,
    loraId,
    templateId,
    artistId,
    styleId,
    imageIds: [imageOffset, imageOffset + 1, imageOffset + 2, imageOffset + 3]
  };
}

function buildPersisted009Database(databasePath, mediaRoot) {
  const database = new DatabaseSync(databasePath);
  for (const name of [
    '001-initial.sql',
    '002-management-media.sql',
    '003-media-path-foundation.sql',
    '004-work-cover-character-fallback.sql'
  ]) database.exec(readFileSync(resolve(migrationDirectory, name), 'utf8'));
  insertWork(database, 1, 'Persisted Work');
  insertWork(database, 2, 'Other Work');
  insertCharacter(database, 1, 1, 'Persisted Character');
  insertCharacter(database, 2, 2, 'Other Character');
  insertStyle(database, 1, 'Persisted Style');
  insertStyle(database, 2, 'Other Style');
  database.prepare(`INSERT INTO item_images(
    id, owner_kind, owner_id, content_hash, local_path, media_path, sort_order, created_at, updated_at
  ) VALUES
    (101, 'work', 1, 'legacy-work-hash', 'images/work.png', 'images/work.png', 0, ?, ?),
    (102, 'character', 1, 'legacy-character-hash', 'images/character.png', 'images/character.png', 0, ?, ?),
    (103, 'style', 1, 'legacy-style-hash', 'images/style.png', 'images/style.png', 0, ?, ?),
    (104, 'work', 2, 'legacy-other-work-hash', 'images/other-work.png', 'images/other-work.png', 0, ?, ?),
    (105, 'character', 2, 'legacy-other-character-hash', 'images/other-character.png', 'images/other-character.png', 0, ?, ?),
    (106, 'style', 2, 'legacy-other-style-hash', 'images/other-style.png', 'images/other-style.png', 0, ?, ?)`)
    .run(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp, timestamp);
  database.prepare('UPDATE works SET cover_media_path = ? WHERE id = 1').run('images/work.png');
  database.prepare('UPDATE characters SET cover_media_path = ? WHERE id = 1').run('images/character.png');
  database.prepare('UPDATE styles SET cover_media_path = ? WHERE id = 1').run('images/style.png');
  database.close();

  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  writeFileSync(join(mediaRoot, 'images', 'work.png'), Buffer.from('work-image'));
  writeFileSync(join(mediaRoot, 'images', 'character.png'), Buffer.from('character-image'));
  writeFileSync(join(mediaRoot, 'images', 'style.png'), Buffer.from('style-image'));
  writeFileSync(join(mediaRoot, 'images', 'other-work.png'), Buffer.from('other-work-image'));
  writeFileSync(join(mediaRoot, 'images', 'other-character.png'), Buffer.from('other-character-image'));
  writeFileSync(join(mediaRoot, 'images', 'other-style.png'), Buffer.from('other-style-image'));
  runMediaCutover({
    databasePath,
    mediaRoot,
    repositoryRoot,
    makeId: () => '01234567-89ab-4def-8123-456789abcdef',
    makeRandomDigits: (() => {
      let next = 0;
      return () => String(next++).padStart(5, '0');
    })(),
    applyPostMigrations(database) {
      for (const name of [
        '006-media-cutover-skipped-cleanup.sql',
        '007-prompt-terms.sql',
        '008-generation-resources.sql',
        '009-vector-retrieval.sql'
      ]) database.exec(readFileSync(resolve(migrationDirectory, name), 'utf8'));
    }
  });
}

test('persisted 009 data upgrades through 010 without losing records and restores cover ownership', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-persisted-009-010-'));
  const databasePath = join(directory, 'catalog.sqlite');
  const mediaRoot = join(directory, 'media');
  const migration010 = readFileSync(resolve(migrationDirectory, '010-restore-media-cover-triggers.sql'), 'utf8');
  try {
    buildPersisted009Database(databasePath, mediaRoot);
    assert.equal(existsSync(databasePath), true);
    const database = new DatabaseSync(databasePath);
    try {
      const beforeObjects = database.prepare(`
        SELECT id, 'work' AS object_kind, name FROM works WHERE id IN (1, 2)
        UNION ALL SELECT id, 'character', name FROM characters WHERE id IN (1, 2)
        UNION ALL SELECT id, 'style', name FROM styles WHERE id IN (1, 2)
        ORDER BY object_kind, id
      `).all();
      const before = database.prepare('SELECT owner_kind, owner_id, media_path FROM item_images ORDER BY id').all();
      assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 9);
      assert.deepEqual(database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name IN (
          'works_cover_media_path_must_belong_before_update',
          'characters_cover_media_path_must_belong_before_update',
          'styles_cover_media_path_must_belong_before_update'
        )
      `).all(), []);

      database.exec(migration010);

      assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 10);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      assert.deepEqual(database.prepare(`
        SELECT id, 'work' AS object_kind, name FROM works WHERE id IN (1, 2)
        UNION ALL SELECT id, 'character', name FROM characters WHERE id IN (1, 2)
        UNION ALL SELECT id, 'style', name FROM styles WHERE id IN (1, 2)
        ORDER BY object_kind, id
      `).all(), beforeObjects);
      assert.deepEqual(database.prepare('SELECT owner_kind, owner_id, media_path FROM item_images ORDER BY id').all(), before);

      const imagePath = (ownerKind, ownerId) => before.find((row) => row.owner_kind === ownerKind && row.owner_id === ownerId).media_path;
      database.prepare('UPDATE works SET cover_media_path = ? WHERE id = 1').run(imagePath('work', 1));
      database.prepare('UPDATE works SET cover_media_path = ? WHERE id = 1').run(imagePath('character', 1));
      database.prepare('UPDATE works SET cover_media_path = NULL WHERE id = 1').run();
      assert.throws(
        () => database.prepare('UPDATE works SET cover_media_path = ? WHERE id = 1').run(imagePath('work', 2)),
        /work cover media path must belong to work or its character/
      );
      assert.throws(
        () => database.prepare('UPDATE works SET cover_media_path = ? WHERE id = 1').run(imagePath('style', 1)),
        /work cover media path must belong to work or its character/
      );

      database.prepare('UPDATE characters SET cover_media_path = ? WHERE id = 1').run(imagePath('character', 1));
      database.prepare('UPDATE characters SET cover_media_path = NULL WHERE id = 1').run();
      assert.throws(
        () => database.prepare('UPDATE characters SET cover_media_path = ? WHERE id = 1').run(imagePath('character', 2)),
        /character cover media path must belong to character/
      );
      assert.throws(
        () => database.prepare('UPDATE characters SET cover_media_path = ? WHERE id = 1').run(imagePath('work', 1)),
        /character cover media path must belong to character/
      );

      database.prepare('UPDATE styles SET cover_media_path = ? WHERE id = 1').run(imagePath('style', 1));
      database.prepare('UPDATE styles SET cover_media_path = NULL WHERE id = 1').run();
      assert.throws(
        () => database.prepare('UPDATE styles SET cover_media_path = ? WHERE id = 1').run(imagePath('style', 2)),
        /style cover media path must belong to style/
      );
      assert.throws(
        () => database.prepare('UPDATE styles SET cover_media_path = ? WHERE id = 1').run(imagePath('character', 1)),
        /style cover media path must belong to style/
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v0.2 six resource tables accept valid rows and enforce ComfyUI credential state transitions', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    seedResourceGraph(database);
    insertInstance(database, 1, 'http://comfy-none');
    insertInstance(database, 2, 'http://comfy-bearer', 'bearer', 'ciphertext');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_instances').get().count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates').get().count, 1);

    assert.throws(
      () => insertInstance(database, 3, 'http://comfy-invalid-none', 'none', 'unexpected-ciphertext'),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertInstance(database, 4, 'http://comfy-invalid-type', 'basic'),
      /CHECK constraint failed/
    );
    assert.throws(
      () => database.prepare(`INSERT INTO comfyui_instances(
        id, title, url, credential_type, is_enabled, is_valid, created_at, updated_at
      ) VALUES (5, 'Enabled Invalid', 'http://comfy-enabled-invalid', 'none', 1, 0, ?, ?)`)
        .run(timestamp, timestamp),
      /CHECK constraint failed/
    );

    database.prepare('UPDATE comfyui_instances SET is_valid = 1, is_enabled = 1 WHERE id = 2').run();
    assert.throws(
      () => database.prepare('UPDATE comfyui_instances SET url = ? WHERE id = 2').run('http://comfy-rejected-change'),
      /changed comfyui connection must be invalid and disabled/
    );
    database.prepare(`UPDATE comfyui_instances
      SET url = ?, credential_type = 'bearer', credential_ciphertext = ?, is_valid = 0, is_enabled = 0
      WHERE id = 2`).run('http://comfy-rotated', 'rotated-ciphertext');
    const rotatedInstance = database.prepare('SELECT url, credential_type, credential_ciphertext, is_enabled, is_valid FROM comfyui_instances WHERE id = 2').get();
    assert.equal(rotatedInstance.url, 'http://comfy-rotated');
    assert.equal(rotatedInstance.credential_type, 'bearer');
    assert.equal(rotatedInstance.credential_ciphertext, 'rotated-ciphertext');
    assert.equal(rotatedInstance.is_enabled, 0);
    assert.equal(rotatedInstance.is_valid, 0);

    const beforeResources = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM generation_base_models) AS base_models,
        (SELECT COUNT(*) FROM generation_models) AS models,
        (SELECT COUNT(*) FROM generation_loras) AS loras,
        (SELECT COUNT(*) FROM comfyui_templates) AS templates,
        (SELECT COUNT(*) FROM artist_prompt_strings) AS artists,
        (SELECT COUNT(*) FROM styles) AS styles,
        (SELECT COUNT(*) FROM artist_prompt_string_styles) AS relations,
        (SELECT COUNT(*) FROM item_images) AS images
    `).get();
    database.prepare('DELETE FROM comfyui_instances').run();
    assert.deepEqual(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM generation_base_models) AS base_models,
        (SELECT COUNT(*) FROM generation_models) AS models,
        (SELECT COUNT(*) FROM generation_loras) AS loras,
        (SELECT COUNT(*) FROM comfyui_templates) AS templates,
        (SELECT COUNT(*) FROM artist_prompt_strings) AS artists,
        (SELECT COUNT(*) FROM styles) AS styles,
        (SELECT COUNT(*) FROM artist_prompt_string_styles) AS relations,
        (SELECT COUNT(*) FROM item_images) AS images
    `).get(), beforeResources);
  } finally {
    database.close();
  }
});

test('v0.2 base and model deletion cascades remove descendants and media while retaining artists and bases', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    seedResourceGraph(database);
    seedResourceGraph(database, {
      baseModelId: 2,
      modelId: 2,
      loraId: 2,
      templateId: 2,
      artistId: 2,
      styleId: 2,
      imageOffset: 20
    });

    assert.throws(() => database.prepare('DELETE FROM generation_base_models WHERE id = 1').run(), /FOREIGN KEY constraint failed/u);
    database.prepare('DELETE FROM styles WHERE id = 1').run();
    database.prepare('DELETE FROM generation_base_models WHERE id = 1').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id IN (10, 11, 12)').get().count, 0);
    assert.equal(database.prepare('SELECT base_model_id FROM artist_prompt_strings WHERE id = 1').get().base_model_id, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = 13').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_string_styles WHERE artist_prompt_string_id = 1 AND style_id = 1').get().count, 0);

    database.prepare('DELETE FROM generation_models WHERE id = 2').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 2').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 2').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 2').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE id = 2').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id IN (20, 21, 22)').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings WHERE id = 2').get().count, 1);
  } finally {
    database.close();
  }
});

test('v0.2 LoRA, template, and artist deletion cascades clean media and relationships while retaining parents', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    seedResourceGraph(database);
    seedResourceGraph(database, {
      baseModelId: 2,
      modelId: 2,
      loraId: 2,
      templateId: 2,
      artistId: 2,
      styleId: 2,
      imageOffset: 20
    });

    database.prepare('DELETE FROM generation_loras WHERE id = 1').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 1').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 1').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id IN (11, 12)').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = 10').get().count, 1);

    database.prepare('DELETE FROM comfyui_templates WHERE id = 2').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 2').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 2').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 2').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE id = 2').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = 22').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = 21').get().count, 1);

    database.prepare('DELETE FROM artist_prompt_strings WHERE id = 1').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings WHERE id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_string_styles WHERE artist_prompt_string_id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = 13').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 1').get().count, 1);
  } finally {
    database.close();
  }
});

test('upgraded database restores and enforces the three v0.11 cover ownership triggers', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    const triggerNames = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'works_cover_media_path_must_belong_before_update',
        'characters_cover_media_path_must_belong_before_update',
        'styles_cover_media_path_must_belong_before_update'
      )
      ORDER BY name
    `).all().map(({ name }) => name);
    assert.deepEqual(triggerNames, [
      'characters_cover_media_path_must_belong_before_update',
      'styles_cover_media_path_must_belong_before_update',
      'works_cover_media_path_must_belong_before_update'
    ]);

    insertWork(database, 1, 'Work One');
    insertWork(database, 2, 'Work Two');
    insertCharacter(database, 1, 1, 'Character One');
    insertBaseModel(database, 1, 'Base One');
    insertStyle(database, 1, 'Style One');
    insertImage(database, 1, 'work', 1, 'work-one.png');
    insertImage(database, 2, 'character', 1, 'character-one.png');
    insertImage(database, 3, 'style', 1, 'style-one.png');

    database.prepare('UPDATE works SET cover_media_path = ? WHERE id = 1').run('work-one.png');
    database.prepare('UPDATE works SET cover_media_path = ? WHERE id = 1').run('character-one.png');
    assert.throws(
      () => database.prepare('UPDATE works SET cover_media_path = ? WHERE id = 1').run('style-one.png'),
      /work cover media path must belong to work or its character/
    );
    database.prepare('UPDATE characters SET cover_media_path = ? WHERE id = 1').run('character-one.png');
    assert.throws(
      () => database.prepare('UPDATE characters SET cover_media_path = ? WHERE id = 1').run('style-one.png'),
      /character cover media path must belong to character/
    );
    database.prepare('UPDATE styles SET cover_media_path = ? WHERE id = 1').run('style-one.png');
    assert.throws(
      () => database.prepare('UPDATE styles SET cover_media_path = ? WHERE id = 1').run('work-one.png'),
      /style cover media path must belong to style/
    );
  } finally {
    database.close();
  }
});

test('v0.2 resources retain one-base-many-artist strings and relation delete behavior', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    insertBaseModel(database, 1, 'Base One');
    insertBaseModel(database, 2, 'Base Two');
    database.prepare(`INSERT INTO artist_prompt_strings(
      id, title, description, artist_string, base_model_id, created_at, updated_at
    ) VALUES (1, 'Artist One', 'description', 'artist one', 1, ?, ?),
             (2, 'Artist Two', 'description', 'artist two', 1, ?, ?)`)
      .run(timestamp, timestamp, timestamp, timestamp);
    insertStyle(database, 1, 'Style One');
    database.prepare('INSERT INTO artist_prompt_string_styles(artist_prompt_string_id, style_id) VALUES (1, 1), (2, 1)').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings WHERE base_model_id = 1').get().count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_string_styles WHERE style_id = 1').get().count, 2);

    database.prepare('DELETE FROM styles WHERE id = 1').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_string_styles').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, 2);
    database.prepare('DELETE FROM generation_base_models WHERE id = 1').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings WHERE base_model_id IS NULL').get().count, 2);
  } finally {
    database.close();
  }
});

test('v0.2 resources reject cross-ecosystem LoRA/templates and enforce one template image cover', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    insertBaseModel(database, 1, 'Base One');
    insertBaseModel(database, 2, 'Base Two');
    insertModel(database, 1, 1, 'model-one.safetensors');
    insertModel(database, 2, 2, 'model-two.safetensors');
    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (1, 1, 1, 'lora-one.safetensors', 'safetensors', 'fp16', 'lora description', 'lora usage', ?, ?)`)
      .run(timestamp, timestamp);
    assert.throws(
      () => database.prepare(`INSERT INTO generation_loras(
        id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
        description, usage, created_at, updated_at
      ) VALUES (2, 2, 1, 'lora-cross.safetensors', 'safetensors', 'fp16', 'lora description', 'lora usage', ?, ?)`)
        .run(timestamp, timestamp),
      /generation_lora model must belong to base model/
    );
    database.prepare(`INSERT INTO comfyui_templates(
      id, base_model_id, model_id, lora_id, template_type, title,
      template_json, created_at, updated_at
    ) VALUES (1, 1, 1, 1, 'text_to_image_lora', 'Template One', '{"nodes":[]}', ?, ?)`)
      .run(timestamp, timestamp);
    assert.throws(
      () => database.prepare(`INSERT INTO comfyui_templates(
        id, base_model_id, model_id, template_type, title, template_json, created_at, updated_at
      ) VALUES (2, 1, 2, 'text_to_image', 'Template Cross', '{"nodes":[]}', ?, ?)`)
        .run(timestamp, timestamp),
      /comfyui template references must belong to one model ecosystem/
    );
    insertImage(database, 1, 'template', 1, 'template-one.png');
    assert.throws(
      () => insertImage(database, 2, 'template', 1, 'template-two.png'),
      /UNIQUE constraint failed: item_images.owner_kind, item_images.owner_id/
    );
    database.prepare('UPDATE comfyui_templates SET cover_media_path = ? WHERE id = 1').run('template-one.png');
    assert.throws(
      () => database.prepare('DELETE FROM item_images WHERE id = 1').run(),
      /clear template cover before deleting its image/
    );
    database.prepare('UPDATE comfyui_templates SET cover_media_path = NULL WHERE id = 1').run();
    database.prepare('DELETE FROM item_images WHERE id = 1').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = \'template\'').get().count, 0);
  } finally {
    database.close();
  }
});
