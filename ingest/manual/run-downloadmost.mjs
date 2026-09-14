import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createManualIngestRunner } from '../../app/ingest/manual-ingest.mjs';
import { createDownloadmostAdapter, DOWNLOADMOST_ORIGIN } from '../../app/ingest/sources/downloadmost.mjs';
import { createConfiguredVectorModelClient, loadVectorModelConfiguration } from '../../app/vector/model-client.mjs';

export const DOWNLOADMOST_BASE_MODEL_NAME = 'wai';

export function resolveDownloadmostBaseModelId(database) {
  if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required');
  const rows = database.prepare('SELECT id, name FROM generation_base_models WHERE lower(name) = ? ORDER BY id').all(DOWNLOADMOST_BASE_MODEL_NAME);
  const matches = rows.filter((row) => typeof row.name === 'string' && row.name.toLocaleLowerCase('en-US') === DOWNLOADMOST_BASE_MODEL_NAME);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1) {
    throw new Error(`downloadmost requires exactly one generation base model named ${DOWNLOADMOST_BASE_MODEL_NAME}`);
  }
  return matches[0].id;
}

function parseArguments(argv) {
  const index = argv.indexOf('--data-root');
  if (index < 0 || !argv[index + 1]) throw new Error('usage: node ingest/manual/run-downloadmost.mjs --data-root <controlled-data-root> [--resume|--smoke|--skip-known-works]');
  const resume = argv.includes('--resume');
  const smoke = argv.includes('--smoke');
  const skipKnownWorks = argv.includes('--skip-known-works');
  if (resume && smoke) throw new Error('--resume and --smoke cannot be combined');
  if (resume && skipKnownWorks) throw new Error('--resume and --skip-known-works cannot be combined');
  if (argv.some((value) => !['--data-root', '--resume', '--smoke', '--skip-known-works', argv[index + 1]].includes(value))) throw new Error('only --data-root, --resume, --smoke, and --skip-known-works are supported');
  return { dataRoot: resolve(argv[index + 1]), resume, smoke, skipKnownWorks };
}

export async function main(argv = process.argv.slice(2), { createAdapter = createDownloadmostAdapter, openDatabase = openCatalogDatabase } = {}) {
  const { dataRoot, resume, smoke, skipKnownWorks } = parseArguments(argv);
  const mediaRoot = resolve(dataRoot, 'media');
  mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });

  if (smoke) {
    const adapter = createAdapter({ mediaRoot });
    return { status: 'source_state_recorded', source_state: await adapter.smoke() };
  }

  const database = openDatabase({ databasePath: resolve(dataRoot, 'app.sqlite'), mediaRoot });
  try {
    const baseModelId = resolveDownloadmostBaseModelId(database);
    const adapter = createAdapter({ mediaRoot, baseModelId });
    const repositoryRoot = resolve(import.meta.dirname, '../..');
    const vectorConfiguration = loadVectorModelConfiguration(repositoryRoot);
    const modelClient = createConfiguredVectorModelClient({ repositoryRoot, configuration: vectorConfiguration });
    let ingestAdapter = adapter;
    if (skipKnownWorks) {
      // downloadmost 当前只产生 style；保持人工入口参数契约，过滤结果自然为空。
      const knownWorkSourceIds = new Set(database.prepare('SELECT source_id FROM works WHERE source_id IS NOT NULL').all().map((row) => row.source_id));
      ingestAdapter = Object.freeze({
        ...adapter,
        async discoverCatalog() {
          const catalog = await adapter.discoverCatalog();
          const filtered = catalog.filter((entry) => entry.identity.kind !== 'work' || !knownWorkSourceIds.has(entry.identity.source_id));
          Object.defineProperty(filtered, 'deduplications', { value: catalog.deduplications ?? [], enumerable: false });
          return filtered;
        }
      });
    }
    let runner = null;
    const handleInterrupt = () => runner?.requestStop('PROCESS_INTERRUPTED');
    try {
      runner = createManualIngestRunner({
        dataRoot,
        mediaRoot,
        sourceConfig: ingestAdapter.sourceConfig,
        adapter: ingestAdapter,
        database,
        config: { crawler: { allowed_source_origins: [DOWNLOADMOST_ORIGIN] } },
        vectorConfiguration,
        modelClient
      });
      process.on('SIGINT', handleInterrupt);
      process.on('SIGTERM', handleInterrupt);
      process.on('SIGHUP', handleInterrupt);
      return resume ? await runner.resume() : await runner.run();
    } finally {
      process.off('SIGINT', handleInterrupt);
      process.off('SIGTERM', handleInterrupt);
      process.off('SIGHUP', handleInterrupt);
    }
  } finally {
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
