import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { createMediaHttpDispatcher } from '../../app/http/media-http.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';
import { assertRuntimeRouteInventory, assertRuntimeRouteInventoryMatchesOperationIds, canonicalHttpMethod, deriveRuntimeRouteInventory, matchRuntimeOperation, matchRuntimeRoute, RUNTIME_OPERATIONS } from '../../app/http/runtime-operations.mjs';

const noop = () => [];
const COMPLETE_SERVICE_METHODS = Object.freeze([
  'listPublicCatalog', 'getWork', 'getCharacter', 'getStyle', 'listManageItems', 'getManageItemDetail', 'createManageItem', 'updateManageItem',
  'getGenerationResourceOptions', 'getPromptTermOptions', 'listPromptTerms', 'createPromptTerm', 'getPromptTerm', 'updatePromptTerm', 'deletePromptTerm',
  'listBaseModels', 'createBaseModel', 'getBaseModel', 'updateBaseModel', 'deleteBaseModel', 'getBaseModelDeleteImpact',
  'listModels', 'createModel', 'getModel', 'updateModel', 'deleteModel', 'getModelDeleteImpact',
  'listLoras', 'createLora', 'getLora', 'updateLora', 'deleteLora', 'getLoraDeleteImpact',
  'listArtistPromptStrings', 'createArtistPromptString', 'getArtistPromptString', 'updateArtistPromptString', 'deleteArtistPromptString', 'getArtistPromptStringDeleteImpact',
  'listComfyuiInstances', 'createComfyuiInstance', 'getComfyuiInstance', 'updateComfyuiInstance', 'deleteComfyuiInstance', 'validateComfyuiInstance', 'getComfyuiInstanceDeleteImpact',
  'listComfyuiTemplates', 'createComfyuiTemplate', 'getComfyuiTemplate', 'updateComfyuiTemplate', 'deleteComfyuiTemplate', 'getComfyuiTemplateDeleteImpact',
  'searchCatalog', 'searchSemanticWorks', 'searchSemanticCharacters', 'searchSemanticStyles', 'searchSemanticPromptTerms',
  'querySemanticWorksForSkill', 'querySemanticCharactersForSkill', 'querySemanticStylesForSkill', 'querySemanticPromptTermsForSkill',
  'querySemanticLorasForSkill', 'querySemanticArtistPromptStringsForSkill',
  'querySemanticBaseModelsForSkill', 'querySemanticGenerationModelsForSkill', 'querySemanticComfyuiInstancesForSkill', 'querySemanticComfyuiTemplatesForSkill',
  'getComfyuiInstanceSourceForHost', 'getComfyuiTemplateBundleForHost',
  'listImages', 'uploadImages', 'reorderImages', 'setCover', 'deleteImage', 'batchDelete'
]);
const service = Object.freeze(Object.fromEntries(COMPLETE_SERVICE_METHODS.map((method) => [method, noop])));

const RETIRED_COMFYUI_OPERATION_IDS = Object.freeze([
  'getComfyuiTemplateWorkflowManagement',
  'listComfyuiTemplateRuntimeInputCandidates',
  'analyzeComfyuiTemplateWorkflow',
  'applyComfyuiTemplateStaticRepair',
  'updateComfyuiTemplateRuntimeConfig',
  'testComfyuiTemplateRuntime',
  'listComfyuiRuns',
  'getComfyuiRun'
]);

test('OpenAPI 运行路由四元组与统一 dispatcher 的实际 route inventory 完全一致', () => {
  const errorMapper = createErrorMapper();
  const mediaDispatcher = createMediaHttpDispatcher({ service, errorMapper, auditError: noop });
  const dispatcher = createCatalogHttpDispatcher({
    service,
    errorMapper,
    mediaDispatcher,
    semanticDiscovery: Object.freeze({ openapi: '3.1.0', paths: {} }),
    sourceDiscovery: Object.freeze({ openapi: '3.1.0', paths: {} })
  });
  const declared = new Set(RUNTIME_OPERATIONS.map((operation) => operation.operationId));
  const implemented = [...dispatcher.implementedOperations];
  assert.equal(declared.size, RUNTIME_OPERATIONS.length, 'RUNTIME_OPERATIONS 唯一来源不得包含重复 operationId');
  assert.equal(new Set(implemented).size, implemented.length, 'dispatcher.implementedOperations 不得包含重复 operationId');
  assert.deepEqual(
    [...declared].filter((operationId) => /BaseModel/u.test(operationId)).sort(),
    ['createBaseModel', 'deleteBaseModel', 'getBaseModel', 'getBaseModelDeleteImpact', 'listBaseModels', 'querySemanticBaseModelsForSkill', 'updateBaseModel']
  );
  assert.deepEqual(new Set(implemented), declared);
  for (const operationId of RETIRED_COMFYUI_OPERATION_IDS) {
    assert.equal(declared.has(operationId), false, operationId);
  }
  assertRuntimeRouteInventoryMatchesOperationIds({ inventory: dispatcher.runtimeRouteInventory, operationIds: implemented });
});

test('生产 runtime inventory validator 拒绝无效属性、重复四元组和重复 operationId', () => {
  const valid = [{ listener: 'public', method: 'get', path: '/api/works', operationId: 'listWorks' }];
  assert.throws(() => assertRuntimeRouteInventory(null), /must be an array/u);
  assert.throws(() => assertRuntimeRouteInventory([null]), /entry must be an object/u);
  assert.throws(() => assertRuntimeRouteInventory(['route']), /entry must be an object/u);
  for (const [property, value, message] of [
    ['listener', 'unknown', /listener is invalid/u],
    ['method', 'GET', /method is invalid/u],
    ['path', 'api/works', /path is invalid/u],
    ['operationId', '', /operationId is required/u]
  ]) {
    assert.throws(() => assertRuntimeRouteInventory([{ ...valid[0], [property]: value }]), message, `生产 validator 必须拒绝无效 ${property}`);
  }
  assert.throws(() => assertRuntimeRouteInventory([...valid, { ...valid[0] }]), /duplicates public GET \/api\/works listWorks/u, '生产 validator 必须拒绝重复四元组');
  assert.throws(() => assertRuntimeRouteInventory([...valid, { ...valid[0], path: '/api/works/{id}' }]), /duplicates operationId listWorks/u, '生产 validator 必须拒绝重复 operationId');
});

test('生产 derive validator 直接拒绝 malformed operationIds 输入', () => {
  assert.throws(() => deriveRuntimeRouteInventory(null), /operationIds must be an array/u);
  assert.throws(() => deriveRuntimeRouteInventory([null]), /operationId is required/u);
  assert.throws(() => deriveRuntimeRouteInventory(['']), /operationId is required/u);
  assert.throws(() => deriveRuntimeRouteInventory(['listWorks', 'listWorks']), /duplicates public GET \/api\/works listWorks/u);
  assert.throws(() => deriveRuntimeRouteInventory(['undeclaredRuntimeOperation']), /not declared by OpenAPI/u);
});

test('HTTP method canonicalization and runtime matchers reject malformed and unsupported methods', () => {
  assert.equal(canonicalHttpMethod(null), null);
  assert.equal(canonicalHttpMethod(''), null);
  assert.equal(canonicalHttpMethod('GET!'), null);
  assert.equal(canonicalHttpMethod('get'), 'GET');
  assert.equal(canonicalHttpMethod('patch'), 'PATCH');

  const inventory = deriveRuntimeRouteInventory(['listWorks']);
  assert.equal(matchRuntimeRoute({ inventory, listener: 'public', method: null, url: '/api/works' }), null);
  assert.equal(matchRuntimeOperation({ listener: 'public', method: '', url: '/api/works' }), null);
  assert.equal(matchRuntimeRoute({ inventory, listener: 'public', method: 'PATCH', url: '/api/works' }), null);
  assert.equal(matchRuntimeOperation({ listener: 'public', method: 'PATCH', url: '/api/works' }), null);
  assert.equal(matchRuntimeRoute({ inventory, listener: 'public', method: 'get', url: '/api/works' })?.route.operationId, 'listWorks');
  assert.equal(matchRuntimeOperation({ listener: 'public', method: 'get', url: '/api/works' })?.operation.operationId, 'listWorks');
});

test('生产 route inventory 对比拒绝新增、复用、删除和四元组改写', () => {
  const errorMapper = createErrorMapper();
  const mediaDispatcher = createMediaHttpDispatcher({ service, errorMapper, auditError: noop });
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper, mediaDispatcher });
  const inventory = dispatcher.runtimeRouteInventory;
  const operationIds = dispatcher.implementedOperations;

  assertRuntimeRouteInventoryMatchesOperationIds({ inventory, operationIds });

  assert.throws(() => assertRuntimeRouteInventoryMatchesOperationIds({
    inventory: [...inventory, { listener: 'public', method: 'get', path: '/api/undeclared-runtime-route', operationId: 'undeclaredRuntimeOperation' }],
    operationIds
  }), /differs from the OpenAPI-derived implemented operationIds/u, '新增唯一但未声明的 runtime route 必须由四元组深度一致性拒绝');
  assert.throws(() => assertRuntimeRouteInventoryMatchesOperationIds({
    inventory: [...inventory, { ...inventory[0], path: '/api/undeclared-runtime-route' }],
    operationIds
  }), /duplicates operationId/u, '复用已有 operationId 的未声明 runtime route 必须失败');
  assert.throws(() => assertRuntimeRouteInventoryMatchesOperationIds({ inventory: inventory.slice(1), operationIds }), /differs from the OpenAPI-derived implemented operationIds/u, '移除已声明 runtime route 必须失败');
  for (const [property, value] of [
    ['listener', 'internal'],
    ['method', 'post'],
    ['path', '/api/changed-runtime-route'],
    ['operationId', 'changedRuntimeOperation']
  ]) {
    assert.throws(() => assertRuntimeRouteInventoryMatchesOperationIds({
      inventory: inventory.map((entry, index) => index === 0 ? { ...entry, [property]: value } : entry),
      operationIds
    }), /differs from the OpenAPI-derived implemented operationIds/u, `改写 runtime route ${property} 必须失败`);
  }
});

test('完整 catalog dispatcher 验证注入 media dispatcher 实际暴露的 inventory', () => {
  const errorMapper = createErrorMapper();
  const mediaDispatcher = createMediaHttpDispatcher({ service, errorMapper, auditError: noop });
  const invalidMediaDispatcher = Object.freeze({
    canHandle: mediaDispatcher.canHandle,
    dispatch: mediaDispatcher.dispatch,
    implementedOperations: mediaDispatcher.implementedOperations,
    runtimeRouteInventory: Object.freeze([
      ...mediaDispatcher.runtimeRouteInventory,
      { listener: 'public', method: 'get', path: '/api/injected-but-undeclared', operationId: 'injectedButUndeclared' }
    ])
  });
  assert.throws(
    () => createCatalogHttpDispatcher({ service, errorMapper, mediaDispatcher: invalidMediaDispatcher }),
    /differs from the OpenAPI-derived implemented operationIds/u,
    '完整 dispatcher 必须验证注入对象实际暴露的 media inventory'
  );
});

test('统一 dispatcher 对 media matcher 和 imperative route 使用同一 method 规范化规则', () => {
  const errorMapper = createErrorMapper();
  const mediaDispatcher = createMediaHttpDispatcher({ service, errorMapper, auditError: noop, apiPublicPath: '/backend/api' });
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper, mediaDispatcher, apiPublicPath: '/backend/api' });
  assert.equal(mediaDispatcher.canHandle({ listener: 'public', method: 'get', url: '/backend/api/items/work/1/images' }), true);
  const lowerCase = dispatcher.dispatch({ listener: 'public', method: 'get', url: '/backend/api/items/work/1/images', requestId: 'lowercase-media' });
  assert.equal(lowerCase.status, 200);
  assert.equal(lowerCase.operationId, 'listImages');
  const unsupported = dispatcher.dispatch({ listener: 'public', method: 'PATCH', url: '/backend/api/items/work/1/images', requestId: 'unsupported-media-method' });
  assert.equal(unsupported.status, 404);
  assert.equal(unsupported.body.error.code, 'NOT_FOUND');
});

test('catalog dispatcher maps shared and aliased handlers to the routes it exposes', () => {
  const dispatcher = createCatalogHttpDispatcher({
    service: { listPublicCatalog: noop },
    errorMapper: createErrorMapper()
  });
  assert.deepEqual([...dispatcher.implementedOperations].sort(), [
    'listCharacters', 'listStyles', 'listWorkCharacters', 'listWorks'
  ]);
  assert.equal(dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/works/1', requestId: 'missing-capability' }).body.error.code, 'NOT_FOUND');
});

test('完整 dispatcher 为未实现的 media handler 保持 404，且不调用其他 handler', () => {
  let listImageCalls = 0;
  const errorMapper = createErrorMapper();
  const mediaDispatcher = createMediaHttpDispatcher({
    service: { listImages: () => { listImageCalls += 1; return { images: [] }; } },
    errorMapper,
    auditError: noop
  });
  const dispatcher = createCatalogHttpDispatcher({
    service: { listPublicCatalog: noop },
    errorMapper,
    mediaDispatcher
  });
  assert.equal(dispatcher.implementedOperations.includes('uploadImages'), false);
  assert.equal(mediaDispatcher.runtimeRouteInventory.some(({ operationId }) => operationId === 'uploadImages'), false);
  const response = dispatcher.dispatch({
    listener: 'public',
    method: 'POST',
    url: '/api/items/work/1/images',
    body: { files: [] },
    requestId: 'missing-media-handler'
  });
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    ok: false,
    request_id: 'missing-media-handler',
    error: { code: 'NOT_FOUND', message: 'not found' }
  });
  assert.equal(listImageCalls, 0);
});

test('生产 inventory 对比 validator 直接拒绝 malformed inventory 和 operationIds', () => {
  assert.throws(() => assertRuntimeRouteInventoryMatchesOperationIds({ inventory: null, operationIds: [] }), /inventory must be an array/u);
  assert.throws(() => assertRuntimeRouteInventoryMatchesOperationIds({ inventory: [null], operationIds: [] }), /entry must be an object/u);
  assert.throws(() => assertRuntimeRouteInventoryMatchesOperationIds({ inventory: [], operationIds: null }), /operationIds must be an array/u);
  assert.throws(() => assertRuntimeRouteInventoryMatchesOperationIds({ inventory: [], operationIds: [''] }), /operationId is required/u);
  assert.throws(() => assertRuntimeRouteInventoryMatchesOperationIds({ inventory: [], operationIds: [null] }), /operationId is required/u);
  assert.throws(() => assertRuntimeRouteInventoryMatchesOperationIds({
    inventory: [{ listener: 'public', method: 'get', path: '/api/works', operationId: 'undeclaredRuntimeOperation' }],
    operationIds: ['undeclaredRuntimeOperation']
  }), /not declared by OpenAPI/u);
});
