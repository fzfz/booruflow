import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveSemanticOpenapiPath, startLocalApplication } from '../../app/server/local-app.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { FAKE_VECTOR_CONFIGURATION, createFakeSemanticModelClient } from '../fixtures/vector/fake-semantic-model-client.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const TEST_PORTS = Object.freeze({ public: 19782, internal: 19783 });

function restoreEnvironment(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-177-discovery-'));
  const dataRoot = join(root, 'data');
  const databasePath = join(dataRoot, 'app.sqlite');
  const mediaRoot = join(dataRoot, 'media');
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot });
  const restore = [
    restoreEnvironment('NODE_ENV', 'test'),
    restoreEnvironment('NOOBAI_TEST_EMPTY_COMFYUI_CATALOG', '1'),
    restoreEnvironment('NOOBAI_PUBLIC_PORT', String(TEST_PORTS.public)),
    restoreEnvironment('NOOBAI_INTERNAL_PORT', String(TEST_PORTS.internal))
  ];
  return Object.freeze({ root, dataPaths: Object.freeze({ dataRoot, databasePath, mediaRoot }), restore: Object.freeze(restore) });
}

test('Issue #177 exposes frozen Catalog discovery only on the internal listener and keeps direct-page POST dispatch alive', { concurrency: false }, async () => {
  const fixture = await createFixture();
  let application;
  try {
    application = await startLocalApplication({
      repositoryRoot,
      dataPaths: fixture.dataPaths,
      vectorConfiguration: FAKE_VECTOR_CONFIGURATION,
      vectorModelClient: createFakeSemanticModelClient(),
      authorizeWrite: () => false,
      onStarted: () => {}
    });
    assert.equal(Object.isFrozen(application.semanticDiscovery), true);
    const internalUrl = `http://127.0.0.1:${application.internalAddress.port}`;
    const publicUrl = `http://127.0.0.1:${application.publicAddress.port}`;
    const internalResponse = await fetch(`${internalUrl}/internal/semantic`);
    assert.equal(internalResponse.status, 200);
    const internalBody = await internalResponse.json();
    assert.deepEqual(internalBody, application.semanticDiscovery);
    assert.equal(Object.hasOwn(internalBody, 'ok'), false);
    assert.equal(Object.hasOwn(internalBody, 'request_id'), false);
    assert.deepEqual(Object.keys(internalBody.paths), [
      '/internal/semantic/base-models',
      '/internal/semantic/generation-models',
      '/internal/semantic/loras',
      '/internal/semantic/works',
      '/internal/semantic/characters',
      '/internal/semantic/styles',
      '/internal/semantic/prompt-terms',
      '/internal/semantic/artist-prompt-strings',
      '/internal/semantic/comfyui-instances',
      '/internal/semantic/comfyui-templates'
    ]);
    assert.deepEqual(Object.keys(internalBody).sort(), ['components', 'info', 'openapi', 'paths', 'x-imagegen-media-origin']);

    const publicResponse = await fetch(`${publicUrl}/internal/semantic`);
    assert.equal(publicResponse.status, 404);
    const publicBody = await publicResponse.json();
    assert.equal(publicBody.ok, false);

    for (const path of [
      '/internal/semantic/base-models',
      '/internal/semantic/generation-models'
    ]) {
      const semanticPost = await fetch(`${internalUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'search', query: 'probe', page: 1, page_size: 1 })
      });
      assert.equal(semanticPost.status, 200);
      const semanticBody = await semanticPost.json();
      assert.deepEqual(semanticBody, {
        status: 'ok',
        message: null,
        results: [],
        page: 1,
        page_size: 1,
        total_count: 0
      });
      assert.equal(Object.hasOwn(semanticBody, 'ok'), false);
      assert.equal(Object.hasOwn(semanticBody, 'request_id'), false);
    }
  } finally {
    if (application) await application.close();
    for (const restore of [...fixture.restore].reverse()) restore();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Issue #177 rejects malformed semantic discovery before opening either listener', { concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-177-discovery-invalid-'));
  const invalidOpenapiPath = join(root, 'schema/api/openapi.yaml');
  await mkdir(join(root, 'schema/api'), { recursive: true });
  await copyFile(join(repositoryRoot, 'package.json'), join(root, 'package.json'));
  await writeFile(invalidOpenapiPath, [
    'openapi: 3.1.0',
    'info: {}',
    'x-imagegen-contract-id: imagegen-source-contract',
    'x-imagegen-contract-version: 1',
    'paths: {}',
    ''
  ].join('\n'));
  const restorePublic = restoreEnvironment('NOOBAI_PUBLIC_PORT', String(TEST_PORTS.public + 2));
  const restoreInternal = restoreEnvironment('NOOBAI_INTERNAL_PORT', String(TEST_PORTS.internal + 2));
  try {
    await assert.rejects(
      startLocalApplication({ repositoryRoot: root, onStarted: () => {} }),
      /discovery requires at least one internal semantic operation/u
    );
    await assert.rejects(fetch(`http://127.0.0.1:${TEST_PORTS.internal + 2}/internal/semantic`));
  } finally {
    restoreInternal();
    restorePublic();
    await rm(root, { recursive: true, force: true });
  }
});

test('Issue #177 resolves the default semantic OpenAPI beneath the supplied repository root', async () => {
  const customRoot = await mkdtemp(join(tmpdir(), 'noobai-issue-177-custom-root-'));
  try {
    await mkdir(join(customRoot, 'schema', 'api'), { recursive: true });
    await copyFile(join(repositoryRoot, 'package.json'), join(customRoot, 'package.json'));
    await copyFile(join(repositoryRoot, 'schema/api/openapi.yaml'), join(customRoot, 'schema/api/openapi.yaml'));
    const canonicalRoot = await realpath(customRoot);
    assert.equal(
      resolveSemanticOpenapiPath({ repositoryRoot: customRoot }),
      resolve(canonicalRoot, 'schema/api/openapi.yaml')
    );
  } finally {
    await rm(customRoot, { recursive: true, force: true });
  }
});
