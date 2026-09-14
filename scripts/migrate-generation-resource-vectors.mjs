import { DatabaseSync } from 'node:sqlite';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseProductionEnvironment,
  resolveProductionRuntimeConfiguration
} from '../app/config/production-environment.mjs';
import { resolveProductionDataPaths } from '../app/config/load-config.mjs';
import { assertProductionStopped } from '../app/maintenance/production-runtime-data.mjs';
import {
  createGenerationLoraVectorMaintenance
} from '../app/vector/generation-lora-semantic.mjs';
import {
  createArtistPromptStringVectorMaintenance
} from '../app/vector/artist-prompt-string-semantic.mjs';
import {
  createConfiguredVectorModelClient,
  loadVectorModelConfiguration
} from '../app/vector/model-client.mjs';
import {
  GENERATION_RESOURCE_VECTOR_MIGRATION_VERSION,
  migrateGenerationResourceVectors
} from '../app/catalog/generation-resource-vector-migration.mjs';
import { TRANSACTION_STATE, transactionStateOf } from '../app/transaction-state.mjs';

export const MIGRATION_VERSION = GENERATION_RESOURCE_VECTOR_MIGRATION_VERSION;

const USAGE = 'Usage: node scripts/migrate-generation-resource-vectors.mjs --production-root <path>';
const REQUIRED_ARGUMENT = '--production-root';
const SAFE_PHASES = new Set([
  'preflight',
  'configuration',
  'stop_check',
  'model_configuration',
  'database_open',
  'model_client',
  'migration',
  'prepare',
  'temp_stage',
  'pre_transaction_source_check',
  'foreign_keys_off',
  'begin',
  'migration_sql',
  'commit',
  'post_commit_control',
  'post_commit_assertion',
  'close',
  'output'
]);
const SAFE_STATUSES = new Set([
  'already_complete',
  'complete',
  'failed',
  'embedding_failed',
  'invalid_embedding',
  'invalid_prepare_result',
  'migration_sql_failed',
  'not_started',
  'offline_required',
  'prepare_failed',
  'production_not_stopped',
  'registered_not_converged',
  'rolled_back',
  'source_drift',
  'source_schema_not_ready',
  'target_without_ledger',
  'temp_stage_failed',
  'uncertain'
]);
const SAFE_EVIDENCE_KEYS = new Set([
  'actual_dimension',
  'actual_count',
  'actual_model',
  'actual_rows',
  'commit_result',
  'expected_dimension',
  'expected_count',
  'expected_model',
  'expected_rows',
  'no_further_connection_use',
  'no_prepare_started',
  'no_write_transaction_started',
  'object_id',
  'object_kind',
  'reason',
  'registered_name',
  'registered_version',
  'required_source_name',
  'required_source_version',
  'returned_object_kind',
  'rollback_result',
  'transaction_state'
]);

function text(value, limit = 240, sensitiveValues = []) {
  let rendered = String(value ?? '');
  for (const sensitiveValue of sensitiveValues
    .filter((entry) => typeof entry === 'string' && entry.length >= 3)
    .sort((left, right) => right.length - left.length)) {
    rendered = rendered.split(sensitiveValue).join('[REDACTED]');
  }
  return rendered
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function regularDirectory(path, label) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} must be an existing non-symbolic-link directory`, { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be an existing non-symbolic-link directory`);
  }
  return resolve(path);
}

function regularDatabaseFile(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    throw new Error('production database must be an existing regular non-symbolic-link file', { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('production database must be an existing regular non-symbolic-link file');
  }
  return resolve(path);
}

function optionValue(argv, index, name) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  if (argv.length === 1 && argv[0] === '--help') {
    return Object.freeze({ help: true, values: Object.freeze({}) });
  }
  if (argv.length !== 2 || argv[0] !== REQUIRED_ARGUMENT) {
    if (argv.length === 0) throw new Error(`${REQUIRED_ARGUMENT} is required`);
    throw new Error(`only ${REQUIRED_ARGUMENT} is accepted`);
  }
  const value = optionValue(argv, 0, REQUIRED_ARGUMENT);
  return Object.freeze({
    help: false,
    values: Object.freeze({ [REQUIRED_ARGUMENT]: value })
  });
}

function defaultReadEnvironment(environmentPath) {
  return parseProductionEnvironment(readFileSync(environmentPath, 'utf8'));
}

function defaultDatabaseFactory(databasePath) {
  return new DatabaseSync(databasePath);
}

function knownTransactionState(error) {
  try {
    const value = transactionStateOf(error) ?? error?.transactionState;
    return Object.values(TRANSACTION_STATE).includes(value) ? value : TRANSACTION_STATE.NOT_STARTED;
  } catch {
    return TRANSACTION_STATE.NOT_STARTED;
  }
}

function sanitizeEvidenceValue(value, key, sensitiveValues = []) {
  if (typeof value === 'string') return text(value, 160, sensitiveValues);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((entry) => sanitizeEvidenceValue(entry, key, sensitiveValues));
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (SAFE_EVIDENCE_KEYS.has(childKey)) result[childKey] = sanitizeEvidenceValue(childValue, childKey, sensitiveValues);
    }
    return result;
  }
  return text(value, 160, sensitiveValues);
}

function sanitizeEvidence(value, sensitiveValues = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SAFE_EVIDENCE_KEYS.has(key)) result[key] = sanitizeEvidenceValue(entry, key, sensitiveValues);
  }
  return result;
}

function failureDetails(error, phase = 'preflight') {
  const transactionState = knownTransactionState(error);
  const errorPhase = typeof error?.phase === 'string' && SAFE_PHASES.has(error.phase)
    ? error.phase
    : phase;
  const name = text(error?.name || 'Error', 80) || 'Error';
  const codeValue = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(error.code)
    ? error.code
    : 'GENERATION_RESOURCE_VECTOR_OFFLINE_CLI_ERROR';
  const status = SAFE_STATUSES.has(error?.status) ? error.status : 'failed';
  const sensitiveValues = Array.isArray(error?.sensitiveValues) ? error.sensitiveValues : [];
  const evidence = sanitizeEvidence(error?.evidence, sensitiveValues);
  if (transactionState === TRANSACTION_STATE.UNCERTAIN && !Object.hasOwn(evidence, 'no_further_connection_use')) {
    evidence.no_further_connection_use = true;
  }
  return Object.freeze({
    name,
    code: codeValue,
    message: text(error?.message || error || 'migration failed', 240, sensitiveValues),
    phase: errorPhase,
    status,
    transaction_state: transactionState,
    connection_must_close: transactionState === TRANSACTION_STATE.UNCERTAIN
      || error?.connection_must_close === true
      || error?.connectionMustClose === true,
    evidence: Object.freeze(evidence)
  });
}

function cliStageError(error, phase) {
  if (error && typeof error === 'object' && typeof error.phase === 'string') return error;
  const wrapped = new Error(error instanceof Error ? error.message : String(error), { cause: error });
  wrapped.name = error?.name ?? 'Error';
  wrapped.code = error?.code;
  wrapped.phase = phase;
  wrapped.status = phase === 'stop_check' ? 'production_not_stopped' : 'failed';
  wrapped.transactionState = knownTransactionState(error);
  wrapped.evidence = {};
  return wrapped;
}

export async function runGenerationResourceVectorMigration({
  productionRoot,
  readEnvironment = defaultReadEnvironment,
  resolveRuntimeConfiguration: resolveRuntime = resolveProductionRuntimeConfiguration,
  resolveDataPaths = resolveProductionDataPaths,
  assertStopped = assertProductionStopped,
  loadModels = loadVectorModelConfiguration,
  databaseFactory = defaultDatabaseFactory,
  createModelClient = createConfiguredVectorModelClient,
  createLoraMaintenance = createGenerationLoraVectorMaintenance,
  createArtistMaintenance = createArtistPromptStringVectorMaintenance,
  migrate = migrateGenerationResourceVectors
} = {}) {
  let phase = 'preflight';
  let database = null;
  let caughtError = null;
  let sensitiveValues = [];
  const root = regularDirectory(productionRoot, 'production root');
  try {
    phase = 'configuration';
    const environment = readEnvironment(resolve(root, '.env'));
    sensitiveValues = Object.values(environment ?? {}).filter((value) => typeof value === 'string' && value.length >= 3);
    const runtimeConfiguration = resolveRuntime({
      environment,
      configPath: resolve(root, 'config', 'defaults.json')
    });
    const paths = resolveDataPaths(runtimeConfiguration, { repositoryRoot: root });
    if (!paths || typeof paths.databasePath !== 'string' || paths.databasePath.length === 0) {
      throw new Error('production data path resolver did not return databasePath');
    }
    const databasePath = regularDatabaseFile(paths.databasePath);

    phase = 'stop_check';
    await assertStopped({ productionRoot: root, runtimeConfiguration });

    phase = 'model_configuration';
    const modelConfiguration = loadModels(root, { environment });

    phase = 'database_open';
    database = databaseFactory(databasePath);
    if (!database || typeof database.close !== 'function') throw new Error('database factory did not return a closeable database');

    phase = 'model_client';
    const modelClient = createModelClient({ repositoryRoot: root, configuration: modelConfiguration });
    const generationLoraMaintenance = createLoraMaintenance({
      database,
      modelClient,
      configuration: modelConfiguration
    });
    const artistPromptStringMaintenance = createArtistMaintenance({
      database,
      modelClient,
      configuration: modelConfiguration
    });

    phase = 'migration';
    const result = await migrate({
      database,
      repositoryRoot: root,
      generationLoraMaintenance,
      artistPromptStringMaintenance
    });
    if (!result || !['complete', 'already_complete'].includes(result.status) || result.version !== MIGRATION_VERSION
      || !Number.isSafeInteger(result.embedding_calls) || result.embedding_calls < 0) {
      throw new Error('migration returned an invalid completion result');
    }
    return Object.freeze({
      status: result.status,
      migration_version: MIGRATION_VERSION,
      production_root: root,
      database_path: databasePath,
      embedding_calls: result.embedding_calls
    });
  } catch (error) {
    caughtError = cliStageError(error, phase);
    try { Object.defineProperty(caughtError, 'sensitiveValues', { value: sensitiveValues, enumerable: false }); } catch {}
    throw caughtError;
  } finally {
    if (database !== null) {
      phase = 'close';
      try {
        database.close();
      } catch (error) {
        if (caughtError !== null) throw caughtError;
        throw cliStageError(error, phase);
      }
    }
  }
}

export const runOfflineGenerationResourceVectorMigration = runGenerationResourceVectorMigration;
export const run = runGenerationResourceVectorMigration;

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const {
    stdout: _stdout,
    stderr: _stderr,
    ...runOptions
  } = options;
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      writeLine(stdout, USAGE);
      return 0;
    }
    const result = await runGenerationResourceVectorMigration({
      ...runOptions,
      productionRoot: parsed.values[REQUIRED_ARGUMENT]
    });
    writeLine(stdout, JSON.stringify({
      ok: true,
      decision: 'GO',
      status: result.status,
      migration_version: result.migration_version,
      production_root: result.production_root,
      database_path: result.database_path,
      embedding_calls: result.embedding_calls
    }));
    return 0;
  } catch (error) {
    const details = failureDetails(error);
    writeLine(stderr, JSON.stringify({ ok: false, decision: 'NO-GO', error: details }));
    return 1;
  }
}

if (pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) {
  process.exitCode = await main();
}
