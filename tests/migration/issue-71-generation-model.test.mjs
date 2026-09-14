import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { runMediaCutover } from '../../app/database/media-cutover.mjs';

const root = resolve(import.meta.dirname, '../..');
const migrations = resolve(root, 'schema/database');
const NOW = '2026-08-02T00:00:00Z';

function openV02MigrationDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-issue-71-migrations-'));
  const databasePath = join(directory, 'catalog.sqlite');
  const mediaRoot = join(directory, 'media');
  const bootstrap = new DatabaseSync(databasePath);
  try {
    for (const name of [
      '001-initial.sql',
      '002-management-media.sql',
      '003-media-path-foundation.sql',
      '004-work-cover-character-fallback.sql'
    ]) bootstrap.exec(readFileSync(resolve(migrations, name), 'utf8'));
  } finally {
    bootstrap.close();
  }
  runMediaCutover({
    databasePath,
    mediaRoot,
    repositoryRoot: root,
    applyPostMigrations(database) {
      for (const name of [
        '006-media-cutover-skipped-cleanup.sql',
        '007-prompt-terms.sql',
        '008-generation-resources.sql'
      ]) database.exec(readFileSync(resolve(migrations, name), 'utf8'));
    }
  });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  return {
    database,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function insertBaseModel(database, id, name) {
  database.prepare(`INSERT INTO generation_base_models(id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(id, name, NOW, NOW);
}

function insertModel(database, id, baseModelId, fileName, version = null) {
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    author, version, release_url, published_at, description, usage, skill_name,
    created_at, updated_at
  ) VALUES (?, ?, ?, 'safetensors', 'fp16', 'Author', ?, 'https://example.test/model', '2026-08-01', 'model description', 'model usage', 'wai-sdxl-prompt-builder', ?, ?)`).run(
    id, baseModelId, fileName, version, NOW, NOW
  );
}

function insertLora(database, id, baseModelId, modelId) {
  database.prepare(`INSERT INTO generation_loras(
    id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'safetensors', 'fp16', 'lora description', 'lora usage', ?, ?)`).run(
    id, baseModelId, modelId, `lora-${id}.safetensors`, NOW, NOW
  );
}

function insertTemplate(database, id, baseModelId, modelId, loraId = null) {
  database.prepare(`INSERT INTO comfyui_templates(
    id, base_model_id, model_id, lora_id, template_type, title, template_json,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'text_to_image', ?, '{}', ?, ?)`).run(
    id, baseModelId, modelId, loraId, `Template ${id}`, NOW, NOW
  );
}

function insertImage(database, id, ownerKind, ownerId, mediaPath) {
  database.prepare(`INSERT INTO item_images(
    id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(id, ownerKind, ownerId, `hash-${id}`, mediaPath, NOW, NOW);
}

test('008 generation-resources migration creates model constraints and leaves no foreign-key violations', () => {
  const migrationDatabase = openV02MigrationDatabase();
  const { database } = migrationDatabase;
  try {
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 8);
    assert.deepEqual(database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all().map(({ version, name }) => ({ version, name })), [
      { version: 1, name: '001-initial' },
      { version: 2, name: '002-management-media' },
      { version: 3, name: '003-media-path-foundation' },
      { version: 4, name: '004-work-cover-character-fallback' },
      { version: 5, name: '005-media-cutover' },
      { version: 6, name: '006-media-cutover-skipped-cleanup' },
      { version: 7, name: '007-prompt-terms' },
      { version: 8, name: '008-generation-resources' }
    ]);
    assert.deepEqual(database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN ('generation_models_identity_uq', 'generation_models_base_model_id_idx')
      ORDER BY name`).all().map(({ name }) => name), [
      'generation_models_base_model_id_idx',
      'generation_models_identity_uq'
    ]);
    assert.ok(database.prepare("SELECT 1 FROM schema_migrations WHERE version = 8 AND name = '008-generation-resources'").get());

    insertBaseModel(database, 1, 'WAI');
    insertBaseModel(database, 2, 'Anima');
    insertModel(database, 1, 1, 'shared-name.safetensors', null);
    insertModel(database, 2, 2, 'shared-name.safetensors', null);
    assert.throws(() => insertModel(database, 3, 1, 'shared-name.safetensors', null), /UNIQUE constraint failed/u);
    insertModel(database, 4, 1, 'shared-name.safetensors', 'v2');
    assert.throws(() => insertModel(database, 5, 1, 'shared-name.safetensors', 'v2'), /UNIQUE constraint failed/u);
  } finally {
    migrationDatabase.close();
  }
});

test('generation model migration enforces base-model association across LoRA and template references', () => {
  const migrationDatabase = openV02MigrationDatabase();
  const { database } = migrationDatabase;
  try {
    insertBaseModel(database, 1, 'WAI');
    insertBaseModel(database, 2, 'Anima');
    insertModel(database, 10, 1, 'wai.safetensors');
    insertLora(database, 20, 1, 10);
    insertTemplate(database, 30, 1, 10, 20);

    assert.throws(() => insertLora(database, 21, 2, 10), /generation_lora model must belong to base model/u);
    assert.throws(() => insertTemplate(database, 31, 2, 10, null), /comfyui template references must belong to one model ecosystem/u);
    assert.throws(() => insertTemplate(database, 32, 1, 10, 999), /comfyui template references must belong to one model ecosystem/u);
  } finally {
    migrationDatabase.close();
  }
});

test('generation model migration rejects an orphan base_model_id through the foreign key', () => {
  const migrationDatabase = openV02MigrationDatabase();
  const { database } = migrationDatabase;
  try {
    assert.throws(() => insertModel(database, 10, 999, 'orphan.safetensors'), /FOREIGN KEY constraint failed/u);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models').get().count, 0);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    migrationDatabase.close();
  }
});

test('deleting a base model cascades its generation models and their resource graph', () => {
  const migrationDatabase = openV02MigrationDatabase();
  const { database } = migrationDatabase;
  try {
    insertBaseModel(database, 1, 'WAI');
    insertModel(database, 10, 1, 'wai.safetensors');
    insertLora(database, 20, 1, 10);
    insertTemplate(database, 30, 1, 10, 20);
    insertImage(database, 100, 'model', 10, 'images/model.png');
    insertImage(database, 101, 'lora', 20, 'images/lora.png');
    insertImage(database, 102, 'template', 30, 'images/template.png');

    database.prepare('DELETE FROM generation_base_models WHERE id = 1').run();

    for (const table of ['generation_base_models', 'generation_models', 'generation_loras', 'comfyui_templates', 'item_images']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} must cascade with the base model`);
    }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    migrationDatabase.close();
  }
});

test('model resource images enforce ownership, immutable media paths, and cover-media lifecycle rules', () => {
  const migrationDatabase = openV02MigrationDatabase();
  const { database } = migrationDatabase;
  try {
    insertBaseModel(database, 1, 'WAI');
    insertModel(database, 10, 1, 'wai.safetensors');

    assert.throws(() => insertImage(database, 100, 'model', 999, 'images/orphan.png'), /item_images owner model does not exist/u);
    assert.throws(() => insertImage(database, 101, 'model', 10, '../outside.png'), /CHECK constraint failed/u);

    insertImage(database, 102, 'model', 10, 'images/model.png');
    database.prepare('UPDATE generation_models SET cover_media_path = ? WHERE id = 10').run('images/model.png');
    assert.throws(() => database.prepare('UPDATE generation_models SET cover_media_path = ? WHERE id = 10').run('images/missing.png'), /model cover media path must belong to model/u);
    assert.throws(() => database.prepare('UPDATE item_images SET media_path = ? WHERE id = 102').run('images/renamed.png'), /item_images media_path is immutable/u);
    assert.throws(() => database.prepare('DELETE FROM item_images WHERE id = 102').run(), /clear model cover before deleting its image/u);

    database.prepare('UPDATE generation_models SET cover_media_path = NULL WHERE id = 10').run();
    database.prepare('DELETE FROM item_images WHERE id = 102').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = 102').get().count, 0);
  } finally {
    migrationDatabase.close();
  }
});

test('deleting a generation model cascades its LoRA, templates, and resource images while retaining its base model', () => {
  const migrationDatabase = openV02MigrationDatabase();
  const { database } = migrationDatabase;
  try {
    insertBaseModel(database, 1, 'WAI');
    insertModel(database, 10, 1, 'wai.safetensors');
    insertLora(database, 20, 1, 10);
    insertTemplate(database, 30, 1, 10, 20);
    insertImage(database, 100, 'model', 10, 'images/model.png');
    insertImage(database, 101, 'lora', 20, 'images/lora.png');
    insertImage(database, 102, 'template', 30, 'images/template.png');

    database.prepare('DELETE FROM generation_models WHERE id = 10').run();

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 1').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 10').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 20').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE id = 30').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id IN (100, 101, 102)').get().count, 0);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    migrationDatabase.close();
  }
});
