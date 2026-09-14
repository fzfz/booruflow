import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { ApplicationError } from '../../app/security/error-mapping.mjs';
import { createCharacterSemanticService, createCharacterVectorMaintenance } from '../../app/vector/character-semantic.mjs';
import { createPromptTermSemanticService, createPromptTermVectorMaintenance } from '../../app/vector/prompt-term-semantic.mjs';
import { createStyleSemanticService, createStyleVectorMaintenance } from '../../app/vector/style-semantic.mjs';
import { createWorkSemanticService, createWorkVectorMaintenance } from '../../app/vector/work-semantic.mjs';
import { deleteVectorEntry } from '../../app/vector/vector-store.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const NOW = '2026-08-05T00:00:00Z';
const configuration = Object.freeze({ embedding_model: 'fake', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 });

function fixture() {
  const database = openCatalogDatabase();
  database.prepare(`UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024 WHERE object_kind IN ('work', 'character', 'style', 'prompt_term')`).run();
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at)
    VALUES (1, '雨夜档案馆', '雨夜档案馆', '["旧书馆"]', '幻想', 1, ?, ?),
           (2, '第二作品', '第二作品', '[]', '测试', 1, ?, ?)` ).run(NOW, NOW, NOW, NOW);
  const calls = [];
  const modelClient = Object.freeze({
    async embed(inputs) {
      calls.push({ kind: 'embed', inputs });
      return inputs.map((input) => input.includes('雨夜') || input.includes('旧书') ? createFixtureVector() : createFixtureVector(-1, 0));
    },
    async rerank(query, documents) {
      calls.push({ kind: 'rerank', query, documents });
      return documents.map((_document, index) => ({ index, relevance_score: 1 - index / 100 }));
    }
  });
  return { database, calls, modelClient };
}

function seedKind(database, kind) {
  if (kind === 'work') {
    database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at) VALUES (1, 'work one', 'work one', '[]', 'x', 1, ?, ?)").run(NOW, NOW);
    return 1;
  }
  if (kind === 'character') {
    database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (1, 'work one', 'work one', '[]', 1, ?, ?)").run(NOW, NOW);
    database.prepare("INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (2, 1, 'character one', 'character one', '[]', 'cp', 1, ?, ?)").run(NOW, NOW);
    return 2;
  }
  if (kind === 'style') {
    database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (20903, 'wai', ?, ?)").run(NOW, NOW);
    database.prepare("INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (3, 20903, 'style one', '[]', 'sp', 'sd', NULL)").run();
    return 3;
  }
  database.prepare("INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at) VALUES (4, 'prompt one', 0, 1, '[]', ?, ?)").run(NOW, NOW);
  return 4;
}

function semanticCases() {
  return [
    ['work', createWorkSemanticService, createWorkVectorMaintenance],
    ['character', createCharacterSemanticService, createCharacterVectorMaintenance],
    ['style', createStyleSemanticService, createStyleVectorMaintenance],
    ['prompt_term', createPromptTermSemanticService, createPromptTermVectorMaintenance]
  ];
}

function publicSemanticRequest(kind, request) {
  return kind === 'style' ? { ...request, base_model_name: 'wai' } : request;
}

function skillSemanticRequest(kind, request) {
  return kind === 'style' ? { ...request, base_model_name: 'wai' } : request;
}

test('direct rebuild/query use one fixed space and a missing single vector only excludes that object', async () => {
  const { database, calls, modelClient } = fixture();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    const maintenance = createWorkVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) });
    assert.deepEqual(await maintenance.rebuild(), { object_kind: 'work', completed: [1, 2], failures: [], rebuilt_at: '2026-08-05T00:00:00.000Z' });
    const semantic = createWorkSemanticService({ database, modelClient, configuration });
    assert.deepEqual(await semantic.searchPublic({ q: '旧书', limit: 20 }), { items: [{ id: 1, name: '雨夜档案馆', aliases: ['旧书馆'], category_name: '幻想', rank: 1, vector_score: 1, reranker_score: 1 }] });
    deleteVectorEntry(database, 'work', 1);
    assert.deepEqual((await semantic.searchPublic({ q: '旧书', limit: 20 })).items, []);
    assert.ok(calls.some((call) => call.kind === 'rerank'));
  } finally { database.close(); }
});

test('query maps a missing fixed vector space to INTERNAL_ERROR without keyword fallback', async () => {
  const { database, modelClient } = fixture();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("DELETE FROM vector_spaces WHERE object_kind = 'work'").run();
    const semantic = createWorkSemanticService({ database, modelClient, configuration });
    await assert.rejects(() => semantic.searchPublic({ q: '关键词', limit: 1 }), (error) => error instanceof ApplicationError && error.code === 'INTERNAL_ERROR' && /configuration is missing/u.test(error.message));
  } finally { database.close(); }
});

test('each semantic query kind maps a missing fixed vector space to INTERNAL_ERROR', async () => {
  const cases = [
    ['work', createWorkSemanticService],
    ['character', createCharacterSemanticService],
    ['style', createStyleSemanticService],
    ['prompt_term', createPromptTermSemanticService]
  ];
  for (const [objectKind, createSemantic] of cases) {
    const { database, modelClient } = fixture();
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
      if (objectKind === 'style') database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (20906, 'wai', ?, ?)").run(NOW, NOW);
      database.prepare('DELETE FROM vector_spaces WHERE object_kind = ?').run(objectKind);
      const semantic = createSemantic({ database, modelClient, configuration });
      await assert.rejects(() => semantic.searchPublic(publicSemanticRequest(objectKind, { q: '关键词', limit: 1 })), (error) => error instanceof ApplicationError && error.code === 'INTERNAL_ERROR' && new RegExp(`${objectKind} vector space configuration is missing`, 'u').test(error.message));
    } finally { database.close(); }
  }
});

test('query maps an unconfigured fixed vector space to VECTOR_INDEX_NOT_READY', async () => {
  const { database, modelClient } = fixture();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__', dimension = 1 WHERE object_kind = 'work'").run();
    const semantic = createWorkSemanticService({ database, modelClient, configuration });
    await assert.rejects(() => semantic.searchPublic({ q: '关键词', limit: 1 }), (error) => error instanceof ApplicationError && error.code === 'VECTOR_INDEX_NOT_READY' && /not ready/u.test(error.message));
  } finally { database.close(); }
});

test('each semantic query rejects a configured model mismatch before calling either model', async () => {
  const cases = [
    ['work', createWorkSemanticService],
    ['character', createCharacterSemanticService],
    ['style', createStyleSemanticService],
    ['prompt_term', createPromptTermSemanticService]
  ];
  for (const [objectKind, createSemantic] of cases) {
    const { database } = fixture();
    const calls = [];
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
      if (objectKind === 'style') database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (20907, 'wai', ?, ?)").run(NOW, NOW);
      const modelClient = {
        async embed(inputs) { calls.push(['embed', inputs]); return [createFixtureVector()]; },
        async rerank(query, documents) { calls.push(['rerank', query, documents]); return documents.map((_document, index) => ({ index, relevance_score: 1 })); }
      };
      const semantic = createSemantic({ database, modelClient, configuration: { ...configuration, embedding_model: 'runtime-model' } });
      await assert.rejects(() => semantic.searchPublic(publicSemanticRequest(objectKind, { q: '关键词', limit: 1 })), (error) => error instanceof ApplicationError
        && error.code === 'INTERNAL_ERROR'
        && new RegExp(`${objectKind} vector space uses a different embedding model`, 'u').test(error.message));
      assert.deepEqual(calls, []);
    } finally { database.close(); }
  }
});

test('character public work_id rejects strings before model calls while Catalog accepts stable string filters', async () => {
  const { database } = fixture();
  const calls = [];
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    const modelClient = {
      async embed(inputs) { calls.push(['embed', inputs]); return [createFixtureVector()]; },
      async rerank(query, documents) { calls.push(['rerank', query, documents]); return documents.map((_document, index) => ({ index, relevance_score: 1 })); }
    };
    const semantic = createCharacterSemanticService({ database, modelClient, configuration });
    await assert.doesNotReject(() => semantic.searchPublic({ q: '角色', limit: 1, work_id: null }));
    calls.length = 0;
    for (const workId of [0, Number.NaN, '1']) {
      await assert.rejects(() => semantic.searchPublic({ q: '角色', limit: 1, work_id: workId }), (error) => error instanceof ApplicationError && error.code === 'SEMANTIC_QUERY_VALIDATION');
    }
    assert.deepEqual(calls, []);
    await assert.doesNotReject(() => semantic.searchCatalog({ query: '角色', page: 1, page_size: 1, work_id: '1' }));
  } finally { database.close(); }
});

test('all semantic public and Skill entry points reject invalid query and request parameters before model calls', async () => {
  for (const [, createSemantic] of semanticCases()) {
    const { database, calls, modelClient } = fixture();
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
      const semantic = createSemantic({ database, modelClient, configuration });
      for (const request of [{ q: '', limit: 1 }, { q: 'q', limit: 0 }, { q: 'q', limit: 21 }]) {
        await assert.rejects(() => semantic.searchPublic(request), (error) => error instanceof ApplicationError && error.code === 'SEMANTIC_QUERY_VALIDATION');
      }
      for (const request of [
        { queries: [], limit: 1 },
        { queries: ['a', 'b', 'c', 'd'], limit: 1 },
        { queries: [''], limit: 1 },
        { queries: ['a'], limit: 0 }
      ]) {
        await assert.rejects(() => semantic.searchSkill(request), (error) => error instanceof ApplicationError && error.code === 'SEMANTIC_QUERY_VALIDATION');
      }
      assert.deepEqual(calls, []);
    } finally { database.close(); }
  }
});

test('all four semantic queries map embedding and reranker protocol failures without fallback', async () => {
  for (const [kind, , createMaintenance] of semanticCases()) {
    const database = openCatalogDatabase();
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
      database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
      const objectId = seedKind(database, kind);
      const stableModel = { async embed(inputs) { return inputs.map(() => createFixtureVector()); }, async rerank(_query, documents) { return documents.map((_document, index) => ({ index, relevance_score: 1 })); } };
      await createMaintenance({ database, modelClient: stableModel, configuration, now: () => new Date(NOW) }).rebuild();

      const embeddingUnavailable = { async embed() { throw new ApplicationError('EMBEDDING_UNAVAILABLE', 'embedding unavailable'); }, async rerank() { throw new Error('rerank must not run'); } };
      await assert.rejects(() => ({
        work: createWorkSemanticService, character: createCharacterSemanticService, style: createStyleSemanticService, prompt_term: createPromptTermSemanticService
      }[kind]({ database, modelClient: embeddingUnavailable, configuration })).searchPublic(publicSemanticRequest(kind, { q: 'query', limit: 1 })), (error) => error.code === 'EMBEDDING_UNAVAILABLE');

      const malformedEmbedding = { async embed() { return [[1, 0, 0]]; }, async rerank() { throw new Error('rerank must not run'); } };
      const createSemantic = { work: createWorkSemanticService, character: createCharacterSemanticService, style: createStyleSemanticService, prompt_term: createPromptTermSemanticService }[kind];
      await assert.rejects(() => createSemantic({ database, modelClient: malformedEmbedding, configuration }).searchPublic(publicSemanticRequest(kind, { q: 'query', limit: 1 })), (error) => error.code === 'MODEL_PROTOCOL_ERROR');

      await createMaintenance({ database, modelClient: stableModel, configuration, now: () => new Date(NOW) }).rebuild({ reset: true });

      const rerankerUnavailable = { async embed(inputs) { return inputs.map(() => createFixtureVector()); }, async rerank() { throw new ApplicationError('RERANKER_UNAVAILABLE', 'reranker unavailable'); } };
      await assert.rejects(() => createSemantic({ database, modelClient: rerankerUnavailable, configuration }).searchPublic(publicSemanticRequest(kind, { q: 'query', limit: 1 })), (error) => error.code === 'RERANKER_UNAVAILABLE');
      const malformedReranker = { async embed(inputs) { return inputs.map(() => createFixtureVector()); }, async rerank() { return []; } };
      await assert.rejects(() => createSemantic({ database, modelClient: malformedReranker, configuration }).searchPublic(publicSemanticRequest(kind, { q: 'query', limit: 1 })), (error) => error.code === 'MODEL_PROTOCOL_ERROR');
    } finally { database.close(); }
  }
});

test('semantic public results honor reranker threshold and limit while Skill groups preserve order and Agent omits retrieval metadata', async () => {
  const database = openCatalogDatabase();
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024 WHERE object_kind = 'work'").run();
    database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at) VALUES
      (1, 'first', 'first', '[]', 'x', 1, ?, ?),
      (2, 'second', 'second', '[]', 'x', 1, ?, ?),
      (3, 'third', 'third', '[]', 'x', 1, ?, ?)`).run(NOW, NOW, NOW, NOW, NOW, NOW);
    const maintenanceModel = { async embed(inputs) { return inputs.map(() => createFixtureVector()); }, async rerank(_query, documents) { return documents.map((_document, index) => ({ index, relevance_score: 1 })); } };
    await createWorkVectorMaintenance({ database, modelClient: maintenanceModel, configuration, now: () => new Date(NOW) }).rebuild({ reset: true });
    const queryModel = {
      async embed(inputs) { return inputs.map(() => createFixtureVector()); },
      async rerank(_query, documents) {
        return documents.map((_document, index) => ({ index, relevance_score: [0.4, 0.9, 0.2][index] }));
      }
    };
    const semantic = createWorkSemanticService({ database, modelClient: queryModel, configuration: { ...configuration, reranker_min_relevance_score: 0.3 } });
    assert.deepEqual(await semantic.searchPublic({ q: 'query', limit: 1 }), {
      items: [{ id: 2, name: 'second', aliases: [], category_name: 'x', rank: 1, vector_score: 1, reranker_score: 0.9 }]
    });
    const groups = await semantic.searchSkill({ queries: ['first query', 'second query'], limit: 2 });
    assert.deepEqual(groups.groups.map((group) => group.query), ['first query', 'second query']);
    assert.deepEqual(groups.groups[0].items.map(({ id }) => id), [2, 1]);
    assert.deepEqual(await semantic.searchSkillForAgent({ queries: ['query'], limit: 2 }), {
      groups: [{ query: 'query', items: [{ name: 'second', aliases: [], category_name: 'x', character_names: [] }, { name: 'first', aliases: [], category_name: 'x', character_names: [] }] }]
    });
  } finally { database.close(); }
});

test('all four semantic query seams filter one missing entry, keep six config rows, and expose minimal Agent projections', async () => {
  const cases = [
    { kind: 'work', id: 1, table: 'works', createSemantic: createWorkSemanticService, createMaintenance: createWorkVectorMaintenance, expectedAgent: { name: 'work one', aliases: [], category_name: 'x', character_names: [] } },
    { kind: 'character', id: 2, table: 'characters', createSemantic: createCharacterSemanticService, createMaintenance: createCharacterVectorMaintenance, expectedAgent: { work_name: 'work one', name: 'character one', aliases: [], prompt_text: 'cp' } },
    { kind: 'style', id: 3, table: 'styles', createSemantic: createStyleSemanticService, createMaintenance: createStyleVectorMaintenance, expectedAgent: { name: 'style one', aliases: [], style_description: 'sd', prompt_text: 'sp' } },
    { kind: 'prompt_term', id: 4, table: 'prompt_terms', createSemantic: createPromptTermSemanticService, createMaintenance: createPromptTermVectorMaintenance, expectedAgent: { canonical_tag: 'prompt one', aliases: [] } }
  ];
  for (const item of cases) {
    const database = openCatalogDatabase();
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
      database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
      if (item.kind === 'work') database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at) VALUES (1, 'work one', 'work one', '[]', 'x', 1, ?, ?)").run(NOW, NOW);
      if (item.kind === 'character') {
        database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (1, 'work one', 'work one', '[]', 1, ?, ?)").run(NOW, NOW);
        database.prepare("INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (2, 1, 'character one', 'character one', '[]', 'cp', 1, ?, ?)").run(NOW, NOW);
      }
      if (item.kind === 'style') {
        database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (20904, 'wai', ?, ?)").run(NOW, NOW);
        database.prepare("INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (3, 20904, 'style one', '[]', 'sp', 'sd', NULL)").run();
      }
      if (item.kind === 'prompt_term') database.prepare("INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at) VALUES (4, 'prompt one', 0, 1, '[]', ?, ?)").run(NOW, NOW);
      const modelClient = { async embed(inputs) { return inputs.map(() => createFixtureVector()); }, async rerank(_query, documents) { return documents.map((_document, index) => ({ index, relevance_score: 1 })); } };
      const maintenance = item.createMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) });
      await maintenance.rebuild({ reset: true });
      const semantic = item.createSemantic({ database, modelClient, configuration });
      const publicResult = await semantic.searchPublic(publicSemanticRequest(item.kind, { q: 'one', limit: 20, ...(item.kind === 'character' ? { work_id: 1 } : {}) }));
      assert.deepEqual(publicResult.items[0], item.kind === 'work'
        ? { id: 1, name: 'work one', aliases: [], category_name: 'x', rank: 1, vector_score: 1, reranker_score: 1 }
        : item.kind === 'character'
        ? { id: 2, work_id: 1, name: 'character one', aliases: [], prompt_text: 'cp', rank: 1, vector_score: 1, reranker_score: 1 }
        : item.kind === 'style'
            ? { id: 3, name: 'style one', aliases: [], prompt_text: 'sp', style_description: 'sd' }
            : { id: 4, canonical_tag: 'prompt one', aliases: [], category: 0, post_count: 1, rank: 1, vector_score: 1, reranker_score: 1 });
      const skillResult = await semantic.searchSkill(skillSemanticRequest(item.kind, { queries: ['one', 'two'], limit: 1 }));
      assert.deepEqual(skillResult.groups.map((group) => ({ query: group.query, count: group.items.length })), [{ query: 'one', count: 1 }, { query: 'two', count: 1 }]);
      assert.deepEqual((await semantic.searchSkillForAgent(skillSemanticRequest(item.kind, { queries: ['one'], limit: 1 }))).groups[0].items[0], item.expectedAgent);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
      deleteVectorEntry(database, item.kind, item.id);
      assert.deepEqual((await semantic.searchPublic(publicSemanticRequest(item.kind, { q: 'one', limit: 20 }))).items, []);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally { database.close(); }
  }
});

test('semantic queries exclude unavailable legacy records while Style rows remain available', async () => {
  const database = openCatalogDatabase();
  const modelClient = {
    async embed(inputs) { return inputs.map(() => createFixtureVector()); },
    async rerank(_query, documents) { return documents.map((_document, index) => ({ index, relevance_score: 1 })); }
  };
  try {
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at) VALUES
      (1, 'available work', 'available work', '[]', 'x', 1, ?, ?),
      (2, 'unavailable work', 'unavailable work', '[]', 'x', 1, ?, ?)` ).run(NOW, NOW, NOW, NOW);
    database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES
      (11, 1, 'available character', 'available character', '[]', 'cp', 1, ?, ?),
      (12, 1, 'unavailable character', 'unavailable character', '[]', 'cp', 1, ?, ?),
      (13, 2, 'character of unavailable work', 'character of unavailable work', '[]', 'cp', 1, ?, ?)` ).run(NOW, NOW, NOW, NOW, NOW, NOW);
    database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (20905, 'wai', ?, ?)").run(NOW, NOW);
    database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES
      (21, 20905, 'available style', '[]', 'sp', 'sd', NULL),
      (22, 20905, 'unavailable style', '[]', 'sp', 'sd', NULL)` ).run();
    database.prepare(`INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at) VALUES
      (31, 'available term', 0, 1, '[]', ?, ?),
      (32, 'deleted term', 0, 1, '[]', ?, ?)` ).run(NOW, NOW, NOW, NOW);

    await createWorkVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) }).rebuild({ reset: true });
    await createCharacterVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) }).rebuild({ reset: true });
    await createStyleVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) }).rebuild({ reset: true });
    await createPromptTermVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) }).rebuild({ reset: true });

    database.prepare("UPDATE works SET is_available = 0 WHERE id = 2").run();
    database.prepare("UPDATE characters SET is_available = 0 WHERE id = 12").run();
    database.prepare("DELETE FROM prompt_terms WHERE id = 32").run();
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);

    const cases = [
      ['work', createWorkSemanticService, [1]],
      ['character', createCharacterSemanticService, [11]],
      ['style', createStyleSemanticService, [21, 22]],
      ['prompt_term', createPromptTermSemanticService, [31]]
    ];
    for (const [kind, createSemantic, expectedIds] of cases) {
      const semantic = createSemantic({ database, modelClient, configuration });
      assert.deepEqual((await semantic.searchPublic(publicSemanticRequest(kind, { q: 'query', limit: 20 }))).items.map(({ id }) => id), expectedIds, kind);
      assert.deepEqual((await semantic.searchSkill(skillSemanticRequest(kind, { queries: ['query'], limit: 20 }))).groups[0].items.map(({ id }) => id), expectedIds, kind);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6, kind);
    }
  } finally {
    database.close();
  }
});
