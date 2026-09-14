import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createFixtureVector } from '../../fixtures/vector/fake-semantic-model-client.mjs';

import { loadAuthoritativeContracts, validateJsonSample } from '../../../app/contracts/authoritative-contracts.mjs';
import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { runMediaCutover } from '../../../app/database/media-cutover.mjs';
import { ManualIngestError } from '../../../app/ingest/manual-ingest.mjs';
import { createRecoveryBackup } from '../../../app/maintenance/recovery-workflow.mjs';
import { TWO_X_NZ_CRAWLEE_SOURCE_CONFIG } from '../../../app/ingest/sources/2x-nz-crawlee.mjs';
import { main, resolve2xNzBaseModelIds } from '../../../ingest/manual/run-2x-nz-crawlee.mjs';
import { resolveProductionDataPaths } from '../../../app/config/load-config.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const contracts = loadAuthoritativeContracts(repositoryRoot);
const DRAW_URL = 'https://2x.nz/draw';
const API_ORIGIN = 'https://api-ai.acofork.com';
const RECORD_CACHE_FILE = '.2x-nz-crawlee-records.json';
const VECTOR_CONFIGURATION = Object.freeze({ embedding_model: 'fake' });
const MODEL_CLIENT = Object.freeze({ async embed(inputs) { return inputs.map(() => createFixtureVector()); } });

function runMain(argv = [], options = {}) {
  return main(argv, { vectorConfiguration: VECTOR_CONFIGURATION, modelClient: MODEL_CLIENT, ...options });
}

function sourceConfig() {
  return TWO_X_NZ_CRAWLEE_SOURCE_CONFIG;
}

test('production 2x.nz entry resolves both mode IDs by unique base-model names', () => {
  const makeDatabase = (rows) => ({ prepare() { return { all() { return rows; } }; } });
  assert.deepEqual(resolve2xNzBaseModelIds(makeDatabase([{ id: 9901, name: 'wai' }, { id: 9902, name: 'anima' }])), { WAI: 9901, ANIMA: 9902 });
  assert.throws(() => resolve2xNzBaseModelIds(makeDatabase([{ id: 9901, name: 'wai' }])), /exactly one.*anima/u);
  assert.throws(() => resolve2xNzBaseModelIds(makeDatabase([{ id: 9901, name: 'wai' }, { id: 9902, name: 'wai' }, { id: 9903, name: 'anima' }])), /exactly one.*wai/u);
});

function fixtureAdapter({ discoverCatalog, fetchDetail, downloadImages } = {}) {
  const identity = { kind: 'style', base_model_id: 12001, source_id: '2x-nz:WAI:style:entry', parent_identity: 'root', normalized_name: '入口画风' };
  const detail = {
    identity,
    source_url: `${API_ORIGIN}/api/library?mode=WAI&category=%E5%85%A5%E5%8F%A3%E7%94%BB%E9%A3%8E&limit=200&offset=0`,
    name: '入口画风',
    aliases: [],
    base_model_id: 12001,
    prompt_text: 'entry prompt',
    style_description: null,
    image_results: [],
    fetched_at: '2026-07-28T08:00:00.000Z'
  };
  return {
    kind: '2x-nz-api',
    sourceConfig: sourceConfig(),
    async discoverCatalog() {
      return discoverCatalog ? discoverCatalog() : [{ identity, source_url: detail.source_url, name: detail.name, source_version: 'WAI', source_updated_at: null, discovered_at: detail.fetched_at }];
    },
    async fetchDetail(task) { return fetchDetail ? fetchDetail(task) : detail; },
    async downloadImages(value) { return downloadImages ? downloadImages(value) : value; }
  };
}

function tempRoot(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  mkdirSync(join(directory, 'media', 'images'), { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function openPersistentCatalogDatabase(databasePath) {
  runMediaCutover({ databasePath, mediaRoot: join(dirname(databasePath), 'media') });
  const database = openCatalogDatabase({ databasePath, includeBuiltinComfyuiCatalog: false });
  database.prepare("INSERT OR IGNORE INTO generation_base_models(id, name, created_at, updated_at) VALUES (12001, 'wai', '2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z'), (12002, 'anima', '2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z')").run();
  return database;
}

function initializeProductionCatalog(repositoryRoot) {
  const dataRoot = join(repositoryRoot, 'data');
  const database = openPersistentCatalogDatabase(join(dataRoot, 'app.sqlite'));
  database.close();
}

test('uses the production configuration data directory for the site and 2x.nz collector', async (t) => {
  const dataRoot = tempRoot(t, '2x-nz-crawlee-entry-');
  initializeProductionCatalog(dataRoot);
  let factoryOptions = null;
  const adapter = fixtureAdapter();
  const runtimeConfig = { data_directory: 'data', crawler: { allowed_source_origins: ['https://2x.nz', API_ORIGIN] } };
  const sitePaths = resolveProductionDataPaths(runtimeConfig, { repositoryRoot: dataRoot });
  const result = await runMain([], {
    repositoryRoot: dataRoot,
    loadRuntimeConfig: () => runtimeConfig,
    createAdapter(options) {
      factoryOptions = options;
      return adapter;
    }
  });

  assert.equal(factoryOptions.mediaRoot, sitePaths.mediaRoot);
  assert.equal(factoryOptions.cachePath, join(sitePaths.dataRoot, RECORD_CACHE_FILE));
  assert.equal(result.state.status, 'completed');
  assert.equal(result.report.counts.discovered, 1);
  assert.equal(result.report.counts.created, 1);
  assert.equal(result.report.counts.pending, 0);
  assert.deepEqual(validateJsonSample(result.report, resolve(repositoryRoot, 'schema/crawler/crawl-report.schema.json'), contracts.schemas), []);
  assert.equal(existsSync(join(sitePaths.dataRoot, 'reports')), true);
});

test('reuses only a verified same-name recovery backup before opening the production database', async (t) => {
  const runtimeConfig = { data_directory: 'data', crawler: { allowed_source_origins: ['https://2x.nz', API_ORIGIN] } };

  await t.test('continues with a complete backup', async () => {
    const repository = tempRoot(t, '2x-nz-crawlee-entry-complete-backup-');
    const dataRoot = join(repository, 'data');
    mkdirSync(join(dataRoot, 'media'), { recursive: true });
    openPersistentCatalogDatabase(join(dataRoot, 'app.sqlite')).close();
    createRecoveryBackup({ dataRoot, name: 'before-2x-nz-run' });
    const result = await runMain([], {
      repositoryRoot: repository,
      loadRuntimeConfig: () => runtimeConfig,
      createAdapter: () => fixtureAdapter()
    });
    assert.equal(result.state.status, 'completed');
  });

  await t.test('stops on a missing completion marker without changing the database', async () => {
    const repository = tempRoot(t, '2x-nz-crawlee-entry-incomplete-backup-');
    const dataRoot = join(repository, 'data');
    mkdirSync(join(dataRoot, 'media'), { recursive: true });
    const databasePath = join(dataRoot, 'app.sqlite');
    openPersistentCatalogDatabase(databasePath).close();
    mkdirSync(join(dataRoot, 'recovery', 'before-2x-nz-run'), { recursive: true });
    writeFileSync(join(dataRoot, 'recovery', 'before-2x-nz-run', 'backup-manifest.json'), '{}');
    const before = readFileSync(databasePath);
    await assert.rejects(() => runMain([], {
      repositoryRoot: repository,
      loadRuntimeConfig: () => runtimeConfig,
      createAdapter: () => { throw new Error('adapter must remain unopened'); }
    }), /incomplete|manifest/u);
    assert.deepEqual(readFileSync(databasePath), before);
  });

  await t.test('stops on a corrupted manifest without changing the database', async () => {
    const repository = tempRoot(t, '2x-nz-crawlee-entry-corrupt-backup-');
    const dataRoot = join(repository, 'data');
    mkdirSync(join(dataRoot, 'media'), { recursive: true });
    const databasePath = join(dataRoot, 'app.sqlite');
    openPersistentCatalogDatabase(databasePath).close();
    const backup = createRecoveryBackup({ dataRoot, name: 'before-2x-nz-run' });
    writeFileSync(join(backup.backupRoot, 'backup-manifest.json'), '{"backup_version":1,"files":[]}');
    const before = readFileSync(databasePath);
    await assert.rejects(() => runMain([], {
      repositoryRoot: repository,
      loadRuntimeConfig: () => runtimeConfig,
      createAdapter: () => { throw new Error('adapter must remain unopened'); }
    }), /manifest/u);
    assert.deepEqual(readFileSync(databasePath), before);
  });
});

test('accepts normal execution, resume, and explicit skipped compensation while rejecting removed 2x.nz options', async () => {
  const runtimeConfig = { data_directory: 'data', crawler: { allowed_source_origins: ['https://2x.nz', API_ORIGIN] } };
  for (const argv of [['--data-root', 'elsewhere'], ['--credentials', 'secret.json'], ['--smoke'], ['--skip-known-works'], ['--unknown']]) {
    await assert.rejects(() => runMain(argv, { loadRuntimeConfig: () => runtimeConfig }), /usage: node ingest\/manual\/run-2x-nz-crawlee\.mjs \[--resume\|--compensate-skipped\]/u);
  }
});

test('reports live stage and object progress through the Crawlee entry', async (t) => {
  const dataRoot = tempRoot(t, '2x-nz-crawlee-progress-');
  initializeProductionCatalog(dataRoot);
  const progress = [];
  const result = await runMain([], {
    repositoryRoot: dataRoot,
    loadRuntimeConfig: () => ({ data_directory: 'data', crawler: { allowed_source_origins: ['https://2x.nz', API_ORIGIN] } }),
    onProgress(state, counts) { progress.push({ stage: state.stage, status: state.status, task: state.current_task?.identity?.normalized_name ?? null, discovered: counts.discovered, fetched: counts.fetched }); },
    createAdapter: () => fixtureAdapter()
  });

  assert.equal(result.state.status, 'completed');
  assert.deepEqual(progress.map((item) => item.stage), ['discover_catalog', 'discover_catalog', 'fetch_details', 'download_images', 'persist', 'persist', 'report']);
  assert.equal(progress.some((item) => item.task === '入口画风'), true);
  assert.equal(progress.at(-1).status, 'completed');
  assert.equal(progress.at(-1).fetched, 1);
});

test('the new entry preserves fatal HTTP stops in state and report', async (t) => {
  const dataRoot = tempRoot(t, '2x-nz-crawlee-entry-stop-');
  initializeProductionCatalog(dataRoot);
    const result = await runMain([], {
      repositoryRoot: dataRoot,
      loadRuntimeConfig: () => ({ data_directory: 'data', crawler: { allowed_source_origins: ['https://2x.nz', API_ORIGIN] } }),
    createAdapter() {
      return fixtureAdapter({
        discoverCatalog: async () => { throw new ManualIngestError('HTTP_403', 'offline 403', { stage: 'discover_catalog' }); }
      });
    }
  });

  assert.equal(result.state.status, 'failed');
  assert.equal(result.state.stop_reason, 'HTTP_403');
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.errors.length, 1);
  assert.equal(result.report.errors[0].code, 'HTTP_403');
  assert.equal(validateJsonSample(result.state, resolve(repositoryRoot, 'schema/crawler/crawl-state.schema.json'), contracts.schemas).length, 0);
  assert.equal(validateJsonSample(result.report, resolve(repositoryRoot, 'schema/crawler/crawl-report.schema.json'), contracts.schemas).length, 0);
});

test('the Crawlee entry is the only 2x.nz collector and the legacy executable stays removed', () => {
  const soleCollectorPath = resolve(repositoryRoot, 'app/ingest/sources/2x-nz-crawlee.mjs');
  assert.equal(existsSync(soleCollectorPath), true);
  assert.equal(readFileSync(soleCollectorPath).length > 0, true);
  assert.equal(existsSync(resolve(repositoryRoot, 'app/ingest/sources/2x-nz.mjs')), false);
  assert.equal(existsSync(resolve(repositoryRoot, 'ingest/manual/run-2x-nz.mjs')), false);
});
