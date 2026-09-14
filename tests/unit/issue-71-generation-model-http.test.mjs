import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createModelRepository } from '../../app/generation-resources/model-repository.mjs';
import { createModelService } from '../../app/generation-resources/model-service.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';

const NOW = '2026-08-02T00:00:00Z';
const VALID_63_LABEL = 'a'.repeat(63);
const VALID_253_HOST = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
const INVALID_64_LABEL = 'a'.repeat(64);
const INVALID_254_HOST = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;

const MODEL_WRITE = Object.freeze({
  base_model_id: 1,
  file_name: 'wai-v1.safetensors',
  file_format: 'safetensors',
  precision_or_quantization: 'fp16',
  author: 'NoobAI',
  version: '1.0',
  release_url: 'https://example.test/wai-v1',
  published_at: '2026-08-01',
  description: 'WAI model description',
  usage: 'Use with the WAI prompt skill',
  skill_name: 'wai-sdxl-prompt-builder'
});

const MODEL_WRITE_UPDATED = Object.freeze({
  base_model_id: 2,
  file_name: 'anima-v2.gguf',
  file_format: 'gguf',
  precision_or_quantization: 'int4',
  author: null,
  version: null,
  release_url: null,
  published_at: null,
  description: 'Updated Anima model description',
  usage: 'Updated Anima model usage',
  skill_name: null
});

const MODEL_RECORD_COLUMNS = Object.freeze([
  'id',
  'base_model_id',
  'file_name',
  'file_format',
  'precision_or_quantization',
  'author',
  'version',
  'release_url',
  'published_at',
  'description',
  'usage',
  'skill_name',
  'cover_media_path',
  'created_at',
  'updated_at'
]);

function assertModelWriteFields(actual, expected) {
  for (const field of [
    'base_model_id',
    'file_name',
    'file_format',
    'precision_or_quantization',
    'author',
    'version',
    'release_url',
    'published_at',
    'description',
    'usage',
    'skill_name'
  ]) assert.deepEqual(actual[field], expected[field], `ModelWrite field ${field}`);
}

function assertSuccessEnvelope(response, requestId) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['data', 'ok', 'request_id']);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.request_id, requestId);
  assert.deepEqual(Object.keys(response.body.data).sort(), ['cascade_deleted', 'cleanup_failures', 'cleanup_warning', 'retained', 'target']);
}

function assertErrorEnvelope(response, requestId) {
  assert.notEqual(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['error', 'ok', 'request_id']);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.request_id, requestId);
  assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'message']);
}

function assertModelIds(items, expectedIds) {
  const ids = items.map((item) => item.id);
  assert.equal(ids.length, expectedIds.length);
  assert.deepEqual([...ids].sort((left, right) => left - right), [...expectedIds].sort((left, right) => left - right));
}

function seedBaseModel(database, id, name) {
  database.prepare(`INSERT INTO generation_base_models(id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(id, name, NOW, NOW);
}

function seedModel(database, {
  id,
  baseModelId = 1,
  fileName = `model-${id}.safetensors`,
  version = null
}) {
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    author, version, release_url, published_at, description, usage, skill_name,
    created_at, updated_at
  ) VALUES (?, ?, ?, 'safetensors', 'fp16', 'Author', ?, 'https://example.test/model', '2026-08-01', 'model description', 'model usage', 'wai-sdxl-prompt-builder', ?, ?)`)
    .run(id, baseModelId, fileName, version, NOW, NOW);
}

function seedModelCover(database, modelId, mediaPath) {
  database.prepare(`INSERT INTO item_images(
    id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
  ) VALUES (?, 'model', ?, ?, ?, 0, ?, ?)`).run(9000 + modelId, modelId, `hash-model-cover-${modelId}`, mediaPath, NOW, NOW);
  database.prepare('UPDATE generation_models SET cover_media_path = ? WHERE id = ?').run(mediaPath, modelId);
}

function readModelRecords(database) {
  return database.prepare(`SELECT ${MODEL_RECORD_COLUMNS.join(', ')}
    FROM generation_models ORDER BY id`).all();
}

function readModelRecord(database, id) {
  return database.prepare(`SELECT ${MODEL_RECORD_COLUMNS.join(', ')}
    FROM generation_models WHERE id = ?`).get(id);
}

function seedCascadeFixture(database) {
  seedBaseModel(database, 1, 'WAI');
  seedBaseModel(database, 2, 'Anima');
  seedModel(database, { id: 10, fileName: 'wai-cascade.safetensors' });
  database.prepare(`INSERT INTO generation_loras(
    id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (20, 1, 10, 'wai-style.safetensors', 'safetensors', 'fp16', 'lora description', 'lora usage', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO comfyui_templates(
    id, base_model_id, model_id, lora_id, template_type, title, template_json,
    created_at, updated_at
  ) VALUES (30, 1, 10, 20, 'text_to_image_lora', 'WAI template', '{}', ?, ?)`).run(NOW, NOW);
  for (const [id, ownerKind, ownerId, mediaPath] of [
    [100, 'model', 10, 'images/model.png'],
    [101, 'lora', 20, 'images/lora.png'],
    [102, 'template', 30, 'images/template.png']
  ]) {
    database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(id, ownerKind, ownerId, `hash-${id}`, mediaPath, NOW, NOW);
  }
}

function fixture({ cascade = false, mediaStorage = undefined, cleanupQueue = null, authorizeWrite = () => true, serviceOverrides = {} } = {}) {
  const database = openCatalogDatabase();
  if (cascade) {
    seedCascadeFixture(database);
  } else {
    seedBaseModel(database, 1, 'WAI');
    seedBaseModel(database, 2, 'Anima');
  }
  const cleanupEntries = [];
  const removedPaths = [];
  const actualMediaStorage = mediaStorage === undefined
    ? { remove(path) { removedPaths.push(path); } }
    : mediaStorage;
  const modelService = createModelService({
    database,
    repository: createModelRepository(database),
    mediaStorage: actualMediaStorage,
    cleanupQueue: cleanupQueue ?? {
      enqueue(entry) { cleanupEntries.push(entry); },
      recordFailure(entry) { return entry; }
    },
    now: () => new Date(NOW)
  });
  const service = {
    listModels: modelService.list,
    createModel: modelService.create,
    getModel: modelService.get,
    updateModel: modelService.update,
    getModelDeleteImpact: modelService.getDeleteImpact,
    deleteModel: modelService.delete,
    ...serviceOverrides
  };
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper(), authorizeWrite });
  return { database, dispatcher, modelService, cleanupEntries, removedPaths };
}

async function dispatch(dispatcher, method, url, body, requestId) {
  return await dispatcher.dispatch({ listener: 'public', method, url, body, requestId });
}

test('文生图模型服务完成创建、读取、完整更新，并按底模关联过滤和页码分页', () => {
  const { database, modelService } = fixture();
  try {
    const first = modelService.create(MODEL_WRITE);
    assert.equal(first.base_model_id, 1);
    assert.equal(first.file_name, MODEL_WRITE.file_name);
    assert.equal(first.skill_name, MODEL_WRITE.skill_name);

    const second = modelService.create({ ...MODEL_WRITE, base_model_id: 2, file_name: 'anima-v1.safetensors', version: null });
    const third = modelService.create({ ...MODEL_WRITE, file_name: 'wai-v2.safetensors', version: null });
    assert.equal(modelService.get(first.id).id, first.id);
    const pageOne = modelService.list({ page: 1, page_size: 1, q: '', base_model_id: 1 });
    const pageTwo = modelService.list({ page: 2, page_size: 1, q: '', base_model_id: 1 });
    assert.deepEqual({ page: pageTwo.page, page_size: pageTwo.page_size, total_count: pageTwo.total_count }, {
      page: 2,
      page_size: 1,
      total_count: 2
    });
    assert.equal(pageOne.items.length, 1);
    assert.equal(pageTwo.items.length, 1);
    assert.deepEqual([...new Set([...pageOne.items, ...pageTwo.items].map((item) => item.id))].sort((left, right) => left - right), [first.id, third.id]);

    const updated = modelService.update(first.id, {
      ...MODEL_WRITE,
      file_name: 'wai-v1-updated.safetensors',
      description: 'Updated model description',
      usage: 'Updated model usage'
    });
    assert.equal(updated.file_name, 'wai-v1-updated.safetensors');
    assert.equal(updated.description, 'Updated model description');
    assert.equal(updated.usage, 'Updated model usage');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = ?').get(first.id).count, 1);
    assert.equal(second.base_model_id, 2);
  } finally {
    database.close();
  }
});

test('文生图模型 HTTP 正交验证 q 搜索与 base_model_id 筛选，并拒绝写入未知字段', async () => {
  const { database, dispatcher } = fixture();
  try {
    seedModel(database, { id: 1, fileName: 'shared-wai.safetensors' });
    seedModel(database, { id: 2, fileName: 'alpha-wai.safetensors' });
    seedModel(database, { id: 3, baseModelId: 2, fileName: 'shared-anima.safetensors' });

    const qSearch = await dispatch(dispatcher, 'GET', '/api/manage/models?page=1&page_size=100&q=shared', undefined, 'model-q-search');
    assert.equal(qSearch.status, 200);
    assert.deepEqual({ page: qSearch.body.data.page, page_size: qSearch.body.data.page_size, total_count: qSearch.body.data.total_count }, { page: 1, page_size: 100, total_count: 2 });
    assertModelIds(qSearch.body.data.items, [1, 3]);

    const baseFilter = await dispatch(dispatcher, 'GET', '/api/manage/models?page=1&page_size=100&base_model_id=1', undefined, 'model-base-filter');
    assert.equal(baseFilter.status, 200);
    assert.equal(baseFilter.body.data.total_count, 2);
    assertModelIds(baseFilter.body.data.items, [1, 2]);

    for (const [url, requestId] of [
      ['/api/manage/models?page=0', 'model-invalid-page-zero'],
      ['/api/manage/models?page_size=101', 'model-invalid-page-size'],
      ['/api/manage/models?unknown=value', 'model-invalid-unknown-query']
    ]) {
      const result = await dispatch(dispatcher, 'GET', url, undefined, requestId);
      assert.equal(result.status, 422);
      assert.equal(result.body.error.code, 'VALIDATION_ERROR');
      assertErrorEnvelope(result, requestId);
    }

    for (const [method, url, body] of [
      ['POST', '/api/manage/models', { ...MODEL_WRITE, extra: true }],
      ['PUT', '/api/manage/models/1', { ...MODEL_WRITE, extra: true }]
    ]) {
      const result = await dispatch(dispatcher, method, url, body, `model-invalid-${method}`);
      assert.equal(result.status, 422);
      assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    }
  } finally {
    database.close();
  }
});

test('文生图模型真实 dispatcher 保留读权限、拒绝三类写操作并允许授权策略放行', async () => {
  const forbidden = fixture({ authorizeWrite: () => false });
  try {
    seedModel(forbidden.database, { id: 1 });
    for (const [method, url, body, requestId] of [
      ['GET', '/api/manage/models?page=1&page_size=20', undefined, 'model-read-list-forbidden-policy'],
      ['GET', '/api/manage/models/1', undefined, 'model-read-detail-forbidden-policy'],
      ['GET', '/api/manage/models/1/delete-impact', undefined, 'model-read-impact-forbidden-policy']
    ]) {
      const response = await dispatch(forbidden.dispatcher, method, url, body, requestId);
      assert.equal(response.status, 200, `${method} ${url}`);
      assert.equal(response.body.ok, true, `${method} ${url}`);
    }
    for (const [method, url, body, requestId] of [
      ['POST', '/api/manage/models', MODEL_WRITE, 'model-write-forbidden'],
      ['PUT', '/api/manage/models/1', MODEL_WRITE, 'model-update-forbidden'],
      ['DELETE', '/api/manage/models/1', undefined, 'model-delete-forbidden']
    ]) {
      const response = await dispatch(forbidden.dispatcher, method, url, body, requestId);
      assert.equal(response.status, 403, `${method} ${url}`);
      assert.equal(response.body.error.code, 'WRITE_FORBIDDEN', `${method} ${url}`);
      assertErrorEnvelope(response, requestId);
    }
  } finally {
    forbidden.database.close();
  }

  const allowed = fixture({ authorizeWrite: () => true });
  try {
    const created = await dispatch(allowed.dispatcher, 'POST', '/api/manage/models', MODEL_WRITE, 'model-write-allowed');
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    const updated = await dispatch(allowed.dispatcher, 'PUT', `/api/manage/models/${id}`, MODEL_WRITE_UPDATED, 'model-update-allowed');
    assert.equal(updated.status, 200);
    const impact = await dispatch(allowed.dispatcher, 'GET', `/api/manage/models/${id}/delete-impact`, undefined, 'model-impact-allowed');
    const deleted = await dispatch(allowed.dispatcher, 'DELETE', `/api/manage/models/${id}`, { impact_token: impact.body.data.impact_token }, 'model-delete-allowed');
    assert.equal(deleted.status, 200);
  } finally {
    allowed.database.close();
  }

  const missing = fixture();
  try {
    const response = await dispatch(missing.dispatcher, 'GET', '/api/manage/models/999', undefined, 'model-not-found');
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, 'NOT_FOUND');
    assertErrorEnvelope(response, 'model-not-found');
  } finally {
    missing.database.close();
  }

  for (const [code, status, requestId] of [
    ['DATABASE_BUSY', 503, 'model-database-busy'],
    ['INTERNAL_ERROR', 500, 'model-internal-error']
  ]) {
    const failed = fixture({
      serviceOverrides: { listModels() { throw new ApplicationError(code, code); } }
    });
    try {
      const response = await dispatch(failed.dispatcher, 'GET', '/api/manage/models?page=1&page_size=20', undefined, requestId);
      assert.equal(response.status, status);
      assert.equal(response.body.error.code, code);
      assertErrorEnvelope(response, requestId);
    } finally {
      failed.database.close();
    }
  }
});

test('文生图模型 POST 和 PUT 拒绝纯空白必填文本及 ftp/mailto release_url，并保持数据库不变', async () => {
  const invalidWrites = [
    ['file_name whitespace', { file_name: '\t \n' }],
    ['description whitespace', { description: '\u2003\u00a0' }],
    ['usage whitespace', { usage: ' \n\t' }],
    ['ftp release_url', { release_url: 'ftp://example.test/model' }],
    ['mailto release_url', { release_url: 'mailto:model@example.test' }]
  ];

  const postFixture = fixture();
  try {
    seedModel(postFixture.database, { id: 1, fileName: 'existing-model.safetensors' });
    const before = readModelRecords(postFixture.database);
    for (const [label, override] of invalidWrites) {
      const response = await dispatch(postFixture.dispatcher, 'POST', '/api/manage/models', { ...MODEL_WRITE, ...override }, `model-invalid-post-${label}`);
      assert.equal(response.status, 422, label);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', label);
      assert.deepEqual(readModelRecords(postFixture.database), before, label);
    }
  } finally {
    postFixture.database.close();
  }

  const putFixture = fixture();
  try {
    seedModel(putFixture.database, { id: 1, fileName: 'existing-model.safetensors' });
    const before = readModelRecords(putFixture.database);
    for (const [label, override] of invalidWrites) {
      const response = await dispatch(putFixture.dispatcher, 'PUT', '/api/manage/models/1', { ...MODEL_WRITE, ...override }, `model-invalid-put-${label}`);
      assert.equal(response.status, 422, label);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', label);
      const after = readModelRecords(putFixture.database);
      assert.deepEqual(after, before, label);
    }
  } finally {
    putFixture.database.close();
  }
});

test('文生图模型 POST 和 PUT 只接受带 host 的 HTTP/HTTPS URL，并保留有效 HTTP/HTTPS/null 正例', async () => {
  const validUrls = [
    ['http', 'http://example.test/model'],
    ['localhost', 'http://localhost/path'],
    ['ipv4-loopback', 'http://127.0.0.1/path'],
    ['dns-label-63', `http://${VALID_63_LABEL}.test/path`],
    ['dns-host-253', `http://${VALID_253_HOST}/path`],
    ['https', 'https://example.test:8080/path?x#f'],
    ['query', 'http://example.test/model?download=1'],
    ['fragment', 'http://example.test/model#section'],
    ['port-zero', 'http://example.test:0'],
    ['port-maximum', 'https://example.test:65535/path'],
    ['null', null]
  ];
  const invalidUrls = [
    ['userinfo without host', 'http://user@/path'],
    ['password-only userinfo', 'http://:pass@example.test/path'],
    ['port out of range', 'http://example.test:65536/path'],
    ['ipv4 octet out of range', 'http://999.999.999.999/path'],
    ['ipv4 final octet out of range', 'http://1.2.3.999/path'],
    ['decimal numeric authority out of range', 'http://4294967296/path'],
    ['hex numeric authority out of range', 'http://0x100000000/path'],
    ['mixed hex two-component authority', 'http://127.0x1/path'],
    ['mixed uppercase hex two-component authority', 'http://127.0X1/path'],
    ['mixed hex three-component authority', 'http://127.0.0x1/path'],
    ['mixed uppercase hex three-component authority', 'http://127.0.0X1/path'],
    ['hex first authority component', 'http://0x7f.0.0.1/path'],
    ['hex second authority component', 'http://127.0x0.0.1/path'],
    ['hex final authority component', 'http://1.2.3.0xff/path'],
    ['hex final authority component overflow', 'http://1.2.3.0x100/path'],
    ['dns label 64', `http://${INVALID_64_LABEL}.test/path`],
    ['dns host 254', `http://${INVALID_254_HOST}/path`],
    ['percent-only host', 'http://%'],
    ['percent in host', 'http://exa%mple.test'],
    ['pipe in authority', 'http://exa|mple.test/path'],
    ['malformed percent in host', 'http://exa%zzmple.test/path'],
    ['malformed percent in path', 'http://example.test/model%zz'],
    ['opening brace in host', 'http://exa{mple.test/path'],
    ['closing brace in host', 'http://exa}mple.test/path'],
    ['double quote in host', 'http://exa"mple.test/path'],
    ['unclosed host bracket', 'http://['],
    ['closing host bracket', 'http://]'],
    ['bare brackets in path', 'http://example.test/model[1]'],
    ['unicode host', 'http://例子.test/path'],
    ['query without host', 'http://?query'],
    ['fragment without host', 'https://#fragment'],
    ['ftp scheme', 'ftp://example.test/model'],
    ['mailto scheme', 'mailto:model@example.test'],
    ['http without host', 'http://'],
    ['https without host', 'https://'],
    ['http whitespace URL', 'http:// '],
    ['ascii whitespace in path', 'http://example.test/model\twith-whitespace'],
    ['unicode whitespace in path', 'http://example.test/model\u00a0with-whitespace'],
    ['control character in path', 'http://example.test/model\u0000with-control'],
    ['backslash in path', 'http://example.test\\path'],
    ['space in host', 'https://example .test/model'],
    ['malformed URL', 'https:///example.test/model']
  ];

  const postFixture = fixture();
  try {
    seedModel(postFixture.database, { id: 1, fileName: 'url-authority-existing-model.safetensors' });
    seedModelCover(postFixture.database, 1, 'images/url-authority-cover.png');
    const beforeInvalidPosts = readModelRecords(postFixture.database);
    for (const [label, releaseUrl] of validUrls) {
      const response = await dispatch(postFixture.dispatcher, 'POST', '/api/manage/models', {
        ...MODEL_WRITE,
        file_name: `valid-${label}.safetensors`,
        release_url: releaseUrl
      }, `model-valid-post-${label}`);
      assert.equal(response.status, 201, label);
      assert.equal(response.body.data.release_url, releaseUrl, label);
    }
    const postRecordsAfterValid = readModelRecords(postFixture.database);
    assert.equal(postRecordsAfterValid.length, beforeInvalidPosts.length + validUrls.length);
    assert.equal(postRecordsAfterValid.find(({ id }) => id === 1).cover_media_path, 'images/url-authority-cover.png');

    const beforeInvalid = readModelRecords(postFixture.database);
    for (const [label, releaseUrl] of invalidUrls) {
      const response = await dispatch(postFixture.dispatcher, 'POST', '/api/manage/models', {
        ...MODEL_WRITE,
        file_name: `invalid-${label}.safetensors`,
        release_url: releaseUrl
      }, `model-invalid-url-post-${label}`);
      assert.equal(response.status, 422, label);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', label);
      assert.deepEqual(readModelRecords(postFixture.database), beforeInvalid, label);
    }
  } finally {
    postFixture.database.close();
  }

  const putFixture = fixture();
  try {
    seedModel(putFixture.database, { id: 1, fileName: 'url-boundary-model.safetensors' });
    seedModelCover(putFixture.database, 1, 'images/url-boundary-cover.png');
    const beforeValidPuts = readModelRecord(putFixture.database, 1);
    for (const [label, releaseUrl] of validUrls) {
      const response = await dispatch(putFixture.dispatcher, 'PUT', '/api/manage/models/1', {
        ...MODEL_WRITE,
        file_name: `valid-put-${label}.safetensors`,
        release_url: releaseUrl
      }, `model-valid-put-${label}`);
      assert.equal(response.status, 200, label);
      assert.equal(response.body.data.release_url, releaseUrl, label);
      assert.equal(readModelRecord(putFixture.database, 1).cover_media_path, beforeValidPuts.cover_media_path, label);
    }
    const beforeInvalid = readModelRecords(putFixture.database);

    for (const [label, releaseUrl] of invalidUrls) {
      const response = await dispatch(putFixture.dispatcher, 'PUT', '/api/manage/models/1', {
        ...MODEL_WRITE,
        file_name: 'url-boundary-model.safetensors',
        release_url: releaseUrl
      }, `model-invalid-url-put-${label}`);
      assert.equal(response.status, 422, label);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', label);
      const after = readModelRecords(putFixture.database);
      assert.deepEqual(after, beforeInvalid, label);
    }
  } finally {
    putFixture.database.close();
  }
});

test('文生图模型 POST 和 PUT 拒绝 URL host 中的反斜杠并保持数据库不变', async () => {
  const invalidUrls = [
    ['backslash before at-sign', 'http://example.test\\@evil.test/path'],
    ['backslash path separator', 'http://example.test\\evil/path']
  ];

  const postFixture = fixture();
  try {
    const before = readModelRecords(postFixture.database);
    for (const [label, releaseUrl] of invalidUrls) {
      const response = await dispatch(postFixture.dispatcher, 'POST', '/api/manage/models', {
        ...MODEL_WRITE,
        file_name: `invalid-backslash-${label}.safetensors`,
        release_url: releaseUrl
      }, `model-invalid-backslash-post-${label}`);
      assert.equal(response.status, 422, label);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', label);
      assert.deepEqual(readModelRecords(postFixture.database), before, label);
    }
  } finally {
    postFixture.database.close();
  }

  const putFixture = fixture();
  try {
    seedModel(putFixture.database, { id: 1, fileName: 'backslash-boundary-model.safetensors' });
    const before = readModelRecord(putFixture.database, 1);
    for (const [label, releaseUrl] of invalidUrls) {
      const response = await dispatch(putFixture.dispatcher, 'PUT', '/api/manage/models/1', {
        ...MODEL_WRITE,
        file_name: 'backslash-boundary-model.safetensors',
        release_url: releaseUrl
      }, `model-invalid-backslash-put-${label}`);
      assert.equal(response.status, 422, label);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', label);
      const after = readModelRecord(putFixture.database, 1);
      assert.deepEqual(after, before, label);
    }
  } finally {
    putFixture.database.close();
  }
});

test('文生图模型 HTTP 完成 CRUD、完整更新、底模切换和关系边界', async () => {
  const { database, dispatcher } = fixture();
  try {
    const created = await dispatch(dispatcher, 'POST', '/api/manage/models', MODEL_WRITE, 'model-create');
    assert.equal(created.status, 201);
    const id = created.body.data.id;
    assertModelWriteFields(created.body.data, MODEL_WRITE);
    const detail = await dispatch(dispatcher, 'GET', `/api/manage/models/${id}`, undefined, 'model-detail');
    assert.equal(detail.status, 200);
    assertModelWriteFields(detail.body.data, MODEL_WRITE);

    const omittedOptional = await dispatch(dispatcher, 'PUT', `/api/manage/models/${id}`, {
      base_model_id: 1,
      file_name: 'wai-omitted-optional.safetensors',
      file_format: 'safetensors',
      precision_or_quantization: 'fp16',
      description: 'Optional fields omitted',
      usage: 'Optional fields omitted usage'
    }, 'model-update-omitted-optional');
    assert.equal(omittedOptional.status, 200);
    assertModelWriteFields(omittedOptional.body.data, {
      base_model_id: 1,
      file_name: 'wai-omitted-optional.safetensors',
      file_format: 'safetensors',
      precision_or_quantization: 'fp16',
      author: null,
      version: null,
      release_url: null,
      published_at: null,
      description: 'Optional fields omitted',
      usage: 'Optional fields omitted usage',
      skill_name: null
    });

    const updated = await dispatch(dispatcher, 'PUT', `/api/manage/models/${id}`, MODEL_WRITE_UPDATED, 'model-update');
    assert.equal(updated.status, 200);
    assertModelWriteFields(updated.body.data, MODEL_WRITE_UPDATED);

    const illegalRelation = await dispatch(dispatcher, 'PUT', `/api/manage/models/${id}`, { ...MODEL_WRITE_UPDATED, base_model_id: 999 }, 'model-illegal-base');
    assert.equal(illegalRelation.status, 409);
    assert.equal(illegalRelation.body.error.code, 'RELATION_CONFLICT');

    const duplicate = await dispatch(dispatcher, 'POST', '/api/manage/models', MODEL_WRITE_UPDATED, 'model-duplicate');
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'DUPLICATE_RESOURCE');

    const invalidWrites = [
      ['missing required base_model_id', (() => { const { base_model_id, ...payload } = MODEL_WRITE; return payload; })()],
      ['base_model_id minimum', { ...MODEL_WRITE, base_model_id: 0 }],
      ['base_model_id type', { ...MODEL_WRITE, base_model_id: '1' }],
      ['file_name type', { ...MODEL_WRITE, file_name: 42 }],
      ['file_name required value', { ...MODEL_WRITE, file_name: '' }],
      ['file_format leading whitespace', { ...MODEL_WRITE, file_format: ' zip' }],
      ['precision control character', { ...MODEL_WRITE, precision_or_quantization: 'bad-precision\n' }],
      ['author type', { ...MODEL_WRITE, author: 42 }],
      ['version type', { ...MODEL_WRITE, version: 1 }],
      ['release_url format', { ...MODEL_WRITE, release_url: 'not-a-url' }],
      ['published_at format', { ...MODEL_WRITE, published_at: '2026/08/01' }],
      ['description required value', { ...MODEL_WRITE, description: '' }],
      ['usage required value', { ...MODEL_WRITE, usage: '' }],
      ['skill_name type', { ...MODEL_WRITE, skill_name: 42 }]
    ];
    for (const [label, payload] of invalidWrites) {
      const invalid = await dispatch(dispatcher, 'POST', '/api/manage/models', payload, `model-invalid-${label}`);
      assert.equal(invalid.status, 422, label);
      assert.equal(invalid.body.error.code, 'VALIDATION_ERROR', label);
    }
  } finally {
    database.close();
  }
});

test('文生图模型 DELETE 拒绝缺失、空对象和额外字段而不删除目标', async () => {
  const { database, dispatcher } = fixture();
  try {
    const created = await dispatch(dispatcher, 'POST', '/api/manage/models', MODEL_WRITE, 'delete-boundary-create');
    const id = created.body.data.id;
    const impact = await dispatch(dispatcher, 'GET', `/api/manage/models/${id}/delete-impact`, undefined, 'delete-boundary-impact');
    for (const [body, requestId] of [
      [undefined, 'delete-missing-confirmation'],
      [{}, 'delete-empty-confirmation'],
      [{ impact_token: impact.body.data.impact_token, extra: true }, 'delete-extra-confirmation']
    ]) {
      const rejected = await dispatch(dispatcher, 'DELETE', `/api/manage/models/${id}`, body, requestId);
      assertErrorEnvelope(rejected, requestId);
      assert.equal(rejected.status, 422);
      assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = ?').get(id).count, 1);
    }
  } finally {
    database.close();
  }
});

test('文生图模型存在 LoRA 和模板时切换底模返回 RELATION_CONFLICT 且保留原数据', async () => {
  const { database, dispatcher } = fixture({ cascade: true });
  try {
    const before = readModelRecord(database, 10);
    const result = await dispatch(dispatcher, 'PUT', '/api/manage/models/10', {
      base_model_id: 2,
      file_name: before.file_name,
      file_format: before.file_format,
      precision_or_quantization: before.precision_or_quantization,
      author: before.author,
      version: before.version,
      release_url: before.release_url,
      published_at: before.published_at,
      description: before.description,
      usage: before.usage,
      skill_name: before.skill_name
    }, 'model-relation-conflict-with-children');
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'RELATION_CONFLICT');
    assertErrorEnvelope(result, 'model-relation-conflict-with-children');
    assert.deepEqual(readModelRecord(database, 10), before);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE model_id = 10').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE model_id = 10').get().count, 1);
  } finally {
    database.close();
  }
});

test('文生图模型删除影响和级联删除不依赖返回数组顺序，并返回完整清理成功 envelope', async () => {
  const { database, dispatcher, cleanupEntries, removedPaths } = fixture({ cascade: true, mediaStorage: undefined });
  try {
    const impact = await dispatch(dispatcher, 'GET', '/api/manage/models/10/delete-impact', undefined, 'model-impact');
    assert.equal(impact.status, 200);
    assert.equal(impact.body.data.target.id, 10);
    assert.deepEqual(impact.body.data.cascade_deleted.reduce((counts, item) => {
      counts[item.kind] = (counts[item.kind] ?? 0) + 1;
      return counts;
    }, {}), { lora: 1, template: 1, image: 3 });
    assert.equal(impact.body.data.cascade_deleted.length, 5);
    assert.deepEqual([...new Set(impact.body.data.cascade_deleted.map((item) => item.kind))].sort(), ['image', 'lora', 'template']);
    assert.deepEqual(impact.body.data.retained, []);

    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (21, 1, 10, 'new-style.safetensors', 'safetensors', 'fp16', 'description', 'usage', ?, ?)`).run(NOW, NOW);
    const stale = await dispatch(dispatcher, 'DELETE', '/api/manage/models/10', { impact_token: impact.body.data.impact_token }, 'model-delete-stale');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'DELETE_IMPACT_STALE');
    assert.deepEqual(Object.keys(stale.body).sort(), ['error', 'ok', 'request_id']);
    assert.equal(stale.body.ok, false);

    const currentImpact = await dispatch(dispatcher, 'GET', '/api/manage/models/10/delete-impact', undefined, 'model-impact-current');
    const deleted = await dispatch(dispatcher, 'DELETE', '/api/manage/models/10', { impact_token: currentImpact.body.data.impact_token }, 'model-delete-success');
    assertSuccessEnvelope(deleted, 'model-delete-success');
    assert.equal(deleted.body.data.cleanup_warning, false);
    assert.deepEqual(deleted.body.data.cleanup_failures, []);
    assert.deepEqual(cleanupEntries, []);
    assert.equal(removedPaths.length, 3);
    assert.deepEqual([...removedPaths].sort(), ['images/lora.png', 'images/model.png', 'images/template.png']);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 10').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE model_id = 10').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE model_id = 10').get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM item_images WHERE owner_kind IN ('model', 'lora', 'template') AND owner_id IN (10, 20, 30, 21)").get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 1').get().count, 1);
  } finally {
    database.close();
  }
});

test('文生图模型删除在文件清理和队列入队均失败时仍返回完整 warning envelope', async () => {
  const auditedFailures = [];
  const { database, dispatcher, cleanupEntries } = fixture({
    cascade: true,
    mediaStorage: { remove() { throw new Error('disk unavailable'); } },
    cleanupQueue: {
      enqueue() { throw new Error('queue unavailable'); },
      recordFailure(entry) { auditedFailures.push(entry); return entry; }
    }
  });
  try {
    const impact = await dispatch(dispatcher, 'GET', '/api/manage/models/10/delete-impact', undefined, 'model-impact-failure');
    const deleted = await dispatch(dispatcher, 'DELETE', '/api/manage/models/10', { impact_token: impact.body.data.impact_token }, 'model-delete-failure');
    assertSuccessEnvelope(deleted, 'model-delete-failure');
    assert.equal(deleted.body.data.cleanup_warning, true);
    assert.equal(deleted.body.data.cleanup_failures.length, 3);
    assert.equal(deleted.body.data.cleanup_failures.length, 3);
    assert.deepEqual([...deleted.body.data.cleanup_failures.map((failure) => failure.path)].sort(), ['images/lora.png', 'images/model.png', 'images/template.png']);
    assert.ok(deleted.body.data.cleanup_failures.every((failure) => failure.reason === 'owner_delete' && failure.remove_error === 'disk unavailable' && failure.enqueue_error === 'queue unavailable' && typeof failure.occurred_at === 'string'));
    assert.deepEqual(cleanupEntries, []);
    assert.equal(auditedFailures.length, 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 10').get().count, 0);
  } finally {
    database.close();
  }
});

test('文生图模型级联删除事务中途失败时回滚模型、LoRA、模板、资源图片和封面路径，且不启动提交后清理', async () => {
  const { database, dispatcher, cleanupEntries, removedPaths } = fixture({ cascade: true });
  try {
    database.prepare('UPDATE generation_models SET cover_media_path = ? WHERE id = 10').run('images/model.png');
    database.exec(`CREATE TRIGGER issue_71_delete_cascade_failure
      AFTER DELETE ON generation_loras
      BEGIN
        SELECT RAISE(ABORT, 'issue 71 injected cascade failure');
      END;`);

    const impact = await dispatch(dispatcher, 'GET', '/api/manage/models/10/delete-impact', undefined, 'model-impact-rollback');
    const failed = await dispatch(dispatcher, 'DELETE', '/api/manage/models/10', {
      impact_token: impact.body.data.impact_token
    }, 'model-delete-rollback');

    assert.equal(failed.status, 500);
    assertErrorEnvelope(failed, 'model-delete-rollback');
    assert.equal(failed.body.error.code, 'INTERNAL_ERROR');
    assert.equal(failed.body.error.message, 'internal service error');
    assert.deepEqual(cleanupEntries, []);
    assert.deepEqual(removedPaths, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE id = 10').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE id = 20 AND model_id = 10').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE id = 30 AND model_id = 10 AND lora_id = 20').get().count, 1);
    assert.deepEqual(database.prepare(`SELECT id, owner_kind, owner_id, media_path
      FROM item_images WHERE id IN (100, 101, 102) ORDER BY id`).all().map((row) => ({ ...row })), [
      { id: 100, owner_kind: 'model', owner_id: 10, media_path: 'images/model.png' },
      { id: 101, owner_kind: 'lora', owner_id: 20, media_path: 'images/lora.png' },
      { id: 102, owner_kind: 'template', owner_id: 30, media_path: 'images/template.png' }
    ]);
    assert.equal(database.prepare('SELECT cover_media_path FROM generation_models WHERE id = 10').get().cover_media_path, 'images/model.png');
  } finally {
    database.close();
  }
});
