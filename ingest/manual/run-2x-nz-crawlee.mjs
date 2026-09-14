import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { loadConfig, REPOSITORY_ROOT, resolveProductionDataPaths } from '../../app/config/load-config.mjs';
import { createManualIngestRunner } from '../../app/ingest/manual-ingest.mjs';
import { createConfiguredVectorModelClient, loadVectorModelConfiguration } from '../../app/vector/model-client.mjs';
import { assertRecoveryBackupComplete, createRecoveryBackup } from '../../app/maintenance/recovery-workflow.mjs';
import { create2xNzCrawleeAdapter } from '../../app/ingest/sources/2x-nz-crawlee.mjs';

function parseArguments(argv) {
  if (argv.length === 0) return { resume: false };
  if (argv.length === 1 && argv[0] === '--resume') return { resume: true };
  if (argv.length === 1 && argv[0] === '--compensate-skipped') return { compensateSkipped: true };
  throw new Error('usage: node ingest/manual/run-2x-nz-crawlee.mjs [--resume|--compensate-skipped]');
}

const STAGE_LABELS = Object.freeze({
  discover_catalog: '发现目录',
  fetch_details: '获取详情',
  download_images: '下载图片',
  persist: '写入数据库',
  report: '生成报告'
});

const TWO_X_NZ_BASE_MODEL_NAMES = Object.freeze({ WAI: 'wai', ANIMA: 'anima' });

export function resolve2xNzBaseModelIds(database) {
  if (!database || typeof database.prepare !== 'function') throw new TypeError('database is required');
  const rows = database.prepare('SELECT id, name FROM generation_base_models WHERE lower(name) IN (?, ?) ORDER BY id').all('wai', 'anima');
  const result = {};
  for (const [mode, name] of Object.entries(TWO_X_NZ_BASE_MODEL_NAMES)) {
    const matches = rows.filter((row) => typeof row.name === 'string' && row.name.toLocaleLowerCase('en-US') === name);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1) {
      throw new Error(`2x.nz requires exactly one generation base model named ${name}`);
    }
    result[mode] = matches[0].id;
  }
  return Object.freeze(result);
}

function progressLine(state, counts) {
  const total = counts.discovered ?? 0;
  const done = Math.min(total, (counts.fetched ?? 0) + (counts.failed ?? 0));
  const percent = total === 0 ? 0 : Math.floor((done / total) * 100);
  const task = state.current_task?.identity?.normalized_name ?? '目录';
  const stage = STAGE_LABELS[state.stage] ?? state.stage;
  const status = state.status === 'running' ? '运行中' : state.status === 'paused' ? '已暂停' : state.status === 'failed' ? '失败' : '已完成';
  const reason = state.stop_reason ? `，原因：${state.stop_reason}` : '';
  return `[2x.nz] ${status}｜${stage}｜${task}｜对象 ${done}/${total} (${percent}%)｜成功 ${counts.fetched ?? 0}｜失败 ${counts.failed ?? 0}｜图片 ${counts.images_downloaded ?? 0}${reason}`;
}

export async function main(argv = process.argv.slice(2), { createAdapter = create2xNzCrawleeAdapter, onProgress = null, loadRuntimeConfig = loadConfig, repositoryRoot = REPOSITORY_ROOT, modelClient = null, vectorConfiguration = null } = {}) {
  const { resume, compensateSkipped = false } = parseArguments(argv);
  const config = loadRuntimeConfig();
  const paths = resolveProductionDataPaths(config, { repositoryRoot });
  const backupRoot = resolve(paths.dataRoot, 'recovery', 'before-2x-nz-run');
  if (existsSync(backupRoot)) assertRecoveryBackupComplete({ dataRoot: paths.dataRoot, name: 'before-2x-nz-run' });
  mkdirSync(paths.mediaRoot, { recursive: true, mode: 0o700 });
  const database = openCatalogDatabase({ databasePath: paths.databasePath, mediaRoot: paths.mediaRoot });
  let runner = null;
  const interrupt = () => runner?.requestStop('PROCESS_INTERRUPTED');
  try {
    if (!existsSync(backupRoot)) createRecoveryBackup({ dataRoot: paths.dataRoot, name: 'before-2x-nz-run' });
    const baseModelIds = resolve2xNzBaseModelIds(database);
    const adapter = createAdapter({ mediaRoot: paths.mediaRoot, cachePath: paths.cachePath, globalPaging: true, emitImageBytes: true, baseModelIds });
    const configuration = vectorConfiguration ?? loadVectorModelConfiguration(repositoryRoot);
    runner = createManualIngestRunner({
      dataRoot: paths.dataRoot,
      mediaRoot: paths.mediaRoot,
      sourceConfig: adapter.sourceConfig,
      adapter,
      database,
      onProgress,
      config,
      vectorConfiguration: configuration,
      modelClient: modelClient ?? createConfiguredVectorModelClient({ repositoryRoot, configuration })
    });
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt); process.on('SIGHUP', interrupt);
    return compensateSkipped ? await runner.compensateSkipped() : resume ? await runner.resume() : await runner.run();
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); process.off('SIGHUP', interrupt);
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { onProgress: (state, counts) => process.stdout.write(`${progressLine(state, counts)}\n`) })
    .then((result) => {
      process.stdout.write(`[2x.nz] 结果已保存：${result.state.report_path}，状态：${result.state.status}\n`);
    })
    .catch((error) => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; });
}
