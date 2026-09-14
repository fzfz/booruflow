import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { buildSemanticDiscovery } from '../../app/http/semantic-discovery.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const TEMPLATE_PATH = '/internal/semantic/comfyui-templates';
const NOW = '2026-08-22T00:00:00.000Z';
const MEDIA_ORIGIN = 'http://127.0.0.1:19082';
const MEDIA_PREFIX = '/media';

function seedTemplateCatalog(database) {
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(279001, 'Issue 279 base', NOW, NOW);
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(279003, 'Issue 279 second base', NOW, NOW);
  const insertModel = database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertModel.run(279002, 279001, 'issue-279.safetensors', 'safetensors', 'fp16', 'Issue 279 model', 'Issue 279 model usage', NOW, NOW);
  insertModel.run(279004, 279003, 'issue-279-second.safetensors', 'safetensors', 'fp16', 'Issue 279 second model', 'Issue 279 second model usage', NOW, NOW);

  const imageWorkflow = JSON.stringify({
    version: 0.4,
    nodes: [{ id: 2, type: 'SaveImage', mode: 0, inputs: [], outputs: [], widgets_values: [] }]
  });
  const videoWorkflow = JSON.stringify({
    version: 0.4,
    nodes: [
      { id: 3, type: 'SaveAudioAdvanced', mode: 0 },
      { id: 4, type: 'VHS_VideoCombine', mode: 0 },
      { id: 5, type: 'SaveImage', mode: 0 }
    ]
  });
  const insertTemplate = database.prepare(`INSERT INTO comfyui_templates(
    id, base_model_id, model_id, lora_id, template_type, title, template_json,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertTemplate.run(279101, 279001, 279002, null, 'text_to_image', 'Configured template', imageWorkflow, NOW, NOW);
  insertTemplate.run(279102, 279001, 279002, null, 'text_to_image', 'Template without runtime config', imageWorkflow, NOW, NOW);
  insertTemplate.run(279103, 279001, 279002, null, 'text_to_image', 'Template without revision table', imageWorkflow, NOW, NOW);
  insertTemplate.run(279104, 279003, 279004, null, 'text_to_video', 'Output types template', videoWorkflow, NOW, NOW);
}

function fixture() {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seedTemplateCatalog(database);
  const repository = createCatalogRepository(database);
  const service = createCatalogService({
    repository,
    database,
    repositoryRoot: REPOSITORY_ROOT,
    mediaOrigin: MEDIA_ORIGIN,
    mediaPublicPrefix: MEDIA_PREFIX
  });
  return { database, service };
}

test('template Catalog searches and resolves template core rows without runtime configuration', () => {
  const { database, service } = fixture();
  try {
    database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (2791011, 'template', 279101, 'hash-2791011', 'templates/configured-cover.webp', 0, ?, ?)`).run(NOW, NOW);
    database.prepare('UPDATE comfyui_templates SET cover_media_path = ? WHERE id = 279101').run('templates/configured-cover.webp');
    const page = service.querySemanticComfyuiTemplatesForSkill({ mode: 'search', query: 'configured' });
    assert.deepEqual(page.results, [{
      id: 279101,
      base_model_id: 279001,
      model_id: 279002,
      lora_id: null,
      template_type: 'text_to_image',
      title: 'Configured template',
      cover_url: `${MEDIA_ORIGIN}${MEDIA_PREFIX}/templates/configured-cover.webp`,
      sample_image_urls: [],
      workflow_json: { version: 0.4, nodes: [{ id: 2, type: 'SaveImage', mode: 0, inputs: [], outputs: [], widgets_values: [] }] }
    }]);
    assert.deepEqual(service.querySemanticComfyuiTemplatesForSkill({ mode: 'resolve', id: '279101' }).results, page.results);
    assert.deepEqual(service.querySemanticComfyuiTemplatesForSkill({ mode: 'resolve', id: '279102' }).results[0].workflow_json, page.results[0].workflow_json);
    assert.deepEqual(service.querySemanticComfyuiTemplatesForSkill({ mode: 'resolve', id: '279103' }).results[0].workflow_json, page.results[0].workflow_json);
    assert.throws(
      () => service.querySemanticComfyuiTemplatesForSkill({ mode: 'resolve', id: '279999' }),
      (error) => error?.code === 'CATALOG_REF_NOT_FOUND'
    );
  } finally {
    database.close();
  }
});

test('template Catalog lists every template core row and filters by base model', () => {
  const { database, service } = fixture();
  try {
    const page = service.querySemanticComfyuiTemplatesForSkill({ mode: 'search', page: 1, page_size: 10 });
    assert.deepEqual(page.results.map(({ id }) => id), [279104, 279103, 279102, 279101]);
    assert.equal(page.total_count, 4);
    assert.deepEqual(service.querySemanticComfyuiTemplatesForSkill({ mode: 'search', query: 'template' }).results.map(({ id }) => id), [279101, 279104, 279103, 279102]);
    assert.deepEqual(service.querySemanticComfyuiTemplatesForSkill({ mode: 'search', base_model_id: '279001' }).results.map(({ id }) => id), [279103, 279102, 279101]);
    assert.throws(
      () => service.querySemanticComfyuiTemplatesForSkill({ mode: 'search', base_model_id: '279999' }),
      (error) => error?.code === 'CATALOG_REQUEST_INVALID'
    );
    const output = service.querySemanticComfyuiTemplatesForSkill({ mode: 'resolve', id: '279104' }).results[0];
    assert.equal(output.template_type, 'text_to_video');
    assert.equal(output.workflow_json.nodes[2].type, 'SaveImage');
    assert.equal(Object.hasOwn(output, 'parameters_json'), false);
    assert.equal(Object.hasOwn(output, 'expected_output_node_ids_json'), false);
  } finally {
    database.close();
  }
});

test('template Catalog discovery describes current Workflow data without runtime parameters', async () => {
  const discovery = buildSemanticDiscovery({ repositoryRoot: REPOSITORY_ROOT });
  const operation = discovery.paths[TEMPLATE_PATH].post;
  assert.equal(operation.operationId, 'querySemanticComfyuiTemplatesForSkill');
  assert.equal(operation['x-harness-tool-name'], 'query_semantic_comfyui_templates');
  assert.equal(operation.description, 'Search or resolve ComfyUI template summaries by title with current Workflow JSON.');

  const calls = [];
  const dispatcher = createCatalogHttpDispatcher({
    service: {
      querySemanticComfyuiTemplatesForSkill(request) {
        calls.push(request);
        return { status: 'ok', message: null, results: [], page: 1, page_size: 20, total_count: 0 };
      }
    },
    errorMapper: createErrorMapper(REPOSITORY_ROOT),
    semanticDiscovery: discovery
  });
  const response = await dispatcher.dispatch({ listener: 'internal', method: 'POST', url: TEMPLATE_PATH, body: { mode: 'search', base_model_id: '279001' } });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ mode: 'search', query: '', page: 1, page_size: 20, base_model_id: '279001' }]);
});
