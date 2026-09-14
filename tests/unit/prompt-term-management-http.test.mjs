import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

test('OpenAPI declares Prompt Tag management CRUD and list filters', () => {
  const openapi = parseDocument(readFileSync(resolve(ROOT, 'schema/api/openapi.yaml'), 'utf8'), { strict: true }).toJS({ mapAsMap: false });
  const collection = openapi.paths['/api/manage/prompt-terms'];
  const item = openapi.paths['/api/manage/prompt-terms/{id}'];
  assert.equal(collection.get.operationId, 'listPromptTerms');
  assert.equal(collection.post.operationId, 'createPromptTerm');
  assert.equal(item.get.operationId, 'getPromptTerm');
  assert.equal(item.put.operationId, 'updatePromptTerm');
  assert.equal(item.delete.operationId, 'deletePromptTerm');
  assert.deepEqual(collection.get.parameters.map(({ name, $ref }) => name ?? openapi.components.parameters[$ref.split('/').at(-1)].name), ['page', 'page_size', 'q', 'category', 'post_count_min', 'post_count_max']);
});

test('Prompt Tag management HTTP parses filters, validates identifiers and exposes CRUD methods', async () => {
  const calls = [];
  const service = {
    listPromptTerms(query) { calls.push(['list', query]); return { items: [], page: query.page ?? 1, page_size: query.page_size ?? 16, total_count: 0 }; },
    createPromptTerm(body) { calls.push(['create', body]); return { id: 1, ...body }; },
    getPromptTerm(id) { calls.push(['get', id]); return { id, canonical_tag: 'one', category: 0, aliases_json: [], post_count: 1 }; },
    updatePromptTerm(id, body) { calls.push(['update', id, body]); return { id, ...body }; },
    deletePromptTerm(id) { calls.push(['delete', id]); return { target: { id, canonical_tag: 'one' } }; }
  };
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper(ROOT), authorizeWrite: () => true });

  const listed = await dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/manage/prompt-terms?page=2&page_size=16&q=blue&category=0&post_count_min=10&post_count_max=20', requestId: 'list-prompt-terms' });
  assert.equal(listed.status, 200);
  assert.deepEqual(calls[0], ['list', { page: 2, page_size: 16, q: 'blue', category: 0, post_count_min: 10, post_count_max: 20 }]);

  const write = { canonical_tag: 'one', category: 0, aliases_json: ['single'], post_count: 1 };
  assert.equal((await dispatcher.dispatch({ listener: 'public', method: 'POST', url: '/api/manage/prompt-terms', body: write, requestId: 'create-prompt-term' })).status, 201);
  assert.equal((await dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/manage/prompt-terms/1', requestId: 'get-prompt-term' })).status, 200);
  assert.equal((await dispatcher.dispatch({ listener: 'public', method: 'PUT', url: '/api/manage/prompt-terms/1', body: write, requestId: 'update-prompt-term' })).status, 200);
  assert.equal((await dispatcher.dispatch({ listener: 'public', method: 'DELETE', url: '/api/manage/prompt-terms/1', requestId: 'delete-prompt-term' })).status, 200);

  for (const url of ['/api/manage/prompt-terms?category=2', '/api/manage/prompt-terms?post_count_min=20&post_count_max=10', '/api/manage/prompt-terms/not-an-id']) {
    const invalid = await dispatcher.dispatch({ listener: 'public', method: 'GET', url, requestId: 'invalid-prompt-term' });
    assert.equal(invalid.status, 422, url);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR', url);
  }
});
