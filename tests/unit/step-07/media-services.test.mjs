import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { createMaintenanceService } from '../../../app/maintenance/maintenance-service.mjs';
import { createMediaStorage, inspectImage } from '../../../app/media/media-storage.mjs';

const NOW = '2026-07-29T00:00:00Z';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217]);

function fixture() {
  const database = openCatalogDatabase();
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('Step07 services base', NOW, NOW);
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
    VALUES (1, 'Work', 'work', '[]', 1, ?, ?)` ).run(NOW, NOW);
  database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
    VALUES (2, 1, 'Character', 'character', '[]', 'ink', 1, ?, ?)` ).run(NOW, NOW);
  database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
    VALUES (3, 1, 'Style', '[]', 'paper', NULL, NULL)` ).run();
  const root = mkdtempSync(join(tmpdir(), 'noobai-step07-'));
  const mediaStorage = createMediaStorage({ mediaRoot: join(root, 'media') });
  return { database, root, mediaStorage, service: createMaintenanceService({ database, mediaStorage }) };
}

function assertSnapshot(snapshot, ownerKind, ownerId, imageIds, coverMediaPath = null, cleanupWarning = false) {
  assert.equal(snapshot.owner_kind, ownerKind);
  assert.equal(snapshot.owner_id, ownerId);
  assert.equal(snapshot.cover_media_path, coverMediaPath);
  assert.equal(snapshot.cleanup_warning, cleanupWarning);
  assert.deepEqual(snapshot.images.map((image) => image.id), imageIds);
  assert.ok(snapshot.images.every((image) => typeof image.media_path === 'string'));
  assert.equal(Object.hasOwn(snapshot, 'kind'), false);
  assert.equal(Object.hasOwn(snapshot, 'item_id'), false);
  assert.equal(Object.hasOwn(snapshot, 'cover_image_id'), false);
  assert.equal(Object.hasOwn(snapshot, 'effective_cover_path'), false);
}

test('识别允许的图片格式，并拒绝无效内容', () => {
  assert.equal(inspectImage(png).mediaType, 'image/png');
  assert.equal(inspectImage(jpeg).mediaType, 'image/jpeg');
  assert.throws(() => inspectImage(Buffer.from('invalid')), (error) => error.code === 'UPLOAD_TYPE_UNSUPPORTED');
});

test('三类对象的详情与上传返回 media_path 快照，重复内容保留独立记录', () => {
  const { database, service } = fixture();
  try {
    for (const [kind, id] of [['work', 1], ['character', 2], ['style', 3]]) {
      assertSnapshot(service.listImages(kind, id), kind, id, []);
      const uploaded = service.uploadImages(kind, id, [{ bytes: png, media_type: 'image/png' }, { bytes: png, media_type: 'image/png' }]);
      const imageIds = uploaded.images.map((image) => image.id);
      assert.equal(new Set(imageIds).size, 2);
      assertSnapshot(uploaded, kind, id, imageIds);
      assertSnapshot(service.listImages(kind, id), kind, id, imageIds);
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = 'work'").get().count, 2);
  } finally {
    database.close();
  }
});

test('封面写入保存实际 media_path，清除封面在写事务中使用固定候选回退', () => {
  const { database, service } = fixture();
  try {
    const characterImage = service.uploadImages('character', 2, [{ bytes: png, media_type: 'image/png' }]).images[0];
    const workImage = service.uploadImages('work', 1, [{ bytes: jpeg, media_type: 'image/jpeg' }]).images[0];
    assertSnapshot(service.setCover('work', 1, { id: workImage.id }), 'work', 1, [workImage.id], workImage.media_path);
    assertSnapshot(service.setCover('work', 1, { id: null }), 'work', 1, [workImage.id], characterImage.media_path);
    const deleted = service.deleteImage('work', 1, workImage.id);
    assertSnapshot(deleted, 'work', 1, [], characterImage.media_path);
    assert.equal(database.prepare('SELECT cover_media_path FROM works WHERE id = 1').get().cover_media_path, characterImage.media_path);
    assert.equal(characterImage.media_path.startsWith('images/'), true);
  } finally {
    database.close();
  }
});

test('设置封面只校验归属和路径，删除当前封面后使用同一对象的下一张路径', () => {
  const { database, service } = fixture();
  try {
    const first = service.uploadImages('character', 2, [{ bytes: png, media_type: 'image/png' }]).images[0];
    service.uploadImages('character', 2, [{ bytes: jpeg, media_type: 'image/jpeg' }]);
    const second = service.listImages('character', 2).images[1];
    const styleImage = service.uploadImages('style', 3, [{ bytes: png, media_type: 'image/png' }]).images[0];
    assert.throws(() => service.setCover('character', 2, { id: styleImage.id }), (error) => error.code === 'ITEM_UNAVAILABLE');
    const selected = service.setCover('character', 2, { id: second.id });
    assert.equal(selected.cover_media_path, second.media_path);
    assertSnapshot(service.deleteImage('character', 2, second.id), 'character', 2, [first.id], first.media_path);
  } finally {
    database.close();
  }
});

test('非空作品封面只在删除当前路径时按角色名称、角色 ID 和图片顺序回退', () => {
  const { database, service } = fixture();
  try {
    database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
      VALUES (4, 1, 'Alpha character', 'alpha character', '[]', 'ink', 1, ?, ?)` ).run(NOW, NOW);
    const explicit = service.uploadImages('work', 1, [{ bytes: png, media_type: 'image/png' }]).images[0];
    const laterCharacterImage = service.uploadImages('character', 2, [{ bytes: jpeg, media_type: 'image/jpeg' }]).images[0];
    const earlierCharacterImage = service.uploadImages('character', 4, [{ bytes: png, media_type: 'image/png' }]).images[0];
    assert.equal(service.setCover('work', 1, { id: explicit.id }).cover_media_path, explicit.media_path);
    service.uploadImages('work', 1, [{ bytes: jpeg, media_type: 'image/jpeg' }]);
    assert.equal(service.listImages('work', 1).cover_media_path, explicit.media_path);
    const deleted = service.deleteImage('work', 1, explicit.id);
    assert.equal(deleted.cover_media_path, earlierCharacterImage.media_path);
    assert.notEqual(deleted.cover_media_path, laterCharacterImage.media_path);
    service.deleteImage('character', 4, earlierCharacterImage.id);
    assert.equal(service.listImages('work', 1).cover_media_path, laterCharacterImage.media_path);
  } finally {
    database.close();
  }
});

test('保留排序接口，并为对象图片返回权威排序和媒体路径快照', () => {
  const { database, service } = fixture();
  try {
    const uploaded = service.uploadImages('work', 1, [{ bytes: png, media_type: 'image/png' }, { bytes: jpeg, media_type: 'image/jpeg' }]);
    const [first, second] = uploaded.images;
    assertSnapshot(service.reorderImages('work', 1, { ids: [second.id, first.id] }), 'work', 1, [second.id, first.id]);
    assert.throws(() => service.reorderImages('work', 1, { ids: [first.id] }), (error) => error.code === 'ITEM_UNAVAILABLE');
    assert.throws(() => service.reorderImages('work', 1, { image_ids: [second.id, first.id] }), (error) => error.code === 'VALIDATION_ERROR');
    assert.throws(() => service.setCover('work', 1, { image_id: first.id }), (error) => error.code === 'VALIDATION_ERROR');
  } finally {
    database.close();
  }
});

test('删图和批量删除在文件清理失败后保持数据库结果，并返回稳定 cleanup_warning', () => {
  const { database, mediaStorage, service } = fixture();
  try {
    const image = service.uploadImages('style', 3, [{ bytes: png, media_type: 'image/png' }]).images[0];
    const failingStorage = Object.freeze({ ...mediaStorage, remove() { throw new Error('injected media failure'); } });
    const failingService = createMaintenanceService({ database, mediaStorage: failingStorage });
    assertSnapshot(failingService.deleteImage('style', 3, image.id), 'style', 3, [], null, true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = ?').get(image.id).count, 0);

    const workImage = service.uploadImages('work', 1, [{ bytes: png, media_type: 'image/png' }]).images[0];
    assert.equal(existsSync(mediaStorage.pathFor(workImage.media_path)), true);
    assert.throws(
      () => failingService.batchDelete({ items: [{ kind: 'work', id: 1 }, { kind: 'style', id: 999 }] }),
      (error) => error.code === 'ITEM_UNAVAILABLE'
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works WHERE id = 1').get().count, 1);
    assert.equal(existsSync(mediaStorage.pathFor(workImage.media_path)), true);

    const result = failingService.batchDelete({ items: [{ kind: 'work', id: 1 }, { kind: 'style', id: 3 }] });
    assert.deepEqual(result, {
      deleted: [{ kind: 'work', id: 1 }, { kind: 'style', id: 3 }, { kind: 'character', id: 2 }],
      cleanup_warnings: [{ kind: 'work', id: 1 }]
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works WHERE id = 1').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 3').get().count, 0);
  } finally {
    database.close();
  }
});

test('上传的任一图片校验失败时整批不留下图片记录或媒体文件', () => {
  const { database, mediaStorage, service } = fixture();
  try {
    assert.throws(
      () => service.uploadImages('style', 3, [
        { bytes: png, media_type: 'image/png' },
        { bytes: Buffer.from('not-an-image'), media_type: 'image/png' }
      ]),
      (error) => error.code === 'UPLOAD_TYPE_UNSUPPORTED'
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = 'style' AND owner_id = 3").get().count, 0);
    const files = existsSync(mediaStorage.imagesRoot) ? readdirSync(mediaStorage.imagesRoot, {recursive:true, withFileTypes:true}).filter(entry => entry.isFile()) : [];
    assert.equal(files.length, 0);
  } finally {
    database.close();
  }
});

test('批量删除拒绝超过上限的显式对象数组', () => {
  const { database, service } = fixture();
  try {
    assert.throws(
      () => service.batchDelete({ items: Array.from({ length: 101 }, (_, index) => ({ kind: 'work', id: index + 1 })) }),
      /1 to 100 entries/u
    );
  } finally {
    database.close();
  }
});

test('批量删除同时选择作品和所属角色时不依赖请求顺序', () => {
  for (const items of [
    [{ kind: 'work', id: 1 }, { kind: 'character', id: 2 }],
    [{ kind: 'character', id: 2 }, { kind: 'work', id: 1 }]
  ]) {
    const { database, service } = fixture();
    try {
      assert.deepEqual(service.batchDelete({ items }), { deleted: items, cleanup_warnings: [] });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works WHERE id = 1').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM characters WHERE id = 2').get().count, 0);
    } finally {
      database.close();
    }
  }
});

test('拒绝非法输入、不可用对象和超过上传限制的文件', () => {
  const { database, service } = fixture();
  try {
    database.prepare('UPDATE works SET is_available = 0 WHERE id = 1').run();
    assert.throws(() => service.listImages('invalid', 1), /kind/u);
    assert.throws(() => service.listImages('work', 0), /positive integer/u);
    assert.throws(() => service.uploadImages('work', 1, [{ bytes: png, media_type: 'image/png' }]), (error) => error.code === 'ITEM_UNAVAILABLE');
    database.prepare('UPDATE works SET is_available = 1 WHERE id = 1').run();
    assert.throws(() => service.uploadImages('work', 1, Array.from({ length: 11 }, () => ({ bytes: png, media_type: 'image/png' }))), (error) => error.code === 'VALIDATION_ERROR');
  } finally {
    database.close();
  }
});
