import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const migrationDirectory = resolve(repositoryRoot, 'schema/database');
const migration24 = readFileSync(resolve(migrationDirectory, '024-generation-lora-trigger-weight.sql'), 'utf8');
const candidates = JSON.parse(readFileSync(resolve(repositoryRoot, 'tests/fixtures/migrations/lora-trigger-weight.json'), 'utf8'));
const temporaryDirectories = [];
const EXISTING_COLUMNS = Object.freeze([
  'id', 'base_model_id', 'model_id', 'file_name', 'file_format', 'precision_or_quantization',
  'author', 'version', 'release_url', 'description', 'usage', 'cover_media_path', 'created_at', 'updated_at'
]);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createVersion23FileDatabase({ includeBuiltinComfyuiCatalog = true } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'noobai-lora-024-v23-'));
  temporaryDirectories.push(root);
  const isolatedRepository = resolve(root, 'repository');
  const targetMigrationDirectory = resolve(isolatedRepository, 'schema/database');
  const databasePath = resolve(root, 'app.sqlite');
  const mediaRoot = resolve(root, 'media');
  mkdirSync(targetMigrationDirectory, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });
  for (const migration of listOrderedMigrations(migrationDirectory).filter(({ version }) => version <= 23)) {
    cpSync(migration.path, resolve(targetMigrationDirectory, migration.path.split('/').at(-1)));
  }
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot: isolatedRepository });
  const database = openCatalogDatabase({
    databasePath,
    mediaRoot,
    repositoryRoot: isolatedRepository,
    includeBuiltinComfyuiCatalog
  });
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 23);
  return { database, databasePath, mediaRoot, repositoryRoot: isolatedRepository };
}

function extendRepositoryThrough35(repositoryRoot) {
  const targetMigrationDirectory = resolve(repositoryRoot, 'schema/database');
  for (const migration of listOrderedMigrations(migrationDirectory).filter(({ version }) => version >= 24 && version <= 35)) {
    cpSync(migration.path, resolve(targetMigrationDirectory, migration.path.split('/').at(-1)));
  }
}

function cloneClosedDatabase(databasePath, prefix) {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  temporaryDirectories.push(root);
  const clonePath = resolve(root, 'app.sqlite');
  cpSync(databasePath, clonePath);
  return clonePath;
}

function rows(database, sql, ...parameters) {
  return database.prepare(sql).all(...parameters).map((row) => ({ ...row }));
}

function existingSnapshot(database) {
  return rows(database, `SELECT ${EXISTING_COLUMNS.join(', ')} FROM generation_loras ORDER BY id`);
}

function loraForIdentity(database, identity) {
  return database.prepare(`SELECT lora.*
    FROM generation_loras AS lora
    JOIN generation_base_models AS base ON base.id = lora.base_model_id
    JOIN generation_models AS model ON model.id = lora.model_id
    WHERE base.name = ?
      AND model.file_name = ?
      AND model.file_format = ?
      AND model.precision_or_quantization = ?
      AND COALESCE(model.version, '') = COALESCE(?, '')
      AND lora.file_name = ?
      AND lora.file_format = ?
      AND lora.precision_or_quantization = ?
      AND COALESCE(lora.version, '') = COALESCE(?, '')`).get(
    identity.base_model_name,
    identity.model_file_name,
    identity.model_file_format,
    identity.model_precision_or_quantization,
    identity.model_version,
    identity.lora_file_name,
    identity.lora_file_format,
    identity.lora_precision_or_quantization,
    identity.lora_version
  );
}

function assertVersion23Rollback(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 23);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 24").get().count, 0);
    const columns = database.prepare('PRAGMA table_info(generation_loras)').all().map(({ name }) => name);
    assert.equal(columns.includes('trigger_words_json'), false);
    assert.equal(columns.includes('weight'), false);
  } finally {
    database.close();
  }
}

function assertMigrationRejected(databasePath, mediaRoot, repositoryRoot) {
  extendRepositoryThrough35(repositoryRoot);
  assert.throws(
    () => openCatalogDatabase({ databasePath, mediaRoot, repositoryRoot, includeBuiltinComfyuiCatalog: true }),
    /CHECK constraint failed: valid = 1/u
  );
  assertVersion23Rollback(databasePath);
}

test('024 migrates all approved records, preserves non-approved columns and is idempotent after reopen', () => {
  const { database, databasePath, mediaRoot, repositoryRoot } = createVersion23FileDatabase();
  const ledgerBefore = rows(database, 'SELECT version, name FROM schema_migrations ORDER BY version');
  const columnsBefore = database.prepare('PRAGMA table_info(generation_loras)').all().map(({ name }) => name);
  const snapshotBefore = existingSnapshot(database);
  try {
    database.exec(migration24);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 24);
    const ledgerAfter = rows(database, 'SELECT version, name FROM schema_migrations ORDER BY version');
    assert.deepEqual(ledgerAfter.slice(0, -1), ledgerBefore);
    assert.deepEqual(ledgerAfter.at(-1), { version: 24, name: '024-generation-lora-trigger-weight' });

    const tableInfo = database.prepare('PRAGMA table_info(generation_loras)').all().map((row) => ({ ...row }));
    assert.deepEqual(tableInfo.map(({ name }) => name), [...columnsBefore, 'trigger_words_json', 'weight']);
    const triggerWordsColumn = tableInfo.find(({ name }) => name === 'trigger_words_json');
    const weightColumn = tableInfo.find(({ name }) => name === 'weight');
    assert.deepEqual({ notnull: triggerWordsColumn.notnull, defaultValue: triggerWordsColumn.dflt_value }, { notnull: 1, defaultValue: "'[]'" });
    assert.deepEqual({ notnull: weightColumn.notnull, defaultValue: weightColumn.dflt_value }, { notnull: 1, defaultValue: '1.0' });

    for (const candidate of candidates.records) {
      const replayIdentity = [3, 4, 9].includes(candidate.source_id)
        ? { ...candidate.identity, model_precision_or_quantization: 'none' }
        : candidate.identity;
      const row = loraForIdentity(database, replayIdentity);
      assert.ok(row, `missing migrated identity ${candidate.source_id}`);
      assert.deepEqual(JSON.parse(row.trigger_words_json), candidate.trigger_words, `trigger words differ for ${candidate.source_id}`);
      assert.equal(row.weight, candidate.weight, `weight differs for ${candidate.source_id}`);
    }

    const candidateById = new Map(candidates.records.map((candidate) => [candidate.source_id, candidate]));
    const snapshotAfter = existingSnapshot(database);
    assert.equal(snapshotAfter.length, snapshotBefore.length);
    for (let index = 0; index < snapshotBefore.length; index += 1) {
      const before = snapshotBefore[index];
      const candidate = candidateById.get(before.id);
      const expected = {
        ...before,
        ...(candidate.description_update === undefined ? {} : { description: candidate.description_update }),
        ...(candidate.usage_update === undefined ? {} : { usage: candidate.usage_update })
      };
      assert.deepEqual(snapshotAfter[index], expected, `existing columns changed unexpectedly for ${before.id}`);
    }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }

  extendRepositoryThrough35(repositoryRoot);
  const reopened = openCatalogDatabase({ databasePath, mediaRoot, repositoryRoot, includeBuiltinComfyuiCatalog: true });
  try {
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 35);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 24').get().count, 1);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, 62);
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    reopened.close();
  }
});

test('024 accepts the audited production Krea2 precision and defaults two added user LoRAs', () => {
  const { database } = createVersion23FileDatabase();
  try {
    const timestamp = '2026-08-12T00:00:00Z';
    const model = database.prepare("SELECT id, base_model_id FROM generation_models WHERE file_name = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'").get();
    database.prepare("UPDATE generation_models SET precision_or_quantization = 'other' WHERE id = ?").run(model.id);
    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, description, usage, created_at, updated_at
    ) VALUES (900, ?, ?, 'user-added.safetensors', 'safetensors', 'none', 'user author', 'v1',
      'https://example.test/user', 'user description', 'user usage', ?, ?)`).run(model.base_model_id, model.id, timestamp, timestamp);
    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) SELECT 901, base_model_id, model_id, file_name, 'ckpt', precision_or_quantization,
      'variant description', 'variant usage', ?, ? FROM generation_loras WHERE id = 13`).run(timestamp, timestamp);
    const before = rows(database, `SELECT ${EXISTING_COLUMNS.join(', ')} FROM generation_loras WHERE id IN (900, 901) ORDER BY id`);

    database.exec(migration24);

    for (const candidate of candidates.records) {
      const productionIdentity = candidate.identity.model_file_name === 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf'
        ? { ...candidate.identity, model_precision_or_quantization: 'other' }
        : [3, 4, 9].includes(candidate.source_id)
          ? { ...candidate.identity, model_precision_or_quantization: 'none' }
          : candidate.identity;
      const migrated = loraForIdentity(database, productionIdentity);
      assert.ok(migrated, `missing production identity ${candidate.source_id}`);
      assert.deepEqual(JSON.parse(migrated.trigger_words_json), candidate.trigger_words, `production trigger words differ for ${candidate.source_id}`);
      assert.equal(migrated.weight, candidate.weight, `production weight differs for ${candidate.source_id}`);
    }
    assert.deepEqual(rows(database, 'SELECT trigger_words_json, weight FROM generation_loras WHERE id IN (900, 901) ORDER BY id'), [
      { trigger_words_json: '[]', weight: 1 },
      { trigger_words_json: '[]', weight: 1 }
    ]);
    assert.deepEqual(rows(database, `SELECT ${EXISTING_COLUMNS.join(', ')} FROM generation_loras WHERE id IN (900, 901) ORDER BY id`), before);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, 64);
  } finally {
    database.close();
  }
});

test('024 column constraints reject invalid JSON and nonnumeric weight while preserving SQLite REAL affinity', () => {
  const { database } = createVersion23FileDatabase();
  try {
    database.exec(migration24);
    assert.throws(() => database.prepare("UPDATE generation_loras SET trigger_words_json = 'not-json' WHERE id = 1").run(), /CHECK constraint failed/u);
    assert.throws(() => database.prepare("UPDATE generation_loras SET trigger_words_json = '{}' WHERE id = 1").run(), /CHECK constraint failed/u);
    assert.throws(() => database.prepare('UPDATE generation_loras SET weight = NULL WHERE id = 1').run(), /NOT NULL constraint failed/u);
    assert.throws(() => database.prepare("UPDATE generation_loras SET weight = 'abc' WHERE id = 1").run(), /CHECK constraint failed/u);

    database.prepare("UPDATE generation_loras SET weight = '1.25' WHERE id = 1").run();
    assert.deepEqual({ ...database.prepare('SELECT weight, typeof(weight) AS storage_type FROM generation_loras WHERE id = 1').get() }, { weight: 1.25, storage_type: 'real' });
    database.prepare('UPDATE generation_loras SET weight = 1 WHERE id = 1').run();
    assert.deepEqual({ ...database.prepare('SELECT weight, typeof(weight) AS storage_type FROM generation_loras WHERE id = 1').get() }, { weight: 1, storage_type: 'real' });
  } finally {
    database.close();
  }
});

test('024 rolls back its columns and ledger when a generation_loras update trigger aborts the mapping write', () => {
  const { database, databasePath, mediaRoot, repositoryRoot } = createVersion23FileDatabase();
  database.exec(`CREATE TRIGGER migration_024_reject_lora_update
    BEFORE UPDATE ON generation_loras
    WHEN OLD.id = 1
    BEGIN
      SELECT RAISE(ABORT, 'forced migration 024 lora update failure');
    END;`);
  database.close();

  extendRepositoryThrough35(repositoryRoot);
  assert.throws(
    () => openCatalogDatabase({ databasePath, mediaRoot, repositoryRoot, includeBuiltinComfyuiCatalog: true }),
    /forced migration 024 lora update failure/u
  );
  assertVersion23Rollback(databasePath);
});

test('024 runs as a structural migration when the built-in catalog is disabled', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 40);
    assert.deepEqual({ ...database.prepare('SELECT version, name FROM schema_migrations WHERE version = 24').get() }, {
      version: 24,
      name: '024-generation-lora-trigger-weight'
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, 0);
    const columns = database.prepare('PRAGMA table_info(generation_loras)').all().map(({ name }) => name);
    assert.ok(columns.includes('trigger_words_json'));
    assert.ok(columns.includes('weight'));
  } finally {
    database.close();
  }
});

test('024 resolves approved trigger, weight and text updates by identity after the audited source id changes', () => {
  const { database } = createVersion23FileDatabase();
  try {
    const sourceId = 13;
    const candidate = candidates.records.find((record) => record.source_id === sourceId);
    assert.ok(candidate?.usage_update);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE lora_id = ?').get(sourceId).count, 0);
    const original = { ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(sourceId) };
    database.prepare('DELETE FROM generation_loras WHERE id = ?').run(sourceId);
    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, description, usage, cover_media_path, created_at, updated_at
    ) VALUES (999, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      original.base_model_id, original.model_id, original.file_name, original.file_format,
      original.precision_or_quantization, original.author, original.version, original.release_url,
      original.description, original.usage, original.cover_media_path, original.created_at, original.updated_at
    );

    database.exec(migration24);

    assert.deepEqual({ ...database.prepare('SELECT id, trigger_words_json, weight, description, usage FROM generation_loras WHERE id = 999').get() }, {
      id: 999,
      trigger_words_json: JSON.stringify(candidate.trigger_words),
      weight: candidate.weight,
      description: original.description,
      usage: candidate.usage_update
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = ?').get(sourceId).count, 0);
  } finally {
    database.close();
  }
});

test('024 rolls back for every changed identity component and for a nonempty zero-match database', () => {
  const base = createVersion23FileDatabase();
  base.database.close();
  const mutations = [
    ['base model name', "UPDATE generation_base_models SET name = 'drifted-anima' WHERE name = 'anima'"],
    ['model file name', "UPDATE generation_models SET file_name = 'drifted-model.safetensors' WHERE file_name = 'anima_aesthetic-v1.1.safetensors'"],
    ['model file format', "UPDATE generation_models SET file_format = 'other' WHERE file_name = 'anima_aesthetic-v1.1.safetensors'"],
    ['model precision', "UPDATE generation_models SET precision_or_quantization = 'fp16' WHERE file_name = 'anima_aesthetic-v1.1.safetensors'"],
    ['model version', "UPDATE generation_models SET version = 'drifted-version' WHERE file_name = 'anima_aesthetic-v1.1.safetensors'"],
    ['LoRA file name', "UPDATE generation_loras SET file_name = 'drifted-lora.safetensors' WHERE id = 1"],
    ['LoRA file format', "UPDATE generation_loras SET file_format = 'ckpt' WHERE id = 1"],
    ['LoRA precision', "UPDATE generation_loras SET precision_or_quantization = 'fp16' WHERE id = 1"],
    ['LoRA version', "UPDATE generation_loras SET version = 'drifted-version' WHERE id = 1"],
    ['nonempty zero match', "UPDATE generation_base_models SET name = 'drifted-' || id"]
  ];

  for (const [label, sql] of mutations) {
    const databasePath = cloneClosedDatabase(base.databasePath, 'noobai-lora-024-drift-');
    const drifted = new DatabaseSync(databasePath);
    try {
      drifted.exec('PRAGMA foreign_keys = ON;');
      drifted.exec(sql);
    } finally {
      drifted.close();
    }
    assertMigrationRejected(databasePath, base.mediaRoot, base.repositoryRoot);
  }
});

test('024 rolls back when one approved identity resolves to duplicate LoRA rows', () => {
  const base = createVersion23FileDatabase();
  base.database.close();
  const databasePath = cloneClosedDatabase(base.databasePath, 'noobai-lora-024-duplicate-');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = ON; DROP INDEX generation_loras_identity_uq;');
    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, description, usage, cover_media_path, created_at, updated_at
    ) SELECT 999, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, description, usage, cover_media_path, created_at, updated_at
      FROM generation_loras WHERE id = 62`).run();
  } finally {
    database.close();
  }
  assertMigrationRejected(databasePath, base.mediaRoot, base.repositoryRoot);
});
