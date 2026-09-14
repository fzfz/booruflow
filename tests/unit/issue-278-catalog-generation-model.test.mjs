import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { SEMANTIC_HANDLER_ROUTE_MANIFEST } from '../../app/http/semantic-handler-routes.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const MODEL_OPERATION = '/internal/semantic/generation-models';
const MEDIA_ORIGIN = 'http://127.0.0.1:19082';
const MEDIA_PREFIX = '/assets/media';
const NOW = '2026-08-22T00:00:00.000Z';

function seedGenerationModels(database) {
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES
      (11, 'WAI', '${NOW}', '${NOW}'),
      (12, 'Anima', '${NOW}', '${NOW}');
  `);
  const insert = database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    author, version, release_url, published_at, description, usage, skill_name,
    cover_media_path, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = [
    [101, 11, 'Alpha.safetensors', 'safetensors', 'fp16', 'Alice', 'v1', 'https://release.example/alpha', '2026-01-01', 'alpha description', 'alpha usage', 'wai.skill', 'covers/space name/图片.png'],
    [102, 11, 'alpha.safetensors', 'safetensors', 'bf16', null, 'v2', null, null, 'version description', 'version usage', null, null],
    [103, 11, 'A%literal.safetensors', 'safetensors', 'none', null, null, null, null, 'percent description', 'percent usage', null, null],
    [104, 11, 'A_literal.safetensors', 'safetensors', 'none', null, null, null, null, 'underscore description', 'underscore usage', null, null],
    [105, 11, 'A\\literal.safetensors', 'safetensors', 'none', null, null, null, null, 'slash description', 'slash usage', null, null],
    [106, 11, 'Zoo.safetensors', 'safetensors', 'fp8', 'Zoo Author', 'z1', 'https://release.example/zoo', '2026-02-02', 'zoo description', 'zoo usage', 'zoo.skill', null],
    [107, 12, 'alpha.safetensors', 'gguf', 'int4', 'Anima Author', 'a1', null, null, 'anima description', 'anima usage', 'anima.skill', null]
  ];
  for (const row of rows) insert.run(...row, NOW, NOW);
}

function fixture({ mediaOrigin = MEDIA_ORIGIN } = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seedGenerationModels(database);
  const repository = createCatalogRepository(database);
  const service = createCatalogService({
    database,
    repository,
    repositoryRoot: REPOSITORY_ROOT,
    mediaOrigin,
    mediaPublicPrefix: MEDIA_PREFIX
  });
  return { database, repository, service };
}

function modelItem({
  id,
  baseModelId = 11,
  fileName,
  fileFormat = 'safetensors',
  precision = 'none',
  author = null,
  version = null,
  description = 'description',
  usage = 'usage',
  skillName = null,
  coverUrl = null,
  sampleImageUrls = []
}) {
  return {
    id,
    base_model_id: baseModelId,
    file_name: fileName,
    file_format: fileFormat,
    precision_or_quantization: precision,
    author,
    version,
    description,
    usage,
    skill_name: skillName,
    cover_url: coverUrl,
    sample_image_urls: sampleImageUrls
  };
}

function insertImage(database, { id, ownerId, mediaPath, sortOrder }) {
  database.prepare(`INSERT INTO item_images(
    id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
  ) VALUES (?, 'model', ?, ?, ?, ?, ?, ?)`).run(
    id, ownerId, `hash-${id}`, mediaPath, sortOrder, NOW, NOW
  );
}

function traceBatchImageQueries(database) {
  const calls = [];
  const tracedDatabase = new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'function') return target.function.bind(target);
      if (property !== 'prepare') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (sql) => {
        const statement = target.prepare(sql);
        if (!/FROM item_images[\s\S]*owner_id IN/u.test(String(sql))) return statement;
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== 'all') return Reflect.get(statementTarget, statementProperty, statementReceiver);
            return (...args) => {
              calls.push({ sql: String(sql), args });
              return statementTarget.all(...args);
            };
          }
        });
      };
    }
  });
  return { calls, tracedDatabase };
}

function modelPage({ items, page = 1, pageSize = 20, totalCount = items.length }) {
  return {
    status: 'ok',
    message: null,
    results: items,
    page,
    page_size: pageSize,
    total_count: totalCount
  };
}

test('Issue 278 generation-model discovery publishes the closed operation and injected media origin', () => {
  const discovery = buildSemanticDiscovery({
    repositoryRoot: REPOSITORY_ROOT,
    mediaOrigin: MEDIA_ORIGIN,
    mediaPublicPrefix: MEDIA_PREFIX
  });
  assert.equal(discovery['x-imagegen-media-origin'], MEDIA_ORIGIN);
  assert.deepEqual(Object.keys(discovery.paths), [
    '/internal/semantic/base-models',
    MODEL_OPERATION,
    '/internal/semantic/loras',
    '/internal/semantic/works',
    '/internal/semantic/characters',
    '/internal/semantic/styles',
    '/internal/semantic/prompt-terms',
    '/internal/semantic/artist-prompt-strings',
    '/internal/semantic/comfyui-instances',
    '/internal/semantic/comfyui-templates'
  ]);
  const operation = discovery.paths[MODEL_OPERATION].post;
  assert.equal(operation.operationId, 'querySemanticGenerationModelsForSkill');
  assert.equal(operation['x-harness-tool-name'], 'query_semantic_generation_models');
  assert.equal(operation.description, 'Search or resolve generation-model records by file name, optionally restricted to one base model.');
  assert.equal(operation['x-noobai-pi-tool-name'], undefined);
  assert.equal(operation['x-noobai-callable-projection'], undefined);
  const search = discovery.components.schemas.CatalogGenerationModelSearchRequest;
  const resolveRequest = discovery.components.schemas.CatalogGenerationModelResolveRequest;
  assert.deepEqual(Object.keys(search.properties), ['mode', 'query', 'page', 'page_size', 'base_model_id']);
  assert.deepEqual(search.required, ['mode']);
  assert.deepEqual(Object.keys(resolveRequest.properties), ['mode', 'id']);
  assert.deepEqual(resolveRequest.required, ['mode', 'id']);
  assert.equal(search.additionalProperties, false);
  assert.equal(resolveRequest.additionalProperties, false);
  assert.equal(search.properties.base_model_id.pattern, '^[1-9][0-9]{0,19}$');
  assert.equal(discovery.components.schemas.CatalogSourceResultRecord.additionalProperties, true);
  assert.equal(discovery.components.schemas.CatalogSourceSuccess.properties.results.maxItems, 100);
  assert.equal(JSON.stringify(operation).includes('release_url'), false);
  assert.equal(JSON.stringify(operation).includes('published_at'), false);
  assert.equal(JSON.stringify(operation).includes('cover_media_path'), false);
});

test('Issue 278 handler manifest includes the generation-model operation after base-model discovery', () => {
  assert.deepEqual(SEMANTIC_HANDLER_ROUTE_MANIFEST, [
    { listener: 'internal', method: 'get', path: '/internal/semantic', operationId: 'getSemanticDiscovery' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/base-models', operationId: 'querySemanticBaseModelsForSkill' },
    { listener: 'internal', method: 'post', path: MODEL_OPERATION, operationId: 'querySemanticGenerationModelsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/loras', operationId: 'querySemanticLorasForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/works', operationId: 'querySemanticWorksForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/characters', operationId: 'querySemanticCharactersForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/styles', operationId: 'querySemanticStylesForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/prompt-terms', operationId: 'querySemanticPromptTermsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/artist-prompt-strings', operationId: 'querySemanticArtistPromptStringsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/comfyui-instances', operationId: 'querySemanticComfyuiInstancesForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/comfyui-templates', operationId: 'querySemanticComfyuiTemplatesForSkill' }
  ]);
});

test('Issue 278 generation-model service applies literal file-name matching, exact parent filtering, stable pagination, closed data, and media URL projection', () => {
  const { database, service } = fixture();
  try {
    const empty = service.querySemanticGenerationModelsForSkill({ mode: 'search', page: 1, page_size: 2 });
    assert.deepEqual(empty, modelPage({
      items: [
        modelItem({ id: 107, baseModelId: 12, fileName: 'alpha.safetensors', fileFormat: 'gguf', precision: 'int4', author: 'Anima Author', version: 'a1', description: 'anima description', usage: 'anima usage', skillName: 'anima.skill' }),
        modelItem({ id: 106, fileName: 'Zoo.safetensors', fileFormat: 'safetensors', precision: 'fp8', author: 'Zoo Author', version: 'z1', description: 'zoo description', usage: 'zoo usage', skillName: 'zoo.skill' })
      ],
      pageSize: 2,
      totalCount: 7
    }));
    assert.deepEqual(service.querySemanticGenerationModelsForSkill({ mode: 'search', query: '   ', page: 1, page_size: 2 }), empty);

    const text = service.querySemanticGenerationModelsForSkill({ mode: 'search', query: 'a', page: 1, page_size: 20 });
    assert.deepEqual(text.results.map(({ id, file_name }) => [id, file_name]), [
      [103, 'A%literal.safetensors'],
      [105, 'A\\literal.safetensors'],
      [104, 'A_literal.safetensors'],
      [101, 'Alpha.safetensors'],
      [106, 'Zoo.safetensors'],
      [102, 'alpha.safetensors'],
      [107, 'alpha.safetensors']
    ]);
    assert.equal(text.total_count, 7);
    assert.deepEqual(service.querySemanticGenerationModelsForSkill({ mode: 'search', query: '%', page_size: 20 }).results.map(({ id }) => id), [103]);
    assert.deepEqual(service.querySemanticGenerationModelsForSkill({ mode: 'search', query: '_', page_size: 20 }).results.map(({ id }) => id), [104]);
    assert.deepEqual(service.querySemanticGenerationModelsForSkill({ mode: 'search', query: '\\', page_size: 20 }).results.map(({ id }) => id), [105]);

    const pageTwo = service.querySemanticGenerationModelsForSkill({ mode: 'search', query: 'a', page: 2, page_size: 2 });
    assert.deepEqual(pageTwo.results.map(({ id }) => id), [104, 101]);
    assert.equal(pageTwo.total_count, 7);
    const pageThree = service.querySemanticGenerationModelsForSkill({ mode: 'search', query: 'a', page: 3, page_size: 2 });
    assert.deepEqual(pageThree.results.map(({ id }) => id), [106, 102]);
    assert.equal(pageThree.total_count, 7);
    const last = service.querySemanticGenerationModelsForSkill({ mode: 'search', query: 'a', page: 4, page_size: 2 });
    assert.deepEqual(last.results.map(({ id }) => id), [107]);
    assert.equal(last.total_count, 7);
    const beyond = service.querySemanticGenerationModelsForSkill({ mode: 'search', query: 'a', page: 5, page_size: 2 });
    assert.deepEqual(beyond.results, []);
    assert.equal(beyond.total_count, 7);

    const filtered = service.querySemanticGenerationModelsForSkill({ mode: 'search', query: 'alpha', base_model_id: '11', page_size: 20 });
    assert.deepEqual(filtered.results.map(({ id }) => id), [101, 102]);
    assert.equal(filtered.total_count, 2);
    const parentNoMatch = service.querySemanticGenerationModelsForSkill({ mode: 'search', query: 'does-not-exist', base_model_id: '11', page_size: 20 });
    assert.deepEqual(parentNoMatch.results, []);
    assert.equal(parentNoMatch.total_count, 0);
    assert.throws(
      () => service.querySemanticGenerationModelsForSkill({ mode: 'search', query: 'alpha', base_model_id: '99999999999999999999' }),
      (error) => error?.code === 'CATALOG_REQUEST_INVALID'
    );

    assert.deepEqual(service.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '101' }), modelPage({
      items: [modelItem({ id: 101, fileName: 'Alpha.safetensors', precision: 'fp16', author: 'Alice', version: 'v1', description: 'alpha description', usage: 'alpha usage', skillName: 'wai.skill', coverUrl: `${MEDIA_ORIGIN}${MEDIA_PREFIX}/covers/space%20name/%E5%9B%BE%E7%89%87.png` })],
      pageSize: 1,
      totalCount: 1
    }));
    assert.equal(service.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '102' }).results[0].version, 'v2');
    assert.equal(service.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '103' }).results[0].version, null);
    assert.deepEqual(Object.keys(service.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '101' }).results[0]), [
      'id', 'base_model_id', 'file_name', 'file_format', 'precision_or_quantization', 'author', 'version', 'description', 'usage', 'skill_name', 'cover_url', 'sample_image_urls'
    ]);
    assert.throws(
      () => service.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '99999999999999999999' }),
      (error) => error?.code === 'CATALOG_REF_NOT_FOUND'
    );
  } finally {
    database.close();
  }
});

test('Source Catalog generation-model sample images exclude the cover, preserve database order, deduplicate URLs, and use one page query', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seedGenerationModels(database);
  insertImage(database, { id: 1001, ownerId: 101, mediaPath: 'models/101-sample-a.webp', sortOrder: 0 });
  insertImage(database, { id: 1002, ownerId: 101, mediaPath: 'models/101-sample-b.webp', sortOrder: 1 });
  insertImage(database, { id: 1003, ownerId: 101, mediaPath: 'covers/space name/图片.png', sortOrder: 2 });
  insertImage(database, { id: 1004, ownerId: 102, mediaPath: 'models/102-cover.webp', sortOrder: 0 });
  insertImage(database, { id: 1005, ownerId: 102, mediaPath: 'models/102-sample-a.webp', sortOrder: 1 });
  insertImage(database, { id: 1006, ownerId: 102, mediaPath: 'models/102-sample-b.webp', sortOrder: 2 });
  insertImage(database, { id: 1007, ownerId: 103, mediaPath: 'models/103-cover.webp', sortOrder: 0 });
  database.prepare('UPDATE generation_models SET cover_media_path = ? WHERE id = ?').run('models/102-cover.webp', 102);
  database.prepare('UPDATE generation_models SET cover_media_path = ? WHERE id = ?').run('models/103-cover.webp', 103);
  const { calls, tracedDatabase } = traceBatchImageQueries(database);
  const repository = createCatalogRepository(tracedDatabase);
  const service = createCatalogService({
    database: tracedDatabase,
    repository,
    repositoryRoot: REPOSITORY_ROOT,
    mediaOrigin: MEDIA_ORIGIN,
    mediaPublicPrefix: MEDIA_PREFIX
  });
  try {
    const search = service.querySemanticGenerationModelsForSkill({ mode: 'search', query: 'alpha', page: 1, page_size: 20 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], 'model');
    assert.equal(calls[0].args.length, search.results.length + 1);
    assert.deepEqual(search.results.find(({ id }) => id === 101).sample_image_urls, [
      `${MEDIA_ORIGIN}${MEDIA_PREFIX}/models/101-sample-a.webp`,
      `${MEDIA_ORIGIN}${MEDIA_PREFIX}/models/101-sample-b.webp`
    ]);
    assert.deepEqual(search.results.find(({ id }) => id === 102).sample_image_urls, [
      `${MEDIA_ORIGIN}${MEDIA_PREFIX}/models/102-sample-a.webp`,
      `${MEDIA_ORIGIN}${MEDIA_PREFIX}/models/102-sample-b.webp`
    ]);

    calls.length = 0;
    const resolved = service.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '101' }).results[0];
    assert.equal(calls.length, 1);
    assert.deepEqual(resolved.sample_image_urls, search.results.find(({ id }) => id === 101).sample_image_urls);
    assert.deepEqual(service.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '103' }).results[0].sample_image_urls, []);
    assert.deepEqual(service.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '106' }).results[0], modelItem({
      id: 106,
      fileName: 'Zoo.safetensors',
      fileFormat: 'safetensors',
      precision: 'fp8',
      author: 'Zoo Author',
      version: 'z1',
      description: 'zoo description',
      usage: 'zoo usage',
      skillName: 'zoo.skill'
    }));
  } finally {
    database.close();
  }

  const duplicateRepository = Object.freeze({
    getCatalogGenerationModel() {
      return {
        id: 1,
        base_model_id: 11,
        file_name: 'duplicate.safetensors',
        file_format: 'safetensors',
        precision_or_quantization: 'fp16',
        description: 'description',
        usage: 'usage',
        cover_media_path: null
      };
    },
    listCatalogImagesByOwners() {
      return [
        { id: 1, owner_kind: 'model', owner_id: 1, media_path: 'models/repeated.webp', sort_order: 0 },
        { id: 2, owner_kind: 'model', owner_id: 1, media_path: 'models/repeated.webp', sort_order: 1 }
      ];
    }
  });
  const duplicateService = createCatalogService({
    database: Object.freeze({}),
    repository: duplicateRepository,
    mediaOrigin: MEDIA_ORIGIN,
    mediaPublicPrefix: MEDIA_PREFIX
  });
  assert.deepEqual(
    duplicateService.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '1' }).results[0].sample_image_urls,
    [`${MEDIA_ORIGIN}${MEDIA_PREFIX}/models/repeated.webp`]
  );
});

test('Issue 278 media origin is a fixed loopback HTTP origin shared by discovery and cover URLs', () => {
  for (const port of [1, 80, 65535]) {
    const origin = `http://127.0.0.1:${port}`;
    const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT, mediaOrigin: origin });
    assert.equal(discovery['x-imagegen-media-origin'], origin);
  }

  for (const mediaOrigin of [
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:00080',
    'https://127.0.0.1:19082',
    'http://localhost:19082',
    'http://example.com:19082',
    'http://user@127.0.0.1:19082',
    'http://127.0.0.1:19082/path',
    'http://127.0.0.1:19082?query=1',
    'http://127.0.0.1:19082#fragment'
  ]) {
    assert.throws(
      () => buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT, mediaOrigin }),
      /x-imagegen-media-origin/
    );
  }

  const { database, service } = fixture({ mediaOrigin: 'http://127.0.0.1:80' });
  try {
    assert.equal(
      service.querySemanticGenerationModelsForSkill({ mode: 'resolve', id: '101' }).results[0].cover_url,
      'http://127.0.0.1:80/assets/media/covers/space%20name/%E5%9B%BE%E7%89%87.png'
    );
  } finally {
    database.close();
  }
});

test('Issue 278 generation-model HTTP seam validates filters and maps fixed errors without model calls', async () => {
  let calls = 0;
  const page = modelPage({ items: [] });
  const service = {
    querySemanticGenerationModelsForSkill(request) {
      calls += 1;
      assert.deepEqual(request, { mode: 'search', query: 'alpha', page: 1, page_size: 20, base_model_id: '11' });
      return page;
    }
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT, mediaOrigin: MEDIA_ORIGIN, mediaPublicPrefix: MEDIA_PREFIX })
  });
  const response = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: MODEL_OPERATION, body: { mode: 'search', query: ' Alpha ', base_model_id: '11' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, page);
  assert.equal(response.body.ok, undefined);
  assert.equal(response.body.data, undefined);
  assert.equal(calls, 1);

  for (const body of [
    { mode: 'search', base_model_id: 11 },
    { mode: 'search', base_model_id: '0' },
    { mode: 'search', base_model_id: '99999999999999999999', unexpected: true },
    { mode: 'resolve', id: '1', base_model_id: '11' },
    { mode: 'search', page: 0 },
    { mode: 'search', page_size: 101 },
    { mode: 'search', query: 'x'.repeat(201) }
  ]) {
    const invalid = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: MODEL_OPERATION, body });
    assert.equal(invalid.status, 422, JSON.stringify(body));
    assert.deepEqual(invalid.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  }
  assert.equal(calls, 1);

  const busyService = {
    querySemanticGenerationModelsForSkill() {
      throw Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
    }
  };
  const busyDispatcher = createCatalogHttpDispatcher({
    service: busyService,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT, mediaOrigin: MEDIA_ORIGIN, mediaPublicPrefix: MEDIA_PREFIX })
  });
  const busy = await busyDispatcher.dispatch({ listener: 'internal', method: 'POST', url: MODEL_OPERATION, body: { mode: 'search' } });
  assert.equal(busy.status, 503);
  assert.deepEqual(busy.body, { status: 'error', message: 'Catalog database is busy.', results: [], page: 1, page_size: 0, total_count: 0 });

  const missingService = {
    querySemanticGenerationModelsForSkill() {
      throw new ApplicationError('CATALOG_REF_NOT_FOUND');
    }
  };
  const missingDispatcher = createCatalogHttpDispatcher({
    service: missingService,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT, mediaOrigin: MEDIA_ORIGIN, mediaPublicPrefix: MEDIA_PREFIX })
  });
  const missing = await missingDispatcher.dispatch({ listener: 'internal', method: 'POST', url: MODEL_OPERATION, body: { mode: 'resolve', id: '101' } });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { status: 'error', message: 'Catalog record was not found.', results: [], page: 1, page_size: 0, total_count: 0 });
});
