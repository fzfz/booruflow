import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inTransaction, openCatalogDatabase } from '../app/catalog/database.mjs';
import { createMaintenanceService } from '../app/maintenance/maintenance-service.mjs';
import { createMediaStorage } from '../app/media/media-storage.mjs';
import { createCharacterVectorMaintenance } from '../app/vector/character-semantic.mjs';
import { createStyleVectorMaintenance } from '../app/vector/style-semantic.mjs';
import { createWorkVectorMaintenance } from '../app/vector/work-semantic.mjs';
import { createPromptTermVectorMaintenance } from '../app/vector/prompt-term-semantic.mjs';
import { createGenerationLoraVectorMaintenance } from '../app/vector/generation-lora-semantic.mjs';
import { createArtistPromptStringVectorMaintenance } from '../app/vector/artist-prompt-string-semantic.mjs';
import {
  createFakeSemanticModelClient,
  FAKE_VECTOR_CONFIGURATION,
  FIXTURE_VECTOR_DIMENSION
} from '../tests/fixtures/vector/fake-semantic-model-client.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TEST_PORTS = Object.freeze({ public: 19182, internal: 19183, control: 19184 });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 96, 0, 0, 0, 2, 0, 1, 229, 39, 212, 162, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const lockDirectory = join(tmpdir(), 'noobai-test-app.lock');
const activeCleanups = new Set();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await Promise.all([...activeCleanups].map((cleanup) => cleanup()));
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function sqliteString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function createCurrentTestDatabase(databasePath, mediaRoot) {
  const source = openCatalogDatabase({
    databasePath: ':memory:',
    mediaRoot,
    includeBuiltinComfyuiCatalog: false
  });
  try {
    source.exec(`VACUUM INTO ${sqliteString(databasePath)}`);
  } finally {
    source.close();
  }
}

async function acquireLock() {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await mkdir(lockDirectory);
      let releasePromise;
      return async () => {
        releasePromise ??= rm(lockDirectory, { recursive: true, force: true });
        await releasePromise;
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('test environment lock timed out');
      await delay(25);
    }
  }
}

async function assertPortFree(port) {
  const probe = createNetServer();
  await new Promise((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolvePromise);
  });
  await new Promise((resolvePromise, reject) => probe.close((error) => error ? reject(error) : resolvePromise()));
}

function assertRealConfiguration({ requireRealApi, apiConfig }) {
  if (requireRealApi && (apiConfig === null || apiConfig === undefined)) {
    throw new Error('real API configuration is required');
  }
}

async function clearDirectory(directory) {
  let entries;
  try { entries = await readdir(directory); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true });
    return;
  }
  await Promise.all(entries.map((entry) => rm(join(directory, entry), { recursive: true, force: true })));
}

function clearDatabase(database) {
  inTransaction(database, () => {
    database.exec(`
      DELETE FROM audit_events;
      DELETE FROM vector_knn_index;
      DELETE FROM vector_entries;
      DELETE FROM item_images;
      DELETE FROM artist_prompt_string_styles;
      DELETE FROM comfyui_templates;
      DELETE FROM generation_loras;
      DELETE FROM generation_models;
      DELETE FROM artist_prompt_strings;
      DELETE FROM characters;
      DELETE FROM styles;
      DELETE FROM works;
      DELETE FROM generation_base_models;
    `);
  });
}

async function seedGenerationResourceFixture(database, mediaRoot) {
  const now = '2026-08-02T00:00:00Z';
  const workflow = {};
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (801, ?, ?, ?)').run('Fixture WAI', now, now);
  database.prepare(`INSERT INTO generation_models(id, base_model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at)
    VALUES (802, 801, 'fixture-model.safetensors', 'safetensors', 'fp16', 'fixture model', 'fixture usage', ?, ?)`).run(now, now);
  database.prepare(`INSERT INTO generation_loras(id, base_model_id, model_id, file_name, file_format, precision_or_quantization, description, usage, created_at, updated_at)
    VALUES (803, 801, 802, 'fixture-lora.safetensors', 'safetensors', 'fp16', 'fixture lora', 'fixture usage', ?, ?)`).run(now, now);
  database.prepare(`INSERT INTO comfyui_templates(id, base_model_id, model_id, lora_id, template_type, title, template_json, created_at, updated_at)
    VALUES (804, 801, 802, 803, 'text_to_image', 'Fixture template', ?, ?, ?)`).run(JSON.stringify(workflow), now, now);
  database.prepare(`INSERT INTO artist_prompt_strings(id, title, description, artist_string, base_model_id, created_at, updated_at)
    VALUES (805, 'Fixture artist', 'fixture artist', 'fixture_artist:1.0', 801, ?, ?)`).run(now, now);
  for (const [id, ownerKind, ownerId, mediaPath] of [
    [806, 'model', 802, 'images/fixture-model.png'],
    [807, 'lora', 803, 'images/fixture-lora.png'],
    [808, 'template', 804, 'images/fixture-template.png']
  ]) {
    database.prepare(`INSERT INTO item_images(id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`).run(id, ownerKind, ownerId, `fixture-hash-${id}`, mediaPath, now, now);
    const target = join(mediaRoot, mediaPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, png, { flag: 'wx' });
  }
}

async function seedCatalog(database, mediaRoot, { semanticFixtures = false } = {}) {
  const now = '2026-07-29T00:00:00Z';
  database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (700, ?, ?, ?)').run('fixture-style-wai', now, now);
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (1, '联调作品', '联调作品', '["测试作品"]', 1, ?, ?)` ).run(now, now);
  database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (2, 1, '联调角色', '联调角色', '[]', 'test character', 1, ?, ?)` ).run(now, now);
  database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (3, 700, '联调画风', '[]', 'test style', NULL, NULL)` ).run();
  if (semanticFixtures) {
    database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (4, '语义作品后返回', '语义作品后返回', '[]', 1, ?, ?)` ).run(now, now);
    database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (5, 1, '语义角色后返回', '语义角色后返回', '[]', 'semantic character', 1, ?, ?)` ).run(now, now);
    database.prepare(`INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (6, 700, '语义画风后返回', '[]', 'semantic style', NULL, NULL)` ).run();
  }
  const mediaStorage = createMediaStorage({ mediaRoot });
  const service = createMaintenanceService({ database, mediaStorage });
  await service.uploadImages('character', 2, [{ bytes: png, media_type: 'image/png' }]);
  await service.uploadImages('work', 1, [{ bytes: png, media_type: 'image/png' }]);
}

async function buildSemanticFixtureIndexes(database) {
  const modelClient = createFakeSemanticModelClient();
  const now = () => new Date('2026-08-02T00:00:00.000Z');
  database.prepare("UPDATE vector_spaces SET embedding_model = ?, dimension = ? WHERE object_kind IN ('work', 'character', 'style', 'prompt_term')").run(FAKE_VECTOR_CONFIGURATION.embedding_model, FIXTURE_VECTOR_DIMENSION);
  await createWorkVectorMaintenance({ database, configuration: FAKE_VECTOR_CONFIGURATION, modelClient, now }).rebuild();
  await createCharacterVectorMaintenance({ database, configuration: FAKE_VECTOR_CONFIGURATION, modelClient, now }).rebuild();
  await createStyleVectorMaintenance({ database, configuration: FAKE_VECTOR_CONFIGURATION, modelClient, now }).rebuild();
  await createPromptTermVectorMaintenance({ database, configuration: FAKE_VECTOR_CONFIGURATION, modelClient, now }).rebuild();
}

async function buildGenerationResourceFixtureIndexes(database) {
  const modelClient = createFakeSemanticModelClient();
  const now = () => new Date('2026-08-02T00:00:00.000Z');
  await createGenerationLoraVectorMaintenance({ database, configuration: FAKE_VECTOR_CONFIGURATION, modelClient, now }).rebuild();
  await createArtistPromptStringVectorMaintenance({ database, configuration: FAKE_VECTOR_CONFIGURATION, modelClient, now }).rebuild();
}

async function initializeEnvironment(paths, { failStage, semanticFixtures = false, generationResourceFixture = false } = {}) {
  if (failStage === 'migration') throw new Error('migration failure requested');
  await mkdir(dirname(paths.database), { recursive: true });
  createCurrentTestDatabase(paths.database, paths.media);
  const database = openCatalogDatabase({ databasePath: paths.database, mediaRoot: paths.media });
  try {
    if (failStage === 'import') throw new Error('import failure requested');
    await clearDirectory(paths.media);
    await mkdir(join(paths.media, 'images'), { recursive: true });
    await mkdir(join(paths.media, '.staging'), { recursive: true });
    await seedCatalog(database, paths.media, { semanticFixtures });
    if (generationResourceFixture) {
      await seedGenerationResourceFixture(database, paths.media);
      await buildGenerationResourceFixtureIndexes(database);
    }
    if (semanticFixtures) await buildSemanticFixtureIndexes(database);
  } finally {
    database.close();
  }
}

async function resetEnvironment(paths, { failStage, semanticFixtures = false, generationResourceFixture = false } = {}) {
  if (failStage === 'reset') throw new Error('reset failure requested');
  const database = openCatalogDatabase({ databasePath: paths.database, mediaRoot: paths.media });
  try {
    clearDatabase(database);
    await clearDirectory(paths.media);
    await mkdir(join(paths.media, 'images'), { recursive: true });
    await mkdir(join(paths.media, '.staging'), { recursive: true });
    await seedCatalog(database, paths.media, { semanticFixtures });
    if (generationResourceFixture) {
      await seedGenerationResourceFixture(database, paths.media);
      await buildGenerationResourceFixtureIndexes(database);
    }
    if (semanticFixtures) await buildSemanticFixtureIndexes(database);
  } finally {
    database.close();
  }
}

function tokenMatches(value, token) {
  if (typeof value !== 'string' || typeof token !== 'string') return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function startResetChannel({ token, paths, semanticFixtures, generationResourceFixture }) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('test reset token is required');
  let pendingReset = Promise.resolve();
  const server = createServer((request, response) => {
    const run = async () => {
      if (request.socket.remoteAddress !== '127.0.0.1' || request.method !== 'POST' || request.url !== '/_test/reset') {
        response.writeHead(404);
        response.end();
        return;
      }
      if (!tokenMatches(request.headers['x-noobai-test-reset-token'], token)) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'test reset token is required' }));
        return;
      }
      const failStage = request.headers['x-noobai-test-fail-stage'];
      pendingReset = pendingReset.then(() => resetEnvironment(paths, { failStage, semanticFixtures, generationResourceFixture }));
      try {
        await pendingReset;
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ reset: true }));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ reset: false, error: error.message }));
      }
    };
    void run();
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(TEST_PORTS.control, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  return Object.freeze({
    resetUrl: `http://127.0.0.1:${TEST_PORTS.control}/_test/reset`,
    close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  });
}

function makePaths(root) {
  return Object.freeze({
    database: join(root, 'catalog', 'app.sqlite'),
    media: join(root, 'catalog', 'media'),
    diagnosticLog: join(root, 'catalog', 'diagnostics', 'request-lifecycle.jsonl'),
    home: join(root, 'home'),
    tmp: join(root, 'tmp'),
    xdgConfigHome: join(root, 'xdg', 'config'),
    xdgDataHome: join(root, 'xdg', 'data'),
    xdgCacheHome: join(root, 'xdg', 'cache')
  });
}

function testEnvironment(paths, { resetToken, semanticFixtures, baseModelDetailReadBehavior, operationIdHeader }) {
  return Object.freeze({
    HOME: paths.home,
    TMPDIR: paths.tmp,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_DATA_HOME: paths.xdgDataHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    NOOBAI_TEST_MODE: '1',
    ...(operationIdHeader === true ? { NOOBAI_TEST_OPERATION_ID_HEADER: '1' } : {}),
    ...(operationIdHeader === false ? { NOOBAI_TEST_OPERATION_ID_HEADER: '0' } : {}),
    NOOBAI_TEST_RESET_TOKEN: resetToken,
    NOOBAI_PUBLIC_PORT: String(TEST_PORTS.public),
    NOOBAI_INTERNAL_PORT: String(TEST_PORTS.internal),
    NOOBAI_TEST_SEMANTIC_FIXTURES: semanticFixtures ? '1' : '0',
    NOOBAI_TEST_BASE_MODEL_DETAIL_READ_BEHAVIOR: baseModelDetailReadBehavior
  });
}

function mergeEnvironment(base, overrides) {
  validateEnvironmentOverrides(overrides);
  const merged = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    merged[name] = value;
  }
  return Object.freeze(merged);
}

function validateEnvironmentOverrides(overrides) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('environmentOverrides must be an object');
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (typeof name !== 'string' || name.length === 0) throw new TypeError('environment override names must be non-empty strings');
    if (value !== undefined && typeof value !== 'string') throw new TypeError(`environment override ${name} must be a string or undefined`);
  }
}

function applyEnvironment(values) {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function configuredPort(environment, name, fallback) {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new TypeError(`${name} must be an integer TCP port`);
  return value;
}

async function waitForApplication(child, { timeoutMs = 8_000 } = {}) {
  let output = '';
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('close', onClose);
    };
    const resolveStartup = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise();
    };
    const rejectStartup = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onStdout = (chunk) => {
      output += chunk.toString();
      if (output.includes('应用已启动：')) resolveStartup();
    };
    const onStderr = (chunk) => { output += chunk.toString(); };
    const onError = (error) => rejectStartup(error);
    const onExit = (code, signal) => rejectStartup(new Error(`test application exited before startup: ${code ?? signal} ${output}`));
    const onClose = (code, signal) => rejectStartup(new Error(`test application closed before startup: ${code ?? signal} ${output}`));
    timer = setTimeout(() => rejectStartup(new Error(`test application startup timed out: ${output}`)), timeoutMs);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('close', onClose);
  });
}

export async function startTestApp({
  testMode = false,
  resetToken = 'noobai-test-reset-token',
  requireRealApi = false,
  apiConfig,
  failStage,
  semanticFixtures = false,
  generationResourceFixture = false,
  baseModelDetailReadBehavior = 'none',
  operationIdHeader = true,
  spawnChild = spawn,
  applicationStarter = null,
  environmentOverrides = {},
  startupTimeoutMs = 8_000
} = {}) {
  if (!['none', 'delay', 'fail'].includes(baseModelDetailReadBehavior)) throw new TypeError('baseModelDetailReadBehavior must be none, delay, or fail');
  if (applicationStarter !== null && typeof applicationStarter !== 'function') throw new TypeError('applicationStarter must be a function or null');
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs <= 0) throw new TypeError('startupTimeoutMs must be a positive integer');
  assertRealConfiguration({ requireRealApi, apiConfig });
  if (![true, false, null, undefined].includes(operationIdHeader)) throw new TypeError('operationIdHeader must be true, false, null, or undefined');
  validateEnvironmentOverrides(environmentOverrides);
  const releaseLock = await acquireLock();
  const root = await mkdtemp(join(tmpdir(), 'noobai-manage-e2e-'));
  const paths = makePaths(root);
  const environment = mergeEnvironment(testEnvironment(paths, { resetToken, semanticFixtures, baseModelDetailReadBehavior, operationIdHeader }), environmentOverrides);
  let child = null;
  let application = null;
  let resetChannel = null;
  let stopped = false;
  let cleaned = false;
  let childClosed = false;
  let childClosePromise = Promise.resolve();
  let restoreProcessEnvironment = null;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      if (resetChannel) await resetChannel.close();
      if (child && !childClosed) {
        child.kill('SIGTERM');
        await childClosePromise.catch(() => {});
      }
      if (application) await application.close();
    } finally {
      restoreProcessEnvironment?.();
      restoreProcessEnvironment = null;
    }
  };
  const cleanupResources = async () => {
    await rm(root, { recursive: true, force: true });
    await releaseLock();
    cleaned = true;
    activeCleanups.delete(close);
  };
  const close = async ({ failStage: closeFailStage } = {}) => {
    if (cleaned) return;
    let stopError = null;
    try {
      await stop();
    } catch (error) {
      stopError = error;
    }
    if (stopError || closeFailStage !== 'cleanup') {
      let cleanupError = null;
      try {
        await cleanupResources();
      } catch (error) {
        cleanupError = error;
      }
      if (stopError) {
        if (cleanupError) throw new AggregateError([stopError, cleanupError], 'test application cleanup failed after application close error');
        throw stopError;
      }
      if (cleanupError) throw cleanupError;
      return;
    }
    throw new Error('cleanup failure requested');
  };
  activeCleanups.add(close);
  try {
    await Promise.all([
      ...Object.values(paths).map((path) => mkdir(dirname(path), { recursive: true })),
      mkdir(paths.media, { recursive: true }),
      mkdir(paths.home, { recursive: true }),
      mkdir(paths.tmp, { recursive: true }),
      mkdir(paths.xdgConfigHome, { recursive: true }),
      mkdir(paths.xdgDataHome, { recursive: true }),
      mkdir(paths.xdgCacheHome, { recursive: true })
    ]);
    const publicPort = configuredPort(environment, 'NOOBAI_PUBLIC_PORT', TEST_PORTS.public);
    const internalPort = configuredPort(environment, 'NOOBAI_INTERNAL_PORT', TEST_PORTS.internal);
    await assertPortFree(publicPort);
    await assertPortFree(internalPort);
    if (testMode) await assertPortFree(TEST_PORTS.control);
    await initializeEnvironment(paths, { failStage, semanticFixtures, generationResourceFixture });
    await writeFile(join(root, 'upload.png'), png, { flag: 'wx' });
    if (testMode) resetChannel = await startResetChannel({ token: resetToken, paths, semanticFixtures, generationResourceFixture });
    const applicationEnvironment = { ...environment, NOOBAI_TEST_TEMP_PARENT: dirname(root) };
    delete applicationEnvironment.NOOBAI_TEST_RESET_TOKEN;
    if (applicationStarter === null) {
      child = spawnChild(process.execPath, ['scripts/start-isolated-test-app.mjs', root], {
        cwd: repositoryRoot,
        env: Object.fromEntries(Object.entries(applicationEnvironment).filter(([, value]) => value !== undefined)),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      childClosePromise = new Promise((resolvePromise) => {
        child.once('close', (code, signal) => {
          childClosed = true;
          resolvePromise({ code, signal });
        });
      });
      await waitForApplication(child, { timeoutMs: startupTimeoutMs });
    } else {
      restoreProcessEnvironment = applyEnvironment(applicationEnvironment);
      const startedApplication = await applicationStarter(Object.freeze({ repositoryRoot, root, paths, environment: Object.freeze({ ...applicationEnvironment }) }));
      if (!startedApplication || typeof startedApplication.close !== 'function') throw new TypeError('applicationStarter must return an application with close()');
      application = startedApplication;
    }
    const resetUrl = resetChannel?.resetUrl;
    const reset = async ({ failStage: resetFailStage } = {}) => {
      if (!resetUrl) throw new Error('test reset is unavailable outside test mode');
      const response = await fetch(resetUrl, {
        method: 'POST',
        headers: {
          'x-noobai-test-reset-token': resetToken,
          ...(resetFailStage ? { 'x-noobai-test-fail-stage': resetFailStage } : {})
        }
      });
      if (!response.ok) throw new Error(`test reset failed: ${await response.text()}`);
      return Object.freeze({ status: response.status, body: await response.json() });
    };
    const actualPublicPort = application?.publicAddress?.port ?? publicPort;
    const actualInternalPort = application?.internalAddress?.port ?? internalPort;
    return Object.freeze({
      baseUrl: `http://127.0.0.1:${actualPublicPort}`,
      internalBaseUrl: `http://127.0.0.1:${actualInternalPort}`,
      ...(resetUrl ? { resetUrl, reset } : {}),
      root,
      paths,
      environment,
      inheritedEnvironmentKeys: Object.freeze([]),
      testMode,
      processId: child?.pid ?? null,
      uploadFixture: join(root, 'upload.png'),
      child,
      application,
      close
    });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
