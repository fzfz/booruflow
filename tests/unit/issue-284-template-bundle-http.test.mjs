import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createComfyuiTemplateRepository } from '../../app/generation-resources/comfyui-template-repository.mjs';
import { createComfyuiSourceService } from '../../app/generation-resources/comfyui-source-service.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSourceDiscovery } from '../../app/http/source-discovery.mjs';
import { SOURCE_HANDLER_ROUTE_MANIFEST } from '../../app/http/source-handler-routes.mjs';
import {
  SOURCE_TEMPLATE_BUNDLE_OPERATION_ID,
  SOURCE_TEMPLATE_BUNDLE_PATH
} from '../../app/contracts/source-contract.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const NOW = '2026-08-22T00:00:00.000Z';
const TEMPLATE_ID = 284001;

function workflow() {
  return {
    version: 0.4,
    last_node_id: 2,
    last_link_id: 0,
    nodes: [{
      id: 1,
      type: 'SaveImage',
      pos: [0, 0],
      size: [1, 1],
      flags: {},
      order: 0,
      mode: 0,
      properties: {},
      inputs: [],
      outputs: [],
      widgets_values: []
    }],
    links: [],
    groups: [],
    config: {},
    extra: {}
  };
}

function seedTemplate(database) {
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(284003, 'Issue 284 base', NOW, NOW);
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    284004, 284003, 'issue-284.safetensors', 'safetensors', 'fp16',
    'Issue 284 model', 'Issue 284 model usage', NOW, NOW
  );
  database.prepare(`INSERT INTO comfyui_templates(
    id, base_model_id, model_id, lora_id, template_type, title, template_json,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    TEMPLATE_ID, 284003, 284004, null, 'text_to_image', 'Issue 284 template',
    JSON.stringify(workflow()), NOW, NOW
  );
}

function fixture() {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seedTemplate(database);
  const templateRepository = createComfyuiTemplateRepository(database);
  const sourceService = createComfyuiSourceService({
    repository: { getStored: () => null },
    templateRepository,
    crypto: { decrypt: () => ({}) },
    repositoryRoot: REPOSITORY_ROOT
  });
  const discovery = buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  const dispatcher = createCatalogHttpDispatcher({
    service: {
      getComfyuiInstanceSourceForHost: () => null,
      [SOURCE_TEMPLATE_BUNDLE_OPERATION_ID]: sourceService[SOURCE_TEMPLATE_BUNDLE_OPERATION_ID]
    },
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    sourceDiscovery: discovery
  });
  return { database, dispatcher };
}

async function readBundle(dispatcher, id = String(TEMPLATE_ID)) {
  return dispatcher.dispatch({
    listener: 'internal',
    method: 'GET',
    url: SOURCE_TEMPLATE_BUNDLE_PATH.replace('{template_id}', id)
  });
}

test('Source discovery and route manifest keep the existing TemplateBundle interface', () => {
  const discovery = buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(Object.keys(discovery).sort(), ['components', 'info', 'openapi', 'paths']);
  assert.deepEqual(Object.keys(discovery.paths), [
    '/internal/comfyui-source/instances/{instance_id}',
    SOURCE_TEMPLATE_BUNDLE_PATH
  ]);
  assert.equal(discovery.paths[SOURCE_TEMPLATE_BUNDLE_PATH].get.operationId, SOURCE_TEMPLATE_BUNDLE_OPERATION_ID);
  assert.deepEqual(SOURCE_HANDLER_ROUTE_MANIFEST.map(({ method, path, operationId }) => `${method} ${path} ${operationId}`), [
    'get /internal/comfyui-source getComfyuiSourceDiscovery',
    'get /internal/comfyui-source/instances/{instance_id} getComfyuiInstanceSourceForHost',
    `get ${SOURCE_TEMPLATE_BUNDLE_PATH} ${SOURCE_TEMPLATE_BUNDLE_OPERATION_ID}`
  ]);
});

test('Source HTTP returns only the template identity, title and Workflow JSON', async () => {
  const { database, dispatcher } = fixture();
  try {
    const response = await readBundle(dispatcher);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: 'ok',
      message: null,
      results: [{
        id: TEMPLATE_ID,
        title: 'Issue 284 template',
        workflow_json: workflow()
      }],
      page: 1,
      page_size: 1,
      total_count: 1
    });
  } finally {
    database.close();
  }
});

test('Source HTTP reads the current Workflow stored on the template core record', async () => {
  const { database, dispatcher } = fixture();
  const latestWorkflow = { ...workflow(), extra: { selected: 'current' } };
  try {
    database.prepare('UPDATE comfyui_templates SET template_json = ? WHERE id = ?')
      .run(JSON.stringify(latestWorkflow), TEMPLATE_ID);
    const response = await readBundle(dispatcher);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.results, [{
      id: TEMPLATE_ID,
      title: 'Issue 284 template',
      workflow_json: latestWorkflow
    }]);
  } finally {
    database.close();
  }
});

test('Source HTTP maps invalid stored Workflow JSON to the unified error response', async () => {
  const invalidJson = createComfyuiSourceService({
    repository: { getStored: () => null },
    templateRepository: {
      getWorkflowSource: () => { throw new SyntaxError('invalid JSON fixture'); }
    },
    crypto: { decrypt: () => ({}) },
    repositoryRoot: REPOSITORY_ROOT
  });
  const dispatcher = createCatalogHttpDispatcher({
    service: {
      getComfyuiInstanceSourceForHost: () => null,
      [SOURCE_TEMPLATE_BUNDLE_OPERATION_ID]: invalidJson[SOURCE_TEMPLATE_BUNDLE_OPERATION_ID]
    },
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    sourceDiscovery: buildSourceDiscovery({ repositoryRoot: REPOSITORY_ROOT })
  });
  const response = await readBundle(dispatcher);
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    status: 'error',
    message: 'Source read failed.',
    results: [],
    page: 1,
    page_size: 0,
    total_count: 0
  });
});

test('Source HTTP reports a missing template without requiring runtime configuration', async () => {
  const { database, dispatcher } = fixture();
  try {
    const response = await readBundle(dispatcher, '284099');
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      status: 'error',
      message: 'ComfyUI template was not found.',
      results: [],
      page: 1,
      page_size: 0,
      total_count: 0
    });
  } finally {
    database.close();
  }
});

test('Source TemplateBundle 直接拒绝非法 ID、缺失读取依赖、数据库忙和不可克隆 Workflow', () => {
  const dependencies = {
    repository: { getStored: () => null },
    crypto: { decrypt: () => ({}) },
    repositoryRoot: REPOSITORY_ROOT
  };
  const withoutTemplateRepository = createComfyuiSourceService(dependencies);
  assert.throws(
    () => withoutTemplateRepository.getTemplateBundle(1),
    (error) => error?.code === 'SOURCE_REQUEST_INVALID'
  );
  assert.throws(
    () => withoutTemplateRepository.getTemplateBundle('0'),
    (error) => error?.code === 'SOURCE_REQUEST_INVALID'
  );
  assert.throws(
    () => withoutTemplateRepository.getTemplateBundle(String(TEMPLATE_ID)),
    (error) => error?.code === 'SOURCE_INTERNAL_ERROR'
  );
  const incompleteTemplateRepository = createComfyuiSourceService({ ...dependencies, templateRepository: {} });
  assert.throws(
    () => incompleteTemplateRepository.getTemplateBundle(String(TEMPLATE_ID)),
    (error) => error?.code === 'SOURCE_INTERNAL_ERROR'
  );

  const databaseBusy = createComfyuiSourceService({
    ...dependencies,
    templateRepository: {
      getWorkflowSource() {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
    }
  });
  assert.throws(
    () => databaseBusy.getTemplateBundle(String(TEMPLATE_ID)),
    (error) => error?.code === 'SOURCE_DATABASE_BUSY'
  );

  const unknownReadFailure = createComfyuiSourceService({
    ...dependencies,
    templateRepository: {
      getWorkflowSource() {
        throw null;
      }
    }
  });
  assert.throws(
    () => unknownReadFailure.getTemplateBundle(String(TEMPLATE_ID)),
    (error) => error?.code === 'SOURCE_INTERNAL_ERROR'
  );

  const uncloneableWorkflow = createComfyuiSourceService({
    ...dependencies,
    templateRepository: {
      getWorkflowSource: () => ({
        id: TEMPLATE_ID,
        title: 'Uncloneable Workflow',
        workflow_json: { callback() {} }
      })
    }
  });
  assert.throws(
    () => uncloneableWorkflow.getTemplateBundle(String(TEMPLATE_ID)),
    (error) => error?.code === 'SOURCE_INTERNAL_ERROR'
  );
});

test('Source service 在实例 repository 或凭据解密依赖缺失时立即失败', () => {
  assert.throws(
    () => createComfyuiSourceService({ crypto: { decrypt() {} } }),
    /source repository is incomplete/u
  );
  assert.throws(
    () => createComfyuiSourceService({ repository: {}, crypto: { decrypt() {} } }),
    /source repository is incomplete/u
  );
  assert.throws(
    () => createComfyuiSourceService({ repository: { getStored() {} } }),
    /crypto must provide decrypt/u
  );
  assert.throws(
    () => createComfyuiSourceService({ repository: { getStored() {} }, crypto: {} }),
    /crypto must provide decrypt/u
  );
});
