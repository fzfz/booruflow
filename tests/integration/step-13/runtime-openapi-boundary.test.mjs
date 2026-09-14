import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RUNTIME_OPERATIONS } from '../../../app/http/runtime-operations.mjs';
import { startTestApp } from '../../../scripts/testing/start-test-app.mjs';

const probes = Object.freeze({
  listWorks: { listener: 'public', method: 'GET', path: '/api/works', expectedStatus: 200 },
  getWork: { listener: 'public', method: 'GET', path: '/api/works/999', expectedStatus: 404 },
  listWorkCharacters: { listener: 'public', method: 'GET', path: '/api/works/999/characters', expectedStatus: 404 },
  listCharacters: { listener: 'public', method: 'GET', path: '/api/characters', expectedStatus: 200 },
  getCharacter: { listener: 'public', method: 'GET', path: '/api/characters/999', expectedStatus: 404 },
  listStyles: { listener: 'public', method: 'GET', path: '/api/styles', expectedStatus: 200 },
  getStyle: { listener: 'public', method: 'GET', path: '/api/styles/999', expectedStatus: 404 },
  searchCatalog: { listener: 'public', method: 'GET', path: '/api/search?q=探针', expectedStatus: 200 },
  searchSemanticWorks: { listener: 'public', method: 'GET', path: '/api/semantic/works?q=probe', expectedStatus: 503 },
  searchSemanticCharacters: { listener: 'public', method: 'GET', path: '/api/semantic/characters?q=probe&work_id=1', expectedStatus: 503 },
  searchSemanticStyles: { listener: 'public', method: 'GET', path: '/api/semantic/styles?q=probe&base_model_name=fixture-style-wai', expectedStatus: 500 },
  searchSemanticPromptTerms: { listener: 'public', method: 'GET', path: '/api/semantic/prompt-terms?q=probe', expectedStatus: 503 },
  listManageItems: { listener: 'public', method: 'GET', path: '/api/manage/items?kind=all&limit=2', expectedStatus: 200 },
  getManageItemDetail: { listener: 'public', method: 'GET', path: '/api/manage/items/work/1', expectedStatus: 200 },
  createManageItem: { listener: 'public', method: 'POST', path: '/api/manage/items/work', body: {}, expectedStatus: 422 },
  updateManageItem: { listener: 'public', method: 'PUT', path: '/api/manage/items/work/1', body: {}, expectedStatus: 422 },
  getGenerationResourceOptions: { listener: 'public', method: 'GET', path: '/api/manage/generation-resource-options', expectedStatus: 200 },
  getPromptTermOptions: { listener: 'public', method: 'GET', path: '/api/manage/prompt-term-options', expectedStatus: 200 },
  listPromptTerms: { listener: 'public', method: 'GET', path: '/api/manage/prompt-terms', expectedStatus: 200 },
  createPromptTerm: { listener: 'public', method: 'POST', path: '/api/manage/prompt-terms', body: {}, expectedStatus: 422 },
  getPromptTerm: { listener: 'public', method: 'GET', path: '/api/manage/prompt-terms/999', expectedStatus: 404 },
  updatePromptTerm: { listener: 'public', method: 'PUT', path: '/api/manage/prompt-terms/999', body: {}, expectedStatus: 422 },
  deletePromptTerm: { listener: 'public', method: 'DELETE', path: '/api/manage/prompt-terms/999', expectedStatus: 404 },
  listBaseModels: { listener: 'public', method: 'GET', path: '/api/manage/base-models', expectedStatus: 200 },
  createBaseModel: { listener: 'public', method: 'POST', path: '/api/manage/base-models', body: {}, expectedStatus: 422 },
  getBaseModel: { listener: 'public', method: 'GET', path: '/api/manage/base-models/999', expectedStatus: 404 },
  updateBaseModel: { listener: 'public', method: 'PUT', path: '/api/manage/base-models/999', body: {}, expectedStatus: 422 },
  deleteBaseModel: { listener: 'public', method: 'DELETE', path: '/api/manage/base-models/999', body: {}, expectedStatus: 422 },
  getBaseModelDeleteImpact: { listener: 'public', method: 'GET', path: '/api/manage/base-models/999/delete-impact', expectedStatus: 404 },
  listModels: { listener: 'public', method: 'GET', path: '/api/manage/models', expectedStatus: 200 },
  createModel: { listener: 'public', method: 'POST', path: '/api/manage/models', body: {}, expectedStatus: 422 },
  getModel: { listener: 'public', method: 'GET', path: '/api/manage/models/999', expectedStatus: 404 },
  updateModel: { listener: 'public', method: 'PUT', path: '/api/manage/models/999', body: {}, expectedStatus: 422 },
  deleteModel: { listener: 'public', method: 'DELETE', path: '/api/manage/models/999', body: {}, expectedStatus: 422 },
  getModelDeleteImpact: { listener: 'public', method: 'GET', path: '/api/manage/models/999/delete-impact', expectedStatus: 404 },
  listLoras: { listener: 'public', method: 'GET', path: '/api/manage/loras', expectedStatus: 200 },
  createLora: { listener: 'public', method: 'POST', path: '/api/manage/loras', body: {}, expectedStatus: 422 },
  getLora: { listener: 'public', method: 'GET', path: '/api/manage/loras/999', expectedStatus: 404 },
  updateLora: { listener: 'public', method: 'PUT', path: '/api/manage/loras/999', body: {}, expectedStatus: 422 },
  deleteLora: { listener: 'public', method: 'DELETE', path: '/api/manage/loras/999', body: {}, expectedStatus: 422 },
  getLoraDeleteImpact: { listener: 'public', method: 'GET', path: '/api/manage/loras/999/delete-impact', expectedStatus: 404 },
  listArtistPromptStrings: { listener: 'public', method: 'GET', path: '/api/manage/artist-prompt-strings', expectedStatus: 200 },
  createArtistPromptString: { listener: 'public', method: 'POST', path: '/api/manage/artist-prompt-strings', body: {}, expectedStatus: 422 },
  getArtistPromptString: { listener: 'public', method: 'GET', path: '/api/manage/artist-prompt-strings/999', expectedStatus: 404 },
  updateArtistPromptString: { listener: 'public', method: 'PUT', path: '/api/manage/artist-prompt-strings/999', body: {}, expectedStatus: 422 },
  deleteArtistPromptString: { listener: 'public', method: 'DELETE', path: '/api/manage/artist-prompt-strings/999', body: {}, expectedStatus: 422 },
  getArtistPromptStringDeleteImpact: { listener: 'public', method: 'GET', path: '/api/manage/artist-prompt-strings/999/delete-impact', expectedStatus: 404 },
  listComfyuiInstances: { listener: 'public', method: 'GET', path: '/api/manage/comfyui-instances', expectedStatus: 200 },
  createComfyuiInstance: { listener: 'public', method: 'POST', path: '/api/manage/comfyui-instances', body: {}, expectedStatus: 422 },
  getComfyuiInstance: { listener: 'public', method: 'GET', path: '/api/manage/comfyui-instances/999', expectedStatus: 404 },
  updateComfyuiInstance: { listener: 'public', method: 'PUT', path: '/api/manage/comfyui-instances/999', body: {}, expectedStatus: 422 },
  deleteComfyuiInstance: { listener: 'public', method: 'DELETE', path: '/api/manage/comfyui-instances/999', body: {}, expectedStatus: 422 },
  validateComfyuiInstance: { listener: 'public', method: 'POST', path: '/api/manage/comfyui-instances/999/validate', expectedStatus: 404 },
  getComfyuiInstanceDeleteImpact: { listener: 'public', method: 'GET', path: '/api/manage/comfyui-instances/999/delete-impact', expectedStatus: 404 },
  listComfyuiTemplates: { listener: 'public', method: 'GET', path: '/api/manage/comfyui-templates', expectedStatus: 200 },
  createComfyuiTemplate: { listener: 'public', method: 'POST', path: '/api/manage/comfyui-templates', body: {}, expectedStatus: 422 },
  getComfyuiTemplate: { listener: 'public', method: 'GET', path: '/api/manage/comfyui-templates/999', expectedStatus: 404 },
  updateComfyuiTemplate: { listener: 'public', method: 'PUT', path: '/api/manage/comfyui-templates/999', body: {}, expectedStatus: 422 },
  deleteComfyuiTemplate: { listener: 'public', method: 'DELETE', path: '/api/manage/comfyui-templates/999', body: {}, expectedStatus: 422 },
  getComfyuiTemplateDeleteImpact: { listener: 'public', method: 'GET', path: '/api/manage/comfyui-templates/999/delete-impact', expectedStatus: 404 },
  listImages: { listener: 'public', method: 'GET', path: '/api/items/work/999/images', expectedStatus: 404 },
  uploadImages: { listener: 'public', method: 'POST', path: '/api/items/work/1/images', body: {}, expectedStatus: 422 },
  reorderImages: { listener: 'public', method: 'PUT', path: '/api/items/work/1/images/order', body: {}, expectedStatus: 422 },
  setCover: { listener: 'public', method: 'PUT', path: '/api/items/work/1/cover', body: {}, expectedStatus: 422 },
  deleteImage: { listener: 'public', method: 'DELETE', path: '/api/items/work/1/images/999', expectedStatus: 409 },
  batchDelete: { listener: 'public', method: 'POST', path: '/api/items/batch-delete', body: { items: [] }, expectedStatus: 422 },
  getSemanticDiscovery: {
    listener: 'internal', method: 'GET', path: '/internal/semantic', expectedStatus: 200
  },
  querySemanticBaseModelsForSkill: {
    listener: 'internal', method: 'POST', path: '/internal/semantic/base-models',
    body: { mode: 'search', query: 'Fixture WAI', page: 1, page_size: 1 },
    closedBody: { mode: 'search', query: 'Fixture WAI', page: 1, page_size: 1, unexpected: true },
    expectedStatus: 200,
    catalogExpectation: { kind: 'base-model', itemId: '801', itemTitle: 'Fixture WAI', dataKey: 'name', dataValue: 'Fixture WAI' }
  },
  querySemanticGenerationModelsForSkill: {
    listener: 'internal', method: 'POST', path: '/internal/semantic/generation-models',
    body: { mode: 'search', query: 'fixture-model.safetensors', page: 1, page_size: 1, base_model_id: '801' },
    closedBody: { mode: 'search', query: 'fixture-model.safetensors', page: 1, page_size: 1, base_model_id: '801', unexpected: true },
    expectedStatus: 200,
    catalogExpectation: { kind: 'model', itemId: '802', itemTitle: 'fixture-model.safetensors', dataKey: 'file_name', dataValue: 'fixture-model.safetensors' }
  },
  querySemanticLorasForSkill: {
    listener: 'internal', method: 'POST', path: '/internal/semantic/loras',
    body: { mode: 'resolve', id: '803' }, expectedStatus: 200
  },
  querySemanticWorksForSkill: {
    listener: 'internal', method: 'POST', path: '/internal/semantic/works',
    body: { mode: 'resolve', id: '1' }, expectedStatus: 200
  },
  querySemanticCharactersForSkill: {
    listener: 'internal', method: 'POST', path: '/internal/semantic/characters',
    body: { mode: 'resolve', id: '2' }, expectedStatus: 200
  },
  querySemanticStylesForSkill: {
    listener: 'internal', method: 'POST', path: '/internal/semantic/styles',
    body: { mode: 'resolve', id: '3' }, expectedStatus: 200
  },
  querySemanticPromptTermsForSkill: {
    listener: 'internal', method: 'POST', path: '/internal/semantic/prompt-terms',
    body: { mode: 'search', page: 1, page_size: 1 }, expectedStatus: 200
  },
  querySemanticArtistPromptStringsForSkill: {
    listener: 'internal', method: 'POST', path: '/internal/semantic/artist-prompt-strings',
    body: { mode: 'resolve', id: '805' }, expectedStatus: 200
  },
  querySemanticComfyuiInstancesForSkill: {
    listener: 'internal', method: 'POST', path: '/internal/semantic/comfyui-instances',
    body: { mode: 'search', page: 1, page_size: 1 }, expectedStatus: 200
  },
  querySemanticComfyuiTemplatesForSkill: {
    listener: 'internal', method: 'POST', path: '/internal/semantic/comfyui-templates',
    body: { mode: 'search', page: 1, page_size: 1 }, expectedStatus: 200
  },
  getComfyuiSourceDiscovery: {
    listener: 'internal', method: 'GET', path: '/internal/comfyui-source', expectedStatus: 200
  },
  getComfyuiInstanceSourceForHost: {
    listener: 'internal', method: 'GET', path: '/internal/comfyui-source/instances/999', expectedStatus: 404
  },
  getComfyuiTemplateBundleForHost: {
    listener: 'internal', method: 'GET', path: '/internal/comfyui-source/templates/999/bundle', expectedStatus: 404
  }
});

async function jsonRequest(baseUrl, probe, requestId) {
  const response = await fetch(`${baseUrl}${probe.path}`, {
    method: probe.method,
    headers: {
      'x-request-id': probe.body?.request_id ?? requestId,
      ...(probe.body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) })
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: response.status, body, text, operationIdHeader: response.headers.get('x-noobai-operation-id') };
}

function installMigrationTestEnvironment() {
  const previous = new Map([
    ['NODE_ENV', process.env.NODE_ENV],
    ['NOOBAI_TEST_EMPTY_COMFYUI_CATALOG', process.env.NOOBAI_TEST_EMPTY_COMFYUI_CATALOG]
  ]);
  process.env.NODE_ENV = 'test';
  process.env.NOOBAI_TEST_EMPTY_COMFYUI_CATALOG = '1';
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function startBoundaryTestApp(options) {
  const restoreEnvironment = installMigrationTestEnvironment();
  try {
    const app = await startTestApp(options);
    let closed = false;
    return Object.freeze({
      ...app,
      close: async (...args) => {
        try {
          return await app.close(...args);
        } finally {
          if (!closed) {
            closed = true;
            restoreEnvironment();
          }
        }
      }
    });
  } catch (error) {
    restoreEnvironment();
    throw error;
  }
}

function assertCatalogPage(result, expectation, operationId) {
  assert.deepEqual(Object.keys(result.body).sort(), ['message', 'page', 'page_size', 'results', 'status', 'total_count'], `${operationId} 未直接返回统一 Catalog 响应`);
  assert.equal(Object.hasOwn(result.body, 'ok'), false, `${operationId} CatalogPage 不应包含 ok envelope 字段`);
  assert.equal(Object.hasOwn(result.body, 'request_id'), false, `${operationId} CatalogPage 不应包含 request_id`);
  assert.equal(result.body.status, 'ok');
  assert.equal(result.body.message, null);
  assert.equal(result.body.page, 1);
  assert.equal(result.body.page_size, 1);
  assert.equal(result.body.total_count, 1);
  assert.equal(result.body.results.length, 1);
  assert.equal(result.body.results[0].id, Number(expectation.itemId));
  assert.equal(result.body.results[0][expectation.dataKey], expectation.dataValue);
}

test('OpenAPI 正式操作与真实启动应用的运行路由集合双向一致', async () => {
  const operations = new Map(RUNTIME_OPERATIONS.map((operation) => [operation.operationId, operation]));
  const app = await startBoundaryTestApp({ testMode: true, generationResourceFixture: true });
  try {
    const missingProbes = [...operations.keys()].filter((operationId) => probes[operationId] === undefined);
    assert.deepEqual(missingProbes, [], `OpenAPI 新增操作缺少真实 HTTP 探针：${missingProbes.join(', ')}`);

    await app.reset();
    const observed = new Set();
    const results = [];
    for (const [operationId, operation] of operations) {
      const probe = probes[operationId];
      const baseUrl = probe.listener === 'internal' ? app.internalBaseUrl : app.baseUrl;
      let result;
      try {
        result = await jsonRequest(baseUrl, probe, `openapi-${operationId}`);
      } catch (error) {
        throw new Error(`${operationId} ${operation.method.toUpperCase()} ${operation.path} 真实 HTTP 探测失败: ${error.message}`, { cause: error });
      }
      results.push({ operationId, method: operation.method, path: operation.path, status: result.status });
      assert.equal(result.status, probe.expectedStatus, `${operationId} ${operation.method.toUpperCase()} ${operation.path} 未被真实路由识别：${result.text}`);
      if (operationId === 'getSemanticDiscovery') {
        assert.equal(result.operationIdHeader, operationId);
        assert.equal(result.body.openapi, '3.1.0');
        assert.equal(Object.hasOwn(result.body, 'ok'), false);
        assert.equal(Object.hasOwn(result.body, 'request_id'), false);
        observed.add(operationId);
        continue;
      }
      assert.equal(result.operationIdHeader, operationId, `${operationId} ${operation.method.toUpperCase()} ${operation.path} 的运行时 operationId header 不匹配`);
      if (probe.catalogExpectation !== undefined) {
        assertCatalogPage(result, probe.catalogExpectation, operationId);
        const closed = await jsonRequest(baseUrl, { ...probe, body: probe.closedBody }, `openapi-${operationId}-closed`);
        assert.equal(closed.status, 422, `${operationId} 未拒绝开放 request：${closed.text}`);
        assert.equal(closed.operationIdHeader, operationId);
        assert.deepEqual(closed.body, { status: 'error', message: 'Catalog request is invalid.', results: [], page: 1, page_size: 0, total_count: 0 });
        assert.equal(Object.hasOwn(closed.body, 'ok'), false);
        assert.equal(Object.hasOwn(closed.body, 'request_id'), false);
      }
      const isDispatcherNotFound = result.status === 404 && result.body?.error?.message === 'not found';
      if (!isDispatcherNotFound) observed.add(result.operationIdHeader);
    }

    assert.deepEqual([...observed].sort(), [...operations.keys()].sort(), `真实运行路由集合与 OpenAPI 不一致：${JSON.stringify(results)}`);
    const publicDiscovery = await jsonRequest(app.baseUrl, { ...probes.getSemanticDiscovery, listener: 'public' }, 'public-discovery-rejected');
    assert.equal(publicDiscovery.status, 404, publicDiscovery.text);
    assert.equal(publicDiscovery.operationIdHeader, null);
  } finally {
    await app.close();
  }
});

test('真实 HTTP 仅在测试 operationId header 显式为 1 时暴露 dispatcher 选中的 operationId', async () => {
  for (const [operationIdHeader, requestId] of [[false, 'operation-id-header-zero'], [null, 'operation-id-header-unset']]) {
    const app = await startBoundaryTestApp({ testMode: true, operationIdHeader });
    try {
      await app.reset();
      const result = await jsonRequest(app.baseUrl, probes.listWorks, requestId);
      assert.equal(result.status, 200, result.text);
      assert.equal(result.operationIdHeader, null);
    } finally {
      await app.close();
    }
  }
});

test('公开端口拒绝内部语义路径，内部端口接收语义 discovery', async () => {
  const app = await startBoundaryTestApp({ testMode: true });
  try {
    const publicResponse = await jsonRequest(app.baseUrl, {
      listener: 'public', method: 'GET', path: '/internal/semantic', expectedStatus: 404
    }, 'public-internal-rejected');
    assert.equal(publicResponse.status, 404, `公开端口泄露内部语义路径：${publicResponse.body}`);

    const internalResponse = await jsonRequest(app.internalBaseUrl, {
      listener: 'internal', method: 'GET', path: '/internal/semantic', expectedStatus: 200
    }, 'internal-semantic-accepted');
    assert.equal(internalResponse.status, 200, `内部端口未接收语义 discovery：${internalResponse.body}`);
  } finally {
    await app.close();
  }
});

test('真实媒体路由接受 owner 快照与 id/ids 写入字段并拒绝已废止别名', async () => {
  const app = await startBoundaryTestApp({ testMode: true });
  try {
    await app.reset();
    const canonical = await jsonRequest(app.baseUrl, {
      listener: 'public', method: 'PUT', path: '/api/items/work/1/cover', body: { id: null }, expectedStatus: 200
    }, 'media-canonical-cover');
    assert.equal(canonical.status, 200, canonical.text);
    assert.deepEqual(Object.keys(canonical.body.data).sort(), ['cleanup_warning', 'cover_media_path', 'images', 'owner_id', 'owner_kind']);
    assert.deepEqual([canonical.body.data.owner_kind, canonical.body.data.owner_id], ['work', 1]);

    const legacyCover = await jsonRequest(app.baseUrl, {
      listener: 'public', method: 'PUT', path: '/api/items/work/1/cover', body: { image_id: null }, expectedStatus: 422
    }, 'media-retired-cover');
    assert.equal(legacyCover.status, 422, legacyCover.text);
    assert.equal(legacyCover.body.error.code, 'VALIDATION_ERROR');

    const legacyOrder = await jsonRequest(app.baseUrl, {
      listener: 'public', method: 'PUT', path: '/api/items/work/1/images/order', body: { image_ids: [1] }, expectedStatus: 422
    }, 'media-retired-order');
    assert.equal(legacyOrder.status, 422, legacyOrder.text);
    assert.equal(legacyOrder.body.error.code, 'VALIDATION_ERROR');
  } finally {
    await app.close();
  }
});
