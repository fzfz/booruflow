import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createBaseModelRepository } from '../../app/generation-resources/base-model-repository.mjs';
import { createBaseModelService } from '../../app/generation-resources/base-model-service.mjs';
import { createFileCleanupQueue } from '../../app/maintenance/file-cleanup-queue.mjs';
import { createMediaStorage } from '../../app/media/media-storage.mjs';

const NOW = '2026-08-02T00:00:00Z';
const CASCADED_MEDIA_PATHS = ['images/model.png', 'images/lora.png', 'images/template.png'];

function seedGraph(database) {
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('WAI', NOW, NOW);
  database.prepare(`INSERT INTO generation_models(id, base_model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at)
    VALUES (10, 1, 'wai.safetensors', 'safetensors', 'fp16', 'description', 'usage', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO generation_loras(id, base_model_id, model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at)
    VALUES (20, 1, 10, 'style.safetensors', 'safetensors', 'fp16', 'description', 'usage', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO comfyui_templates(id, base_model_id, model_id, lora_id, template_type, title, template_json, created_at, updated_at)
    VALUES (30, 1, 10, 20, 'text_to_image', 'WAI template', '{}', ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO artist_prompt_strings(id, title, description, artist_string, base_model_id, created_at, updated_at)
    VALUES (40, 'Retained artist', 'description', 'artist_a:1.0', 1, ?, ?)`).run(NOW, NOW);
  for (const [id, ownerKind, ownerId, mediaPath] of [[100, 'model', 10, CASCADED_MEDIA_PATHS[0]], [101, 'lora', 20, CASCADED_MEDIA_PATHS[1]], [102, 'template', 30, CASCADED_MEDIA_PATHS[2]]]) {
    database.prepare(`INSERT INTO item_images(id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(id, ownerKind, ownerId, `hash-${id}`, mediaPath, NOW, NOW);
  }
}

function service(database, mediaStorage, cleanupQueue) {
  return createBaseModelService({
    database,
    repository: createBaseModelRepository(database),
    mediaStorage,
    cleanupQueue,
    now: () => new Date(NOW)
  });
}

test('底模删除在提交后删除级联资源图片文件，不生成清理警告', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-base-model-media-success-'));
  const database = openCatalogDatabase();
  try {
    seedGraph(database);
    const mediaStorage = createMediaStorage({ mediaRoot: join(directory, 'media') });
    for (const mediaPath of CASCADED_MEDIA_PATHS) {
      const target = mediaStorage.pathFor(mediaPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(mediaPath));
    }
    const queued = [];
    const baseModels = service(database, mediaStorage, { enqueue(entry) { queued.push(entry); }, recordFailure() { throw new Error('unexpected cleanup audit'); } });
    const impact = baseModels.getDeleteImpact(1);
    const deleted = baseModels.delete(1, impact.impact_token);
    assert.equal(deleted.cleanup_warning, false);
    assert.deepEqual(queued, []);
    for (const mediaPath of CASCADED_MEDIA_PATHS) assert.equal(existsSync(mediaStorage.pathFor(mediaPath)), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id IN (100, 101, 102)').get().count, 0);
    assert.equal(database.prepare('SELECT base_model_id FROM artist_prompt_strings WHERE id = 40').get().base_model_id, null);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('底模提交删除成功后，文件清理失败会入队并返回 cleanup_warning', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-base-model-media-queue-'));
  const database = openCatalogDatabase();
  try {
    seedGraph(database);
    const cleanupQueue = createFileCleanupQueue({ queuePath: join(directory, 'file-cleanup.json'), mediaRoot: join(directory, 'media') });
    const baseModels = service(database, { remove() { throw new Error('disk unavailable'); } }, cleanupQueue);
    const impact = baseModels.getDeleteImpact(1);
    const deleted = baseModels.delete(1, impact.impact_token);
    assert.equal(deleted.cleanup_warning, true);
    assert.deepEqual(cleanupQueue.read().entries.map((entry) => [entry.path, entry.reason]).sort(), CASCADED_MEDIA_PATHS.map((path) => [path, 'owner_delete']).sort());
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id IN (100, 101, 102)').get().count, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('底模提交删除后，文件删除与清理队列写入同时失败时保留可追溯告警且不回滚数据库提交', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-base-model-media-audit-'));
  const database = openCatalogDatabase();
  try {
    seedGraph(database);
    const durableQueue = createFileCleanupQueue({ queuePath: join(directory, 'file-cleanup.json'), mediaRoot: join(directory, 'media'), now: () => new Date(NOW) });
    const baseModels = service(database, { remove() { throw new Error('disk unavailable'); } }, { ...durableQueue, enqueue() { throw new Error('queue persistence unavailable'); } });
    const impact = baseModels.getDeleteImpact(1);
    const deleted = baseModels.delete(1, impact.impact_token);

    assert.equal(deleted.cleanup_warning, true);
    assert.deepEqual([...deleted.cleanup_failures].sort((left, right) => left.path.localeCompare(right.path)), CASCADED_MEDIA_PATHS.map((path) => ({
      path,
      reason: 'owner_delete',
      occurred_at: NOW,
      remove_error: 'disk unavailable',
      enqueue_error: 'queue persistence unavailable'
    })).sort((left, right) => left.path.localeCompare(right.path)));
    const restartedQueue = createFileCleanupQueue({ queuePath: durableQueue.queuePath, mediaRoot: durableQueue.mediaRoot, now: () => new Date(NOW) });
    assert.deepEqual(restartedQueue.read().audit_failures, deleted.cleanup_failures);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM generation_base_models WHERE id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id IN (100, 101, 102)').get().count, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('清理审计记录在 enqueue、drain 和重启读取后始终保留', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-base-model-audit-retain-'));
  try {
    const queue = createFileCleanupQueue({ queuePath: join(directory, 'file-cleanup.json'), mediaRoot: join(directory, 'media'), now: () => new Date(NOW) });
    const failure = queue.recordFailure({ path: 'images/audit.png', reason: 'owner_delete', remove_error: 'remove failed', enqueue_error: 'enqueue failed' });
    queue.enqueue({ path: 'images/queued.png', reason: 'owner_delete' });
    queue.drain(() => {});
    const restartedQueue = createFileCleanupQueue({ queuePath: queue.queuePath, mediaRoot: queue.mediaRoot, now: () => new Date(NOW) });
    assert.deepEqual(restartedQueue.read(), { queue_version: 1, updated_at: NOW, entries: [], audit_failures: [failure] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('清理审计也写入失败时，删除结果明确携带 audit_error 而不伪称已持久化', () => {
  const database = openCatalogDatabase();
  try {
    seedGraph(database);
    const baseModels = service(database, { remove() { throw new Error('disk unavailable'); } }, {
      enqueue() { throw new Error('queue persistence unavailable'); },
      recordFailure() { throw new Error('audit persistence unavailable'); }
    });
    const deleted = baseModels.delete(1, baseModels.getDeleteImpact(1).impact_token);
    assert.equal(deleted.cleanup_warning, true);
    assert.ok(deleted.cleanup_failures.every((failure) => failure.audit_error === 'audit persistence unavailable'));
    assert.ok(deleted.cleanup_failures.every((failure) => failure.reason === 'owner_delete' && typeof failure.occurred_at === 'string'));
  } finally {
    database.close();
  }
});
