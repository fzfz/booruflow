import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startTestApp } from '../../scripts/testing/start-test-app.mjs';

const LORA_WRITE = Object.freeze({
  base_model_id: 801,
  model_id: 802,
  file_format: 'safetensors',
  precision_or_quantization: 'fp16',
  author: null,
  version: null,
  release_url: null,
  description: 'Issue 72 LoRA description',
  usage: 'Issue 72 LoRA usage',
  trigger_words: Object.freeze(['issue 72 trigger']),
  weight: 0.75
});

const ALTERNATE_MODEL_WRITE = Object.freeze({
  file_format: 'safetensors',
  precision_or_quantization: 'fp16',
  author: null,
  version: null,
  release_url: null,
  published_at: null,
  description: 'Issue 72 alternate model description',
  usage: 'Issue 72 alternate model usage',
  skill_name: null
});

let requestSequence = 0;

async function requestJson(app, method, pathname, body, operation) {
  const requestId = `issue-72-${operation}-${++requestSequence}`;
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

function assertSuccessEnvelope(result, expectedStatus) {
  assert.equal(result.status, expectedStatus);
  assert.deepEqual(Object.keys(result.body).sort(), ['data', 'ok', 'request_id']);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.request_id, result.requestId);
}

function assertErrorEnvelope(result, expectedStatus, expectedCode) {
  assert.equal(result.status, expectedStatus);
  assert.deepEqual(Object.keys(result.body).sort(), ['error', 'ok', 'request_id']);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.request_id, result.requestId);
  assert.deepEqual(Object.keys(result.body.error).sort(), ['code', 'message']);
  assert.equal(result.body.error.code, expectedCode);
}

async function createLora(app, fileName) {
  const result = await requestJson(app, 'POST', '/api/manage/loras', {
    ...LORA_WRITE,
    file_name: fileName
  }, 'lora-create');
  assertSuccessEnvelope(result, 201);
  assert.equal(result.body.data.file_name, fileName);
  assert.equal(result.body.data.base_model_id, LORA_WRITE.base_model_id);
  assert.equal(result.body.data.model_id, LORA_WRITE.model_id);
  assert.deepEqual(result.body.data.trigger_words, LORA_WRITE.trigger_words);
  assert.equal(result.body.data.weight, LORA_WRITE.weight);
  assert.equal(Object.hasOwn(result.body.data, 'trigger_words_json'), false);
  return result.body.data;
}

test('真实应用 HTTP 支持 LoRA 列表的页码分页、q 搜索和 base_model_id 筛选', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    await createLora(app, 'issue-72-page-a.safetensors');
    await createLora(app, 'issue-72-page-b.safetensors');

    const pageOne = await requestJson(app, 'GET', '/api/manage/loras?page=1&page_size=1', undefined, 'lora-list-page-one');
    const pageTwo = await requestJson(app, 'GET', '/api/manage/loras?page=2&page_size=1', undefined, 'lora-list-page-two');
    assertSuccessEnvelope(pageOne, 200);
    assertSuccessEnvelope(pageTwo, 200);
    assert.deepEqual({
      page: pageOne.body.data.page,
      page_size: pageOne.body.data.page_size,
      total_count: pageOne.body.data.total_count
    }, { page: 1, page_size: 1, total_count: 3 });
    assert.deepEqual({
      page: pageTwo.body.data.page,
      page_size: pageTwo.body.data.page_size,
      total_count: pageTwo.body.data.total_count
    }, { page: 2, page_size: 1, total_count: 3 });
    assert.equal(pageOne.body.data.items.length, 1);
    assert.equal(pageTwo.body.data.items.length, 1);
    assert.notEqual(pageOne.body.data.items[0].id, pageTwo.body.data.items[0].id);

    const search = await requestJson(app, 'GET', '/api/manage/loras?page=1&page_size=20&q=fixture', undefined, 'lora-list-q');
    assertSuccessEnvelope(search, 200);
    assert.equal(search.body.data.total_count, 1);
    assert.match(search.body.data.items[0].file_name, /fixture/u);

    const baseModelFilter = await requestJson(app, 'GET', '/api/manage/loras?page=1&page_size=20&base_model_id=801', undefined, 'lora-list-base-model');
    assertSuccessEnvelope(baseModelFilter, 200);
    assert.equal(baseModelFilter.body.data.total_count, 3);
    assert.ok(baseModelFilter.body.data.items.every((item) => item.base_model_id === 801));
  } finally {
    await app.close();
  }
});

test('真实应用 HTTP 完成 LoRA POST、GET 和 PUT CRUD，并返回对应 operation 状态 envelope', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const created = await createLora(app, 'issue-72-crud.safetensors');

    const read = await requestJson(app, 'GET', `/api/manage/loras/${created.id}`, undefined, 'lora-get');
    assertSuccessEnvelope(read, 200);
    assert.equal(read.body.data.id, created.id);
    assert.equal(read.body.data.file_name, created.file_name);
    assert.deepEqual(read.body.data.trigger_words, LORA_WRITE.trigger_words);
    assert.equal(read.body.data.weight, LORA_WRITE.weight);

    const updatedFileName = 'issue-72-crud-updated.safetensors';
    const update = await requestJson(app, 'PUT', `/api/manage/loras/${created.id}`, {
      ...LORA_WRITE,
      file_name: updatedFileName,
      description: 'Issue 72 updated LoRA description',
      usage: 'Issue 72 updated LoRA usage',
      trigger_words: [' updated first ', 'updated second'],
      weight: -0.5
    }, 'lora-update');
    assertSuccessEnvelope(update, 200);
    assert.equal(update.body.data.id, created.id);
    assert.equal(update.body.data.file_name, updatedFileName);
    assert.equal(update.body.data.description, 'Issue 72 updated LoRA description');
    assert.equal(update.body.data.usage, 'Issue 72 updated LoRA usage');
    assert.deepEqual(update.body.data.trigger_words, ['updated first', 'updated second']);
    assert.equal(update.body.data.weight, -0.5);

    const list = await requestJson(app, 'GET', '/api/manage/loras?page=1&page_size=20&q=issue-72-crud-updated', undefined, 'lora-list-after-update');
    assertSuccessEnvelope(list, 200);
    assert.equal(list.body.data.total_count, 1);
    assert.deepEqual(list.body.data.items[0].trigger_words, ['updated first', 'updated second']);
    assert.equal(list.body.data.items[0].weight, -0.5);
  } finally {
    await app.close();
  }
});

test('真实应用 HTTP 接受空触发词数组与零权重，并保持 PUT round-trip', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const created = await requestJson(app, 'POST', '/api/manage/loras', {
      ...LORA_WRITE,
      file_name: 'issue-72-empty-trigger.safetensors',
      trigger_words: [],
      weight: 0
    }, 'lora-empty-trigger-create');
    assertSuccessEnvelope(created, 201);
    assert.deepEqual(created.body.data.trigger_words, []);
    assert.equal(created.body.data.weight, 0);

    const updated = await requestJson(app, 'PUT', `/api/manage/loras/${created.body.data.id}`, {
      ...LORA_WRITE,
      file_name: 'issue-72-empty-trigger.safetensors',
      trigger_words: ['single trigger'],
      weight: 2.5
    }, 'lora-single-trigger-update');
    assertSuccessEnvelope(updated, 200);
    assert.deepEqual(updated.body.data.trigger_words, ['single trigger']);
    assert.equal(updated.body.data.weight, 2.5);
  } finally {
    await app.close();
  }
});

test('真实应用 HTTP 的 LoRA POST 和 PUT 拒绝缺失字段、非法 JSON、null、字符串及非法触发词字段', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const { weight: _weight, ...missingWeight } = LORA_WRITE;
    const { trigger_words: _triggerWords, ...missingTriggerWords } = LORA_WRITE;
    const invalidWrites = [
      missingWeight,
      missingTriggerWords,
      { ...LORA_WRITE, weight: null },
      { ...LORA_WRITE, weight: '0.8' },
      { ...LORA_WRITE, trigger_words: null },
      { ...LORA_WRITE, trigger_words: 'alpha' },
      { ...LORA_WRITE, trigger_words: ['   '] },
      { ...LORA_WRITE, trigger_words: ['alpha', ' alpha '] }
    ];
    for (const [index, body] of invalidWrites.entries()) {
      const post = await requestJson(app, 'POST', '/api/manage/loras', { ...body, file_name: `issue-72-invalid-${index}.safetensors` }, `invalid-post-${index}`);
      assertErrorEnvelope(post, 422, 'VALIDATION_ERROR');
      const put = await requestJson(app, 'PUT', '/api/manage/loras/803', { ...body, file_name: 'fixture-lora.safetensors' }, `invalid-put-${index}`);
      assertErrorEnvelope(put, 422, 'VALIDATION_ERROR');
    }

    for (const [method, pathname] of [['POST', '/api/manage/loras'], ['PUT', '/api/manage/loras/803']]) {
      const requestId = `issue-72-invalid-json-${method.toLowerCase()}-${++requestSequence}`;
      const response = await fetch(`${app.baseUrl}${pathname}`, {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-request-id': requestId },
        body: '{'
      });
      const body = await response.json();
      assert.equal(response.status, 422);
      assert.equal(body.ok, false);
      assert.equal(body.request_id, requestId);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
    }
  } finally {
    await app.close();
  }
});

test('真实应用 HTTP 拒绝 POST 和 PUT 的跨模型生态 LoRA 写入', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const alternateBase = await requestJson(app, 'POST', '/api/manage/base-models', { name: 'Issue 72 alternate ecosystem' }, 'alternate-base-create');
    assertSuccessEnvelope(alternateBase, 201);
    const alternateModel = await requestJson(app, 'POST', '/api/manage/models', {
      ...ALTERNATE_MODEL_WRITE,
      base_model_id: alternateBase.body.data.id,
      file_name: 'issue-72-alternate.safetensors'
    }, 'alternate-model-create');
    assertSuccessEnvelope(alternateModel, 201);

    const crossEcosystemWrite = {
      ...LORA_WRITE,
      model_id: alternateModel.body.data.id,
      file_name: 'issue-72-cross-ecosystem.safetensors'
    };
    const create = await requestJson(app, 'POST', '/api/manage/loras', crossEcosystemWrite, 'lora-cross-ecosystem-create');
    assertErrorEnvelope(create, 409, 'RELATION_CONFLICT');

    const update = await requestJson(app, 'PUT', '/api/manage/loras/803', crossEcosystemWrite, 'lora-cross-ecosystem-update');
    assertErrorEnvelope(update, 409, 'RELATION_CONFLICT');
  } finally {
    await app.close();
  }
});

test('真实应用 HTTP 返回 LoRA 删除影响并执行缺失、错误、正确 impact_token 的确认语义', { concurrency: false }, async () => {
  const app = await startTestApp({ generationResourceFixture: true });
  try {
    const impact = await requestJson(app, 'GET', '/api/manage/loras/803/delete-impact', undefined, 'lora-delete-impact');
    assertSuccessEnvelope(impact, 200);
    assert.deepEqual(Object.keys(impact.body.data).sort(), ['cascade_deleted', 'impact_token', 'retained', 'target']);
    assert.equal(impact.body.data.target.id, 803);
    assert.ok(Array.isArray(impact.body.data.cascade_deleted));
    assert.ok(Array.isArray(impact.body.data.retained));
    assert.equal(typeof impact.body.data.impact_token, 'string');
    assert.notEqual(impact.body.data.impact_token.length, 0);

    const missingToken = await requestJson(app, 'DELETE', '/api/manage/loras/803', undefined, 'lora-delete-missing-token');
    assertErrorEnvelope(missingToken, 422, 'VALIDATION_ERROR');

    const wrongToken = await requestJson(app, 'DELETE', '/api/manage/loras/803', { impact_token: 'issue-72-wrong-impact-token' }, 'lora-delete-wrong-token');
    assertErrorEnvelope(wrongToken, 409, 'DELETE_IMPACT_STALE');

    const deleted = await requestJson(app, 'DELETE', '/api/manage/loras/803', { impact_token: impact.body.data.impact_token }, 'lora-delete-confirmed');
    assertSuccessEnvelope(deleted, 200);
    assert.deepEqual(Object.keys(deleted.body.data).sort(), ['cascade_deleted', 'cleanup_failures', 'cleanup_warning', 'retained', 'target']);
    assert.equal(deleted.body.data.target.id, 803);

    const missing = await requestJson(app, 'GET', '/api/manage/loras/803', undefined, 'lora-get-after-delete');
    assertErrorEnvelope(missing, 404, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});
