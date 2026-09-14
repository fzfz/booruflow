import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';
import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const migrationDirectory = resolve(repositoryRoot, 'schema/database');
const styleDescriptionMigrationPath = resolve(migrationDirectory, '011-style-description.sql');
const NOW = '2026-08-03T00:00:00Z';

function openPersistentDatabaseAt010() {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-issue-111-migration-'));
  const databasePath = join(directory, 'catalog.sqlite');
  const mediaRoot = join(directory, 'media');
  const historicalRepositoryRoot = join(directory, 'repository');
  const historicalMigrationDirectory = join(historicalRepositoryRoot, 'schema/database');
  mkdirSync(historicalMigrationDirectory, { recursive: true });
  for (const migration of listOrderedMigrations(migrationDirectory).filter(({ version }) => version <= 35)) {
    cpSync(migration.path, join(historicalMigrationDirectory, migration.path.split('/').at(-1)));
  }
  const bootstrap = new DatabaseSync(databasePath);
  try {
    for (const name of [
      '001-initial.sql',
      '002-management-media.sql',
      '003-media-path-foundation.sql',
      '004-work-cover-character-fallback.sql'
    ]) bootstrap.exec(readFileSync(resolve(migrationDirectory, name), 'utf8'));
  } finally {
    bootstrap.close();
  }
  runMediaCutover({
    databasePath,
    mediaRoot,
    repositoryRoot,
    applyPostMigrations(database) {
      for (const name of [
        '006-media-cutover-skipped-cleanup.sql',
        '007-prompt-terms.sql',
        '008-generation-resources.sql',
        '009-vector-retrieval.sql',
        '010-restore-media-cover-triggers.sql'
      ]) database.exec(readFileSync(resolve(migrationDirectory, name), 'utf8'));
    }
  });
  return { directory, databasePath, repositoryRoot: historicalRepositoryRoot };
}

test('Issue #111 publishes the nullable styles.style_description migration after migration 010', () => {
  assert.equal(existsSync(styleDescriptionMigrationPath), true, 'the style_description migration must be published');
  const migrations = listOrderedMigrations(migrationDirectory);
  const styleDescriptionIndex = migrations.findIndex(({ name }) => name === '011-style-description');
  assert.ok(styleDescriptionIndex > 0, '011-style-description must follow an earlier migration');
  assert.deepEqual(
    migrations.slice(styleDescriptionIndex - 1, styleDescriptionIndex + 1).map(({ name }) => name),
    ['010-restore-media-cover-triggers', '011-style-description']
  );
});

test('Issue #111 upgrades a persistent 010 database through the real migration entry and remains idempotent after reopen', () => {
  const fixture = openPersistentDatabaseAt010();
  try {
    const legacy = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(legacy.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 10);
      legacy.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (7, 'anima', ?, ?), (42, 'wai', ?, ?)")
        .run(NOW, NOW, NOW, NOW);
      legacy.prepare(`INSERT INTO styles(
        id, source_version, name, name_normalized, aliases_json, category_name, prompt_text, is_available, created_at, updated_at
      ) VALUES (11101, 'WAI', 'Legacy Style', 'legacy style', '[]', '绘画', 'legacy prompt', 1, ?, ?)`)
        .run(NOW, NOW);
    } finally {
      legacy.close();
    }

    const database = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: join(fixture.directory, 'media'), repositoryRoot: fixture.repositoryRoot });
    try {
      assert.deepEqual(database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name), [
        'id', 'base_model_id', 'name', 'aliases_json', 'prompt_text', 'style_description', 'cover_media_path'
      ]);
      database.prepare(`INSERT INTO styles(
        id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
      ) VALUES (11102, 42, 'Described Style', '[]', 'described prompt', 'soft layered brushwork', NULL)`).run();

      const repository = createCatalogRepository(database);
      assert.deepEqual(database.prepare('SELECT id, base_model_id, name FROM styles ORDER BY id').all().map((row) => ({ ...row })), [
        { id: 11101, base_model_id: 42, name: 'Legacy Style' },
        { id: 11102, base_model_id: 42, name: 'Described Style' }
      ]);
      assert.equal(repository.getStyle(11101).style_description, null);
      assert.equal(repository.getStyle(11102).style_description, 'soft layered brushwork');
      assert.deepEqual(
        repository.listStyles().map(({ id, style_description: description }) => ({ id, description })),
        [{ id: 11102, description: 'soft layered brushwork' }, { id: 11101, description: null }]
      );
      const migrations = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
      assert.equal(migrations.at(-1).version, 35);
      assert.equal(migrations.at(-1).name, '035-iterative-image-task-round-error-details');
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 35);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'session_work_selections'").get().count, 0);
    } finally {
      database.close();
    }

    const reopened = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: join(fixture.directory, 'media'), repositoryRoot: fixture.repositoryRoot });
    try {
      assert.equal(reopened.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 35);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('styles') WHERE name = 'style_description'").get().count, 1);
      assert.equal(reopened.prepare('SELECT style_description FROM styles WHERE id = 11101').get().style_description, null);
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 35);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
