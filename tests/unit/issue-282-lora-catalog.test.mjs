import assert from 'node:assert/strict';
import test from 'node:test';

import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';
import { createGenerationLoraSemanticService } from '../../app/vector/generation-lora-semantic.mjs';
import { upsertVectorEntry, writeVectorSpaceConfiguration } from '../../app/vector/vector-store.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const REPOSITORY_ROOT = new URL('../..', import.meta.url).pathname;
const NOW = '2026-08-22T00:00:00.000Z';
const LORA_PATH = '/internal/semantic/loras';
const MEDIA_ORIGIN = 'http://127.0.0.1:19082';
const MEDIA_PREFIX = '/media';
const CATALOG_DISCOVERY_PATHS = Object.freeze([
  '/internal/semantic/base-models',
  '/internal/semantic/generation-models',
  LORA_PATH,
  '/internal/semantic/works',
  '/internal/semantic/characters',
  '/internal/semantic/styles',
  '/internal/semantic/prompt-terms',
  '/internal/semantic/artist-prompt-strings',
  '/internal/semantic/comfyui-instances',
  '/internal/semantic/comfyui-templates'
]);
const LORA_CONFIG = Object.freeze({
  embedding_model: 'issue-282-lora-embedding',
  reranker_candidate_limit: 3,
  reranker_min_relevance_score: 0.5
});

function seed(database) {
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES
        (28201, 'WAI', '${NOW}', '${NOW}'),
        (28202, 'Anima', '${NOW}', '${NOW}');
    INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      author, version, description, usage, created_at, updated_at
    ) VALUES
      (28211, 28201, 'wai-base.safetensors', 'safetensors', 'fp16', 'Base Author', 'v1', 'WAI base', 'WAI usage', '${NOW}', '${NOW}'),
      (28212, 28202, 'anima-base.safetensors', 'safetensors', 'bf16', NULL, 'v2', 'Anima base', 'Anima usage', '${NOW}', '${NOW}');
    INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      author, version, description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES
      (28201, 28201, 28211, 'Beta Lora.safetensors', 'safetensors', 'fp16', 'Beta Author', 'v9', 'Beta description', 'Beta usage', '["beta first", "beta second"]', 0.8, '${NOW}', '${NOW}'),
      (28202, 28201, 28211, 'Alpha Lora.safetensors', 'safetensors', 'fp16', 'Alpha Author', 'v8', 'Alpha description', 'Alpha usage', '["alpha first", "alpha second"]', 0.7, '${NOW}', '${NOW}'),
      (28203, 28201, 28211, 'Threshold Lora.safetensors', 'safetensors', 'fp16', NULL, 'v7', 'Threshold description', 'Threshold usage', '["threshold"]', 1.0, '${NOW}', '${NOW}'),
      (28204, 28201, 28211, 'Later Lora.safetensors', 'safetensors', 'fp16', NULL, NULL, 'Later description', 'Later usage', '["later"]', 1.1, '${NOW}', '${NOW}'),
      (28205, 28202, 28212, 'Anima Lora.safetensors', 'safetensors', 'bf16', 'Anima Author', 'v3', 'Anima description', 'Anima usage', '["anima"]', 0.9, '${NOW}', '${NOW}');
  `);
  writeVectorSpaceConfiguration(database, 'generation_lora', {
    embeddingModel: LORA_CONFIG.embedding_model,
    dimension: 1024
  });
  for (const [id, vector] of [
    [28201, createFixtureVector(0.9, Math.sqrt(0.19))],
    [28202, createFixtureVector(0.9, Math.sqrt(0.19))],
    [28203, createFixtureVector(0.8, 0.6)],
    [28204, createFixtureVector(0.7, Math.sqrt(0.51))],
    [28205, createFixtureVector(0.1, Math.sqrt(0.99))]
  ]) upsertVectorEntry(database, 'generation_lora', id, vector, { expectedModel: LORA_CONFIG.embedding_model });
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
        ['Beta Lora.safetensors\nbeta first\nbeta second\nBeta description\nBeta usage', 0.8],
        ['Alpha Lora.safetensors\nalpha first\nalpha second\nAlpha description\nAlpha usage', 0.8],
        ['Threshold Lora.safetensors\nthreshold\nThreshold description\nThreshold usage', 0.49],
        ['Anima Lora.safetensors\nanima\nAnima description\nAnima usage', 0.9]
      ]);
      return documents.map((document, index) => ({ index, relevance_score: scoreByDocument.get(document) ?? 0.1 }));
    }
  });
}

function fixture(options = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seed(database);
  const calls = [];
  const configuration = options.configuration ?? LORA_CONFIG;
  const loraSemanticService = createGenerationLoraSemanticService({
    database,
    modelClient: modelClient(calls, options),
    configuration
  });
  const repository = createCatalogRepository(database);
  const service = createCatalogService({
    database,
    repository,
    repositoryRoot: REPOSITORY_ROOT,
    generationLoraSemanticService: loraSemanticService,
    mediaOrigin: MEDIA_ORIGIN,
    mediaPublicPrefix: MEDIA_PREFIX
  });
  return { database, calls, service };
}

function loraPage(items, { page = 1, pageSize = 20, totalCount = items.length } = {}) {
  return {
    status: 'ok', message: null, results: items,
    page,
    page_size: pageSize,
    total_count: totalCount
  };
}

function loraItem({ id, baseModelId, modelId, fileName, fileFormat, precision, author, version, description, usage, triggerWords, weight, coverUrl = null, sampleImageUrls = [] }) {
  return {
    id,
    base_model_id: baseModelId,
    model_id: modelId,
    file_name: fileName,
    file_format: fileFormat,
    precision_or_quantization: precision,
    author,
    version,
    description,
    usage,
    trigger_words_json: triggerWords,
    weight,
    cover_url: coverUrl,
    sample_image_urls: sampleImageUrls
  };
}

test('Issue 282 LoRA Catalog uses the fixed projection, filters finite KNN candidates, preserves trigger order, and applies threshold/tie/pagination rules', async () => {
  const { database, calls, service } = fixture();
  try {
    const page = await service.querySemanticLorasForSkill({ mode: 'search', query: '  beta  ', page: 1, page_size: 1, base_model_id: '28201' });
    assert.deepEqual(page, loraPage([
      loraItem({
        id: 28202,
        baseModelId: 28201,
        modelId: 28211,
        fileName: 'Alpha Lora.safetensors',
        fileFormat: 'safetensors',
        precision: 'fp16',
        author: 'Alpha Author',
        version: 'v8',
        description: 'Alpha description',
        usage: 'Alpha usage',
        triggerWords: ['alpha first', 'alpha second'],
        weight: 0.7
      })
    ], { pageSize: 1, totalCount: 2 }));
    assert.deepEqual(calls, [
      { kind: 'embed', inputs: ['beta'] },
      {
        kind: 'rerank',
        query: 'beta',
        documents: [
          'Beta Lora.safetensors\nbeta first\nbeta second\nBeta description\nBeta usage',
          'Alpha Lora.safetensors\nalpha first\nalpha second\nAlpha description\nAlpha usage',
          'Threshold Lora.safetensors\nthreshold\nThreshold description\nThreshold usage'
        ]
      }
    ]);
    assert.deepEqual((await service.querySemanticLorasForSkill({ mode: 'search', query: 'beta', page: 2, page_size: 1, base_model_id: '28201' })).results.map(({ id }) => id), [28201]);
    assert.deepEqual(await service.querySemanticLorasForSkill({ mode: 'search', query: 'beta', page: 3, page_size: 1, base_model_id: '28201' }), loraPage([], { page: 3, pageSize: 1, totalCount: 2 }));
  } finally {
    database.close();
  }
});

test('Issue 282 LoRA Catalog empty and resolve branches use SQLite only, sort by id DESC, and keep complete safe item data', async () => {
  const { database, calls, service } = fixture({
    embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE'),
    rerankerError: new ApplicationError('RERANKER_UNAVAILABLE')
  });
  try {
    const empty = await service.querySemanticLorasForSkill({ mode: 'search', query: '   ', page: 1, page_size: 3 });
    assert.deepEqual(empty.results.map(({ id }) => id), [28205, 28204, 28203]);
    assert.equal(empty.total_count, 5);
    assert.deepEqual(await service.querySemanticLorasForSkill({ mode: 'search', query: '', page: 2, page_size: 3 }), loraPage([
      loraItem({ id: 28202, baseModelId: 28201, modelId: 28211, fileName: 'Alpha Lora.safetensors', fileFormat: 'safetensors', precision: 'fp16', author: 'Alpha Author', version: 'v8', description: 'Alpha description', usage: 'Alpha usage', triggerWords: ['alpha first', 'alpha second'], weight: 0.7 }),
      loraItem({ id: 28201, baseModelId: 28201, modelId: 28211, fileName: 'Beta Lora.safetensors', fileFormat: 'safetensors', precision: 'fp16', author: 'Beta Author', version: 'v9', description: 'Beta description', usage: 'Beta usage', triggerWords: ['beta first', 'beta second'], weight: 0.8 })
    ], { page: 2, pageSize: 3, totalCount: 5 }));
    const resolved = await service.querySemanticLorasForSkill({ mode: 'resolve', id: '28201' });
    assert.deepEqual(resolved, loraPage([
      loraItem({ id: 28201, baseModelId: 28201, modelId: 28211, fileName: 'Beta Lora.safetensors', fileFormat: 'safetensors', precision: 'fp16', author: 'Beta Author', version: 'v9', description: 'Beta description', usage: 'Beta usage', triggerWords: ['beta first', 'beta second'], weight: 0.8 })
    ], { pageSize: 1, totalCount: 1 }));
    assert.equal(calls.length, 0);
    const serialized = JSON.stringify(resolved);
    assert.equal(serialized.includes('vector_score'), false);
    assert.equal(serialized.includes('reranker_score'), false);
    assert.equal(serialized.includes('media_path'), false);
    await assert.rejects(() => service.querySemanticLorasForSkill({ mode: 'resolve', id: '28999' }), (error) => error?.code === 'CATALOG_REF_NOT_FOUND');
    await assert.rejects(() => service.querySemanticLorasForSkill({ mode: 'search', query: 'beta', base_model_id: '28999' }), (error) => error?.code === 'CATALOG_REQUEST_INVALID');
    assert.equal(calls.length, 0);
  } finally {
    database.close();
  }
});

test('Source Catalog LoRA returns an ordered multi-image response without repeating its cover', async () => {
  const { database, service } = fixture();
  try {
    const insertImage = database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (?, 'lora', 28201, ?, ?, ?, ?, ?)`);
    insertImage.run(282101, 'hash-282101', 'loras/beta-example-2.webp', 0, NOW, NOW);
    insertImage.run(282102, 'hash-282102', 'loras/beta-cover.webp', 1, NOW, NOW);
    insertImage.run(282103, 'hash-282103', 'loras/beta-example-3.webp', 2, NOW, NOW);
    database.prepare('UPDATE generation_loras SET cover_media_path = ? WHERE id = 28201').run('loras/beta-cover.webp');

    const response = await service.querySemanticLorasForSkill({ mode: 'resolve', id: '28201' });
    assert.deepEqual(response, loraPage([
      loraItem({
        id: 28201,
        baseModelId: 28201,
        modelId: 28211,
        fileName: 'Beta Lora.safetensors',
        fileFormat: 'safetensors',
        precision: 'fp16',
        author: 'Beta Author',
        version: 'v9',
        description: 'Beta description',
        usage: 'Beta usage',
        triggerWords: ['beta first', 'beta second'],
        weight: 0.8,
        coverUrl: `${MEDIA_ORIGIN}${MEDIA_PREFIX}/loras/beta-cover.webp`,
        sampleImageUrls: [
          `${MEDIA_ORIGIN}${MEDIA_PREFIX}/loras/beta-example-2.webp`,
          `${MEDIA_ORIGIN}${MEDIA_PREFIX}/loras/beta-example-3.webp`
        ]
      })
    ], { pageSize: 1, totalCount: 1 }));
  } finally {
    database.close();
  }
});

test('Issue 282 LoRA Catalog applies an existing base_model_id to finite KNN candidates and succeeds with an empty valid scope', async () => {
  const { database, calls, service } = fixture({ configuration: { ...LORA_CONFIG, reranker_candidate_limit: 5 } });
  try {
    const filtered = await service.querySemanticLorasForSkill({ mode: 'search', query: 'lora', base_model_id: '28202', page: 1, page_size: 20 });
    assert.deepEqual(filtered.results.map(({ id }) => id), [28205]);
    assert.equal(calls[1].documents.length, 1);
    calls.length = 0;
    const empty = await service.querySemanticLorasForSkill({ mode: 'search', query: 'lora', base_model_id: '28202', page: 2, page_size: 20 });
    assert.deepEqual(empty, loraPage([], { page: 2, pageSize: 20, totalCount: 1 }));
    assert.equal(calls.length, 2);
  } finally {
    database.close();
  }
});

test('Issue 282 LoRA Catalog maps index, dependency, and timeout errors only for non-empty semantic queries', async () => {
  const unavailable = fixture({ embeddingError: new ApplicationError('EMBEDDING_UNAVAILABLE') });
  try {
    await assert.rejects(() => unavailable.service.querySemanticLorasForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_UNAVAILABLE');
  } finally {
    unavailable.database.close();
  }

  const timeout = fixture({ rerankerError: new ApplicationError('RERANKER_TIMEOUT') });
  try {
    await assert.rejects(() => timeout.service.querySemanticLorasForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_DEPENDENCY_TIMEOUT');
  } finally {
    timeout.database.close();
  }

  const notReady = fixture();
  try {
    notReady.database.prepare("UPDATE vector_spaces SET embedding_model = '__unconfigured__' WHERE object_kind = 'generation_lora'").run();
    await assert.rejects(() => notReady.service.querySemanticLorasForSkill({ mode: 'search', query: 'watercolor' }), (error) => error?.code === 'CATALOG_INDEX_NOT_READY');
    await notReady.service.querySemanticLorasForSkill({ mode: 'search', query: '' });
    await notReady.service.querySemanticLorasForSkill({ mode: 'resolve', id: '28201' });
    assert.equal(notReady.calls.length, 0);
  } finally {
    notReady.database.close();
  }
});

test('Issue 282 LoRA Catalog discovery, HTTP validation, and error projection expose the closed base_model_id operation', async () => {
  const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(Object.keys(discovery.paths), CATALOG_DISCOVERY_PATHS);
  assert.ok(discovery.paths[LORA_PATH]);
  const operation = discovery.paths[LORA_PATH].post;
  assert.equal(operation.operationId, 'querySemanticLorasForSkill');
  assert.equal(operation['x-harness-tool-name'], 'query_semantic_loras');
  assert.equal(operation.description, 'Semantically search or resolve LoRA catalog records with usage, trigger words, and default weight guidance.');
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogLoraSearchRequest.properties), ['mode', 'query', 'page', 'page_size', 'base_model_id']);
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogLoraResolveRequest.properties), ['mode', 'id']);
  assert.equal(discovery.components.schemas.CatalogSourceResultRecord.additionalProperties, true);

  const calls = [];
  const service = {
    querySemanticLorasForSkill(request) {
      calls.push(request);
      if (request.mode === 'search' && request.query === 'down') throw new ApplicationError('CATALOG_DEPENDENCY_UNAVAILABLE');
      return loraPage([]);
    }
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: discovery
  });
  const success = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: LORA_PATH, body: { mode: 'search', base_model_id: '28201' } });
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, loraPage([]));
  const invalid = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: LORA_PATH, body: { mode: 'resolve', id: '1', base_model_id: '28201' } });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  const dependency = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: LORA_PATH, body: { mode: 'search', query: 'down' } });
  assert.equal(dependency.status, 502);
  assert.deepEqual(dependency.body, { status: 'error', message: 'Catalog dependency is unavailable.', results: [], page: 1, page_size: 0, total_count: 0 });
  assert.deepEqual(calls, [
    { mode: 'search', query: '', page: 1, page_size: 20, base_model_id: '28201' },
    { mode: 'search', query: 'down', page: 1, page_size: 20 }
  ]);
});
