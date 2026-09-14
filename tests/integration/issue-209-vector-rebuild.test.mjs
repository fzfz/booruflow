import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CatalogTransactionError, openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCharacterVectorMaintenance } from '../../app/vector/character-semantic.mjs';
import { createPromptTermVectorMaintenance } from '../../app/vector/prompt-term-semantic.mjs';
import { createStyleVectorMaintenance } from '../../app/vector/style-semantic.mjs';
import { createWorkVectorMaintenance } from '../../app/vector/work-semantic.mjs';
import { deleteVectorEntry, rebuildVectorEntries, upsertVectorEntry } from '../../app/vector/vector-store.mjs';
import { ApplicationError } from '../../app/security/error-mapping.mjs';
import { TRANSACTION_STATE, markTransactionState } from '../../app/transaction-state.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const NOW = '2026-08-05T00:00:00.000Z';
const configuration = Object.freeze({ embedding_model: 'fake', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 });

function fixture() {
  const database = openCatalogDatabase();
  database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
  database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (20901, 'wai', ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at) VALUES (1, 'work one', 'work one', '[]', 'x', 1, ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (2, 1, 'character one', 'character one', '[]', 'cp', 1, ?, ?)").run(NOW, NOW);
  database.prepare("INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (3, 20901, 'style one', '[]', 'sp', 'sd', NULL)").run();
  database.prepare("INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at) VALUES (4, 'prompt one', 0, 1, '[]', ?, ?)").run(NOW, NOW);
  const calls = [];
  const modelClient = {
    async embed(inputs) {
      calls.push(inputs[0]);
      if (inputs[0].includes('fail-object')) throw new Error('fake missing object');
      return inputs.map((input) => input.includes('changed') ? createFixtureVector(0, 1) : createFixtureVector());
    },
    async rerank(_query, documents) { return documents.map((_document, index) => ({ index, relevance_score: 1 })); }
  };
  return { database, calls, modelClient };
}

test('all four vector maintenance seams rebuild, upsert and delete directly with the same method names', async () => {
  const { database, modelClient } = fixture();
  try {
    const maintenance = [
      createWorkVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) }),
      createCharacterVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) }),
      createStyleVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) }),
      createPromptTermVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) })
    ];
    for (const service of maintenance) {
      assert.equal(typeof service.upsert, 'function');
      assert.equal(typeof service.delete, 'function');
      assert.equal(typeof service.rebuild, 'function');
      assert.equal(Object.hasOwn(service, 'upsertOne'), false);
      assert.equal(Object.hasOwn(service, 'deleteOne'), false);
      assert.equal(Object.hasOwn(service, 'rebuildAll'), false);
      const result = await service.rebuild();
      assert.deepEqual(result.failures, []);
    }
    assert.deepEqual(database.prepare('SELECT object_kind, object_id FROM vector_entries ORDER BY object_kind').all().map((row) => ({ ...row })), [
      { object_kind: 'character', object_id: 2 },
      { object_kind: 'prompt_term', object_id: 4 },
      { object_kind: 'style', object_id: 3 },
      { object_kind: 'work', object_id: 1 }
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    for (const kind of ['work', 'character', 'style', 'prompt_term']) {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ?').get(kind).count, 1, `${kind} rebuild must keep one vector entry per source row`);
    }
    for (const [index, [kind, id]] of ([['work', 1], ['character', 2], ['style', 3], ['prompt_term', 4]].entries())) {
      const beforeVector = Buffer.from(database.prepare('SELECT embedding_f32 FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, id).embedding_f32);
      const table = kind === 'work' ? 'works' : kind === 'character' ? 'characters' : kind === 'style' ? 'styles' : 'prompt_terms';
      const nameColumn = kind === 'prompt_term' ? 'canonical_tag' : 'name';
      const normalizedColumn = kind === 'prompt_term' ? 'updated_at' : kind === 'style' ? 'style_description' : 'name_normalized';
      database.prepare(`UPDATE ${table} SET ${nameColumn} = ?, ${normalizedColumn} = ? WHERE id = ?`).run(`changed ${kind}`, kind === 'prompt_term' ? NOW : `changed ${kind}`, id);
      await maintenance[index].upsert(id);
      const afterVector = Buffer.from(database.prepare('SELECT embedding_f32 FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, id).embedding_f32);
      assert.notDeepEqual(afterVector, beforeVector, `${kind} upsert must change the vector blob for a changed projection`);
    }
    await maintenance[0].delete(1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'work'").get().count, 0);
    await maintenance[0].upsert(1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'work'").get().count, 1);
  } finally { database.close(); }
});

test('direct upsert initializes each unconfigured fixed space from its first existing business object', async () => {
  const { database, modelClient } = fixture();
  try {
    const cases = [
      ['work', 1, createWorkVectorMaintenance],
      ['character', 2, createCharacterVectorMaintenance],
      ['style', 3, createStyleVectorMaintenance],
      ['prompt_term', 4, createPromptTermVectorMaintenance]
    ];
    for (const [kind, id, createMaintenance] of cases) {
      deleteVectorEntry(database, kind, kind === 'work' ? 1 : kind === 'character' ? 2 : kind === 'style' ? 3 : 4);
      database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__', dimension = 1 WHERE object_kind = ?").run(kind);
      await createMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) }).upsert(id);
      assert.deepEqual({ ...database.prepare('SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = ?').get(kind) }, { embedding_model: 'fake', dimension: 1024 });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, id).count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    }
  } finally { database.close(); }
});

test('rebuild continues after one embedding failure and a second run embeds only the missing object', async () => {
  const { database, calls, modelClient } = fixture();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at) VALUES (9, 'fail-object', 'fail-object', '[]', 'x', 1, ?, ?)").run(NOW, NOW);
    const maintenance = createWorkVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) });
    const first = await maintenance.rebuild();
    assert.deepEqual(first.completed, [1]);
    assert.deepEqual(first.failures.map(({ object_id }) => object_id), [9]);
    const callsAfterFirst = calls.length;
    const second = await maintenance.rebuild();
    assert.deepEqual(second.completed, [1]);
    assert.deepEqual(second.failures.map(({ object_id }) => object_id), [9]);
    assert.equal(calls.length, callsAfterFirst + 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
  } finally { database.close(); }
});

test('upsert removes a residual entry when the requested business object no longer exists for every kind', async () => {
  const { database, modelClient } = fixture();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    const maintenance = [
      ['work', 1, createWorkVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) })],
      ['character', 2, createCharacterVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) })],
      ['style', 3, createStyleVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) })],
      ['prompt_term', 4, createPromptTermVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) })]
    ];
    for (const [, , service] of maintenance) await service.rebuild();
    for (const [kind, id, service] of maintenance) {
      database.prepare(`DELETE FROM ${kind === 'work' ? 'works' : kind === 'character' ? 'characters' : kind === 'style' ? 'styles' : 'prompt_terms'} WHERE id = ?`).run(id);
      await service.upsert(id);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, id).count, 0);
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
  } finally { database.close(); }
});

test('explicit first rebuild clears each kind once, commits successful rows, continues SQLite failures, and resumes only the missing ids', async () => {
  const cases = [
    ['work', 'works', 1, 11, createWorkVectorMaintenance],
    ['character', 'characters', 2, 12, createCharacterVectorMaintenance],
    ['style', 'styles', 3, 13, createStyleVectorMaintenance],
    ['prompt_term', 'prompt_terms', 4, 14, createPromptTermVectorMaintenance]
  ];
  for (const [kind, table, firstId, secondId, createMaintenance] of cases) {
    const { database, calls, modelClient } = fixture();
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
      if (kind === 'work') database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at) VALUES (?, 'second', 'second', '[]', 'x', 1, ?, ?)").run(secondId, NOW, NOW);
      if (kind === 'character') database.prepare("INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (?, 1, 'second', 'second', '[]', 'cp', 1, ?, ?)").run(secondId, NOW, NOW);
      if (kind === 'style') database.prepare("INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (?, 20901, 'second', '[]', 'sp', 'sd', NULL)").run(secondId);
      if (kind === 'prompt_term') database.prepare("INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at) VALUES (?, 'second', 0, 1, '[]', ?, ?)").run(secondId, NOW, NOW);
      upsertVectorEntry(database, kind, firstId, createFixtureVector(0, 1), { expectedModel: 'fake' });
      database.exec(`CREATE TRIGGER issue_209_rebuild_sql_failure BEFORE INSERT ON vector_entries WHEN NEW.object_kind = '${kind}' AND NEW.object_id = ${secondId} BEGIN SELECT RAISE(ABORT, 'rebuild vector write failed'); END;`);
      const maintenance = createMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) });
      const first = await maintenance.rebuild({ reset: true });
      assert.deepEqual(first.completed, [firstId]);
      assert.deepEqual(first.failures.map(({ object_id }) => object_id), [secondId]);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, firstId).count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, secondId).count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
      const callsAfterFirst = calls.length;
      database.exec('DROP TRIGGER issue_209_rebuild_sql_failure');
      const second = await maintenance.rebuild();
      assert.deepEqual(second.completed, [firstId, secondId]);
      assert.equal(calls.length, callsAfterFirst + 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally { database.close(); }
  }
});

test('an unconfigured first-row SQLite failure does not poison later rows', async () => {
  const { database, modelClient } = fixture();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__', dimension = 1 WHERE object_kind = 'work'").run();
    database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at) VALUES (11, 'second', 'second', '[]', 'x', 1, ?, ?)").run(NOW, NOW);
    database.exec("CREATE TRIGGER issue_209_unconfigured_first_failure BEFORE INSERT ON vector_entries WHEN NEW.object_kind = 'work' AND NEW.object_id = 1 BEGIN SELECT RAISE(ABORT, 'first vector write failed'); END;");
    const maintenance = createWorkVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) });
    const first = await maintenance.rebuild({ reset: true });
    assert.deepEqual(first.completed, [11]);
    assert.deepEqual(first.failures.map(({ object_id }) => object_id), [1]);
    assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'work'").get() }, { embedding_model: 'fake', dimension: 1024 });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'work' AND object_id = 11").get().count, 1);
    database.exec('DROP TRIGGER issue_209_unconfigured_first_failure');
    const second = await maintenance.rebuild();
    assert.deepEqual(second.completed, [1, 11]);
    assert.deepEqual(second.failures, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
  } finally { database.close(); }
});

test('an explicit model-change rebuild replaces only the target space configuration and vectors', async () => {
  const { database, modelClient } = fixture();
  try {
    const initial = createWorkVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) });
    await initial.rebuild({ reset: true });
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'work' AND object_id = 1").get().embedding_f32);
    const changedConfiguration = { ...configuration, embedding_model: 'changed-model' };
    const changedModel = {
      async embed(inputs) { return inputs.map(() => createFixtureVector(0, 1)); },
      async rerank(_query, documents) { return documents.map((_document, index) => ({ index, relevance_score: 1 })); }
    };
    const result = await createWorkVectorMaintenance({ database, modelClient: changedModel, configuration: changedConfiguration, now: () => new Date(NOW) }).rebuild();
    assert.deepEqual(result.completed, [1]);
    assert.deepEqual(result.failures, []);
    assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'work'").get() }, { embedding_model: 'changed-model', dimension: 1024 });
    assert.notDeepEqual(Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'work' AND object_id = 1").get().embedding_f32), beforeVector);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
  } finally { database.close(); }
});

test('style vector progress emits exactly one ordered event per row and callback failures do not become vector failures', async () => {
  const { database, modelClient } = fixture();
  try {
    const rows = database.prepare('SELECT id, name, aliases_json, style_description, prompt_text FROM styles ORDER BY id').all();
    const events = [];
    const result = await rebuildVectorEntries({
      database,
      objectKind: 'style',
      rows,
      project: (row) => row.name,
      modelClient,
      embeddingModel: 'fake',
      availableWhere: '1 = 1',
      onProgress: (event) => events.push(event),
      now: () => new Date(NOW)
    });
    assert.deepEqual(events.map(({ processed, total, row, status, error }) => ({ processed, total, id: row.id, status, error })), [
      { processed: 1, total: 1, id: 3, status: 'completed', error: null }
    ]);
    assert.deepEqual(result.failures, []);

    const callbackError = new Error('progress delivery failed after commit');
    await assert.rejects(() => rebuildVectorEntries({
      database,
      objectKind: 'style',
      rows,
      project: (row) => `${row.name} changed`,
      modelClient,
      embeddingModel: 'fake',
      reset: true,
      onProgress: () => { throw callbackError; },
      now: () => new Date(NOW)
    }), (error) => error === callbackError);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style' AND object_id = 3").get().count, 1);
  } finally { database.close(); }
});

test('an uncertain SQL rollback remains primary when failed progress delivery also throws', async () => {
  const { database: source } = fixture();
  source.prepare("INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (5, 20901, 'later style', '[]', 'later', 'later', NULL)").run();
  source.exec("CREATE TRIGGER issue_211_uncertain_progress BEFORE INSERT ON vector_entries WHEN NEW.object_kind = 'style' AND NEW.object_id = 3 BEGIN SELECT RAISE(ABORT, 'forced vector SQL failure'); END;");
  const rows = source.prepare('SELECT id, name, aliases_json, style_description, prompt_text FROM styles ORDER BY id').all();
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
  let embedCalls = 0;
  const callbackError = new Error('failed progress delivery');
  try {
    await assert.rejects(() => rebuildVectorEntries({
      database,
      objectKind: 'style',
      rows,
      project: (row) => row.name,
      modelClient: {
        async embed(inputs) {
          embedCalls += inputs.length;
          return inputs.map(() => createFixtureVector());
        }
      },
      embeddingModel: 'fake',
      availableWhere: '1 = 1',
      onProgress: ({ status }) => {
        if (status === 'failed') throw callbackError;
      },
      now: () => new Date(NOW)
    }), (error) => {
      assert.equal(error instanceof CatalogTransactionError, true);
      assert.equal(error.transactionState, TRANSACTION_STATE.UNCERTAIN);
      assert.match(error.originalError.message, /forced vector SQL failure/u);
      assert.match(error.rollbackError.message, /forced vector rollback failure/u);
      assert.equal(error.progressError, callbackError);
      return true;
    });
    assert.equal(embedCalls, 1);
    assert.equal(prepareAfterRollback, 0);
  } finally {
    database.close();
  }
});

test('an uncertain Embedding error remains primary when failed progress delivery also throws', async () => {
  const { database: source } = fixture();
  source.prepare("INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (5, 20901, 'later style', '[]', 'later', 'later', NULL)").run();
  const rows = source.prepare('SELECT id, name, aliases_json, style_description, prompt_text FROM styles ORDER BY id').all();
  let uncertainSeen = false;
  let prepareAfterUncertain = 0;
  const database = new Proxy(source, {
    get(target, property) {
      if (property === 'prepare') {
        return (...args) => {
          if (uncertainSeen) prepareAfterUncertain += 1;
          return target.prepare(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  let embedCalls = 0;
  const originalError = new Error('nested Embedding failure');
  const rollbackError = new Error('nested Embedding rollback failure');
  const embeddingError = new ApplicationError('MODEL_PROTOCOL_ERROR', 'Embedding transaction state uncertain');
  markTransactionState(embeddingError, TRANSACTION_STATE.UNCERTAIN);
  Object.assign(embeddingError, { originalError, rollbackError });
  const callbackError = new Error('Embedding progress delivery failed');
  try {
    await assert.rejects(() => rebuildVectorEntries({
      database,
      objectKind: 'style',
      rows,
      project: (row) => row.name,
      modelClient: {
        async embed() {
          embedCalls += 1;
          uncertainSeen = true;
          throw embeddingError;
        }
      },
      embeddingModel: 'fake',
      availableWhere: '1 = 1',
      onProgress: () => { throw callbackError; },
      now: () => new Date(NOW)
    }), (error) => {
      assert.equal(error, embeddingError);
      assert.equal(error.transactionState, TRANSACTION_STATE.UNCERTAIN);
      assert.equal(error.originalError, originalError);
      assert.equal(error.rollbackError, rollbackError);
      assert.equal(error.progressError, callbackError);
      return true;
    });
    assert.equal(embedCalls, 1);
    assert.equal(prepareAfterUncertain, 0);
  } finally {
    database.close();
  }
});

test('failed embedding and failed SQL each produce one failed progress event while later rows continue', async () => {
  const { database } = fixture();
  try {
    database.prepare("INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (5, 20901, 'fail-object', '[]', 'sp', 'sd', NULL)").run();
    const events = [];
    const modelClient = { async embed(inputs) { if (inputs[0].includes('fail-object')) throw new Error('embed failed'); return [createFixtureVector()]; } };
    const first = await rebuildVectorEntries({ database, objectKind: 'style', rows: database.prepare('SELECT id, name, aliases_json, style_description, prompt_text FROM styles ORDER BY id').all(), project: (row) => row.name, modelClient, embeddingModel: 'fake', availableWhere: '1 = 1', onProgress: (event) => events.push(event), now: () => new Date(NOW) });
    assert.deepEqual(events.map(({ row, status }) => ({ id: row.id, status })), [{ id: 3, status: 'completed' }, { id: 5, status: 'failed' }]);
    assert.deepEqual(first.failures.map(({ object_id }) => object_id), [5]);
    database.exec("CREATE TRIGGER issue_211_progress_sql_failure BEFORE INSERT ON vector_entries WHEN NEW.object_kind = 'style' AND NEW.object_id = 5 BEGIN SELECT RAISE(ABORT, 'progress SQL failure'); END;");
    deleteVectorEntry(database, 'style', 5);
    const sqlEvents = [];
    const sqlResult = await rebuildVectorEntries({ database, objectKind: 'style', rows: database.prepare('SELECT id, name, aliases_json, style_description, prompt_text FROM styles ORDER BY id').all(), project: (row) => row.name, modelClient: { async embed() { return [createFixtureVector()]; } }, embeddingModel: 'fake', availableWhere: '1 = 1', onProgress: (event) => sqlEvents.push(event), now: () => new Date(NOW) });
    assert.deepEqual(sqlEvents.map(({ row, status }) => ({ id: row.id, status })), [{ id: 3, status: 'completed' }, { id: 5, status: 'failed' }]);
    assert.deepEqual(sqlResult.failures.map(({ object_id }) => object_id), [5]);
  } finally { database.close(); }
});
