import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { startLocalApplication } from '../../app/server/local-app.mjs';
import { FAKE_VECTOR_CONFIGURATION, createFakeSemanticModelClient } from '../fixtures/vector/fake-semantic-model-client.mjs';

const runProcess = promisify(execFile);
const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const CLI_PATH = resolve(REPOSITORY_ROOT, 'scripts/imagegen-semantic-query.mjs');
const BASE_MODEL_PATH = '/internal/semantic/base-models';
const GENERATION_MODEL_PATH = '/internal/semantic/generation-models';
const LORA_PATH = '/internal/semantic/loras';
const WORK_PATH = '/internal/semantic/works';
const CHARACTER_PATH = '/internal/semantic/characters';
const STYLE_PATH = '/internal/semantic/styles';
const ARTIST_PROMPT_STRING_PATH = '/internal/semantic/artist-prompt-strings';
const COMFYUI_INSTANCE_PATH = '/internal/semantic/comfyui-instances';
const COMFYUI_TEMPLATE_PATH = '/internal/semantic/comfyui-templates';

function restoreEnvironment(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return port;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-278-catalog-http-cli-'));
  const dataRoot = join(root, 'data');
  const paths = Object.freeze({
    dataRoot,
    databasePath: join(dataRoot, 'app.sqlite'),
    mediaRoot: join(dataRoot, 'media')
  });
  const publicPort = await reservePort();
  let internalPort = await reservePort();
  while (internalPort === publicPort) internalPort = await reservePort();
  const restores = [
    restoreEnvironment('NODE_ENV', 'test'),
    restoreEnvironment('NOOBAI_PUBLIC_PORT', String(publicPort)),
    restoreEnvironment('NOOBAI_INTERNAL_PORT', String(internalPort)),
    restoreEnvironment('NOOBAI_TEST_EMPTY_COMFYUI_CATALOG', '1')
  ];
  let application = null;
  try {
    await mkdir(join(paths.dataRoot, 'media'), { recursive: true });
    runMediaCutover({ databasePath: paths.databasePath, mediaRoot: paths.mediaRoot, repositoryRoot: REPOSITORY_ROOT });

    const database = openCatalogDatabase({
      databasePath: paths.databasePath,
      mediaRoot: paths.mediaRoot,
      repositoryRoot: REPOSITORY_ROOT,
      includeBuiltinComfyuiCatalog: false
    });
    try {
      const now = '2026-08-22T00:00:00.000Z';
      database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(901, 'Fixture WAI', now, now);
      database.prepare(`INSERT INTO generation_models(
        id, base_model_id, file_name, file_format, precision_or_quantization,
        description, usage, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(902, 901, 'fixture-model.safetensors', 'safetensors', 'fp16', 'fixture description', 'fixture usage', now, now);
      const insertImage = database.prepare(`INSERT INTO item_images(
        id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
      ) VALUES (?, 'model', 902, ?, ?, ?, ?, ?)`);
      insertImage.run(903, 'hash-903', 'models/fixture-cover.webp', 0, now, now);
      insertImage.run(904, 'hash-904', 'models/fixture-example-2.webp', 1, now, now);
      insertImage.run(905, 'hash-905', 'models/fixture-example-3.webp', 2, now, now);
      database.prepare('UPDATE generation_models SET cover_media_path = ? WHERE id = 902').run('models/fixture-cover.webp');
    } finally {
      database.close();
    }

    application = await startLocalApplication({
      repositoryRoot: REPOSITORY_ROOT,
      dataPaths: paths,
      listenerMode: 'internal-only',
      vectorConfiguration: FAKE_VECTOR_CONFIGURATION,
      vectorModelClient: createFakeSemanticModelClient(),
      authorizeWrite: () => false,
      onStarted: () => {}
    });
    return Object.freeze({ root, application, restores });
  } catch (error) {
    if (application) await application.close();
    for (const restore of restores.reverse()) restore();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function runCli(port, path, args) {
  const result = await runProcess(process.execPath, [CLI_PATH, '--port', String(port), '--path', path, ...args], { cwd: REPOSITORY_ROOT });
  return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
}

function assertJsonOutput(result) {
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(result.stdout, JSON.stringify(parsed));
  return parsed;
}

test('Issue 278 Catalog discovery and CLI use the real HTTP listener and isolated SQLite records', { concurrency: false }, async () => {
  const fixture = await createFixture();
  try {
    const internalBaseUrl = `http://127.0.0.1:${fixture.application.internalAddress.port}`;
    const discoveryResponse = await fetch(`${internalBaseUrl}/internal/semantic`);
    assert.equal(discoveryResponse.status, 200);
    const discovery = await discoveryResponse.json();
    assert.deepEqual(Object.keys(discovery.paths), [BASE_MODEL_PATH, GENERATION_MODEL_PATH, LORA_PATH, WORK_PATH, CHARACTER_PATH, STYLE_PATH, '/internal/semantic/prompt-terms', ARTIST_PROMPT_STRING_PATH, COMFYUI_INSTANCE_PATH, COMFYUI_TEMPLATE_PATH]);
    assert.equal(discovery.paths[BASE_MODEL_PATH].post.operationId, 'querySemanticBaseModelsForSkill');
    assert.equal(discovery.paths[GENERATION_MODEL_PATH].post.operationId, 'querySemanticGenerationModelsForSkill');
    assert.equal(discovery.paths[WORK_PATH].post.operationId, 'querySemanticWorksForSkill');
    assert.equal(discovery.paths[CHARACTER_PATH].post.operationId, 'querySemanticCharactersForSkill');
    assert.equal(discovery.paths[STYLE_PATH].post.operationId, 'querySemanticStylesForSkill');

    const workResponse = await fetch(`${internalBaseUrl}${WORK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'search', query: '' })
    });
    assert.equal(workResponse.status, 200);
    const workBody = await workResponse.json();
    assert.equal(workBody.status, 'ok');
    assert.deepEqual(workBody.results, []);

    const search = assertJsonOutput(await runCli(fixture.application.internalAddress.port, BASE_MODEL_PATH, [
      '--mode', 'search', '--query', 'fixture', '--page', '1', '--page_size', '20'
    ]));
    assert.equal(search.status, 'ok');
    assert.deepEqual(search.results.map((item) => item.name), ['Fixture WAI']);
    assert.equal(search.results[0].id, 901);

    const httpResolveResponse = await fetch(`${internalBaseUrl}${GENERATION_MODEL_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'resolve', id: '902' })
    });
    assert.equal(httpResolveResponse.status, 200);
    const httpResolveText = await httpResolveResponse.text();
    const cliResolve = await runCli(fixture.application.internalAddress.port, GENERATION_MODEL_PATH, [
      '--mode', 'resolve', '--id', '902'
    ]);
    const resolve = assertJsonOutput(cliResolve);
    assert.equal(cliResolve.stdout, httpResolveText);
    assert.equal(resolve.status, 'ok');
    assert.equal(resolve.results[0].id, 902);
    assert.equal(resolve.results[0].file_name, 'fixture-model.safetensors');
    assert.equal(resolve.results[0].base_model_id, 901);
    assert.equal(resolve.results[0].cover_url.endsWith('/media/models/fixture-cover.webp'), true);
    assert.deepEqual(resolve.results[0].sample_image_urls.map((url) => new URL(url).pathname), [
      '/media/models/fixture-example-2.webp',
      '/media/models/fixture-example-3.webp'
    ]);
  } finally {
    await fixture.application.close();
    for (const restore of fixture.restores.reverse()) restore();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
