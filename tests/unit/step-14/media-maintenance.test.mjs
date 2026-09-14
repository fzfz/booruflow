import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFixtureVector } from '../../fixtures/vector/fake-semantic-model-client.mjs';

import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { createFileCleanupQueue } from '../../../app/maintenance/file-cleanup-queue.mjs';
import { createMaintenanceService } from '../../../app/maintenance/maintenance-service.mjs';
import { createMediaMaintenanceTask } from '../../../app/maintenance/media-maintenance-task.mjs';
import { createMediaStorage } from '../../../app/media/media-storage.mjs';
import { createCatalogImporter } from '../../../app/ingest/manual-ingest.mjs';

const NOW = '2026-08-01T00:00:00Z';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1, 229, 39, 212, 162, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const VECTOR_CONFIGURATION = Object.freeze({ embedding_model: 'fake' });
const MODEL_CLIENT = Object.freeze({ async embed(inputs) { return inputs.map(() => createFixtureVector()); } });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'noobai-media-maintenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = openCatalogDatabase();
  t.after(() => database.close());
  const mediaRoot = join(root, 'media');
  const mediaStorage = createMediaStorage({ mediaRoot });
  const cleanupQueue = createFileCleanupQueue({
    queuePath: join(root, 'file-cleanup.json'), mediaRoot, repositoryRoot: join(import.meta.dirname, '../../..'), now: () => new Date(NOW)
  });
  return { root, database, mediaStorage, cleanupQueue };
}

test('后台媒体任务把数据库缺失文件、孤儿文件和已知清理结果写入可追溯报告', (t) => {
  const { root, database, mediaStorage, cleanupQueue } = fixture(t);
  const [stored] = mediaStorage.stageFiles([{ bytes: PNG, media_type: 'image/png' }]);
  mediaStorage.commit([stored]);
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
    VALUES (1, 'Work', 'work', '[]', 1, ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO item_images(owner_kind, owner_id, source_id, source_url, content_hash, media_path, sort_order, created_at, updated_at)
    VALUES ('work', 1, NULL, NULL, ?, ?, 0, ?, ?)`).run(stored.content_hash, stored.media_path, NOW, NOW);
  mediaStorage.remove(stored.media_path);
  const [orphan] = mediaStorage.stageFiles([{ bytes: PNG, media_type: 'image/png' }]);
  mediaStorage.commit([orphan]);
  cleanupQueue.enqueue({ path: orphan.media_path, reason: 'image_delete' });

  const task = createMediaMaintenanceTask({
    database, mediaStorage, cleanupQueue, reportRoot: join(root, 'reports'), now: () => new Date(NOW)
  });
  const report = task.run();

  assert.deepEqual(report.database_relations.missing_media_paths, [stored.media_path]);
  assert.deepEqual(report.file_system.orphan_media_paths, []);
  assert.deepEqual(report.cleanup.completed_paths, [orphan.media_path]);
  assert.equal(report.status, 'attention_required');
  assert.equal(existsSync(join(root, 'reports', 'media-maintenance-latest.json')), true);
  assert.deepEqual(cleanupQueue.read().entries, []);
});

test('管理写入只把已知清理失败加入队列，不启动完整性扫描', (t) => {
  const { database, mediaStorage, cleanupQueue } = fixture(t);
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
    VALUES (1, 'Work', 'work', '[]', 1, ?, ?)`).run(NOW, NOW);
  const storageWithFailedRemoval = Object.freeze({
    ...mediaStorage,
    remove() { throw new Error('disk unavailable'); }
  });
  const service = createMaintenanceService({ database, mediaStorage: storageWithFailedRemoval, cleanupQueue });
  const uploaded = service.uploadImages('work', 1, [{ bytes: PNG, media_type: 'image/png' }]);
  const deleted = service.deleteImage('work', 1, uploaded.images[0].id);

  assert.equal(deleted.cleanup_warning, true);
  assert.deepEqual(cleanupQueue.read().entries.map(({ path, reason }) => ({ path, reason })), [{
    path: uploaded.images[0].media_path,
    reason: 'image_delete'
  }]);
});

test('手工导入把采集图片字节和声明 MIME 交给集中媒体存储', async (t) => {
  const { database, mediaStorage } = fixture(t);
  database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
  const work = { kind: 'work', source_id: 'work-1', parent_identity: 'root', normalized_name: 'Work' };
  const character = { kind: 'character', source_id: 'character-1', parent_work_identity: work, normalized_name: 'Keeper' };
  const importer = createCatalogImporter({ database, mediaRoot: mediaStorage.mediaRoot, mediaStorage, now: () => new Date(NOW), modelClient: MODEL_CLIENT, configuration: VECTOR_CONFIGURATION });
  await importer.importDetail({ identity: work, source_url: 'https://source.example/works/1', name: 'Work', aliases: [], fetched_at: NOW });
  await importer.importDetail({
    identity: character, source_url: 'https://source.example/characters/1', name: 'Keeper', aliases: [], prompt_text: 'ink', fetched_at: NOW,
    image_results: [{ owner_identity: character, source_url: 'https://source.example/images/keeper.png', sort_order: 0, status: 'downloaded', media_type: 'image/png' }]
  }, [{ source_url: 'https://source.example/images/keeper.png', bytes: PNG, media_type: 'image/png' }]);

  const image = database.prepare('SELECT media_path FROM item_images').get();
  assert.match(image.media_path, /^images\/[0-9a-f]{2}\/[0-9a-f-]{36}-\d{5}\.png$/u);
  assert.equal(existsSync(mediaStorage.pathFor(image.media_path)), true);
});
