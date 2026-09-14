import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { createComfyuiSourceService } from '../../app/generation-resources/comfyui-source-service.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSourceDiscovery } from '../../app/http/source-discovery.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';
import { SOURCE_INSTANCE_OPERATION_ID } from '../../app/contracts/source-contract.mjs';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const NOW = '2026-08-22T00:00:00.000Z';

function storedInstance(overrides = {}) {
  return {
    id: 31,
    title: 'Fixture ComfyUI',
    url: 'http://127.0.0.1:8188/',
    credential_type: 'none',
    credential_ciphertext: null,
    is_enabled: 0,
    is_valid: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides
  };
}

function sourceService(row, { decrypt = () => ({}) } = {}) {
  return createComfyuiSourceService({
    repository: { getStored: () => row },
    crypto: { decrypt }
  });
}

test('Issue 283 source discovery publishes only the Host Source instance operation', () => {
  const discovery = buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  assert.equal(discovery.openapi, '3.1.0');
  assert.deepEqual(Object.keys(discovery).sort(), ['components', 'info', 'openapi', 'paths']);
  assert.deepEqual(Object.keys(discovery.paths), [
    '/internal/comfyui-source/instances/{instance_id}',
    '/internal/comfyui-source/templates/{template_id}/bundle'
  ]);
  const operation = discovery.paths['/internal/comfyui-source/instances/{instance_id}'].get;
  assert.equal(operation.operationId, 'getComfyuiInstanceSourceForHost');
  assert.equal(operation['x-harness-tool-name'], undefined);
});

test('Issue 283 source service projects database fields and decrypted authorization without state or time fields', () => {
  assert.deepEqual(sourceService(storedInstance()).getInstanceSource('31'), {
    id: 31,
    title: 'Fixture ComfyUI',
    url: 'http://127.0.0.1:8188/',
    credential_type: 'none',
    authorization: null
  });
  assert.equal(sourceService(storedInstance({ credential_type: 'http_basic', credential_ciphertext: 'basic' }), {
    decrypt: () => ({ type: 'http_basic', username: 'fixture-user', password: 'fixture-pass' })
  }).getInstanceSource('31').authorization, 'Basic Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzcw==');
  assert.equal(sourceService(storedInstance({ credential_type: 'bearer', credential_ciphertext: 'bearer', is_enabled: 0, is_valid: 0 }), {
    decrypt: () => ({ type: 'bearer', token: 'fixture-token' })
  }).getInstanceSource('31').authorization, 'Bearer fixture-token');
  assert.deepEqual(Object.keys(sourceService(storedInstance()).getInstanceSource('31')), [
    'id', 'title', 'url', 'credential_type', 'authorization'
  ]);
  const source = sourceService(storedInstance());
  const assembledService = { [SOURCE_INSTANCE_OPERATION_ID]: source[SOURCE_INSTANCE_OPERATION_ID] };
  assert.equal(assembledService[SOURCE_INSTANCE_OPERATION_ID]('31').id, 31);
});

test('Issue 283 Source HTTP wraps one instance result in the shared response envelope', async () => {
  const source = sourceService(storedInstance());
  const dispatcher = createCatalogHttpDispatcher({
    service: {
      getComfyuiSourceDiscovery: () => buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT }),
      getComfyuiInstanceSourceForHost: source.getInstanceSource,
      getComfyuiTemplateBundleForHost: () => null
    },
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    sourceDiscovery: buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT })
  });
  const response = await dispatcher.dispatch({ listener: 'internal', method: 'GET', url: '/internal/comfyui-source/instances/31' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: 'ok',
    message: null,
    results: [{
      id: 31,
      title: 'Fixture ComfyUI',
      url: 'http://127.0.0.1:8188/',
      credential_type: 'none',
      authorization: null
    }],
    page: 1,
    page_size: 1,
    total_count: 1
  });
});

test('Issue 283 source HTTP maps invalid IDs, missing instances, and unavailable credentials without secret leakage', async () => {
  const source = sourceService(storedInstance({ credential_type: 'bearer', credential_ciphertext: 'broken' }), { decrypt: () => { throw new Error('fixture secret should not leak'); } });
  const service = {
    getComfyuiSourceDiscovery: () => buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT }),
    getComfyuiInstanceSourceForHost: source.getInstanceSource,
    getComfyuiTemplateBundleForHost: () => null
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    runtimeOperations: undefined,
    sourceDiscovery: buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT })
  });
  const invalid = await dispatcher.dispatch({ listener: 'internal', method: 'GET', url: '/internal/comfyui-source/instances/0' });
  assert.deepEqual(invalid.body, {
    status: 'error',
    message: 'Source request is invalid.',
    results: [],
    page: 1,
    page_size: 0,
    total_count: 0
  });
  const empty = await dispatcher.dispatch({ listener: 'internal', method: 'GET', url: '/internal/comfyui-source/instances/' });
  assert.deepEqual(empty.body, {
    status: 'error',
    message: 'Source request is invalid.',
    results: [],
    page: 1,
    page_size: 0,
    total_count: 0
  });
  const unavailable = await dispatcher.dispatch({ listener: 'internal', method: 'GET', url: '/internal/comfyui-source/instances/31' });
  assert.deepEqual(unavailable.body, {
    status: 'error',
    message: 'ComfyUI authorization is unavailable.',
    results: [],
    page: 1,
    page_size: 0,
    total_count: 0
  });
  assert.equal(JSON.stringify(unavailable.body).includes('fixture secret'), false);

  const missingService = sourceService(null);
  const missingDispatcher = createCatalogHttpDispatcher({
    service: {
      getComfyuiSourceDiscovery: () => buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT }),
      getComfyuiInstanceSourceForHost: missingService.getInstanceSource,
      getComfyuiTemplateBundleForHost: () => null
    },
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    sourceDiscovery: buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT })
  });
  const missing = await missingDispatcher.dispatch({ listener: 'internal', method: 'GET', url: '/internal/comfyui-source/instances/31' });
  assert.deepEqual(missing.body, {
    status: 'error',
    message: 'ComfyUI instance was not found.',
    results: [],
    page: 1,
    page_size: 0,
    total_count: 0
  });
});

test('Issue 283 source service directly rejects non-string IDs, malformed rows, busy reads, and failed reads', () => {
  assert.throws(
    () => sourceService(storedInstance()).getInstanceSource(31),
    (error) => error?.code === 'SOURCE_REQUEST_INVALID'
  );
  for (const row of [
    storedInstance({ id: 0 }),
    storedInstance({ title: 31 }),
    storedInstance({ title: '' }),
    storedInstance({ title: 'x'.repeat(301) })
  ]) {
    assert.throws(
      () => sourceService(row).getInstanceSource('31'),
      (error) => error?.code === 'SOURCE_INTERNAL_ERROR'
    );
  }

  const busy = createComfyuiSourceService({
    repository: {
      getStored() {
        throw Object.assign(new Error('database is busy'), { code: 'SQLITE_BUSY' });
      }
    },
    crypto: { decrypt() {} }
  });
  assert.throws(() => busy.getInstanceSource('31'), (error) => error?.code === 'SOURCE_DATABASE_BUSY');

  const failed = createComfyuiSourceService({
    repository: { getStored() { throw new Error('fixture read failure'); } },
    crypto: { decrypt() {} }
  });
  assert.throws(() => failed.getInstanceSource('31'), (error) => error?.code === 'SOURCE_INTERNAL_ERROR');
});
