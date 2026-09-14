import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { startLocalApplication } from '../../app/server/local-app.mjs';
import { FAKE_VECTOR_CONFIGURATION } from '../fixtures/vector/fake-semantic-model-client.mjs';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const BASE_MODEL_PATH = '/internal/semantic/base-models';
const GENERATION_MODEL_PATH = '/internal/semantic/generation-models';
const CATALOG_ERROR = { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 };

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

async function createLocalFixture({ vectorModelClient, onInternalRequest = undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-278-catalog-http-boundary-'));
  const dataRoot = join(root, 'data');
  const paths = Object.freeze({
    dataRoot,
    databasePath: join(dataRoot, 'app.sqlite'),
    mediaRoot: join(dataRoot, 'media')
  });
  const publicPort = await reservePort();
  let internalPort = await reservePort();
  while (internalPort === publicPort) internalPort = await reservePort();
  const restores = [
    restoreEnvironment('NODE_ENV', 'test'),
    restoreEnvironment('NOOBAI_PUBLIC_PORT', String(publicPort)),
    restoreEnvironment('NOOBAI_INTERNAL_PORT', String(internalPort)),
    restoreEnvironment('NOOBAI_TEST_EMPTY_COMFYUI_CATALOG', '1')
  ];
  let application = null;
  try {
    await mkdir(join(paths.dataRoot, 'media'), { recursive: true });
    runMediaCutover({ databasePath: paths.databasePath, mediaRoot: paths.mediaRoot, repositoryRoot: REPOSITORY_ROOT });

    const database = openCatalogDatabase({
      databasePath: paths.databasePath,
      mediaRoot: paths.mediaRoot,
      repositoryRoot: REPOSITORY_ROOT,
      includeBuiltinComfyuiCatalog: false
    });
    try {
      const now = '2026-08-22T00:00:00.000Z';
      database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(901, 'Fixture WAI', now, now);
      database.prepare(`INSERT INTO generation_models(
        id, base_model_id, file_name, file_format, precision_or_quantization,
        author, version, description, usage, skill_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(902, 901, 'fixture-model.safetensors', 'safetensors', 'fp16', 'Fixture Author', 'v1', 'fixture description', 'fixture usage', 'fixture.skill', now, now);
    } finally {
      database.close();
    }

    application = await startLocalApplication({
      repositoryRoot: REPOSITORY_ROOT,
      dataPaths: paths,
      listenerMode: 'internal-only',
      vectorConfiguration: FAKE_VECTOR_CONFIGURATION,
      vectorModelClient,
      authorizeWrite: () => false,
      onStarted: () => {},
      onInternalRequest
    });
    return Object.freeze({ root, application, restores });
  } catch (error) {
    if (application) await application.close();
    for (const restore of restores.reverse()) restore();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeLocalFixture(fixture) {
  await fixture.application.close();
  for (const restore of fixture.restores.reverse()) restore();
  await rm(fixture.root, { recursive: true, force: true });
}

async function postRaw(baseUrl, path, rawBody) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

function failFastModelClient(calls) {
  return Object.freeze({
    async embed() {
      calls.push('embed');
      throw new Error('Catalog base/model operations must not call embed');
    },
    async rerank() {
      calls.push('rerank');
      throw new Error('Catalog base/model operations must not call rerank');
    }
  });
}

test('Issue 278 startLocalApplication rejects duplicate JSON keys before Catalog service dispatch on both paths', { concurrency: false }, async () => {
  const observedRequests = [];
  const modelCalls = [];
  const fixture = await createLocalFixture({
    vectorModelClient: failFastModelClient(modelCalls),
    onInternalRequest: (request) => observedRequests.push(request)
  });
  try {
    const baseUrl = `http://127.0.0.1:${fixture.application.internalAddress.port}`;
    const duplicateBodies = [
      '{"mode":"search","mode":"resolve","id":"901"}',
      '{"mode":"search","nested":{"query":"one","query":"two"}}',
      '{"mode":"search","nested":[{"query":"one","query":"two"}]}',
      '{"mode":"search","mo\\u0064e":"resolve","id":"901"}'
    ];
    for (const path of [BASE_MODEL_PATH, GENERATION_MODEL_PATH]) {
      for (const rawBody of duplicateBodies) {
        const response = await postRaw(baseUrl, path, rawBody);
        assert.equal(response.status, 422, `${path}: ${rawBody}`);
        assert.deepEqual(response.body, CATALOG_ERROR, `${path}: ${rawBody}`);
      }
    }
    assert.deepEqual(observedRequests, []);
    assert.deepEqual(modelCalls, []);

    for (const [path, rawBody] of [
      [BASE_MODEL_PATH, '{"mo\\u0064e":"search","q\\u0075ery":"Fixture WAI","page":1,"page\\u005fsize":20}'],
      [GENERATION_MODEL_PATH, '{"mo\\u0064e":"search","q\\u0075ery":"fixture","page":1,"page\\u005fsize":20}']
    ]) {
      const response = await postRaw(baseUrl, path, rawBody);
      assert.equal(response.status, 200, `${path}: escaped-key JSON should remain valid`);
      assert.equal(response.body.status, 'ok');
    }
    assert.equal(observedRequests.length, 2);
    assert.deepEqual(modelCalls, []);
  } finally {
    await closeLocalFixture(fixture);
  }
});

test('Issue 278 startLocalApplication Catalog search and resolve never call embedding or reranking models', { concurrency: false }, async () => {
  const modelCalls = [];
  const fixture = await createLocalFixture({ vectorModelClient: failFastModelClient(modelCalls) });
  try {
    const baseUrl = `http://127.0.0.1:${fixture.application.internalAddress.port}`;
    const cases = [
      [BASE_MODEL_PATH, { mode: 'search', query: 'Fixture', page: 1, page_size: 20 }, 'base-model'],
      [BASE_MODEL_PATH, { mode: 'search', page: 1, page_size: 20 }, 'base-model'],
      [BASE_MODEL_PATH, { mode: 'search', query: '', page: 1, page_size: 20 }, 'base-model'],
      [BASE_MODEL_PATH, { mode: 'search', query: '   ', page: 1, page_size: 20 }, 'base-model'],
      [BASE_MODEL_PATH, { mode: 'resolve', id: '901' }, 'base-model'],
      [GENERATION_MODEL_PATH, { mode: 'search', query: 'fixture', page: 1, page_size: 20 }, 'model'],
      [GENERATION_MODEL_PATH, { mode: 'search', page: 1, page_size: 20 }, 'model'],
      [GENERATION_MODEL_PATH, { mode: 'search', query: '', page: 1, page_size: 20 }, 'model'],
      [GENERATION_MODEL_PATH, { mode: 'search', query: '   ', page: 1, page_size: 20 }, 'model'],
      [GENERATION_MODEL_PATH, { mode: 'resolve', id: '902' }, 'model']
    ];
    for (const [path, body] of cases) {
      const response = await postRaw(baseUrl, path, JSON.stringify(body));
      assert.equal(response.status, 200, `${path} ${JSON.stringify(body)}`);
      assert.equal(response.body.status, 'ok');
    }
    assert.deepEqual(modelCalls, []);
  } finally {
    await closeLocalFixture(fixture);
  }
});
