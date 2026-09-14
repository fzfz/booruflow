import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { migrateGenerationResourceVectors } from '../../app/catalog/generation-resource-vector-migration.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { startLocalApplication } from '../../app/server/local-app.mjs';
import { FAKE_VECTOR_CONFIGURATION, createFakeSemanticModelClient, createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CATALOG_CLI_PATH = resolve(REPOSITORY_ROOT, 'scripts/imagegen-semantic-query.mjs');
const SOURCE_CLI_PATH = resolve(REPOSITORY_ROOT, 'scripts/imagegen-comfyui-source-read.mjs');
const TEMPLATE_CATALOG_PATH = '/internal/semantic/comfyui-templates';
const VECTOR_MIGRATION_SQL_PATH = resolve(REPOSITORY_ROOT, 'schema/database/036-generation-resource-vectors.sql');

async function createRepositoryWithout036(root) {
  const sourceDirectory = resolve(REPOSITORY_ROOT, 'schema/database');
  const migrationNames = (await readdir(sourceDirectory))
    .filter((name) => /^\d{3}-.+\.sql$/u.test(name) && Number(name.slice(0, 3)) < 36)
    .sort();
  assert.equal(migrationNames.length, 35, 'the temporary migration repository must contain migrations 001 through 035');
  const repositoryRoot = join(root, 'repository-without-036');
  const destinationDirectory = join(repositoryRoot, 'schema/database');
  await mkdir(destinationDirectory, { recursive: true });
  await Promise.all(migrationNames.map((name) => copyFile(
    join(sourceDirectory, name),
    join(destinationDirectory, name)
  )));
  return repositoryRoot;
}

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

function runProcess(scriptPath, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'noobai-issue-286-source-cli-runtime-'));
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
    restoreEnvironment('NOOBAI_TEST_EMPTY_COMFYUI_CATALOG', undefined)
  ];
  let application = null;
  try {
    await mkdir(join(paths.dataRoot, 'media'), { recursive: true });
    runMediaCutover({ databasePath: paths.databasePath, mediaRoot: paths.mediaRoot, repositoryRoot: REPOSITORY_ROOT });

    const repositoryWithout036 = await createRepositoryWithout036(root);
    const database = openCatalogDatabase({
      databasePath: paths.databasePath,
      mediaRoot: paths.mediaRoot,
      repositoryRoot: repositoryWithout036,
      includeBuiltinComfyuiCatalog: true
    });
    try {
      const templateCount = database.prepare('SELECT COUNT(*) AS count FROM comfyui_templates').get().count;
      assert.ok(templateCount > 0, 'the temporary SQLite database must contain built-in ComfyUI templates');
      const migrationResult = await migrateGenerationResourceVectors({
        database,
        repositoryRoot: REPOSITORY_ROOT,
        readMigrationSql: () => readFileSync(VECTOR_MIGRATION_SQL_PATH, 'utf8'),
        generationLoraMaintenance: {
          async prepare() {
            return { object_kind: 'generation_lora', embedding_model: 'issue-286-fixture', vector: createFixtureVector() };
          }
        },
        artistPromptStringMaintenance: {
          async prepare() {
            return { object_kind: 'artist_prompt_string', embedding_model: 'issue-286-fixture', vector: createFixtureVector() };
          }
        }
      });
      assert.equal(migrationResult.status, 'complete');
      const { migrateVectorKnnIndex } = await import('../../app/catalog/vector-knn-migration.mjs');
      const knnMigrationResult = migrateVectorKnnIndex({ database, repositoryRoot: REPOSITORY_ROOT });
      assert.equal(knnMigrationResult.status, 'complete');
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

test('Issue 286 preserves the built-in Catalog result and Template Bundle service error through real CLI processes', { concurrency: false }, async () => {
  const fixture = await createFixture();
  try {
    assert.equal(fixture.application.publicAddress, null);
    const internalPort = fixture.application.internalAddress.port;
    const catalogResult = await runProcess(CATALOG_CLI_PATH, [
      '--port', String(internalPort),
      '--path', TEMPLATE_CATALOG_PATH,
      '--mode', 'search',
      '--query', '',
      '--page', '1',
      '--page_size', '100'
    ]);
    assert.equal(catalogResult.status, 0, catalogResult.stderr);
    assert.equal(catalogResult.signal, null);
    assert.equal(catalogResult.stderr, '');
    const catalogPage = JSON.parse(catalogResult.stdout);
    assert.equal(catalogPage.status, 'ok');
    assert.ok(Array.isArray(catalogPage.results) && catalogPage.results.length > 0);
    const catalogItem = catalogPage.results[0];
    assert.equal(typeof catalogItem.id, 'number');

    const bundleResult = await runProcess(SOURCE_CLI_PATH, [
      '--port', String(internalPort),
      'template-bundle',
      '--id', String(catalogItem.id)
    ]);
    assert.equal(bundleResult.status, 0, JSON.stringify({ catalogItem, bundleResult }));
    assert.equal(bundleResult.signal, null);
    assert.equal(bundleResult.stderr, '');
    const bundle = JSON.parse(bundleResult.stdout);
    assert.equal(bundle.status, 'ok');
    assert.equal(bundle.results[0].id, catalogItem.id);
  } finally {
    await fixture.application.close();
    for (const restore of fixture.restores.reverse()) restore();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
