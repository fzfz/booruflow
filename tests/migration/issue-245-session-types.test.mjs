import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);
const migrationDirectory = resolve(repositoryRoot, 'schema/database');
const migration026 = readFileSync(resolve(migrationDirectory, '026-session-types.sql'), 'utf8');
const NOW = '2026-08-15T00:00:00Z';

function seedBaseModel(database) {
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('Fixture Base', NOW, NOW);
}

function insertSession(database, { id, sessionType = 'homepage_chat', maxRounds = 3, roundsUsed = 0, status = 'active' } = {}) {
  database.prepare(`INSERT INTO sessions(
    id, title, session_type, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
    pi_session_file, committed_leaf_id, base_model_id, base_model_snapshot_json, created_at, updated_at
  ) VALUES (?, 'Fixture', ?, ?, ?, ?, ?, ?, ?, ?, 1, '{"id":1,"name":"Fixture Base"}', ?, ?)`)
    .run(id, sessionType, status, maxRounds, roundsUsed, `instance-${id}`, `pi-${id}`, `sessions/${id}.jsonl`, roundsUsed > 0 ? `leaf-${id}` : null, NOW, NOW);
}

test('Issue #245 publishes migration 026 and records both explicit session types on a fresh database', () => {
  const migrations = listOrderedMigrations(migrationDirectory);
  const migration026Record = migrations.find(({ version }) => version === 26);
  assert.equal(migration026Record?.version, 26);
  assert.equal(migration026Record?.name, '026-session-types');
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 40);
    assert.deepEqual(database.prepare('SELECT session_type, max_rounds, rounds_used, status FROM sessions').all(), []);
    const typeColumn = database.prepare('PRAGMA table_info(sessions)').all().find(({ name }) => name === 'session_type');
    assert.deepEqual({ type: typeColumn.type, notnull: typeColumn.notnull, dflt_value: typeColumn.dflt_value }, { type: 'TEXT', notnull: 1, dflt_value: null });
    seedBaseModel(database);
    insertSession(database, { id: 1 });
    insertSession(database, { id: 2, sessionType: 'iterative_prompt', maxRounds: null, roundsUsed: 4 });
    assert.deepEqual(database.prepare('SELECT id, session_type, max_rounds, rounds_used, status FROM sessions ORDER BY id').all().map((row) => ({ ...row })), [
      { id: 1, session_type: 'homepage_chat', max_rounds: 3, rounds_used: 0, status: 'active' },
      { id: 2, session_type: 'iterative_prompt', max_rounds: null, rounds_used: 4, status: 'active' }
    ]);
    assert.throws(() => insertSession(database, { id: 3, sessionType: 'iterative_prompt', maxRounds: 3 }), /CHECK constraint failed/u);
    assert.throws(() => insertSession(database, { id: 4, sessionType: 'iterative_prompt', maxRounds: null, status: 'exhausted' }), /CHECK constraint failed/u);
  } finally {
    database.close();
  }
});

test('Issue #245 upgrades existing sessions to homepage_chat without changing child FKs or unique constraints', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'noobai-issue-245-legacy-'));
  const target = resolve(root, 'schema/database');
  mkdirSync(target, { recursive: true });
  for (const migration of listOrderedMigrations(migrationDirectory).filter(({ version }) => version <= 25)) {
    copyFileSync(migration.path, resolve(target, migration.path.split('/').at(-1)));
  }
  const database = openCatalogDatabase({ repositoryRoot: root, includeBuiltinComfyuiCatalog: false });
  try {
    seedBaseModel(database);
    database.prepare(`INSERT INTO sessions(
      id, title, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
      pi_session_file, committed_leaf_id, base_model_id, created_at, updated_at
    ) VALUES (7, 'Fixture', 'active', 3, 2, 'instance-7', 'pi-7', 'sessions/7.jsonl', 'leaf-7', 1, ?, ?)`)
      .run(NOW, NOW);
    database.prepare('INSERT INTO session_turn_skills(session_id, round_number, skill_name) VALUES (7, 1, ?)').run('wai-sdxl-prompt-builder');
    database.prepare('INSERT INTO session_turn_skills(session_id, round_number, skill_name) VALUES (7, 2, ?)').run('wai-sdxl-prompt-builder');

    // Execute the new migration against the already-open 025 schema to prove the upgrade path.
    database.exec(migration026);
    assert.equal(database.prepare('SELECT session_type FROM sessions WHERE id = 7').get().session_type, 'homepage_chat');
    assert.deepEqual(database.prepare('PRAGMA foreign_key_list(session_turn_skills)').all().map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete })), [
      { from: 'session_id', table: 'sessions', to: 'id', on_delete: 'CASCADE' }
    ]);
    assert.throws(() => database.prepare('INSERT INTO sessions(title, session_type, status, max_rounds, rounds_used, pi_instance_id, pi_session_id, pi_session_file, base_model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('Duplicate file', 'homepage_chat', 'active', 3, 0, 'instance-dup', 'pi-dup', 'sessions/7.jsonl', 1, NOW, NOW), /UNIQUE constraint failed: sessions.pi_session_file/u);
    database.prepare('DELETE FROM sessions WHERE id = 7').run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM session_turn_skills WHERE session_id = 7').get().count, 0);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Issue #245 migration is runnable as an application upgrade from a 025 repository root', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'noobai-issue-245-migration-'));
  const target = resolve(root, 'schema/database');
  mkdirSync(target, { recursive: true });
  try {
    for (const migration of listOrderedMigrations(migrationDirectory).filter(({ version }) => version <= 26)) {
      copyFileSync(migration.path, resolve(target, migration.path.split('/').at(-1)));
    }
    const database = openCatalogDatabase({ repositoryRoot: root, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 26);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Issue #245 migration 026 rolls back a failed transactional table swap through application startup', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'noobai-issue-245-migration-rollback-'));
  const target = resolve(root, 'schema/database');
  const databasePath = resolve(root, 'app.sqlite');
  const mediaRoot = resolve(root, 'media');
  mkdirSync(target, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });
  try {
    for (const migration of listOrderedMigrations(migrationDirectory).filter(({ version }) => version <= 25)) {
      copyFileSync(migration.path, resolve(target, migration.path.split('/').at(-1)));
    }
    runMediaCutover({ databasePath, mediaRoot, repositoryRoot: root });

    const before = new DatabaseSync(databasePath);
    before.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (9001, ?, ?, ?)').run('Rollback Fixture', NOW, NOW);
    before.prepare(`INSERT INTO sessions(
      id, title, status, max_rounds, rounds_used, pi_instance_id, pi_session_id,
      pi_session_file, committed_leaf_id, base_model_id, created_at, updated_at
    ) VALUES (9001, 'Rollback Session', 'active', 3, 1, 'instance-9001', 'pi-9001', 'sessions/9001.jsonl', 'leaf-9001', 9001, ?, ?)`)
      .run(NOW, NOW);
    before.prepare('INSERT INTO session_turn_skills(session_id, round_number, skill_name) VALUES (9001, 1, ?)').run('wai-sdxl-prompt-builder');
    const sessionsBefore = before.prepare('SELECT * FROM sessions ORDER BY id').all().map((row) => ({ ...row }));
    const turnSkillsBefore = before.prepare('SELECT * FROM session_turn_skills ORDER BY session_id, round_number').all().map((row) => ({ ...row }));
    const sessionIndexesBefore = before.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'sessions' ORDER BY name").all().map((row) => ({ ...row }));
    const turnSkillForeignKeysBefore = before.prepare('PRAGMA foreign_key_list(session_turn_skills)').all().map((row) => ({ ...row }));
    before.close();

    const failedMigration = `${migration026.replace(
      'ALTER TABLE sessions_next RENAME TO sessions;\n',
      "ALTER TABLE sessions_next RENAME TO sessions;\nINSERT INTO issue_245_forced_failure VALUES (1);\n"
    )}`;
    writeFileSync(resolve(target, '026-session-types.sql'), failedMigration);
    assert.throws(() => openCatalogDatabase({ databasePath, mediaRoot, repositoryRoot: root, includeBuiltinComfyuiCatalog: false }), /issue_245_forced_failure/u);

    const after = new DatabaseSync(databasePath);
    try {
      assert.deepEqual(after.prepare('SELECT * FROM sessions ORDER BY id').all().map((row) => ({ ...row })), sessionsBefore);
      assert.deepEqual(after.prepare('SELECT * FROM session_turn_skills ORDER BY session_id, round_number').all().map((row) => ({ ...row })), turnSkillsBefore);
      assert.deepEqual(after.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'sessions' ORDER BY name").all().map((row) => ({ ...row })), sessionIndexesBefore);
      assert.deepEqual(after.prepare('PRAGMA foreign_key_list(session_turn_skills)').all().map((row) => ({ ...row })), turnSkillForeignKeysBefore);
      assert.equal(after.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'sessions_next'").get().count, 0);
      assert.equal(after.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 26').get().count, 0);
      assert.equal(after.prepare('PRAGMA user_version').get().user_version, 25);
      assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
