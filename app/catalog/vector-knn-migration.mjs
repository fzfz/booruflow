import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { TRANSACTION_STATE, markTransactionState } from '../transaction-state.mjs';

export const VECTOR_KNN_MIGRATION_VERSION = 37;
export const VECTOR_KNN_MIGRATION_NAME = '037-vector-knn-index';
export const VECTOR_KNN_SOURCE_VERSION = 36;

const VECTOR_KINDS = Object.freeze([
  'work',
  'character',
  'style',
  'prompt_term',
  'generation_lora',
  'artist_prompt_string'
]);
const VECTOR_KIND_SET = new Set(VECTOR_KINDS);
const VECTOR_DIMENSION = 1024;
const VECTOR_BLOB_BYTES = VECTOR_DIMENSION * 4;
const UNCONFIGURED_MODEL = '__unconfigured__';

export class OfflineVectorKnnMigrationRequiredError extends Error {
  constructor() {
    super('vector KNN migration 037 requires the offline migration command before the application can start');
    this.name = 'OfflineVectorKnnMigrationRequiredError';
    this.code = 'OFFLINE_VECTOR_KNN_MIGRATION_REQUIRED';
    this.phase = 'preflight';
    this.status = 'offline_required';
    this.transactionState = TRANSACTION_STATE.NOT_STARTED;
    this.evidence = Object.freeze({
      phase: this.phase,
      status: this.status,
      transaction_state: this.transactionState,
      no_prepare_started: true,
      no_write_transaction_started: true
    });
    markTransactionState(this, this.transactionState);
  }
}

export class VectorKnnMigrationError extends Error {
  constructor(message, {
    status = 'failed',
    phase = 'preflight',
    transactionState = TRANSACTION_STATE.NOT_STARTED,
    cause = null,
    evidence = {},
    connectionMustClose = false
  } = {}) {
    super(message, cause === null ? undefined : { cause });
    this.name = 'VectorKnnMigrationError';
    this.code = 'VECTOR_KNN_MIGRATION_ERROR';
    this.status = status;
    this.phase = phase;
    this.originalError = cause;
    this.connectionMustClose = connectionMustClose;
    this.connection_must_close = connectionMustClose;
    this.connectionReusable = !connectionMustClose;
    this.evidence = Object.freeze({
      phase,
      status,
      transaction_state: transactionState,
      connection_must_close: connectionMustClose,
      ...evidence
    });
    markTransactionState(this, transactionState);
  }
}

function tableExists(database, tableName) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName));
}

function migrationLedger(database) {
  if (!tableExists(database, 'schema_migrations')) return null;
  return database.prepare('SELECT version, name FROM schema_migrations WHERE version = ? LIMIT 1')
    .get(VECTOR_KNN_MIGRATION_VERSION) ?? null;
}

function sourceSchemaReady(database) {
  if (!tableExists(database, 'schema_migrations') || !tableExists(database, 'vector_spaces') || !tableExists(database, 'vector_entries')) return false;
  const migration = database.prepare('SELECT version, name FROM schema_migrations WHERE version = ? LIMIT 1').get(VECTOR_KNN_SOURCE_VERSION);
  return migration?.name === '036-generation-resource-vectors'
    && database.prepare('PRAGMA user_version').get()?.user_version === VECTOR_KNN_SOURCE_VERSION;
}

function countByKind(database, tableName) {
  const counts = new Map();
  for (const row of database.prepare(`SELECT object_kind, COUNT(*) AS count FROM ${tableName} GROUP BY object_kind`).all()) {
    counts.set(row.object_kind, row.count);
  }
  return counts;
}

function sameKindCounts(left, right) {
  for (const kind of VECTOR_KINDS) {
    if ((left.get(kind) ?? 0) !== (right.get(kind) ?? 0)) return false;
  }
  return [...left.keys()].every((kind) => VECTOR_KIND_SET.has(kind))
    && [...right.keys()].every((kind) => VECTOR_KIND_SET.has(kind));
}

export function vectorKnnMigrationStartupConverged(database) {
  const registered = migrationLedger(database);
  if (registered?.name !== VECTOR_KNN_MIGRATION_NAME
    || !tableExists(database, 'vector_spaces')
    || !tableExists(database, 'vector_entries')
    || !tableExists(database, 'vector_knn_index')) return false;
  if ((database.prepare('PRAGMA user_version').get()?.user_version ?? 0) < VECTOR_KNN_MIGRATION_VERSION) return false;
  const spaceKinds = database.prepare('SELECT object_kind FROM vector_spaces ORDER BY object_kind').all().map(({ object_kind }) => object_kind);
  if (spaceKinds.length !== VECTOR_KINDS.length || new Set(spaceKinds).size !== VECTOR_KINDS.length || spaceKinds.some((kind) => !VECTOR_KIND_SET.has(kind))) return false;
  const sourceCounts = countByKind(database, 'vector_entries');
  const indexCounts = countByKind(database, 'vector_knn_index');
  return sameKindCounts(sourceCounts, indexCounts);
}

export function vectorKnnMigrationConverged(database) {
  return vectorKnnMigrationStartupConverged(database);
}

function migrationSql(repositoryRoot) {
  return readFileSync(resolve(repositoryRoot, 'schema/database/037-vector-knn-index.sql'), 'utf8');
}

function sourceInvalid(message, evidence = {}) {
  throw new VectorKnnMigrationError(message, { status: 'source_invalid', phase: 'preflight', evidence });
}

function validateSource(database) {
  const spaces = database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all();
  if (spaces.length !== VECTOR_KINDS.length || spaces.some(({ object_kind }) => !VECTOR_KIND_SET.has(object_kind)) || new Set(spaces.map(({ object_kind }) => object_kind)).size !== VECTOR_KINDS.length) {
    sourceInvalid('migration 036 vector_spaces must contain exactly six known object kinds');
  }

  const counts = countByKind(database, 'vector_entries');
  const configuredModels = new Set();
  for (const space of spaces) {
    const count = counts.get(space.object_kind) ?? 0;
    const isUnconfiguredPlaceholder = space.embedding_model === UNCONFIGURED_MODEL && space.dimension === 1;
    if (count === 0 && isUnconfiguredPlaceholder) continue;
    if (space.embedding_model === UNCONFIGURED_MODEL || space.dimension !== VECTOR_DIMENSION) {
      sourceInvalid(`vector space ${space.object_kind} must use a configured 1024-dimensional model before migration 037`, { object_kind: space.object_kind, count });
    }
    if (count > 0) configuredModels.add(space.embedding_model);
  }
  if (configuredModels.size > 1) sourceInvalid('all non-empty vector spaces must use one embedding model', { models: [...configuredModels].sort() });

  const invalidEntry = database.prepare(`
    SELECT object_kind, object_id, typeof(embedding_f32) AS value_type, length(embedding_f32) AS byte_length
    FROM vector_entries
    WHERE object_kind NOT IN ('work', 'character', 'style', 'prompt_term', 'generation_lora', 'artist_prompt_string')
       OR object_id IS NULL
       OR object_id <= 0
       OR typeof(embedding_f32) <> 'blob'
       OR length(embedding_f32) <> ?
    LIMIT 1
  `).get(VECTOR_BLOB_BYTES);
  if (invalidEntry) sourceInvalid('vector entries must contain known positive IDs and 4096-byte BLOB values before migration 037', { entry: invalidEntry });

  const duplicateEntry = database.prepare(`
    SELECT object_kind, object_id, COUNT(*) AS count
    FROM vector_entries
    GROUP BY object_kind, object_id
    HAVING COUNT(*) <> 1
    LIMIT 1
  `).get();
  if (duplicateEntry) sourceInvalid('vector entries must not contain duplicate object identities before migration 037', { entry: duplicateEntry });

  for (const kind of VECTOR_KINDS) {
    if ((counts.get(kind) ?? 0) > 0) {
      const space = spaces.find(({ object_kind }) => object_kind === kind);
      if (space.dimension !== VECTOR_DIMENSION || space.embedding_model === UNCONFIGURED_MODEL) {
        sourceInvalid(`non-empty vector space ${kind} must be configured as 1024-dimensional`, { object_kind: kind });
      }
    }
  }
}

function closeMigrationConnection(database) {
  try {
    if (typeof database.close === 'function' && database.isOpen !== false) database.close();
  } catch {}
}

function migrationBodyFailure(error, database) {
  try {
    database.exec('ROLLBACK;');
    return markTransactionState(new VectorKnnMigrationError(`migration 037 failed: ${error.message}`, {
      status: 'rolled_back',
      phase: 'migration_sql',
      transactionState: TRANSACTION_STATE.ROLLED_BACK,
      cause: error
    }), TRANSACTION_STATE.ROLLED_BACK);
  } catch (rollbackError) {
    closeMigrationConnection(database);
    return markTransactionState(new VectorKnnMigrationError(`migration 037 failed: ${error.message}; ROLLBACK failed: ${rollbackError.message}; transaction state uncertain`, {
      status: 'uncertain',
      phase: 'rollback',
      transactionState: TRANSACTION_STATE.UNCERTAIN,
      cause: error,
      connectionMustClose: true,
      evidence: { rollback_error: rollbackError.message, no_further_connection_use: true }
    }), TRANSACTION_STATE.UNCERTAIN);
  }
}

function migrationBeginFailure(error) {
  return new VectorKnnMigrationError(`migration 037 failed before its transaction started: ${error.message}`, {
    status: 'not_started',
    phase: 'begin',
    transactionState: TRANSACTION_STATE.NOT_STARTED,
    cause: error
  });
}

function migrationCommitFailure(error, database) {
  closeMigrationConnection(database);
  return markTransactionState(new VectorKnnMigrationError(`migration 037 COMMIT failed; transaction state uncertain: ${error.message}`, {
    status: 'uncertain',
    phase: 'commit',
    transactionState: TRANSACTION_STATE.UNCERTAIN,
    cause: error,
    connectionMustClose: true,
    evidence: { commit_result: 'unknown', no_further_connection_use: true }
  }), TRANSACTION_STATE.UNCERTAIN);
}

export function migrateVectorKnnIndex({ database, repositoryRoot }) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') throw new TypeError('database with prepare() and exec() is required');
  if (typeof repositoryRoot !== 'string' || repositoryRoot.length === 0) throw new TypeError('repositoryRoot is required');

  const registered = migrationLedger(database);
  if (registered !== null) {
    if (registered.name === VECTOR_KNN_MIGRATION_NAME && vectorKnnMigrationConverged(database)) {
      return Object.freeze({ status: 'already_complete', version: VECTOR_KNN_MIGRATION_VERSION, indexed_count: database.prepare('SELECT COUNT(*) AS count FROM vector_knn_index').get().count });
    }
    throw new VectorKnnMigrationError('migration 037 is registered but its KNN index does not converge', { status: 'registered_not_converged' });
  }
  if (!sourceSchemaReady(database)) throw new VectorKnnMigrationError('migration 036 must converge before migration 037', { status: 'source_schema_not_ready' });
  if (tableExists(database, 'vector_knn_index')) throw new VectorKnnMigrationError('migration 037 target exists without its ledger entry', { status: 'target_without_ledger' });
  validateSource(database);
  let sql;
  try {
    sql = migrationSql(repositoryRoot);
  } catch (error) {
    throw migrationBeginFailure(error);
  }
  try {
    database.exec('BEGIN IMMEDIATE;');
  } catch (error) {
    throw migrationBeginFailure(error);
  }
  try {
    database.exec(sql);
  } catch (error) {
    throw migrationBodyFailure(error, database);
  }
  try {
    database.exec('COMMIT;');
  } catch (error) {
    throw migrationCommitFailure(error, database);
  }
  if (!vectorKnnMigrationConverged(database)) {
    throw new VectorKnnMigrationError('migration 037 completed without a converged KNN index', { status: 'registered_not_converged', phase: 'post_commit' });
  }
  return Object.freeze({ status: 'complete', version: VECTOR_KNN_MIGRATION_VERSION, indexed_count: database.prepare('SELECT COUNT(*) AS count FROM vector_knn_index').get().count });
}

export function migrateVectorKnnIndexForOpen({ database, repositoryRoot }) {
  const registered = migrationLedger(database);
  if (registered !== null) {
    if (registered.name === VECTOR_KNN_MIGRATION_NAME && vectorKnnMigrationStartupConverged(database)) {
      return Object.freeze({ status: 'already_complete', version: VECTOR_KNN_MIGRATION_VERSION, indexed_count: database.prepare('SELECT COUNT(*) AS count FROM vector_knn_index').get().count });
    }
    throw new VectorKnnMigrationError('migration 037 is registered but its KNN index does not converge', { status: 'registered_not_converged' });
  }
  if (!sourceSchemaReady(database)) return null;
  const sourceCount = database.prepare('SELECT COUNT(*) AS count FROM vector_entries').get().count;
  if (sourceCount !== 0) throw new OfflineVectorKnnMigrationRequiredError();
  return migrateVectorKnnIndex({ database, repositoryRoot });
}
