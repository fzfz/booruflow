import assert from 'node:assert/strict';
import test from 'node:test';

import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';
import { createPromptTermSemanticService } from '../../app/vector/prompt-term-semantic.mjs';
import { upsertVectorEntry, writeVectorSpaceConfiguration } from '../../app/vector/vector-store.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const REPOSITORY_ROOT = new URL('../..', import.meta.url).pathname;
const NOW = '2026-08-22T00:00:00.000Z';
const PROMPT_TERM_PATH = '/internal/semantic/prompt-terms';
const CATALOG_DISCOVERY_PATHS = Object.freeze([
  '/internal/semantic/base-models',
  '/internal/semantic/generation-models',
  '/internal/semantic/loras',
  '/internal/semantic/works',
  '/internal/semantic/characters',
  '/internal/semantic/styles',
  PROMPT_TERM_PATH,
  '/internal/semantic/artist-prompt-strings',
  '/internal/semantic/comfyui-instances',
  '/internal/semantic/comfyui-templates'
]);
const PROMPT_TERM_CONFIG = Object.freeze({
  embedding_model: 'issue-281-prompt-term-embedding',
  reranker_candidate_limit: 3,
  reranker_min_relevance_score: 0.5
});

function seed(database) {
  database.exec(`
    INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at)
      VALUES
        (28101, 'search', 0, 10, '["lookup"]', '${NOW}', '${NOW}'),
        (28102, 'zeta term', 1, 20, '["zeta alias", "z"]', '${NOW}', '${NOW}'),
        (28103, 'alpha term', 3, 30, '["alpha alias"]', '${NOW}', '${NOW}'),
        (28104, 'threshold term', 4, 40, '["threshold alias"]', '${NOW}', '${NOW}'),
        (28105, 'later term', 5, 50, '["later alias"]', '${NOW}', '${NOW}');
  `);
  writeVectorSpaceConfiguration(database, 'prompt_term', {
    embeddingModel: PROMPT_TERM_CONFIG.embedding_model,
    dimension: 1024
  });
  for (const [id, vector] of [
    [28101, createFixtureVector(0.1, Math.sqrt(0.99))],
    [28102, createFixtureVector(0.9, Math.sqrt(0.19))],
    [28103, createFixtureVector(0.9, Math.sqrt(0.19))],
    [28104, createFixtureVector(0.8, 0.6)],
    [28105, createFixtureVector(0.7, Math.sqrt(0.51))]
  ]) upsertVectorEntry(database, 'prompt_term', id, vector, { expectedModel: PROMPT_TERM_CONFIG.embedding_model });
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
        ['zeta term\nzeta alias\nz', 0.8],
        ['alpha term\nalpha alias', 0.8],
        ['threshold term\nthreshold alias', 0.49]
      ]);
      return documents.map((document, index) => ({ index, relevance_score: scoreByDocument.get(document) ?? 0.1 }));
    }
  });
}

function fixture(options = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seed(database);
  const calls = [];
  const configuration = options.configuration ?? PROMPT_TERM_CONFIG;
  const promptTermSemanticService = createPromptTermSemanticService({
    database,
    modelClient: modelClient(calls, options),
    configuration
  });
  const repository = createCatalogRepository(database);
  const service = createCatalogService({
    database,
    repository,
    repositoryRoot: REPOSITORY_ROOT,
    promptTermSemanticService
  });
  return { database, calls, service };
}

function promptTermPage(items, { page = 1, pageSize = 20, totalCount = items.length } = {}) {
  return {
    status: 'ok',
    message: null,
    results: items,
    page,
    page_size: pageSize,
    total_count: totalCount
  };
}

function promptTermItem({ id, canonicalTag, aliases, category, postCount }) {
  return {
    id,
    canonical_tag: canonicalTag,
    aliases_json: aliases,
    category,
    post_count: postCount,
    sample_image_urls: []
  };
}

test('Issue 281 prompt-term Catalog uses canonical_tag and aliases in order, has no exact-name priority, and paginates finite reranker results', async () => {
  const { database, calls, service } = fixture();
  try {
    const page = await service.querySemanticPromptTermsForSkill({ mode: 'search', query: '  search  ', page: 1, page_size: 1 });
    assert.deepEqual(page, promptTermPage([
      promptTermItem({ id: 28103, canonicalTag: 'alpha term', aliases: ['alpha alias'], category: 3, postCount: 30 })
    ], { pageSize: 1, totalCount: 2 }));
    assert.deepEqual(calls, [
      { kind: 'embed', inputs: ['search'] },
      {
        kind: 'rerank',
        query: 'search',
        documents: [
          'zeta term\nzeta alias\nz',
          'alpha term\nalpha alias',
          'threshold term\nthreshold alias'
        ]
      }
    ]);
    assert.deepEqual((await service.querySemanticPromptTermsForSkill({ mode: 'search', query: 'search', page: 2, page_size: 1 })).results.map(({ id }) => id), [28102]);
    assert.deepEqual(await service.querySemanticPromptTermsForSkill({ mode: 'search', query: 'search', page: 3, page_size: 1 }), promptTermPage([], { page: 3, pageSize: 1, totalCount: 2 }));
  } finally {
    database.close();
  }
});

test('Issue 281 prompt-term Catalog empty and resolve branches use SQLite only, sort by id DESC, and preserve data fields', async () => {
  const { database, calls, service } = fixture({
    embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE'),
    rerankerError: new ApplicationError('RERANKER_UNAVAILABLE')
  });
  try {
    const empty = await service.querySemanticPromptTermsForSkill({ mode: 'search', query: '   ', page: 1, page_size: 3 });
    assert.deepEqual(empty.results.map(({ id }) => id), [28105, 28104, 28103]);
    assert.equal(empty.total_count, 5);
    assert.deepEqual(await service.querySemanticPromptTermsForSkill({ mode: 'search', query: '', page: 2, page_size: 3 }), promptTermPage([
      promptTermItem({ id: 28102, canonicalTag: 'zeta term', aliases: ['zeta alias', 'z'], category: 1, postCount: 20 }),
      promptTermItem({ id: 28101, canonicalTag: 'search', aliases: ['lookup'], category: 0, postCount: 10 })
    ], { page: 2, pageSize: 3, totalCount: 5 }));
    assert.deepEqual(await service.querySemanticPromptTermsForSkill({ mode: 'resolve', id: '28101' }), promptTermPage([
      promptTermItem({ id: 28101, canonicalTag: 'search', aliases: ['lookup'], category: 0, postCount: 10 })
    ], { pageSize: 1, totalCount: 1 }));
    assert.equal(Object.hasOwn((await service.querySemanticPromptTermsForSkill({ mode: 'resolve', id: '28101' })).results[0], 'cover_url'), false);
    assert.equal(calls.length, 0);
  } finally {
    database.close();
  }
});

test('Issue 281 prompt-term Catalog maps index, dependency, and timeout errors only for non-empty semantic query', async () => {
  const unavailable = fixture({ embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE') });
  try {
    await assert.rejects(() => unavailable.service.querySemanticPromptTermsForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_UNAVAILABLE');
  } finally {
    unavailable.database.close();
  }

  const timeout = fixture({ rerankerError: new ApplicationError('RERANKER_TIMEOUT') });
  try {
    await assert.rejects(() => timeout.service.querySemanticPromptTermsForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_TIMEOUT');
  } finally {
    timeout.database.close();
  }

  const notReady = fixture();
  try {
    notReady.database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__' WHERE object_kind = 'prompt_term'").run();
    await assert.rejects(() => notReady.service.querySemanticPromptTermsForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_INDEX_NOT_READY');
    await notReady.service.querySemanticPromptTermsForSkill({ mode: 'search', query: '' });
    await notReady.service.querySemanticPromptTermsForSkill({ mode: 'resolve', id: '28101' });
    assert.equal(notReady.calls.length, 0);
  } finally {
    notReady.database.close();
  }
});

test('Issue 281 prompt-term Catalog discovery, HTTP validation, and error projection expose the closed operation', async () => {
  const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(Object.keys(discovery.paths), CATALOG_DISCOVERY_PATHS);
  assert.ok(discovery.paths[PROMPT_TERM_PATH]);
  const operation = discovery.paths[PROMPT_TERM_PATH].post;
  assert.equal(operation.operationId, 'querySemanticPromptTermsForSkill');
  assert.equal(operation['x-harness-tool-name'], 'query_semantic_prompt_terms');
  assert.equal(operation.description, 'Semantically search or resolve canonical prompt-term records and their aliases.');
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogPromptTermSearchRequest.properties), ['mode', 'query', 'page', 'page_size']);
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogPromptTermResolveRequest.properties), ['mode', 'id']);
  assert.equal(discovery.components.schemas.CatalogSourceResultRecord.additionalProperties, true);

  const calls = [];
  const service = {
    querySemanticPromptTermsForSkill(request) {
      calls.push(request);
      if (request.mode === 'search' && request.query === 'down') throw new ApplicationError('CATALOG_DEPENDENCY_UNAVAILABLE');
      return promptTermPage([]);
    }
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: discovery
  });
  const success = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: PROMPT_TERM_PATH, body: { mode: 'search' } });
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, promptTermPage([]));
  const invalid = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: PROMPT_TERM_PATH, body: { mode: 'resolve', id: '1', query: '' } });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  const dependency = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: PROMPT_TERM_PATH, body: { mode: 'search', query: 'down' } });
  assert.equal(dependency.status, 502);
  assert.deepEqual(dependency.body, { status: 'error', message: 'Catalog dependency is unavailable.', results: [], page: 1, page_size: 0, total_count: 0 });
  assert.deepEqual(calls, [
    { mode: 'search', query: '', page: 1, page_size: 20 },
    { mode: 'search', query: 'down', page: 1, page_size: 20 }
  ]);
});
