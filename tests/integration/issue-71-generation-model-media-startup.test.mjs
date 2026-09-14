import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { startLocalApplication } from '../../app/server/local-app.mjs';
import { FAKE_VECTOR_CONFIGURATION, createFakeSemanticModelClient } from '../fixtures/vector/fake-semantic-model-client.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-08-03T00:00:00Z';
const STARTUP_TEST_PORTS = Object.freeze({ public: 19292, internal: 19293 });
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);

function setEnvironment(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

function multipartBody(files, extraField = null) {
  const boundary = '----noobai-issue-71-model-media-startup';
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

async function createFixture(authorizeWrite) {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-71-model-media-startup-'));
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const databasePath = join(dataRoot, 'app.sqlite');
  await mkdir(dataRoot, { recursive: true });
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot });

  const database = openCatalogDatabase({ databasePath });
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(1, 'WAI', NOW, NOW);
  database.prepare(`INSERT INTO generation_models(
    id, base_model_id, file_name, file_format, precision_or_quantization,
    description, usage, created_at, updated_at
  ) VALUES (10, 1, 'startup-model.safetensors', 'safetensors', 'fp16', 'description', 'usage', ?, ?)`)
    .run(NOW, NOW);
  database.close();

  const restoreEnvironment = [
    setEnvironment('NOOBAI_PUBLIC_PORT', String(STARTUP_TEST_PORTS.public)),
    setEnvironment('NOOBAI_INTERNAL_PORT', String(STARTUP_TEST_PORTS.internal))
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

async function request(application, method, pathname, { body, contentType = 'application/json', requestId = `startup-${method}-${pathname}` } = {}) {
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
    else if (entry.isFile()) files.push({ path: relative(directory, path).split(sep).join('/'), bytes: await readFile(path) });
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

test('真实 startLocalApplication 接线保留模型资源图片读取授权并拒绝所有写入', { concurrency: false }, async () => {
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

test('真实 startLocalApplication 接线完成模型资源图片的 multipart 上传、列表、排序、封面同步和删除回退', { concurrency: false }, async () => {
  const fixture = await createFixture(() => true);
  try {
    const empty = await request(fixture.application, 'GET', '/api/items/model/10/images');
    assert.equal(empty.status, 200);
    assertSnapshot(empty.body.data, []);

    const uploadBody = multipartBody([PNG, PNG, PNG]);
    const uploaded = await request(fixture.application, 'POST', '/api/items/model/10/images', {
      body: uploadBody.body,
      contentType: uploadBody.contentType
    });
    assert.equal(uploaded.status, 201);
    const [first, second, third] = uploaded.body.data.images;
    assertSnapshot(uploaded.body.data, [first.id, second.id, third.id]);
    const uploadedState = await readOwnerState(fixture);
    assert.deepEqual(uploadedState.images.map(({ id, media_path, sort_order }) => ({ id, media_path, sort_order })), [first, second, third].map(({ id, media_path }, sort_order) => ({ id, media_path, sort_order })));
    assert.deepEqual(uploadedState.files.map(({ path }) => path), uploaded.body.data.images.map(({ media_path }) => media_path).sort());

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
    assert.equal((await readOwnerState(fixture)).model.cover_media_path, first.media_path);

    const deletedNonCover = await request(fixture.application, 'DELETE', `/api/items/model/10/images/${third.id}`);
    assert.equal(deletedNonCover.status, 200);
    assertSnapshot(deletedNonCover.body.data, [first.id, second.id], first.media_path);
    assert.equal((await readOwnerState(fixture)).files.some(({ path }) => path === third.media_path), false);

    const deletedCover = await request(fixture.application, 'DELETE', `/api/items/model/10/images/${first.id}`);
    assert.equal(deletedCover.status, 200);
    assertSnapshot(deletedCover.body.data, [second.id], second.media_path);
    assert.equal((await readOwnerState(fixture)).model.cover_media_path, second.media_path);

    const deletedLast = await request(fixture.application, 'DELETE', `/api/items/model/10/images/${second.id}`);
    assert.equal(deletedLast.status, 200);
    assertSnapshot(deletedLast.body.data, [], null);
    const finalState = await readOwnerState(fixture);
    assert.deepEqual(finalState.images, []);
    assert.equal(finalState.model.cover_media_path, null);
    assert.deepEqual(finalState.files, []);
  } finally {
    await closeFixture(fixture);
  }
});

test('真实 startLocalApplication 接线拒绝未知模型、未知字段、非法排序和越界输入且保持状态不变', { concurrency: false }, async () => {
  const fixture = await createFixture(() => true);
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
    await assertFailureUnchanged(fixture, 'POST', '/api/items/model/10/images', {
      body: multipartBody([PNG], 'unexpected').body,
      contentType: multipartBody([PNG], 'unexpected').contentType
    }, 422, 'VALIDATION_ERROR');
    await assertFailureUnchanged(fixture, 'PUT', '/api/items/model/10/images/order', { body: JSON.stringify({ ids: [first.id, first.id, second.id] }) }, 422, 'VALIDATION_ERROR');
    await assertFailureUnchanged(fixture, 'PUT', '/api/items/model/10/images/order', { body: JSON.stringify({ ids: [first.id, second.id, 999999] }) }, 404, 'NOT_FOUND');
    await assertFailureUnchanged(fixture, 'PUT', '/api/items/model/10/cover', { body: JSON.stringify({ id: 999999 }) }, 404, 'NOT_FOUND');
    await assertFailureUnchanged(fixture, 'DELETE', '/api/items/model/10/images/999999', undefined, 404, 'NOT_FOUND');
  } finally {
    await closeFixture(fixture);
  }
});
