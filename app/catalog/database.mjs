import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { REPOSITORY_ROOT } from '../contracts/authoritative-contracts.mjs';
import { listOrderedMigrations } from '../database/migration-baseline.mjs';
import { CREATE_MEDIA_CUTOVER_PLAN_TABLE_SQL, MEDIA_CUTOVER_VERSION } from '../database/media-cutover-contract.mjs';
import { migrateStylesToBaseModel, STYLE_SCHEMA_MIGRATION_VERSION } from '../database/style-schema-migration.mjs';
import {
  GENERATION_RESOURCE_VECTOR_MIGRATION_NAME,
  GENERATION_RESOURCE_VECTOR_MIGRATION_VERSION,
  migrateGenerationResourceVectorsForOpen,
  OfflineGenerationResourceVectorMigrationRequiredError
} from './generation-resource-vector-migration.mjs';
import {
  VECTOR_KNN_MIGRATION_NAME,
  VECTOR_KNN_MIGRATION_VERSION,
  migrateVectorKnnIndexForOpen,
  OfflineVectorKnnMigrationRequiredError,
  VectorKnnMigrationError
} from './vector-knn-migration.mjs';
import { TRANSACTION_STATE, hasTransactionState, markTransactionState } from '../transaction-state.mjs';

export class CatalogDatabaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogDatabaseError';
  }
}

export class CatalogTransactionError extends CatalogDatabaseError {
  constructor(message, { originalError = null, rollbackError = null, transactionState = TRANSACTION_STATE.UNCERTAIN } = {}) {
    super(message);
    this.name = 'CatalogTransactionError';
    this.originalError = originalError;
    this.rollbackError = rollbackError;
    this.cause = originalError;
    markTransactionState(this, transactionState);
  }
}

export class OfflineMediaCutoverRequiredError extends CatalogDatabaseError {
  constructor() {
    super('The database predates the supported upgrade range. Upgrade the old deployment to v0.87.0 and migrate an isolated copy, or create a new installation before starting the application.');
    this.name = 'OfflineMediaCutoverRequiredError';
  }
}

export { OfflineGenerationResourceVectorMigrationRequiredError, OfflineVectorKnnMigrationRequiredError, VectorKnnMigrationError };

const DATABASE_CONNECTION_STATES = new WeakMap();
const DATABASE_CONNECTION_STATE = Symbol('catalog database connection state');
const STATEMENT_EXECUTION_METHODS = new Set(['run', 'get', 'all', 'iterate']);
const SQLITE_VEC_RUNTIME_VERSION = 'v0.1.9';

export function loadCatalogSqliteVec(database) {
  sqliteVec.load(database);
  const version = database.prepare('SELECT vec_version() AS version').get()?.version;
  if (version !== SQLITE_VEC_RUNTIME_VERSION) {
    throw new CatalogDatabaseError(`sqlite-vec runtime version must be ${SQLITE_VEC_RUNTIME_VERSION}`);
  }
}

function assertDatabaseObject(database) {
  if (database === null || (typeof database !== 'object' && typeof database !== 'function')) {
    throw new TypeError('database connection must be an object');
  }
  return database;
}

function databaseConnectionState(database) {
  const connection = assertDatabaseObject(database);
  try {
    const sharedState = connection[DATABASE_CONNECTION_STATE];
    if (sharedState !== undefined) return sharedState;
  } catch {}
  let state = DATABASE_CONNECTION_STATES.get(connection);
  if (state === undefined) {
    state = { usable: true, uncertain: false };
    DATABASE_CONNECTION_STATES.set(connection, state);
  }
  return state;
}

function guardedIterator(iterator, state) {
  if (iterator === null || (typeof iterator !== 'object' && typeof iterator !== 'function')) return iterator;
  let guarded;
  guarded = new Proxy(iterator, {
    get(target, property) {
      const value = target[property];
      if (property === Symbol.iterator && typeof value === 'function') return () => guarded;
      if (property === 'next' && typeof value === 'function') {
        return (...args) => {
          if (!state.usable) assertDatabaseConnectionUsable({ [DATABASE_CONNECTION_STATE]: state });
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return guarded;
}

function guardedExecutionHandle(handle, state, { project = null } = {}) {
  return new Proxy(handle, {
    get(target, property) {
      const projected = project === null ? undefined : project(property);
      if (projected !== undefined) return projected;
      const value = target[property];
      if (STATEMENT_EXECUTION_METHODS.has(property) && typeof value === 'function') {
        return (...args) => {
          if (!state.usable) assertDatabaseConnectionUsable({ [DATABASE_CONNECTION_STATE]: state });
          const result = Reflect.apply(value, target, args);
          return property === 'iterate' ? guardedIterator(result, state) : result;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function guardedStatement(statement, state) {
  return guardedExecutionHandle(statement, state);
}

function guardedTagStore(tagStore, state, database) {
  return guardedExecutionHandle(tagStore, state, {
    project: (property) => property === 'db' ? database : undefined
  });
}

function guardedSession(session, state) {
  return new Proxy(session, {
    get(target, property) {
      const value = target[property];
      if (property === 'changeset' || property === 'patchset') {
        return (...args) => {
          if (!state.usable) assertDatabaseConnectionUsable({ [DATABASE_CONNECTION_STATE]: state });
          return Reflect.apply(value, target, args);
        };
      }
      if (property === 'close' || property === Symbol.dispose) {
        return (...args) => Reflect.apply(value, target, args);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function managedDatabaseConnection(database) {
  const state = databaseConnectionState(database);
  let managed;
  managed = new Proxy(database, {
    get(target, property) {
      if (property === DATABASE_CONNECTION_STATE) return state;
      const value = target[property];
      if (property === 'close') return (...args) => Reflect.apply(value, target, args);
      if (property === 'prepare') {
        return (...args) => {
          if (!state.usable) assertDatabaseConnectionUsable({ [DATABASE_CONNECTION_STATE]: state });
          return guardedStatement(Reflect.apply(value, target, args), state);
        };
      }
      if (property === 'createTagStore') {
        return (...args) => {
          if (!state.usable) assertDatabaseConnectionUsable({ [DATABASE_CONNECTION_STATE]: state });
          return guardedTagStore(Reflect.apply(value, target, args), state, managed);
        };
      }
      if (property === 'createSession') {
        return (...args) => {
          if (!state.usable) assertDatabaseConnectionUsable({ [DATABASE_CONNECTION_STATE]: state });
          return guardedSession(Reflect.apply(value, target, args), state);
        };
      }
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (!state.usable) assertDatabaseConnectionUsable({ [DATABASE_CONNECTION_STATE]: state });
        return Reflect.apply(value, target, args);
      };
    }
  });
  return managed;
}

export function databaseConnectionIsUsable(database) {
  return databaseConnectionState(database).usable;
}

export function databaseConnectionHasUncertainTransaction(database) {
  return databaseConnectionState(database).uncertain;
}

export function markDatabaseConnectionUnusable(database, { uncertain = false } = {}) {
  if (typeof uncertain !== 'boolean') throw new TypeError('uncertain must be a boolean');
  const state = databaseConnectionState(database);
  state.usable = false;
  if (uncertain) state.uncertain = true;
  return database;
}

export function assertDatabaseConnectionUsable(database) {
  const state = databaseConnectionState(database);
  if (state.usable) return database;
  const error = new CatalogDatabaseError('database connection is not serviceable');
  if (state.uncertain) markTransactionState(error, TRANSACTION_STATE.UNCERTAIN);
  throw error;
}

function migrationDirectory(repositoryRoot) {
  return resolve(repositoryRoot, 'schema/database');
}

const MIGRATION_POLICY = JSON.parse(readFileSync(new URL('../../config/migration-policy.json',import.meta.url),'utf8'));
const COMFYUI_BUILTIN_DATA_MIGRATION_VERSIONS = new Set(MIGRATION_POLICY.historical_seed_versions);

function applyEmptyBuiltinDataMigration(database, migration) {
  database.exec(`BEGIN IMMEDIATE;
    INSERT INTO schema_migrations(version, name, applied_at)
    VALUES (${migration.version}, '${migration.name}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    PRAGMA user_version = ${migration.version};
    COMMIT;`);
}

function applyPendingMigrations(database, repositoryRoot, { inMemoryDatabase, mediaRoot = null, deferStyleMigration = false, includeBuiltinComfyuiCatalog = true }) {
  const migrations = listOrderedMigrations(migrationDirectory(repositoryRoot));
  const migrationIsApplied = (migration) => Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
      && database.prepare('SELECT 1 FROM schema_migrations WHERE version = ? AND name = ? LIMIT 1').get(migration.version, migration.name)
  );
  const applyMigration = (migration) => {
    if (migrationIsApplied(migration)) return;
    if (migration.version === GENERATION_RESOURCE_VECTOR_MIGRATION_VERSION
      && migration.name === GENERATION_RESOURCE_VECTOR_MIGRATION_NAME) {
      migrateGenerationResourceVectorsForOpen({ database, repositoryRoot });
      return;
    }
    if (migration.version === VECTOR_KNN_MIGRATION_VERSION
      && migration.name === VECTOR_KNN_MIGRATION_NAME) {
      migrateVectorKnnIndexForOpen({ database, repositoryRoot });
      return;
    }
    if (!includeBuiltinComfyuiCatalog && COMFYUI_BUILTIN_DATA_MIGRATION_VERSIONS.has(migration.version)) {
      applyEmptyBuiltinDataMigration(database, migration);
      return;
    }
    if (migration.version === STYLE_SCHEMA_MIGRATION_VERSION) {
      if (deferStyleMigration) return;
      const result = migrateStylesToBaseModel({ database, mediaRoot, repositoryRoot });
      if (result.status !== 'complete' && result.status !== 'already_applied') {
        throw new CatalogDatabaseError(`style schema migration did not complete: ${result.status}`);
      }
      return;
    }
    database.exec(readFileSync(migration.path, 'utf8'));
  };
  for (const migration of migrations) {
    if (migration.version >= MEDIA_CUTOVER_VERSION) continue;
    const applied = database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
    `).get() && database.prepare(`
      SELECT 1 FROM schema_migrations WHERE version = ? AND name = ? LIMIT 1
    `).get(migration.version, migration.name);
    if (applied) continue;
    applyMigration(migration);
  }
  const cutover = migrations.find((migration) => migration.version === MEDIA_CUTOVER_VERSION);
  if (!cutover) throw new CatalogDatabaseError('media cutover migration is missing');
  const cutoverApplied = migrationIsApplied(cutover);
  if (cutoverApplied) {
    for (const migration of migrations.filter(({ version }) => version > MEDIA_CUTOVER_VERSION)) {
      if (deferStyleMigration && migration.version === STYLE_SCHEMA_MIGRATION_VERSION && !migrationIsApplied(migration)) return;
      applyMigration(migration);
    }
    return;
  }
  if (!inMemoryDatabase) throw new OfflineMediaCutoverRequiredError();
  const imageCount = database.prepare('SELECT COUNT(*) AS count FROM item_images').get().count;
  if (imageCount !== 0) throw new OfflineMediaCutoverRequiredError();
  database.exec(CREATE_MEDIA_CUTOVER_PLAN_TABLE_SQL);
  try {
    database.exec(readFileSync(cutover.path, 'utf8'));
    for (const migration of migrations.filter(({ version }) => version > MEDIA_CUTOVER_VERSION)) {
      if (deferStyleMigration && migration.version === STYLE_SCHEMA_MIGRATION_VERSION && !migrationIsApplied(migration)) return;
      applyMigration(migration);
    }
  } catch (error) {
    try { database.exec('DROP TABLE IF EXISTS media_cutover_paths;'); } catch {}
    throw error;
  }
}

function defaultBuiltinCatalogMode(environment) {
  const emptyCatalog = environment.NOOBAI_TEST_EMPTY_COMFYUI_CATALOG;
  if (emptyCatalog === undefined) return true;
  if (environment.NODE_ENV !== 'test' || emptyCatalog !== '1') {
    throw new TypeError('NOOBAI_TEST_EMPTY_COMFYUI_CATALOG=1 is available only when NODE_ENV=test');
  }
  return false;
}

export function openCatalogDatabase({
  databasePath = ':memory:',
  repositoryRoot = REPOSITORY_ROOT,
  mediaRoot = null,
  deferStyleMigration = false,
  includeBuiltinComfyuiCatalog = defaultBuiltinCatalogMode(process.env)
} = {}) {
  const database = new DatabaseSync(databasePath, { allowExtension: true });
  try {
    if (typeof deferStyleMigration !== 'boolean') throw new TypeError('deferStyleMigration must be a boolean');
    if (typeof includeBuiltinComfyuiCatalog !== 'boolean') throw new TypeError('includeBuiltinComfyuiCatalog must be a boolean');
    loadCatalogSqliteVec(database);
    applyPendingMigrations(database, repositoryRoot, { inMemoryDatabase: databasePath === ':memory:', mediaRoot, deferStyleMigration, includeBuiltinComfyuiCatalog });
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;');
  } catch (error) {
    database.close();
    if (error instanceof OfflineMediaCutoverRequiredError
      || error instanceof OfflineGenerationResourceVectorMigrationRequiredError
      || error instanceof OfflineVectorKnnMigrationRequiredError
      || error instanceof VectorKnnMigrationError) throw error;
    throw new CatalogDatabaseError(`cannot initialize catalog database: ${error.message}`);
  }
  return managedDatabaseConnection(database);
}

export function openExistingCatalogDatabase({ databasePath, readOnly = false } = {}) {
  if (typeof databasePath !== 'string' || databasePath.length === 0 || databasePath === ':memory:') {
    throw new TypeError('databasePath must identify an existing database file');
  }
  if (typeof readOnly !== 'boolean') throw new TypeError('readOnly must be a boolean');
  if (!existsSync(databasePath) || lstatSync(databasePath).isSymbolicLink() || !lstatSync(databasePath).isFile()) {
    throw new TypeError('databasePath must identify an existing regular database file');
  }
  const database = new DatabaseSync(databasePath, { allowExtension: true, readOnly });
  try {
    loadCatalogSqliteVec(database);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;');
  } catch (error) {
    database.close();
    throw new CatalogDatabaseError(`cannot open existing catalog database: ${error.message}`);
  }
  return managedDatabaseConnection(database);
}

export function inTransaction(database, callback) {
  assertDatabaseConnectionUsable(database);
  try {
    database.exec('BEGIN IMMEDIATE;');
  } catch (error) {
    const marked = markTransactionState(error, TRANSACTION_STATE.NOT_STARTED);
    if (hasTransactionState(marked, TRANSACTION_STATE.UNCERTAIN)) {
      markDatabaseConnectionUnusable(database, { uncertain: true });
    }
    throw marked;
  }
  try {
    const result = callback();
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch (rollbackError) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      markDatabaseConnectionUnusable(database, { uncertain: true });
      throw new CatalogTransactionError(
        `${originalMessage}; ROLLBACK failed: ${rollbackMessage}; transaction state uncertain`,
        { originalError: error, rollbackError, transactionState: TRANSACTION_STATE.UNCERTAIN }
      );
    }
    if (hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN)) {
      markDatabaseConnectionUnusable(database, { uncertain: true });
      throw error;
    }
    throw markTransactionState(error, TRANSACTION_STATE.ROLLED_BACK);
  }
}
