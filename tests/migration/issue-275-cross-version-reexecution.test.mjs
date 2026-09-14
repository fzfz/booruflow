import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';
import { migrateGenerationResourceVectors } from '../../app/catalog/generation-resource-vector-migration.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MIGRATION_DIRECTORY = resolve(ROOT, 'schema/database');
const MIGRATION_036 = resolve(MIGRATION_DIRECTORY, '036-generation-resource-vectors.sql');
const RELEASE_LABELS = Object.freeze(['v0.81.0', 'v0.81.1', 'v0.82.0']);

function create035Repository(releaseLabel) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), `issue-275-${releaseLabel}-035-repository-`));
  const migrationDirectory = resolve(repositoryRoot, 'schema/database');
  mkdirSync(migrationDirectory, { recursive: true });
  for (const migration of listOrderedMigrations(MIGRATION_DIRECTORY).filter(({ version: migrationVersion }) => migrationVersion <= 35)) {
    copyFileSync(migration.path, resolve(migrationDirectory, basename(migration.path)));
  }
  return repositoryRoot;
}

function createNonEmpty035Database(repositoryRoot) {
  const dataRoot = resolve(repositoryRoot, 'data');
  const databasePath = resolve(dataRoot, 'app.sqlite');
  const mediaRoot = resolve(dataRoot, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot });
  const database = openCatalogDatabase({
    databasePath,
    mediaRoot,
    repositoryRoot,
    includeBuiltinComfyuiCatalog: false
  });
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES (5001, 'cross-version base', '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z');
    INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (
      5002, 5001, 'cross-version-model.safetensors', 'safetensors', 'fp16',
      'cross-version model', 'cross-version model usage', '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
    );
    INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (
      5003, 5001, 5002, 'cross-version-lora.safetensors', 'safetensors', 'fp16',
      'cross-version lora', 'cross-version lora usage', '["cross_version_lora"]', 1.0,
      '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
    );
    INSERT INTO artist_prompt_strings(
      id, title, description, artist_string, base_model_id, created_at, updated_at
    ) VALUES (
      5004, 'Cross-version Artist', 'cross-version artist', 'cross_version_artist:1.2', 5001,
      '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
    );
    UPDATE vector_spaces SET embedding_model = CASE object_kind
      WHEN 'work' THEN 'old-work-model'
      WHEN 'character' THEN 'old-character-model'
      WHEN 'style' THEN 'old-style-model'
      WHEN 'prompt_term' THEN 'old-prompt-model'
    END, dimension = 2;
    INSERT INTO vector_entries(object_kind, object_id, embedding_f32)
      VALUES ('work', 1, X'0000803F00000040'),
             ('character', 1, X'0000404000008040'),
             ('style', 5005, X'0000A0400000C040'),
             ('prompt_term', 1, X'0000E04000000041');
  `);
  return { database, databasePath, mediaRoot };
}

test('Issue #275 migration ignores release labels and executes the same formal 036 SQL from the 035/036 ledger, once per independent database', async () => {
  const formalSql = readFileSync(MIGRATION_036);
  const fixtures = [];
  try {
    for (const releaseLabel of RELEASE_LABELS) {
      const repositoryRoot = create035Repository(releaseLabel);
      const fixture = createNonEmpty035Database(repositoryRoot);
      fixtures.push({ repositoryRoot, ...fixture });
      const migrationPath = resolve(repositoryRoot, 'schema/database/036-generation-resource-vectors.sql');
      copyFileSync(MIGRATION_036, migrationPath);

      assert.equal(existsSync(resolve(repositoryRoot, 'config/release-version.json')), false, releaseLabel);
      assert.deepEqual(readFileSync(migrationPath), formalSql, releaseLabel);
      assert.deepEqual(fixture.database.prepare('SELECT version, name FROM schema_migrations WHERE version = 35').all().map((row) => ({ ...row })), [
        { version: 35, name: '035-iterative-image-task-round-error-details' }
      ], releaseLabel);
      assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 35, releaseLabel);
      assert.equal(fixture.database.prepare('PRAGMA user_version').get().user_version, 35, releaseLabel);
      assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, 1, releaseLabel);
      assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, 1, releaseLabel);

      const embeddingCalls = [];
      const maintenance = (objectKind, vector) => ({
        async prepare(row) {
          embeddingCalls.push({ object_kind: objectKind, object_id: row.id });
          return { object_kind: objectKind, embedding_model: 'cross-version-model', vector };
        }
      });
      const first = await migrateGenerationResourceVectors({
        database: fixture.database,
        repositoryRoot,
        generationLoraMaintenance: maintenance('generation_lora', [3, 4, 0]),
        artistPromptStringMaintenance: maintenance('artist_prompt_string', [4, 3, 0])
      });
      assert.equal(first.status, 'complete', releaseLabel);
      assert.equal(first.version, 36, releaseLabel);
      assert.equal(first.embedding_calls, 2, releaseLabel);
      assert.deepEqual(embeddingCalls, [
        { object_kind: 'generation_lora', object_id: 5003 },
        { object_kind: 'artist_prompt_string', object_id: 5004 }
      ], releaseLabel);

      const callsBeforeSecondRun = embeddingCalls.length;
      const second = await migrateGenerationResourceVectors({
        database: fixture.database,
        repositoryRoot,
        generationLoraMaintenance: maintenance('generation_lora', [3, 4, 0]),
        artistPromptStringMaintenance: maintenance('artist_prompt_string', [4, 3, 0])
      });
      assert.equal(second.status, 'already_complete', releaseLabel);
      assert.equal(second.embedding_calls, 0, releaseLabel);
      assert.equal(embeddingCalls.length, callsBeforeSecondRun, releaseLabel);
      assert.deepEqual(fixture.database.prepare('SELECT version, name FROM schema_migrations WHERE version = 36').all().map((row) => ({ ...row })), [
        { version: 36, name: '036-generation-resource-vectors' }
      ], releaseLabel);
      assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 36').get().count, 1, releaseLabel);
      assert.equal(fixture.database.prepare('PRAGMA user_version').get().user_version, 36, releaseLabel);
      assert.deepEqual(fixture.database.prepare('SELECT object_kind, object_id FROM vector_entries WHERE object_kind IN (\'generation_lora\', \'artist_prompt_string\') ORDER BY object_kind, object_id').all().map((row) => ({ ...row })), [
        { object_kind: 'artist_prompt_string', object_id: 5004 },
        { object_kind: 'generation_lora', object_id: 5003 }
      ], releaseLabel);
    }
  } finally {
    for (const fixture of fixtures) {
      fixture.database.close();
      rmSync(fixture.repositoryRoot, { recursive: true, force: true });
    }
  }
});
