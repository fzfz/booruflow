import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  OfflineGenerationResourceVectorMigrationRequiredError,
  openCatalogDatabase,
  VectorKnnMigrationError
} from '../../app/catalog/database.mjs';
import { migrateGenerationResourceVectors } from '../../app/catalog/generation-resource-vector-migration.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
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

function embeddingVector(seed) {
  const values = new Array(1024).fill(0);
  values[seed] = 1;
  return values;
}

function repositoryWithout036() {
  const root = mkdtempSync(join(tmpdir(), 'issue-275-open-repository-'));
  const directory = join(root, 'schema/database');
  mkdirSync(directory, { recursive: true });
  for (const name of MIGRATION_NAMES) copyFileSync(resolve(ROOT, 'schema/database', name), join(directory, name));
  return root;
}

function create035Database({ source = 'empty' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'issue-275-open-database-'));
  const repositoryRoot = repositoryWithout036();
  const databasePath = join(root, 'app.sqlite');
  const mediaRoot = join(root, 'media');
  const database = openCatalogDatabase({
    databasePath: ':memory:',
    mediaRoot,
    repositoryRoot,
    includeBuiltinComfyuiCatalog: false
  });
  if (source !== 'empty') {
    database.exec(`
      INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES (5001, 'open migration base', '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z');
      INSERT INTO generation_models(
        id, base_model_id, file_name, file_format, precision_or_quantization,
        description, usage, created_at, updated_at
      ) VALUES (
        5002, 5001, 'open-migration-model.safetensors', 'safetensors', 'fp16',
        'open migration model', 'open migration model usage',
        '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
      );
    `);
    if (source === 'lora' || source === 'both') {
      database.prepare(`
        INSERT INTO generation_loras(
          id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
          description, usage, trigger_words_json, weight, created_at, updated_at
        ) VALUES (5003, 5001, 5002, 'open-migration-lora.safetensors', 'safetensors', 'fp16',
          'lora description', 'lora usage', '["lora_token"]', 1.0,
          '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z')
      `).run();
    }
    if (source === 'artist' || source === 'both') {
      database.prepare(`
        INSERT INTO artist_prompt_strings(
          id, title, description, artist_string, base_model_id, created_at, updated_at
        ) VALUES (5004, 'Migration Artist', 'artist description', 'open_artist:1.2', 5001,
          '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z')
      `).run();
    }
  }
  database.exec(`VACUUM INTO '${databasePath.replaceAll("'", "''")}'`);
  database.close();
  return { root, repositoryRoot, databasePath, mediaRoot };
}

function openAt035(fixture) {
  return openCatalogDatabase({
    databasePath: fixture.databasePath,
    mediaRoot: fixture.mediaRoot,
    repositoryRoot: fixture.repositoryRoot,
    includeBuiltinComfyuiCatalog: false
  });
}

function assert035Unchanged(fixture, source) {
  const database = openAt035(fixture);
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 35);
    assert.deepEqual(
      { ...database.prepare('SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1').get() },
      { version: 35, name: '035-iterative-image-task-round-error-details' }
    );
    assert.deepEqual(
      database.prepare('SELECT object_kind FROM vector_spaces ORDER BY object_kind').all().map(({ object_kind }) => object_kind),
      ['character', 'prompt_term', 'style', 'work']
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('vector_spaces_035', 'vector_entries_035')").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 36").get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, source === 'lora' || source === 'both' ? 1 : 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, source === 'artist' || source === 'both' ? 1 : 0);
  } finally {
    database.close();
  }
}

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(fixture.repositoryRoot, { recursive: true, force: true });
}

test('Issue #275 ordinary open migrates an empty 035 database with one synchronous SQL path and zero model calls', () => {
  const fixture = create035Database();
  try {
    const database = openCatalogDatabase({
      databasePath: fixture.databasePath,
      mediaRoot: fixture.mediaRoot,
      includeBuiltinComfyuiCatalog: false
    });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 40);
      assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.deepEqual(
        database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all().map((row) => ({ ...row })),
        [
          { object_kind: 'artist_prompt_string', embedding_model: '__unconfigured__', dimension: 1 },
          { object_kind: 'character', embedding_model: '__unconfigured__', dimension: 1 },
          { object_kind: 'generation_lora', embedding_model: '__unconfigured__', dimension: 1 },
          { object_kind: 'prompt_term', embedding_model: '__unconfigured__', dimension: 1 },
          { object_kind: 'style', embedding_model: '__unconfigured__', dimension: 1 },
          { object_kind: 'work', embedding_model: '__unconfigured__', dimension: 1 }
        ]
      );
      assert.deepEqual(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%delete_vector_entries_after_delete' ORDER BY name").all().map((row) => ({ ...row })),
        [
          { name: 'artist_prompt_strings_delete_vector_entries_after_delete' },
          { name: 'generation_loras_delete_vector_entries_after_delete' }
        ]
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries').get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 36 AND name = '036-generation-resource-vectors'").get().count, 1);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_temp_master WHERE type = 'table' AND name LIKE 'migration_036_%'").get().count, 0);
    } finally {
      database.close();
    }
  } finally {
    cleanup(fixture);
  }
});

for (const source of ['lora', 'artist', 'both']) {
  test(`Issue #275 ordinary open rejects a 035 database with ${source} source rows before any 036 write`, () => {
    const fixture = create035Database({ source });
    try {
      assert.throws(
        () => openCatalogDatabase({
          databasePath: fixture.databasePath,
          mediaRoot: fixture.mediaRoot,
          includeBuiltinComfyuiCatalog: false
        }),
        (error) => error instanceof OfflineGenerationResourceVectorMigrationRequiredError
          && error.name === 'OfflineGenerationResourceVectorMigrationRequiredError'
          && error.message === 'generation resource vector migration 036 requires the offline migration entry before the application can start'
      );
      assert035Unchanged(fixture, source);
    } finally {
      cleanup(fixture);
    }
  });
}

test('Issue #275 ordinary open accepts an already converged 036 database without repeating migration', () => {
  const fixture = create035Database();
  try {
    const first = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, includeBuiltinComfyuiCatalog: false });
    first.close();
    const second = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(second.prepare('PRAGMA user_version').get().user_version, 40);
      assert.equal(second.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 36 AND name = '036-generation-resource-vectors'").get().count, 1);
      assert.equal(second.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally {
      second.close();
    }
  } finally {
    cleanup(fixture);
  }
});

test('ordinary startup skips registered migration 036 after later LoRA data changes', () => {
  const fixture = create035Database();
  try {
    const migrated = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, includeBuiltinComfyuiCatalog: false });
    migrated.close();

    const timestamp = '2026-08-30T00:00:00Z';
    const mutate = new DatabaseSync(fixture.databasePath);
    try {
      mutate.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(5101, 'post-migration-base', timestamp, timestamp);
      mutate.prepare(`INSERT INTO generation_models(
          id, base_model_id, file_name, file_format, precision_or_quantization,
          description, usage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(5102, 5101, 'post-migration-model.safetensors', 'safetensors', 'fp16', 'post migration model', 'post migration model', timestamp, timestamp);
      mutate.prepare(`INSERT INTO generation_loras(
          id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
          description, usage, trigger_words_json, weight, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(5103, 5101, 5102, 'post-migration-lora.safetensors', 'safetensors', 'fp16', 'post migration LoRA', 'post migration LoRA', '[]', 1, timestamp, timestamp);
    } finally {
      mutate.close();
    }

    const reopened = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 40);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 5103').get().count, 1);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = 5103").get().count, 0);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(fixture);
  }
});

test('Issue #275 ordinary open reopens a configured kind after its last source row and vector are deleted by the formal trigger', async () => {
  const fixture = create035Database({ source: 'lora' });
  try {
    const database = openAt035(fixture);
    await migrateGenerationResourceVectors({
      database,
      repositoryRoot: fixture.repositoryRoot,
      readMigrationSql: () => readFileSync(resolve(ROOT, 'schema/database/036-generation-resource-vectors.sql'), 'utf8'),
      generationLoraMaintenance: { async prepare() { return { object_kind: 'generation_lora', embedding_model: 'reopen-model', vector: embeddingVector(3) }; } },
      artistPromptStringMaintenance: { async prepare() { return { object_kind: 'artist_prompt_string', embedding_model: 'reopen-model', vector: embeddingVector(4) }; } }
    });
    database.close();
    const mutate = new DatabaseSync(fixture.databasePath);
    try {
      mutate.prepare('DELETE FROM generation_loras WHERE id = 5003').run();
    } finally {
      mutate.close();
    }

    const reopened = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 40);
      assert.deepEqual(
        { ...reopened.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'generation_lora'").get() },
        { embedding_model: 'reopen-model', dimension: 1024 }
      );
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM generation_loras WHERE id = 5003").get().count, 0);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora'").get().count, 0);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(fixture);
  }
});

test('ordinary startup skips registered migration 036 and leaves pending migration 037 to validate its source schema', () => {
  const fixture = create035Database();
  const database = openAt035(fixture);
  database.prepare(`
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (36, '036-generation-resource-vectors', '2026-08-21T00:00:00Z')
  `).run();
  database.exec('PRAGMA user_version = 36;');
  database.close();
  try {
    assert.throws(
      () => openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, includeBuiltinComfyuiCatalog: false }),
      (error) => error instanceof VectorKnnMigrationError
        && /migration 036 vector_spaces must contain exactly six known object kinds/u.test(error.message)
    );
    const unchanged = new DatabaseSync(fixture.databasePath);
    try {
      assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 36);
      assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 4);
      assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 36').get().count, 1);
      assert.equal(unchanged.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%delete_vector_entries_after_delete'").get().count, 0);
    } finally {
      unchanged.close();
    }
  } finally {
    cleanup(fixture);
  }
});

test('Issue #275 ordinary open does not directly execute 036 SQL without its TEMP staging tables', () => {
  const fixture = create035Database();
  try {
    assert.doesNotThrow(() => {
      const database = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, includeBuiltinComfyuiCatalog: false });
      database.close();
    });
  } finally {
    cleanup(fixture);
  }
});
