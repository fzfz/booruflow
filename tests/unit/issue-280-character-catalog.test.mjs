import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';
import { createCharacterSemanticService } from '../../app/vector/character-semantic.mjs';
import { upsertVectorEntry, writeVectorSpaceConfiguration } from '../../app/vector/vector-store.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const REPOSITORY_ROOT = new URL('../..', import.meta.url).pathname;
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const NOW = '2026-08-22T00:00:00.000Z';
const CHARACTER_PATH = '/internal/semantic/characters';
const MEDIA_ORIGIN = 'http://127.0.0.1:19082';
const MEDIA_PREFIX = '/media';
const CATALOG_DISCOVERY_PATHS = Object.freeze([
  '/internal/semantic/base-models',
  '/internal/semantic/generation-models',
  '/internal/semantic/loras',
  '/internal/semantic/works',
  CHARACTER_PATH,
  '/internal/semantic/styles',
  '/internal/semantic/prompt-terms',
  '/internal/semantic/artist-prompt-strings',
  '/internal/semantic/comfyui-instances',
  '/internal/semantic/comfyui-templates'
]);
const CHARACTER_CONFIG = Object.freeze({
  embedding_model: 'issue-280-character-embedding',
  reranker_candidate_limit: 3,
  reranker_min_relevance_score: 0.5
});

function seed(database) {
  database.exec(`
    INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at)
      VALUES
        (28001, 'Work A', 'work a', '[]', 'Drama', 1, '${NOW}', '${NOW}'),
        (28002, 'Work B', 'work b', '[]', 'Action', 1, '${NOW}', '${NOW}'),
        (28003, 'Hidden Work', 'hidden work', '[]', 'Drama', 0, '${NOW}', '${NOW}');
    INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
      VALUES
        (28101, 28001, 'alpha', 'alpha', '["first alias", "second alias"]', 'brave heroine', 1, '${NOW}', '${NOW}'),
        (28102, 28001, 'Beta', 'beta', '["beta alias"]', 'quiet rival', 1, '${NOW}', '${NOW}'),
        (28103, 28001, 'Alpha2', 'alpha2', '["upper alias"]', 'brave heroine', 1, '${NOW}', '${NOW}'),
        (28104, 28002, 'omega', 'omega', '["omega alias"]', 'calm mentor', 1, '${NOW}', '${NOW}'),
        (28105, 28002, 'Unavailable Character', 'unavailable character', '["hidden alias"]', 'hidden', 0, '${NOW}', '${NOW}'),
        (28106, 28003, 'Unavailable Work Character', 'unavailable work character', '[]', 'hidden', 1, '${NOW}', '${NOW}'),
        (28107, 28001, 'Negative', 'negative', '[]', 'negative', 1, '${NOW}', '${NOW}'),
        (28108, 28001, 'Zero', 'zero', '[]', 'zero', 1, '${NOW}', '${NOW}');
  `);
  writeVectorSpaceConfiguration(database, 'character', {
    embeddingModel: CHARACTER_CONFIG.embedding_model,
    dimension: 1024
  });
  for (const [id, vector] of [
    [28101, createFixtureVector(1, 0)], [28102, createFixtureVector(0.8, 0.6)], [28103, createFixtureVector(0.8, 0.6)], [28104, createFixtureVector(0.7, 0.7)],
    [28105, createFixtureVector(-1, 0)], [28106, createFixtureVector(-1, 0)], [28107, createFixtureVector(-1, 0)], [28108, createFixtureVector(0, 1)]
  ]) {
    upsertVectorEntry(database, 'character', id, vector, { expectedModel: CHARACTER_CONFIG.embedding_model });
  }
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
        ['Work A\nalpha\nfirst alias\nsecond alias\nbrave heroine', 0.5],
        ['Work A\nBeta\nbeta alias\nquiet rival', 0.2],
        ['Work A\nAlpha2\nupper alias\nbrave heroine', 0.5],
        ['Work B\nomega\nomega alias\ncalm mentor', 0.5]
      ]);
      return documents.map((document, index) => ({ index, relevance_score: scoreByDocument.get(document) ?? 0.1 }));
    }
  });
}

function fixture(options = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seed(database);
  const calls = [];
  const configuration = options.configuration ?? CHARACTER_CONFIG;
  const characterSemanticService = createCharacterSemanticService({
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
    characterSemanticService
  });
  return { database, calls, service };
}

function characterPage(items, { page = 1, pageSize = 20, totalCount = items.length } = {}) {
  return {
    status: 'ok',
    message: null,
    results: items,
    page,
    page_size: pageSize,
    total_count: totalCount
  };
}

function characterItem({ id, workId, workName, name, aliases, promptText, coverUrl = null, sampleImageUrls = [] }) {
  return {
    id,
    work_id: workId,
    'works.name': workName,
    name,
    aliases_json: aliases,
    prompt_text: promptText,
    cover_url: coverUrl,
    sample_image_urls: sampleImageUrls
  };
}

test('Issue 280 character Catalog uses the fixed character projection, filters finite KNN candidates, threshold, tie ordering, and stable pagination', async () => {
  const { database, calls, service } = fixture();
  try {
    const page = await service.querySemanticCharactersForSkill({ mode: 'search', query: '  watercolor  ', page: 1, page_size: 1 });
    assert.deepEqual(page, characterPage([
      characterItem({ id: 28103, workId: 28001, workName: 'Work A', name: 'Alpha2', aliases: ['upper alias'], promptText: 'brave heroine' })
    ], { pageSize: 1, totalCount: 2 }));
    assert.deepEqual(calls, [
      { kind: 'embed', inputs: ['watercolor'] },
      {
        kind: 'rerank',
        query: 'watercolor',
        documents: [
          'Work A\nalpha\nfirst alias\nsecond alias\nbrave heroine',
          'Work A\nBeta\nbeta alias\nquiet rival',
          'Work A\nAlpha2\nupper alias\nbrave heroine'
        ]
      }
    ]);
    assert.deepEqual((await service.querySemanticCharactersForSkill({ mode: 'search', query: 'watercolor', page: 2, page_size: 1 })).results.map(({ id }) => id), [28101]);
    assert.deepEqual(await service.querySemanticCharactersForSkill({ mode: 'search', query: 'watercolor', page: 3, page_size: 1 }), characterPage([], { page: 3, pageSize: 1, totalCount: 2 }));

    const filteredFixture = fixture({ configuration: { ...CHARACTER_CONFIG, reranker_candidate_limit: 8 } });
    try {
      const filtered = await filteredFixture.service.querySemanticCharactersForSkill({ mode: 'search', query: 'watercolor', work_id: '28002', page: 1, page_size: 20 });
      assert.deepEqual(filtered.results.map(({ id }) => id), [28104]);
      assert.deepEqual(filteredFixture.calls, [
        { kind: 'embed', inputs: ['watercolor'] },
        { kind: 'rerank', query: 'watercolor', documents: ['Work B\nomega\nomega alias\ncalm mentor'] }
      ]);
    } finally {
      filteredFixture.database.close();
    }
  } finally {
    database.close();
  }
});

test('Issue 280 character Catalog empty and resolve branches use SQLite only, sort by id DESC, and map availability', async () => {
  const { database, calls, service } = fixture({
    embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE'),
    rerankerError: new ApplicationError('RERANKER_UNAVAILABLE')
  });
  try {
    const empty = await service.querySemanticCharactersForSkill({ mode: 'search', query: '   ', page: 1, page_size: 3 });
    assert.deepEqual(empty.results.map(({ id }) => id), [28108, 28107, 28104]);
    assert.equal(empty.total_count, 6);
    assert.deepEqual(await service.querySemanticCharactersForSkill({ mode: 'search', query: '', work_id: '28002', page: 1, page_size: 20 }), characterPage([
      characterItem({ id: 28104, workId: 28002, workName: 'Work B', name: 'omega', aliases: ['omega alias'], promptText: 'calm mentor' })
    ], { totalCount: 1 }));
    assert.deepEqual(await service.querySemanticCharactersForSkill({ mode: 'resolve', id: '28101' }), characterPage([
      characterItem({ id: 28101, workId: 28001, workName: 'Work A', name: 'alpha', aliases: ['first alias', 'second alias'], promptText: 'brave heroine' })
    ], { pageSize: 1, totalCount: 1 }));
    assert.equal(calls.length, 0);
    await assert.rejects(() => service.querySemanticCharactersForSkill({ mode: 'resolve', id: '28105' }), (error) => error?.code === 'CATALOG_RESOURCE_UNAVAILABLE');
    await assert.rejects(() => service.querySemanticCharactersForSkill({ mode: 'resolve', id: '28106' }), (error) => error?.code === 'CATALOG_RESOURCE_UNAVAILABLE');
    await assert.rejects(() => service.querySemanticCharactersForSkill({ mode: 'resolve', id: '28999' }), (error) => error?.code === 'CATALOG_REF_NOT_FOUND');
    assert.equal(calls.length, 0);
  } finally {
    database.close();
  }
});

test('Issue 280 character Catalog projects direct non-cover images identically for search and resolve', async () => {
  const { database, service } = fixture();
  try {
    database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (281011, 'character', 28101, 'hash-281011', 'characters/alpha-sample.webp', 1, ?, ?)`).run(NOW, NOW);
    const expectedUrl = `${MEDIA_ORIGIN}${MEDIA_PREFIX}/characters/alpha-sample.webp`;

    const searchItem = (await service.querySemanticCharactersForSkill({ mode: 'search', query: '', page: 1, page_size: 20 }))
      .results.find(({ id }) => id === 28101);
    const resolveItem = (await service.querySemanticCharactersForSkill({ mode: 'resolve', id: '28101' })).results[0];

    assert.deepEqual(searchItem.sample_image_urls, [expectedUrl]);
    assert.deepEqual(resolveItem.sample_image_urls, [expectedUrl]);
  } finally {
    database.close();
  }
});

test('Issue 280 character Catalog validates work_id existence and keeps existing empty filters successful', async () => {
  const { database, service } = fixture();
  try {
    await assert.rejects(
      () => service.querySemanticCharactersForSkill({ mode: 'search', query: 'watercolor', work_id: '28999' }),
      (error) => error?.code === 'CATALOG_REQUEST_INVALID'
    );
    assert.deepEqual(await service.querySemanticCharactersForSkill({ mode: 'search', query: 'watercolor', work_id: '28003' }), characterPage([], { totalCount: 0 }));
  } finally {
    database.close();
  }
});

test('Issue 280 character Catalog maps semantic dependency, index, and timeout errors only for non-empty query', async () => {
  const unavailable = fixture({ embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE') });
  try {
    await assert.rejects(() => unavailable.service.querySemanticCharactersForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_UNAVAILABLE');
  } finally {
    unavailable.database.close();
  }

  const timeout = fixture({ rerankerError: new ApplicationError('RERANKER_TIMEOUT') });
  try {
    await assert.rejects(() => timeout.service.querySemanticCharactersForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_TIMEOUT');
  } finally {
    timeout.database.close();
  }

  const notReady = fixture();
  try {
    notReady.database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__' WHERE object_kind = 'character'").run();
    await assert.rejects(() => notReady.service.querySemanticCharactersForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_INDEX_NOT_READY');
    await notReady.service.querySemanticCharactersForSkill({ mode: 'search', query: '' });
    await notReady.service.querySemanticCharactersForSkill({ mode: 'resolve', id: '28101' });
    assert.equal(notReady.calls.length, 0);
  } finally {
    notReady.database.close();
  }
});

test('Issue 280 character Catalog discovery, HTTP validation, and service error projection expose the closed work_id operation', async () => {
  const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(Object.keys(discovery.paths), CATALOG_DISCOVERY_PATHS);
  assert.ok(discovery.paths[CHARACTER_PATH]);
  const operation = discovery.paths[CHARACTER_PATH].post;
  assert.equal(operation.operationId, 'querySemanticCharactersForSkill');
  assert.equal(operation['x-harness-tool-name'], 'query_semantic_characters');
  assert.equal(operation.description, 'Semantically search or resolve available character records, optionally restricted to one work.');
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogCharacterSearchRequest.properties), ['mode', 'query', 'page', 'page_size', 'work_id']);
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogCharacterResolveRequest.properties), ['mode', 'id']);
  assert.equal(discovery.components.schemas.CatalogSourceResultRecord.additionalProperties, true);

  const calls = [];
  const service = {
    querySemanticCharactersForSkill(request) {
      calls.push(request);
      if (request.mode === 'search' && request.query === 'down') throw new ApplicationError('CATALOG_DEPENDENCY_UNAVAILABLE');
      return characterPage([]);
    }
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: discovery
  });
  const success = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: CHARACTER_PATH, body: { mode: 'search', work_id: '28001' } });
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, characterPage([]));
  const invalid = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: CHARACTER_PATH, body: { mode: 'resolve', id: '1', work_id: '28001' } });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  const dependency = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: CHARACTER_PATH, body: { mode: 'search', query: 'down' } });
  assert.equal(dependency.status, 502);
  assert.deepEqual(dependency.body, { status: 'error', message: 'Catalog dependency is unavailable.', results: [], page: 1, page_size: 0, total_count: 0 });
  assert.deepEqual(calls, [
    { mode: 'search', query: '', page: 1, page_size: 20, work_id: '28001' },
    { mode: 'search', query: 'down', page: 1, page_size: 20 }
  ]);
});
