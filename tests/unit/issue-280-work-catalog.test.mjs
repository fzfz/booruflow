import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';
import { createWorkSemanticService } from '../../app/vector/work-semantic.mjs';
import { upsertVectorEntry, writeVectorSpaceConfiguration } from '../../app/vector/vector-store.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const REPOSITORY_ROOT = new URL('../..', import.meta.url).pathname;
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const NOW = '2026-08-22T00:00:00.000Z';
const WORK_PATH = '/internal/semantic/works';
const MEDIA_ORIGIN = 'http://127.0.0.1:19082';
const MEDIA_PREFIX = '/media';
const CATALOG_DISCOVERY_PATHS = Object.freeze([
  '/internal/semantic/base-models',
  '/internal/semantic/generation-models',
  '/internal/semantic/loras',
  WORK_PATH,
  '/internal/semantic/characters',
  '/internal/semantic/styles',
  '/internal/semantic/prompt-terms',
  '/internal/semantic/artist-prompt-strings',
  '/internal/semantic/comfyui-instances',
  '/internal/semantic/comfyui-templates'
]);
const WORK_CONFIG = Object.freeze({
  embedding_model: 'issue-280-work-embedding',
  reranker_candidate_limit: 3,
  reranker_min_relevance_score: 0.5
});

function seed(database) {
  database.exec(`
    INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at)
      VALUES
        (2801, 'alpha', 'alpha', '["first alias", "second alias"]', 'Drama', 1, '${NOW}', '${NOW}'),
        (2802, 'Beta', 'beta', '["beta alias"]', 'Action', 1, '${NOW}', '${NOW}'),
        (2803, 'Alpha2', 'alpha2', '["upper alias"]', 'Drama', 1, '${NOW}', '${NOW}'),
        (2804, 'omega', 'omega', '["omega alias"]', NULL, 1, '${NOW}', '${NOW}'),
        (2805, 'Unavailable', 'unavailable', '["hidden alias"]', 'Drama', 0, '${NOW}', '${NOW}'),
        (2806, 'Negative', 'negative', '["negative alias"]', 'Drama', 1, '${NOW}', '${NOW}'),
        (2807, 'Zero', 'zero', '["zero alias"]', 'Drama', 1, '${NOW}', '${NOW}');
  `);
  writeVectorSpaceConfiguration(database, 'work', {
    embeddingModel: WORK_CONFIG.embedding_model,
    dimension: 1024
  });
  for (const [id, vector] of [
    [2801, createFixtureVector(1, 0)], [2802, createFixtureVector(0.8, 0.6)], [2803, createFixtureVector(0.8, 0.6)], [2804, createFixtureVector(0.7, 0.7)],
    [2805, createFixtureVector(-1, 0)], [2806, createFixtureVector(-1, 0)], [2807, createFixtureVector(0, 1)]
  ]) {
    upsertVectorEntry(database, 'work', id, vector, { expectedModel: WORK_CONFIG.embedding_model });
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
        ['alpha\nfirst alias\nsecond alias\nDrama', 0.5],
        ['Beta\nbeta alias\nAction', 0.2],
        ['Alpha2\nupper alias\nDrama', 0.5]
      ]);
      return documents.map((document, index) => ({ index, relevance_score: scoreByDocument.get(document) ?? 0.1 }));
    }
  });
}

function fixture(options = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seed(database);
  const calls = [];
  const workSemanticService = createWorkSemanticService({
    database,
    modelClient: modelClient(calls, options),
    configuration: WORK_CONFIG
  });
  const repository = createCatalogRepository(database);
  const service = createCatalogService({
    database,
    repository,
    repositoryRoot: REPOSITORY_ROOT,
    workSemanticService,
    mediaOrigin: MEDIA_ORIGIN,
    mediaPublicPrefix: MEDIA_PREFIX
  });
  return { database, calls, service };
}

function workPage(items, { page = 1, pageSize = 20, totalCount = items.length } = {}) {
  return {
    status: 'ok',
    message: null,
    results: items,
    page,
    page_size: pageSize,
    total_count: totalCount
  };
}

function workItem({ id, name, aliases, categoryName, characterNames = [], coverUrl = null, sampleImageUrls = [] }) {
  return {
    id,
    name,
    aliases_json: aliases,
    category_name: categoryName,
    character_names: characterNames,
    cover_url: coverUrl,
    sample_image_urls: sampleImageUrls
  };
}

test('Issue 280 work Catalog uses the fixed work projection, finite candidate set, threshold, and stable paged ranking', async () => {
  const { database, calls, service } = fixture();
  try {
    const page = await service.querySemanticWorksForSkill({ mode: 'search', query: '  watercolor  ', page: 1, page_size: 1 });
    assert.deepEqual(page, workPage([
      workItem({ id: 2803, name: 'Alpha2', aliases: ['upper alias'], categoryName: 'Drama' })
    ], { pageSize: 1, totalCount: 2 }));
    assert.deepEqual(calls, [
      { kind: 'embed', inputs: ['watercolor'] },
      {
        kind: 'rerank',
        query: 'watercolor',
        documents: [
          'alpha\nfirst alias\nsecond alias\nDrama',
          'Beta\nbeta alias\nAction',
          'Alpha2\nupper alias\nDrama'
        ]
      }
    ]);
    assert.deepEqual((await service.querySemanticWorksForSkill({ mode: 'search', query: 'watercolor', page: 2, page_size: 1 })).results.map(({ id }) => id), [2801]);
    assert.equal((await service.querySemanticWorksForSkill({ mode: 'search', query: 'watercolor', page: 3, page_size: 1 })).total_count, 2);
    assert.deepEqual((await service.querySemanticWorksForSkill({ mode: 'search', query: 'watercolor', page: 3, page_size: 1 })).results, []);
  } finally {
    database.close();
  }
});

test('Issue 280 work Catalog empty and resolve branches use SQLite only, preserve availability, and map unavailable records', async () => {
  const { database, calls, service } = fixture({
    embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE'),
    rerankerError: new ApplicationError('RERANKER_UNAVAILABLE')
  });
  try {
    const empty = await service.querySemanticWorksForSkill({ mode: 'search', query: '   ', page: 1, page_size: 2 });
    assert.deepEqual(empty.results.map(({ id }) => id), [2807, 2806]);
    assert.equal(empty.total_count, 6);
    assert.deepEqual(await service.querySemanticWorksForSkill({ mode: 'search', query: '', page: 4, page_size: 2 }), workPage([], { page: 4, pageSize: 2, totalCount: 6 }));
    assert.deepEqual(await service.querySemanticWorksForSkill({ mode: 'resolve', id: '2801' }), workPage([
      workItem({ id: 2801, name: 'alpha', aliases: ['first alias', 'second alias'], categoryName: 'Drama' })
    ], { pageSize: 1, totalCount: 1 }));
    assert.equal(calls.length, 0);
    await assert.rejects(() => service.querySemanticWorksForSkill({ mode: 'resolve', id: '2805' }), (error) => error?.code === 'CATALOG_RESOURCE_UNAVAILABLE');
    await assert.rejects(() => service.querySemanticWorksForSkill({ mode: 'resolve', id: '2899' }), (error) => error?.code === 'CATALOG_REF_NOT_FOUND');
    assert.equal(calls.length, 0);
  } finally {
    database.close();
  }
});

test('Source Catalog work keeps a character-owned cover and returns only direct work images', async () => {
  const { database, service } = fixture();
  try {
    database.prepare(`INSERT INTO characters(
      id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at
    ) VALUES (28901, 2801, 'Cover Character', 'cover character', '[]', 'cover prompt', 1, ?, ?)`).run(NOW, NOW);
    const insertImage = database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insertImage.run(289011, 'character', 28901, 'hash-289011', 'characters/work-cover.webp', 0, NOW, NOW);
    insertImage.run(289012, 'character', 28901, 'hash-289012', 'characters/not-a-work-sample.webp', 1, NOW, NOW);
    insertImage.run(289013, 'work', 2801, 'hash-289013', 'works/direct-example-2.webp', 0, NOW, NOW);
    insertImage.run(289014, 'work', 2801, 'hash-289014', 'works/direct-example-3.webp', 1, NOW, NOW);
    database.prepare('UPDATE characters SET cover_media_path = ? WHERE id = 28901').run('characters/work-cover.webp');
    database.prepare('UPDATE works SET cover_media_path = ? WHERE id = 2801').run('characters/work-cover.webp');

    const resolved = await service.querySemanticWorksForSkill({ mode: 'resolve', id: '2801' });
    assert.deepEqual(resolved, workPage([
      workItem({
        id: 2801,
        name: 'alpha',
        aliases: ['first alias', 'second alias'],
        categoryName: 'Drama',
        characterNames: ['Cover Character'],
        coverUrl: `${MEDIA_ORIGIN}${MEDIA_PREFIX}/characters/work-cover.webp`,
        sampleImageUrls: [
          `${MEDIA_ORIGIN}${MEDIA_PREFIX}/works/direct-example-2.webp`,
          `${MEDIA_ORIGIN}${MEDIA_PREFIX}/works/direct-example-3.webp`
        ]
      })
    ], { pageSize: 1, totalCount: 1 }));
    const searchItem = (await service.querySemanticWorksForSkill({ mode: 'search', query: '', page: 1, page_size: 20 })).results.find(({ id }) => id === 2801);
    assert.equal(searchItem.cover_url, resolved.results[0].cover_url);
    assert.deepEqual(searchItem.sample_image_urls, resolved.results[0].sample_image_urls);
    assert.equal(JSON.stringify(searchItem).includes('not-a-work-sample'), false);
  } finally {
    database.close();
  }
});

test('Issue 280 work Catalog maps semantic dependency, index, and timeout errors only for non-empty query', async () => {
  const unavailable = fixture({ embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE') });
  try {
    await assert.rejects(() => unavailable.service.querySemanticWorksForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_UNAVAILABLE');
  } finally {
    unavailable.database.close();
  }

  const timeout = fixture({ rerankerError: new ApplicationError('RERANKER_TIMEOUT') });
  try {
    await assert.rejects(() => timeout.service.querySemanticWorksForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_TIMEOUT');
  } finally {
    timeout.database.close();
  }

  const notReady = fixture();
  try {
    notReady.database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__' WHERE object_kind = 'work'").run();
    await assert.rejects(() => notReady.service.querySemanticWorksForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_INDEX_NOT_READY');
    assert.deepEqual(await notReady.service.querySemanticWorksForSkill({ mode: 'search', query: '' }), workPage([
      workItem({ id: 2807, name: 'Zero', aliases: ['zero alias'], categoryName: 'Drama' }),
      workItem({ id: 2806, name: 'Negative', aliases: ['negative alias'], categoryName: 'Drama' }),
      workItem({ id: 2804, name: 'omega', aliases: ['omega alias'], categoryName: null }),
      workItem({ id: 2803, name: 'Alpha2', aliases: ['upper alias'], categoryName: 'Drama' }),
      workItem({ id: 2802, name: 'Beta', aliases: ['beta alias'], categoryName: 'Action' }),
      workItem({ id: 2801, name: 'alpha', aliases: ['first alias', 'second alias'], categoryName: 'Drama' })
    ], { totalCount: 6 }));
    assert.equal(notReady.calls.length, 0);
  } finally {
    notReady.database.close();
  }
});

test('Issue 280 work Catalog preserves a database error while reading vector-space configuration for the HTTP error mapper', async () => {
  const { database, calls } = fixture();
  const databaseBusy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  const databaseWithBusyVectorSpaceRead = Object.freeze({
    prepare(sql) {
      if (sql.includes('FROM vector_spaces')) throw databaseBusy;
      return database.prepare(sql);
    }
  });
  const workSemanticService = createWorkSemanticService({
    database: databaseWithBusyVectorSpaceRead,
    modelClient: modelClient(calls),
    configuration: WORK_CONFIG
  });
  try {
    await assert.rejects(
      () => workSemanticService.searchCatalog({ query: 'watercolor', page: 1, page_size: 20 }),
      (error) => error === databaseBusy
    );
  } finally {
    database.close();
  }
});

test('Issue 280 work Catalog discovery, HTTP validation, and service error projection expose only the new closed operation', async () => {
  const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(Object.keys(discovery.paths), CATALOG_DISCOVERY_PATHS);
  assert.ok(discovery.paths[WORK_PATH]);
  const operation = discovery.paths[WORK_PATH].post;
  assert.equal(operation.operationId, 'querySemanticWorksForSkill');
  assert.equal(operation['x-harness-tool-name'], 'query_semantic_works');
  assert.equal(operation.description, 'Semantically search or resolve available work records with aliases, category, and known character names.');
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogWorkSearchRequest.properties), ['mode', 'query', 'page', 'page_size']);
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogWorkResolveRequest.properties), ['mode', 'id']);
  assert.equal(discovery.components.schemas.CatalogSourceResultRecord.additionalProperties, true);

  const calls = [];
  const service = {
    querySemanticWorksForSkill(request) {
      calls.push(request);
      if (request.mode === 'search' && request.query === 'down') throw new ApplicationError('CATALOG_DEPENDENCY_UNAVAILABLE');
      return workPage([]);
    }
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: discovery
  });
  const success = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: WORK_PATH, body: { mode: 'search' } });
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, workPage([]));
  const invalid = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: WORK_PATH, body: { mode: 'resolve', id: '1', query: '' } });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  const dependency = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: WORK_PATH, body: { mode: 'search', query: 'down' } });
  assert.equal(dependency.status, 502);
  assert.deepEqual(dependency.body, { status: 'error', message: 'Catalog dependency is unavailable.', results: [], page: 1, page_size: 0, total_count: 0 });
  assert.deepEqual(calls, [
    { mode: 'search', query: '', page: 1, page_size: 20 },
    { mode: 'search', query: 'down', page: 1, page_size: 20 }
  ]);
});
