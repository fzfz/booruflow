import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inTransaction, openCatalogDatabase } from '../../app/catalog/database.mjs';
import {
  deleteVectorEntry,
  rebuildVectorEntries,
  upsertVectorEntry,
  writeVectorSpaceConfiguration
} from '../../app/vector/vector-store.mjs';
import { createSemanticService } from '../../app/vector/semantic-service.mjs';
import { createArtistPromptStringSemanticService } from '../../app/vector/artist-prompt-string-semantic.mjs';
import { createCharacterSemanticService } from '../../app/vector/character-semantic.mjs';
import { createGenerationLoraSemanticService } from '../../app/vector/generation-lora-semantic.mjs';
import { createPromptTermSemanticService } from '../../app/vector/prompt-term-semantic.mjs';
import { createStyleSemanticService } from '../../app/vector/style-semantic.mjs';
import { createWorkSemanticService } from '../../app/vector/work-semantic.mjs';

const VECTOR_DIMENSION = 1024;
const EMBEDDING_MODEL = 'issue-288-test-model';
const NOW = new Date('2026-08-23T00:00:00.000Z');
const BASE_MODEL_NAME = 'Issue-288-WAI';
const BASE_MODEL_ID = 103;
const MODEL_ID = 104;

function vector(seed, value = 1) {
  const result = new Array(VECTOR_DIMENSION).fill(0);
  result[seed] = value;
  return result;
}

function positivePair(first, second) {
  const result = new Array(VECTOR_DIMENSION).fill(0);
  result[0] = first;
  result[1] = second;
  return result;
}

function database() {
  const result = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  result.prepare(`UPDATE vector_spaces SET embedding_model = ?, dimension = ?`).run(EMBEDDING_MODEL, VECTOR_DIMENSION);
  return result;
}

function identities(database, tableName) {
  return database.prepare(`SELECT object_kind, object_id FROM ${tableName} ORDER BY object_kind, object_id`).all()
    .map(({ object_kind: objectKind, object_id: objectId }) => ({ object_kind: objectKind, object_id: objectId }));
}

function seedSixSources(db) {
  const timestamp = NOW.toISOString();
  db.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES (${BASE_MODEL_ID}, '${BASE_MODEL_NAME}', '${timestamp}', '${timestamp}');
    INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (
      ${MODEL_ID}, ${BASE_MODEL_ID}, 'issue-288-model.safetensors', 'safetensors', 'fp16',
      'test model', 'test usage', '${timestamp}', '${timestamp}'
    );
    INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at)
      VALUES (101, 'Issue Work', 'issue work', '[]', 'category', 1, '${timestamp}', '${timestamp}');
    INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
      VALUES (102, 101, 'Issue Character', 'issue character', '[]', 'character prompt', 1, '${timestamp}', '${timestamp}');
    INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description)
      VALUES (105, ${BASE_MODEL_ID}, 'Issue Style', '[]', 'style prompt', 'style description');
    INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at)
      VALUES (108, 'issue_tag', 1, 1, '[]', '${timestamp}', '${timestamp}');
    INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (
      106, ${BASE_MODEL_ID}, ${MODEL_ID}, 'issue-lora.safetensors', 'safetensors', 'fp16',
      'lora description', 'lora usage', '["issue trigger"]', 1.0, '${timestamp}', '${timestamp}'
    );
    INSERT INTO artist_prompt_strings(id, title, description, artist_string, base_model_id, created_at, updated_at)
      VALUES (107, 'Issue Artist', 'artist description', 'artist_string', ${BASE_MODEL_ID}, '${timestamp}', '${timestamp}');
  `);
}

test('vector store rejects every embedding whose stored dimension is not exactly 1024', () => {
  const db = database();
  try {
    assert.throws(() => writeVectorSpaceConfiguration(db, 'work', { embeddingModel: EMBEDDING_MODEL, dimension: 768 }), /dimension must be exactly 1024/u);
    assert.throws(
      () => upsertVectorEntry(db, 'work', 1, [1, 0]),
      (error) => error?.code === 'MODEL_PROTOCOL_ERROR' && error.message === 'stored embedding dimension must be exactly 1024'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vector_entries').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vector_knn_index').get().count, 0);
  } finally {
    db.close();
  }
});

test('vector upsert and delete synchronize vector_entries and vector_knn_index in one managed transaction', () => {
  const db = database();
  try {
    const entries = [
      ['work', 11],
      ['character', 12],
      ['style', 13],
      ['prompt_term', 14],
      ['generation_lora', 15],
      ['artist_prompt_string', 16]
    ];
    for (const [objectKind, objectId] of entries) {
      inTransaction(db, () => upsertVectorEntry(db, objectKind, objectId, vector(objectId), { expectedModel: EMBEDDING_MODEL }));
    }
    const expectedIdentities = entries.map(([object_kind, object_id]) => ({ object_kind, object_id }))
      .sort((left, right) => left.object_kind.localeCompare(right.object_kind) || left.object_id - right.object_id);
    assert.deepEqual(identities(db, 'vector_entries'), expectedIdentities);
    assert.deepEqual(identities(db, 'vector_knn_index'), expectedIdentities);

    for (const [objectKind, objectId] of entries) inTransaction(db, () => deleteVectorEntry(db, objectKind, objectId));
    assert.deepEqual(identities(db, 'vector_entries'), []);
    assert.deepEqual(identities(db, 'vector_knn_index'), []);
  } finally {
    db.close();
  }
});

test('vector upsert rolls back vector_entries when the KNN write fails in the same transaction', () => {
  const db = database();
  try {
    const failingDatabase = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver);
        return (sql) => /INSERT INTO vector_knn_index/u.test(String(sql))
          ? { run() { throw new Error('issue-288 KNN write failed'); } }
          : target.prepare(sql);
      }
    });
    assert.throws(
      () => inTransaction(failingDatabase, () => upsertVectorEntry(failingDatabase, 'work', 21, vector(0), { expectedModel: EMBEDDING_MODEL })),
      /issue-288 KNN write failed/u
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'work' AND object_id = 21").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vector_knn_index WHERE object_kind = 'work' AND object_id = 21").get().count, 0);
  } finally {
    db.close();
  }
});

test('vector delete rolls back vector_entries when the KNN delete fails in the same transaction', () => {
  const db = database();
  try {
    inTransaction(db, () => upsertVectorEntry(db, 'work', 22, vector(0), { expectedModel: EMBEDDING_MODEL }));
    const failingDatabase = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver);
        return (sql) => /DELETE FROM vector_knn_index/u.test(String(sql))
          ? { run() { throw new Error('issue-288 KNN delete failed'); } }
          : target.prepare(sql);
      }
    });
    assert.throws(() => inTransaction(failingDatabase, () => deleteVectorEntry(failingDatabase, 'work', 22)), /issue-288 KNN delete failed/u);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'work' AND object_id = 22").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vector_knn_index WHERE object_kind = 'work' AND object_id = 22").get().count, 1);
  } finally {
    db.close();
  }
});

test('vector rebuild removes stale entries from both synchronized stores', async () => {
  const db = database();
  try {
    inTransaction(db, () => upsertVectorEntry(db, 'work', 1, vector(1), { expectedModel: EMBEDDING_MODEL }));
    inTransaction(db, () => upsertVectorEntry(db, 'work', 3, vector(3), { expectedModel: EMBEDDING_MODEL }));
    db.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
      VALUES (1, 'One', 'one', '[]', 1, ?, ?), (2, 'Two', 'two', '[]', 1, ?, ?), (3, 'Three', 'three', '[]', 1, ?, ?)`)
      .run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString());

    const result = await rebuildVectorEntries({
      database: db,
      objectKind: 'work',
      rows: [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }],
      project: (row) => row.name,
      modelClient: { async embed(inputs) { return inputs.map((_input, index) => vector(index)); } },
      embeddingModel: EMBEDDING_MODEL,
      reset: true,
      now: () => NOW
    });

    assert.deepEqual(result.completed, [1, 2]);
    assert.deepEqual(identities(db, 'vector_entries'), [
      { object_kind: 'work', object_id: 1 },
      { object_kind: 'work', object_id: 2 }
    ]);
    assert.deepEqual(identities(db, 'vector_knn_index'), [
      { object_kind: 'work', object_id: 1 },
      { object_kind: 'work', object_id: 2 }
    ]);
  } finally {
    db.close();
  }
});

test('vector rebuild keeps the KNN index synchronized for each of the six object kinds', async () => {
  const db = database();
  try {
    seedSixSources(db);
    const entries = [
      ['work', 101],
      ['character', 102],
      ['style', 105],
      ['prompt_term', 108],
      ['generation_lora', 106],
      ['artist_prompt_string', 107]
    ];
    for (const [objectKind, objectId] of entries) {
      inTransaction(db, () => upsertVectorEntry(db, objectKind, objectId, vector(0), { expectedModel: EMBEDDING_MODEL }));
    }
    db.prepare("DELETE FROM vector_knn_index WHERE object_kind = 'work' AND object_id = 101").run();
    let repairEmbedCalls = 0;
    const repair = await rebuildVectorEntries({
      database: db,
      objectKind: 'work',
      rows: [{ id: 101, name: 'work' }],
      project: (row) => row.name,
      modelClient: { async embed(inputs) { repairEmbedCalls += inputs.length; return inputs.map(() => vector(0)); } },
      embeddingModel: EMBEDDING_MODEL,
      now: () => NOW
    });
    assert.deepEqual(repair.completed, [101]);
    assert.equal(repairEmbedCalls, 0);
    assert.deepEqual(identities(db, 'vector_knn_index').filter((entry) => entry.object_kind === 'work'), [{ object_kind: 'work', object_id: 101 }]);
    for (const [objectKind, objectId] of entries) {
      const result = await rebuildVectorEntries({
        database: db,
        objectKind,
        rows: [{ id: objectId, name: objectKind }],
        project: (row) => row.name,
        modelClient: { async embed(inputs) { return inputs.map(() => vector(0)); } },
        embeddingModel: EMBEDDING_MODEL,
        reset: true,
        now: () => NOW
      });
      assert.deepEqual(result.completed, [objectId], objectKind);
      assert.deepEqual(identities(db, 'vector_entries').filter((entry) => entry.object_kind === objectKind), [{ object_kind: objectKind, object_id: objectId }]);
      assert.deepEqual(identities(db, 'vector_knn_index').filter((entry) => entry.object_kind === objectKind), [{ object_kind: objectKind, object_id: objectId }]);
    }
  } finally {
    db.close();
  }
});

test('semantic search asks vec0 for exactly the reranker candidate limit and converts distance to cosine', async () => {
  const db = database();
  const statements = [];
  try {
    inTransaction(db, () => upsertVectorEntry(db, 'work', 1, vector(0), { expectedModel: EMBEDDING_MODEL }));
    inTransaction(db, () => upsertVectorEntry(db, 'work', 2, positivePair(0.8, 0.6), { expectedModel: EMBEDDING_MODEL }));
    inTransaction(db, () => upsertVectorEntry(db, 'work', 3, positivePair(0.6, 0.8), { expectedModel: EMBEDDING_MODEL }));
    const tracedDatabase = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver);
        return (sql) => {
          statements.push(String(sql));
          return target.prepare(sql);
        };
      }
    });
    const rerankCalls = [];
    const service = createSemanticService({
      database: tracedDatabase,
      objectKind: 'work',
      modelClient: {
        async embed(inputs) { return inputs.map(() => vector(0)); },
        async rerank(query, documents) {
          rerankCalls.push({ query, documents });
          return documents.map((_document, index) => ({ index, relevance_score: 1 - index / 10 }));
        }
      },
      configuration: {
        embedding_model: EMBEDDING_MODEL,
        reranker_candidate_limit: 2,
        reranker_min_relevance_score: 0
      },
      loadRows: (ids) => ids.map((id) => ({ id, name: `work-${id}` })),
      projectText: (row) => row.name,
      projectPublic: (row, retrieval) => ({ id: row.id, ...retrieval })
    });

    const result = await service.searchPublic({ q: 'query', limit: 1 });
    assert.deepEqual(result.items, [{ id: 1, rank: 1, vector_score: 1, reranker_score: 1 }]);
    assert.equal(rerankCalls.length, 1);
    assert.equal(rerankCalls[0].documents.length, 2);
    const knnStatements = statements.filter((sql) => /vector_knn_index/u.test(sql));
    assert.equal(knnStatements.length, 1);
    assert.match(knnStatements[0], /embedding\s+MATCH\s+\?/iu);
    assert.match(knnStatements[0], /k\s*=\s*\?/iu);
    assert.match(knnStatements[0], /object_kind\s*=\s*\?/iu);
    assert.match(knnStatements[0], /ORDER BY distance/iu);
    assert.equal(statements.some((sql) => /embedding_f32/u.test(sql)), false);
  } finally {
    db.close();
  }
});

test('all six semantic public seams use the shared vec0 KNN path without reading embedding blobs', async () => {
  const db = database();
  const statements = [];
  try {
    seedSixSources(db);
    const entries = [
      ['work', 101],
      ['character', 102],
      ['style', 105],
      ['prompt_term', 108],
      ['generation_lora', 106],
      ['artist_prompt_string', 107]
    ];
    for (const [objectKind, objectId] of entries) {
      inTransaction(db, () => upsertVectorEntry(db, objectKind, objectId, vector(0), { expectedModel: EMBEDDING_MODEL }));
    }
    const tracedDatabase = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver);
        return (sql) => {
          statements.push(String(sql));
          return target.prepare(sql);
        };
      }
    });
    const modelClient = {
      async embed(inputs) { return inputs.map(() => vector(0)); },
      async rerank(_query, documents) { return documents.map((_document, index) => ({ index, relevance_score: 1 })); }
    };
    const configuration = {
      embedding_model: EMBEDDING_MODEL,
      reranker_candidate_limit: 1,
      reranker_min_relevance_score: 0
    };
    const services = [
      ['work', createWorkSemanticService],
      ['character', createCharacterSemanticService],
      ['style', createStyleSemanticService],
      ['prompt_term', createPromptTermSemanticService],
      ['generation_lora', createGenerationLoraSemanticService],
      ['artist_prompt_string', createArtistPromptStringSemanticService]
    ];
    for (const [objectKind, createService] of services) {
      const service = createService({ database: tracedDatabase, modelClient, configuration });
      const options = objectKind === 'style' || objectKind === 'generation_lora' || objectKind === 'artist_prompt_string'
        ? { base_model_name: BASE_MODEL_NAME }
        : {};
      const result = await service.searchPublic({ q: 'issue', limit: 1, ...options });
      assert.equal(result.items.length, 1, objectKind);
    }
    const knnStatements = statements.filter((sql) => /vector_knn_index/u.test(sql));
    assert.equal(knnStatements.length, entries.length);
    for (const sql of knnStatements) {
      assert.match(sql, /embedding\s+MATCH\s+\?/iu);
      assert.match(sql, /k\s*=\s*\?/iu);
      assert.match(sql, /object_kind\s*=\s*\?/iu);
      assert.match(sql, /ORDER BY distance/iu);
    }
    assert.equal(statements.some((sql) => /embedding_f32/u.test(sql)), false);
  } finally {
    db.close();
  }
});
