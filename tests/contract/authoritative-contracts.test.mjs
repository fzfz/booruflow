import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ContractViolation,
  assertCrawlerCrossObjectConsistency,
  assertErrorMatrix,
  assertJsonSchemaReferences,
  loadAuthoritativeContracts,
  parseOpenApiStructure,
  validateJsonSample
} from '../../app/contracts/authoritative-contracts.mjs';
import { verifyAuthoritativeContracts } from '../../app/contracts/verify-contracts.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const fixtureDirectory = resolve(repositoryRoot, 'tests/fixtures/step-05');

function fixtureJson(name) {
  return JSON.parse(readFileSync(resolve(fixtureDirectory, name), 'utf8'));
}

function fixtureText(name) {
  return readFileSync(resolve(fixtureDirectory, name), 'utf8');
}

test('R11–R18 authoritative files load and pass their direct structural gate', () => {
  const contracts = loadAuthoritativeContracts(repositoryRoot);
  const result = verifyAuthoritativeContracts(repositoryRoot);
  const openapi = parseOpenApiStructure(contracts.openapiText);

  assert.equal(contracts.schemas.size, 10);
  assert.equal(result.schema.schemaCount, contracts.schemas.size);
  assert.equal(result.openapi.operationCount, openapi.operations.length);
  assert.equal(result.matrix.errorCount, Object.keys(contracts.errorCatalog.errors).length);
});

test('Issue #242 candidate read is not classified as a write operation', () => {
  const contracts = loadAuthoritativeContracts(repositoryRoot);
  assert.equal(contracts.errorCatalog.errors.WRITE_FORBIDDEN.operationIds.includes('listComfyuiTemplateRuntimeInputCandidates'), false);
});

test('OpenAPI paths, operations, component references, and error matrix are bidirectionally consistent', () => {
  const contracts = loadAuthoritativeContracts(repositoryRoot);
  const openapi = parseOpenApiStructure(contracts.openapiText);
  const matrix = assertErrorMatrix(openapi, contracts.errorCatalog);
  const statusMessageOperationIds = new Set(openapi.operations
    .filter(({ path }) => path.startsWith('/internal/semantic/') || path.startsWith('/internal/comfyui-source/'))
    .map(({ operationId }) => operationId));
  const authoritativeMatrixCount = Object.values(contracts.errorCatalog.errors)
    .reduce((count, definition) => count + definition.operationIds.filter((operationId) => !statusMessageOperationIds.has(operationId)).length, 0);

  assert.equal(openapi.operations.every((operation) => operation.path.startsWith('/api/') || operation.path === '/internal/semantic' || operation.path.startsWith('/internal/semantic/') || operation.path === '/internal/comfyui-source' || operation.path.startsWith('/internal/comfyui-source/')), true);
  assert.deepEqual(
    openapi.operations.filter((operation) => operation.path.startsWith('/internal/comfyui-source')).map(({ path, method, operationId }) => ({ path, method, operationId })),
    [
      { path: '/internal/comfyui-source', method: 'get', operationId: 'getComfyuiSourceDiscovery' },
      { path: '/internal/comfyui-source/instances/{instance_id}', method: 'get', operationId: 'getComfyuiInstanceSourceForHost' },
      { path: '/internal/comfyui-source/templates/{template_id}/bundle', method: 'get', operationId: 'getComfyuiTemplateBundleForHost' }
    ]
  );
  assert.deepEqual(
    openapi.operations.filter((operation) => operation.path.startsWith('/api/manage/base-models')).map((operation) => operation.operationId).sort(),
    ['createBaseModel', 'deleteBaseModel', 'getBaseModel', 'getBaseModelDeleteImpact', 'listBaseModels', 'updateBaseModel']
  );
  assert.equal(matrix.matrixCount, authoritativeMatrixCount);
  assert.throws(
    () => parseOpenApiStructure(fixtureText('openapi-missing-response.yaml')),
    ContractViolation
  );

  const fixtureOpenapi = parseOpenApiStructure(fixtureText('openapi-valid.yaml'));
  assert.equal(assertErrorMatrix(fixtureOpenapi, fixtureJson('error-catalog-valid.json')).matrixCount, 1);
  assert.throws(
    () => assertErrorMatrix(fixtureOpenapi, fixtureJson('error-catalog-unknown-operation.json')),
    /unknown operationId/
  );
});

test('OpenAPI error codes come only from a response root error.code across inline refs and compositions', () => {
  const openapi = parseOpenApiStructure(fixtureText('openapi-error-root-boundary.yaml'));
  const catalog = fixtureJson('error-catalog-error-root-boundary.json');
  assert.equal(assertErrorMatrix(openapi, catalog).matrixCount, 4);
  assert.deepEqual(
    openapi.matrix.map(({ code }) => code),
    ['ROOT_ERROR_ONEOF', 'ROOT_ERROR_REF', 'ROOT_INLINE_ALLOF', 'ROOT_REF_SIBLING']
  );
  assert.equal(openapi.matrix.some(({ code }) => code.includes('MUST_NOT_COUNT')), false);
});

test('Crawler schemas retain Draft 2020-12 references, versions, and valid/invalid sample behavior', () => {
  const contracts = loadAuthoritativeContracts(repositoryRoot);
  const result = assertJsonSchemaReferences(contracts.schemas);
  const crawlerConfigSchema = resolve(repositoryRoot, 'schema/crawler/crawl-config.schema.json');
  const detailSchema = resolve(repositoryRoot, 'schema/crawler/detail-result.schema.json');

  assert.equal(result.versionPropertyCount, 4);
  assert.deepEqual(validateJsonSample(fixtureJson('crawl-config-valid.json'), crawlerConfigSchema, contracts.schemas), []);
  assert.notDeepEqual(validateJsonSample(fixtureJson('crawl-config-invalid.json'), crawlerConfigSchema, contracts.schemas), []);
  assert.deepEqual(validateJsonSample(fixtureJson('detail-character-valid.json'), detailSchema, contracts.schemas), []);
  assert.deepEqual(validateJsonSample(fixtureJson('detail-character-invalid-owner.json'), detailSchema, contracts.schemas), []);
});

test('Schema format checks reject invalid UTC calendar dates and RFC3986-invalid HTTP URI originals', () => {
  const contracts = loadAuthoritativeContracts(repositoryRoot);
  const detailSchema = resolve(repositoryRoot, 'schema/crawler/detail-result.schema.json');
  const crawlerConfigSchema = resolve(repositoryRoot, 'schema/crawler/crawl-config.schema.json');
  const invalidDate = fixtureJson('detail-character-valid.json');
  invalidDate.fetched_at = '2023-02-29T00:00:00Z';

  assert.notDeepEqual(validateJsonSample(invalidDate, detailSchema, contracts.schemas), []);
  for (const sourceBaseUrl of [
    'http://source.example/path?query=value#fragment',
    'https://source.example/a%20path?query=one%2Ftwo',
    'https://[2001:db8::1]/path'
  ]) {
    const validUri = fixtureJson('crawl-config-valid.json');
    validUri.source_base_url = sourceBaseUrl;
    assert.deepEqual(validateJsonSample(validUri, crawlerConfigSchema, contracts.schemas), []);
  }

  for (const sourceBaseUrl of [
    'https://source.example/%zz',
    'https://[invalid',
    'https:\\source.example/path',
    'https://source.example/<tag>',
    'https://source.example/|pipe',
    'https://source.example/with space',
    'https://source.example/"quote"',
    'https://source.example/{item}',
    'https://source.example/^caret',
    'https://source.example/\u0001control',
    'ftp://source.example/path',
    'https:'
  ]) {
    const invalidUri = fixtureJson('crawl-config-valid.json');
    invalidUri.source_base_url = sourceBaseUrl;
    assert.notDeepEqual(validateJsonSample(invalidUri, crawlerConfigSchema, contracts.schemas), []);
  }

  for (const sourceBaseUrl of ['https:\\source.example/path', 'https://source.example/<tag>']) {
    assert.notEqual(new URL(sourceBaseUrl).href, sourceBaseUrl);
    const invalidUri = fixtureJson('crawl-config-valid.json');
    invalidUri.source_base_url = sourceBaseUrl;
    assert.notDeepEqual(validateJsonSample(invalidUri, crawlerConfigSchema, contracts.schemas), []);
  }
});

test('Schema uniqueItems rejects structurally equal objects despite different key order', () => {
  const contracts = loadAuthoritativeContracts(repositoryRoot);
  const cleanupSchema = resolve(repositoryRoot, 'schema/file-cleanup.schema.json');
  const duplicateEntries = {
    queue_version: 1,
    updated_at: '2026-07-26T12:00:00Z',
    entries: [
      { path: 'images/example.jpg', reason: 'image_delete', queued_at: '2026-07-26T12:00:00Z', attempts: 0 },
      { attempts: 0, queued_at: '2026-07-26T12:00:00Z', reason: 'image_delete', path: 'images/example.jpg' }
    ]
  };

  assert.notDeepEqual(validateJsonSample(duplicateEntries, cleanupSchema, contracts.schemas), []);
});

test('crawler cross-object rules reject every R11/R18 broken relation, while the valid local sample passes', () => {
  assert.doesNotThrow(() => assertCrawlerCrossObjectConsistency(fixtureJson('detail-character-valid.json')));
  assert.throws(
    () => assertCrawlerCrossObjectConsistency(fixtureJson('detail-character-invalid-owner.json')),
    /owner_identity must equal/
  );
  assert.throws(() => assertCrawlerCrossObjectConsistency(fixtureJson('detail-character-duplicate-sort.json')), /sort_order must be unique/);
  assert.throws(() => assertCrawlerCrossObjectConsistency(fixtureJson('detail-character-duplicate-source.json')), /source_url must be unique/);
  assert.throws(() => assertCrawlerCrossObjectConsistency(fixtureJson('crawl-report-invalid-time.json')), /finished_at must not be earlier/);
  assert.throws(() => assertCrawlerCrossObjectConsistency(fixtureJson('crawl-report-invalid-dedup-kind.json')), /kind must equal both identity kinds/);
});
