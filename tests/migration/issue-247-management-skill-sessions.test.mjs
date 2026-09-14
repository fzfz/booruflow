import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);
const migrationDirectory = resolve(repositoryRoot, 'schema/database');

async function legacyRoot() {
  const root = await mkdtemp(join(tmpdir(), 'issue-247-legacy-'));
  const target = join(root, 'schema', 'database');
  await mkdir(target, { recursive: true });
  for (const migration of listOrderedMigrations(migrationDirectory).filter(({ version }) => version <= 26)) {
    await cp(migration.path, join(target, migration.path.split('/').at(-1)));
  }
  return root;
}

test('Issue #247 creates the management Skill session table on a fresh database with foreign-key checks clean', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    const table = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'management_skill_sessions'").get();
    assert.match(table.sql, /UNIQUE\(owner_kind, owner_id, skill_name\)/u);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(database.prepare('PRAGMA table_info(management_skill_sessions)').all().map(({ name }) => name), [
      'id', 'owner_kind', 'owner_id', 'skill_name', 'pi_instance_id', 'pi_session_id', 'pi_session_file',
      'committed_leaf_id', 'created_at', 'updated_at'
    ]);
  } finally {
    database.close();
  }
});

test('Issue #247 upgrades a 026 database to 027 and rolls back the migration as one transaction', async () => {
  const root = await legacyRoot();
  const databasePath = resolve(root, 'rollback.sqlite');
  try {
    const migration027 = await (await import('node:fs/promises')).readFile(resolve(repositoryRoot, 'schema/database/027-management-skill-sessions.sql'), 'utf8');
    const upgraded = openCatalogDatabase({ repositoryRoot: root, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 26);
      upgraded.exec(migration027);
      assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 27);
      assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'management_skill_sessions'").get().count, 1);
    } finally {
      upgraded.close();
    }

    const legacy = openCatalogDatabase({ repositoryRoot: root, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(legacy.prepare('PRAGMA database_list').get().file, '', 'VACUUM source must begin as an in-memory 026 database');
      assert.equal(legacy.prepare('PRAGMA user_version').get().user_version, 26);
      legacy.prepare(`INSERT INTO generation_base_models(id, name, created_at, updated_at)
        VALUES (987, 'rollback-baseline', '2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')`).run();
      assert.equal(legacy.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 26').get().count, 1);
      legacy.exec(`VACUUM INTO '${databasePath.replaceAll("'", "''")}'`);
    } finally {
      legacy.close();
    }

    const failedMigration = migration027.replace(
      "INSERT INTO schema_migrations(version, name, applied_at)",
      "INSERT INTO issue_247_forced_failure VALUES (1);\nINSERT INTO schema_migrations(version, name, applied_at)"
    );
    const rollbackDatabase = new DatabaseSync(databasePath);
    try {
      assert.notEqual(rollbackDatabase.prepare('PRAGMA database_list').get().file, '', 'rollback must use the persistent SQLite file');
      assert.equal(rollbackDatabase.prepare('PRAGMA user_version').get().user_version, 26);
      assert.throws(() => rollbackDatabase.exec(failedMigration), /issue_247_forced_failure/u);
    } finally {
      rollbackDatabase.close();
    }

    const afterRollback = new DatabaseSync(databasePath);
    try {
      assert.equal(afterRollback.prepare('PRAGMA user_version').get().user_version, 26);
      assert.equal(afterRollback.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'management_skill_sessions'").get().count, 0);
      assert.equal(afterRollback.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 27').get().count, 0);
      assert.equal(afterRollback.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 26').get().count, 1);
      assert.equal(afterRollback.prepare("SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 987 AND name = 'rollback-baseline'").get().count, 1);
      assert.deepEqual(afterRollback.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      afterRollback.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
