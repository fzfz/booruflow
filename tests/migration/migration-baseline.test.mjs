import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  listOrderedMigrations
} from '../../app/database/migration-baseline.mjs';
import { OfflineMediaCutoverRequiredError, openCatalogDatabase } from '../../app/catalog/database.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const migrationDirectory = resolve(repositoryRoot, 'schema/database');

function historicalRepositoryRoot(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'noobai-migration-baseline-'));
  const target = resolve(root, 'schema/database');
  mkdirSync(target, { recursive: true });
  for (const migration of listOrderedMigrations(migrationDirectory).filter(({ version }) => version <= 35)) {
    cpSync(migration.path, resolve(target, migration.path.split('/').at(-1)));
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('migration filenames are ordered and duplicate versions fail loudly', () => {
  const migrations = listOrderedMigrations(migrationDirectory);
  assert.deepEqual(migrations.slice(0, 9).map((migration) => migration.name), ['001-initial', '002-management-media', '003-media-path-foundation', '004-work-cover-character-fallback', '005-media-cutover', '006-media-cutover-skipped-cleanup', '007-prompt-terms', '008-generation-resources', '009-vector-retrieval']);
  assert.equal(migrations.at(-1)?.version, 40, 'migration discovery must continue through data import batches');
  assert.throws(
    () => listOrderedMigrations(resolve(repositoryRoot, 'tests/fixtures/step-05/migrations')),
    /duplicate migration version/
  );
});

test('migration 035 database with the built-in catalog has a contiguous unique ledger and no foreign-key violations', (t) => {
  const database = openCatalogDatabase({ repositoryRoot: historicalRepositoryRoot(t), includeBuiltinComfyuiCatalog: true });
  try {
    const ledger = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    assert.deepEqual(ledger.map(({ version }) => version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
    assert.equal(new Set(ledger.map(({ version }) => version)).size, ledger.length);
    assert.equal(ledger.at(-1).name, '035-iterative-image-task-round-error-details');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'session_work_selections'").get().count, 0);
    assert.equal(database.prepare('PRAGMA table_info(iterative_image_task_rounds)').all().at(-1).name, 'error_details_json');
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('test fixtures may apply the full schema ledger without importing the built-in ComfyUI catalog', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 40);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'data_import_batches'").get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates').get().count, 0);
    const templateColumns = database.prepare('PRAGMA table_info(comfyui_templates)').all().map(({ name }) => name);
    assert.equal(templateColumns.includes('revision_number'), false);
    assert.equal(templateColumns.includes('workflow_sha256'), false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN ('comfyui_template_revisions', 'comfyui_template_runtime_configs', 'comfyui_runs')").get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models').get().count, 0);
    assert.deepEqual(database.prepare('SELECT version, name FROM schema_migrations WHERE version IN (18, 19, 20, 21, 22, 23, 24, 25, 26) ORDER BY version').all().map((row) => ({ ...row })), [
      { version: 18, name: '018-comfyui-template-builtin-catalog' },
      { version: 19, name: '019-comfyui-template-runtime-corrections' },
      { version: 20, name: '020-comfyui-template-output-node-repairs' },
      { version: 21, name: '021-comfyui-template-active-path-repairs' },
      { version: 22, name: '022-comfyui-runs' },
      { version: 23, name: '023-krea2-lora-catalog' },
      { version: 24, name: '024-generation-lora-trigger-weight' },
      { version: 25, name: '025-remove-session-selections' },
      { version: 26, name: '026-session-types' }
    ]);
  } finally {
    database.close();
  }
  assert.throws(() => openCatalogDatabase({ includeBuiltinComfyuiCatalog: 'false' }), /includeBuiltinComfyuiCatalog must be a boolean/u);
});

test('已有旧图片记录的数据库必须先执行停机媒体迁移', () => {
  const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'noobai-management-media-'));
    const databasePath = resolve(temporaryDirectory, 'legacy.sqlite');
    const initialSql = readFileSync(resolve(migrationDirectory, '001-initial.sql'), 'utf8');
    const managementSql = readFileSync(resolve(migrationDirectory, '002-management-media.sql'), 'utf8');
  const timestamp = '2026-07-29T00:00:00Z';
  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(initialSql);
    legacy.exec(managementSql);
    legacy.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
      VALUES (1, 'Work', 'work', '[]', 1, ?, ?)` ).run(timestamp, timestamp);
    legacy.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
      VALUES (2, 1, 'Character', 'character', '[]', 'ink', 1, ?, ?)` ).run(timestamp, timestamp);
    legacy.prepare(`INSERT INTO item_images(id, owner_kind, owner_id, content_hash, local_path, sort_order, created_at, updated_at)
      VALUES (9, 'character', 2, 'hash', 'images/legacy.png', 4, ?, ?)` ).run(timestamp, timestamp);
    legacy.prepare('UPDATE characters SET cover_image_id = 9 WHERE id = 2').run();
    legacy.close();

    assert.throws(() => openCatalogDatabase({ databasePath }), OfflineMediaCutoverRequiredError);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
