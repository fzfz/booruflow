import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { migrateGenerationResourceVectors } from '../../app/catalog/generation-resource-vector-migration.mjs';
import { TRANSACTION_STATE, transactionStateOf } from '../../app/transaction-state.mjs';
import { OBJECT_KINDS, VECTOR_SOURCE_DEFINITIONS, VECTOR_SOURCE_TABLES } from '../../app/vector/vector-source-definitions.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const NEW_OBJECT_KINDS = ['generation_lora', 'artist_prompt_string'];
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
  const root = mkdtempSync(resolve(tmpdir(), 'issue-275-repository-'));
  const directory = resolve(root, 'schema/database');
  mkdirSync(directory, { recursive: true });
  for (const name of MIGRATION_NAMES) copyFileSync(resolve(ROOT, 'schema/database', name), resolve(directory, basename(name)));
  return root;
}

function vectorBlob(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

function fixture() {
  const repositoryRoot = repositoryWithout036();
  const database = openCatalogDatabase({
    databasePath: ':memory:',
    repositoryRoot,
    mediaRoot: resolve(repositoryRoot, 'media'),
    includeBuiltinComfyuiCatalog: false
  });
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES (5001, 'migration base', '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z');
    INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (
      5002, 5001, 'migration-model.safetensors', 'safetensors', 'fp16',
      'migration model', 'migration model usage', '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
    );
    INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (
      5003, 5001, 5002, 'migration-lora.safetensors', 'safetensors', 'fp16',
      'lora description', 'lora usage', '["lora_token"]', 1.0,
      '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
    );
    INSERT INTO artist_prompt_strings(
      id, title, description, artist_string, base_model_id, created_at, updated_at
    ) VALUES (
      5004, 'Migration Artist', 'artist description', 'migration_artist:1.2', 5001,
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
             ('character', 2, X'0000404000008040'),
             ('style', 3, X'0000A0400000C040'),
             ('prompt_term', 4, X'0000E04000000041');
  `);
  return { database, repositoryRoot };
}

function observedDatabase(database, events) {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'exec') {
        return (...args) => {
          events.push({ operation: 'exec', sql: String(args[0]) });
          return target.exec(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function migrationOptions(database, repositoryRoot, overrides = {}) {
  return {
    database,
    repositoryRoot,
    readMigrationSql: () => readFileSync(resolve(ROOT, 'schema/database/036-generation-resource-vectors.sql'), 'utf8'),
    generationLoraMaintenance: { async prepare() { return { object_kind: 'generation_lora', embedding_model: 'migration-model', vector: [3, 4, 0] }; } },
    artistPromptStringMaintenance: { async prepare() { return { object_kind: 'artist_prompt_string', embedding_model: 'migration-model', vector: [4, 3, 0] }; } },
    ...overrides
  };
}

function sqlObjectKindCheckValues(sql, tableName) {
  const table = new RegExp(`CREATE TABLE\\s+${tableName}\\s*\\(([\\s\\S]*?)\\);`, 'iu').exec(sql)?.[1] ?? '';
  const check = /CHECK\s*\(\s*object_kind\s+IN\s*\(([^()]*)\)\s*\)/iu.exec(table);
  return check === null ? [] : [...check[1].matchAll(/'([^']+)'/gu)].map(([, value]) => value);
}

function assert035(database) {
  assert.deepEqual(database.prepare('SELECT object_kind FROM vector_spaces ORDER BY object_kind').all().map(({ object_kind }) => object_kind), ['character', 'prompt_term', 'style', 'work']);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 36').get().count, 0);
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%delete_vector_entries_after_delete'").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_temp_master WHERE type = 'table' AND name LIKE 'migration_036_%'").get().count, 0);
}

test('Issue #275 keeps both 036 object_kind CHECK closed sets and delete trigger scopes aligned with the shared definitions', () => {
  const sql = readFileSync(resolve(ROOT, 'schema/database/036-generation-resource-vectors.sql'), 'utf8');
  for (const tableName of ['vector_spaces', 'vector_entries']) {
    assert.deepEqual(sqlObjectKindCheckValues(sql, tableName).sort(), [...OBJECT_KINDS].sort(), `${tableName} object_kind CHECK differs from shared OBJECT_KINDS`);
  }
  const triggerContracts = [
    ['generation_loras_delete_vector_entries_after_delete', 'generation_lora'],
    ['artist_prompt_strings_delete_vector_entries_after_delete', 'artist_prompt_string']
  ];
  for (const [triggerName, objectKind] of triggerContracts) {
    const definition = new RegExp(`CREATE TRIGGER\\s+${triggerName}\\s+[\\s\\S]*?AFTER\\s+DELETE\\s+ON\\s+(\\w+)[\\s\\S]*?DELETE\\s+FROM\\s+vector_entries\\s+WHERE\\s+object_kind\\s*=\\s*'([^']+)'\\s+AND\\s+object_id\\s*=\\s*OLD\\.id`, 'iu').exec(sql);
    assert.ok(definition, `${triggerName} must declare its source table and object kind`);
    assert.equal(definition[1], VECTOR_SOURCE_TABLES[objectKind]);
    assert.equal(definition[1], VECTOR_SOURCE_DEFINITIONS[objectKind].table);
    assert.equal(definition[2], objectKind);
  }
});

test('Issue #275 migrates a non-empty 035 database to six vector spaces atomically', async () => {
  const { database, repositoryRoot } = fixture();
  const events = [];
  try {
    const embeddingCalls = [];
    const generationLoraMaintenance = {
      async prepare(row) {
        events.push({ operation: 'embed', kind: 'generation_lora', id: row.id });
        embeddingCalls.push({ kind: 'generation_lora', id: row.id });
        return { object_kind: 'generation_lora', embedding_model: 'migration-model', vector: new Float32Array([3, 4, 0]) };
      }
    };
    const artistPromptStringMaintenance = {
      async prepare(row) {
        events.push({ operation: 'embed', kind: 'artist_prompt_string', id: row.id });
        embeddingCalls.push({ kind: 'artist_prompt_string', id: row.id });
        return { object_kind: 'artist_prompt_string', embedding_model: 'migration-model', vector: new Float32Array([4, 3, 0]) };
      }
    };
    const oldSpaces = database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all();
    const oldEntries = database.prepare('SELECT object_kind, object_id, embedding_f32 FROM vector_entries ORDER BY object_kind, object_id').all()
      .map((row) => ({ object_kind: row.object_kind, object_id: row.object_id, embedding_f32: Buffer.from(row.embedding_f32) }));
    const oldEntryCounts = database.prepare('SELECT object_kind, COUNT(*) AS count FROM vector_entries GROUP BY object_kind ORDER BY object_kind').all()
      .map((row) => ({ object_kind: row.object_kind, count: row.count }));

    const result = await migrateGenerationResourceVectors({
      database: observedDatabase(database, events),
      repositoryRoot,
      readMigrationSql: () => readFileSync(resolve(ROOT, 'schema/database/036-generation-resource-vectors.sql'), 'utf8'),
      generationLoraMaintenance,
      artistPromptStringMaintenance
    });

    assert.equal(result.status, 'complete');
    assert.deepEqual(embeddingCalls, [
      { kind: 'generation_lora', id: 5003 },
      { kind: 'artist_prompt_string', id: 5004 }
    ]);
    assert.deepEqual(database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all().map((row) => ({ ...row })), [
      { object_kind: 'artist_prompt_string', embedding_model: 'migration-model', dimension: 3 },
      { object_kind: 'character', embedding_model: 'old-character-model', dimension: 2 },
      { object_kind: 'generation_lora', embedding_model: 'migration-model', dimension: 3 },
      { object_kind: 'prompt_term', embedding_model: 'old-prompt-model', dimension: 2 },
      { object_kind: 'style', embedding_model: 'old-style-model', dimension: 2 },
      { object_kind: 'work', embedding_model: 'old-work-model', dimension: 2 }
    ]);
    const newEntries = database.prepare('SELECT object_kind, object_id, embedding_f32 FROM vector_entries ORDER BY object_kind, object_id').all()
      .map((row) => ({ object_kind: row.object_kind, object_id: row.object_id, embedding_f32: Buffer.from(row.embedding_f32) }));
    for (const oldEntry of oldEntries) {
      const current = newEntries.find(({ object_kind, object_id }) => object_kind === oldEntry.object_kind && object_id === oldEntry.object_id);
      assert.ok(current);
      assert.deepEqual(current.embedding_f32, oldEntry.embedding_f32);
    }
    assert.deepEqual(newEntries.filter(({ object_kind }) => ['work', 'character', 'style', 'prompt_term'].includes(object_kind))
      .reduce((counts, row) => counts.set(row.object_kind, (counts.get(row.object_kind) ?? 0) + 1), new Map()), new Map(oldEntryCounts.map(({ object_kind, count }) => [object_kind, count])));
    assert.deepEqual(newEntries.filter(({ object_kind }) => NEW_OBJECT_KINDS.includes(object_kind)).map(({ object_kind, object_id }) => ({ object_kind, object_id })), [
      { object_kind: 'generation_lora', object_id: 5003 },
      { object_kind: 'artist_prompt_string', object_id: 5004 }
    ].sort((left, right) => left.object_kind.localeCompare(right.object_kind)));
    assert.deepEqual({ ...database.prepare('SELECT version, name FROM schema_migrations WHERE version = 36').get() }, { version: 36, name: '036-generation-resource-vectors' });
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 36);
    assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'migration_036_%'").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_temp_master WHERE type = 'table' AND name LIKE 'migration_036_%'").get().count, 0);
    assert.ok(events.some(({ sql }) => /BEGIN\s+IMMEDIATE/iu.test(sql)));
    const beginIndex = events.findIndex(({ sql }) => /BEGIN\s+IMMEDIATE/iu.test(sql));
    assert.ok(beginIndex > -1);
    assert.ok(events.slice(0, beginIndex).every(({ operation }) => operation === 'embed' || operation === 'exec' || operation === undefined));
    assert.equal(events.findIndex((event, index) => index > beginIndex && event.operation === 'embed'), -1);
    const foreignKeysOffIndex = events.findIndex(({ sql }) => /PRAGMA\s+foreign_keys\s*=\s*OFF/iu.test(sql));
    assert.ok(foreignKeysOffIndex > -1 && foreignKeysOffIndex < beginIndex);
  } finally {
    database.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Issue #275 rejects source id, count, and updated_at drift before BEGIN IMMEDIATE', async () => {
  for (const [driftKind, driftMode] of [
    ['generation_lora', 'updated_at'],
    ['generation_lora', 'count'],
    ['generation_lora', 'id'],
    ['artist_prompt_string', 'updated_at'],
    ['artist_prompt_string', 'count'],
    ['artist_prompt_string', 'id']
  ]) {
    const { database, repositoryRoot } = fixture();
    const events = [];
    let mutated = false;
    try {
      const overrides = {
        generationLoraMaintenance: {
          async prepare(row) {
            if (driftKind === 'generation_lora' && !mutated) {
              mutated = true;
              if (driftMode === 'updated_at') database.prepare("UPDATE generation_loras SET updated_at = '2026-08-21T00:01:00Z' WHERE id = ?").run(row.id);
              if (driftMode === 'count' || driftMode === 'id') {
                if (driftMode === 'id') database.prepare('DELETE FROM generation_loras WHERE id = ?').run(row.id);
                database.prepare(`INSERT INTO generation_loras(
                  id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
                  description, usage, trigger_words_json, weight, created_at, updated_at
                ) VALUES (5005, 5001, 5002, 'drift-lora.safetensors', 'safetensors', 'fp16', 'drift', 'drift', '[]', 1.0, '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z')`).run();
              }
            }
            return { object_kind: 'generation_lora', embedding_model: 'migration-model', vector: [3, 4, 0] };
          }
        },
        artistPromptStringMaintenance: {
          async prepare(row) {
            if (driftKind === 'artist_prompt_string' && !mutated) {
              mutated = true;
              if (driftMode === 'updated_at') database.prepare("UPDATE artist_prompt_strings SET updated_at = '2026-08-21T00:01:00Z' WHERE id = ?").run(row.id);
              if (driftMode === 'count' || driftMode === 'id') {
                if (driftMode === 'id') database.prepare('DELETE FROM artist_prompt_strings WHERE id = ?').run(row.id);
                database.prepare(`INSERT INTO artist_prompt_strings(
                  id, title, description, artist_string, base_model_id, created_at, updated_at
                ) VALUES (5006, 'Drift Artist', 'drift description', 'drift_artist', 5001, '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z')`).run();
              }
            }
            return { object_kind: 'artist_prompt_string', embedding_model: 'migration-model', vector: [4, 3, 0] };
          }
        }
      };
      await assert.rejects(
        () => migrateGenerationResourceVectors(migrationOptions(observedDatabase(database, events), repositoryRoot, overrides)),
        (error) => error?.status === 'source_drift' && transactionStateOf(error) === TRANSACTION_STATE.NOT_STARTED
      );
      assert.equal(events.some(({ sql }) => /BEGIN\s+IMMEDIATE/iu.test(sql)), false);
      assert035(database);
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('Issue #275 rejects NaN, Infinity, zero, and inconsistent dimensions before permanent writes', async () => {
  const invalidCases = [
    ['nan', [Number.NaN, 0]],
    ['infinity', [Number.POSITIVE_INFINITY, 0]],
    ['zero', [0, 0]]
  ];
  for (const [label, vector] of invalidCases) {
    const { database, repositoryRoot } = fixture();
    const events = [];
    try {
      await assert.rejects(
        () => migrateGenerationResourceVectors(migrationOptions(observedDatabase(database, events), repositoryRoot, {
          generationLoraMaintenance: { async prepare() { return { object_kind: 'generation_lora', embedding_model: 'migration-model', vector }; } }
        })),
        (error) => error?.status === 'invalid_embedding' && transactionStateOf(error) === TRANSACTION_STATE.NOT_STARTED,
        label
      );
      assert.equal(events.some(({ sql }) => /BEGIN\s+IMMEDIATE/iu.test(sql)), false);
      assert035(database);
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }

  const { database, repositoryRoot } = fixture();
  const events = [];
  try {
    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (
      5005, 5001, 5002, 'second-migration-lora.safetensors', 'safetensors', 'fp16',
      'second lora description', 'second lora usage', '[]', 1.0,
      '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
    )`).run();
    await assert.rejects(
      () => migrateGenerationResourceVectors(migrationOptions(observedDatabase(database, events), repositoryRoot, {
        generationLoraMaintenance: {
          async prepare(row) {
            return { object_kind: 'generation_lora', embedding_model: 'migration-model', vector: row.id === 5003 ? [1, 0] : [1, 0, 0] };
          }
        }
      })),
      (error) => error?.status === 'invalid_embedding' && transactionStateOf(error) === TRANSACTION_STATE.NOT_STARTED
    );
    assert.equal(events.some(({ sql }) => /BEGIN\s+IMMEDIATE/iu.test(sql)), false);
    assert035(database);
  } finally {
    database.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Issue #275 does not begin a permanent transaction when prepare(sourceRow) fails', async () => {
  const { database, repositoryRoot } = fixture();
  const events = [];
  try {
    await assert.rejects(
      () => migrateGenerationResourceVectors(migrationOptions(observedDatabase(database, events), repositoryRoot, {
        generationLoraMaintenance: { async prepare() { throw new Error('injected embedding failure'); } }
      })),
      (error) => error?.status === 'embedding_failed'
        && transactionStateOf(error) === TRANSACTION_STATE.NOT_STARTED
        && error.evidence.no_write_transaction_started === true
    );
    assert.equal(events.some(({ sql }) => /BEGIN\s+IMMEDIATE/iu.test(sql)), false);
    assert035(database);
  } finally {
    database.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Issue #275 rolls deterministic SQL failure back to 035 and restores foreign_keys', async () => {
  const { database, repositoryRoot } = fixture();
  try {
    await assert.rejects(
      () => migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot, {
        readMigrationSql: () => `${readFileSync(resolve(ROOT, 'schema/database/036-generation-resource-vectors.sql'), 'utf8')}\nSELECT * FROM issue_275_missing_table;`
      })),
      (error) => error?.status === 'rolled_back' && transactionStateOf(error) === TRANSACTION_STATE.ROLLED_BACK
    );
    assert035(database);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 35);
  } finally {
    database.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Issue #275 rejects a non-contiguous or non-035 source ledger before prepare', async () => {
  for (const [label, mutate] of [
    ['missing middle ledger row', (database) => database.prepare('DELETE FROM schema_migrations WHERE version = 17').run()],
    ['highest ledger row is not 35', (database) => database.prepare('DELETE FROM schema_migrations WHERE version = 35').run()],
    ['ledger contains a version above 35', (database) => database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (37, '037-unexpected', '2026-08-21T00:00:00Z')").run()],
    ['user_version is not 35', (database) => database.exec('PRAGMA user_version = 34;')]
  ]) {
    const { database, repositoryRoot } = fixture();
    const events = [];
    let calls = 0;
    try {
      mutate(database);
      await assert.rejects(
        () => migrateGenerationResourceVectors(migrationOptions(observedDatabase(database, events), repositoryRoot, {
          generationLoraMaintenance: { async prepare() { calls += 1; return { object_kind: 'generation_lora', embedding_model: 'migration-model', vector: [1, 0] }; } },
          artistPromptStringMaintenance: { async prepare() { calls += 1; return { object_kind: 'artist_prompt_string', embedding_model: 'migration-model', vector: [1, 0] }; } }
        })),
        (error) => error?.status === 'source_schema_not_ready'
          && transactionStateOf(error) === TRANSACTION_STATE.NOT_STARTED,
        label
      );
      assert.equal(calls, 0);
      assert.equal(events.some(({ sql }) => /BEGIN\s+IMMEDIATE/iu.test(sql)), false);
      assert.equal(events.some(({ sql }) => /PRAGMA\s+foreign_keys\s*=\s*OFF/iu.test(sql)), false);
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('Issue #275 rolls back a failure at the first schema swap and never reaches COMMIT', async () => {
  const { database, repositoryRoot } = fixture();
  const events = [];
  try {
    await assert.rejects(
      () => migrateGenerationResourceVectors(migrationOptions(observedDatabase(database, events), repositoryRoot, {
        readMigrationSql: () => readFileSync(resolve(ROOT, 'schema/database/036-generation-resource-vectors.sql'), 'utf8')
          .replace('ALTER TABLE vector_spaces RENAME TO vector_spaces_035;', 'ALTER TABLE vector_spaces RENAME TO vector_spaces_035;\nSELECT * FROM issue_275_missing_table;')
      })),
      (error) => error?.status === 'rolled_back' && transactionStateOf(error) === TRANSACTION_STATE.ROLLED_BACK
    );
    assert035(database);
    assert.equal(events.some(({ sql }) => /^\s*COMMIT\s*;?\s*$/iu.test(sql)), false);
  } finally {
    database.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Issue #275 fails its transaction assertions before COMMIT when staged BLOB length disagrees with a new space', async () => {
  const { database, repositoryRoot } = fixture();
  const events = [];
  try {
    await assert.rejects(
      () => migrateGenerationResourceVectors(migrationOptions(observedDatabase(database, events), repositoryRoot, {
        readMigrationSql: () => readFileSync(resolve(ROOT, 'schema/database/036-generation-resource-vectors.sql'), 'utf8')
          .replace('DROP TABLE vector_entries_035;', "UPDATE vector_spaces SET dimension = dimension + 1 WHERE object_kind = 'generation_lora';\nDROP TABLE vector_entries_035;")
      })),
      (error) => error?.status === 'rolled_back' && transactionStateOf(error) === TRANSACTION_STATE.ROLLED_BACK
    );
    assert035(database);
    assert.equal(events.some(({ sql }) => /^\s*COMMIT\s*;?\s*$/iu.test(sql)), false);
  } finally {
    database.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Issue #275 requires exact deletion trigger scope for already_complete convergence', async () => {
  const { database, repositoryRoot } = fixture();
  try {
    await migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot));
    database.exec(`
      DROP TRIGGER generation_loras_delete_vector_entries_after_delete;
      CREATE TRIGGER generation_loras_delete_vector_entries_after_delete
      AFTER DELETE ON generation_loras
      BEGIN
        DELETE FROM vector_entries
        WHERE object_kind = 'artist_prompt_string' AND object_id = OLD.id;
      END;
    `);
    let calls = 0;
    await assert.rejects(
      () => migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot, {
        generationLoraMaintenance: { async prepare() { calls += 1; throw new Error('registered non-convergence must not prepare'); } },
        artistPromptStringMaintenance: { async prepare() { calls += 1; throw new Error('registered non-convergence must not prepare'); } }
      })),
      (error) => error?.status === 'registered_not_converged'
        && transactionStateOf(error) === TRANSACTION_STATE.NOT_STARTED
    );
    assert.equal(calls, 0);
  } finally {
    database.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Issue #275 marks COMMIT and ROLLBACK control failures UNCERTAIN and stops connection use', async () => {
  {
    const { database, repositoryRoot } = fixture();
    try {
      let uncertain = false;
      const failingDatabase = new Proxy(database, {
        get(target, property) {
          if (property === 'exec') {
            return (sql) => {
              if (uncertain) throw new Error('connection used after uncertainty');
              if (/^\s*COMMIT/iu.test(String(sql))) {
                uncertain = true;
                throw new Error('injected COMMIT failure');
              }
              return target.exec(sql);
            };
          }
          if (property === 'prepare') {
            return (...args) => {
              if (uncertain) throw new Error('connection used after uncertainty');
              return target.prepare(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      let migrationError;
      await assert.rejects(
        () => migrateGenerationResourceVectors(migrationOptions(failingDatabase, repositoryRoot)),
        (error) => {
          migrationError = error;
          return error?.status === 'uncertain'
          && transactionStateOf(error) === TRANSACTION_STATE.UNCERTAIN
          && error.connectionMustClose === true
          && error.evidence.no_further_connection_use === true
          && error.originalError?.message === 'injected COMMIT failure';
        }
      );
      assert.equal(migrationError.status, 'uncertain');
      assert.throws(() => failingDatabase.exec('SELECT 1;'), /connection used after uncertainty/u);
      assert.throws(() => failingDatabase.prepare('SELECT 1;'), /connection used after uncertainty/u);
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
  {
    const { database, repositoryRoot } = fixture();
    try {
      let uncertain = false;
      const failingDatabase = new Proxy(database, {
        get(target, property) {
          if (property === 'exec') {
            return (sql) => {
              if (uncertain) throw new Error('connection used after uncertainty');
              if (/^\s*ROLLBACK/iu.test(String(sql))) {
                uncertain = true;
                throw new Error('injected ROLLBACK failure');
              }
              return target.exec(sql);
            };
          }
          if (property === 'prepare') {
            return (...args) => {
              if (uncertain) throw new Error('connection used after uncertainty');
              return target.prepare(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      let migrationError;
      await assert.rejects(
        () => migrateGenerationResourceVectors(migrationOptions(failingDatabase, repositoryRoot, { readMigrationSql: () => 'SELECT * FROM issue_275_missing_table;' })),
        (error) => {
          migrationError = error;
          return error?.status === 'uncertain'
          && transactionStateOf(error) === TRANSACTION_STATE.UNCERTAIN
          && error.connectionMustClose === true
          && error.evidence.no_further_connection_use === true
          && error.originalError?.message?.includes('no such table: issue_275_missing_table');
        }
      );
      assert.equal(migrationError.status, 'uncertain');
      assert.equal(migrationError.rollbackError?.message, 'injected ROLLBACK failure');
      assert.throws(() => failingDatabase.exec('SELECT 1;'), /connection used after uncertainty/u);
      assert.throws(() => failingDatabase.prepare('SELECT 1;'), /connection used after uncertainty/u);
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('Issue #275 uses the same SQL for empty sources and makes zero model calls', async () => {
  const { database, repositoryRoot } = fixture();
  let calls = 0;
  let sqlReads = 0;
  try {
    database.prepare('DELETE FROM generation_loras WHERE id = 5003').run();
    database.prepare('DELETE FROM artist_prompt_strings WHERE id = 5004').run();
    const result = await migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot, {
      readMigrationSql: () => {
        sqlReads += 1;
        return readFileSync(resolve(ROOT, 'schema/database/036-generation-resource-vectors.sql'), 'utf8');
      },
      generationLoraMaintenance: null,
      artistPromptStringMaintenance: null
    }));
    assert.equal(result.status, 'complete');
    assert.equal(result.embedding_calls, 0);
    assert.equal(calls, 0);
    assert.equal(sqlReads, 1);
    assert.deepEqual(database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces WHERE object_kind IN (\'generation_lora\', \'artist_prompt_string\') ORDER BY object_kind').all().map((row) => ({ ...row })), [
      { object_kind: 'artist_prompt_string', embedding_model: '__unconfigured__', dimension: 1 },
      { object_kind: 'generation_lora', embedding_model: '__unconfigured__', dimension: 1 }
    ]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind IN ('generation_lora', 'artist_prompt_string')").get().count, 0);
  } finally {
    database.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Issue #275 returns already_complete with zero model calls and rejects a registered non-converged migration', async () => {
  {
    const { database, repositoryRoot } = fixture();
    try {
      await migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot));
      database.exec('PRAGMA user_version = 37;');
      let calls = 0;
      const result = await migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot, {
        generationLoraMaintenance: { async prepare() { calls += 1; throw new Error('already-complete must not embed'); } },
        artistPromptStringMaintenance: { async prepare() { calls += 1; throw new Error('already-complete must not embed'); } }
      }));
      assert.equal(result.status, 'already_complete');
      assert.equal(result.embedding_calls, 0);
      assert.equal(calls, 0);
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
  {
    const { database, repositoryRoot } = fixture();
    try {
      database.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (36, '036-generation-resource-vectors', '2026-08-21T00:00:00Z')").run();
      database.exec('PRAGMA user_version = 36;');
      let calls = 0;
      await assert.rejects(
        () => migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot, {
          generationLoraMaintenance: { async prepare() { calls += 1; return { object_kind: 'generation_lora', embedding_model: 'migration-model', vector: [1, 0] }; } },
          artistPromptStringMaintenance: { async prepare() { calls += 1; return { object_kind: 'artist_prompt_string', embedding_model: 'migration-model', vector: [1, 0] }; } }
        })),
        (error) => error?.status === 'registered_not_converged' && transactionStateOf(error) === TRANSACTION_STATE.NOT_STARTED
      );
      assert.equal(calls, 0);
      assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('Issue #275 accepts a configured kind after its last source row is deleted by the formal vector trigger without embedding', async () => {
  const { database, repositoryRoot } = fixture();
  try {
    await migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot));
    database.prepare('DELETE FROM generation_loras WHERE id = 5003').run();
    let calls = 0;
    const result = await migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot, {
      generationLoraMaintenance: { async prepare() { calls += 1; throw new Error('reopen must not embed deleted source'); } },
      artistPromptStringMaintenance: { async prepare() { calls += 1; throw new Error('reopen must not embed existing source'); } }
    }));
    assert.equal(result.status, 'already_complete');
    assert.equal(result.embedding_calls, 0);
    assert.equal(calls, 0);
    assert.deepEqual(
      { ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'generation_lora'").get() },
      { embedding_model: 'migration-model', dimension: 3 }
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora'").get().count, 0);
  } finally {
    database.close();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Issue #275 keeps non-empty source gaps and invalid unconfigured empty spaces as hard convergence failures', async () => {
  for (const [label, mutate] of [
    ['non-empty source without vector', (database) => database.prepare("DELETE FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = 5003").run()],
    ['empty unconfigured source with dimension other than one', (database) => {
      database.prepare('DELETE FROM generation_loras WHERE id = 5003').run();
      database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__', dimension = 2 WHERE object_kind = 'generation_lora'").run();
    }]
  ]) {
    const { database, repositoryRoot } = fixture();
    try {
      await migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot));
      mutate(database);
      let calls = 0;
      await assert.rejects(
        () => migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot, {
          generationLoraMaintenance: { async prepare() { calls += 1; throw new Error(`${label} must not embed`); } },
          artistPromptStringMaintenance: { async prepare() { calls += 1; throw new Error(`${label} must not embed`); } }
        })),
        (error) => error?.status === 'registered_not_converged' && transactionStateOf(error) === TRANSACTION_STATE.NOT_STARTED,
        label
      );
      assert.equal(calls, 0);
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('Issue #275 deletion triggers clean direct and generation-model-cascade LoRA and artist vectors', async () => {
  {
    const { database, repositoryRoot } = fixture();
    try {
      await migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot));
      database.prepare('DELETE FROM generation_loras WHERE id = 5003').run();
      database.prepare('DELETE FROM artist_prompt_strings WHERE id = 5004').run();
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = 5003").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = 5004").get().count, 0);
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
  {
    const { database, repositoryRoot } = fixture();
    try {
      await migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot));
      database.prepare('DELETE FROM generation_models WHERE id = 5002').run();
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 5003').get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = 5003").get().count, 0);
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
  {
    const { database, repositoryRoot } = fixture();
    try {
      await migrateGenerationResourceVectors(migrationOptions(database, repositoryRoot));
      const artistVectorBeforeCascade = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = 5004").get().embedding_f32);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'generation_loras_delete_vector_entries_after_delete'").get().count, 1);
      database.prepare('DELETE FROM generation_base_models WHERE id = 5001').run();
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 5002').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 5003').get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = 5003").get().count, 0);
      assert.deepEqual({ ...database.prepare('SELECT id, base_model_id FROM artist_prompt_strings WHERE id = 5004').get() }, { id: 5004, base_model_id: null });
      assert.deepEqual(
        Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = 5004").get().embedding_f32),
        artistVectorBeforeCascade
      );
    } finally {
      database.close();
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});
