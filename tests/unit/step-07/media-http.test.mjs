import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { createMaintenanceService } from '../../../app/maintenance/maintenance-service.mjs';
import { createMediaStorage } from '../../../app/media/media-storage.mjs';
import { createMediaHttpDispatcher } from '../../../app/http/media-http.mjs';
import { ApplicationError, createErrorMapper } from '../../../app/security/error-mapping.mjs';

const NOW = '2026-07-29T00:00:00Z';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);

function fixture({ authorizeWrite = () => true, mediaStorage: storageOverride, apiPublicPath = '/api' } = {}) {
  const database = openCatalogDatabase();
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (1, ?, ?, ?)').run('Step07 HTTP base', NOW, NOW);
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
    VALUES (1, 'Work', 'work', '[]', 1, ?, ?)` ).run(NOW, NOW);
  database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
    VALUES (2, 1, 'Character', 'character', '[]', 'ink', 1, ?, ?)` ).run(NOW, NOW);
  database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
    VALUES (3, 1, 'Style', '[]', 'paper', NULL, NULL)` ).run();
  const root = mkdtempSync(join(tmpdir(), 'noobai-step07-http-'));
  const mediaStorage = createMediaStorage({ mediaRoot: join(root, 'media') });
  const service = createMaintenanceService({ database, mediaStorage: storageOverride ?? mediaStorage });
  const dispatcher = createMediaHttpDispatcher({ service, errorMapper: createErrorMapper(), authorizeWrite, auditError: () => {}, apiPublicPath });
  return { database, mediaStorage, service, dispatcher };
}

test('routes media operations through the configured API prefix', () => {
  const { database, dispatcher } = fixture({ apiPublicPath: '/backend/api' });
  try {
    assert.equal(dispatcher.dispatch({ listener: 'public', method: 'get', url: '/backend/api/items/work/1/images', requestId: 'custom-media' }).status, 200);
    assert.equal(dispatcher.dispatch({ listener: 'public', method: 'GET', url: '/api/items/work/1/images', requestId: 'wrong-media' }), null);
    assert.equal(dispatcher.canHandle({ listener: 'public', method: 'PATCH', url: '/backend/api/items/work/1/images' }), false);
    assert.equal(dispatcher.dispatch({ listener: 'public', method: 'PATCH', url: '/backend/api/items/work/1/images', requestId: 'unsupported-method' }), null);
  } finally {
    database.close();
  }
});

function dispatch(dispatcher, method, url, requestId, body) {
  return dispatcher.dispatch({ listener: 'public', method, url, requestId, body });
}

function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(response.body, { ok: false, request_id: response.body.request_id, error: { code, message: response.body.error.message } });
}

function assertDirectDispatcherResult(result, { operationId, status, body }) {
  assert.equal(result.operationId, operationId);
  assert.deepEqual(Object.keys(result), ['status', 'body']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(result, 'operationId'), {
    value: operationId,
    writable: false,
    enumerable: false,
    configurable: false
  });
  assert.equal(result.status, status);
  assert.deepEqual(result.body, body);
  assert.equal(JSON.stringify(result), JSON.stringify({ status, body }));
}

test('media dispatcher rejects missing required constructor dependencies', () => {
  const errorMapper = createErrorMapper();
  assert.throws(
    () => createMediaHttpDispatcher({ errorMapper, auditError: () => {} }),
    /service is required/u
  );
  assert.throws(
    () => createMediaHttpDispatcher({ service: {}, auditError: () => {} }),
    /errorMapper is required/u
  );
  assert.throws(
    () => createMediaHttpDispatcher({ service: {}, errorMapper }),
    /auditError must be a function/u
  );
});

test('media dispatcher retains the selected operationId and public result shape across completion paths', async () => {
  const request = { listener: 'public', method: 'GET', url: '/api/items/work/1/images', requestId: 'media-operation' };
  const expectedSuccess = { ok: true, request_id: 'media-operation', data: { images: ['selected'] } };
  const expectedError = { ok: false, request_id: 'media-operation', error: { code: 'VALIDATION_ERROR', message: 'selected media route failed' } };
  const cases = [
    { listImages: () => ({ images: ['selected'] }), status: 200, body: expectedSuccess },
    { listImages: () => { throw new ApplicationError('VALIDATION_ERROR', 'selected media route failed'); }, status: 422, body: expectedError },
    { listImages: () => Promise.resolve({ images: ['selected'] }), status: 200, body: expectedSuccess },
    { listImages: () => Promise.reject(new ApplicationError('VALIDATION_ERROR', 'selected media route failed')), status: 422, body: expectedError }
  ];
  for (const scenario of cases) {
    const dispatcher = createMediaHttpDispatcher({ service: { listImages: scenario.listImages }, errorMapper: createErrorMapper(), auditError: () => {} });
    const result = await dispatcher.dispatch(request);
    assertDirectDispatcherResult(result, { operationId: 'listImages', status: scenario.status, body: scenario.body });
  }
  const dispatcher = createMediaHttpDispatcher({ service: { uploadImages: () => ({ images: [] }) }, errorMapper: createErrorMapper(), auditError: () => {} });
  const result = dispatcher.dispatch({
    ...request,
    method: 'POST',
    requestError: new ApplicationError('UPLOAD_TOO_LARGE', 'request body failed')
  });
  assertDirectDispatcherResult(result, {
    operationId: 'uploadImages',
    status: 413,
    body: { ok: false, request_id: 'media-operation', error: { code: 'UPLOAD_TOO_LARGE', message: 'request body failed' } }
  });
});

test('media dispatcher declares only routes backed by available service handlers', () => {
  const dispatcher = createMediaHttpDispatcher({ service: { listImages: () => ({ images: [] }) }, errorMapper: createErrorMapper(), auditError: () => {} });
  assert.deepEqual(dispatcher.implementedOperations, ['listImages']);
  assert.deepEqual(dispatcher.runtimeRouteInventory.map(({ operationId }) => operationId), ['listImages']);
  assert.equal(dispatcher.canHandle({ listener: 'public', method: 'GET', url: '/api/items/work/1/images' }), true);
  assert.equal(dispatcher.canHandle({ listener: 'public', method: 'POST', url: '/api/items/work/1/images' }), false);
  assert.equal(dispatcher.dispatch({ listener: 'public', method: 'POST', url: '/api/items/work/1/images', requestId: 'missing-upload-handler' }), null);
});

test('media dispatcher invokes all six mapped service handlers', () => {
  const calls = [];
  const service = Object.fromEntries([
    'listImages', 'uploadImages', 'reorderImages', 'setCover', 'deleteImage', 'batchDelete'
  ].map((method) => [method, (...args) => {
    calls.push([method, ...args]);
    return { method };
  }]));
  const dispatcher = createMediaHttpDispatcher({ service, errorMapper: createErrorMapper(), auditError: () => {} });
  const requests = [
    ['GET', '/api/items/work/1/images', undefined, 'listImages', 200],
    ['POST', '/api/items/work/1/images', { files: ['image'] }, 'uploadImages', 201],
    ['PUT', '/api/items/work/1/images/order', { ids: [2] }, 'reorderImages', 200],
    ['PUT', '/api/items/work/1/cover', { id: 2 }, 'setCover', 200],
    ['DELETE', '/api/items/work/1/images/2', undefined, 'deleteImage', 200],
    ['POST', '/api/items/batch-delete', { items: [{ kind: 'work', id: 1 }] }, 'batchDelete', 200]
  ];
  for (const [method, url, body, operationId, status] of requests) {
    const response = dispatcher.dispatch({ listener: 'public', method, url, body, requestId: `mapped-${operationId}` });
    assert.equal(response.status, status, operationId);
    assert.equal(response.operationId, operationId);
  }
  assert.deepEqual(calls, [
    ['listImages', 'work', 1],
    ['uploadImages', 'work', 1, ['image']],
    ['reorderImages', 'work', 1, { ids: [2] }],
    ['setCover', 'work', 1, { id: 2 }],
    ['deleteImage', 'work', 1, 2],
    ['batchDelete', { items: [{ kind: 'work', id: 1 }] }]
  ]);
});

function assertMediaSnapshot(snapshot, ownerKind, ownerId) {
  assert.deepEqual(Object.keys(snapshot).sort(), ['cleanup_warning', 'cover_media_path', 'images', 'owner_id', 'owner_kind']);
  assert.equal(snapshot.owner_kind, ownerKind);
  assert.equal(snapshot.owner_id, ownerId);
  assert.equal(Object.hasOwn(snapshot, 'kind'), false);
  assert.equal(Object.hasOwn(snapshot, 'item_id'), false);
}

test('三类详情、上传、排序、封面和删图均返回可直接刷新页面的统一媒体快照', () => {
  const { database, dispatcher } = fixture();
  try {
    for (const [kind, itemId] of [['work', 1], ['character', 2], ['style', 3]]) {
      const empty = dispatch(dispatcher, 'GET', `/api/items/${kind}/${itemId}/images`, `detail-${kind}`);
      assert.equal(empty.status, 200);
      assertMediaSnapshot(empty.body.data, kind, itemId);
      assert.equal(empty.body.data.cover_media_path, null);
      assert.deepEqual(empty.body.data.images, []);
      assert.equal(empty.body.data.cleanup_warning, false);
      const uploaded = dispatch(dispatcher, 'POST', `/api/items/${kind}/${itemId}/images`, `upload-${kind}`, { files: [{ bytes: png, media_type: 'image/png' }, { bytes: png, media_type: 'image/png' }] });
      assert.equal(uploaded.status, 201);
      assertMediaSnapshot(uploaded.body.data, kind, itemId);
      const [firstImage, secondImage] = uploaded.body.data.images;
      const reordered = dispatch(dispatcher, 'PUT', `/api/items/${kind}/${itemId}/images/order`, `order-${kind}`, { ids: [secondImage.id, firstImage.id] });
      assert.equal(reordered.status, 200);
      assertMediaSnapshot(reordered.body.data, kind, itemId);
      assert.deepEqual(reordered.body.data.images.map((image) => image.id), [secondImage.id, firstImage.id]);
      const cover = dispatch(dispatcher, 'PUT', `/api/items/${kind}/${itemId}/cover`, `cover-${kind}`, { id: secondImage.id });
      assert.equal(cover.body.data.cover_media_path, secondImage.media_path);
      assert.equal(Object.hasOwn(cover.body.data, 'cover_image_id'), false);
      const deleted = dispatch(dispatcher, 'DELETE', `/api/items/${kind}/${itemId}/images/${secondImage.id}`, `delete-${kind}`);
      assert.equal(deleted.status, 200);
      assertMediaSnapshot(deleted.body.data, kind, itemId);
      assert.deepEqual(deleted.body.data.images.map((image) => image.id), [firstImage.id]);
      assert.equal(deleted.body.data.cleanup_warning, false);
    }
  } finally {
    database.close();
  }
});

test('运行时拒绝重复图片 ID 排序请求并保持原有顺序', () => {
  const { database, dispatcher } = fixture();
  try {
    const uploaded = dispatch(dispatcher, 'POST', '/api/items/work/1/images', 'duplicate-order-upload', {
      files: [{ bytes: png, media_type: 'image/png' }, { bytes: png, media_type: 'image/png' }]
    });
    assert.equal(uploaded.status, 201);
    const originalOrder = uploaded.body.data.images.map((image) => image.id);
    const duplicate = dispatch(dispatcher, 'PUT', '/api/items/work/1/images/order', 'duplicate-order', { ids: [originalOrder[0], originalOrder[0]] });
    assertError(duplicate, 422, 'VALIDATION_ERROR');
    const current = dispatch(dispatcher, 'GET', '/api/items/work/1/images', 'duplicate-order-read');
    assert.equal(current.status, 200);
    assert.deepEqual(current.body.data.images.map((image) => image.id), originalOrder);
  } finally {
    database.close();
  }
});

test('作品图库路由可用，二进制媒体业务接口不再匹配', () => {
  const { database, dispatcher } = fixture();
  try {
    const uploaded = dispatch(dispatcher, 'POST', '/api/items/work/1/images', 'work-upload', { files: [{ bytes: png, media_type: 'image/png' }] });
    assert.equal(uploaded.status, 201);
    assert.equal(dispatch(dispatcher, 'GET', '/api/media/1', 'media-read'), null);
  } finally {
    database.close();
  }
});

test('清理失败仍以成功快照和 cleanup_warning 返回，批量删除保持原子性', () => {
  const normal = fixture();
  const { database, mediaStorage } = normal;
  try {
    const image = normal.service.uploadImages('character', 2, [{ bytes: png, media_type: 'image/png' }]).images[0].id;
    const failingStorage = Object.freeze({ ...mediaStorage, remove() { throw new Error('disk unavailable'); } });
    const service = createMaintenanceService({ database, mediaStorage: failingStorage });
    const dispatcher = createMediaHttpDispatcher({ service, errorMapper: createErrorMapper(), auditError: () => {} });
    const deleted = dispatch(dispatcher, 'DELETE', `/api/items/character/2/images/${image}`, 'cleanup-warning');
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.data.cleanup_warning, true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = ?').get(image).count, 0);
    const batch = dispatch(dispatcher, 'POST', '/api/items/batch-delete', 'batch', { items: [{ kind: 'work', id: 1 }, { kind: 'style', id: 999 }] });
    assertError(batch, 409, 'ITEM_UNAVAILABLE');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works WHERE id = 1').get().count, 1);
  } finally {
    database.close();
  }
});

test('权限、非法输入、无效归属和数据库繁忙映射到约定错误', () => {
  const { database, dispatcher, service } = fixture({ authorizeWrite: () => false });
  try {
    assertError(dispatch(dispatcher, 'POST', '/api/items/work/1/images', 'forbidden', { files: [{ bytes: png, media_type: 'image/png' }] }), 403, 'WRITE_FORBIDDEN');
    const writable = createMediaHttpDispatcher({ service, errorMapper: createErrorMapper(), auditError: () => {} });
    assertError(dispatch(writable, 'GET', '/api/items/work/0/images', 'invalid'), 422, 'VALIDATION_ERROR');
    assertError(dispatch(writable, 'DELETE', '/api/items/work/1/images/not-id', 'bad-delete'), 422, 'VALIDATION_ERROR');
    const imageId = service.uploadImages('work', 1, [{ bytes: png, media_type: 'image/png' }]).images[0].id;
    assertError(dispatch(writable, 'PUT', '/api/items/character/2/cover', 'wrong-owner', { id: imageId }), 409, 'ITEM_UNAVAILABLE');
    assertError(dispatch(writable, 'PUT', '/api/items/work/1/cover', 'retired-cover-body', { image_id: imageId }), 422, 'VALIDATION_ERROR');
    assertError(dispatch(writable, 'PUT', '/api/items/work/1/images/order', 'retired-order-body', { image_ids: [imageId] }), 422, 'VALIDATION_ERROR');
    const busy = writable.dispatch({ listener: 'public', method: 'GET', url: '/api/items/work/1/images', requestId: 'busy', requestError: Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }) });
    assertError(busy, 503, 'DATABASE_BUSY');
  } finally {
    database.close();
  }
});

test('上传类型错误和请求读取错误保持声明的错误契约', () => {
  const { database, dispatcher } = fixture();
  try {
    assertError(dispatch(dispatcher, 'POST', '/api/items/style/3/images', 'type', { files: [{ bytes: png, media_type: 'image/jpeg' }] }), 415, 'UPLOAD_TYPE_UNSUPPORTED');
    const response = dispatcher.dispatch({ listener: 'public', method: 'POST', url: '/api/items/style/3/images', requestId: 'read-error', requestError: new ApplicationError('UPLOAD_TOO_LARGE', 'body too large') });
    assertError(response, 413, 'UPLOAD_TOO_LARGE');
  } finally {
    database.close();
  }
});
