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
const BASE_MODEL_OPERATION = '/internal/semantic/base-models';

const NOW = '2026-08-22T00:00:00.000Z';

function seedBaseModels(database) {
  const rows = [
    [11, 'Alpha'],
    [12, 'alpha'],
    [13, 'A%literal'],
    [14, 'A_literal'],
    [15, 'A\\literal'],
    [16, 'Beta']
  ];
  const insert = database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  for (const [id, name] of rows) insert.run(id, name, NOW, NOW);
}

function fixture() {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seedBaseModels(database);
  const repository = createCatalogRepository(database);
  const service = createCatalogService({ database, repository });
  return { database, service };
}

function baseItem(id, name) {
  return { id, name };
}

function basePage({ items, page = 1, pageSize = 20, totalCount = items.length }) {
  return {
    status: 'ok',
    message: null,
    results: items,
    page,
    page_size: pageSize,
    total_count: totalCount
  };
}

test('Issue 278 Catalog discovery publishes current implemented Catalog operations without result protocol metadata', () => {
  const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(Object.keys(discovery.paths), [
    BASE_MODEL_OPERATION,
    '/internal/semantic/generation-models',
    '/internal/semantic/loras',
    '/internal/semantic/works',
    '/internal/semantic/characters',
    '/internal/semantic/styles',
    '/internal/semantic/prompt-terms',
    '/internal/semantic/artist-prompt-strings',
    '/internal/semantic/comfyui-instances',
    '/internal/semantic/comfyui-templates'
  ]);
  const operation = discovery.paths[BASE_MODEL_OPERATION].post;
  assert.equal(operation.operationId, 'querySemanticBaseModelsForSkill');
  assert.equal(operation['x-harness-tool-name'], 'query_semantic_base_models');
  assert.equal(operation.description, 'Search or resolve base-model records by base-model name for generation catalog filtering.');
  assert.equal(operation['x-noobai-pi-tool-name'], undefined);
  assert.equal(operation['x-noobai-callable-projection'], undefined);
  const requestSchema = discovery.components.schemas.CatalogBaseModelRequest;
  assert.equal(requestSchema.oneOf.length, 2);
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogBaseModelSearchRequest.properties), ['mode', 'query', 'page', 'page_size']);
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogBaseModelResolveRequest.properties), ['mode', 'id']);
  const pageSchema = discovery.components.schemas.CatalogSourceSuccess;
  assert.equal(pageSchema.properties.results.maxItems, 100);
  assert.equal(discovery.components.schemas.CatalogSourceResultRecord.additionalProperties, true);
  assert.equal(JSON.stringify(discovery).includes('queries'), false);
  assert.equal(JSON.stringify(discovery).includes('groups'), false);
});

test('Issue 278 handler manifest exposes the discovery endpoint and current implemented Catalog operations', () => {
  assert.deepEqual(SEMANTIC_HANDLER_ROUTE_MANIFEST, [
    { listener: 'internal', method: 'get', path: '/internal/semantic', operationId: 'getSemanticDiscovery' },
    { listener: 'internal', method: 'post', path: BASE_MODEL_OPERATION, operationId: 'querySemanticBaseModelsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/generation-models', operationId: 'querySemanticGenerationModelsForSkill' },
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

test('Issue 278 base-model service handles closed search, escaped LIKE text, binary ordering, pagination, and resolve', () => {
  const { database, service } = fixture();
  try {
    const empty = service.querySemanticBaseModelsForSkill({ mode: 'search', page: 1, page_size: 2 });
    assert.deepEqual(empty, basePage({
      items: [baseItem(16, 'Beta'), baseItem(15, 'A\\literal')],
      pageSize: 2,
      totalCount: 6
    }));
    const blank = service.querySemanticBaseModelsForSkill({ mode: 'search', query: '   ', page: 1, page_size: 2 });
    assert.deepEqual(blank, empty);
    const last = service.querySemanticBaseModelsForSkill({ mode: 'search', query: '', page: 3, page_size: 2 });
    assert.deepEqual(last, basePage({ items: [baseItem(12, 'alpha'), baseItem(11, 'Alpha')], page: 3, pageSize: 2, totalCount: 6 }));
    const beyond = service.querySemanticBaseModelsForSkill({ mode: 'search', page: 4, page_size: 2 });
    assert.deepEqual(beyond, basePage({ items: [], page: 4, pageSize: 2, totalCount: 6 }));

    const text = service.querySemanticBaseModelsForSkill({ mode: 'search', query: 'a', page: 1, page_size: 20 });
    assert.deepEqual(text.results.map(({ id, name }) => [id, name]), [
      [13, 'A%literal'],
      [15, 'A\\literal'],
      [14, 'A_literal'],
      [11, 'Alpha'],
      [16, 'Beta'],
      [12, 'alpha']
    ]);
    assert.equal(text.total_count, 6);
    assert.deepEqual(service.querySemanticBaseModelsForSkill({ mode: 'search', query: '%', page_size: 20 }).results.map(({ id }) => id), [13]);
    assert.deepEqual(service.querySemanticBaseModelsForSkill({ mode: 'search', query: '_', page_size: 20 }).results.map(({ id }) => id), [14]);
    assert.deepEqual(service.querySemanticBaseModelsForSkill({ mode: 'search', query: '\\', page_size: 20 }).results.map(({ id }) => id), [15]);

    assert.deepEqual(
      service.querySemanticBaseModelsForSkill({ mode: 'resolve', id: '13' }),
      basePage({ items: [baseItem(13, 'A%literal')], page: 1, pageSize: 1, totalCount: 1 })
    );
    assert.throws(
      () => service.querySemanticBaseModelsForSkill({ mode: 'resolve', id: '999' }),
      (error) => error?.code === 'CATALOG_REF_NOT_FOUND'
    );
    assert.throws(
      () => service.querySemanticBaseModelsForSkill({ mode: 'resolve', id: '12345678901234567890' }),
      (error) => error?.code === 'CATALOG_REF_NOT_FOUND'
    );
  } finally {
    database.close();
  }
});

test('Issue 278 HTTP dispatcher accepts only closed search/resolve requests and returns the CatalogPage directly', async () => {
  const service = {
    querySemanticBaseModelsForSkill(request) {
      assert.deepEqual(request, { mode: 'search', query: '', page: 1, page_size: 20 });
      return basePage({ items: [] });
    }
  };
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper(REPOSITORY_ROOT), semanticDiscovery: buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT }) });
  const response = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: BASE_MODEL_OPERATION, body: { mode: 'search' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, basePage({ items: [] }));
  assert.equal(response.body.ok, undefined);
  assert.equal(response.body.data, undefined);

  for (const body of [
    { mode: 'search', unexpected: true },
    { mode: 'resolve' },
    { mode: 'resolve', id: '1', query: '' },
    { mode: 'search', page: 0 },
    { mode: 'search', page: 100001 },
    { mode: 'search', page_size: 101 },
    { mode: 'search', query: 'x'.repeat(201) }
  ]) {
    const invalid = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: BASE_MODEL_OPERATION, body });
    assert.equal(invalid.status, 422, JSON.stringify(body));
    assert.deepEqual(invalid.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  }
});

test('Issue 278 HTTP dispatcher maps unresolved IDs and SQLite busy without invoking a model', async () => {
  let calls = 0;
  const service = {
    querySemanticBaseModelsForSkill(request) {
      calls += 1;
      if (request.mode === 'resolve' && request.id === '1') throw Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
      if (request.mode === 'resolve' && request.id === '2') throw new ApplicationError('CATALOG_REF_NOT_FOUND');
      throw new Error('unexpected');
    }
  };
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper(REPOSITORY_ROOT), semanticDiscovery: buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT }) });
  const busy = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: BASE_MODEL_OPERATION, body: { mode: 'resolve', id: '1' } });
  assert.equal(busy.status, 503);
  assert.deepEqual(busy.body, { status: 'error', message: 'Catalog database is busy.', results: [], page: 1, page_size: 0, total_count: 0 });
  assert.equal(calls, 1);

  const unknown = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: BASE_MODEL_OPERATION, body: { mode: 'resolve', id: '2' } });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { status: 'error', message: 'Catalog record was not found.', results: [], page: 1, page_size: 0, total_count: 0 });
});
