import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { startLocalApplication } from '../../app/server/local-app.mjs';
import { FAKE_VECTOR_CONFIGURATION, createFakeSemanticModelClient } from '../fixtures/vector/fake-semantic-model-client.mjs';

const CLI_PATH = new URL('../../scripts/imagegen-semantic-query.mjs', import.meta.url).pathname;
const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const BASE_MODEL_PATH = '/internal/semantic/base-models';
const GENERATION_MODEL_PATH = '/internal/semantic/generation-models';
const CURRENT_CATALOG_PATHS = Object.freeze([
  BASE_MODEL_PATH,
  GENERATION_MODEL_PATH,
  '/internal/semantic/loras',
  '/internal/semantic/works',
  '/internal/semantic/characters',
  '/internal/semantic/styles',
  '/internal/semantic/prompt-terms',
  '/internal/semantic/artist-prompt-strings',
  '/internal/semantic/comfyui-instances',
  '/internal/semantic/comfyui-templates'
]);

function restoreEnvironment(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return port;
}

function createCountingModelClient(calls) {
  const fakeClient = createFakeSemanticModelClient();
  return Object.freeze({
    async embed(inputs) {
      calls.push({ method: 'embed', inputs: [...inputs] });
      return fakeClient.embed(inputs);
    },
    async rerank(query, documents) {
      calls.push({ method: 'rerank', query, documents: [...documents] });
      return fakeClient.rerank(query, documents);
    }
  });
}

async function startSemanticFixtureApplication({ repositoryRoot, paths, calls }) {
  const database = openCatalogDatabase({ databasePath: paths.database, mediaRoot: paths.media, repositoryRoot, includeBuiltinComfyuiCatalog: false });
  try {
    const now = '2026-08-22T00:00:00.000Z';
    database.exec(`
      INSERT INTO generation_base_models(id, name, created_at, updated_at)
        VALUES (801, 'Fixture WAI', '${now}', '${now}');
      INSERT INTO generation_models(
        id, base_model_id, file_name, file_format, precision_or_quantization,
        description, usage, created_at, updated_at
      ) VALUES (802, 801, 'fixture-model.safetensors', 'safetensors', 'fp16', 'fixture model', 'fixture usage', '${now}', '${now}');
    `);
  } finally {
    database.close();
  }
  return startLocalApplication({
    repositoryRoot,
    dataPaths: { dataRoot: dirname(paths.database), databasePath: paths.database, mediaRoot: paths.media },
    listenerMode: 'all',
    vectorConfiguration: FAKE_VECTOR_CONFIGURATION,
    vectorModelClient: createCountingModelClient(calls),
    authorizeWrite: () => false,
    onStarted: () => {}
  });
}

async function createRealApplicationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-276-semantic-http-'));
  const dataRoot = join(root, 'data');
  const paths = {
    database: join(dataRoot, 'app.sqlite'),
    media: join(dataRoot, 'media')
  };
  const calls = [];
  const publicPort = await reservePort();
  let internalPort = await reservePort();
  while (internalPort === publicPort) internalPort = await reservePort();
  runMediaCutover({ databasePath: paths.database, mediaRoot: paths.media, repositoryRoot: REPOSITORY_ROOT });
  const restores = [
    restoreEnvironment('NODE_ENV', 'test'),
    restoreEnvironment('NOOBAI_PUBLIC_PORT', String(publicPort)),
    restoreEnvironment('NOOBAI_INTERNAL_PORT', String(internalPort)),
    restoreEnvironment('NOOBAI_TEST_EMPTY_COMFYUI_CATALOG', '1')
  ];
  let application = null;
  try {
    application = await startSemanticFixtureApplication({ repositoryRoot: REPOSITORY_ROOT, paths, calls });
    return Object.freeze({ application, root, paths, calls, restores });
  } catch (error) {
    if (application) await application.close();
    for (const restore of restores.reverse()) restore();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
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

function assertCatalogError(body, code, { allowRequestId = false } = {}) {
  if (allowRequestId) {
    assert.deepEqual(Object.keys(body).sort(), ['error', 'ok', 'request_id']);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, code);
    assert.equal(typeof body.error.message, 'string');
    return;
  }
  assert.deepEqual(Object.keys(body).sort(), ['message', 'page', 'page_size', 'results', 'status', 'total_count']);
  assert.equal(body.status, 'error');
  assert.equal(typeof body.message, 'string', code);
  assert.deepEqual(body.results, []);
  assert.equal(body.page, 1);
  assert.equal(body.page_size, 0);
  assert.equal(body.total_count, 0);
  if (!allowRequestId) assert.equal(Object.hasOwn(body, 'request_id'), false);
}

test('Issue 276 legacy batch requests stay retired while all current Catalog paths remain safe and callable', { concurrency: false }, async () => {
  const fixture = await createRealApplicationFixture();
  try {
    const internalBaseUrl = `http://127.0.0.1:${fixture.application.internalAddress.port}`;
    const publicBaseUrl = `http://127.0.0.1:${fixture.application.publicAddress.port}`;
    const discoveryResponse = await fetch(`${internalBaseUrl}/internal/semantic`);
    assert.equal(discoveryResponse.status, 200);
    const discovery = await discoveryResponse.json();
    assert.deepEqual(Object.keys(discovery.paths), CURRENT_CATALOG_PATHS);
    assert.equal(JSON.stringify(discovery).includes('queries'), false);
    assert.equal(JSON.stringify(discovery).includes('groups'), false);

    const baseSearchResponse = await fetch(`${internalBaseUrl}${BASE_MODEL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'search', query: 'fixture', page: 1, page_size: 20 })
    });
    assert.equal(baseSearchResponse.status, 200);
    const baseSearch = await baseSearchResponse.json();
    assert.equal(baseSearch.status, 'ok');
    assert.deepEqual(baseSearch.results.map((item) => item.id), [801]);
    assert.equal(baseSearch.ok, undefined);

    const modelResolveResponse = await fetch(`${internalBaseUrl}${GENERATION_MODEL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'resolve', id: '802' })
    });
    assert.equal(modelResolveResponse.status, 200);
    const modelResolve = await modelResolveResponse.json();
    assert.equal(modelResolve.status, 'ok');
    assert.equal(modelResolve.results[0].id, 802);
    assert.equal(modelResolve.results[0].file_name, 'fixture-model.safetensors');

    for (const path of CURRENT_CATALOG_PATHS.slice(2)) {
      const internalResponse = await fetch(`${internalBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queries: ['fixture'], limit: 1 })
      });
      assert.equal(internalResponse.status, 422, path);
      assertCatalogError(await internalResponse.json(), 'CATALOG_REQUEST_INVALID');

      const publicResponse = await fetch(`${publicBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'search', query: 'fixture' })
      });
      assert.equal(publicResponse.status, 404, path);
      assertCatalogError(await publicResponse.json(), 'NOT_FOUND', { allowRequestId: true });

    }

    const retiredPath = '/internal/semantic/generation-loras';
    const retiredResponse = await fetch(`${internalBaseUrl}${retiredPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: ['fixture'], limit: 1 })
    });
    assert.equal(retiredResponse.status, 404);
    assertCatalogError(await retiredResponse.json(), 'NOT_FOUND', { allowRequestId: true });
    const retiredCli = await runCli(['--port', String(fixture.application.internalAddress.port), '--path', retiredPath]);
    assert.equal(retiredCli.status, 2);
    assert.equal(retiredCli.signal, null);
    assert.equal(retiredCli.stdout, '');
    assert.match(retiredCli.stderr, /INVALID_ARGUMENT/u);

    for (const [path, body] of [
      [BASE_MODEL_PATH, { mode: 'search', query: 'x'.repeat(201) }],
      [GENERATION_MODEL_PATH, { mode: 'resolve', id: '999' }]
    ]) {
      const response = await fetch(`${internalBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, body.mode === 'resolve' ? 404 : 422);
      assertCatalogError(await response.json(), body.mode === 'resolve' ? 'CATALOG_REF_NOT_FOUND' : 'CATALOG_REQUEST_INVALID');
    }

    for (const path of [BASE_MODEL_PATH, GENERATION_MODEL_PATH]) {
      const publicResponse = await fetch(`${publicBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'search' })
      });
      assert.equal(publicResponse.status, 404, path);
      assertCatalogError(await publicResponse.json(), 'NOT_FOUND', { allowRequestId: true });
    }

    assert.deepEqual(fixture.calls, []);
  } finally {
    await fixture.application.close();
    for (const restore of fixture.restores.reverse()) restore();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
