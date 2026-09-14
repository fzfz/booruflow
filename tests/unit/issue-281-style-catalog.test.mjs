import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';
import { createStyleSemanticService } from '../../app/vector/style-semantic.mjs';
import { upsertVectorEntry, writeVectorSpaceConfiguration } from '../../app/vector/vector-store.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const REPOSITORY_ROOT = new URL('../..', import.meta.url).pathname;
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const NOW = '2026-08-22T00:00:00.000Z';
const STYLE_PATH = '/internal/semantic/styles';
const MEDIA_ORIGIN = 'http://127.0.0.1:19082';
const MEDIA_PREFIX = '/media';
const CATALOG_DISCOVERY_PATHS = Object.freeze([
  '/internal/semantic/base-models',
  '/internal/semantic/generation-models',
  '/internal/semantic/loras',
  '/internal/semantic/works',
  '/internal/semantic/characters',
  STYLE_PATH,
  '/internal/semantic/prompt-terms',
  '/internal/semantic/artist-prompt-strings',
  '/internal/semantic/comfyui-instances',
  '/internal/semantic/comfyui-templates'
]);
const STYLE_CONFIG = Object.freeze({
  embedding_model: 'issue-281-style-embedding',
  reranker_candidate_limit: 3,
  reranker_min_relevance_score: 0.5
});

function seed(database) {
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES
        (28101, 'WAI', '${NOW}', '${NOW}'),
        (28102, 'Anima', '${NOW}', '${NOW}');
    INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
      VALUES
        (28101, 28101, 'Copper   Reverie', '["copper alias", "reverie"]', 'copper prompt', 'copper description', NULL),
        (28102, 28101, 'Bright Decoy', '["bright alias"]', 'bright prompt', 'bright description', NULL),
        (28103, 28101, 'Second Decoy', '["second alias"]', 'second prompt', 'second description', NULL),
        (28104, 28101, 'Threshold Drop', '[]', 'drop prompt', 'drop description', NULL),
        (28105, 28101, 'Later Copper', '[]', 'later prompt', 'later description', NULL),
        (28106, 28102, 'Copper Reverie', '["anima alias"]', 'anima prompt', 'anima description', NULL),
        (28107, 28102, 'Anima Other', '[]', 'anima other prompt', 'anima other description', NULL);
  `);
  writeVectorSpaceConfiguration(database, 'style', {
    embeddingModel: STYLE_CONFIG.embedding_model,
    dimension: 1024
  });
  for (const [id, vector] of [
    [28101, createFixtureVector(0.85, Math.sqrt(0.2775))],
    [28102, createFixtureVector(1, 0)],
    [28103, createFixtureVector(0.9, Math.sqrt(0.19))],
    [28104, createFixtureVector(0.8, 0.6)],
    [28105, createFixtureVector(0.7, Math.sqrt(0.51))],
    [28106, createFixtureVector(0.1, Math.sqrt(0.99))],
    [28107, createFixtureVector(0.05, Math.sqrt(0.9975))]
  ]) upsertVectorEntry(database, 'style', id, vector, { expectedModel: STYLE_CONFIG.embedding_model });
}

function modelClient(calls, { embeddingError = null, rerankerError = null } = {}) {
  return Object.freeze({
    async embed(inputs) {
      calls.push({ kind: 'embed', inputs: [...inputs] });
      if (embeddingError !== null) throw embeddingError;
      return inputs.map(() => createFixtureVector());
    },
    async rerank(query, documents) {
      calls.push({ kind: 'rerank', query, documents: [...documents] });
      if (rerankerError !== null) throw rerankerError;
      const scoreByDocument = new Map([
        ['Copper   Reverie\ncopper alias\nreverie\ncopper description\ncopper prompt', 0.8],
        ['Bright Decoy\nbright alias\nbright description\nbright prompt', 0.8],
        ['Second Decoy\nsecond alias\nsecond description\nsecond prompt', 0.8],
        ['Threshold Drop\ndrop description\ndrop prompt', 0.49],
        ['Copper Reverie\nanima alias\nanima description\nanima prompt', 0.9],
        ['Anima Other\nanima other description\nanima other prompt', 0.8]
      ]);
      return documents.map((document, index) => ({
        index,
        relevance_score: query === 'watercolor' && document.startsWith('Copper   Reverie\n')
          ? 0.1
          : scoreByDocument.get(document) ?? 0.1
      }));
    }
  });
}

function fixture(options = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seed(database);
  const calls = [];
  const configuration = options.configuration ?? STYLE_CONFIG;
  const styleSemanticService = createStyleSemanticService({
    database,
    modelClient: modelClient(calls, options),
    configuration
  });
  const repository = createCatalogRepository(database);
  const service = createCatalogService({
    database,
    repository,
    repositoryRoot: REPOSITORY_ROOT,
    mediaOrigin: MEDIA_ORIGIN,
    mediaPublicPrefix: MEDIA_PREFIX,
    styleSemanticService
  });
  return { database, calls, service };
}

function stylePage(items, { page = 1, pageSize = 20, totalCount = items.length } = {}) {
  return {
    status: 'ok',
    message: null,
    results: items,
    page,
    page_size: pageSize,
    total_count: totalCount
  };
}

function styleItem({ id, baseModelId, name, aliases, promptText, description, coverUrl = null, sampleImageUrls = [] }) {
  return {
    id,
    base_model_id: baseModelId,
    name,
    aliases_json: aliases,
    prompt_text: promptText,
    style_description: description,
    cover_url: coverUrl,
    sample_image_urls: sampleImageUrls
  };
}

test('Issue 281 style Catalog uses the style projection, exact-name priority before candidate limit, tie ordering, threshold, and stable pagination', async () => {
  const { database, calls, service } = fixture();
  try {
    const page = await service.querySemanticStylesForSkill({ mode: 'search', query: '  copper reverie  ', page: 1, page_size: 2, base_model_id: '28101' });
    assert.deepEqual(page, stylePage([
      styleItem({ id: 28102, baseModelId: 28101, name: 'Bright Decoy', aliases: ['bright alias'], promptText: 'bright prompt', description: 'bright description' }),
      styleItem({ id: 28101, baseModelId: 28101, name: 'Copper   Reverie', aliases: ['copper alias', 'reverie'], promptText: 'copper prompt', description: 'copper description' })
    ], { pageSize: 2, totalCount: 3 }));
    assert.deepEqual(calls, [
      { kind: 'embed', inputs: ['copper reverie'] },
      {
        kind: 'rerank',
        query: 'copper reverie',
        documents: [
          'Copper   Reverie\ncopper alias\nreverie\ncopper description\ncopper prompt',
          'Bright Decoy\nbright alias\nbright description\nbright prompt',
          'Second Decoy\nsecond alias\nsecond description\nsecond prompt'
        ]
      }
    ]);
    assert.deepEqual((await service.querySemanticStylesForSkill({ mode: 'search', query: 'copper reverie', page: 2, page_size: 2, base_model_id: '28101' })).results.map(({ id }) => id), [28103]);
    assert.deepEqual(await service.querySemanticStylesForSkill({ mode: 'search', query: 'copper reverie', page: 3, page_size: 2, base_model_id: '28101' }), stylePage([], { page: 3, pageSize: 2, totalCount: 3 }));
  } finally {
    database.close();
  }
});

test('Issue 281 Style keeps a normalized exact-name candidate ranked below the KNN limit in both query paths', async () => {
  const { database, calls } = fixture({ configuration: { ...STYLE_CONFIG, reranker_min_relevance_score: 0 } });
  const statements = [];
  try {
    database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
      VALUES (28108, 28101, 'Remote   Exact', '[]', 'remote prompt', 'remote description', NULL)`).run();
    upsertVectorEntry(database, 'style', 28108, createFixtureVector(0.82, Math.sqrt(0.3276)), { expectedModel: STYLE_CONFIG.embedding_model });

    const remoteExact = 'Remote   Exact\nremote description\nremote prompt';
    const tracedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'function') return target.function.bind(target);
        if (property !== 'prepare') return Reflect.get(target, property, receiver);
        return (sql) => {
          const statement = target.prepare(sql);
          if (!/vector_knn_index/u.test(String(sql))) return statement;
          return {
            all(...args) {
              const rows = statement.all(...args);
              statements.push({ sql: String(sql), args, rows });
              return rows;
            },
            get(...args) {
              statements.push({ sql: String(sql), args });
              return statement.get(...args);
            },
            run(...args) {
              statements.push({ sql: String(sql), args });
              return statement.run(...args);
            }
          };
        };
      }
    });
    const tracedService = createStyleSemanticService({
      database: tracedDatabase,
      modelClient: {
        async embed(inputs) { return inputs.map(() => createFixtureVector()); },
        async rerank(query, documents) {
          calls.push({ kind: 'rerank-exact', query, documents: [...documents] });
          return documents.map((document, index) => ({ index, relevance_score: document === remoteExact ? 0.99 : 0.8 }));
        }
      },
      configuration: { ...STYLE_CONFIG, reranker_min_relevance_score: 0 }
    });

    const publicResult = await tracedService.searchPublic({ q: ' remote exact ', limit: 20, base_model_name: 'WAI' });
    assert.equal(publicResult.items[0].id, 28108);
    const catalogResult = await tracedService.searchCatalog({ query: 'remote exact', page: 1, page_size: 20, base_model_id: '28101' });
    assert.equal(catalogResult.rows[0].id, 28108);
    const rerankCalls = calls.filter(({ kind }) => kind === 'rerank-exact');
    assert.equal(rerankCalls.length, 2);
    for (const call of rerankCalls) {
      assert.deepEqual(call.documents, [remoteExact, 'Bright Decoy\nbright alias\nbright description\nbright prompt', 'Second Decoy\nsecond alias\nsecond description\nsecond prompt']);
      assert.equal(call.documents.length <= STYLE_CONFIG.reranker_candidate_limit, true);
    }
    const knn = statements.filter(({ sql }) => /embedding\s+MATCH/u.test(sql));
    assert.equal(knn.length, 2);
    for (const statement of knn) {
      assert.equal(statement.args[1], BigInt(STYLE_CONFIG.reranker_candidate_limit));
      assert.deepEqual(statement.rows.map(({ object_id: objectId }) => objectId), [28102, 28103, 28101]);
    }
    const exactDistance = statements.filter(({ sql }) => /vec_distance_l2/u.test(sql));
    assert.equal(exactDistance.length, 2);
  } finally {
    database.close();
  }
});

test('Issue 281 style Catalog applies base_model_id to finite KNN candidates and keeps a valid empty filter successful', async () => {
  const { database, calls, service } = fixture({ configuration: { ...STYLE_CONFIG, reranker_candidate_limit: 7 } });
  try {
    const filtered = await service.querySemanticStylesForSkill({ mode: 'search', query: 'copper reverie', base_model_id: '28102', page: 1, page_size: 20 });
    assert.deepEqual(filtered.results.map(({ id }) => id), [28106, 28107]);
    assert.deepEqual(calls, [
      { kind: 'embed', inputs: ['copper reverie'] },
      { kind: 'rerank', query: 'copper reverie', documents: [
        'Copper Reverie\nanima alias\nanima description\nanima prompt',
        'Anima Other\nanima other description\nanima other prompt'
      ] }
    ]);
    calls.length = 0;
    assert.deepEqual(await service.querySemanticStylesForSkill({ mode: 'search', query: 'copper reverie', base_model_id: '28102', page: 2, page_size: 20 }), stylePage([], { page: 2, pageSize: 20, totalCount: 2 }));
    assert.equal(calls.length, 2);
    assert.deepEqual(await service.querySemanticStylesForSkill({ mode: 'search', query: '', base_model_id: '28102', page: 1, page_size: 20 }), stylePage([
      styleItem({ id: 28107, baseModelId: 28102, name: 'Anima Other', aliases: [], promptText: 'anima other prompt', description: 'anima other description' }),
      styleItem({ id: 28106, baseModelId: 28102, name: 'Copper Reverie', aliases: ['anima alias'], promptText: 'anima prompt', description: 'anima description' })
    ], { totalCount: 2 }));
  } finally {
    database.close();
  }
});

test('Issue 281 style Catalog removes reranker results below the fixed threshold before total_count and pagination', async () => {
  const { database, calls, service } = fixture({ configuration: { ...STYLE_CONFIG, reranker_candidate_limit: 4 } });
  try {
    const page = await service.querySemanticStylesForSkill({ mode: 'search', query: 'watercolor', base_model_id: '28101', page: 1, page_size: 20 });
    assert.equal(page.total_count, 2);
    assert.deepEqual(page.results.map(({ id }) => id), [28102, 28103]);
    assert.equal(calls[1].documents.includes('Threshold Drop\ndrop description\ndrop prompt'), true);
  } finally {
    database.close();
  }
});

test('Issue 281 style Catalog empty and resolve branches use SQLite only, sort by id DESC, and preserve equal rows', async () => {
  const { database, calls, service } = fixture({
    embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE'),
    rerankerError: new ApplicationError('RERANKER_UNAVAILABLE')
  });
  try {
    const empty = await service.querySemanticStylesForSkill({ mode: 'search', query: '   ', page: 1, page_size: 3 });
    assert.deepEqual(empty.results.map(({ id }) => id), [28107, 28106, 28105]);
    assert.equal(empty.total_count, 7);
    assert.deepEqual(await service.querySemanticStylesForSkill({ mode: 'search', query: '', page: 3, page_size: 3 }), stylePage([
      styleItem({ id: 28101, baseModelId: 28101, name: 'Copper   Reverie', aliases: ['copper alias', 'reverie'], promptText: 'copper prompt', description: 'copper description' })
    ], { page: 3, pageSize: 3, totalCount: 7 }));
    assert.deepEqual(await service.querySemanticStylesForSkill({ mode: 'resolve', id: '28101' }), stylePage([
      styleItem({ id: 28101, baseModelId: 28101, name: 'Copper   Reverie', aliases: ['copper alias', 'reverie'], promptText: 'copper prompt', description: 'copper description' })
    ], { pageSize: 1, totalCount: 1 }));
    assert.equal(calls.length, 0);
    await assert.rejects(() => service.querySemanticStylesForSkill({ mode: 'resolve', id: '28999' }), (error) => error?.code === 'CATALOG_REF_NOT_FOUND');
    await assert.rejects(() => service.querySemanticStylesForSkill({ mode: 'search', query: 'copper', base_model_id: '28999' }), (error) => error?.code === 'CATALOG_REQUEST_INVALID');
    assert.equal(calls.length, 0);
  } finally {
    database.close();
  }
});

test('Issue 281 style Catalog projects direct non-cover images identically for search and resolve', async () => {
  const { database, service } = fixture();
  try {
    database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (281011, 'style', 28101, 'hash-281011', 'styles/copper-sample.webp', 1, ?, ?)`).run(NOW, NOW);
    const expectedUrl = `${MEDIA_ORIGIN}${MEDIA_PREFIX}/styles/copper-sample.webp`;

    const searchItem = (await service.querySemanticStylesForSkill({ mode: 'search', query: '', page: 1, page_size: 20 }))
      .results.find(({ id }) => id === 28101);
    const resolveItem = (await service.querySemanticStylesForSkill({ mode: 'resolve', id: '28101' })).results[0];

    assert.deepEqual(searchItem.sample_image_urls, [expectedUrl]);
    assert.deepEqual(resolveItem.sample_image_urls, [expectedUrl]);
  } finally {
    database.close();
  }
});

test('Issue 281 style Catalog maps index, dependency, and timeout errors only for non-empty semantic query', async () => {
  const unavailable = fixture({ embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE') });
  try {
    await assert.rejects(() => unavailable.service.querySemanticStylesForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_UNAVAILABLE');
  } finally {
    unavailable.database.close();
  }

  const timeout = fixture({ rerankerError: new ApplicationError('RERANKER_TIMEOUT') });
  try {
    await assert.rejects(() => timeout.service.querySemanticStylesForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_TIMEOUT');
  } finally {
    timeout.database.close();
  }

  const notReady = fixture();
  try {
    notReady.database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__' WHERE object_kind = 'style'").run();
    await assert.rejects(() => notReady.service.querySemanticStylesForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_INDEX_NOT_READY');
    await notReady.service.querySemanticStylesForSkill({ mode: 'search', query: '' });
    await notReady.service.querySemanticStylesForSkill({ mode: 'resolve', id: '28101' });
    assert.equal(notReady.calls.length, 0);
  } finally {
    notReady.database.close();
  }
});

test('Issue 281 style Catalog discovery, HTTP validation, and error projection expose the closed base_model_id operation', async () => {
  const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(Object.keys(discovery.paths), CATALOG_DISCOVERY_PATHS);
  assert.ok(discovery.paths[STYLE_PATH]);
  const operation = discovery.paths[STYLE_PATH].post;
  assert.equal(operation.operationId, 'querySemanticStylesForSkill');
  assert.equal(operation['x-harness-tool-name'], 'query_semantic_styles');
  assert.equal(operation.description, 'Semantically search or resolve style records with descriptions and prompt semantics.');
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogStyleSearchRequest.properties), ['mode', 'query', 'page', 'page_size', 'base_model_id']);
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogStyleResolveRequest.properties), ['mode', 'id']);
  assert.equal(discovery.components.schemas.CatalogSourceResultRecord.additionalProperties, true);

  const calls = [];
  const service = {
    querySemanticStylesForSkill(request) {
      calls.push(request);
      if (request.mode === 'search' && request.query === 'down') throw new ApplicationError('CATALOG_DEPENDENCY_UNAVAILABLE');
      return stylePage([]);
    }
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: discovery
  });
  const success = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: STYLE_PATH, body: { mode: 'search', base_model_id: '28101' } });
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, stylePage([]));
  const invalid = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: STYLE_PATH, body: { mode: 'resolve', id: '1', base_model_id: '28101' } });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  const dependency = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: STYLE_PATH, body: { mode: 'search', query: 'down' } });
  assert.equal(dependency.status, 502);
  assert.deepEqual(dependency.body, { status: 'error', message: 'Catalog dependency is unavailable.', results: [], page: 1, page_size: 0, total_count: 0 });
  assert.deepEqual(calls, [
    { mode: 'search', query: '', page: 1, page_size: 20, base_model_id: '28101' },
    { mode: 'search', query: 'down', page: 1, page_size: 20 }
  ]);
});
