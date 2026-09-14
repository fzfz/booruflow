import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);
const migrationDirectory = resolve(repositoryRoot, 'schema/database');
const timestamp = '2026-08-04T00:00:00Z';

function makeLegacyRepositoryRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'noobai-issue-172-migration-'));
  const target = resolve(root, 'schema/database');
  mkdirSync(target, { recursive: true });
  for (let version = 1; version <= 11; version += 1) {
    const name = `${String(version).padStart(3, '0')}-${[
      'initial', 'management-media', 'media-path-foundation', 'work-cover-character-fallback',
      'media-cutover', 'media-cutover-skipped-cleanup', 'prompt-terms', 'generation-resources',
      'vector-retrieval', 'restore-media-cover-triggers', 'style-description'
    ][version - 1]}.sql`;
    copyFileSync(resolve(migrationDirectory, name), resolve(target, name));
  }
  return root;
}

function addGenerationBaseModel(database, id, name) {
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, timestamp, timestamp);
}

function addGenerationModel(database, { id, baseModelId, skillName }) {
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    description, usage, skill_name, created_at, updated_at
  ) VALUES (?, ?, ?, 'safetensors', 'fp16', 'description', 'usage', ?, ?, ?)`).run(
    id, baseModelId, `model-${id}.safetensors`, skillName, timestamp, timestamp
  );
}

function addSession(database, id = 1) {
  database.prepare(`INSERT INTO sessions(
    id, title, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
    pi_session_file, committed_leaf_id, created_at, updated_at
  ) VALUES (?, 'Fixture', 'active', 3, 0, 'instance', 'session', 'sessions/fixture.jsonl', NULL, ?, ?)`).run(id, timestamp, timestamp);
}

function addCurrentSession(database, baseModelId) {
  database.prepare(`INSERT INTO sessions(
    id, title, session_type, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
    pi_session_file, committed_leaf_id, base_model_id, created_at, updated_at
  ) VALUES (1, 'Fixture', 'homepage_chat', 'active', 3, 0, 'instance', 'session', 'sessions/current.jsonl', NULL, ?, ?, ?)`).run(baseModelId, timestamp, timestamp);
}

function executeSessionMigration(database) {
  database.exec(readFileSync(resolve(migrationDirectory, '012-session-base-model.sql'), 'utf8'));
}

test('Issue #172 migration creates the session base-model relation on an empty database', () => {
  const database = openCatalogDatabase();
  try {
    const columns = database.prepare('PRAGMA table_info(sessions)').all();
    const baseModelColumn = columns.find((column) => column.name === 'base_model_id');
    assert.equal(baseModelColumn.notnull, 1);
    assert.equal(baseModelColumn.type, 'INTEGER');
    assert.deepEqual(database.prepare('PRAGMA foreign_key_list(sessions)').all().filter((row) => row.from === 'homepage_base_model_id').map((row) => ({ table: row.table, to: row.to, on_delete: row.on_delete })), [
      { table: 'generation_base_models', to: 'id', on_delete: 'RESTRICT' }
    ]);
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_base_model_id_idx'").all().map(({ name }) => name), ['sessions_base_model_id_idx']);
  } finally {
    database.close();
  }
});

test('Issue #172 current sessions reject NULL and unknown base-model foreign keys', () => {
  const database = openCatalogDatabase();
  try {
    assert.throws(() => addCurrentSession(database, null), /NOT NULL constraint failed/u);
    assert.throws(() => addCurrentSession(database, 999), /FOREIGN KEY constraint failed/u);
  } finally {
    database.close();
  }
});

test('Issue #172 prevents deleting a base model referenced by a current session', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    addGenerationBaseModel(database, 1, 'Fixture Base');
    addCurrentSession(database, 1);
    assert.throws(() => database.prepare('DELETE FROM generation_base_models WHERE id = 1').run(), /FOREIGN KEY constraint failed/u);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 1').get().count, 1);
  } finally {
    database.close();
  }
});

test('Issue #172 migration backfills every existing session from one trimmed WAI mapping', () => {
  const legacyRoot = makeLegacyRepositoryRoot();
  try {
    const database = openCatalogDatabase({ repositoryRoot: legacyRoot });
    addGenerationBaseModel(database, 7, 'WAI');
    addGenerationModel(database, { id: 70, baseModelId: 7, skillName: '  wai-sdxl-prompt-builder  ' });
    addSession(database, 1);
    executeSessionMigration(database);
    assert.equal(database.prepare('SELECT base_model_id FROM sessions WHERE id = 1').get().base_model_id, 7);
    database.close();
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});

test('Issue #172 migration rejects existing sessions when no WAI mapping exists and leaves the legacy table unchanged', () => {
  const legacyRoot = makeLegacyRepositoryRoot();
  try {
    const database = openCatalogDatabase({ repositoryRoot: legacyRoot });
    addSession(database, 1);
    assert.throws(() => executeSessionMigration(database), /exactly one WAI session Skill mapping/u);
    database.exec('ROLLBACK');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'sessions_next'").get().count, 0);
    database.close();
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});

test('Issue #172 migration rejects existing sessions when WAI mappings point to multiple base models', () => {
  const legacyRoot = makeLegacyRepositoryRoot();
  try {
    const database = openCatalogDatabase({ repositoryRoot: legacyRoot });
    addGenerationBaseModel(database, 7, 'WAI');
    addGenerationBaseModel(database, 8, 'WAI alternate');
    addGenerationModel(database, { id: 70, baseModelId: 7, skillName: 'wai-sdxl-prompt-builder' });
    addGenerationModel(database, { id: 80, baseModelId: 8, skillName: ' wai-sdxl-prompt-builder ' });
    addSession(database, 1);
    assert.throws(() => executeSessionMigration(database), /exactly one WAI session Skill mapping/u);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
    database.close();
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
  }
});
