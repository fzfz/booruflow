import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const root = resolve(import.meta.dirname, '../..');
const openapi = parseDocument(readFileSync(resolve(root, 'schema/api/openapi.yaml'), 'utf8'), { strict: true }).toJS();
const basePath = '/internal/semantic/base-models';

function page() {
  return { status: 'ok', message: null, results: [], page: 1, page_size: 20, total_count: 0 };
}

test('Issue #212 keeps the legacy Style Pi projection removed while exposing the Harness Catalog operation', () => {
  const styleOperation = openapi.paths['/internal/semantic/styles']?.post;
  assert.equal(styleOperation?.operationId, 'querySemanticStylesForSkill');
  assert.equal(styleOperation?.['x-harness-tool-name'], 'query_semantic_styles');
  assert.equal(styleOperation?.['x-noobai-pi-tool-name'], undefined);
  assert.equal(styleOperation?.['x-noobai-callable-projection'], undefined);
  const internalCatalogOperations = Object.values(openapi.paths)
    .flatMap((pathItem) => Object.values(pathItem))
    .filter((operation) => typeof operation === 'object' && typeof operation.operationId === 'string' && operation.operationId.startsWith('querySemantic'));
  assert.deepEqual(internalCatalogOperations.map(({ operationId }) => operationId), [
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
  ]);
  for (const operation of internalCatalogOperations) {
    assert.equal(operation['x-noobai-pi-tool-name'], undefined, operation.operationId);
    assert.equal(operation['x-noobai-callable-projection'], undefined, operation.operationId);
    assert.equal(typeof operation['x-harness-tool-name'], 'string', operation.operationId);
  }
});

test('Issue #212 internal HTTP rejects the removed Style request and returns direct CatalogPage for the current replacement', async () => {
  const dispatcher = createCatalogHttpDispatcher({
    service: {
      querySemanticBaseModelsForSkill: () => page(),
      querySemanticStylesForSkill: () => page()
    },
    errorMapper: createErrorMapper(root),
    semanticDiscovery: buildSemanticDiscovery({ repositoryRoot: root })
  });
  const removed = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: '/internal/semantic/styles', body: { base_model_name: 'WAI', queries: ['watercolor'], limit: 1 } });
  assert.equal(removed.status, 422);
  assert.deepEqual(removed.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
  const current = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: basePath, body: { mode: 'search' } });
  assert.equal(current.status, 200);
  assert.deepEqual(current.body, page());
  assert.equal(current.body.ok, undefined);
  assert.equal(current.body.data, undefined);
});
