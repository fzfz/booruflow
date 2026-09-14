import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { migrateGenerationResourceVectors } from '../../app/catalog/generation-resource-vector-migration.mjs';
import { OBJECT_KINDS } from '../../app/vector/vector-source-definitions.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const ROOT_MIGRATION_PATH = resolve(ROOT, 'schema/database/036-generation-resource-vectors.sql');
const MIGRATION_NAMES = [
  '001-initial.sql', '002-management-media.sql', '003-media-path-foundation.sql',
  '004-work-cover-character-fallback.sql', '005-media-cutover.sql',
  '006-media-cutover-skipped-cleanup.sql', '007-prompt-terms.sql',
  '008-generation-resources.sql', '009-vector-retrieval.sql',
  '010-restore-media-cover-triggers.sql', '011-style-description.sql',
  '012-session-base-model.sql', '013-session-turn-skills.sql',
  '014-vector-convergence.sql', '015-style-base-model.sql',
  '016-remove-session-work-selections.sql', '017-comfyui-template-workflow-management.sql',
  '018-comfyui-template-builtin-catalog.sql', '019-comfyui-template-runtime-corrections.sql',
  '020-comfyui-template-output-node-repairs.sql', '021-comfyui-template-active-path-repairs.sql',
  '022-comfyui-runs.sql', '023-krea2-lora-catalog.sql', '024-generation-lora-trigger-weight.sql',
  '025-remove-session-selections.sql', '026-session-types.sql', '027-management-skill-sessions.sql',
  '028-iterative-image-tasks.sql', '029-comfyui-iterative-runs-media.sql',
  '030-iterative-image-task-lora-adjustment.sql', '031-iterative-image-task-stage-failure.sql',
  '032-iterative-image-task-comfyui-retry.sql', '033-iterative-image-task-followup-rounds.sql',
  '034-iterative-image-task-write-idempotency.sql', '035-iterative-image-task-round-error-details.sql'
];

function repositoryWithout036() {
  const repositoryRoot = mkdtempSync(resolve(tmpdir(), 'issue-277-database-contract-'));
  const migrationDirectory = resolve(repositoryRoot, 'schema/database');
  mkdirSync(migrationDirectory, { recursive: true });
  for (const name of MIGRATION_NAMES) {
    copyFileSync(resolve(ROOT, 'schema/database', name), resolve(migrationDirectory, name));
  }
  return repositoryRoot;
}

function create035Database(repositoryRoot) {
  const database = openCatalogDatabase({
    databasePath: ':memory:',
    mediaRoot: resolve(repositoryRoot, 'media'),
    repositoryRoot,
    includeBuiltinComfyuiCatalog: false
  });
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES (7701, 'Issue 277 base', '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z');
    INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (
      7702, 7701, 'issue-277-model.safetensors', 'safetensors', 'fp16',
      'Issue 277 model', 'Issue 277 model usage', '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z'
    );
    INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (
      7703, 7701, 7702, 'issue-277-lora.safetensors', 'safetensors', 'fp16',
      'Issue 277 LoRA description', 'Issue 277 LoRA usage', '["issue_277_token"]', 1.0,
      '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z'
    );
    INSERT INTO artist_prompt_strings(
      id, title, description, artist_string, base_model_id, created_at, updated_at
    ) VALUES (
      7704, 'Issue 277 artist', 'Issue 277 artist description', 'issue_277_artist:1.2', 7701,
      '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z'
    );
    UPDATE vector_spaces SET embedding_model = 'legacy-model', dimension = 2;
    INSERT INTO vector_entries(object_kind, object_id, embedding_f32)
      VALUES ('work', 1, X'0000803F00000040'),
             ('character', 2, X'0000404000008040'),
             ('style', 3, X'0000A0400000C040'),
             ('prompt_term', 4, X'0000E04000000041');
  `);
  return database;
}

test('migration 036 runs against a temporary 035 database and preserves all six spaces', async () => {
  const repositoryRoot = repositoryWithout036();
  const database = create035Database(repositoryRoot);
  const migrationSql = readFileSync(ROOT_MIGRATION_PATH, 'utf8');
  const embeddingCalls = [];
  try {
    const result = await migrateGenerationResourceVectors({
      database,
      repositoryRoot,
      readMigrationSql: () => migrationSql,
      generationLoraMaintenance: {
        async prepare(row) {
          embeddingCalls.push({ object_kind: 'generation_lora', id: row.id });
          return { object_kind: 'generation_lora', embedding_model: 'issue-277-model', vector: [3, 4, 0] };
        }
      },
      artistPromptStringMaintenance: {
        async prepare(row) {
          embeddingCalls.push({ object_kind: 'artist_prompt_string', id: row.id });
          return { object_kind: 'artist_prompt_string', embedding_model: 'issue-277-model', vector: [4, 3, 0] };
        }
      }
    });

    assert.equal(result.status, 'complete');
    assert.deepEqual(embeddingCalls, [
      { object_kind: 'generation_lora', id: 7703 },
      { object_kind: 'artist_prompt_string', id: 7704 }
    ]);
    assert.deepEqual(
      database.prepare('SELECT object_kind FROM vector_spaces ORDER BY object_kind').all().map(({ object_kind }) => object_kind),
      [...OBJECT_KINDS].sort()
    );
    assert.deepEqual(
      database.prepare('SELECT object_kind, object_id FROM vector_entries ORDER BY object_kind, object_id').all().map((row) => ({ ...row })),
      [
        { object_kind: 'artist_prompt_string', object_id: 7704 },
        { object_kind: 'character', object_id: 2 },
        { object_kind: 'generation_lora', object_id: 7703 },
        { object_kind: 'prompt_term', object_id: 4 },
        { object_kind: 'style', object_id: 3 },
        { object_kind: 'work', object_id: 1 }
      ]
    );
    assert.deepEqual(
      { ...database.prepare('SELECT version, name FROM schema_migrations WHERE version = 36').get() },
      { version: 36, name: '036-generation-resource-vectors' }
    );
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 36);
    assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally {
    database.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
