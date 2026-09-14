import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

import { loadConfig } from '../../app/config/load-config.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { PROMPT_TERM_CATEGORIES } from '../../app/prompt-terms/prompt-term-categories.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

test('OpenAPI declares configurable file attributes and both read-only management option operations', () => {
  const openapi = parseDocument(readFileSync(resolve(ROOT, 'schema/api/openapi.yaml'), 'utf8'), { strict: true }).toJS({ mapAsMap: false });
  for (const name of ['FileFormat', 'Precision']) {
    assert.deepEqual(openapi.components.schemas[name], {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001F\\u007F]+$'
    });
  }
  assert.equal(openapi.paths['/api/manage/generation-resource-options'].get.operationId, 'getGenerationResourceOptions');
  assert.equal(openapi.paths['/api/manage/prompt-term-options'].get.operationId, 'getPromptTermOptions');
});

test('management option endpoints return their process sources and reject query parameters or write methods', async () => {
  const config = loadConfig({ environment: {} });
  const service = {
    getGenerationResourceOptions: () => config.generation_resources,
    getPromptTermOptions: () => ({ categories: PROMPT_TERM_CATEGORIES })
  };
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper(ROOT) });

  const generation = await dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/manage/generation-resource-options', requestId: 'generation-options' });
  assert.equal(generation.status, 200);
  assert.deepEqual(generation.body.data, config.generation_resources);
  const prompt = await dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/manage/prompt-term-options', requestId: 'prompt-options' });
  assert.equal(prompt.status, 200);
  assert.deepEqual(prompt.body.data.categories, PROMPT_TERM_CATEGORIES);

  for (const url of ['/api/manage/generation-resource-options?unexpected=1', '/api/manage/prompt-term-options?unexpected=1']) {
    const invalid = await dispatcher.dispatch({ listener: 'public', method: 'GET', url, requestId: 'invalid-options' });
    assert.equal(invalid.status, 422, url);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR', url);
  }
  for (const url of ['/api/manage/generation-resource-options', '/api/manage/prompt-term-options']) {
    const write = await dispatcher.dispatch({ listener: 'public', method: 'POST', url, body: {}, requestId: 'write-options' });
    assert.equal(write.status, 404, url);
  }
});
