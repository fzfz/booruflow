import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const MIGRATION_DIRECTORY = resolve(REPOSITORY_ROOT, 'schema/database');
const RETIRED_TABLES = Object.freeze([
  'comfyui_template_asset_references',
  'comfyui_template_validation_reports',
  'comfyui_template_runtime_configs',
  'comfyui_template_current_revisions',
  'comfyui_template_sources',
  'comfyui_template_revisions',
  'comfyui_model_assets',
  'comfyui_run_outputs',
  'comfyui_runs'
]);

function tableExists(database, tableName) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function version37RepositoryRoot(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'noobai-before-template-removal-'));
  const target = resolve(root, 'schema/database');
  mkdirSync(target, { recursive: true });
  for (const migration of listOrderedMigrations(MIGRATION_DIRECTORY).filter(({ version }) => version <= 37)) {
    cpSync(migration.path, resolve(target, migration.path.split('/').at(-1)));
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function insertTemplateWithRevision(database, { templateJson, revisionJson, linkCurrentRevision = true }) {
  const timestamp = '2026-08-30T00:00:00.000Z';
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(3801, 'migration-038-base', timestamp, timestamp);
  database.prepare(`INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(3802, 3801, 'migration-038.safetensors', 'safetensors', 'fp16', 'migration 038', 'migration 038', timestamp, timestamp);
  database.prepare(`INSERT INTO comfyui_templates(
      id, base_model_id, model_id, lora_id, template_type, title, template_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(3803, 3801, 3802, null, 'text_to_image', 'migration 038 template', JSON.stringify(templateJson), timestamp, timestamp);
  database.prepare(`INSERT INTO comfyui_template_revisions(
      id, template_id, revision_number, parent_revision_id, workflow_json, workflow_sha256,
      change_kind, repair_operations_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(3804, 3803, 6, null, JSON.stringify({ ...revisionJson, historical: true }), 'b'.repeat(64), 'manual_update', '[]', timestamp);
  database.prepare(`INSERT INTO comfyui_template_revisions(
      id, template_id, revision_number, parent_revision_id, workflow_json, workflow_sha256,
      change_kind, repair_operations_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(3805, 3803, 7, 3804, JSON.stringify(revisionJson), 'a'.repeat(64), 'manual_update', '[]', timestamp);
  if (linkCurrentRevision) {
    database.prepare('INSERT INTO comfyui_template_current_revisions(template_id, revision_id) VALUES (?, ?)')
      .run(3803, 3805);
  }
}

test('migration 038 preserves the template Workflow and removes retired ComfyUI management storage', (t) => {
  const database = openCatalogDatabase({
    repositoryRoot: version37RepositoryRoot(t),
    includeBuiltinComfyuiCatalog: false
  });
  try {
    const workflow = { version: 0.4, nodes: [], links: [], extra: { source: 'same' } };
    insertTemplateWithRevision(database, { templateJson: workflow, revisionJson: workflow });
    const migration = readFileSync(resolve(MIGRATION_DIRECTORY, '038-remove-comfyui-template-management.sql'), 'utf8');
    database.exec(migration);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 38);
    assert.deepEqual(
      database.prepare('SELECT version, name FROM schema_migrations WHERE version = 38').all().map((row) => ({ ...row })),
      [{ version: 38, name: '038-remove-comfyui-template-management' }]
    );
    assert.deepEqual(JSON.parse(database.prepare('SELECT template_json FROM comfyui_templates WHERE id = 3803').get().template_json), workflow);
    const templateColumns = database.prepare('PRAGMA table_info(comfyui_templates)').all().map(({ name }) => name);
    assert.equal(templateColumns.includes('revision_number'), false);
    assert.equal(templateColumns.includes('workflow_sha256'), false);
    for (const tableName of RETIRED_TABLES) assert.equal(tableExists(database, tableName), false, tableName);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('migration 038 writes the selected current revision Workflow into the template core before removing revisions', (t) => {
  const database = openCatalogDatabase({
    repositoryRoot: version37RepositoryRoot(t),
    includeBuiltinComfyuiCatalog: false
  });
  try {
    const templateJson = { version: 0.4, nodes: [], links: [], extra: { source: 'template' } };
    const currentRevisionJson = { version: 0.4, nodes: [], links: [], extra: { source: 'current-revision' } };
    insertTemplateWithRevision(database, {
      templateJson,
      revisionJson: currentRevisionJson
    });
    const migration = readFileSync(resolve(MIGRATION_DIRECTORY, '038-remove-comfyui-template-management.sql'), 'utf8');
    database.exec(migration);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 38);
    assert.deepEqual(
      JSON.parse(database.prepare('SELECT template_json FROM comfyui_templates WHERE id = 3803').get().template_json),
      currentRevisionJson
    );
    for (const tableName of RETIRED_TABLES) assert.equal(tableExists(database, tableName), false, tableName);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('migration 038 preserves the template core Workflow when no current revision relation exists', (t) => {
  const database = openCatalogDatabase({
    repositoryRoot: version37RepositoryRoot(t),
    includeBuiltinComfyuiCatalog: false
  });
  try {
    const templateJson = { version: 0.4, nodes: [], links: [], extra: { source: 'template' } };
    insertTemplateWithRevision(database, {
      templateJson,
      revisionJson: { version: 0.4, nodes: [], links: [], extra: { source: 'unselected-revision' } },
      linkCurrentRevision: false
    });
    const migration = readFileSync(resolve(MIGRATION_DIRECTORY, '038-remove-comfyui-template-management.sql'), 'utf8');
    database.exec(migration);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 38);
    assert.deepEqual(
      JSON.parse(database.prepare('SELECT template_json FROM comfyui_templates WHERE id = 3803').get().template_json),
      templateJson
    );
    for (const tableName of RETIRED_TABLES) assert.equal(tableExists(database, tableName), false, tableName);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('ordinary startup skips registered 036 and 037 before applying the remaining migrations', (t) => {
  const runtimeRoot = mkdtempSync(resolve(tmpdir(), 'noobai-template-removal-startup-'));
  const databasePath = resolve(runtimeRoot, 'app.sqlite');
  const mediaRoot = resolve(runtimeRoot, 'media');
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));

  const database = openCatalogDatabase({
    mediaRoot,
    repositoryRoot: version37RepositoryRoot(t),
    includeBuiltinComfyuiCatalog: false
  });
  const templateJson = { version: 0.4, nodes: [], links: [], extra: { source: 'template' } };
  const currentRevisionJson = { version: 0.4, nodes: [], links: [], extra: { source: 'current-revision' } };
  insertTemplateWithRevision(database, { templateJson, revisionJson: currentRevisionJson });
  database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(3806, 3801, 3802, 'post-037-lora.safetensors', 'safetensors', 'fp16', 'post 037 LoRA', 'post 037 LoRA', '[]', 1, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
  database.exec(`VACUUM INTO '${databasePath.replaceAll("'", "''")}'`);
  database.close();

  const migrated = openCatalogDatabase({
    databasePath,
    mediaRoot,
    repositoryRoot: REPOSITORY_ROOT,
    includeBuiltinComfyuiCatalog: false
  });
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 40);
    assert.deepEqual(
      JSON.parse(migrated.prepare('SELECT template_json FROM comfyui_templates WHERE id = 3803').get().template_json),
      currentRevisionJson
    );
    assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 3806').get().count, 1);
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = 3806").get().count, 0);
    for (const tableName of RETIRED_TABLES) assert.equal(tableExists(migrated, tableName), false, tableName);
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    migrated.close();
  }
});
