import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

test('OpenAPI declares catalog management create and update operations', () => {
  const openapi = parseDocument(readFileSync(resolve(ROOT, 'schema/api/openapi.yaml'), 'utf8'), { strict: true }).toJS({ mapAsMap: false });
  assert.equal(openapi.paths['/api/manage/items/{kind}'].post.operationId, 'createManageItem');
  assert.equal(openapi.paths['/api/manage/items/{kind}/{item_id}'].put.operationId, 'updateManageItem');
});

test('catalog management HTTP validates kind-specific writes and identifiers', async () => {
  const calls = [];
  const service = {
    createManageItem(kind, input) { calls.push(['create', kind, input]); return { kind, id: 1, ...input, cover_media_path: null }; },
    updateManageItem(kind, id, input) { calls.push(['update', kind, id, input]); return { kind, id, ...input, cover_media_path: null }; }
  };
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper(ROOT), authorizeWrite: () => true });
  const work = { name: '星海旅人', category_name: null, aliases_json: ['星海'], is_available: true };
  const created = await dispatcher.dispatch({ listener: 'public', method: 'POST', url: '/api/manage/items/work', body: work, requestId: 'create-work' });
  const updated = await dispatcher.dispatch({ listener: 'public', method: 'PUT', url: '/api/manage/items/work/1', body: work, requestId: 'update-work' });
  assert.equal(created.status, 201);
  assert.equal(updated.status, 200);
  assert.deepEqual(calls, [['create', 'work', work], ['update', 'work', 1, work]]);

  for (const request of [
    { method: 'POST', url: '/api/manage/items/nope', body: work },
    { method: 'PUT', url: '/api/manage/items/work/nope', body: work },
    { method: 'POST', url: '/api/manage/items/work', body: { ...work, unknown: true } }
  ]) {
    const response = await dispatcher.dispatch({ listener: 'public', ...request, requestId: 'invalid-catalog-write' });
    assert.equal(response.status, 422, request.url);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR', request.url);
  }
});
