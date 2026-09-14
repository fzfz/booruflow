import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createBaseModelRepository } from '../../app/generation-resources/base-model-repository.mjs';
import { createBaseModelService } from '../../app/generation-resources/base-model-service.mjs';
import { createArtistPromptStringRepository } from '../../app/generation-resources/artist-prompt-string-repository.mjs';
import { createArtistPromptStringService } from '../../app/generation-resources/artist-prompt-string-service.mjs';
import { createMaintenanceService } from '../../app/maintenance/maintenance-service.mjs';
import { ApplicationError } from '../../app/security/error-mapping.mjs';
import { createArtistPromptStringVectorMaintenance } from '../../app/vector/artist-prompt-string-semantic.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const CONFIGURATION = Object.freeze({ embedding_model: 'issue-276-artist-embedding' });
const NOW = () => new Date('2026-08-22T00:00:00.000Z');
const ARTIST_WRITE = Object.freeze({
  title: 'Issue 276 artist',
  description: 'an artist string fixture',
  artist_string: 'issue_276_artist:1.0',
  base_model_id: 1,
  style_ids: Object.freeze([101, 102])
});

function seedArtistRelations(database) {
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)')
    .run('Issue 276 artist base', NOW().toISOString(), NOW().toISOString());
  for (const [id, name] of [[101, 'Issue 276 style one'], [102, 'Issue 276 style two']]) {
    database.prepare(`INSERT INTO styles(
        id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
      ) VALUES (?, 1, ?, '[]', ?, NULL, NULL)`)
      .run(id, name, `${name} prompt`);
  }
}

function createFixture({ onEmbed = null, embedError = null } = {}) {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  seedArtistRelations(database);
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
  const vectorMaintenance = createArtistPromptStringVectorMaintenance({ database, modelClient, configuration: CONFIGURATION, now: NOW });
  const service = createArtistPromptStringService({
    database,
    repository: createArtistPromptStringRepository(database),
    mediaStorage: { remove() {} },
    cleanupQueue: { enqueue() {}, recordFailure() {} },
    vectorMaintenance,
    now: NOW
  });
  return { database, service, calls, setEmbedError: (code) => { state.embedError = code; } };
}

test('画师串创建在同一事务提交原始记录、Style 关系、首条向量和实际向量空间配置', async () => {
  const { database, service, calls } = createFixture();
  try {
    const created = await service.create(ARTIST_WRITE);

    assert.equal(calls.length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, 1);
    assert.deepEqual(database.prepare('SELECT style_id FROM artist_prompt_string_styles WHERE artist_prompt_string_id = ? ORDER BY style_id').all(created.id).map(({ style_id: styleId }) => styleId), [101, 102]);
    assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'artist_prompt_string'").get() }, {
      embedding_model: CONFIGURATION.embedding_model,
      dimension: 1024
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).count, 1);
  } finally {
    database.close();
  }
});

test('画师串完整更新在 Embedding 后目标记录漂移时保留业务记录、Style 关系和旧向量', async () => {
  const { database, service, calls } = createFixture({
    onEmbed: ({ database: currentDatabase, calls: currentCalls }) => {
      if (currentCalls.length === 2) {
        currentDatabase.prepare('UPDATE artist_prompt_strings SET description = ?, updated_at = ? WHERE id = 1')
          .run('concurrent artist update', '2026-08-22T00:00:01Z');
      }
    }
  });
  try {
    const created = await service.create(ARTIST_WRITE);
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32);

    await assert.rejects(() => service.update(created.id, {
      ...ARTIST_WRITE,
      title: 'Issue 276 updated',
      description: 'must not replace concurrent update'
    }), (error) => error?.code === 'RELATION_CONFLICT');

    const current = database.prepare('SELECT title, description FROM artist_prompt_strings WHERE id = ?').get(created.id);
    const afterVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32);
    assert.equal(calls.length, 2);
    assert.equal(current.title, ARTIST_WRITE.title);
    assert.equal(current.description, 'concurrent artist update');
    assert.deepEqual(database.prepare('SELECT style_id FROM artist_prompt_string_styles WHERE artist_prompt_string_id = ? ORDER BY style_id').all(created.id).map(({ style_id: styleId }) => styleId), [...ARTIST_WRITE.style_ids]);
    assert.deepEqual(afterVector, beforeVector);
  } finally {
    database.close();
  }
});

test('画师串创建在 Embedding 后底模关系漂移时拒绝提交', async () => {
  const { database, service, calls } = createFixture({
    onEmbed: ({ database: currentDatabase }) => {
      currentDatabase.prepare('DELETE FROM styles WHERE base_model_id = 1').run();
      currentDatabase.prepare('DELETE FROM generation_base_models WHERE id = 1').run();
    }
  });
  try {
    await assert.rejects(() => service.create({ ...ARTIST_WRITE, style_ids: [] }), (error) => error?.code === 'RELATION_CONFLICT');
    assert.equal(calls.length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'artist_prompt_string'").get().count, 0);
    assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'artist_prompt_string'").get() }, {
      embedding_model: '__unconfigured__',
      dimension: 1
    });
  } finally {
    database.close();
  }
});

test('画师串完整更新在 Embedding 后 Style 关系漂移时拒绝提交', async () => {
  const { database, service, calls } = createFixture({
    onEmbed: ({ database: currentDatabase, calls: currentCalls }) => {
      if (currentCalls.length === 2) {
        currentDatabase.prepare('DELETE FROM artist_prompt_string_styles WHERE artist_prompt_string_id = ? AND style_id = ?').run(1, 102);
      }
    }
  });
  try {
    const created = await service.create(ARTIST_WRITE);
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32);

    await assert.rejects(() => service.update(created.id, {
      ...ARTIST_WRITE,
      description: 'must not replace changed style relation'
    }), (error) => error?.code === 'RELATION_CONFLICT');

    assert.equal(calls.length, 2);
    assert.deepEqual(database.prepare('SELECT style_id FROM artist_prompt_string_styles WHERE artist_prompt_string_id = ? ORDER BY style_id').all(created.id).map(({ style_id: styleId }) => styleId), [101]);
    assert.deepEqual(Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32), beforeVector);
  } finally {
    database.close();
  }
});

test('画师串完整更新重新生成并在同一事务替换 Style 关系与旧向量', async () => {
  const { database, service, calls } = createFixture();
  try {
    const created = await service.create(ARTIST_WRITE);
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32);

    const updated = await service.update(created.id, {
      ...ARTIST_WRITE,
      title: 'Issue 276 revised',
      description: 'an updated artist string fixture',
      artist_string: 'issue_276_revised:0.8',
      style_ids: [102]
    });

    const afterVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(updated.id).embedding_f32);
    assert.equal(calls.length, 2);
    assert.equal(updated.title, 'Issue 276 revised');
    assert.deepEqual(updated.style_ids, [102]);
    assert.notDeepEqual(afterVector, beforeVector);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(updated.id).count, 1);
  } finally {
    database.close();
  }
});

test('画师串创建透传固定 Embedding 错误且不写入业务记录或首条向量空间', async (t) => {
  for (const code of ['EMBEDDING_UNAVAILABLE', 'MODEL_RATE_LIMITED', 'EMBEDDING_TIMEOUT', 'MODEL_PROTOCOL_ERROR']) {
    await t.test(code, async () => {
      const { database, service, calls } = createFixture({ embedError: code });
      try {
        await assert.rejects(() => service.create(ARTIST_WRITE), (error) => error?.code === code);
        assert.equal(calls.length, 1);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM artist_prompt_string_styles").get().count, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'artist_prompt_string'").get().count, 0);
        assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'artist_prompt_string'").get() }, {
          embedding_model: '__unconfigured__',
          dimension: 1
        });
      } finally {
        database.close();
      }
    });
  }
});

test('画师串更新 Embedding 失败时保留旧业务记录、旧 Style 关系和旧向量', async () => {
  const { database, service, calls, setEmbedError } = createFixture();
  try {
    const created = await service.create(ARTIST_WRITE);
    const beforeRecord = { ...database.prepare('SELECT title, description, artist_string, base_model_id FROM artist_prompt_strings WHERE id = ?').get(created.id) };
    const beforeStyles = database.prepare('SELECT style_id FROM artist_prompt_string_styles WHERE artist_prompt_string_id = ? ORDER BY style_id').all(created.id).map(({ style_id: styleId }) => styleId);
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32);
    setEmbedError('EMBEDDING_TIMEOUT');

    await assert.rejects(() => service.update(created.id, {
      ...ARTIST_WRITE,
      title: 'Issue 276 failed',
      description: 'must not persist after embedding failure',
      style_ids: [102]
    }), (error) => error?.code === 'EMBEDDING_TIMEOUT');

    assert.equal(calls.length, 2);
    assert.deepEqual({ ...database.prepare('SELECT title, description, artist_string, base_model_id FROM artist_prompt_strings WHERE id = ?').get(created.id) }, beforeRecord);
    assert.deepEqual(database.prepare('SELECT style_id FROM artist_prompt_string_styles WHERE artist_prompt_string_id = ? ORDER BY style_id').all(created.id).map(({ style_id: styleId }) => styleId), beforeStyles);
    assert.deepEqual(Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32), beforeVector);
  } finally {
    database.close();
  }
});

test('画师串向量 SQL 失败时回滚业务写入、Style 关系和向量空间配置', async () => {
  const { database, service, calls } = createFixture();
  try {
    database.exec(`CREATE TRIGGER issue_276_artist_vector_insert_failure
      BEFORE INSERT ON vector_entries
      WHEN NEW.object_kind = 'artist_prompt_string'
      BEGIN SELECT RAISE(ABORT, 'issue 276 artist vector SQL failure'); END;`);

    await assert.rejects(() => service.create(ARTIST_WRITE), /issue 276 artist vector SQL failure/u);
    assert.equal(calls.length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_string_styles').get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'artist_prompt_string'").get().count, 0);
    assert.deepEqual({ ...database.prepare("SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = 'artist_prompt_string'").get() }, {
      embedding_model: '__unconfigured__',
      dimension: 1
    });
  } finally {
    database.close();
  }
});

test('画师串更新向量 SQL 失败时保留旧业务记录、旧 Style 关系和旧向量', async () => {
  const { database, service } = createFixture();
  try {
    const created = await service.create(ARTIST_WRITE);
    const beforeRecord = { ...database.prepare('SELECT title, description, artist_string, base_model_id FROM artist_prompt_strings WHERE id = ?').get(created.id) };
    const beforeStyles = database.prepare('SELECT style_id FROM artist_prompt_string_styles WHERE artist_prompt_string_id = ? ORDER BY style_id').all(created.id).map(({ style_id: styleId }) => styleId);
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32);
    database.exec(`CREATE TRIGGER issue_276_artist_vector_update_failure
      BEFORE INSERT ON vector_entries
      WHEN NEW.object_kind = 'artist_prompt_string'
      BEGIN SELECT RAISE(ABORT, 'issue 276 artist vector update SQL failure'); END;`);

    await assert.rejects(() => service.update(created.id, {
      ...ARTIST_WRITE,
      title: 'Issue 276 fail',
      description: 'must not persist after vector SQL failure',
      style_ids: [102]
    }), /issue 276 artist vector update SQL failure/u);

    assert.deepEqual({ ...database.prepare('SELECT title, description, artist_string, base_model_id FROM artist_prompt_strings WHERE id = ?').get(created.id) }, beforeRecord);
    assert.deepEqual(database.prepare('SELECT style_id FROM artist_prompt_string_styles WHERE artist_prompt_string_id = ? ORDER BY style_id').all(created.id).map(({ style_id: styleId }) => styleId), beforeStyles);
    assert.deepEqual(Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32), beforeVector);
  } finally {
    database.close();
  }
});

test('base_model_id=null 的全局画师串可创建和完整更新并同步向量', async () => {
  const { database, service, calls } = createFixture();
  try {
    const created = await service.create({ ...ARTIST_WRITE, base_model_id: null });
    assert.equal(created.base_model_id, null);
    assert.deepEqual(created.style_ids, [...ARTIST_WRITE.style_ids]);

    const updated = await service.update(created.id, {
      ...ARTIST_WRITE,
      base_model_id: null,
      title: 'Issue 276 global',
      artist_string: 'issue_276_global:0.7',
      style_ids: []
    });

    assert.equal(calls.length, 2);
    assert.equal(updated.base_model_id, null);
    assert.deepEqual(updated.style_ids, []);
    assert.equal(database.prepare('SELECT base_model_id FROM artist_prompt_strings WHERE id = ?').get(created.id).base_model_id, null);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).count, 1);
  } finally {
    database.close();
  }
});

test('删除画师串所属底模沿用数据库 SET NULL 行为且不生成新的 Embedding', async () => {
  const { database, service, calls } = createFixture();
  try {
    const created = await service.create({ ...ARTIST_WRITE, style_ids: [] });
    database.prepare('DELETE FROM styles WHERE base_model_id = 1').run();
    const baseModelService = createBaseModelService({
      database,
      repository: createBaseModelRepository(database),
      mediaStorage: { remove() {} },
      cleanupQueue: { enqueue() {}, recordFailure() {} },
      now: NOW
    });
    const impact = baseModelService.getDeleteImpact(1);
    baseModelService.delete(1, impact.impact_token);

    assert.equal(calls.length, 1);
    assert.equal(database.prepare('SELECT base_model_id FROM artist_prompt_strings WHERE id = ?').get(created.id).base_model_id, null);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).count, 1);
  } finally {
    database.close();
  }
});

test('画师串媒体上传、主封面选择、图片排序和图片删除不调用 Embedding', async () => {
  const { database, service, calls } = createFixture();
  try {
    const created = await service.create({ ...ARTIST_WRITE, style_ids: [] });
    const maintenance = createMaintenanceService({
      database,
      mediaStorage: {
        stageFiles(files) {
          return files.map((file, index) => ({ content_hash: `issue-276-artist-upload-${index}`, media_path: `images/${file.name}` }));
        },
        commit() {},
        discard() {},
        remove() {}
      },
      now: NOW
    });

    const uploaded = maintenance.uploadImages('artist_prompt_string', created.id, [{ name: 'issue-276-artist-one.png' }, { name: 'issue-276-artist-two.png' }]);
    const [first, second] = uploaded.images;
    maintenance.setCover('artist_prompt_string', created.id, { id: first.id });
    maintenance.reorderImages('artist_prompt_string', created.id, { ids: [second.id, first.id] });
    maintenance.deleteImage('artist_prompt_string', created.id, second.id);

    assert.equal(calls.length, 1);
    assert.equal(database.prepare('SELECT cover_media_path FROM artist_prompt_strings WHERE id = ?').get(created.id).cover_media_path, first.media_path);
  } finally {
    database.close();
  }
});

test('画师串重复记录写入返回 DUPLICATE_RESOURCE 且不增加业务记录或向量', async () => {
  const { database, service, calls } = createFixture();
  try {
    const created = await service.create(ARTIST_WRITE);
    const beforeVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32);

    await assert.rejects(() => service.create(ARTIST_WRITE), (error) => error?.code === 'DUPLICATE_RESOURCE');
    const afterVector = Buffer.from(database.prepare("SELECT embedding_f32 FROM vector_entries WHERE object_kind = 'artist_prompt_string' AND object_id = ?").get(created.id).embedding_f32);
    assert.equal(calls.length, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, 1);
    assert.deepEqual(afterVector, beforeVector);
    assert.deepEqual(database.prepare('SELECT style_id FROM artist_prompt_string_styles WHERE artist_prompt_string_id = ? ORDER BY style_id').all(created.id).map(({ style_id: styleId }) => styleId), [...ARTIST_WRITE.style_ids]);
  } finally {
    database.close();
  }
});
