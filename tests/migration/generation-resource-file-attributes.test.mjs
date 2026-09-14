import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const MIGRATIONS = resolve(ROOT, 'schema/database');
const NOW = '2026-08-31T00:00:00.000Z';

function version38Root(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'noobai-file-attributes-v38-'));
  const target = resolve(root, 'schema/database');
  mkdirSync(target, { recursive: true });
  for (const migration of listOrderedMigrations(MIGRATIONS).filter(({ version }) => version <= 38)) {
    cpSync(migration.path, resolve(target, migration.path.split('/').at(-1)));
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function schemaSql(database, type, name) {
  return database.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get(type, name)?.sql ?? '';
}

test('migration 039 preserves model and LoRA records, relations and indexes while allowing custom file attributes', (t) => {
  const database = openCatalogDatabase({ repositoryRoot: version38Root(t), includeBuiltinComfyuiCatalog: false });
  try {
    database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('anima', NOW, NOW);
    database.prepare(`INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, published_at, description, usage, skill_name, cover_media_path, created_at, updated_at
    ) VALUES (2, 1, 'before.safetensors', 'safetensors', 'fp16', 'A', 'v1', 'https://example.test/model', '2026-08-31', 'model description', 'model usage', 'skill', NULL, ?, ?)`).run(NOW, NOW);
    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, description, usage, trigger_words_json, weight, cover_media_path, created_at, updated_at
    ) VALUES (3, 1, 2, 'before-lora.safetensors', 'safetensors', 'fp16', 'B', 'v2', 'https://example.test/lora', 'lora description', 'lora usage', '["tag"]', 0.75, NULL, ?, ?)`).run(NOW, NOW);

    database.exec(readFileSync(resolve(MIGRATIONS, '039-generation-resource-file-attributes.sql'), 'utf8'));

    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 39);
    assert.deepEqual(database.prepare('SELECT version, name FROM schema_migrations WHERE version = 39').all().map((row) => ({ ...row })), [
      { version: 39, name: '039-generation-resource-file-attributes' }
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 2').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 3 AND model_id = 2').get().count, 1);
    assert.match(schemaSql(database, 'table', 'generation_models'), /file_format = trim\(file_format\)[\s\S]*length\(file_format\) > 0/u);
    assert.match(schemaSql(database, 'table', 'generation_loras'), /length\(precision_or_quantization\) <= 64/u);
    assert.doesNotMatch(schemaSql(database, 'table', 'generation_models'), /file_format IN/u);
    assert.doesNotMatch(schemaSql(database, 'table', 'generation_loras'), /precision_or_quantization IN/u);
    for (const index of ['generation_models_identity_uq', 'generation_models_base_model_id_idx', 'generation_loras_identity_uq', 'generation_loras_base_model_id_idx', 'generation_loras_model_id_idx']) {
      assert.notEqual(schemaSql(database, 'index', index), '', index);
    }

    database.prepare(`INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at
    ) VALUES (4, 1, 'custom.model', 'custom-container', 'custom-q6', 'custom model', 'custom usage', ?, ?)`).run(NOW, NOW);
    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (5, 1, 4, 'custom.lora', 'custom-container', 'custom-q6', 'custom lora', 'custom usage', '[]', 1, ?, ?)`).run(NOW, NOW);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('migration 039 file attribute checks reject empty, whitespace, control characters and values longer than 64 characters', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 40);
    database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('anima', NOW, NOW);
    const insert = database.prepare(`INSERT INTO generation_models(
      base_model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at
    ) VALUES (1, 'invalid.model', ?, ?, 'description', 'usage', ?, ?)`);
    for (const [format, precision] of [['', 'fp16'], [' ', 'fp16'], ['bad\nformat', 'fp16'], ['x'.repeat(65), 'fp16'], ['safe', ''], ['safe', ' '], ['safe', 'bad\u0000precision'], ['safe', 'q'.repeat(65)]]) {
      assert.throws(() => insert.run(format, precision, NOW, NOW), /constraint failed/u, `${JSON.stringify(format)} ${JSON.stringify(precision)}`);
    }
  } finally {
    database.close();
  }
});
