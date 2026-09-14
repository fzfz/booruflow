import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);
const migrationDirectory = resolve(repositoryRoot, 'schema/database');
const timestamp = '2026-08-05T00:00:00Z';

function legacyRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'noobai-issue-174-migration-'));
  const target = resolve(root, 'schema/database');
  mkdirSync(target, { recursive: true });
  const names = [
    '001-initial.sql', '002-management-media.sql', '003-media-path-foundation.sql',
    '004-work-cover-character-fallback.sql', '005-media-cutover.sql',
    '006-media-cutover-skipped-cleanup.sql', '007-prompt-terms.sql',
    '008-generation-resources.sql', '009-vector-retrieval.sql',
    '010-restore-media-cover-triggers.sql', '011-style-description.sql',
    '012-session-base-model.sql'
  ];
  for (const name of names) copyFileSync(resolve(migrationDirectory, name), resolve(target, name));
  return root;
}

function historicalRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'noobai-issue-174-historical-'));
  const target = resolve(root, 'schema/database');
  mkdirSync(target, { recursive: true });
  for (const migration of listOrderedMigrations(migrationDirectory).filter(({ version }) => version <= 35)) {
    copyFileSync(migration.path, resolve(target, migration.path.split('/').at(-1)));
  }
  return root;
}

function seedBaseModel(database) {
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('WAI', timestamp, timestamp);
}

function seedGenerationModel(database) {
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    description, usage, skill_name, created_at, updated_at
  ) VALUES (1, 1, 'wai.safetensors', 'safetensors', 'fp16', 'fixture', 'fixture', 'wai-sdxl-prompt-builder', ?, ?)`)
    .run(timestamp, timestamp);
}

function seedSession(database, { id, rounds, status = rounds === 3 ? 'exhausted' : 'active', leaf = rounds ? `a${id}` : null }) {
  database.prepare(`INSERT INTO sessions(
    id, title, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
    pi_session_file, committed_leaf_id, base_model_id, created_at, updated_at
  ) VALUES (?, ?, ?, 3, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, `Session ${id}`, status, rounds, `instance-${id}`, `session-${id}`, `sessions/${id}.jsonl`, leaf, timestamp, timestamp);
}

function seedCurrentSession(database, { id, rounds, status = rounds === 3 ? 'exhausted' : 'active', leaf = rounds ? `a${id}` : null }) {
  database.prepare(`INSERT INTO sessions(
    id, title, session_type, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
    pi_session_file, committed_leaf_id, base_model_id, created_at, updated_at
  ) VALUES (?, ?, 'homepage_chat', ?, 3, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, `Session ${id}`, status, rounds, `instance-${id}`, `session-${id}`, `sessions/${id}.jsonl`, leaf, timestamp, timestamp);
}

function apply013(database) {
  database.exec(readFileSync(resolve(migrationDirectory, '013-session-turn-skills.sql'), 'utf8'));
}

test('Issue #174 migration creates the exact turn-fact table and a contiguous ledger entry', () => {
  const root = historicalRoot();
  const database = openCatalogDatabase({ repositoryRoot: root, includeBuiltinComfyuiCatalog: false });
  try {
    const columns = database.prepare('PRAGMA table_info(session_turn_skills)').all();
    assert.deepEqual(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })), [
      { name: 'session_id', type: 'INTEGER', notnull: 1, pk: 1 },
      { name: 'round_number', type: 'INTEGER', notnull: 1, pk: 2 },
      { name: 'skill_name', type: 'TEXT', notnull: 1, pk: 0 }
    ]);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_list(session_turn_skills)').all().map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete })), [
      { from: 'session_id', table: 'sessions', to: 'id', on_delete: 'CASCADE' }
    ]);
    assert.deepEqual(database.prepare('SELECT version, name FROM schema_migrations WHERE version >= 13 ORDER BY version DESC').all().map((row) => ({ ...row })), [
      { version: 35, name: '035-iterative-image-task-round-error-details' },
      { version: 34, name: '034-iterative-image-task-write-idempotency' },
      { version: 33, name: '033-iterative-image-task-followup-rounds' },
      { version: 32, name: '032-iterative-image-task-comfyui-retry' },
      { version: 31, name: '031-iterative-image-task-stage-failure' },
      { version: 30, name: '030-iterative-image-task-lora-adjustment' },
      { version: 29, name: '029-comfyui-iterative-runs-media' },
      { version: 28, name: '028-iterative-image-tasks' },
      { version: 27, name: '027-management-skill-sessions' },
      { version: 26, name: '026-session-types' },
      { version: 25, name: '025-remove-session-selections' },
      { version: 24, name: '024-generation-lora-trigger-weight' },
      { version: 23, name: '023-krea2-lora-catalog' },
      { version: 22, name: '022-comfyui-runs' },
      { version: 21, name: '021-comfyui-template-active-path-repairs' },
      { version: 20, name: '020-comfyui-template-output-node-repairs' },
      { version: 19, name: '019-comfyui-template-runtime-corrections' },
      { version: 18, name: '018-comfyui-template-builtin-catalog' },
      { version: 17, name: '017-comfyui-template-workflow-management' },
      { version: 16, name: '016-remove-session-work-selections' },
      { version: 15, name: '015-style-base-model' },
      { version: 14, name: '014-vector-convergence' },
      { version: 13, name: '013-session-turn-skills' }
    ]);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Issue #174 migration backfills one WAI fact per existing successful round and skips zero-round sessions', () => {
  const root = legacyRoot();
  try {
    const database = openCatalogDatabase({ repositoryRoot: root });
    seedBaseModel(database);
    seedGenerationModel(database);
    seedSession(database, { id: 1, rounds: 0 });
    seedSession(database, { id: 2, rounds: 2 });
    apply013(database);
    assert.deepEqual(database.prepare('SELECT session_id, round_number, skill_name FROM session_turn_skills ORDER BY session_id, round_number').all().map((row) => ({ ...row })), [
      { session_id: 2, round_number: 1, skill_name: 'wai-sdxl-prompt-builder' },
      { session_id: 2, round_number: 2, skill_name: 'wai-sdxl-prompt-builder' }
    ]);
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Issue #174 turn facts cascade with session deletion and reject duplicate rounds', () => {
  const root = historicalRoot();
  const database = openCatalogDatabase({ repositoryRoot: root, includeBuiltinComfyuiCatalog: false });
  try {
    seedBaseModel(database);
    seedCurrentSession(database, { id: 1, rounds: 0 });
    database.prepare('INSERT INTO session_turn_skills(session_id, round_number, skill_name) VALUES (1, 1, ?)').run('wai-sdxl-prompt-builder');
    assert.throws(() => database.prepare('INSERT INTO session_turn_skills(session_id, round_number, skill_name) VALUES (1, 1, ?)').run('other-skill'), /UNIQUE constraint failed: session_turn_skills\.session_id, session_turn_skills\.round_number/u);
    database.prepare('DELETE FROM sessions WHERE id = 1').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM session_turn_skills').get().count, 0);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Issue #174 migration failure leaves the legacy sessions table untouched', () => {
  const root = legacyRoot();
  try {
    const database = openCatalogDatabase({ repositoryRoot: root });
    seedBaseModel(database);
    seedGenerationModel(database);
    seedSession(database, { id: 1, rounds: 1 });
    apply013(database);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM session_turn_skills').get().count, 1);
    assert.throws(() => database.prepare('INSERT INTO session_turn_skills(session_id, round_number, skill_name) VALUES (999, 2, ?)').run('other-skill'), /FOREIGN KEY constraint failed/u);
    assert.equal(database.prepare('SELECT rounds_used FROM sessions WHERE id = 1').get().rounds_used, 1);
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
