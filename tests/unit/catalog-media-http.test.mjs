import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createMaintenanceService } from '../../app/maintenance/maintenance-service.mjs';
import { createMediaHttpDispatcher } from '../../app/http/media-http.mjs';
import { createCatalogRepository } from '../../app/catalog/catalog-repository.mjs';
import { createCatalogService } from '../../app/catalog/catalog-service.mjs';
import { createCatalogHttpDispatcher } from '../../app/http/catalog-http.mjs';
import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createMediaStorage } from '../../app/media/media-storage.mjs';
import { ApplicationError, createErrorMapper } from '../../app/security/error-mapping.mjs';

const NOW = '2026-07-29T00:00:00Z';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);

function fixture() {
  const database = openCatalogDatabase();
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('Catalog media base', NOW, NOW);
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (1, 'Work', 'work', '[]', 1, ?, ?), (2, 'Unavailable', 'unavailable', '[]', 0, ?, ?)` ).run(NOW, NOW, NOW, NOW);
  database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (10, 1, 'Character', 'character', '[]', 'ink', 1, ?, ?), (11, 1, 'Hidden', 'hidden', '[]', 'ink', 0, ?, ?)` ).run(NOW, NOW, NOW, NOW);
  database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (20, 1, 'Style', '[]', 'paper', NULL, NULL)` ).run();
  const root = mkdtempSync(join(tmpdir(), 'noobai-catalog-media-'));
  const mediaStorage = createMediaStorage({ mediaRoot: join(root, 'media') });
  const service = createMaintenanceService({ database, mediaStorage });
  const dispatcher = createMediaHttpDispatcher({ service, errorMapper: createErrorMapper(), auditError: () => {} });
  return { database, service, dispatcher, mediaStorage };
}

function get(dispatcher, url, requestId = 'image-request') {
  return dispatcher.dispatch({ listener: 'public', method: 'GET', url, requestId });
}

test('GET 详情图片返回真实排序列表，并保持 request_id', () => {
  const { database, service, dispatcher } = fixture();
  try {
    assert.deepEqual(get(dispatcher, '/api/items/character/10/images', 'empty').body.data.images, []);
    const uploaded = service.uploadImages('character', 10, [{ bytes: PNG, media_type: 'image/png' }]);
    const response = get(dispatcher, '/api/items/character/10/images', 'success');
    assert.equal(response.status, 200);
    assert.equal(response.body.request_id, 'success');
    assert.deepEqual(response.body.data.images, uploaded.images);
  } finally { database.close(); }
});

test('GET 详情图片校验 kind、id、归属和对象可用性', () => {
  const { database, dispatcher } = fixture();
  try {
    for (const [url, status, code] of [
      ['/api/items/work/1/images', 200, null],
      ['/api/items/character/0/images', 422, 'VALIDATION_ERROR'],
      ['/api/items/character/999/images', 404, 'NOT_FOUND'],
      ['/api/items/character/11/images', 409, 'ITEM_UNAVAILABLE']
    ]) {
      const response = get(dispatcher, url, `invalid-${status}`);
      assert.equal(response.status, status, url);
      if (code) assert.equal(response.body.error.code, code, url);
    }
  } finally { database.close(); }
});

test('图库读取直接返回数据库媒体路径，删除当前封面后清除路径', () => {
  const { database, service, dispatcher } = fixture();
  try {
    const uploaded = service.uploadImages('character', 10, [
      { bytes: PNG, media_type: 'image/png' }, { bytes: PNG, media_type: 'image/png' }
    ]);
    const [first, second] = uploaded.images;
    assert.deepEqual(get(dispatcher, '/api/items/character/10/images', 'missing').body.data.images, uploaded.images);
    service.setCover('character', 10, { id: second.id });
    service.deleteImage('character', 10, second.id);
    assert.deepEqual(service.getCover('character', 10), { cover_media_path: first.media_path });
  } finally { database.close(); }
});

test('媒体路由保留失败响应的 request_id', () => {
  const { database, dispatcher } = fixture();
  try {
    const response = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/items/character/10/images', requestId: 'busy', requestError: new ApplicationError('DATABASE_BUSY', 'busy') });
    assert.equal(response.status, 503);
    assert.equal(response.body.request_id, 'busy');
  } finally { database.close(); }
});

test('二进制媒体业务接口不再匹配', () => {
  const { database, dispatcher } = fixture();
  try {
    assert.equal(get(dispatcher, '/api/media/invalid', 'legacy-media'), null);
  } finally { database.close(); }
});

test('公开目录直接返回数据库中的 cover_media_path，不读取媒体字节', () => {
  const { database, service } = fixture();
  try {
    const uploaded = service.uploadImages('character', 10, [
      { bytes: PNG, media_type: 'image/png' }, { bytes: PNG, media_type: 'image/png' }
    ]);
    const [first, second] = uploaded.images;
    service.setCover('character', 10, { id: first.id });
    const firstPath = first.media_path;

    const repository = createCatalogRepository(database);
    const catalogService = createCatalogService({ database, repository });
    const dispatcher = createCatalogHttpDispatcher({ service: catalogService, errorMapper: createErrorMapper() });
    const response = dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/characters/10', requestId: 'catalog-cover-fallback' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.cover_media_path, firstPath);
  } finally { database.close(); }
});
