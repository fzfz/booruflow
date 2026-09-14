import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { startLocalApplication } from '../../app/server/local-app.mjs';
import { FAKE_VECTOR_CONFIGURATION, createFakeSemanticModelClient } from '../fixtures/vector/fake-semantic-model-client.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-08-03T00:00:00Z';
const STARTUP_TEST_PORTS = Object.freeze({ public: 19192, internal: 19193 });

const MODEL_WRITE = Object.freeze({
  base_model_id: 1,
  file_name: 'startup-model.safetensors',
  file_format: 'safetensors',
  precision_or_quantization: 'fp16',
  author: 'NoobAI',
  version: '1.0',
  release_url: 'https://example.test/startup-model',
  published_at: '2026-08-03',
  description: 'startup model description',
  usage: 'startup model usage',
  skill_name: 'wai-sdxl-prompt-builder'
});

const MODEL_WRITE_UPDATED = Object.freeze({
  ...MODEL_WRITE,
  file_name: 'startup-model-updated.safetensors',
  description: 'updated startup model description',
  usage: 'updated startup model usage'
});

function setEnvironment(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function createFixture(authorizeWrite) {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-71-startup-'));
  const dataRoot = join(root, 'data');
  const mediaRoot = join(dataRoot, 'media');
  const databasePath = join(dataRoot, 'app.sqlite');
  await mkdir(dataRoot, { recursive: true });
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot });

  const database = openCatalogDatabase({ databasePath });
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(1, 'WAI', NOW, NOW);
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(2, 'Anima', NOW, NOW);
  database.close();

  const restoreEnvironment = [
    setEnvironment('NOOBAI_PUBLIC_PORT', String(STARTUP_TEST_PORTS.public)),
    setEnvironment('NOOBAI_INTERNAL_PORT', String(STARTUP_TEST_PORTS.internal))
  ];
  let application;
  try {
    application = await startLocalApplication({
      repositoryRoot,
      dataPaths: { dataRoot, databasePath, mediaRoot },
      vectorConfiguration: FAKE_VECTOR_CONFIGURATION,
      vectorModelClient: createFakeSemanticModelClient(),
      authorizeWrite,
      onStarted: () => {}
    });
    return Object.freeze({ application, root, restoreEnvironment: Object.freeze(restoreEnvironment) });
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

async function request(application, method, pathname, body, requestId) {
  const response = await fetch(`http://127.0.0.1:${application.publicAddress.port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

test('真实 startLocalApplication 接线使用 authorizeWrite 保留读权限并拒绝模型三类写操作', { concurrency: false }, async () => {
  const fixture = await createFixture(() => false);
  try {
    const database = openCatalogDatabase({ databasePath: join(fixture.root, 'data/app.sqlite') });
    database.prepare(`INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (10, 1, 'existing-startup-model.safetensors', 'safetensors', 'fp16', 'description', 'usage', ?, ?)`)
      .run(NOW, NOW);
    database.close();

    for (const [method, pathname, body, requestId] of [
      ['GET', '/api/manage/models?page=1&page_size=20', undefined, 'startup-auth-list'],
      ['GET', '/api/manage/models/10', undefined, 'startup-auth-detail'],
      ['GET', '/api/manage/models/10/delete-impact', undefined, 'startup-auth-impact']
    ]) {
      const response = await request(fixture.application, method, pathname, body, requestId);
      assert.equal(response.status, 200, `${method} ${pathname}`);
      assert.equal(response.body.ok, true, `${method} ${pathname}`);
    }

    for (const [method, pathname, body, requestId] of [
      ['POST', '/api/manage/models', MODEL_WRITE, 'startup-auth-create'],
      ['PUT', '/api/manage/models/10', MODEL_WRITE, 'startup-auth-update'],
      ['DELETE', '/api/manage/models/10', undefined, 'startup-auth-delete']
    ]) {
      const response = await request(fixture.application, method, pathname, body, requestId);
      assert.equal(response.status, 403, `${method} ${pathname}`);
      assert.equal(response.body.error.code, 'WRITE_FORBIDDEN', `${method} ${pathname}`);
    }
  } finally {
    await closeFixture(fixture);
  }
});

test('真实 startLocalApplication 接线覆盖六个模型 operationId 的成功路径', { concurrency: false }, async () => {
  const fixture = await createFixture(() => true);
  try {
    const listed = await request(fixture.application, 'GET', '/api/manage/models?page=1&page_size=20', undefined, 'startup-model-list');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.ok, true);
    assert.deepEqual(listed.body.data.items, []);

    const created = await request(fixture.application, 'POST', '/api/manage/models', MODEL_WRITE, 'startup-model-create');
    assert.equal(created.status, 201);
    assert.equal(created.body.ok, true);
    const id = created.body.data.id;

    const detail = await request(fixture.application, 'GET', `/api/manage/models/${id}`, undefined, 'startup-model-detail');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.id, id);

    const impactBeforeUpdate = await request(fixture.application, 'GET', `/api/manage/models/${id}/delete-impact`, undefined, 'startup-model-impact-before-update');
    assert.equal(impactBeforeUpdate.status, 200);
    assert.equal(impactBeforeUpdate.body.data.target.id, id);

    const updated = await request(fixture.application, 'PUT', `/api/manage/models/${id}`, MODEL_WRITE_UPDATED, 'startup-model-update');
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.file_name, MODEL_WRITE_UPDATED.file_name);

    const impactBeforeDelete = await request(fixture.application, 'GET', `/api/manage/models/${id}/delete-impact`, undefined, 'startup-model-impact-before-delete');
    assert.equal(impactBeforeDelete.status, 200);
    const deleted = await request(fixture.application, 'DELETE', `/api/manage/models/${id}`, { impact_token: impactBeforeDelete.body.data.impact_token }, 'startup-model-delete');
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.ok, true);
  } finally {
    await closeFixture(fixture);
  }
});
