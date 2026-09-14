import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import {
  GenerationResourceVectorMigrationError
} from '../../app/catalog/generation-resource-vector-migration.mjs';
import {
  main,
  parseArguments,
  runGenerationResourceVectorMigration
} from '../../scripts/migrate-generation-resource-vectors.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const MIGRATION_NAMES = [
  '001-initial.sql', '002-management-media.sql', '003-media-path-foundation.sql',
  '004-work-cover-character-fallback.sql', '005-media-cutover.sql',
  '006-media-cutover-skipped-cleanup.sql', '007-prompt-terms.sql',
  '008-generation-resources.sql', '009-vector-retrieval.sql',
  '010-restore-media-cover-triggers.sql', '011-style-description.sql',
  '012-session-base-model.sql', '013-session-turn-skills.sql',
  '014-vector-convergence.sql', '015-style-base-model.sql',
  '016-remove-session-work-selections.sql', '017-comfyui-template-workflow-management.sql',
  '018-comfyui-template-builtin-catalog.sql', '019-comfyui-template-runtime-corrections.sql',
  '020-comfyui-template-output-node-repairs.sql', '021-comfyui-template-active-path-repairs.sql',
  '022-comfyui-runs.sql', '023-krea2-lora-catalog.sql',
  '024-generation-lora-trigger-weight.sql', '025-remove-session-selections.sql',
  '026-session-types.sql', '027-management-skill-sessions.sql',
  '028-iterative-image-tasks.sql', '029-comfyui-iterative-runs-media.sql',
  '030-iterative-image-task-lora-adjustment.sql', '031-iterative-image-task-stage-failure.sql',
  '032-iterative-image-task-comfyui-retry.sql', '033-iterative-image-task-followup-rounds.sql',
  '034-iterative-image-task-write-idempotency.sql', '035-iterative-image-task-round-error-details.sql'
];
const TEST_VECTOR_DIMENSION = 1024;
const REQUIRED_ENVIRONMENT = Object.freeze({
  NOOBAI_INTERNAL_API_TIMEOUT_MS: '60000',
  NOOBAI_RERANKER_API_KEY: 'reranker-test-secret',
  NOOBAI_RERANKER_MODEL: 'test-reranker-model'
});

function vectorBlob(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

async function freePort() {
  const server = createServer();
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.unref();
  const port = server.address().port;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function fakeEmbeddingServer() {
  const calls = { requests: 0, inputs: 0 };
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/embeddings') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      calls.requests += 1;
      calls.inputs += body.input.length;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        data: body.input.map((_, index) => ({
          index,
          embedding: Array.from(
            { length: TEST_VECTOR_DIMENSION },
            (__, dimension) => dimension === 0 ? 3 : dimension === 1 ? 4 : 0
          )
        }))
      }));
    });
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  return {
    calls,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  };
}

function productionEnvironment({ publicPort, internalPort, embeddingBaseUrl }) {
  return Object.freeze({
    ...REQUIRED_ENVIRONMENT,
    NOOBAI_PUBLIC_PORT: String(publicPort),
    NOOBAI_INTERNAL_PORT: String(internalPort),
    NOOBAI_EMBEDDING_BASE_URL: embeddingBaseUrl,
    NOOBAI_EMBEDDING_API_KEY: 'embedding-test-secret',
    NOOBAI_EMBEDDING_MODEL: 'test-embedding-model',
    NOOBAI_RERANKER_BASE_URL: 'http://127.0.0.1:1'
  });
}

function writeProductionEnvironment(root, environment) {
  writeFileSync(resolve(root, '.env'), Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
}

function copyProductionRepository(root) {
  mkdirSync(resolve(root, 'schema/database'), { recursive: true });
  for (const name of MIGRATION_NAMES) copyFileSync(resolve(ROOT, 'schema/database', name), resolve(root, 'schema/database', name));
  mkdirSync(resolve(root, 'config/vector'), { recursive: true });
  copyFileSync(resolve(ROOT, 'config/defaults.json'), resolve(root, 'config/defaults.json'));
  copyFileSync(resolve(ROOT, 'config/vector/models.json'), resolve(root, 'config/vector/models.json'));
  mkdirSync(resolve(root, 'data'), { recursive: true });
}

function addNonEmptyGenerationResources(database) {
  database.exec(`
    INSERT INTO generation_base_models(id, name, created_at, updated_at)
      VALUES (5001, 'offline migration base', '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z');
    INSERT INTO generation_models(
      id, base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) VALUES (
      5002, 5001, 'offline-model.safetensors', 'safetensors', 'fp16',
      'offline model', 'offline model usage', '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
    );
    INSERT INTO generation_loras(
      id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (
      5003, 5001, 5002, 'offline-lora.safetensors', 'safetensors', 'fp16',
      'offline lora description', 'offline lora usage', '["offline_token"]', 1.0,
      '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
    );
    INSERT INTO artist_prompt_strings(
      id, title, description, artist_string, base_model_id, created_at, updated_at
    ) VALUES (
      5004, 'Offline Artist', 'offline artist description', 'offline_artist:1.2', 5001,
      '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
    );
    UPDATE vector_spaces SET embedding_model = CASE object_kind
      WHEN 'work' THEN 'old-work-model'
      WHEN 'character' THEN 'old-character-model'
      WHEN 'style' THEN 'old-style-model'
      WHEN 'prompt_term' THEN 'old-prompt-model'
    END, dimension = 2;
    INSERT INTO vector_entries(object_kind, object_id, embedding_f32)
      VALUES ('work', 1, X'0000803F00000040'),
             ('character', 2, X'0000404000008040'),
             ('style', 3, X'0000A0400000C040'),
             ('prompt_term', 4, X'0000E04000000041');
  `);
}

async function productionFixture({ nonEmpty = true } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'issue-275-offline-production-'));
  const model = await fakeEmbeddingServer();
  try {
    const publicPort = await freePort();
    const internalPort = await freePort();
    copyProductionRepository(root);
    writeProductionEnvironment(root, productionEnvironment({
      publicPort,
      internalPort,
      embeddingBaseUrl: model.baseUrl
    }));
    const databasePath = resolve(root, 'data/app.sqlite');
    const database = openCatalogDatabase({
      databasePath: ':memory:',
      repositoryRoot: root,
      includeBuiltinComfyuiCatalog: false
    });
    if (nonEmpty) addNonEmptyGenerationResources(database);
    database.exec(`VACUUM INTO '${databasePath.replace(/'/gu, "''")}'`);
    database.close();
    copyFileSync(resolve(ROOT, 'schema/database/036-generation-resource-vectors.sql'), resolve(root, 'schema/database/036-generation-resource-vectors.sql'));
    return {
      root,
      databasePath,
      model,
      publicPort,
      internalPort,
      async close() {
        model.server.closeAllConnections?.();
        model.server.close();
        rmSync(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    model.server.closeAllConnections?.();
    model.server.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function runCli(productionRoot, options = {}) {
  const stdout = [];
  const stderr = [];
  const exitCode = await main(['--production-root', productionRoot], {
    stdout: { write: (line) => stdout.push(line) },
    stderr: { write: (line) => stderr.push(line) },
    ...options
  });
  return {
    exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    stdoutJson: stdout.length === 1 ? JSON.parse(stdout[0]) : null,
    stderrJson: stderr.length === 1 ? JSON.parse(stderr[0]) : null
  };
}

function assert035(database) {
  assert.deepEqual(database.prepare('SELECT object_kind FROM vector_spaces ORDER BY object_kind').all().map(({ object_kind }) => object_kind), [
    'character', 'prompt_term', 'style', 'work'
  ]);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 36').get().count, 0);
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
}

function inspectMigratedDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    return {
      spaces: database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all().map((row) => ({ ...row })),
      entries: database.prepare('SELECT object_kind, object_id, length(embedding_f32) AS bytes FROM vector_entries ORDER BY object_kind, object_id').all().map((row) => ({ ...row })),
      ledger: { ...database.prepare('SELECT version, name FROM schema_migrations WHERE version = 36').get() },
      userVersion: database.prepare('PRAGMA user_version').get().user_version,
      foreignKeys: database.prepare('PRAGMA foreign_keys').get().foreign_keys,
      triggers: database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%delete_vector_entries_after_delete' ORDER BY name").all().map(({ name }) => name)
    };
  } finally {
    database.close();
  }
}

test('Issue #275 offline CLI accepts exactly one explicit production root', () => {
  assert.deepEqual(parseArguments(['--production-root', '/tmp/production']), {
    help: false,
    values: { '--production-root': '/tmp/production' }
  });
  assert.deepEqual(parseArguments(['--help']), { help: true, values: {} });
  for (const argv of [
    [],
    ['--production-root'],
    ['--production-root', '/tmp/one', '--production-root', '/tmp/two'],
    ['--database', '/tmp/app.sqlite'],
    ['--media-root', '/tmp/media'],
    ['--port', '18082'],
    ['/tmp/production'],
    ['--unknown', 'value']
  ]) assert.throws(() => parseArguments(argv));
});

test('Issue #275 offline CLI main emits structured NO-GO for a missing production root', async () => {
  const stdout = [];
  const stderr = [];
  const exitCode = await main(['--production-root', '/tmp/production'], {
    stdout: { write: (line) => stdout.push(line) },
    stderr: { write: (line) => stderr.push(line) }
  });
  assert.equal(exitCode, 1);
  assert.equal(stdout.length, 0);
  assert.equal(stderr.length, 1);
});

test('Issue #275 offline CLI run seam is exported for stopped production migration', async () => {
  const productionRoot = mkdtempSync(resolve(tmpdir(), 'issue-275-offline-cli-'));
  const events = [];
  try {
    writeFileSync(resolve(productionRoot, 'app.sqlite'), 'fixture');
    const result = await runGenerationResourceVectorMigration({
      productionRoot,
      readEnvironment: () => Object.freeze({}),
      resolveRuntimeConfiguration: () => ({ listeners: { public: { port: 1 }, internal: { port: 2 } } }),
      resolveDataPaths: () => ({ databasePath: resolve(productionRoot, 'app.sqlite') }),
      assertStopped: async () => events.push('stopped'),
      databaseFactory: () => ({ close: () => events.push('close') }),
      loadModels: () => ({ embedding_model: 'fake' }),
      createModelClient: () => ({}),
      createLoraMaintenance: () => ({}),
      createArtistMaintenance: () => ({}),
      migrate: async () => ({ status: 'already_complete', version: 36, embedding_calls: 0 })
    });
    assert.deepEqual(events, ['stopped', 'close']);
    assert.equal(result.status, 'already_complete');
  } finally {
    rmSync(productionRoot, { recursive: true, force: true });
  }
});

test('Issue #275 offline CLI migrates a non-empty 035 production database and emits only GO JSON', async () => {
  const fixture = await productionFixture();
  try {
    const result = await runCli(fixture.root);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stderr, '');
    assert.deepEqual(result.stdoutJson, {
      ok: true,
      decision: 'GO',
      status: 'complete',
      migration_version: 36,
      production_root: fixture.root,
      database_path: fixture.databasePath,
      embedding_calls: 2
    });
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const observed = inspectMigratedDatabase(fixture.databasePath);
    assert.deepEqual(observed.spaces.map(({ object_kind }) => object_kind), [
      'artist_prompt_string', 'character', 'generation_lora', 'prompt_term', 'style', 'work'
    ]);
    assert.deepEqual(observed.spaces.filter(({ object_kind }) => ['generation_lora', 'artist_prompt_string'].includes(object_kind)), [
      { object_kind: 'artist_prompt_string', embedding_model: 'test-embedding-model', dimension: TEST_VECTOR_DIMENSION },
      { object_kind: 'generation_lora', embedding_model: 'test-embedding-model', dimension: TEST_VECTOR_DIMENSION }
    ]);
    assert.deepEqual(observed.entries, [
      { object_kind: 'artist_prompt_string', object_id: 5004, bytes: TEST_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT },
      { object_kind: 'character', object_id: 2, bytes: 8 },
      { object_kind: 'generation_lora', object_id: 5003, bytes: TEST_VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT },
      { object_kind: 'prompt_term', object_id: 4, bytes: 8 },
      { object_kind: 'style', object_id: 3, bytes: 8 },
      { object_kind: 'work', object_id: 1, bytes: 8 }
    ]);
    assert.deepEqual(observed.ledger, { version: 36, name: '036-generation-resource-vectors' });
    assert.equal(observed.userVersion, 36);
    assert.equal(observed.foreignKeys, 1);
    assert.deepEqual(observed.triggers, [
      'artist_prompt_strings_delete_vector_entries_after_delete',
      'generation_loras_delete_vector_entries_after_delete'
    ]);
    assert.equal(fixture.model.calls.inputs, 2);
  } finally {
    await fixture.close();
  }
});

test('Issue #275 offline CLI returns already_complete without another Embedding request', async () => {
  const fixture = await productionFixture();
  try {
    const first = await runCli(fixture.root);
    assert.equal(first.exitCode, 0);
    const callsAfterFirstRun = fixture.model.calls.inputs;
    const second = await runCli(fixture.root);
    assert.equal(second.exitCode, 0);
    assert.deepEqual(second.stdoutJson, {
      ok: true,
      decision: 'GO',
      status: 'already_complete',
      migration_version: 36,
      production_root: fixture.root,
      database_path: fixture.databasePath,
      embedding_calls: 0
    });
    assert.equal(fixture.model.calls.inputs, callsAfterFirstRun);
  } finally {
    await fixture.close();
  }
});

test('Issue #275 offline CLI passes both configured ports to the stop seam before opening the database or model', async () => {
  const fixture = await productionFixture();
  const events = [];
  try {
    const result = await runCli(fixture.root, {
      assertStopped: async ({ runtimeConfiguration }) => {
        events.push({
          phase: 'stopped',
          ports: [runtimeConfiguration.listeners.public.port, runtimeConfiguration.listeners.internal.port]
        });
      },
      databaseFactory: (path) => {
        events.push({ phase: 'database', path });
        return new DatabaseSync(path);
      },
      createModelClient: ({ repositoryRoot }) => {
        events.push({ phase: 'model_client', repositoryRoot });
        return { embed: async () => [[3, 4, 0]] };
      },
      migrate: async () => {
        events.push({ phase: 'migrate' });
        return { status: 'already_complete', version: 36, embedding_calls: 0 };
      }
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(events, [
      { phase: 'stopped', ports: [fixture.publicPort, fixture.internalPort] },
      { phase: 'database', path: fixture.databasePath },
      { phase: 'model_client', repositoryRoot: fixture.root },
      { phase: 'migrate' }
    ]);
  } finally {
    await fixture.close();
  }
});

for (const [label, makeBusy] of [
  ['PID', async (fixture) => {
    mkdirSync(resolve(fixture.root, 'runtime/run'), { recursive: true });
    writeFileSync(resolve(fixture.root, 'runtime/run/app.pid'), `${process.pid}\n`);
    return null;
  }],
  ['public port', async (fixture) => {
    const server = createServer((_request, response) => response.end('busy'));
    server.listen({ host: '127.0.0.1', port: fixture.publicPort });
    await once(server, 'listening');
    return server;
  }],
  ['internal port', async (fixture) => {
    const server = createServer((_request, response) => response.end('busy'));
    server.listen({ host: '127.0.0.1', port: fixture.internalPort });
    await once(server, 'listening');
    return server;
  }]
]) {
  test(`Issue #275 offline CLI rejects an active production ${label} before database/model/migration`, async () => {
    const fixture = await productionFixture();
    let databaseCalls = 0;
    let modelCalls = 0;
    let migrationCalls = 0;
    const busyServer = await makeBusy(fixture);
    try {
      const result = await runCli(fixture.root, {
        databaseFactory: (path) => {
          databaseCalls += 1;
          return new DatabaseSync(path);
        },
        createModelClient: () => {
          modelCalls += 1;
          return { embed: async () => [[3, 4, 0]] };
        },
        migrate: async () => {
          migrationCalls += 1;
          return { status: 'complete', version: 36, embedding_calls: 2 };
        }
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderrJson.ok, false);
      assert.equal(result.stderrJson.decision, 'NO-GO');
      assert.equal(databaseCalls, 0);
      assert.equal(modelCalls, 0);
      assert.equal(migrationCalls, 0);
      const database = new DatabaseSync(fixture.databasePath);
      try { assert035(database); } finally { database.close(); }
    } finally {
      if (busyServer !== null) await new Promise((resolvePromise, reject) => busyServer.close((error) => error ? reject(error) : resolvePromise()));
      await fixture.close();
    }
  });
}

test('Issue #275 offline CLI rejects a missing or symbolic-link database without creating a target', async () => {
  const missing = await productionFixture();
  try {
    rmSync(missing.databasePath);
    const result = await runCli(missing.root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderrJson.decision, 'NO-GO');
    assert.equal(result.stdout, '');
    assert.equal(existsSync(missing.databasePath), false);
  } finally {
    await missing.close();
  }

  const symbolic = await productionFixture();
  try {
    const target = resolve(symbolic.root, 'data/real.sqlite');
    copyFileSync(symbolic.databasePath, target);
    rmSync(symbolic.databasePath);
    symlinkSync(target, symbolic.databasePath);
    const result = await runCli(symbolic.root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderrJson.decision, 'NO-GO');
    assert.equal(result.stdout, '');
  } finally {
    await symbolic.close();
  }
});

test('Issue #275 offline CLI rejects a symbolic-link production root and missing production config', async () => {
  const target = await productionFixture();
  const link = mkdtempSync(resolve(tmpdir(), 'issue-275-production-link-'));
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target.root, link);
  try {
    const result = await runCli(link);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderrJson.decision, 'NO-GO');
    assert.equal(result.stdout, '');
  } finally {
    rmSync(link, { force: true });
    await target.close();
  }

  const missingConfig = await productionFixture();
  try {
    rmSync(resolve(missingConfig.root, 'config/defaults.json'));
    const result = await runCli(missingConfig.root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderrJson.decision, 'NO-GO');
    assert.equal(result.stdout, '');
    const database = new DatabaseSync(missingConfig.databasePath);
    try { assert035(database); } finally { database.close(); }
  } finally {
    await missingConfig.close();
  }
});

test('Issue #275 offline CLI reports registered non-converged migration without repair or Embedding', async () => {
  const fixture = await productionFixture();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.exec(`
      INSERT INTO schema_migrations(version, name, applied_at)
        VALUES (36, '036-generation-resource-vectors', '2026-08-21T00:00:00.000Z');
      PRAGMA user_version = 36;
    `);
    database.close();
    const result = await runCli(fixture.root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderrJson.decision, 'NO-GO');
    assert.equal(result.stderrJson.error.status, 'registered_not_converged');
    assert.equal(fixture.model.calls.inputs, 0);
    const unchanged = new DatabaseSync(fixture.databasePath);
    try {
      assert.deepEqual(unchanged.prepare('SELECT object_kind FROM vector_spaces ORDER BY object_kind').all().map(({ object_kind }) => object_kind), [
        'character', 'prompt_term', 'style', 'work'
      ]);
      assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind IN (\'generation_lora\', \'artist_prompt_string\')').get().count, 0);
    } finally {
      unchanged.close();
    }
  } finally {
    await fixture.close();
  }
});

test('Issue #275 offline CLI closes once and never queries a connection after UNCERTAIN migration failure', async () => {
  const fixture = await productionFixture();
  const events = [];
  try {
    const result = await runCli(fixture.root, {
      databaseFactory: () => ({
        prepare() {
          events.push('prepare-after-open');
          throw new Error('connection must not be queried after uncertain failure');
        },
        exec() {
          events.push('exec-after-open');
          throw new Error('connection must not be used after uncertain failure');
        },
        close() {
          events.push('close');
        }
      }),
      createModelClient: () => ({ embed: async () => [[3, 4, 0]] }),
      migrate: async () => {
        const error = new GenerationResourceVectorMigrationError('commit outcome cannot be determined', {
          phase: 'commit',
          status: 'uncertain',
          transactionState: 'uncertain',
          connectionMustClose: true,
          evidence: { commit_result: 'unknown' }
        });
        throw error;
      }
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderrJson.decision, 'NO-GO');
    assert.equal(result.stderrJson.error.transaction_state, 'uncertain');
    assert.equal(result.stderrJson.error.connection_must_close, true);
    assert.deepEqual(events, ['close']);
  } finally {
    await fixture.close();
  }
});

test('Issue #275 offline CLI sanitizes failure messages and never emits production credentials', async () => {
  const fixture = await productionFixture();
  try {
    const result = await runCli(fixture.root, {
      migrate: async () => { throw new Error('upstream failure embedding-test-secret'); }
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr.includes('embedding-test-secret'), false);
    assert.equal(result.stderrJson.error.message.includes('[REDACTED]'), true);
    assert.equal(result.stderrJson.error.decision, undefined);
  } finally {
    await fixture.close();
  }
});
