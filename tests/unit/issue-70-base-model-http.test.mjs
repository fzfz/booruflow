import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createBaseModelRepository } from '../../app/generation-resources/base-model-repository.mjs';
import { createBaseModelService } from '../../app/generation-resources/base-model-service.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { createErrorMapper } from '../../app/security/error-mapping.mjs';

const NOW = '2026-08-02T00:00:00Z';

function seedBaseModel(database, id, name) {
  database.prepare(`INSERT INTO generation_base_models(id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)`).run(id, name, NOW, NOW);
}

function seedCascadeFixture(database) {
  seedBaseModel(database, 1, 'WAI Cascade');
  database.prepare(`INSERT INTO generation_models
    (id, base_model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at)
    VALUES (10, 1, 'wai.safetensors', 'safetensors', 'fp16', 'model description', 'model usage', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO generation_loras
    (id, base_model_id, model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at)
    VALUES (20, 1, 10, 'style.safetensors', 'safetensors', 'fp16', 'lora description', 'lora usage', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO comfyui_templates
    (id, base_model_id, model_id, lora_id, template_type, title, template_json, created_at, updated_at)
    VALUES (30, 1, 10, 20, 'text_to_image', 'WAI template', '{}', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO artist_prompt_strings
    (id, title, description, artist_string, base_model_id, created_at, updated_at)
    VALUES (40, 'Retained artist', 'artist description', 'artist_a:1.0', 1, ?, ?)`).run(NOW, NOW);
  for (const [id, ownerKind, ownerId, mediaPath] of [
    [100, 'model', 10, 'images/model-cover.png'],
    [101, 'lora', 20, 'images/lora-cover.png'],
    [102, 'template', 30, 'images/template-cover.png']
  ]) {
    database.prepare(`INSERT INTO item_images
      (id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(id, ownerKind, ownerId, `hash-${id}`, mediaPath, NOW, NOW);
  }
}

function fixture({ cascade = false, mediaStorage = { remove() {} }, cleanupQueue = null } = {}) {
  const database = openCatalogDatabase();
  if (cascade) seedCascadeFixture(database);
  const cleanupEntries = [];
  const baseModelService = createBaseModelService({
    database,
    repository: createBaseModelRepository(database),
    mediaStorage,
    cleanupQueue: cleanupQueue ?? { enqueue(entry) { cleanupEntries.push(entry); }, recordFailure(entry) { return entry; } },
    now: () => new Date(NOW)
  });
  const service = {
    listBaseModels: baseModelService.list,
    createBaseModel: baseModelService.create,
    getBaseModel: baseModelService.get,
    updateBaseModel: baseModelService.update,
    getBaseModelDeleteImpact: baseModelService.getDeleteImpact,
    deleteBaseModel: baseModelService.delete
  };
  const dispatcher = createCatalogHttpDispatcher({ service, errorMapper: createErrorMapper() });
  return { database, dispatcher, cleanupEntries };
}

async function dispatch(dispatcher, method, url, body, requestId) {
  return await dispatcher.dispatch({ listener: 'public', method, url, body, requestId });
}

test('底模 HTTP 使用正式 page/page_size/q 契约，并拒绝空名、未知字段和非法 ID', async () => {
  const { database, dispatcher } = fixture();
  try {
    seedBaseModel(database, 1, 'Anima');
    seedBaseModel(database, 2, 'Krea2');
    seedBaseModel(database, 3, 'WAI');

    const page = await dispatch(dispatcher, 'GET', '/api/manage/base-models?page=2&page_size=1&q=', undefined, 'base-page-2');
    assert.equal(page.status, 200);
    assert.equal(page.body.ok, true);
    assert.deepEqual({ page: page.body.data.page, page_size: page.body.data.page_size, total_count: page.body.data.total_count }, { page: 2, page_size: 1, total_count: 3 });

    for (const [url, body] of [
      ['/api/manage/base-models', { name: '   ' }],
      ['/api/manage/base-models', { name: 'Unexpected', extra: true }],
      [`/api/manage/base-models?q=${'x'.repeat(101)}`, undefined],
      [`/api/manage/base-models?q=${encodeURIComponent('😀'.repeat(51))}`, undefined],
      ['/api/manage/base-models/zero', undefined]
    ]) {
      const result = await dispatch(dispatcher, url.includes('?') || url === '/api/manage/base-models/zero' ? 'GET' : 'POST', url, body, `invalid-${url}`);
      assert.equal(result.status, 422);
      assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    }
    const emojiBoundary = await dispatch(dispatcher, 'GET', `/api/manage/base-models?q=${encodeURIComponent('😀'.repeat(50))}`, undefined, 'base-emoji-boundary');
    assert.equal(emojiBoundary.status, 200);
    const unconstrainedPage = await dispatch(dispatcher, 'GET', '/api/manage/base-models?page=1000001&page_size=1', undefined, 'base-large-page');
    assert.equal(unconstrainedPage.status, 200);
  } finally {
    database.close();
  }
});

test('底模列表和详情返回数据库计算的模型、LoRA 与画风关联数量', async () => {
  const { database, dispatcher } = fixture({ cascade: true });
  try {
    database.prepare(`INSERT INTO styles
      (id, base_model_id, name, aliases_json, prompt_text, style_description)
      VALUES (50, 1, '厚涂', '[]', 'painterly', '真实画风说明')`).run();

    const page = await dispatch(dispatcher, 'GET', '/api/manage/base-models?page=1&page_size=16&q=WAI', undefined, 'base-count-list');
    assert.equal(page.status, 200);
    assert.deepEqual(
      { model_count: page.body.data.items[0].model_count, lora_count: page.body.data.items[0].lora_count, style_count: page.body.data.items[0].style_count },
      { model_count: 1, lora_count: 1, style_count: 1 }
    );

    const detail = await dispatch(dispatcher, 'GET', '/api/manage/base-models/1', undefined, 'base-count-detail');
    assert.equal(detail.status, 200);
    assert.deepEqual(
      { model_count: detail.body.data.model_count, lora_count: detail.body.data.lora_count, style_count: detail.body.data.style_count },
      { model_count: 1, lora_count: 1, style_count: 1 }
    );
  } finally {
    database.close();
  }
});

test('底模删除在数据库提交后清理文件和入队同时失败时仍返回稳定成功包络', async () => {
  const { database, dispatcher } = fixture({
    cascade: true,
    mediaStorage: { remove() { throw new Error('disk unavailable'); } },
    cleanupQueue: { enqueue() { throw new Error('queue persistence unavailable'); }, recordFailure(entry) { return { ...entry, occurred_at: NOW }; } }
  });
  try {
    const impact = await dispatch(dispatcher, 'GET', '/api/manage/base-models/1/delete-impact', undefined, 'base-cleanup-impact');
    const deleted = await dispatch(dispatcher, 'DELETE', '/api/manage/base-models/1', { impact_token: impact.body.data.impact_token }, 'base-cleanup-delete');
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.ok, true);
    assert.equal(deleted.body.data.cleanup_warning, true);
    assert.equal(deleted.body.data.cleanup_failures.length, 3);
    assert.deepEqual(deleted.body.data.cleanup_failures.map((failure) => failure.path).sort(), ['images/lora-cover.png', 'images/model-cover.png', 'images/template-cover.png']);
    assert.ok(deleted.body.data.cleanup_failures.every((failure) => failure.reason === 'owner_delete' && failure.occurred_at === NOW && failure.remove_error === 'disk unavailable' && failure.enqueue_error === 'queue persistence unavailable'));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 1').get().count, 0);
  } finally {
    database.close();
  }
});

test('底模 service 在 repository、事务、媒体清理依赖缺失时立即失败', () => {
  const database = { prepare() {}, exec() {} };
  const repository = {
    list() {}, get() {}, create() {}, update() {}, getImpact() {}, remove() {}
  };
  const mediaStorage = { remove() {} };
  const cleanupQueue = { enqueue() {}, recordFailure() {} };
  assert.throws(() => createBaseModelService({ repository, mediaStorage, cleanupQueue }), /prepare and exec/u);
  for (const name of Object.keys(repository)) {
    const incomplete = { ...repository };
    delete incomplete[name];
    assert.throws(() => createBaseModelService({ database, repository: incomplete, mediaStorage, cleanupQueue }), /repository is incomplete/u);
  }
  assert.throws(() => createBaseModelService({ database, repository, cleanupQueue }), /mediaStorage/u);
  assert.throws(() => createBaseModelService({ database, repository, mediaStorage }), /cleanupQueue/u);
});

test('底模 HTTP 完成创建、读取、完整更新、重复名映射和带 impact_token 的删除', async () => {
  const { database, dispatcher } = fixture();
  try {
    const created = await dispatch(dispatcher, 'POST', '/api/manage/base-models', { name: 'WAI' }, 'base-create');
    assert.equal(created.status, 201);
    assert.equal(created.body.data.name, 'WAI');
    const id = created.body.data.id;

    const detail = await dispatch(dispatcher, 'GET', `/api/manage/base-models/${id}`, undefined, 'base-detail');
    assert.deepEqual(detail.body.data, created.body.data);
    const updated = await dispatch(dispatcher, 'PUT', `/api/manage/base-models/${id}`, { name: 'WAI Updated' }, 'base-update');
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.name, 'WAI Updated');
    const duplicate = await dispatch(dispatcher, 'POST', '/api/manage/base-models', { name: 'WAI Updated' }, 'base-duplicate');
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'DUPLICATE_RESOURCE');

    const impact = await dispatch(dispatcher, 'GET', `/api/manage/base-models/${id}/delete-impact`, undefined, 'base-impact');
    const extraDeleteField = await dispatch(dispatcher, 'DELETE', `/api/manage/base-models/${id}`, { impact_token: impact.body.data.impact_token, confirm: true }, 'base-delete-extra');
    assert.equal(extraDeleteField.status, 422);
    const deleted = await dispatch(dispatcher, 'DELETE', `/api/manage/base-models/${id}`, { impact_token: impact.body.data.impact_token }, 'base-delete');
    assert.equal(deleted.status, 200);
    const missing = await dispatch(dispatcher, 'GET', `/api/manage/base-models/${id}`, undefined, 'base-missing');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
  } finally {
    database.close();
  }
});

test('底模影响预览在图谱变化后阻止删除，并分别返回级联删除与保留对象', async () => {
  const { database, dispatcher } = fixture({ cascade: true });
  try {
    const preview = await dispatch(dispatcher, 'GET', '/api/manage/base-models/1/delete-impact', undefined, 'base-impact-before');
    assert.equal(preview.status, 200);
    assert.equal(preview.body.data.target.id, 1);
    assert.deepEqual(preview.body.data.cascade_deleted.map((item) => item.kind), ['model', 'lora', 'template', 'image', 'image', 'image']);
    assert.deepEqual(preview.body.data.retained.map((item) => item.kind), ['artist_prompt_string']);

    database.prepare(`INSERT INTO generation_models
      (id, base_model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at)
      VALUES (11, 1, 'wai-v2.safetensors', 'safetensors', 'fp16', 'description', 'usage', ?, ?)`).run(NOW, NOW);
    const stale = await dispatch(dispatcher, 'DELETE', '/api/manage/base-models/1', { impact_token: preview.body.data.impact_token }, 'base-delete-stale');
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'DELETE_IMPACT_STALE');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 1').get().count, 1);

    const current = await dispatch(dispatcher, 'GET', '/api/manage/base-models/1/delete-impact', undefined, 'base-impact-current');
    const deleted = await dispatch(dispatcher, 'DELETE', '/api/manage/base-models/1', { impact_token: current.body.data.impact_token }, 'base-delete-cascade');
    assert.equal(deleted.status, 200);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_models WHERE base_model_id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras WHERE base_model_id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates WHERE base_model_id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT base_model_id FROM artist_prompt_strings WHERE id = 40').get().base_model_id, null);
  } finally {
    database.close();
  }
});
