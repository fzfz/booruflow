import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { SEMANTIC_HANDLER_ROUTE_MANIFEST } from '../../app/http/semantic-handler-routes.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const CLI_PATH = resolve(REPOSITORY_ROOT, 'scripts/imagegen-semantic-query.mjs');
const INSTANCE_PATH = '/internal/semantic/comfyui-instances';
const MEDIA_ORIGIN = 'http://127.0.0.1:19082';
const NOW = '2026-08-22T00:00:00.000Z';

function seedInstances(database) {
  const insert = database.prepare(`INSERT INTO comfyui_instances(
    id, title, url, credential_type, credential_ciphertext, is_enabled, is_valid, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = [
    [11, 'Alpha', 'http://127.0.0.1:8111', 'none', null, 0, 0],
    [12, 'alpha', 'http://127.0.0.1:8112', 'bearer', 'cipher-alpha', 1, 1],
    [13, 'A%literal', 'http://127.0.0.1:8113', 'http_basic', 'cipher-percent', 0, 0],
    [14, 'A_literal', 'http://127.0.0.1:8114', 'none', null, 0, 0],
    [15, 'A\\literal', 'http://127.0.0.1:8115', 'none', null, 0, 0],
    [16, 'Beta', 'http://127.0.0.1:8116', 'none', null, 0, 0]
  ];
  for (const row of rows) insert.run(...row, NOW, NOW);
}

function fixture({ semanticServices = {} } = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seedInstances(database);
  const repository = createCatalogRepository(database);
  const service = createCatalogService({
    database,
    repository,
    repositoryRoot: REPOSITORY_ROOT,
    mediaOrigin: MEDIA_ORIGIN,
    mediaPublicPrefix: '/assets/media',
    ...semanticServices
  });
  return { database, service };
}

function instanceItem(id, title) {
  return { id, title };
}

function instancePage({ items, page = 1, pageSize = 20, totalCount = items.length }) {
  return {
    status: 'ok',
    message: null,
    results: items,
    page,
    page_size: pageSize,
    total_count: totalCount
  };
}

function runCli(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd: '/', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

async function startDiscoveryServer(discovery) {
  const server = createNetServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  const httpServer = await new Promise((resolvePromise, rejectPromise) => {
    const listener = createHttpServer((request, response) => {
      if (request.method === 'GET' && request.url === '/internal/semantic') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(discovery));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
    });
    listener.once('error', rejectPromise);
    listener.listen(0, '127.0.0.1', () => resolvePromise(listener));
  });
  return Object.freeze({
    port: httpServer.address().port,
    close: () => new Promise((resolvePromise, rejectPromise) => httpServer.close((error) => error ? rejectPromise(error) : resolvePromise()))
  });
}

test('Issue 279 instance Catalog discovery, manifest, and CLI expose the closed ComfyUI instance operation in the current implemented Catalog set', async (t) => {
  const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT, mediaOrigin: MEDIA_ORIGIN, mediaPublicPrefix: '/assets/media' });
  assert.deepEqual(Object.keys(discovery.paths), [
    '/internal/semantic/base-models',
    '/internal/semantic/generation-models',
    '/internal/semantic/loras',
    '/internal/semantic/works',
    '/internal/semantic/characters',
    '/internal/semantic/styles',
    '/internal/semantic/prompt-terms',
    '/internal/semantic/artist-prompt-strings',
    INSTANCE_PATH,
    '/internal/semantic/comfyui-templates'
  ]);
  const operation = discovery.paths[INSTANCE_PATH].post;
  assert.equal(operation.operationId, 'querySemanticComfyuiInstancesForSkill');
  assert.equal(operation['x-harness-tool-name'], 'query_semantic_comfyui_instances');
  assert.equal(operation.description, 'Search or resolve ComfyUI instance records by title without exposing connection details or credentials.');
  const request = discovery.components.schemas.CatalogComfyuiInstanceRequest;
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogComfyuiInstanceSearchRequest.properties), ['mode', 'query', 'page', 'page_size']);
  assert.deepEqual(Object.keys(discovery.components.schemas.CatalogComfyuiInstanceResolveRequest.properties), ['mode', 'id']);
  assert.equal(request.oneOf.length, 2);
  assert.equal(discovery.components.schemas.CatalogSourceResultRecord.additionalProperties, true);
  assert.equal(JSON.stringify(operation).includes('url'), false);
  assert.equal(JSON.stringify(operation).includes('credential_type'), false);
  assert.equal(JSON.stringify(operation).includes('credential_ciphertext'), false);
  assert.equal(JSON.stringify(operation).includes('Authorization'), false);

  assert.deepEqual(SEMANTIC_HANDLER_ROUTE_MANIFEST, [
    { listener: 'internal', method: 'get', path: '/internal/semantic', operationId: 'getSemanticDiscovery' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/base-models', operationId: 'querySemanticBaseModelsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/generation-models', operationId: 'querySemanticGenerationModelsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/loras', operationId: 'querySemanticLorasForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/works', operationId: 'querySemanticWorksForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/characters', operationId: 'querySemanticCharactersForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/styles', operationId: 'querySemanticStylesForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/prompt-terms', operationId: 'querySemanticPromptTermsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/artist-prompt-strings', operationId: 'querySemanticArtistPromptStringsForSkill' },
    { listener: 'internal', method: 'post', path: INSTANCE_PATH, operationId: 'querySemanticComfyuiInstancesForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/comfyui-templates', operationId: 'querySemanticComfyuiTemplatesForSkill' }
  ]);

  const server = await startDiscoveryServer(discovery);
  t.after(() => server.close());
  const help = await runCli(['--port', String(server.port), '--path', INSTANCE_PATH, '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, new RegExp(`POST ${INSTANCE_PATH}`, 'u'));
  assert.match(help.stdout, /--mode search/u);
  assert.match(help.stdout, /--mode resolve --id/u);
});

test('Issue 279 instance Catalog uses SQLite title matching, id-desc empty paging, binary text ordering, resolve, and secret exclusion', () => {
  const { database, service } = fixture();
  try {
    const empty = service.querySemanticComfyuiInstancesForSkill({ mode: 'search', page: 1, page_size: 2 });
    assert.deepEqual(empty, instancePage({
      items: [instanceItem(16, 'Beta', false, false), instanceItem(15, 'A\\literal', false, false)],
      pageSize: 2,
      totalCount: 6
    }));
    assert.deepEqual(service.querySemanticComfyuiInstancesForSkill({ mode: 'search', query: '   ', page: 1, page_size: 2 }), empty);
    assert.deepEqual(service.querySemanticComfyuiInstancesForSkill({ mode: 'search', query: '', page: 3, page_size: 2 }).results.map(({ id }) => id), [12, 11]);
    assert.equal(service.querySemanticComfyuiInstancesForSkill({ mode: 'search', query: '', page: 4, page_size: 2 }).total_count, 6);
    assert.deepEqual(service.querySemanticComfyuiInstancesForSkill({ mode: 'search', query: 'a', page: 1, page_size: 20 }).results.map(({ id, title }) => [id, title]), [
      [13, 'A%literal'],
      [15, 'A\\literal'],
      [14, 'A_literal'],
      [11, 'Alpha'],
      [16, 'Beta'],
      [12, 'alpha']
    ]);
    assert.deepEqual(service.querySemanticComfyuiInstancesForSkill({ mode: 'search', query: '%', page_size: 20 }).results.map(({ id }) => id), [13]);
    assert.deepEqual(service.querySemanticComfyuiInstancesForSkill({ mode: 'search', query: '_', page_size: 20 }).results.map(({ id }) => id), [14]);
    assert.deepEqual(service.querySemanticComfyuiInstancesForSkill({ mode: 'search', query: '\\', page_size: 20 }).results.map(({ id }) => id), [15]);
    assert.deepEqual(service.querySemanticComfyuiInstancesForSkill({ mode: 'resolve', id: '12' }), instancePage({ items: [instanceItem(12, 'alpha', true, true)], pageSize: 1, totalCount: 1 }));
    assert.deepEqual(Object.keys(empty.results[0]), ['id', 'title']);
    assert.equal(JSON.stringify(empty).includes('8112'), false);
    assert.equal(JSON.stringify(empty).includes('cipher-alpha'), false);
    assert.throws(() => service.querySemanticComfyuiInstancesForSkill({ mode: 'resolve', id: '999' }), (error) => error?.code === 'CATALOG_REF_NOT_FOUND');
  } finally {
    database.close();
  }
});

test('Issue 279 instance Catalog HTTP seam maps invalid, busy, and unknown requests without model calls', async () => {
  let calls = 0;
  const page = instancePage({ items: [] });
  const service = {
    querySemanticComfyuiInstancesForSkill(request) {
      calls += 1;
      if (request.mode === 'resolve' && request.id === '1') throw Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
      if (request.mode === 'resolve' && request.id === '2') throw new ApplicationError('CATALOG_REF_NOT_FOUND');
      return page;
    }
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT, mediaOrigin: MEDIA_ORIGIN, mediaPublicPrefix: '/assets/media' })
  });
  const response = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: INSTANCE_PATH, body: { mode: 'search' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, page);
  for (const body of [{ mode: 'search', unknown: true }, { mode: 'resolve' }, { mode: 'resolve', id: '1', query: '' }, { mode: 'search', page: 0 }]) {
    const invalid = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: INSTANCE_PATH, body });
    assert.equal(invalid.status, 422, JSON.stringify(body));
    assert.deepEqual(invalid.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  }
  const busy = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: INSTANCE_PATH, body: { mode: 'resolve', id: '1' } });
  assert.equal(busy.status, 503);
  assert.deepEqual(busy.body, { status: 'error', message: 'Catalog database is busy.', results: [], page: 1, page_size: 0, total_count: 0 });
  const unknown = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: INSTANCE_PATH, body: { mode: 'resolve', id: '2' } });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { status: 'error', message: 'Catalog record was not found.', results: [], page: 1, page_size: 0, total_count: 0 });
  assert.equal(calls, 3);
});

test('Issue 279 instance Catalog does not touch configured semantic services', () => {
  const calls = [];
  const failFast = Object.freeze({
    searchPublic() { calls.push('searchPublic'); throw new Error('instance Catalog must not use semantic search'); },
    searchSkillForAgent() { calls.push('searchSkillForAgent'); throw new Error('instance Catalog must not use semantic search'); }
  });
  const { database, service } = fixture({ semanticServices: {
    workSemanticService: failFast,
    characterSemanticService: failFast,
    styleSemanticService: failFast,
    promptTermSemanticService: failFast
  } });
  try {
    service.querySemanticComfyuiInstancesForSkill({ mode: 'search', query: 'alpha' });
    service.querySemanticComfyuiInstancesForSkill({ mode: 'search' });
    service.querySemanticComfyuiInstancesForSkill({ mode: 'resolve', id: '11' });
    assert.deepEqual(calls, []);
  } finally {
    database.close();
  }
});
