import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { SEMANTIC_HANDLER_ROUTE_MANIFEST } from '../../app/http/semantic-handler-routes.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const ROOT_OPENAPI_PATH = resolve(REPOSITORY_ROOT, 'schema/api/openapi.yaml');
const ERROR_CATALOG_PATH = resolve(REPOSITORY_ROOT, 'schema/api/error-catalog.json');

const CURRENT_CATALOG_OPERATION_IDS = Object.freeze([
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
const SAMPLE_IMAGE_CATALOG_PAGE_BY_OPERATION = Object.freeze({
  querySemanticGenerationModelsForSkill: 'CatalogGenerationModelPage',
  querySemanticLorasForSkill: 'CatalogLoraPage',
  querySemanticWorksForSkill: 'CatalogWorkPage',
  querySemanticCharactersForSkill: 'CatalogCharacterPage',
  querySemanticStylesForSkill: 'CatalogStylePage',
  querySemanticPromptTermsForSkill: 'CatalogPromptTermPage',
  querySemanticArtistPromptStringsForSkill: 'CatalogArtistPromptStringPage',
  querySemanticComfyuiTemplatesForSkill: 'CatalogComfyuiTemplatePage'
});
function readOpenApi(path) {
  const document = parseDocument(readFileSync(path, 'utf8'), { strict: true });
  assert.equal(document.errors.length, 0, path);
  return document.toJS({ mapAsMap: false });
}

function operationById(document, operationId) {
  const matches = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (operation?.operationId === operationId) matches.push({ path, method, operation });
    }
  }
  assert.equal(matches.length, 1, `${operationId} must be declared exactly once`);
  return matches[0];
}

function componentReference(reference) {
  const match = /^#\/components\/([^/]+)\/([^/]+)$/u.exec(reference);
  assert.ok(match, `expected a local component reference, received ${reference}`);
  return { section: match[1], name: match[2] };
}

function openApiErrorCodes(document, operationId) {
  const operation = operationById(document, operationId).operation;
  return Object.fromEntries(Object.entries(operation.responses)
    .filter(([status]) => Number(status) >= 400)
    .map(([status, response]) => {
      const responseComponent = componentReference(response.$ref);
      const responseSchema = document.components.responses[responseComponent.name].content['application/json'].schema;
      const codes = new Set();
      function collectCodes(value, state = 'none') {
        if (Array.isArray(value)) {
          value.forEach((child) => collectCodes(child, state));
          return;
        }
        if (value === null || typeof value !== 'object') return;
        if (typeof value.$ref === 'string') {
          const { section, name } = componentReference(value.$ref);
          collectCodes(document.components?.[section]?.[name], state);
          return;
        }
        const nextState = value.properties?.error === undefined
          ? state
          : state === 'none' ? 'error' : state;
        if (state === 'error' && value.properties?.code) {
          const code = value.properties.code;
          if (typeof code.const === 'string') codes.add(code.const);
          for (const item of code.enum ?? []) if (typeof item === 'string') codes.add(item);
        }
        for (const [key, child] of Object.entries(value)) {
          if (key !== '$ref') collectCodes(child, key === 'error' ? 'error' : nextState);
        }
      }
      collectCodes(responseSchema);
      return [status, [...codes].sort()];
    }));
}

function expectedSemanticRoutes() {
  return [
    { listener: 'internal', method: 'post', path: '/internal/semantic/base-models', operationId: 'querySemanticBaseModelsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/generation-models', operationId: 'querySemanticGenerationModelsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/loras', operationId: 'querySemanticLorasForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/works', operationId: 'querySemanticWorksForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/characters', operationId: 'querySemanticCharactersForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/styles', operationId: 'querySemanticStylesForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/prompt-terms', operationId: 'querySemanticPromptTermsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/artist-prompt-strings', operationId: 'querySemanticArtistPromptStringsForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/comfyui-instances', operationId: 'querySemanticComfyuiInstancesForSkill' },
    { listener: 'internal', method: 'post', path: '/internal/semantic/comfyui-templates', operationId: 'querySemanticComfyuiTemplatesForSkill' }
  ];
}

test('Issue 278 root OpenAPI exposes the current implemented Catalog contracts', () => {
  const root = readOpenApi(ROOT_OPENAPI_PATH);
  assert.deepEqual(
    Object.entries(root.paths)
      .filter(([path]) => path.startsWith('/internal/semantic/'))
      .map(([path, pathItem]) => ({
        listener: 'internal', method: Object.keys(pathItem)[0], path, operationId: pathItem[Object.keys(pathItem)[0]].operationId
      })),
    expectedSemanticRoutes()
  );
  assert.equal(Object.values(root.paths).some((pathItem) => Object.values(pathItem).some((operation) => operation?.operationId === 'querySemanticGenerationLorasForCli')), false);
  for (const [operationId, toolName, schemaName] of [
    ['querySemanticBaseModelsForSkill', 'query_semantic_base_models', 'CatalogBaseModelRequest'],
    ['querySemanticGenerationModelsForSkill', 'query_semantic_generation_models', 'CatalogGenerationModelRequest'],
    ['querySemanticLorasForSkill', 'query_semantic_loras', 'CatalogLoraRequest'],
    ['querySemanticWorksForSkill', 'query_semantic_works', 'CatalogWorkRequest'],
    ['querySemanticCharactersForSkill', 'query_semantic_characters', 'CatalogCharacterRequest'],
    ['querySemanticStylesForSkill', 'query_semantic_styles', 'CatalogStyleRequest'],
    ['querySemanticPromptTermsForSkill', 'query_semantic_prompt_terms', 'CatalogPromptTermRequest'],
    ['querySemanticArtistPromptStringsForSkill', 'query_semantic_artist_prompt_strings', 'CatalogArtistPromptStringRequest'],
    ['querySemanticComfyuiInstancesForSkill', 'query_semantic_comfyui_instances', 'CatalogComfyuiInstanceRequest'],
    ['querySemanticComfyuiTemplatesForSkill', 'query_semantic_comfyui_templates', 'CatalogComfyuiTemplateRequest']
  ]) {
    const operation = operationById(root, operationId).operation;
    assert.equal(operation['x-harness-tool-name'], toolName, operationId);
    assert.equal(operation['x-noobai-pi-tool-name'], undefined, operationId);
    assert.equal(operation['x-noobai-callable-projection'], undefined, operationId);
    assert.equal(operation.requestBody.content['application/json'].schema.$ref, `#/components/schemas/${schemaName}`);
    const errorsByStatus = openApiErrorCodes(root, operationId);
    assert.equal(Object.keys(errorsByStatus).length > 0, true, operationId);
    assert.equal(Object.values(errorsByStatus).every((codes) => codes.length === 0), true, operationId);
  }
});

test('Source Catalog root OpenAPI requires unique loopback sample image URLs for exactly eight Catalog operations', () => {
  const openApiPath = ROOT_OPENAPI_PATH;
  const openApi = readOpenApi(openApiPath);
    const imageRecord = openApi.components.schemas.CatalogSampleImageResultRecord.allOf[1];
    assert.deepEqual(imageRecord.required, ['sample_image_urls'], openApiPath);
    const sampleImageUrls = imageRecord.properties.sample_image_urls;
    assert.equal(sampleImageUrls.type, 'array', openApiPath);
    assert.equal(sampleImageUrls.uniqueItems, true, openApiPath);
    assert.equal(sampleImageUrls.items.type, 'string', openApiPath);
    assert.equal(sampleImageUrls.items.format, 'uri', openApiPath);
    const urlPattern = new RegExp(sampleImageUrls.items.pattern, 'u');
    assert.equal(urlPattern.test('http://127.0.0.1:18092/media/images/example-2.webp'), true, openApiPath);
    assert.equal(urlPattern.test('http://127.0.0.1:65535/media/images/example-3.webp'), true, openApiPath);
    assert.equal(urlPattern.test('http://localhost:18092/media/images/example-2.webp'), false, openApiPath);

    for (const [operationId, pageName] of Object.entries(SAMPLE_IMAGE_CATALOG_PAGE_BY_OPERATION)) {
      const responseReference = operationById(openApi, operationId).operation.responses['200'].$ref;
      const responseName = componentReference(responseReference).name;
      const responseSchema = openApi.components.responses[responseName].content['application/json'].schema;
      assert.equal(responseSchema.$ref, `#/components/schemas/${pageName}`, `${openApiPath}:${operationId}`);
      assert.equal(openApi.components.schemas[pageName].$ref, '#/components/schemas/CatalogSampleImageSuccess', `${openApiPath}:${operationId}`);
    }

    for (const [operationId, pageName] of [
      ['querySemanticBaseModelsForSkill', 'CatalogBaseModelPage'],
      ['querySemanticComfyuiInstancesForSkill', 'CatalogComfyuiInstancePage']
    ]) {
      const responseReference = operationById(openApi, operationId).operation.responses['200'].$ref;
      const responseName = componentReference(responseReference).name;
      const responseSchema = openApi.components.responses[responseName].content['application/json'].schema;
      assert.equal(responseSchema.$ref, '#/components/schemas/CatalogSourceSuccess', `${openApiPath}:${operationId}`);
      assert.equal(openApi.components.schemas[pageName].$ref, '#/components/schemas/CatalogSourceSuccess', `${openApiPath}:${operationId}`);
    }
});

test('current error catalog covers all Catalog operations', () => {
  const currentCatalog = JSON.parse(readFileSync(ERROR_CATALOG_PATH, 'utf8'));
  const currentErrors = {
    404: ['CATALOG_REF_NOT_FOUND'],
    422: ['CATALOG_REQUEST_INVALID'],
    500: ['CATALOG_INTERNAL_ERROR'],
    503: ['CATALOG_DATABASE_BUSY']
  };
  for (const operationId of CURRENT_CATALOG_OPERATION_IDS) {
    const errors = ['querySemanticWorksForSkill', 'querySemanticCharactersForSkill'].includes(operationId)
      ? { ...currentErrors, 409: ['CATALOG_RESOURCE_UNAVAILABLE'], 502: ['CATALOG_DEPENDENCY_UNAVAILABLE'], 503: ['CATALOG_DATABASE_BUSY', 'CATALOG_INDEX_NOT_READY'], 504: ['CATALOG_DEPENDENCY_TIMEOUT'] }
      : ['querySemanticStylesForSkill', 'querySemanticLorasForSkill', 'querySemanticArtistPromptStringsForSkill'].includes(operationId)
      ? { ...currentErrors, 502: ['CATALOG_DEPENDENCY_UNAVAILABLE'], 503: ['CATALOG_DATABASE_BUSY', 'CATALOG_INDEX_NOT_READY'], 504: ['CATALOG_DEPENDENCY_TIMEOUT'] }
      : operationId === 'querySemanticComfyuiTemplatesForSkill'
      ? { ...currentErrors, 409: ['CATALOG_RESOURCE_UNAVAILABLE'] }
      : currentErrors;
    for (const [status, codes] of Object.entries(errors)) {
      for (const code of codes) {
        assert.equal(currentCatalog.errors[code].http_status, Number(status), `${operationId}:${code}`);
        assert.equal(currentCatalog.errors[code].operationIds.includes(operationId), true, `${operationId}:${code}`);
      }
    }
  }
});

test('Issue 277 management update contracts declare NOT_FOUND while create contracts do not', () => {
  const root = readOpenApi(ROOT_OPENAPI_PATH);
  for (const operationId of ['updateLora', 'updateArtistPromptString']) {
    assert.deepEqual(openApiErrorCodes(root, operationId)['404'], ['NOT_FOUND'], operationId);
  }
  for (const operationId of ['createLora', 'createArtistPromptString']) {
    assert.equal(openApiErrorCodes(root, operationId)['404'], undefined, operationId);
  }
});

test('Issue 278 discovery, handler manifest, and Dispatcher expose current implemented Catalog operations on the internal listener', () => {
  const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  const expectedRoutes = expectedSemanticRoutes();
  assert.deepEqual(
    Object.entries(discovery.paths).map(([path, pathItem]) => ({
      listener: 'internal', method: Object.keys(pathItem)[0], path, operationId: pathItem[Object.keys(pathItem)[0]].operationId
    })),
    expectedRoutes
  );
  assert.deepEqual(
    SEMANTIC_HANDLER_ROUTE_MANIFEST.filter(({ path }) => path.startsWith('/internal/semantic/')),
    expectedRoutes
  );

  const service = {
    querySemanticBaseModelsForSkill: () => ({
      contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'base-model', items: [], page: 1, page_size: 20, total_count: 0
    }),
    querySemanticGenerationModelsForSkill: () => ({
      contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'model', items: [], page: 1, page_size: 20, total_count: 0
    }),
    querySemanticLorasForSkill: () => ({
      contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'lora', items: [], page: 1, page_size: 20, total_count: 0
    }),
    querySemanticWorksForSkill: () => ({
      contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'work', items: [], page: 1, page_size: 20, total_count: 0
    }),
    querySemanticCharactersForSkill: () => ({
      contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'character', items: [], page: 1, page_size: 20, total_count: 0
    }),
    querySemanticStylesForSkill: () => ({
      contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'style', items: [], page: 1, page_size: 20, total_count: 0
    }),
    querySemanticPromptTermsForSkill: () => ({
      contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'prompt-term', items: [], page: 1, page_size: 20, total_count: 0
    }),
    querySemanticArtistPromptStringsForSkill: () => ({
      contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'artist-string', items: [], page: 1, page_size: 20, total_count: 0
    }),
    querySemanticComfyuiInstancesForSkill: () => ({
      contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'comfyui-instance', items: [], page: 1, page_size: 20, total_count: 0
    }),
    querySemanticComfyuiTemplatesForSkill: () => ({
      contract_id: 'imagegen-source-contract', contract_version: 1, kind: 'comfyui-template', items: [], page: 1, page_size: 20, total_count: 0
    })
  };
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: discovery
  });
  assert.deepEqual(
    dispatcher.runtimeRouteInventory.filter(({ path }) => path.startsWith('/internal/semantic/')),
    expectedRoutes
  );

});
