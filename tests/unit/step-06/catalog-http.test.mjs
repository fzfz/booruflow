import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalogRepository } from '../../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../../app/catalog/catalog-service.mjs';
import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { createCatalogHttpDispatcher, startCatalogHttpListeners } from '../../../app/http/catalog-http.mjs';
import { RUNTIME_OPERATIONS } from '../../../app/http/runtime-operations.mjs';
import { ApplicationError, createErrorMapper } from '../../../app/security/error-mapping.mjs';
import { createCharacterSemanticService, createCharacterVectorMaintenance } from '../../../app/vector/character-semantic.mjs';
import { createFixtureVector } from '../../fixtures/vector/fake-semantic-model-client.mjs';

const NOW = '2026-07-27T00:00:00Z';

function emptyCatalogPage(kind) {
  return {
    contract_id: 'imagegen-source-contract',
    contract_version: 1,
    kind,
    items: [],
    page: 1,
    page_size: 20,
    total_count: 0
  };
}

function createHttpFixture({ serviceOverride, authorizeWrite, apiPublicPath = '/api' } = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  database.prepare(`INSERT INTO generation_base_models(id, name, created_at, updated_at)
    VALUES (1, 'Fixture Base', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
    VALUES (1, 'Arc', 'arc', '[]', 1, ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
    VALUES (2, 1, 'Keeper', 'keeper', '[]', 'ink', 1, ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
    VALUES (3, 1, 'Warm', '[]', 'paper', NULL, NULL)`).run();
  const catalogService = createCatalogService({ database, repository: createCatalogRepository(database) });
  const service = Object.freeze({
    ...catalogService,
    querySemanticBaseModelsForSkill: () => emptyCatalogPage('base-model'),
    querySemanticGenerationModelsForSkill: () => emptyCatalogPage('model'),
    ...serviceOverride
  });
  return {
    database,
    dispatcher: createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper(), authorizeWrite, apiPublicPath })
  };
}

function assertDirectDispatcherResult(result, { operationId, status, body }) {
  assert.equal(result.operationId, operationId);
  assert.deepEqual(Object.keys(result), ['status', 'body']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(result, 'operationId'), {
    value: operationId,
    writable: false,
    enumerable: false,
    configurable: false
  });
  assert.equal(result.status, status);
  assert.deepEqual(result.body, body);
  assert.equal(JSON.stringify(result), JSON.stringify({ status, body }));
}

test('catalog dispatcher rejects missing required constructor dependencies', () => {
  const errorMapper = createErrorMapper();
  assert.throws(
    () => createCatalogHttpDispatcher({ errorMapper }),
    /service is required/u
  );
  assert.throws(
    () => createCatalogHttpDispatcher({ service: {} }),
    /errorMapper is required/u
  );
});

test('catalog dispatcher preserves its public result shape while retaining the selected operationId across completion paths', async () => {
  const request = { listener: 'public', method: 'GET', url: '/api/works', requestId: 'catalog-operation' };
  const expectedSuccess = { ok: true, request_id: 'catalog-operation', data: { items: ['selected'] } };
  const expectedError = { ok: false, request_id: 'catalog-operation', error: { code: 'VALIDATION_ERROR', message: 'selected route failed' } };
  const cases = [
    { listPublicCatalog: () => ({ items: ['selected'] }), status: 200, body: expectedSuccess },
    { listPublicCatalog: () => { throw new ApplicationError('VALIDATION_ERROR', 'selected route failed'); }, status: 422, body: expectedError },
    { listPublicCatalog: () => Promise.resolve({ items: ['selected'] }), status: 200, body: expectedSuccess },
    { listPublicCatalog: () => Promise.reject(new ApplicationError('VALIDATION_ERROR', 'selected route failed')), status: 422, body: expectedError }
  ];
  for (const scenario of cases) {
    const { database, dispatcher } = createHttpFixture({ serviceOverride: { listPublicCatalog: scenario.listPublicCatalog } });
    try {
      const result = await dispatcher.dispatch(request);
      assertDirectDispatcherResult(result, { operationId: 'listWorks', status: scenario.status, body: scenario.body });
    } finally {
      database.close();
    }
  }
  const { database, dispatcher } = createHttpFixture({ serviceOverride: { listPublicCatalog: () => ({ items: [] }) } });
  try {
    const result = dispatcher.dispatch({ ...request, requestError: new ApplicationError('VALIDATION_ERROR', 'request body failed') });
    assertDirectDispatcherResult(result, {
      operationId: 'listWorks',
      status: 422,
      body: { ok: false, request_id: 'catalog-operation', error: { code: 'VALIDATION_ERROR', message: 'request body failed' } }
    });
  } finally {
    database.close();
  }
});

test('real public semantic character dispatch treats omitted work_id as null and rejects malformed filters before model calls', async () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  const calls = [];
  const configuration = Object.freeze({ embedding_model: 'fake', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 });
  const modelClient = {
    async embed(inputs) { calls.push(['embed', inputs]); return inputs.map(() => createFixtureVector()); },
    async rerank(query, documents) { calls.push(['rerank', query, documents]); return documents.map((_document, index) => ({ index, relevance_score: 1 })); }
  };
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024 WHERE object_kind = 'character'").run();
    database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
      VALUES (1, 'Arc', 'arc', '[]', 1, ?, ?)` ).run(NOW, NOW);
    database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
      VALUES (2, 1, 'Keeper', 'keeper', '[]', 'ink', 1, ?, ?)` ).run(NOW, NOW);
    const characterSemanticService = createCharacterSemanticService({ database, modelClient, configuration });
    await createCharacterVectorMaintenance({ database, modelClient, configuration, now: () => new Date(NOW) }).rebuild({ reset: true });
    calls.length = 0;
    const received = [];
    const catalogService = createCatalogService({ database, repository: createCatalogRepository(database), characterSemanticService });
    const service = Object.freeze({
      ...catalogService,
      searchSemanticCharacters(input) { received.push(input); return characterSemanticService.searchPublic(input); }
    });
    const dispatcher = createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper() });
    const listeners = await startCatalogHttpListeners({
      dispatcher,
      config: { listeners: { public: { host: '127.0.0.1', port: 0 }, internal: { host: '127.0.0.1', port: 0 } } }
    });
    try {
      const baseUrl = `http://127.0.0.1:${listeners.publicAddress.port}`;
      for (const [label, url, expectedStatus, expectedWorkId] of [
        ['omitted', '/api/semantic/characters?q=Keeper', 200, null],
        ['positive', '/api/semantic/characters?q=Keeper&work_id=1', 200, 1],
        ['zero', '/api/semantic/characters?q=Keeper&work_id=0', 422, undefined],
        ['NaN', '/api/semantic/characters?q=Keeper&work_id=NaN', 422, undefined],
        ['string', '/api/semantic/characters?q=Keeper&work_id=abc', 422, undefined]
      ]) {
        const response = await fetch(`${baseUrl}${url}`, { headers: { 'x-request-id': `semantic-work-${label}` } });
        const result = { status: response.status, body: await response.json() };
        assert.equal(result.status, expectedStatus, label);
        if (expectedStatus === 422) assert.equal(result.body.error.code, 'SEMANTIC_QUERY_VALIDATION', label);
        else assert.equal(result.body.data.items[0].id, 2, label);
        if (expectedWorkId === undefined) assert.equal(calls.length, 4, `${label} must fail before model calls`);
      }
      assert.deepEqual(received, [
        { q: 'Keeper', limit: undefined, work_id: null },
        { q: 'Keeper', limit: undefined, work_id: 1 },
        { q: 'Keeper', limit: undefined, work_id: 0 },
        { q: 'Keeper', limit: undefined, work_id: Number.NaN },
        { q: 'Keeper', limit: undefined, work_id: Number.NaN }
      ]);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally {
      await listeners.close();
    }
  } finally {
    database.close();
  }
});

test('routes public catalog operations through the configured API prefix', () => {
  const custom = createHttpFixture({ apiPublicPath: '/backend/api' });
  const empty = createHttpFixture({ apiPublicPath: '' });
  try {
    assert.equal(custom.dispatcher.dispatch({ listener: 'public', method: 'get', url: '/backend/api/works', requestId: 'custom-api' }).status, 200);
    assert.equal(custom.dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/works', requestId: 'wrong-api' }).status, 404);
    assert.equal(empty.dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/works', requestId: 'root-api' }).status, 200);
    assert.equal(custom.dispatcher.dispatch({ listener: 'public', method: 'PATCH', url: '/backend/api/works', requestId: 'unsupported-method' }).status, 404);
    assert.equal(custom.dispatcher.dispatch({ listener: 'internal', method: 'patch', url: '/internal/semantic/works', requestId: 'unsupported-internal-method' }).status, 404);
  } finally {
    custom.database.close();
    empty.database.close();
  }
});

test('catalog dispatcher declares only routes backed by its available service handlers', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    const dispatcher = createCatalogHttpDispatcher({
      service: {
        listPublicCatalog: () => ({ items: [] })
      },
      errorMapper: createErrorMapper()
    });
    assert.deepEqual([...dispatcher.implementedOperations].sort(), [
      'listCharacters', 'listStyles', 'listWorkCharacters', 'listWorks'
    ]);
    assert.deepEqual(dispatcher.runtimeRouteInventory.map(({ operationId }) => operationId).sort(), [...dispatcher.implementedOperations].sort());
    const unsupported = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/works/1', requestId: 'missing-get-work' });
    assert.equal(unsupported.status, 404);
    assert.equal(unsupported.body.error.code, 'NOT_FOUND');
  } finally {
    database.close();
  }
});

test('catalog dispatcher invokes shared and one-to-one handlers through their operation mappings', () => {
  const calls = [];
  const dispatcher = createCatalogHttpDispatcher({
    service: {
      listPublicCatalog: (kind, query) => {
        calls.push(['listPublicCatalog', kind, query]);
        return { items: [kind] };
      },
      getWork: (workId) => {
        calls.push(['getWork', workId]);
        return { id: workId };
      }
    },
    errorMapper: createErrorMapper()
  });
  const requests = [
    ['GET', '/api/works', 'listWorks'],
    ['GET', '/api/characters', 'listCharacters'],
    ['GET', '/api/styles', 'listStyles'],
    ['GET', '/api/works/7/characters', 'listWorkCharacters'],
    ['GET', '/api/works/7', 'getWork']
  ];
  for (const [method, url, operationId] of requests) {
    const response = dispatcher.dispatch({ listener: 'public', method, url, requestId: `mapped-${operationId}` });
    assert.equal(response.status, 200, operationId);
    assert.equal(response.operationId, operationId);
  }
  assert.deepEqual(calls, [
    ['listPublicCatalog', 'work', { query: '', limit: undefined, cursor: null }],
    ['listPublicCatalog', 'character', { query: '', limit: undefined, cursor: null }],
    ['listPublicCatalog', 'style', { query: '', limit: undefined, cursor: null }],
    ['listPublicCatalog', 'character', { query: '', limit: undefined, cursor: null, workId: 7 }],
    ['getWork', 7]
  ]);
});

test('covers every implemented HTTP operation with a declared OpenAPI operation and error-catalog status', () => {
  const { database, dispatcher } = createHttpFixture();
  try {
    const declaredOperations = new Set(RUNTIME_OPERATIONS.map((operation) => operation.operationId));
    const implementedOperations = [...dispatcher.implementedOperations].sort();
    assert.equal(implementedOperations.every((operationId) => declaredOperations.has(operationId)), true, '运行时 operation 白名单必须与 OpenAPI 和错误目录同步');
    assert.deepEqual(implementedOperations.filter((operationId) => operationId.startsWith('querySemantic')).sort(), [
      'querySemanticArtistPromptStringsForSkill',
      'querySemanticBaseModelsForSkill',
      'querySemanticCharactersForSkill',
      'querySemanticComfyuiInstancesForSkill',
      'querySemanticComfyuiTemplatesForSkill',
      'querySemanticGenerationModelsForSkill',
      'querySemanticLorasForSkill',
      'querySemanticPromptTermsForSkill',
      'querySemanticStylesForSkill',
      'querySemanticWorksForSkill'
    ]);
    const publicRequests = [
      ['GET', '/api/works'], ['GET', '/api/works/1'], ['GET', '/api/works/1/characters'],
      ['GET', '/api/characters'], ['GET', '/api/characters/2'], ['GET', '/api/styles'], ['GET', '/api/styles/3'], ['GET', '/api/search?q=arc'],
      ['GET', '/api/manage/items?kind=all&limit=10'], ['GET', '/api/manage/items/work/1']
    ];
    for (const [method, url] of publicRequests) {
      const response = dispatcher.dispatch({ listener: 'public', method, url, requestId: `ok-${url}` });
      assert.equal(response.status, 200, url);
      assert.equal(response.body.ok, true, url);
    }
    const missing = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/works/99', requestId: 'r2' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
    const invalid = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/search?q=%20', requestId: 'r3' });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  } finally {
    database.close();
  }
});

test('maps database busy errors to the declared response', () => {
  const busyService = { listPublicCatalog: () => { throw new Error('SQLITE_BUSY: database is locked'); } };
  const busy = createHttpFixture({ serviceOverride: busyService });
  try {
    const response = busy.dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/works', requestId: 'r4' });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'DATABASE_BUSY');
  } finally {
    busy.database.close();
  }
});

test('rejects a non-loopback internal listener before opening a socket', async () => {
  const { database, dispatcher } = createHttpFixture();
  try {
    await assert.rejects(() => startCatalogHttpListeners({
      dispatcher,
      config: { listeners: { public: { host: '0.0.0.0', port: 0 }, internal: { host: '0.0.0.0', port: 0 } } }
    }), /127\.0\.0\.1/u);
  } finally {
    database.close();
  }
});
