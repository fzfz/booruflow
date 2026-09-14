import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const BASE_MODEL_PATH = '/internal/semantic/base-models';

function emptyPage() {
  return {
    contract_id: 'imagegen-source-contract',
    contract_version: 1,
    kind: 'base-model',
    items: [],
    page: 1,
    page_size: 20,
    total_count: 0
  };
}

function dispatcherFor(service) {
  return createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(repositoryRoot),
    semanticDiscovery: buildSemanticDiscovery({ repositoryRoot })
  });
}

test('Issue #177 replaces the legacy multi-query route with a closed CatalogPage request', async () => {
  const requests = [];
  const page = emptyPage();
  const dispatcher = dispatcherFor({
    querySemanticBaseModelsForSkill(request) {
      requests.push(request);
      return page;
    }
  });

  const legacyRoute = await dispatcher.dispatch({
    listener: 'internal',
    method: 'POST',
    url: '/internal/semantic/works',
    body: { queries: ['雨夜'], limit: 2 }
  });
  assert.equal(legacyRoute.status, 404);
  assert.deepEqual(requests, []);

  const legacyBody = await dispatcher.dispatch({
    listener: 'internal',
    method: 'POST',
    url: BASE_MODEL_PATH,
    body: { queries: ['雨夜'], limit: 2 }
  });
  assert.equal(legacyBody.status, 422);
  assert.deepEqual(legacyBody.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  assert.deepEqual(requests, []);

  const current = await dispatcher.dispatch({
    listener: 'internal',
    method: 'POST',
    url: BASE_MODEL_PATH,
    body: { mode: 'search' }
  });
  assert.equal(current.status, 200);
  assert.deepEqual(current.body, page);
  assert.deepEqual(requests, [{ mode: 'search', query: '', page: 1, page_size: 20 }]);
  assert.equal(current.body.ok, undefined);
  assert.equal(current.body.data, undefined);
});

test('Issue #177 rejects legacy extensions and fields without invoking a Catalog service', async () => {
  let calls = 0;
  const dispatcher = dispatcherFor({
    querySemanticBaseModelsForSkill() {
      calls += 1;
      return emptyPage();
    }
  });
  for (const body of [
    { mode: 'search', request_id: 'legacy' },
    { mode: 'search', unknown: 'legacy' },
    { mode: 'search', queries: ['legacy'] },
    { mode: 'resolve', id: '1', limit: 1 }
  ]) {
    const response = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: BASE_MODEL_PATH, body });
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.deepEqual(response.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  }
  assert.equal(calls, 0);
});
