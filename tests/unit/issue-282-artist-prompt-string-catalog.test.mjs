import assert from 'node:assert/strict';
import test from 'node:test';

import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';
import { createArtistPromptStringSemanticService } from '../../app/vector/artist-prompt-string-semantic.mjs';
import { upsertVectorEntry, writeVectorSpaceConfiguration } from '../../app/vector/vector-store.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const REPOSITORY_ROOT = new URL('../..', import.meta.url).pathname;
const NOW = '2026-08-22T00:00:00.000Z';
const ARTIST_PATH = '/internal/semantic/artist-prompt-strings';
const MEDIA_ORIGIN = 'http://127.0.0.1:19082';
const MEDIA_PREFIX = '/media';
const CATALOG_DISCOVERY_PATHS = Object.freeze([
  '/internal/semantic/base-models',
  '/internal/semantic/generation-models',
  '/internal/semantic/loras',
  '/internal/semantic/works',
  '/internal/semantic/characters',
  '/internal/semantic/styles',
  '/internal/semantic/prompt-terms',
  ARTIST_PATH,
  '/internal/semantic/comfyui-instances',
  '/internal/semantic/comfyui-templates'
]);
const ARTIST_CONFIG = Object.freeze({
  embedding_model: 'issue-282-artist-embedding',
  reranker_candidate_limit: 3,
  reranker_min_relevance_score: 0.5
});

function seed(database) {
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES
        (28201, 'WAI', '${NOW}', '${NOW}'),
        (28202, 'Anima', '${NOW}', '${NOW}');
    INSERT INTO artist_prompt_strings(
      id, title, description, artist_string, base_model_id, created_at, updated_at
    ) VALUES
      (28201, 'global search', 'global description', 'global_artist', NULL, '${NOW}', '${NOW}'),
      (28202, 'search', 'exact title description', 'exact_artist', 28201, '${NOW}', '${NOW}'),
      (28203, 'Zeta Artist', 'zeta description', 'zeta_artist', 28201, '${NOW}', '${NOW}'),
      (28204, 'Alpha Artist', 'alpha description', 'alpha_artist', 28201, '${NOW}', '${NOW}'),
      (28205, 'Threshold Artist', 'threshold description', 'threshold_artist', 28201, '${NOW}', '${NOW}'),
      (28206, 'Anima Artist', 'anima description', 'anima_artist', 28202, '${NOW}', '${NOW}');
  `);
  writeVectorSpaceConfiguration(database, 'artist_prompt_string', {
    embeddingModel: ARTIST_CONFIG.embedding_model,
    dimension: 1024
  });
  for (const [id, vector] of [
    [28201, createFixtureVector(-1, 0)],
    [28202, createFixtureVector(0.1, Math.sqrt(0.99))],
    [28203, createFixtureVector(0.9, Math.sqrt(0.19))],
    [28204, createFixtureVector(0.9, Math.sqrt(0.19))],
    [28205, createFixtureVector(0.8, 0.6)],
    [28206, createFixtureVector(0.1, Math.sqrt(0.99))]
  ]) upsertVectorEntry(database, 'artist_prompt_string', id, vector, { expectedModel: ARTIST_CONFIG.embedding_model });
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
        ['Zeta Artist\nzeta description\nzeta_artist', 0.8],
        ['Alpha Artist\nalpha description\nalpha_artist', 0.8],
        ['Threshold Artist\nthreshold description\nthreshold_artist', 0.49],
        ['Anima Artist\nanima description\nanima_artist', 0.9]
      ]);
      return documents.map((document, index) => ({ index, relevance_score: scoreByDocument.get(document) ?? 0.1 }));
    }
  });
}

function fixture(options = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seed(database);
  const calls = [];
  const artistPromptStringSemanticService = createArtistPromptStringSemanticService({
    database,
    modelClient: modelClient(calls, options),
    configuration: options.configuration ?? ARTIST_CONFIG
  });
  const repository = createCatalogRepository(database);
  const service = createCatalogService({
    database,
    repository,
    repositoryRoot: REPOSITORY_ROOT,
    artistPromptStringSemanticService,
    mediaOrigin: MEDIA_ORIGIN,
    mediaPublicPrefix: MEDIA_PREFIX
  });
  return { database, calls, service };
}

function artistPage(items, { page = 1, pageSize = 20, totalCount = items.length } = {}) {
  return {
    status: 'ok', message: null, results: items,
    page,
    page_size: pageSize,
    total_count: totalCount
  };
}

function artistItem({ id, title, description, artistString, baseModelId, styleIds = [], coverUrl = null, sampleImageUrls = [] }) {
  return {
    id,
    title,
    description,
    artist_string: artistString,
    base_model_id: baseModelId,
    style_ids: styleIds,
    cover_url: coverUrl,
    sample_image_urls: sampleImageUrls
  };
}

test('Issue 282 artist-string Catalog filters finite KNN candidates, has no exact-title priority, and applies threshold/tie/pagination rules', async () => {
  const { database, calls, service } = fixture();
  try {
    const page = await service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: '  search  ', page: 1, page_size: 1, base_model_id: '28201' });
    assert.deepEqual(page, artistPage([
      artistItem({ id: 28204, title: 'Alpha Artist', description: 'alpha description', artistString: 'alpha_artist', baseModelId: 28201 })
    ], { pageSize: 1, totalCount: 2 }));
    assert.deepEqual(calls, [
      { kind: 'embed', inputs: ['search'] },
      {
        kind: 'rerank',
        query: 'search',
        documents: [
          'Zeta Artist\nzeta description\nzeta_artist',
          'Alpha Artist\nalpha description\nalpha_artist',
          'Threshold Artist\nthreshold description\nthreshold_artist'
        ]
      }
    ]);
    assert.deepEqual((await service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: 'search', page: 2, page_size: 1, base_model_id: '28201' })).results.map(({ id }) => id), [28203]);
    assert.deepEqual(await service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: 'search', page: 3, page_size: 1, base_model_id: '28201' }), artistPage([], { page: 3, pageSize: 1, totalCount: 2 }));
  } finally {
    database.close();
  }
});

test('Issue 282 artist-string Catalog empty and resolve branches use SQLite only, sort by id DESC, exclude global strings from a strict base filter, and preserve safe fields', async () => {
  const { database, calls, service } = fixture({
    embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE'),
    rerankerError: new ApplicationError('RERANKER_UNAVAILABLE')
  });
  try {
    const empty = await service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: '   ', page: 1, page_size: 3 });
    assert.deepEqual(empty.results.map(({ id }) => id), [28206, 28205, 28204]);
    assert.equal(empty.total_count, 6);
    assert.deepEqual(await service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: '', page: 2, page_size: 3, base_model_id: '28201' }), artistPage([
      artistItem({ id: 28202, title: 'search', description: 'exact title description', artistString: 'exact_artist', baseModelId: 28201 }),
    ], { page: 2, pageSize: 3, totalCount: 4 }));
    assert.deepEqual(await service.querySemanticArtistPromptStringsForSkill({ mode: 'resolve', id: '28201' }), artistPage([
      artistItem({ id: 28201, title: 'global search', description: 'global description', artistString: 'global_artist', baseModelId: null })
    ], { pageSize: 1, totalCount: 1 }));
    assert.equal(calls.length, 0);
    const serialized = JSON.stringify(empty);
    assert.equal(serialized.includes('vector_score'), false);
    assert.equal(serialized.includes('reranker_score'), false);
    assert.equal(serialized.includes('media_path'), false);
    await assert.rejects(() => service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: 'search', base_model_id: '28999' }), (error) => error?.code === 'CATALOG_REQUEST_INVALID');
    assert.equal(calls.length, 0);
  } finally {
    database.close();
  }
});

test('Source Catalog artist-string semantic search and resolve reuse the same cover and sample image projection', async () => {
  const { database, service } = fixture();
  try {
    const insertImage = database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (?, 'artist_prompt_string', 28203, ?, ?, ?, ?, ?)`);
    insertImage.run(282301, 'hash-282301', 'artists/zeta-cover.webp', 0, NOW, NOW);
    insertImage.run(282302, 'hash-282302', 'artists/zeta-example.webp', 1, NOW, NOW);
    database.prepare('UPDATE artist_prompt_strings SET cover_media_path = ? WHERE id = 28203').run('artists/zeta-cover.webp');

    const search = await service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: 'search', page: 1, page_size: 20, base_model_id: '28201' });
    const searchItem = search.results.find(({ id }) => id === 28203);
    const resolved = (await service.querySemanticArtistPromptStringsForSkill({ mode: 'resolve', id: '28203' })).results[0];
    assert.deepEqual(searchItem, resolved);
    assert.equal(resolved.cover_url, `${MEDIA_ORIGIN}${MEDIA_PREFIX}/artists/zeta-cover.webp`);
    assert.deepEqual(resolved.sample_image_urls, [`${MEDIA_ORIGIN}${MEDIA_PREFIX}/artists/zeta-example.webp`]);
  } finally {
    database.close();
  }
});

test('Issue 282 artist-string Catalog maps index, dependency, and timeout errors only for non-empty semantic query', async () => {
  const unavailable = fixture({ embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE') });
  try {
    await assert.rejects(() => unavailable.service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_UNAVAILABLE');
  } finally {
    unavailable.database.close();
  }

  const timeout = fixture({ rerankerError: new ApplicationError('RERANKER_TIMEOUT') });
  try {
    await assert.rejects(() => timeout.service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_TIMEOUT');
  } finally {
    timeout.database.close();
  }

  const notReady = fixture();
  try {
    notReady.database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__' WHERE object_kind = 'artist_prompt_string'").run();
    await assert.rejects(() => notReady.service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_INDEX_NOT_READY');
    await notReady.service.querySemanticArtistPromptStringsForSkill({ mode: 'search', query: '' });
    await notReady.service.querySemanticArtistPromptStringsForSkill({ mode: 'resolve', id: '28201' });
    assert.equal(notReady.calls.length, 0);
  } finally {
    notReady.database.close();
  }
});

test('Issue 282 artist-string Catalog discovery, HTTP validation, and error projection expose the closed base_model_id operation', async () => {
  const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(Object.keys(discovery.paths), CATALOG_DISCOVERY_PATHS);
  assert.ok(discovery.paths[ARTIST_PATH]);
  const operation = discovery.paths[ARTIST_PATH].post;
  assert.equal(operation.operationId, 'querySemanticArtistPromptStringsForSkill');
  assert.equal(operation['x-harness-tool-name'], 'query_semantic_artist_prompt_strings');
  assert.equal(operation.description, 'Semantically search or resolve curated artist prompt strings, optionally restricted to one base model.');
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogArtistPromptStringSearchRequest.properties), ['mode', 'query', 'page', 'page_size', 'base_model_id']);
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogArtistPromptStringResolveRequest.properties), ['mode', 'id']);
  assert.equal(discovery.components.schemas.CatalogSourceResultRecord.additionalProperties, true);

  const calls = [];
  const service = {
    querySemanticArtistPromptStringsForSkill(request) {
      calls.push(request);
      if (request.mode === 'search' && request.query === 'down') throw new ApplicationError('CATALOG_DEPENDENCY_UNAVAILABLE');
      return artistPage([]);
    }
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: discovery
  });
  const success = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: ARTIST_PATH, body: { mode: 'search', base_model_id: '28201' } });
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, artistPage([]));
  const invalid = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: ARTIST_PATH, body: { mode: 'resolve', id: '1', base_model_id: '28201' } });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  const dependency = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: ARTIST_PATH, body: { mode: 'search', query: 'down' } });
  assert.equal(dependency.status, 502);
  assert.deepEqual(dependency.body, { status: 'error', message: 'Catalog dependency is unavailable.', results: [], page: 1, page_size: 0, total_count: 0 });
  assert.deepEqual(calls, [
    { mode: 'search', query: '', page: 1, page_size: 20, base_model_id: '28201' },
    { mode: 'search', query: 'down', page: 1, page_size: 20 }
  ]);
});
