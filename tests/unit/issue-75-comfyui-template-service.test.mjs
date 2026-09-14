import assert from 'node:assert/strict';
import test from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createComfyuiTemplateRepository } from '../../app/generation-resources/comfyui-template-repository.mjs';
import { createComfyuiTemplateService } from '../../app/generation-resources/comfyui-template-service.mjs';

const NOW = '2026-08-30T00:00:00.000Z';
const BASE_MODEL_ID = 9301;
const MODEL_ID = 9302;
const LORA_ID = 9303;
const SECOND_BASE_MODEL_ID = 9311;
const SECOND_MODEL_ID = 9312;
const SECOND_LORA_ID = 9313;

function workflow(marker = 'initial') {
  return {
    version: 1,
    state: {},
    nodes: [{
      id: 1,
      type: 'Issue75ServiceNode',
      pos: [0, 0],
      size: [1, 1],
      flags: {},
      order: 0,
      mode: 0,
      properties: { marker }
    }],
    extra: { marker }
  };
}

function writeRequest({ title = 'Service template', templateJson = workflow(), loraId = null, baseModelId = BASE_MODEL_ID, modelId = MODEL_ID } = {}) {
  return {
    base_model_id: baseModelId,
    model_id: modelId,
    lora_id: loraId,
    template_type: 'text_to_image',
    title,
    template_json: templateJson
  };
}

function seedEcosystems(database) {
  for (const [id, name] of [[BASE_MODEL_ID, 'Primary base'], [SECOND_BASE_MODEL_ID, 'Secondary base']]) {
    database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, name, NOW, NOW);
  }
  for (const [id, baseModelId, fileName] of [
    [MODEL_ID, BASE_MODEL_ID, 'primary.safetensors'],
    [SECOND_MODEL_ID, SECOND_BASE_MODEL_ID, 'secondary.safetensors']
  ]) {
    database.prepare(`INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (?, ?, ?, 'safetensors', 'fp16', 'description', 'usage', ?, ?)`).run(id, baseModelId, fileName, NOW, NOW);
  }
  for (const [id, baseModelId, modelId, fileName] of [
    [LORA_ID, BASE_MODEL_ID, MODEL_ID, 'primary-lora.safetensors'],
    [SECOND_LORA_ID, SECOND_BASE_MODEL_ID, SECOND_MODEL_ID, 'secondary-lora.safetensors']
  ]) {
    database.prepare(`INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'safetensors', 'fp16', 'description', 'usage', '[]', 1, ?, ?)`).run(
      id, baseModelId, modelId, fileName, NOW, NOW
    );
  }
}

function fixture({ mediaStorage = { remove() {} }, cleanupQueue = { enqueue() {}, recordFailure(entry) { return entry; } } } = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seedEcosystems(database);
  const repository = createComfyuiTemplateRepository(database);
  const service = createComfyuiTemplateService({
    database,
    repository,
    mediaStorage,
    cleanupQueue,
    now: () => new Date(NOW)
  });
  return { database, repository, service };
}

function assertApplicationError(error, code) {
  return error?.code === code;
}

test('ComfyUI 模板 service 直接维护当前 Workflow 并完成列表、读取和删除', () => {
  const removedPaths = [];
  const { database, repository, service } = fixture({ mediaStorage: { remove(path) { removedPaths.push(path); } } });
  try {
    const created = service.create(writeRequest());
    assert.equal(created.title, 'Service template');
    assert.deepEqual(created.template_json, workflow());
    assert.deepEqual(repository.getWorkflowSource(created.id), {
      id: created.id,
      title: 'Service template',
      workflow_json: workflow()
    });

    const sameWorkflow = service.update(created.id, writeRequest({ title: 'Metadata edit', loraId: LORA_ID }));
    assert.equal(sameWorkflow.lora_id, LORA_ID);

    const changedWorkflow = service.update(created.id, writeRequest({ title: 'Workflow edit', templateJson: workflow('changed'), loraId: LORA_ID }));
    assert.deepEqual(changedWorkflow.template_json, workflow('changed'));
    assert.deepEqual(repository.getWorkflowSource(created.id).workflow_json, workflow('changed'));
    assert.deepEqual(service.get(created.id), changedWorkflow);
    assert.equal(service.list({ page: 1, page_size: 10, q: '%_' }).total_count, 0);
    assert.equal(service.list({ page: 1, page_size: 10, q: 'Workflow', base_model_id: BASE_MODEL_ID, model_id: MODEL_ID, lora_id: LORA_ID }).total_count, 1);

    database.prepare(`INSERT INTO item_images(
      owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES ('template', ?, 'service-cover-hash', 'images/service-cover.png', 0, ?, ?)`).run(created.id, NOW, NOW);
    const impact = service.getDeleteImpact(created.id);
    assert.deepEqual(impact.cascade_deleted.map(({ kind, media_path: mediaPath }) => [kind, mediaPath]), [['image', 'images/service-cover.png']]);
    const deleted = service.delete(created.id, impact.impact_token);
    assert.equal(deleted.cleanup_warning, false);
    assert.deepEqual(deleted.cleanup_failures, []);
    assert.deepEqual(removedPaths, ['images/service-cover.png']);
    assert.equal(repository.get(created.id), null);
    assert.equal(repository.getWorkflowSource(created.id), null);
  } finally {
    database.close();
  }
});

test('ComfyUI 模板 service 拒绝无效 Workflow、跨生态关联、缺失记录和过期删除影响', () => {
  const { database, service } = fixture();
  try {
    assert.throws(() => service.create(writeRequest({ templateJson: { version: 2, nodes: [] } })), (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.deepEqual(error.details, { field: 'template_json', supported_versions: ['0.4', '1.0'] });
      return true;
    });
    assert.throws(
      () => service.create(writeRequest({ baseModelId: BASE_MODEL_ID, modelId: SECOND_MODEL_ID })),
      (error) => assertApplicationError(error, 'RELATION_CONFLICT')
    );
    assert.throws(
      () => service.create(writeRequest({ loraId: SECOND_LORA_ID })),
      (error) => assertApplicationError(error, 'RELATION_CONFLICT')
    );
    assert.throws(() => service.get(999999), (error) => assertApplicationError(error, 'NOT_FOUND'));
    assert.throws(() => service.getDeleteImpact(999999), (error) => assertApplicationError(error, 'NOT_FOUND'));
    assert.throws(() => service.delete(999999, '0'.repeat(64)), (error) => assertApplicationError(error, 'NOT_FOUND'));

    const created = service.create(writeRequest());
    assert.throws(
      () => service.delete(created.id, '0'.repeat(64)),
      (error) => assertApplicationError(error, 'DELETE_IMPACT_STALE')
    );
    assert.equal(service.get(created.id).id, created.id);
  } finally {
    database.close();
  }
});

test('ComfyUI 模板 service 在依赖不完整或时间源无效时立即失败', () => {
  const database = { prepare() {}, exec() {} };
  const repository = {
    list() {}, get() {}, modelInBase() {}, loraInEcosystem() {},
    create() {}, update() {}, getImpact() {}, remove() {}
  };
  const mediaStorage = { remove() {} };
  const cleanupQueue = { enqueue() {}, recordFailure() {} };

  assert.throws(() => createComfyuiTemplateService({ repository, mediaStorage, cleanupQueue }), /database must provide prepare and exec/u);
  for (const name of Object.keys(repository)) {
    const incomplete = { ...repository };
    delete incomplete[name];
    assert.throws(
      () => createComfyuiTemplateService({ database, repository: incomplete, mediaStorage, cleanupQueue }),
      /repository is incomplete/u
    );
  }
  assert.throws(() => createComfyuiTemplateService({ database, repository, cleanupQueue }), /mediaStorage must provide remove/u);
  assert.throws(() => createComfyuiTemplateService({ database, repository, mediaStorage }), /cleanupQueue must provide enqueue and recordFailure/u);
  assert.throws(() => createComfyuiTemplateService({ database, repository, mediaStorage, cleanupQueue, now: null }), /now must be a function/u);

  const invalidClock = createComfyuiTemplateService({
    database,
    repository,
    mediaStorage,
    cleanupQueue,
    now: () => new Date('invalid')
  });
  assert.throws(() => invalidClock.create(writeRequest()), /now must return a valid Date/u);
});
