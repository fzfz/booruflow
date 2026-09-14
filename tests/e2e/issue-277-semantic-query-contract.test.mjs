import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { startLocalApplication } from '../../app/server/local-app.mjs';
import { FAKE_VECTOR_CONFIGURATION, createFakeSemanticModelClient } from '../fixtures/vector/fake-semantic-model-client.mjs';

const runProcess = promisify(execFile);
const CLI_PATH = new URL('../../scripts/imagegen-semantic-query.mjs', import.meta.url).pathname;
const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const TEST_PORTS = Object.freeze({ public: 19892, internal: 19893 });
const BASE_MODEL_PATH = '/internal/semantic/base-models';
const GENERATION_MODEL_PATH = '/internal/semantic/generation-models';
const RETIRED_OPERATION_PATHS = Object.freeze(['/internal/semantic/generation-loras']);

function operation(discovery, operationId) {
  for (const [path, pathItem] of Object.entries(discovery.paths)) {
    for (const [method, candidate] of Object.entries(pathItem)) {
      if (candidate.operationId === operationId) return { path, method, operation: candidate };
    }
  }
  return null;
}

function restoreEnvironment(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

function createCountingModelClient() {
  const delegate = createFakeSemanticModelClient();
  const calls = { embed: 0, rerank: 0 };
  return {
    calls,
    async embed(inputs) {
      calls.embed += 1;
      return delegate.embed(inputs);
    },
    async rerank(query, documents) {
      calls.rerank += 1;
      return delegate.rerank(query, documents);
    }
  };
}

async function startSemanticFixtureApplication({ repositoryRoot, paths }) {
  const database = openCatalogDatabase({ databasePath: paths.database, mediaRoot: paths.media, repositoryRoot, includeBuiltinComfyuiCatalog: false });
  const now = '2026-08-22T00:00:00.000Z';
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(801, 'Fixture WAI', now, now);
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(802, 801, 'fixture-model.safetensors', 'safetensors', 'fp16', 'fixture model', 'fixture usage', now, now);
  database.close();
  const modelClient = createCountingModelClient();
  const application = await startLocalApplication({
    repositoryRoot,
    dataPaths: { dataRoot: dirname(paths.database), databasePath: paths.database, mediaRoot: paths.media },
    listenerMode: 'all',
    vectorConfiguration: FAKE_VECTOR_CONFIGURATION,
    vectorModelClient: modelClient,
    authorizeWrite: () => false,
    onStarted: () => {}
  });
  return { application, modelClient };
}

async function createRealApplicationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-277-semantic-e2e-'));
  const dataRoot = join(root, 'data');
  const paths = {
    database: join(dataRoot, 'app.sqlite'),
    media: join(dataRoot, 'media')
  };
  runMediaCutover({ databasePath: paths.database, mediaRoot: paths.media, repositoryRoot: REPOSITORY_ROOT });
  const restore = [
    restoreEnvironment('NODE_ENV', 'test'),
    restoreEnvironment('NOOBAI_TEST_EMPTY_COMFYUI_CATALOG', '1'),
    restoreEnvironment('NOOBAI_PUBLIC_PORT', String(TEST_PORTS.public)),
    restoreEnvironment('NOOBAI_INTERNAL_PORT', String(TEST_PORTS.internal))
  ];
  let application;
  try {
    const started = await startSemanticFixtureApplication({ repositoryRoot: REPOSITORY_ROOT, paths });
    return { ...started, root, restore };
  } catch (error) {
    for (const restoreEnvironmentValue of restore.reverse()) restoreEnvironmentValue();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function assertCatalogPage(body, { id, expectedData, page, pageSize }) {
  assert.deepEqual(Object.keys(body).sort(), ['message', 'page', 'page_size', 'results', 'status', 'total_count']);
  assert.equal(body.status, 'ok');
  assert.equal(body.message, null);
  assert.equal(body.page, page);
  assert.equal(body.page_size, pageSize);
  assert.equal(body.total_count, 1);
  assert.equal(body.ok, undefined);
  assert.equal(body.data, undefined);
  assert.equal(body.results.length, 1);
  const item = body.results[0];
  assert.equal(item.id, Number(id));
  for (const [name, value] of Object.entries(expectedData)) assert.deepEqual(item[name], typeof value === 'string' && /^\d+$/u.test(value) && name.endsWith('_id') ? Number(value) : value);
  return item;
}

test('Issue 278 Catalog contract is proven through real listeners and CLI processes', { concurrency: false }, async () => {
  const fixture = await createRealApplicationFixture();
  try {
    const internalBaseUrl = `http://127.0.0.1:${fixture.application.internalAddress.port}`;
    const publicBaseUrl = `http://127.0.0.1:${fixture.application.publicAddress.port}`;
    const discoveryResponse = await fetch(`${internalBaseUrl}/internal/semantic`);
    assert.equal(discoveryResponse.status, 200);
    const discovery = await discoveryResponse.json();
    assert.equal(discovery.openapi, '3.1.0');
    const expectedOperationIds = [
      'querySemanticBaseModelsForSkill',
      'querySemanticGenerationModelsForSkill',
      'querySemanticLorasForSkill',
      'querySemanticWorksForSkill',
      'querySemanticCharactersForSkill',
      'querySemanticStylesForSkill',
      'querySemanticPromptTermsForSkill',
      'querySemanticArtistPromptStringsForSkill',
      'querySemanticComfyuiInstancesForSkill',
      'querySemanticComfyuiTemplatesForSkill'
    ];
    assert.deepEqual(
      Object.values(discovery.paths).flatMap((pathItem) => Object.values(pathItem).map(({ operationId }) => operationId)),
      expectedOperationIds
    );

    const selectedOperations = [
      {
        selected: operation(discovery, 'querySemanticBaseModelsForSkill'),
        path: BASE_MODEL_PATH,
        kind: 'base-model',
        id: '801',
        searchBody: { mode: 'search', query: 'fixture', page: 1, page_size: 20 },
        searchArgs: ['--mode', 'search', '--query', 'fixture', '--page', '1', '--page_size', '20'],
        expectedData: { name: 'Fixture WAI' },
        resultContractId: 'imagegen.catalog.base-model.v1'
      },
      {
        selected: operation(discovery, 'querySemanticGenerationModelsForSkill'),
        path: GENERATION_MODEL_PATH,
        kind: 'model',
        id: '802',
        searchBody: { mode: 'search', query: 'fixture', page: 1, page_size: 20, base_model_id: '801' },
        searchArgs: ['--mode', 'search', '--query', 'fixture', '--page', '1', '--page_size', '20', '--base_model_id', '801'],
        expectedData: {
          base_model_id: '801',
          file_name: 'fixture-model.safetensors',
          file_format: 'safetensors',
          precision_or_quantization: 'fp16',
          author: null,
          version: null,
          description: 'fixture model',
          usage: 'fixture usage',
          skill_name: null
        },
        resultContractId: 'imagegen.catalog.generation-model.v1'
      }
    ];
    const searchPages = new Map();
    for (const details of selectedOperations) {
      assert.ok(details.selected);
      assert.equal(details.selected.path, details.path);
      assert.equal(details.selected.method, 'post');
      const response = await fetch(`${internalBaseUrl}${details.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(details.searchBody)
      });
      assert.equal(response.status, 200, details.selected.operation.operationId);
      const body = await response.json();
      const item = assertCatalogPage(body, { ...details, page: 1, pageSize: 20 });
      assert.equal(body.total_count, 1, details.selected.operation.operationId);
      searchPages.set(details.path, body);

      const publicResponse = await fetch(`${publicBaseUrl}${details.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(details.searchBody)
      });
      assert.equal(publicResponse.status, 404, details.selected.operation.operationId);
    }

    assert.equal((await fetch(`${publicBaseUrl}/internal/semantic`)).status, 404);
    for (const retiredPath of RETIRED_OPERATION_PATHS) {
      assert.equal(discovery.paths[retiredPath], undefined, retiredPath);
      assert.equal((await fetch(`${internalBaseUrl}${retiredPath}`, { method: 'POST' })).status, 404, retiredPath);
    }

    for (const details of selectedOperations) {
      const cli = await runProcess(process.execPath, [
        CLI_PATH,
        '--port', String(fixture.application.internalAddress.port),
        '--path', details.path,
        ...details.searchArgs
      ]);
      assert.equal(cli.stderr, '', details.selected.operation.operationId);
      const result = JSON.parse(cli.stdout);
      assert.equal(cli.stdout, JSON.stringify(result), details.selected.operation.operationId);
      assert.deepEqual(result, searchPages.get(details.path), details.selected.operation.operationId);
    }

    for (const details of selectedOperations) {
      const resolveBody = { mode: 'resolve', id: details.id };
      const response = await fetch(`${internalBaseUrl}${details.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(resolveBody)
      });
      assert.equal(response.status, 200, details.selected.operation.operationId);
      const resolved = await response.json();
      assertCatalogPage(resolved, { ...details, page: 1, pageSize: 1 });

      const cli = await runProcess(process.execPath, [
        CLI_PATH,
        '--port', String(fixture.application.internalAddress.port),
        '--path', details.path,
        '--mode', 'resolve',
        '--id', details.id
      ]);
      assert.equal(cli.stderr, '', details.selected.operation.operationId);
      assert.deepEqual(JSON.parse(cli.stdout), resolved, details.selected.operation.operationId);

      const publicResponse = await fetch(`${publicBaseUrl}${details.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(resolveBody)
      });
      assert.equal(publicResponse.status, 404, details.selected.operation.operationId);
    }

    for (const details of selectedOperations) {
      const response = await fetch(`${internalBaseUrl}${details.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'resolve', id: '999' })
      });
      assert.equal(response.status, 404, details.selected.operation.operationId);
      assert.deepEqual(await response.json(), { status: 'error', message: 'Catalog record was not found.', results: [], page: 1, page_size: 0, total_count: 0 });

      let cliError;
      try {
        await runProcess(process.execPath, [
          CLI_PATH,
          '--port', String(fixture.application.internalAddress.port),
          '--path', details.path,
          '--mode', 'resolve',
          '--id', '999'
        ]);
        assert.fail(`${details.selected.operation.operationId} invalid id must fail`);
      } catch (error) {
        cliError = error;
      }
      assert.equal(cliError.code, 7, details.selected.operation.operationId);
      assert.equal(cliError.stdout, '', details.selected.operation.operationId);
      const expectedError = {
        status: 'error', message: 'Catalog record was not found.', results: [], page: 1, page_size: 0, total_count: 0
      };
      assert.equal(cliError.stderr, JSON.stringify(expectedError), details.selected.operation.operationId);
      assert.deepEqual(JSON.parse(cliError.stderr), expectedError, details.selected.operation.operationId);
    }

    const invalidParentResponse = await fetch(`${internalBaseUrl}${GENERATION_MODEL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'search', query: 'fixture', page: 1, page_size: 20, base_model_id: '999' })
    });
    assert.equal(invalidParentResponse.status, 422);
    const expectedInvalidParentError = { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 };
    assert.deepEqual(await invalidParentResponse.json(), expectedInvalidParentError);

    let invalidParentCliError;
    try {
      await runProcess(process.execPath, [
        CLI_PATH,
        '--port', String(fixture.application.internalAddress.port),
        '--path', GENERATION_MODEL_PATH,
        '--mode', 'search',
        '--query', 'fixture',
        '--page', '1',
        '--page_size', '20',
        '--base_model_id', '999'
      ]);
      assert.fail('generation-model search with an unknown base_model_id must fail');
    } catch (error) {
      invalidParentCliError = error;
    }
    assert.equal(invalidParentCliError.code, 7);
    assert.equal(invalidParentCliError.stdout, '');
    assert.equal(invalidParentCliError.stderr, JSON.stringify(expectedInvalidParentError));
    assert.deepEqual(JSON.parse(invalidParentCliError.stderr), expectedInvalidParentError);

    assert.deepEqual(fixture.modelClient.calls, { embed: 0, rerank: 0 });
  } finally {
    await fixture.application.close();
    for (const restoreEnvironmentValue of fixture.restore.reverse()) restoreEnvironmentValue();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
