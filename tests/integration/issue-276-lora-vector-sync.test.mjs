import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createLoraRepository } from '../../app/generation-resources/lora-repository.mjs';
import { createLoraService } from '../../app/generation-resources/lora-service.mjs';
import { createMaintenanceService } from '../../app/maintenance/maintenance-service.mjs';
import { ApplicationError } from '../../app/security/error-mapping.mjs';
import { createGenerationLoraVectorMaintenance } from '../../app/vector/generation-lora-semantic.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const CONFIGURATION = Object.freeze({ embedding_model: 'issue-276-embedding' });
const NOW = () => new Date('2026-08-22T00:00:00.000Z');
const LORA_WRITE = Object.freeze({
  base_model_id: 1,
  model_id: 2,
  file_name: 'issue-276-create.safetensors',
  file_format: 'safetensors',
  precision_or_quantization: 'fp16',
  author: null,
  version: null,
  release_url: null,
  description: 'a creation fixture',
  usage: 'use this creation fixture',
  trigger_words: Object.freeze(['creation']),
  weight: 0.8
});

function seedGenerationModel(database) {
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)')
    .run('Issue 276 base', NOW().toISOString(), NOW().toISOString());
  database.prepare(`INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, skill_name, created_at, updated_at
    ) VALUES (2, 1, ?, 'safetensors', 'fp16', 'model description', 'model usage', NULL, ?, ?)`)
    .run('issue-276-model.safetensors', NOW().toISOString(), NOW().toISOString());
}

function createFixture({ onEmbed = null, embedError = null } = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seedGenerationModel(database);
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (3, ?, ?, ?)')
    .run('Issue 276 drift base', NOW().toISOString(), NOW().toISOString());
  const calls = [];
  const state = { embedError };
  const modelClient = {
    async embed(inputs) {
      calls.push([...inputs]);
      await onEmbed?.({ database, calls, inputs });
      if (state.embedError !== null) throw new ApplicationError(state.embedError, `${state.embedError} fixture`);
      return inputs.map(() => calls.length === 1 ? createFixtureVector(3, 4) : createFixtureVector(4, 3));
    }
  };
  const vectorMaintenance = createGenerationLoraVectorMaintenance({ database, modelClient, configuration: CONFIGURATION, now: NOW });
  const service = createLoraService({
    database,
    repository: createLoraRepository(database),
    mediaStorage: { remove() {} },
    cleanupQueue: { enqueue() {}, recordFailure() {} },
    vectorMaintenance,
    now: NOW
  });
  return { database, service, calls, setEmbedError: (code) => { state.embedError = code; } };
}

test('LoRA 创建在同一事务提交原始记录、首条向量和实际向量空间配置', async () => {
  const { database, service, calls } = createFixture();
  try {
    const created = await service.create(LORA_WRITE);

    assert.equal(calls.length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, 1);
    assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'generation_lora'").get() }, {
      embedding_model: CONFIGURATION.embedding_model,
      dimension: 1024
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(created.id).count, 1);
  } finally {
    database.close();
  }
});

test('LoRA 完整更新重新生成并在同一事务替换旧向量', async () => {
  const { database, service, calls } = createFixture();
  try {
    const created = await service.create(LORA_WRITE);
    const before = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(created.id).embedding_f32);

    const updated = await service.update(created.id, {
      ...LORA_WRITE,
      file_name: 'issue-276-updated.safetensors',
      description: 'an updated fixture',
      usage: 'use the updated fixture',
      trigger_words: ['updated']
    });

    const after = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(updated.id).embedding_f32);
    assert.equal(calls.length, 2);
    assert.equal(updated.file_name, 'issue-276-updated.safetensors');
    assert.notDeepEqual(after, before);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(updated.id).count, 1);
  } finally {
    database.close();
  }
});

test('LoRA 创建在 Embedding 后模型归属漂移时拒绝写入业务记录和向量', async () => {
  const { database, service, calls } = createFixture({
    onEmbed: ({ database: currentDatabase }) => {
      currentDatabase.prepare('UPDATE generation_models SET base_model_id = 3 WHERE id = 2').run();
    }
  });
  try {
    await assert.rejects(() => service.create(LORA_WRITE), (error) => error?.code === 'RELATION_CONFLICT');
    assert.equal(calls.length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora'").get().count, 0);
    assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'generation_lora'").get() }, {
      embedding_model: '__unconfigured__',
      dimension: 1
    });
  } finally {
    database.close();
  }
});

test('LoRA 完整更新在 Embedding 后目标记录漂移时保留业务记录和旧向量', async () => {
  const { database, service, calls } = createFixture({
    onEmbed: ({ database: currentDatabase, calls: currentCalls }) => {
      if (currentCalls.length === 2) {
        currentDatabase.prepare('UPDATE generation_loras SET description = ?, updated_at = ? WHERE id = 1')
          .run('concurrent update', '2026-08-22T00:00:01.000Z');
      }
    }
  });
  try {
    const created = await service.create(LORA_WRITE);
    const before = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(created.id).embedding_f32);

    await assert.rejects(() => service.update(created.id, {
      ...LORA_WRITE,
      file_name: 'issue-276-drifted-update.safetensors',
      description: 'must not replace concurrent update'
    }), (error) => error?.code === 'RELATION_CONFLICT');

    const current = database.prepare('SELECT file_name, description FROM generation_loras WHERE id = ?').get(created.id);
    const after = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(created.id).embedding_f32);
    assert.equal(calls.length, 2);
    assert.equal(current.file_name, LORA_WRITE.file_name);
    assert.equal(current.description, 'concurrent update');
    assert.deepEqual(after, before);
  } finally {
    database.close();
  }
});

test('LoRA 创建透传固定 Embedding 错误且不写入业务记录或首条向量空间', async (t) => {
  for (const code of ['EMBEDDING_UNAVAILABLE', 'MODEL_RATE_LIMITED', 'EMBEDDING_TIMEOUT', 'MODEL_PROTOCOL_ERROR']) {
    await t.test(code, async () => {
      const { database, service, calls } = createFixture({ embedError: code });
      try {
        await assert.rejects(() => service.create(LORA_WRITE), (error) => error?.code === code);
        assert.equal(calls.length, 1);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora'").get().count, 0);
        assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'generation_lora'").get() }, {
          embedding_model: '__unconfigured__',
          dimension: 1
        });
      } finally {
        database.close();
      }
    });
  }
});

test('LoRA 更新 Embedding 失败时保留旧业务记录和旧向量', async () => {
  const { database, service, calls, setEmbedError } = createFixture();
  try {
    const created = await service.create(LORA_WRITE);
    const beforeRecord = { ...database.prepare('SELECT file_name, description, usage, trigger_words_json, weight FROM generation_loras WHERE id = ?').get(created.id) };
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(created.id).embedding_f32);
    setEmbedError('EMBEDDING_TIMEOUT');

    await assert.rejects(() => service.update(created.id, {
      ...LORA_WRITE,
      file_name: 'issue-276-embedding-failure.safetensors',
      description: 'must not persist'
    }), (error) => error?.code === 'EMBEDDING_TIMEOUT');

    assert.equal(calls.length, 2);
    assert.deepEqual({ ...database.prepare('SELECT file_name, description, usage, trigger_words_json, weight FROM generation_loras WHERE id = ?').get(created.id) }, beforeRecord);
    assert.deepEqual(Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(created.id).embedding_f32), beforeVector);
  } finally {
    database.close();
  }
});

test('LoRA 向量 SQL 失败时回滚业务写入和向量空间配置', async () => {
  const { database, service, calls } = createFixture();
  try {
    database.exec(`CREATE TRIGGER issue_276_lora_vector_insert_failure
      BEFORE INSERT ON vector_entries
      WHEN NEW.object_kind = 'generation_lora'
      BEGIN SELECT RAISE(ABORT, 'issue 276 vector SQL failure'); END;`);

    await assert.rejects(() => service.create(LORA_WRITE), /issue 276 vector SQL failure/u);
    assert.equal(calls.length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'generation_lora'").get().count, 0);
    assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'generation_lora'").get() }, {
      embedding_model: '__unconfigured__',
      dimension: 1
    });
  } finally {
    database.close();
  }
});

test('LoRA 更新向量 SQL 失败时保留旧业务记录和旧向量', async () => {
  const { database, service } = createFixture();
  try {
    const created = await service.create(LORA_WRITE);
    const beforeRecord = { ...database.prepare('SELECT file_name, description, usage, trigger_words_json, weight FROM generation_loras WHERE id = ?').get(created.id) };
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(created.id).embedding_f32);
    database.exec(`CREATE TRIGGER issue_276_lora_vector_update_failure
      BEFORE INSERT ON vector_entries
      WHEN NEW.object_kind = 'generation_lora'
      BEGIN SELECT RAISE(ABORT, 'issue 276 vector update SQL failure'); END;`);

    await assert.rejects(() => service.update(created.id, { ...LORA_WRITE, file_name: 'issue-276-vector-update-failure.safetensors' }), /issue 276 vector update SQL failure/u);
    assert.deepEqual({ ...database.prepare('SELECT file_name, description, usage, trigger_words_json, weight FROM generation_loras WHERE id = ?').get(created.id) }, beforeRecord);
    assert.deepEqual(Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(created.id).embedding_f32), beforeVector);
  } finally {
    database.close();
  }
});

test('LoRA 重复记录写入返回 DUPLICATE_RESOURCE 且不增加业务记录或向量', async () => {
  const { database, service, calls } = createFixture();
  try {
    const created = await service.create(LORA_WRITE);
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(created.id).embedding_f32);

    await assert.rejects(() => service.create(LORA_WRITE), (error) => error?.code === 'DUPLICATE_RESOURCE');
    const afterVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'generation_lora' AND object_id = ?").get(created.id).embedding_f32);
    assert.equal(calls.length, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_loras').get().count, 1);
    assert.deepEqual(afterVector, beforeVector);
  } finally {
    database.close();
  }
});

test('LoRA 封面上传、主封面选择、图片排序和图片删除不调用 Embedding', async () => {
  const { database, service, calls } = createFixture();
  try {
    const created = await service.create(LORA_WRITE);
    database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (501, 'lora', ?, 'issue-276-media-501', 'images/issue-276-501.png', 0, ?, ?),
      (502, 'lora', ?, 'issue-276-media-502', 'images/issue-276-502.png', 1, ?, ?)`)
      .run(created.id, NOW().toISOString(), NOW().toISOString(), created.id, NOW().toISOString(), NOW().toISOString());
    const maintenance = createMaintenanceService({
      database,
      mediaStorage: {
        stageFiles(files) {
          return files.map((file, index) => ({ content_hash: `issue-276-upload-${index}`, media_path: `images/${file.name}` }));
        },
        commit() {},
        discard() {},
        remove() {}
      },
      now: NOW
    });

    const uploaded = maintenance.uploadImages('lora', created.id, [{ name: 'issue-276-upload.png' }]);
    maintenance.setCover('lora', created.id, { id: 501 });
    maintenance.reorderImages('lora', created.id, { ids: uploaded.images.map(({ id }) => id).reverse() });
    maintenance.deleteImage('lora', created.id, uploaded.images.find(({ media_path }) => media_path === 'images/issue-276-upload.png').id);

    assert.equal(calls.length, 1);
    assert.equal(database.prepare('SELECT cover_media_path FROM generation_loras WHERE id = ?').get(created.id).cover_media_path, 'images/issue-276-501.png');
  } finally {
    database.close();
  }
});
