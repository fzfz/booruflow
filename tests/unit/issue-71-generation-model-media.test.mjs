import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { startLocalApplication } from '../../app/server/local-app.mjs';
import { FAKE_VECTOR_CONFIGURATION, createFakeSemanticModelClient } from '../fixtures/vector/fake-semantic-model-client.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const currentOpenapi = parseYaml(readFileSync(resolve(repositoryRoot, 'schema/api/openapi.yaml'), 'utf8'));
const NOW = '2026-08-03T00:00:00Z';
const UNIT_TEST_PORTS = Object.freeze({ public: 19290, internal: 19291 });
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
const JPEG = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217]);
const MEDIA_PATHS = Object.freeze([
  '/api/items/{owner_kind}/{owner_id}/images',
  '/api/items/{owner_kind}/{owner_id}/images/order',
  '/api/items/{owner_kind}/{owner_id}/cover',
  '/api/items/{owner_kind}/{owner_id}/images/{id}'
]);

function mediaOperations(document) {
  return MEDIA_PATHS.flatMap((path) => Object.entries(document.paths[path] ?? {})
    .filter(([method]) => ['get', 'post', 'put', 'delete'].includes(method))
    .map(([method, operation]) => ({ path, method, operationId: operation.operationId })));
}

function seedModel(database) {
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(1, 'WAI', NOW, NOW);
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (10, 1, 'model-10.safetensors', 'safetensors', 'fp16', 'description', 'usage', ?, ?)`)
    .run(NOW, NOW);
}

function setEnvironment(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function createFixture(authorizeWrite = () => true) {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-71-model-media-unit-'));
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const databasePath = join(dataRoot, 'app.sqlite');
  await mkdir(dataRoot, { recursive: true });
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot });

  const database = openCatalogDatabase({ databasePath, includeBuiltinComfyuiCatalog: false });
  seedModel(database);
  database.close();

  const restoreEnvironment = [
    setEnvironment('NOOBAI_PUBLIC_PORT', String(UNIT_TEST_PORTS.public)),
    setEnvironment('NOOBAI_INTERNAL_PORT', String(UNIT_TEST_PORTS.internal))
  ];
  try {
    const application = await startLocalApplication({
      repositoryRoot,
      dataPaths: { dataRoot, databasePath, mediaRoot },
      vectorConfiguration: FAKE_VECTOR_CONFIGURATION,
      vectorModelClient: createFakeSemanticModelClient(),
      authorizeWrite,
      onStarted: () => {}
    });
    return Object.freeze({ application, databasePath, mediaRoot, root, restoreEnvironment: Object.freeze(restoreEnvironment) });
  } catch (error) {
    for (const restore of restoreEnvironment.reverse()) restore();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeFixture(fixture) {
  try {
    await fixture.application.close();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    for (const restore of [...fixture.restoreEnvironment].reverse()) restore();
  }
}

function multipartBody(files, extraField = null) {
  const boundary = '----noobai-issue-71-model-media-unit';
  const chunks = [];
  for (const [index, file] of files.entries()) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="model-${index}.png"\r\nContent-Type: image/png\r\n\r\n`, 'latin1'));
    chunks.push(file);
    chunks.push(Buffer.from('\r\n', 'latin1'));
  }
  if (extraField !== null) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${extraField}"\r\n\r\nunexpected\r\n`, 'latin1'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
  return Object.freeze({ body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` });
}

async function request(application, method, pathname, { body, contentType = 'application/json', requestId = `issue-71-${method}-${pathname}` } = {}) {
  const response = await fetch(`http://127.0.0.1:${application.publicAddress.port}${pathname}`, {
    method,
    headers: { 'content-type': contentType, 'x-request-id': requestId },
    ...(body === undefined ? {} : { body })
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

async function readMediaFiles(directory, current = directory) {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await readMediaFiles(directory, path));
    else if (entry.isFile()) files.push({ path: path.slice(directory.length + 1), bytes: await readFile(path) });
  }
  return files;
}

async function readOwnerState(fixture) {
  const database = openCatalogDatabase({ databasePath: fixture.databasePath });
  try {
    return Object.freeze({
      model: database.prepare('SELECT id, base_model_id, file_name, file_format, precision_or_quantization, description, usage, cover_media_path, created_at, updated_at FROM generation_models WHERE id = 10').get(),
      images: database.prepare('SELECT id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at FROM item_images WHERE owner_kind = \'model\' AND owner_id = 10 ORDER BY sort_order, id').all(),
      files: await readMediaFiles(fixture.mediaRoot)
    });
  } finally {
    database.close();
  }
}

function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, code);
}

function assertSnapshot(snapshot, imageIds, coverMediaPath = null) {
  assert.deepEqual(Object.keys(snapshot).sort(), ['cleanup_warning', 'cover_media_path', 'images', 'owner_id', 'owner_kind']);
  assert.equal(snapshot.owner_kind, 'model');
  assert.equal(snapshot.owner_id, 10);
  assert.equal(snapshot.cover_media_path, coverMediaPath);
  assert.equal(snapshot.cleanup_warning, false);
  assert.deepEqual(snapshot.images.map(({ id }) => id), imageIds);
  assert.deepEqual(snapshot.images.map(({ sort_order }) => sort_order), imageIds.map((_, index) => index));
  assert.ok(snapshot.images.every(({ media_path }) => media_path.startsWith('images/')));
}

async function assertFailureUnchanged(fixture, method, pathname, options, status, code) {
  const before = await readOwnerState(fixture);
  assertError(await request(fixture.application, method, pathname, options), status, code);
  assert.deepEqual(await readOwnerState(fixture), before);
}

test('媒体路径与 operationId 来自当前运行时 schema', () => {
  assert.deepEqual(mediaOperations(currentOpenapi), [
    { path: MEDIA_PATHS[0], method: 'get', operationId: 'listImages' },
    { path: MEDIA_PATHS[0], method: 'post', operationId: 'uploadImages' },
    { path: MEDIA_PATHS[1], method: 'put', operationId: 'reorderImages' },
    { path: MEDIA_PATHS[2], method: 'put', operationId: 'setCover' },
    { path: MEDIA_PATHS[3], method: 'delete', operationId: 'deleteImage' }
  ]);
});

test('真实 startLocalApplication 保留模型资源图片读取授权并拒绝所有写入', { concurrency: false }, async () => {
  const fixture = await createFixture(() => false);
  try {
    const read = await request(fixture.application, 'GET', '/api/items/model/10/images');
    assert.equal(read.status, 200);
    assertSnapshot(read.body.data, []);

    const multipart = multipartBody([PNG]);
    for (const [method, pathname, options] of [
      ['POST', '/api/items/model/10/images', { body: multipart.body, contentType: multipart.contentType }],
      ['PUT', '/api/items/model/10/images/order', { body: JSON.stringify({ ids: [1] }) }],
      ['PUT', '/api/items/model/10/cover', { body: JSON.stringify({ id: 1 }) }],
      ['DELETE', '/api/items/model/10/images/1']
    ]) {
      await assertFailureUnchanged(fixture, method, pathname, options, 403, 'WRITE_FORBIDDEN');
    }
  } finally {
    await closeFixture(fixture);
  }
});

test('真实 HTTP 完成模型资源图片的上传、列表、排序、封面回退和删除', { concurrency: false }, async () => {
  const fixture = await createFixture();
  try {
    const empty = await request(fixture.application, 'GET', '/api/items/model/10/images');
    assert.equal(empty.status, 200);
    assertSnapshot(empty.body.data, []);

    const uploadBody = multipartBody([PNG, JPEG, PNG]);
    const uploaded = await request(fixture.application, 'POST', '/api/items/model/10/images', {
      body: uploadBody.body,
      contentType: uploadBody.contentType
    });
    assert.equal(uploaded.status, 201);
    const [first, second, third] = uploaded.body.data.images;
    assertSnapshot(uploaded.body.data, [first.id, second.id, third.id]);

    const listed = await request(fixture.application, 'GET', '/api/items/model/10/images');
    assert.equal(listed.status, 200);
    assertSnapshot(listed.body.data, [first.id, second.id, third.id]);

    const reordered = await request(fixture.application, 'PUT', '/api/items/model/10/images/order', {
      body: JSON.stringify({ ids: [third.id, first.id, second.id] })
    });
    assert.equal(reordered.status, 200);
    assertSnapshot(reordered.body.data, [third.id, first.id, second.id]);

    const covered = await request(fixture.application, 'PUT', '/api/items/model/10/cover', {
      body: JSON.stringify({ id: first.id })
    });
    assert.equal(covered.status, 200);
    assertSnapshot(covered.body.data, [third.id, first.id, second.id], first.media_path);

    const deletedNonCover = await request(fixture.application, 'DELETE', `/api/items/model/10/images/${third.id}`);
    assert.equal(deletedNonCover.status, 200);
    assertSnapshot(deletedNonCover.body.data, [first.id, second.id], first.media_path);

    const deletedCover = await request(fixture.application, 'DELETE', `/api/items/model/10/images/${first.id}`);
    assert.equal(deletedCover.status, 200);
    assertSnapshot(deletedCover.body.data, [second.id], second.media_path);

    const deletedLast = await request(fixture.application, 'DELETE', `/api/items/model/10/images/${second.id}`);
    assert.equal(deletedLast.status, 200);
    assertSnapshot(deletedLast.body.data, [], null);
    const state = await readOwnerState(fixture);
    assert.deepEqual(state.images, []);
    assert.equal(state.model.cover_media_path, null);
    assert.deepEqual(state.files, []);
  } finally {
    await closeFixture(fixture);
  }
});

test('真实 HTTP 对未知模型、未知字段、非法排序和越界输入返回错误且不改变模型媒体状态', { concurrency: false }, async () => {
  const fixture = await createFixture();
  try {
    await assertFailureUnchanged(fixture, 'GET', '/api/items/model/999/images', undefined, 404, 'NOT_FOUND');
    await assertFailureUnchanged(fixture, 'POST', '/api/items/model/999/images', {
      body: multipartBody([PNG]).body,
      contentType: multipartBody([PNG]).contentType
    }, 404, 'NOT_FOUND');
    await assertFailureUnchanged(fixture, 'PUT', '/api/items/model/999/images/order', { body: JSON.stringify({ ids: [1] }) }, 404, 'NOT_FOUND');
    await assertFailureUnchanged(fixture, 'PUT', '/api/items/model/999/cover', { body: JSON.stringify({ id: 1 }) }, 404, 'NOT_FOUND');
    await assertFailureUnchanged(fixture, 'DELETE', '/api/items/model/999/images/1', undefined, 404, 'NOT_FOUND');

    await assertFailureUnchanged(fixture, 'GET', '/api/items/model/0/images', undefined, 422, 'VALIDATION_ERROR');
    await assertFailureUnchanged(fixture, 'GET', '/api/items/model/-1/images', undefined, 422, 'VALIDATION_ERROR');
    await assertFailureUnchanged(fixture, 'GET', '/api/items/model/1.5/images', undefined, 422, 'VALIDATION_ERROR');

    const uploadBody = multipartBody([PNG, PNG, PNG]);
    const uploaded = await request(fixture.application, 'POST', '/api/items/model/10/images', {
      body: uploadBody.body,
      contentType: uploadBody.contentType
    });
    assert.equal(uploaded.status, 201);
    const [first, second] = uploaded.body.data.images;

    await assertFailureUnchanged(fixture, 'PUT', '/api/items/model/10/cover', { body: JSON.stringify({ id: first.id, image_id: second.id }) }, 422, 'VALIDATION_ERROR');
    await assertFailureUnchanged(fixture, 'PUT', '/api/items/model/10/images/order', { body: JSON.stringify({ ids: [first.id, second.id], extra: true }) }, 422, 'VALIDATION_ERROR');
    const unknownFieldUpload = multipartBody([PNG], 'unexpected');
    await assertFailureUnchanged(fixture, 'POST', '/api/items/model/10/images', {
      body: unknownFieldUpload.body,
      contentType: unknownFieldUpload.contentType
    }, 422, 'VALIDATION_ERROR');
    await assertFailureUnchanged(fixture, 'PUT', '/api/items/model/10/images/order', { body: JSON.stringify({ ids: [first.id, first.id, second.id] }) }, 422, 'VALIDATION_ERROR');
    await assertFailureUnchanged(fixture, 'PUT', '/api/items/model/10/images/order', { body: JSON.stringify({ ids: [first.id, second.id, 999999] }) }, 404, 'NOT_FOUND');
    await assertFailureUnchanged(fixture, 'PUT', '/api/items/model/10/cover', { body: JSON.stringify({ id: 999999 }) }, 404, 'NOT_FOUND');
    await assertFailureUnchanged(fixture, 'DELETE', '/api/items/model/10/images/999999', undefined, 404, 'NOT_FOUND');
  } finally {
    await closeFixture(fixture);
  }
});
