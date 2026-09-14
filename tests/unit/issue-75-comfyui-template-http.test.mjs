import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

import { startTestApp } from '../../scripts/start-test-app.mjs';

const BASE_MODEL_ID = 801;
const MODEL_ID = 802;
const SECOND_BASE_MODEL_ID = 809;
const SECOND_MODEL_ID = 810;
const SECOND_LORA_ID = 811;
const NOW = '2026-08-02T00:00:00Z';

let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const requestId = `issue-75-template-${operation}-${++requestSequence}`;
  const response = await fetch(`${app.baseUrl}${pathname}`, {
    method,
    headers: {
      accept: 'application/json',
      'x-request-id': requestId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return Object.freeze({ status: response.status, body: await response.json(), requestId });
}

async function uploadTemplateCover(app, templateId, operation) {
  const form = new FormData();
  form.append('files', new Blob([await readFile(app.uploadFixture)], { type: 'image/png' }), 'issue-75-template.png');
  return requestMultipart(app, `/api/items/template/${templateId}/images`, form, operation);
}

async function requestMultipart(app, pathname, body, operation) {
  const requestId = `issue-75-template-${operation}-${++requestSequence}`;
  const response = await fetch(`${app.baseUrl}${pathname}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'x-request-id': requestId },
    body
  });
  return Object.freeze({ status: response.status, body: await response.json(), requestId });
}

function assertSuccessEnvelope(result, expectedStatus) {
  assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
  assert.deepEqual(Object.keys(result.body).sort(), ['data', 'ok', 'request_id']);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.request_id, result.requestId);
}

function assertErrorEnvelope(result, expectedStatus, expectedCode, expectedDetails = undefined) {
  assert.equal(result.status, expectedStatus);
  assert.deepEqual(Object.keys(result.body).sort(), ['error', 'ok', 'request_id']);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.request_id, result.requestId);
  assert.deepEqual(Object.keys(result.body.error).sort(), expectedDetails === undefined ? ['code', 'message'] : ['code', 'details', 'message']);
  if (expectedCode !== undefined) assert.equal(result.body.error.code, expectedCode);
  if (expectedDetails !== undefined) assert.deepEqual(result.body.error.details, expectedDetails);
}

const WORKFLOW_FORMAT_DETAILS = Object.freeze({ field: 'template_json', supported_versions: Object.freeze(['0.4', '1.0']) });

function validWorkflow(extra = {}) {
  return {
    version: 1,
    state: {},
    nodes: [{
      id: 1,
      type: 'Issue75UnknownNodeThatMustNotExecute',
      pos: [0, 0],
      size: [1, 1],
      flags: {},
      order: 0,
      mode: 0,
      properties: {}
    }],
    extra
  };
}

function validWorkflowV04(extra = {}, links = []) {
  return {
    last_node_id: 1,
    last_link_id: links.at(-1)?.[0] ?? 0,
    nodes: [{
      id: 1,
      type: 'Issue75UnknownNodeThatMustNotExecute',
      pos: [0, 0],
      size: [1, 1],
      flags: {},
      order: 0,
      mode: 0,
      properties: {}
    }],
    links,
    groups: [],
    config: {},
    extra,
    version: 0.4
  };
}

function templateWrite(title, templateJson = validWorkflow()) {
  return {
    base_model_id: BASE_MODEL_ID,
    model_id: MODEL_ID,
    lora_id: null,
    template_type: 'text_to_image',
    title,
    template_json: templateJson
  };
}

function seedSecondEcosystem(database) {
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(SECOND_BASE_MODEL_ID, 'Issue 75 second ecosystem', NOW, NOW);
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (?, ?, 'issue-75-second.safetensors', 'safetensors', 'fp16', 'second model', 'second usage', ?, ?)`)
    .run(SECOND_MODEL_ID, SECOND_BASE_MODEL_ID, NOW, NOW);
  database.prepare(`INSERT INTO generation_loras(
    id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (?, ?, ?, 'issue-75-second-lora.safetensors', 'safetensors', 'fp16', 'second lora', 'second usage', ?, ?)`)
    .run(SECOND_LORA_ID, SECOND_BASE_MODEL_ID, SECOND_MODEL_ID, NOW, NOW);
}

async function startLoopbackProbe() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return Object.freeze({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  });
}

test('真实 HTTP 完成 ComfyUI 模板创建、读取、完整更新、分页和删除，且 lora_id 可为 null', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const created = await requestJson(app, 'POST', '/api/manage/comfyui-templates', templateWrite('Issue 75 CRUD one'), 'create-one');
    assertSuccessEnvelope(created, 201);
    assert.equal(created.body.data.base_model_id, BASE_MODEL_ID);
    assert.equal(created.body.data.model_id, MODEL_ID);
    assert.equal(created.body.data.lora_id, null);
    assert.equal(created.body.data.title, 'Issue 75 CRUD one');

    const templateId = created.body.data.id;
    const detail = await requestJson(app, 'GET', `/api/manage/comfyui-templates/${templateId}`, undefined, 'get-one');
    assertSuccessEnvelope(detail, 200);
    assert.deepEqual(detail.body.data, created.body.data);

    const updatedWrite = templateWrite('Issue 75 CRUD updated', validWorkflowV04({ updated: true }));
    const updated = await requestJson(app, 'PUT', `/api/manage/comfyui-templates/${templateId}`, updatedWrite, 'update-one');
    assertSuccessEnvelope(updated, 200);
    assert.equal(updated.body.data.title, updatedWrite.title);
    assert.deepEqual(updated.body.data.template_json, updatedWrite.template_json);
    assert.equal(updated.body.data.lora_id, null);

    const page = await requestJson(app, 'GET', '/api/manage/comfyui-templates?page=1&page_size=1&base_model_id=801&model_id=802', undefined, 'page-one');
    assertSuccessEnvelope(page, 200);
    assert.deepEqual({
      page: page.body.data.page,
      page_size: page.body.data.page_size,
      total_count: page.body.data.total_count
    }, { page: 1, page_size: 1, total_count: 2 });
    assert.equal(page.body.data.items.length, 1);

    const impact = await requestJson(app, 'GET', `/api/manage/comfyui-templates/${templateId}/delete-impact`, undefined, 'delete-impact');
    assertSuccessEnvelope(impact, 200);
    assert.equal(typeof impact.body.data.impact_token, 'string');
    const deleted = await requestJson(app, 'DELETE', `/api/manage/comfyui-templates/${templateId}`, { impact_token: impact.body.data.impact_token }, 'delete-one');
    assertSuccessEnvelope(deleted, 200);

    const missing = await requestJson(app, 'GET', `/api/manage/comfyui-templates/${templateId}`, undefined, 'get-after-delete');
    assertErrorEnvelope(missing, 404, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('真实 HTTP 按 Workflow JSON 0.4 和 1.0 校验模板，不执行未知节点或访问 ComfyUI', { concurrency: false }, async () => {
  const probe = await startLoopbackProbe();
  const app = await startTestApp({ generationResourceFixture: true });
  const database = new DatabaseSync(app.paths.database);
  try {
    const invalid = await requestJson(app, 'POST', '/api/manage/comfyui-templates', templateWrite('Issue 75 invalid', { version: 0, state: {}, nodes: [] }), 'invalid-workflow');
    assertErrorEnvelope(invalid, 422, 'VALIDATION_ERROR', WORKFLOW_FORMAT_DETAILS);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE title = ?').get('Issue 75 invalid').count, 0);

    const invalidV04 = await requestJson(app, 'POST', '/api/manage/comfyui-templates', templateWrite('Issue 75 invalid 0.4', {
      ...validWorkflowV04(),
      links: [{}]
    }), 'invalid-workflow-0.4');
    assertErrorEnvelope(invalidV04, 422, 'VALIDATION_ERROR', WORKFLOW_FORMAT_DETAILS);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE title = ?').get('Issue 75 invalid 0.4').count, 0);

    const unsupportedVersion = await requestJson(app, 'POST', '/api/manage/comfyui-templates', templateWrite('Issue 75 unsupported version', {
      ...validWorkflow(),
      version: 2
    }), 'unsupported-workflow-version');
    assertErrorEnvelope(unsupportedVersion, 422, 'VALIDATION_ERROR', WORKFLOW_FORMAT_DETAILS);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE title = ?').get('Issue 75 unsupported version').count, 0);

    const { groups, config, extra, ...minimalV04 } = validWorkflowV04();
    assert.deepEqual([groups, config, extra], [[], {}, {}]);
    const acceptedMinimalV04 = await requestJson(
      app,
      'POST',
      '/api/manage/comfyui-templates',
      templateWrite('Issue 75 minimal workflow 0.4', minimalV04),
      'minimal-workflow-0.4'
    );
    assertSuccessEnvelope(acceptedMinimalV04, 201);

    const invalidModelUrl = await requestJson(app, 'PUT', `/api/manage/comfyui-templates/${acceptedMinimalV04.body.data.id}`, templateWrite(
      'Issue 75 invalid model URL',
      { ...validWorkflow(), models: [{ name: 'model', url: 'not a uri', directory: 'models/checkpoints' }] }
    ), 'invalid-model-url');
    assertErrorEnvelope(invalidModelUrl, 422, 'VALIDATION_ERROR', WORKFLOW_FORMAT_DETAILS);
    assert.equal(
      database.prepare('SELECT title FROM comfyui_templates WHERE id = ?').get(acceptedMinimalV04.body.data.id).title,
      'Issue 75 minimal workflow 0.4'
    );

    const invalidModelProperty = await requestJson(app, 'PUT', `/api/manage/comfyui-templates/${acceptedMinimalV04.body.data.id}`, templateWrite(
      'Issue 75 invalid model property',
      { ...validWorkflowV04(), models: [{ name: 'model', url: 'https://example.com/model.safetensors', directory: 'models/checkpoints', unsupported: true }] }
    ), 'invalid-model-property');
    assertErrorEnvelope(invalidModelProperty, 422, 'VALIDATION_ERROR', WORKFLOW_FORMAT_DETAILS);

    const workflow = validWorkflow({ probe_url: probe.url });
    const accepted = await requestJson(app, 'POST', '/api/manage/comfyui-templates', templateWrite('Issue 75 valid', workflow), 'valid-workflow');
    assertSuccessEnvelope(accepted, 201);
    assert.deepEqual(accepted.body.data.template_json, workflow);
    assert.deepEqual(JSON.parse(database.prepare('SELECT template_json FROM comfyui_templates WHERE id = ?').get(accepted.body.data.id).template_json), workflow);
    assert.deepEqual(probe.requests, []);
  } finally {
    database.close();
    await app.close();
    await probe.close();
  }
});

test('根 OpenAPI 使用结构化版本分支约束 Workflow JSON', () => {
  for (const relativePath of ['schema/api/openapi.yaml']) {
    const document = parseDocument(readFileSync(resolve(import.meta.dirname, '../..', relativePath), 'utf8'), { strict: true }).toJS({ mapAsMap: false });
    const workflowSchema = document.components.schemas.ComfyuiTemplateWrite.properties.template_json;
    assert.equal(Array.isArray(workflowSchema.oneOf), true, relativePath);
    assert.deepEqual(workflowSchema.oneOf.map((branch) => branch.properties.version.const), [0.4, 1], relativePath);
    assert.deepEqual(workflowSchema.oneOf[0].required, ['version', 'last_node_id', 'last_link_id', 'nodes', 'links'], relativePath);
    assert.deepEqual(workflowSchema.oneOf[1].required, ['version', 'state', 'nodes'], relativePath);
  }
});

test('真实 HTTP 接受 ComfyUI 前端导出的 Workflow JSON 0.4', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const database = new DatabaseSync(app.paths.database);
  try {
    const workflow = validWorkflowV04(
      { frontendVersion: '1.23.0' },
      [[1, 1, 0, 1, 0, 'IMAGE']]
    );
    const accepted = await requestJson(app, 'POST', '/api/manage/comfyui-templates', templateWrite('Issue 75 workflow 0.4', workflow), 'workflow-0.4');

    assertSuccessEnvelope(accepted, 201);
    assert.deepEqual(accepted.body.data.template_json, workflow);
    assert.deepEqual(
      JSON.parse(database.prepare('SELECT template_json FROM comfyui_templates WHERE id = ?').get(accepted.body.data.id).template_json),
      workflow
    );
  } finally {
    database.close();
    await app.close();
  }
});

test('真实 HTTP 拒绝 ComfyUI 模板的跨底模、跨模型和跨 LoRA 生态关联', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const database = new DatabaseSync(app.paths.database);
  try {
    seedSecondEcosystem(database);
    const crossModel = await requestJson(app, 'POST', '/api/manage/comfyui-templates', {
      ...templateWrite('Issue 75 cross model'),
      model_id: SECOND_MODEL_ID
    }, 'cross-model');
    assertErrorEnvelope(crossModel, 409, 'RELATION_CONFLICT');

    const crossLora = await requestJson(app, 'POST', '/api/manage/comfyui-templates', {
      ...templateWrite('Issue 75 cross lora'),
      lora_id: SECOND_LORA_ID
    }, 'cross-lora');
    assertErrorEnvelope(crossLora, 409, 'RELATION_CONFLICT');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE title LIKE \'Issue 75 cross%\'').get().count, 0);
  } finally {
    database.close();
    await app.close();
  }
});

test('真实 HTTP 为模板上传唯一封面、拒绝第二张并在同一删除事务中清空封面和图片记录', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  const database = new DatabaseSync(app.paths.database);
  try {
    const created = await requestJson(app, 'POST', '/api/manage/comfyui-templates', templateWrite('Issue 75 cover'), 'cover-template');
    assertSuccessEnvelope(created, 201);
    const templateId = created.body.data.id;

    const empty = await requestJson(app, 'GET', `/api/items/template/${templateId}/images`, undefined, 'cover-empty');
    assertSuccessEnvelope(empty, 200);
    assert.equal(empty.body.data.cover_media_path, null);
    assert.deepEqual(empty.body.data.images, []);

    const uploaded = await uploadTemplateCover(app, templateId, 'cover-upload');
    assertSuccessEnvelope(uploaded, 201);
    assert.equal(uploaded.body.data.owner_kind, 'template');
    assert.equal(uploaded.body.data.owner_id, templateId);
    assert.equal(uploaded.body.data.images.length, 1);
    const image = uploaded.body.data.images[0];
    assert.equal(uploaded.body.data.cover_media_path, image.media_path);
    assert.equal((await fetch(`${app.baseUrl}/media/${image.media_path}`)).status, 200);

    const duplicate = await uploadTemplateCover(app, templateId, 'cover-duplicate');
    assertErrorEnvelope(duplicate, 409, 'DUPLICATE_RESOURCE');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = \'template\' AND owner_id = ?').get(templateId).count, 1);

    const deleted = await requestJson(app, 'DELETE', `/api/items/template/${templateId}/images/${image.id}`, undefined, 'cover-delete');
    assertSuccessEnvelope(deleted, 200);
    assert.equal(deleted.body.data.cover_media_path, null);
    assert.deepEqual(deleted.body.data.images, []);
    assert.equal(database.prepare('SELECT cover_media_path FROM comfyui_templates WHERE id = ?').get(templateId).cover_media_path, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = ?').get(image.id).count, 0);
    assert.equal((await fetch(`${app.baseUrl}/media/${image.media_path}`)).status, 404);
  } finally {
    database.close();
    await app.close();
  }
});
