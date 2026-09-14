import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);
const openapi = parseDocument(readFileSync(resolve(repositoryRoot, 'schema/api/openapi.yaml'), 'utf8'), { strict: true }).toJS({ mapAsMap: false });
const errorCatalog = JSON.parse(readFileSync(resolve(repositoryRoot, 'schema/api/error-catalog.json'), 'utf8'));

const EXPECTED = Object.freeze({
  500: Object.freeze({ response: 'ManagementWriteInternal', schema: 'E500ManagementWrite', codes: ['MODEL_PROTOCOL_ERROR', 'INTERNAL_ERROR'] }),
  502: Object.freeze({ response: 'ManagementWriteEmbeddingUnavailable', schema: 'E502ManagementWrite', codes: ['EMBEDDING_UNAVAILABLE'] }),
  503: Object.freeze({ response: 'ManagementWriteBusyOrRateLimited', schema: 'E503ManagementWrite', codes: ['MODEL_RATE_LIMITED', 'DATABASE_BUSY'] }),
  504: Object.freeze({ response: 'ManagementWriteEmbeddingTimeout', schema: 'E504ManagementWrite', codes: ['EMBEDDING_TIMEOUT'] })
});

const writes = Object.freeze([
  Object.freeze({ path: '/api/manage/artist-prompt-strings', method: 'post', operationId: 'createArtistPromptString', httpMethod: 'POST', url: '/api/manage/artist-prompt-strings' }),
  Object.freeze({ path: '/api/manage/artist-prompt-strings/{id}', method: 'put', operationId: 'updateArtistPromptString', httpMethod: 'PUT', url: '/api/manage/artist-prompt-strings/1' })
]);

function responseSchemaCodes(schema) {
  const code = schema.allOf.find((part) => part?.properties?.error?.properties?.code)?.properties.error.properties.code;
  return code?.const === undefined ? [...(code?.enum ?? [])].sort() : [code.const];
}

test('Issue #276 画师串 create/update 声明固定管理写入模型错误矩阵', () => {
  for (const { path, method, operationId } of writes) {
    const responses = openapi.paths[path][method].responses;
    for (const [status, expected] of Object.entries(EXPECTED)) {
      const response = responses[status];
      assert.equal(response?.$ref, `#/components/responses/${expected.response}`, `${operationId} ${status} response`);
      const responseComponent = openapi.components.responses[expected.response];
      assert.equal(responseComponent.content['application/json'].schema.$ref, `#/components/schemas/${expected.schema}`, `${operationId} ${status} schema`);
      assert.deepEqual(responseSchemaCodes(openapi.components.schemas[expected.schema]), [...expected.codes].sort(), `${operationId} ${status} codes`);
      for (const code of expected.codes) assert.equal(errorCatalog.errors[code].operationIds.includes(operationId), true, `${operationId} ${code} catalog mapping`);
    }
  }
});

test('Issue #276 画师串 create/update 通过公开 HTTP 操作返回固定模型错误和 request_id', () => {
  const mapper = createErrorMapper(repositoryRoot);
  let currentCode = 'INTERNAL_ERROR';
  const dispatcher = createCatalogHttpDispatcher({
    service: {
      createArtistPromptString: () => { throw new ApplicationError(currentCode, `fixture ${currentCode}`); },
      updateArtistPromptString: () => { throw new ApplicationError(currentCode, `fixture ${currentCode}`); }
    },
    errorMapper: mapper,
    authorizeWrite: () => true
  });
  const write = {
    title: 'Issue 276 artist',
    description: 'Issue 276 HTTP fixture',
    artist_string: 'issue_276_artist:1.0',
    base_model_id: null,
    style_ids: []
  };
  for (const { operationId, httpMethod, url } of writes) {
    for (const [status, expected] of Object.entries(EXPECTED)) {
      for (const code of expected.codes) {
        currentCode = code;
        const response = dispatcher.dispatch({ listener: 'public', method: httpMethod, url, body: write, requestId: 'issue-276-artist-model-error' });
        assert.equal(response.status, Number(status), `${operationId} ${code}`);
        assert.equal(response.body.error.code, code, `${operationId} ${code}`);
        assert.equal(response.body.request_id, 'issue-276-artist-model-error', `${operationId} ${code}`);
      }
    }
  }
});
