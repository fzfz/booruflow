import { DatabaseSync } from 'node:sqlite';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as sqliteVec from 'sqlite-vec';

import { parseProductionEnvironment, resolveProductionRuntimeConfiguration } from '../app/config/production-environment.mjs';
import { resolveProductionDataPaths } from '../app/config/load-config.mjs';
import { assertProductionStopped } from '../app/maintenance/production-runtime-data.mjs';
import {
  migrateVectorKnnIndex,
  vectorKnnMigrationConverged,
  VECTOR_KNN_MIGRATION_VERSION
} from '../app/catalog/vector-knn-migration.mjs';

const SQLITE_VEC_RUNTIME_VERSION = 'v0.1.9';
const USAGE = 'Usage: node scripts/migrate-vector-knn-index.mjs --production-root <path>';

function regularPath(path, kind) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || (kind === 'directory' ? !stats.isDirectory() : !stats.isFile())) {
    throw new Error(`${kind} path must be a regular non-symbolic-link ${kind}`);
  }
  return resolve(path);
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length !== 2 || argv[0] !== '--production-root' || argv[1].startsWith('--')) {
    throw new Error('--production-root <path> is required');
  }
  return { help: false, productionRoot: argv[1] };
}

function openDatabase(path) {
  const database = new DatabaseSync(path, { allowExtension: true });
  try {
    sqliteVec.load(database);
    const version = database.prepare('SELECT vec_version() AS version').get()?.version;
    if (version !== SQLITE_VEC_RUNTIME_VERSION) throw new Error(`sqlite-vec runtime version must be ${SQLITE_VEC_RUNTIME_VERSION}`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function closeDatabase(database) {
  if (database && typeof database.close === 'function' && database.isOpen !== false) database.close();
}

function verifyVectorKnnMigration({ database, result }) {
  if (!vectorKnnMigrationConverged(database)) throw new Error('migration 037 did not converge on its verification connection');
  const indexedCount = database.prepare('SELECT COUNT(*) AS count FROM vector_knn_index').get().count;
  if (indexedCount !== result.indexed_count) throw new Error('migration 037 verification count does not match the committed result');
}

export async function runVectorKnnMigration({
  productionRoot,
  assertStopped = assertProductionStopped,
  databaseFactory = openDatabase,
  migrate = migrateVectorKnnIndex,
  verify = verifyVectorKnnMigration
} = {}) {
  const root = regularPath(productionRoot, 'directory');
  const environment = parseProductionEnvironment(readFileSync(resolve(root, '.env'), 'utf8'));
  const runtimeConfiguration = resolveProductionRuntimeConfiguration({ environment, configPath: resolve(root, 'config/defaults.json') });
  const paths = resolveProductionDataPaths(runtimeConfiguration, { repositoryRoot: root });
  const databasePath = regularPath(paths.databasePath, 'file');

  await assertStopped({ productionRoot: root, runtimeConfiguration });

  const database = databaseFactory(databasePath);
  let result;
  try {
    result = migrate({ database, repositoryRoot: root });
    if (!result || !['complete', 'already_complete'].includes(result.status) || result.version !== VECTOR_KNN_MIGRATION_VERSION) {
      throw new Error('migration returned an invalid result');
    }
  } finally {
    closeDatabase(database);
  }

  const verificationDatabase = databaseFactory(databasePath);
  try {
    await verify({ database: verificationDatabase, result });
  } finally {
    closeDatabase(verificationDatabase);
  }
  return Object.freeze({ ...result, production_root: root, database_path: databasePath });
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, ...options } = {}) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const result = await runVectorKnnMigration({ ...options, productionRoot: parsed.productionRoot });
    stdout.write(`${JSON.stringify({
      ok: true,
      decision: 'GO',
      status: result.status,
      migration_version: result.version,
      indexed_count: result.indexed_count,
      production_root: result.production_root,
      database_path: result.database_path
    })}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${JSON.stringify({
      ok: false,
      decision: 'NO-GO',
      error: {
        name: error.name || 'Error',
        message: error.message,
        status: error.status ?? 'failed',
        phase: error.phase ?? 'preflight'
      }
    })}\n`);
    return 1;
  }
}

if (pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url) process.exitCode = await main();
