import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { createCatalogHttpDispatcher, startCatalogHttpListeners } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const BASE_MODEL_PATH = '/internal/semantic/base-models';
const GENERATION_MODEL_PATH = '/internal/semantic/generation-models';
const CATALOG_ERROR = {
  status: 'error',
  message: 'Catalog request is invalid.',
  results: [],
  page: 1,
  page_size: 0,
  total_count: 0
};

async function postRaw(baseUrl, path, rawBody) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

function catalogPage(kind, item) {
  return {
    status: 'ok',
    message: null,
    results: [item],
    page: 1,
    page_size: 20,
    total_count: 1
  };
}

test('Issue 278 alternate Catalog listener rejects duplicate JSON keys and accepts escaped JSON keys for both Catalog paths', { concurrency: false }, async () => {
  const service = {
    querySemanticBaseModelsForSkill: () => catalogPage('base-model', { id: '901' }),
    querySemanticGenerationModelsForSkill: () => catalogPage('model', { id: '902' })
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT })
  });
  const listeners = await startCatalogHttpListeners({
    dispatcher,
    config: { listeners: { public: { host: '127.0.0.1', port: 0 }, internal: { host: '127.0.0.1', port: 0 } } }
  });
  try {
    const baseUrl = `http://127.0.0.1:${listeners.internalAddress.port}`;
    for (const path of [BASE_MODEL_PATH, GENERATION_MODEL_PATH]) {
      const duplicate = await postRaw(baseUrl, path, '{"mode":"search","mode":"resolve","id":"901"}');
      assert.equal(duplicate.status, 422, path);
      assert.deepEqual(duplicate.body, CATALOG_ERROR, path);
      const escaped = await postRaw(baseUrl, path, '{"mo\\u0064e":"search","q\\u0075ery":"fixture"}');
      assert.equal(escaped.status, 200, path);
    }
  } finally {
    await listeners.close();
  }
});
