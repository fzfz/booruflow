import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { inTransaction, openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { startLocalApplication } from '../../app/server/local-app.mjs';
import { FAKE_VECTOR_CONFIGURATION, createFakeSemanticModelClient } from '../fixtures/vector/fake-semantic-model-client.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC_PORT = 19982;
const INTERNAL_PORT = 19983;
const LORA_WRITE = Object.freeze({
  base_model_id: 801,
  model_id: 802,
  file_name: 'uncertain.safetensors',
  file_format: 'safetensors',
  precision_or_quantization: 'fp16',
  description: 'uncertain transaction fixture',
  usage: 'uncertain transaction fixture',
  trigger_words: ['uncertain_fixture'],
  weight: 0.75
});

function setEnvironment(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-276-uncertain-'));
  const dataRoot = join(root, 'data');
  const databasePath = join(dataRoot, 'app.sqlite');
  const mediaRoot = join(dataRoot, 'media');
  const restoreEnvironment = [
    setEnvironment('NODE_ENV', 'test'),
    setEnvironment('NOOBAI_TEST_EMPTY_COMFYUI_CATALOG', '1'),
    setEnvironment('NOOBAI_PUBLIC_PORT', String(PUBLIC_PORT)),
    setEnvironment('NOOBAI_INTERNAL_PORT', String(INTERNAL_PORT))
  ];
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot: REPOSITORY_ROOT });
  const seedDatabase = openCatalogDatabase({ databasePath, mediaRoot, repositoryRoot: REPOSITORY_ROOT });
  seedDatabase.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES (801, 'Uncertain WAI', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z');
    INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (
      802, 801, 'uncertain-model.safetensors', 'safetensors', 'fp16',
      'uncertain model', 'uncertain model', '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z'
    );
  `);
  seedDatabase.close();

  const control = {
    events: [],
    beginCount: 0,
    closeCount: 0,
    faultEnabled: false,
    database: null,
    enableFault() { this.faultEnabled = true; }
  };
  const databaseFactory = ({ databasePath: selectedDatabasePath, mediaRoot: selectedMediaRoot, repositoryRoot: selectedRepositoryRoot }) => {
    const rawDatabase = openCatalogDatabase({ databasePath: selectedDatabasePath, mediaRoot: selectedMediaRoot, repositoryRoot: selectedRepositoryRoot });
    const database = new Proxy(rawDatabase, {
      get(target, property) {
        if (property === 'exec') {
          return (sql) => {
            if (sql === 'BEGIN IMMEDIATE;') control.beginCount += 1;
            if (control.faultEnabled && sql === 'COMMIT;') throw new Error('forced commit result unavailable');
            if (control.faultEnabled && sql === 'ROLLBACK;') throw new Error('forced rollback result unavailable');
            return target.exec(sql);
          };
        }
        if (property === 'close') {
          return () => {
            control.closeCount += 1;
            control.events.push('database_close');
            return target.close();
          };
        }
        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    control.database = database;
    return database;
  };
  let application;
  try {
    application = await startLocalApplication({
      repositoryRoot: REPOSITORY_ROOT,
      dataPaths: { dataRoot, databasePath, mediaRoot },
      listenerMode: 'all',
      vectorConfiguration: FAKE_VECTOR_CONFIGURATION,
      vectorModelClient: createFakeSemanticModelClient(),
      databaseFactory,
      authorizeWrite: () => true,
      onStarted: () => {}
    });
  } catch (error) {
    for (const restore of [...restoreEnvironment].reverse()) restore();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({ application, control, root, restoreEnvironment });
}

async function closeFixture(fixture) {
  try {
    await fixture.application.close();
  } finally {
    for (const restore of [...fixture.restoreEnvironment].reverse()) restore();
    await rm(fixture.root, { recursive: true, force: true });
  }
}

async function requestJson(fixture, method, pathname, body, requestId) {
  const response = await fetch(`http://127.0.0.1:${fixture.application.publicAddress.port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-request-id': requestId },
    body: JSON.stringify(body)
  });
  return Object.freeze({ response, body: await response.json() });
}

test('Issue #276 uncertain HTTP response completes before application closes both listeners and database', { concurrency: false }, async () => {
  const fixture = await createFixture();
  try {
    const normal = await requestJson(fixture, 'POST', '/api/manage/loras', {}, 'uncertain-normal-validation');
    assert.equal(normal.response.status, 422);
    assert.equal(normal.body.error.code, 'VALIDATION_ERROR');
    assert.deepEqual(fixture.control.events, []);
    const stillOpen = await fetch(`http://127.0.0.1:${fixture.application.publicAddress.port}/api/manage/loras`);
    assert.equal(stillOpen.status, 200);
    await stillOpen.arrayBuffer();

    fixture.control.enableFault();
    const uncertain = await requestJson(fixture, 'POST', '/api/manage/loras', LORA_WRITE, 'uncertain-write');
    assert.equal(uncertain.response.status, 500);
    assert.deepEqual(uncertain.body, {
      ok: false,
      request_id: 'uncertain-write',
      error: { code: 'INTERNAL_ERROR', message: 'internal service error' }
    });
    assert.deepEqual(fixture.control.events, ['database_close']);
    assert.equal(fixture.control.closeCount, 1);

    await assert.rejects(fetch(`http://127.0.0.1:${fixture.application.publicAddress.port}/api/manage/loras`));
    await assert.rejects(fetch(`http://127.0.0.1:${fixture.application.internalAddress.port}/internal/semantic`));
    const statementsBeforeRetry = fixture.control.beginCount;
    assert.throws(() => inTransaction(fixture.control.database, () => {}), /connection is not serviceable/u);
    assert.equal(fixture.control.beginCount, statementsBeforeRetry);

    await fixture.application.close();
    assert.equal(fixture.control.closeCount, 1);
  } finally {
    await closeFixture(fixture);
  }
});
