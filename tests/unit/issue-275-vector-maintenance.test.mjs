import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

import { CatalogTransactionError } from '../../app/catalog/database.mjs';
import { createArtistPromptStringVectorMaintenance } from '../../app/vector/artist-prompt-string-semantic.mjs';
import { createGenerationLoraVectorMaintenance } from '../../app/vector/generation-lora-semantic.mjs';
import {
  OBJECT_KINDS as SHARED_OBJECT_KINDS,
  VECTOR_SOURCE_DEFINITIONS,
  VECTOR_SOURCE_TABLES
} from '../../app/vector/vector-source-definitions.mjs';
import { deleteVectorEntry, OBJECT_KINDS, rebuildVectorEntries, upsertVectorEntry } from '../../app/vector/vector-store.mjs';
import { TRANSACTION_STATE } from '../../app/transaction-state.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const configuration = Object.freeze({ embedding_model: 'fake' });

function databaseFixture() {
  const database = new DatabaseSync(':memory:', { allowExtension: true });
  sqliteVec.load(database);
  database.exec(`
    CREATE TABLE vector_spaces (
      object_kind TEXT PRIMARY KEY,
      embedding_model TEXT NOT NULL,
      dimension INTEGER NOT NULL
    );
    CREATE TABLE vector_entries (
      object_kind TEXT NOT NULL,
      object_id INTEGER NOT NULL,
      embedding_f32 BLOB NOT NULL,
      PRIMARY KEY (object_kind, object_id)
    );
    CREATE VIRTUAL TABLE vector_knn_index USING vec0(
      object_kind TEXT partition key,
      object_id INTEGER,
      embedding FLOAT[1024]
    );
    CREATE TABLE generation_loras (
      id INTEGER PRIMARY KEY,
      file_name TEXT NOT NULL,
      description TEXT NOT NULL,
      usage TEXT NOT NULL,
      trigger_words_json TEXT NOT NULL
    );
    CREATE TABLE artist_prompt_strings (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      artist_string TEXT NOT NULL,
      base_model_id INTEGER
    );
    CREATE TABLE artist_prompt_string_styles (
      artist_prompt_string_id INTEGER NOT NULL,
      style_id INTEGER NOT NULL
    );
    CREATE TABLE styles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE prompt_terms (id INTEGER PRIMARY KEY);
    INSERT INTO vector_spaces(object_kind, embedding_model, dimension) VALUES
      ('work', 'fake', 1024),
      ('character', 'fake', 1024),
      ('style', 'fake', 1024),
      ('prompt_term', 'fake', 1024),
      ('generation_lora', 'fake', 1024),
      ('artist_prompt_string', 'fake', 1024);
    INSERT INTO generation_loras(id, file_name, description, usage, trigger_words_json)
      VALUES (1, 'portrait.safetensors', 'changes portrait details', 'use at 0.8', '["portrait_token", "second_token"]');
    INSERT INTO artist_prompt_strings(id, title, description, artist_string, base_model_id)
      VALUES (1, 'Artist One', 'artist description', 'artist_one:1.2', 7);
    INSERT INTO styles(id, name) VALUES (1, 'style relation must not be projected');
    INSERT INTO artist_prompt_string_styles(artist_prompt_string_id, style_id) VALUES (1, 1);
    INSERT INTO prompt_terms(id) VALUES (99);
  `);
  upsertVectorEntry(database, 'generation_lora', 1, createFixtureVector(0, 1), { expectedModel: 'fake' });
  upsertVectorEntry(database, 'generation_lora', 99, createFixtureVector(0, 1), { expectedModel: 'fake' });
  upsertVectorEntry(database, 'prompt_term', 99, createFixtureVector(0, 1), { expectedModel: 'fake' });
  return database;
}

function vectorBlob(values = createFixtureVector()) {
  return Buffer.from(new Float32Array(values).buffer);
}

function modelClient({ failWhen = null } = {}) {
  const calls = [];
  return {
    calls,
    async embed(inputs) {
      calls.push(...inputs);
      if (failWhen !== null && inputs.some((input) => input.includes(failWhen))) throw new Error(`embedding failed for ${failWhen}`);
      return inputs.map(() => createFixtureVector());
    }
  };
}

test('Issue #275 fixes the vector object-kind set at six kinds', () => {
  assert.strictEqual(OBJECT_KINDS, SHARED_OBJECT_KINDS);
  assert.deepEqual([...OBJECT_KINDS], [
    'work',
    'character',
    'style',
    'prompt_term',
    'generation_lora',
    'artist_prompt_string'
  ]);
});

test('Issue #275 keeps one frozen structured definition for vector kinds and source tables', () => {
  assert.equal(Object.isFrozen(VECTOR_SOURCE_DEFINITIONS), true);
  assert.equal(Object.isFrozen(SHARED_OBJECT_KINDS), true);
  assert.equal(Object.isFrozen(VECTOR_SOURCE_TABLES), true);
  assert.deepEqual(VECTOR_SOURCE_DEFINITIONS, {
    work: { table: 'works', availableWhere: 'is_available = 1' },
    character: { table: 'characters', availableWhere: 'is_available = 1' },
    style: { table: 'styles', availableWhere: '1 = 1' },
    prompt_term: { table: 'prompt_terms', availableWhere: '1 = 1' },
    generation_lora: { table: 'generation_loras', availableWhere: '1 = 1' },
    artist_prompt_string: { table: 'artist_prompt_strings', availableWhere: '1 = 1' }
  });
  assert.deepEqual(VECTOR_SOURCE_TABLES, {
    work: 'works',
    character: 'characters',
    style: 'styles',
    prompt_term: 'prompt_terms',
    generation_lora: 'generation_loras',
    artist_prompt_string: 'artist_prompt_strings'
  });
  for (const definition of Object.values(VECTOR_SOURCE_DEFINITIONS)) assert.equal(Object.isFrozen(definition), true);
});

test('Issue #275 rebuild cleans generation_lora orphans from its fixed source table', async () => {
  const database = databaseFixture();
  try {
    const result = await rebuildVectorEntries({
      database,
      objectKind: 'generation_lora',
      rows: [{ id: 1, text: 'lora' }],
      project: (row) => row.text,
      modelClient: { async embed() { return [createFixtureVector()]; } },
      embeddingModel: 'fake'
    });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(database.prepare("SELECT object_id FROM vector_entries WHERE object_kind = 'generation_lora' ORDER BY object_id").all().map((row) => ({ ...row })), [{ object_id: 1 }]);
  } finally {
    database.close();
  }
});

test('Issue #275 rejects unknown object kinds before source-table cleanup', async () => {
  const database = databaseFixture();
  try {
    const promptTermCountBefore = database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'prompt_term'").get().count;
    await assert.rejects(() => rebuildVectorEntries({
      database,
      objectKind: 'not_a_vector_kind',
      rows: [],
      project: () => '',
      modelClient: { async embed() { return [createFixtureVector()]; } },
      embeddingModel: 'fake'
    }), (error) => error instanceof TypeError);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'prompt_term'").get().count, promptTermCountBefore);
  } finally {
    database.close();
  }
});

test('Issue #275 exposes only prepare and rebuild for both new vector objects', async () => {
  const database = databaseFixture();
  try {
    const model = modelClient();
    const generationLora = createGenerationLoraVectorMaintenance({ database, modelClient: model, configuration });
    const artistPromptString = createArtistPromptStringVectorMaintenance({ database, modelClient: model, configuration });
    assert.deepEqual(Object.keys(generationLora), ['prepare', 'rebuild']);
    assert.deepEqual(Object.keys(artistPromptString), ['prepare', 'rebuild']);
    assert.equal(Object.hasOwn(generationLora, 'upsert'), false);
    assert.equal(Object.hasOwn(artistPromptString, 'upsert'), false);
    assert.equal(Object.hasOwn(generationLora, 'delete'), false);
    assert.equal(Object.hasOwn(artistPromptString, 'delete'), false);
    const loraResult = await generationLora.prepare({ file_name: 'prepared.safetensors', description: 'prepared description', usage: 'prepared usage', trigger_words_json: '["prepared_token"]' });
    const artistResult = await artistPromptString.prepare({ title: 'Prepared Artist', description: 'prepared description', artist_string: 'prepared_artist' });
    assert.equal(loraResult.object_kind, 'generation_lora');
    assert.equal(artistResult.object_kind, 'artist_prompt_string');
  } finally {
    database.close();
  }
});

test('Issue #275 projects LoRA fields in order and preserves trigger-word order', async () => {
  const database = databaseFixture();
  try {
    const model = modelClient();
    await createGenerationLoraVectorMaintenance({ database, modelClient: model, configuration }).prepare({
      file_name: 'portrait.safetensors',
      description: 'changes portrait details',
      usage: 'use at 0.8',
      trigger_words_json: '["portrait_token", "second_token"]'
    });
    assert.deepEqual(model.calls, ['portrait.safetensors\nportrait_token\nsecond_token\nchanges portrait details\nuse at 0.8']);
  } finally {
    database.close();
  }
});

test('Issue #275 projects artist title, description and string without style relations', async () => {
  const database = databaseFixture();
  try {
    const model = modelClient();
    await createArtistPromptStringVectorMaintenance({ database, modelClient: model, configuration }).prepare({
      title: 'Artist One',
      description: 'artist description',
      artist_string: 'artist_one:1.2'
    });
    assert.deepEqual(model.calls, ['Artist One\nartist description\nartist_one:1.2']);
  } finally {
    database.close();
  }
});

test('Issue #275 reports malformed LoRA trigger JSON as a deterministic model protocol error', async () => {
  const database = databaseFixture();
  try {
    const model = modelClient();
    await assert.rejects(
      () => createGenerationLoraVectorMaintenance({ database, modelClient: model, configuration }).prepare({
        file_name: 'portrait.safetensors',
        description: 'changes portrait details',
        usage: 'use at 0.8',
        trigger_words_json: 'not-json'
      }),
      (error) => error?.code === 'MODEL_PROTOCOL_ERROR' && error.message === 'generation lora trigger words are invalid'
    );
    assert.deepEqual(model.calls, []);
  } finally {
    database.close();
  }
});

test('Issue #275 prepare performs no database reads or writes and returns model plus normalized vector', async () => {
  const database = databaseFixture();
  try {
    const access = [];
    const guardedDatabase = new Proxy(database, {
      get(target, property) {
        if (property === 'prepare' || property === 'exec') {
          return (...args) => {
            access.push({ property, args });
            throw new Error(`prepare must not access database through ${property}`);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const calls = [];
    const model = {
      async embed(inputs) {
        calls.push(...inputs);
        return [createFixtureVector(3, 4)];
      }
    };
    const loraResult = await createGenerationLoraVectorMaintenance({ database: guardedDatabase, modelClient: model, configuration: { embedding_model: 'prepared-model' } }).prepare({
      file_name: 'prepared.safetensors',
      description: 'prepared description',
      usage: 'prepared usage',
      trigger_words_json: '["prepared_token"]'
    });
    const artistResult = await createArtistPromptStringVectorMaintenance({ database: guardedDatabase, modelClient: model, configuration: { embedding_model: 'prepared-model' } }).prepare({
      title: 'Prepared Artist',
      description: 'prepared description',
      artist_string: 'prepared_artist'
    });
    assert.deepEqual(access, []);
    assert.deepEqual(calls, [
      'prepared.safetensors\nprepared_token\nprepared description\nprepared usage',
      'Prepared Artist\nprepared description\nprepared_artist'
    ]);
    assert.equal(loraResult.embedding_model, 'prepared-model');
    assert.equal(artistResult.embedding_model, 'prepared-model');
    assert.equal(loraResult.vector.length, 1024);
    assert.equal(artistResult.vector.length, 1024);
    assert.ok(Math.abs(loraResult.vector[0] - 0.6) < 0.00001);
    assert.ok(Math.abs(loraResult.vector[1] - 0.8) < 0.00001);
    assert.ok(Math.abs(artistResult.vector[0] - 0.6) < 0.00001);
    assert.ok(Math.abs(artistResult.vector[1] - 0.8) < 0.00001);
  } finally {
    database.close();
  }
});

test('Issue #275 rebuild reuses valid entries, repairs wrong dimensions, records a single failure, and cleans orphans', async () => {
  const database = databaseFixture();
  try {
    database.prepare("INSERT INTO generation_loras(id, file_name, description, usage, trigger_words_json) VALUES (2, 'bad.safetensors', 'bad description', 'bad usage', '[]')").run();
    database.prepare("INSERT INTO artist_prompt_strings(id, title, description, artist_string, base_model_id) VALUES (2, 'Artist Two', 'description two', 'artist_two', NULL)").run();
    database.prepare("INSERT INTO vector_entries(object_kind, object_id, embedding_f32) VALUES ('artist_prompt_string', 2, ?), ('artist_prompt_string', 99, ?)").run(vectorBlob([1]), vectorBlob());
    const model = modelClient({ failWhen: 'bad.safetensors' });
    const lora = createGenerationLoraVectorMaintenance({ database, modelClient: model, configuration });
    const artist = createArtistPromptStringVectorMaintenance({ database, modelClient: model, configuration });
    const loraResult = await lora.rebuild();
    const artistResult = await artist.rebuild();
    assert.deepEqual(loraResult.completed, [1]);
    assert.deepEqual(loraResult.failures.map(({ object_id }) => object_id), [2]);
    assert.deepEqual(artistResult.completed, [1, 2]);
    assert.deepEqual(artistResult.failures, []);
    assert.deepEqual(database.prepare("SELECT object_id FROM vector_entries WHERE object_kind = 'generation_lora' ORDER BY object_id").all().map((row) => row.object_id), [1]);
    assert.deepEqual(database.prepare("SELECT object_id FROM vector_entries WHERE object_kind = 'artist_prompt_string' ORDER BY object_id").all().map((row) => row.object_id), [1, 2]);
  } finally {
    database.close();
  }
});

test('Issue #275 stops a public rebuild immediately when its vector transaction becomes uncertain', async () => {
  const source = databaseFixture();
  deleteVectorEntry(source, 'generation_lora', 1);
  source.exec("CREATE TRIGGER issue_275_uncertain_lora BEFORE INSERT ON vector_entries WHEN NEW.object_kind = 'generation_lora' AND NEW.object_id = 1 BEGIN SELECT RAISE(ABORT, 'forced vector write failure'); END;");
  let rollbackFailed = false;
  let prepareAfterRollback = 0;
  const database = new Proxy(source, {
    get(target, property) {
      if (property === 'exec') {
        return (sql) => {
          if (sql === 'ROLLBACK;' && !rollbackFailed) {
            rollbackFailed = true;
            throw new Error('forced vector rollback failure');
          }
          return target.exec(sql);
        };
      }
      if (property === 'prepare') {
        return (...args) => {
          if (rollbackFailed) prepareAfterRollback += 1;
          return target.prepare(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  try {
    const model = modelClient();
    await assert.rejects(
      () => createGenerationLoraVectorMaintenance({ database, modelClient: model, configuration }).rebuild(),
      (error) => error instanceof CatalogTransactionError
        && error.transactionState === TRANSACTION_STATE.UNCERTAIN
        && error.originalError?.message === 'forced vector write failure'
        && error.rollbackError?.message === 'forced vector rollback failure'
    );
    assert.deepEqual(model.calls, ['portrait.safetensors\nportrait_token\nsecond_token\nchanges portrait details\nuse at 0.8']);
    assert.equal(prepareAfterRollback, 0);
  } finally {
    source.close();
  }
});
