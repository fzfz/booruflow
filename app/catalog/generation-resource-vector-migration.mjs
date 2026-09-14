import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TRANSACTION_STATE,
  markTransactionState,
  transactionStateOf
} from '../transaction-state.mjs';
import { OBJECT_KINDS, VECTOR_SOURCE_DEFINITIONS } from '../vector/vector-source-definitions.mjs';

export const GENERATION_RESOURCE_VECTOR_MIGRATION_VERSION = 36;
export const GENERATION_RESOURCE_VECTOR_MIGRATION_NAME = '036-generation-resource-vectors';
const SOURCE_SCHEMA_VERSION = 35;
const SOURCE_SCHEMA_MIGRATION_NAME = '035-iterative-image-task-round-error-details';

const moduleDirectory = fileURLToPath(new URL('.', import.meta.url));
const defaultRepositoryRoot = resolve(moduleDirectory, '../..');
const TRIGGER_NAMES = Object.freeze({
  generation_lora: 'generation_loras_delete_vector_entries_after_delete',
  artist_prompt_string: 'artist_prompt_strings_delete_vector_entries_after_delete'
});
const TEMP_TABLES = Object.freeze({
  oldSpaces: 'migration_036_vector_spaces_035',
  oldEntries: 'migration_036_vector_entries_035',
  loraVectors: 'migration_036_generation_lora_vectors',
  artistVectors: 'migration_036_artist_prompt_string_vectors'
});

const SOURCE_DEFINITIONS = Object.freeze({
  generation_lora: Object.freeze({
    table: VECTOR_SOURCE_DEFINITIONS.generation_lora.table,
    maintenanceOption: 'generationLoraMaintenance',
    select: `SELECT id, file_name, description, usage, trigger_words_json, updated_at
      FROM ${VECTOR_SOURCE_DEFINITIONS.generation_lora.table} ORDER BY id`
  }),
  artist_prompt_string: Object.freeze({
    table: VECTOR_SOURCE_DEFINITIONS.artist_prompt_string.table,
    maintenanceOption: 'artistPromptStringMaintenance',
    select: `SELECT id, title, description, artist_string, updated_at
      FROM ${VECTOR_SOURCE_DEFINITIONS.artist_prompt_string.table} ORDER BY id`
  })
});
const NEW_OBJECT_KINDS = Object.freeze(Object.keys(SOURCE_DEFINITIONS));
const TARGET_OBJECT_KINDS = OBJECT_KINDS;
const OLD_OBJECT_KINDS = Object.freeze(OBJECT_KINDS.filter((objectKind) => !NEW_OBJECT_KINDS.includes(objectKind)));

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function freezeEvidence(evidence) {
  return Object.freeze({ ...evidence });
}

export class GenerationResourceVectorMigrationError extends Error {
  constructor(message, {
    phase = 'migration',
    status = 'failed',
    transactionState = TRANSACTION_STATE.NOT_STARTED,
    originalError = null,
    rollbackError = null,
    controlFailures = [],
    connectionMustClose = false,
    evidence = {}
  } = {}) {
    super(message, originalError === null ? undefined : { cause: originalError });
    this.name = 'GenerationResourceVectorMigrationError';
    this.code = 'GENERATION_RESOURCE_VECTOR_MIGRATION_ERROR';
    this.phase = phase;
    this.status = status;
    this.originalError = originalError;
    this.rollbackError = rollbackError;
    this.controlFailures = Object.freeze([...controlFailures]);
    this.connectionMustClose = connectionMustClose;
    this.connection_must_close = connectionMustClose;
    this.connectionReusable = !connectionMustClose;
    this.evidence = freezeEvidence({
      phase,
      status,
      transaction_state: transactionState,
      connection_must_close: connectionMustClose,
      ...evidence
    });
    markTransactionState(this, transactionState);
  }
}

export class OfflineGenerationResourceVectorMigrationRequiredError extends Error {
  constructor() {
    super('Database migration 036 is incomplete, so the database predates the supported upgrade range. Upgrade the old deployment to v0.87.0 and migrate an isolated copy, or create a new installation before starting the application.');
    this.name = 'OfflineGenerationResourceVectorMigrationRequiredError';
    this.code = 'OFFLINE_GENERATION_RESOURCE_VECTOR_MIGRATION_REQUIRED';
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

function migrationError(error, options = {}) {
  if (error instanceof GenerationResourceVectorMigrationError) return error;
  const transactionState = options.transactionState ?? transactionStateOf(error) ?? TRANSACTION_STATE.NOT_STARTED;
  return new GenerationResourceVectorMigrationError(errorMessage(error), {
    ...options,
    transactionState,
    originalError: error
  });
}

function requireDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('database with prepare() and exec() is required');
  }
}

function tableExists(database, tableName) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName) !== undefined;
}

function triggerExists(database, triggerName) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ? LIMIT 1").get(triggerName) !== undefined;
}

function triggerDefinition(database, triggerName) {
  return database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ? LIMIT 1").get(triggerName)?.sql ?? '';
}

function migrationLedger(database) {
  if (!tableExists(database, 'schema_migrations')) return null;
  return database.prepare('SELECT version, name FROM schema_migrations WHERE version = ? LIMIT 1')
    .get(GENERATION_RESOURCE_VECTOR_MIGRATION_VERSION) ?? null;
}

function sourceSchemaLedgerReady(database) {
  if (!tableExists(database, 'schema_migrations')) return false;
  const rows = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  const userVersion = database.prepare('PRAGMA user_version').get()?.user_version;
  if (userVersion !== SOURCE_SCHEMA_VERSION || rows.length !== SOURCE_SCHEMA_VERSION) return false;
  if (rows.some(({ version }) => version > SOURCE_SCHEMA_VERSION)) return false;
  return rows.every(({ version }, index) => version === index + 1)
    && rows.at(-1)?.version === SOURCE_SCHEMA_VERSION
    && rows.at(-1)?.name === SOURCE_SCHEMA_MIGRATION_NAME;
}

function tableColumns(database, tableName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all().map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
}

function tableDefinition(database, tableName) {
  return database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(tableName)?.sql ?? '';
}

function hasClosedObjectKindCheck(sql) {
  const match = /CHECK\s*\(\s*object_kind\s+IN\s*\(([^()]*)\)\s*\)/iu.exec(sql);
  if (!match) return false;
  const values = [...match[1].matchAll(/'([^']+)'/gu)].map(([, value]) => value);
  return values.length === TARGET_OBJECT_KINDS.length
    && new Set(values).size === TARGET_OBJECT_KINDS.length
    && TARGET_OBJECT_KINDS.every((objectKind) => values.includes(objectKind));
}

function hasScopedDeleteTrigger(database, triggerName, sourceTable, objectKind) {
  const definition = triggerDefinition(database, triggerName);
  const tablePattern = new RegExp(`AFTER\\s+DELETE\\s+ON\\s+${sourceTable}\\b`, 'iu');
  if (!tablePattern.test(definition)) return false;
  const deleteStatements = [...definition.matchAll(/DELETE\s+FROM\s+vector_entries\s+WHERE\s+([\s\S]*?);/igu)];
  if (deleteStatements.length !== 1) return false;
  const whereClause = deleteStatements[0][1].replace(/\s+/gu, ' ').trim();
  const expectedWhere = new RegExp(`^(?:object_kind\\s*=\\s*'${objectKind}'\\s+AND\\s+object_id\\s*=\\s*OLD\\.id|object_id\\s*=\\s*OLD\\.id\\s+AND\\s+object_kind\\s*=\\s*'${objectKind}')$`, 'iu');
  return expectedWhere.test(whereClause);
}

function vectorSpaceRows(database) {
  if (!tableExists(database, 'vector_spaces')) return [];
  return database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all();
}

function vectorEntryRows(database, objectKind = null) {
  if (!tableExists(database, 'vector_entries')) return [];
  if (objectKind === null) return database.prepare('SELECT object_kind, object_id, embedding_f32 FROM vector_entries ORDER BY object_kind, object_id').all();
  return database.prepare('SELECT object_kind, object_id, embedding_f32 FROM vector_entries WHERE object_kind = ? ORDER BY object_id').all(objectKind);
}

function sourceRows(database, objectKind) {
  const definition = SOURCE_DEFINITIONS[objectKind];
  return database.prepare(definition.select).all();
}

function rowIdentity(row) {
  return `${row.id}:${row.updated_at}`;
}

function sourceRowsMatch(expected, actual) {
  if (expected.length !== actual.length) return false;
  const expectedIdentities = expected.map(rowIdentity).sort();
  const actualIdentities = actual.map(rowIdentity).sort();
  return expectedIdentities.every((identity, index) => identity === actualIdentities[index]);
}

function assertSourceRowsMatch(expected, actual, objectKind, phase) {
  if (sourceRowsMatch(expected, actual)) return;
  throw new GenerationResourceVectorMigrationError(`${objectKind} source rows changed before migration transaction`, {
    phase,
    status: 'source_drift',
    transactionState: TRANSACTION_STATE.NOT_STARTED,
    evidence: {
      object_kind: objectKind,
      expected_count: expected.length,
      actual_count: actual.length,
      expected_rows: expected.map(rowIdentity),
      actual_rows: actual.map(rowIdentity)
    }
  });
}

function validateVectorValues(vector, objectKind, objectId) {
  const values = Array.isArray(vector)
    ? vector
    : vector instanceof Float32Array ? [...vector] : null;
  if (values === null || values.length === 0 || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new GenerationResourceVectorMigrationError(`${objectKind} embedding for source row ${objectId} is not finite`, {
      phase: 'prepare',
      status: 'invalid_embedding',
      transactionState: TRANSACTION_STATE.NOT_STARTED,
      evidence: { object_kind: objectKind, object_id: objectId, reason: 'non_finite_or_empty' }
    });
  }
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new GenerationResourceVectorMigrationError(`${objectKind} embedding for source row ${objectId} is zero or cannot be normalized`, {
      phase: 'prepare',
      status: 'invalid_embedding',
      transactionState: TRANSACTION_STATE.NOT_STARTED,
      evidence: { object_kind: objectKind, object_id: objectId, reason: magnitude === 0 ? 'zero' : 'not_normalizable' }
    });
  }
  const normalized = Float32Array.from(values.map((value) => value / magnitude));
  const normalizedMagnitude = Math.sqrt([...normalized].reduce((sum, value) => sum + value * value, 0));
  if (normalized.length !== values.length || [...normalized].some((value) => !Number.isFinite(value)) || !Number.isFinite(normalizedMagnitude) || normalizedMagnitude === 0) {
    throw new GenerationResourceVectorMigrationError(`${objectKind} embedding for source row ${objectId} cannot be normalized`, {
      phase: 'prepare',
      status: 'invalid_embedding',
      transactionState: TRANSACTION_STATE.NOT_STARTED,
      evidence: { object_kind: objectKind, object_id: objectId, reason: 'normalized_non_finite' }
    });
  }
  return normalized;
}

function encodeNormalizedEmbedding(vector) {
  return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

async function prepareRows({ objectKind, rows, maintenance }) {
  if (rows.length === 0) return Object.freeze({ rows: Object.freeze([]), dimension: null, embedding_model: null });
  if (!maintenance || typeof maintenance.prepare !== 'function') {
    throw new TypeError(`${SOURCE_DEFINITIONS[objectKind].maintenanceOption}.prepare is required`);
  }
  const prepared = [];
  let dimension = null;
  let embeddingModel = null;
  for (const row of rows) {
    let result;
    try {
      result = await maintenance.prepare(Object.freeze({ ...row }));
    } catch (error) {
      throw migrationError(error, {
        phase: 'prepare',
        status: 'embedding_failed',
        transactionState: transactionStateOf(error) ?? TRANSACTION_STATE.NOT_STARTED,
        evidence: { object_kind: objectKind, object_id: row.id, no_write_transaction_started: true }
      });
    }
    if (!result || result.object_kind !== objectKind) {
      throw new GenerationResourceVectorMigrationError(`${objectKind} prepare returned an unexpected object kind`, {
        phase: 'prepare',
        status: 'invalid_prepare_result',
        evidence: { object_kind: objectKind, object_id: row.id, returned_object_kind: result?.object_kind ?? null }
      });
    }
    if (typeof result.embedding_model !== 'string' || result.embedding_model.trim().length === 0) {
      throw new GenerationResourceVectorMigrationError(`${objectKind} prepare returned no embedding model`, {
        phase: 'prepare',
        status: 'invalid_prepare_result',
        evidence: { object_kind: objectKind, object_id: row.id }
      });
    }
    const vector = validateVectorValues(result.vector, objectKind, row.id);
    if (dimension === null) dimension = vector.length;
    if (vector.length !== dimension) {
      throw new GenerationResourceVectorMigrationError(`${objectKind} embeddings have inconsistent dimensions`, {
        phase: 'prepare',
        status: 'invalid_embedding',
        evidence: { object_kind: objectKind, object_id: row.id, expected_dimension: dimension, actual_dimension: vector.length }
      });
    }
    if (embeddingModel === null) embeddingModel = result.embedding_model;
    if (result.embedding_model !== embeddingModel) {
      throw new GenerationResourceVectorMigrationError(`${objectKind} embeddings use inconsistent models`, {
        phase: 'prepare',
        status: 'invalid_prepare_result',
        evidence: { object_kind: objectKind, object_id: row.id, expected_model: embeddingModel, actual_model: result.embedding_model }
      });
    }
    prepared.push(Object.freeze({
      object_id: row.id,
      source_updated_at: row.updated_at,
      embedding_model: embeddingModel,
      dimension,
      embedding_f32: encodeNormalizedEmbedding(vector)
    }));
  }
  return Object.freeze({ rows: Object.freeze(prepared), dimension, embedding_model: embeddingModel });
}

function targetStructurePresent(database) {
  if (tableExists(database, 'vector_spaces_035') || tableExists(database, 'vector_entries_035')) return true;
  if (NEW_OBJECT_KINDS.some((objectKind) => triggerExists(database, TRIGGER_NAMES[objectKind]))) return true;
  const spaces = vectorSpaceRows(database);
  return spaces.some(({ object_kind }) => NEW_OBJECT_KINDS.includes(object_kind));
}

function oldSchemaPresent(database) {
  const spaces = vectorSpaceRows(database);
  return spaces.length === OLD_OBJECT_KINDS.length
    && OLD_OBJECT_KINDS.every((objectKind) => spaces.some(({ object_kind }) => object_kind === objectKind))
    && tableExists(database, 'vector_entries')
    && NEW_OBJECT_KINDS.every((objectKind) => tableExists(database, SOURCE_DEFINITIONS[objectKind].table));
}

function expectedSourceVectorIds(database, objectKind) {
  const table = SOURCE_DEFINITIONS[objectKind].table;
  return database.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(({ id }) => id);
}

function vectorIds(database, objectKind) {
  return vectorEntryRows(database, objectKind).map(({ object_id }) => object_id);
}

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function converged(database) {
  const ledger = migrationLedger(database);
  if (ledger?.name !== GENERATION_RESOURCE_VECTOR_MIGRATION_NAME) return false;
  if (database.prepare('PRAGMA user_version').get().user_version < GENERATION_RESOURCE_VECTOR_MIGRATION_VERSION) return false;
  if (!tableExists(database, 'vector_spaces') || !tableExists(database, 'vector_entries')) return false;
  const spaceColumns = tableColumns(database, 'vector_spaces');
  const entryColumns = tableColumns(database, 'vector_entries');
  if (spaceColumns.map(({ name }) => name).join(',') !== 'object_kind,embedding_model,dimension'
    || entryColumns.map(({ name }) => name).join(',') !== 'object_kind,object_id,embedding_f32') return false;
  const expectedSpaceColumns = [
    ['object_kind', 'TEXT', 1, 1],
    ['embedding_model', 'TEXT', 1, 0],
    ['dimension', 'INTEGER', 1, 0]
  ];
  if (spaceColumns.length !== expectedSpaceColumns.length
    || spaceColumns.some(({ name, type, notnull, pk }, index) => {
      const expected = expectedSpaceColumns[index];
      return !expected || name !== expected[0] || String(type ?? '').toUpperCase() !== expected[1] || notnull !== expected[2] || pk !== expected[3];
    })) return false;
  const expectedEntryColumns = [
    ['object_kind', 'TEXT', 1, 1],
    ['object_id', 'INTEGER', 1, 2],
    ['embedding_f32', 'BLOB', 1, 0]
  ];
  if (entryColumns.length !== expectedEntryColumns.length
    || entryColumns.some(({ name, type, notnull, pk }, index) => {
      const expected = expectedEntryColumns[index];
      return !expected || name !== expected[0] || String(type ?? '').toUpperCase() !== expected[1] || notnull !== expected[2] || pk !== expected[3];
    })) return false;
  if (!hasClosedObjectKindCheck(tableDefinition(database, 'vector_spaces'))
    || !hasClosedObjectKindCheck(tableDefinition(database, 'vector_entries'))) return false;
  const entryForeignKeys = database.prepare('PRAGMA foreign_key_list(vector_entries)').all();
  if (entryForeignKeys.length !== 1 || !entryForeignKeys.some(({ table, from, to, on_delete }) => table === 'vector_spaces'
    && from === 'object_kind' && to === 'object_kind' && on_delete === 'CASCADE')) return false;
  const spaces = vectorSpaceRows(database);
  if (spaces.length !== TARGET_OBJECT_KINDS.length || !TARGET_OBJECT_KINDS.every((objectKind) => spaces.some(({ object_kind }) => object_kind === objectKind))) return false;
  if (vectorEntryRows(database).some(({ object_kind }) => !TARGET_OBJECT_KINDS.includes(object_kind))) return false;
  if (database.prepare('PRAGMA foreign_key_check').all().length > 0) return false;
  if (database.prepare('SELECT integrity_check FROM pragma_integrity_check LIMIT 1').get()?.integrity_check !== 'ok') return false;
  for (const objectKind of NEW_OBJECT_KINDS) {
    if (!triggerExists(database, TRIGGER_NAMES[objectKind])) return false;
    if (!hasScopedDeleteTrigger(database, TRIGGER_NAMES[objectKind], SOURCE_DEFINITIONS[objectKind].table, objectKind)) return false;
  }
  for (const objectKind of NEW_OBJECT_KINDS) {
    const space = spaces.find(({ object_kind }) => object_kind === objectKind);
    const ids = expectedSourceVectorIds(database, objectKind);
    if (!sameIds(ids, vectorIds(database, objectKind))) return false;
    if (ids.length === 0) {
      if (typeof space.embedding_model !== 'string' || space.embedding_model.trim().length === 0
        || !Number.isInteger(space.dimension) || space.dimension < 1) return false;
      if (space.embedding_model === '__unconfigured__' && space.dimension !== 1) return false;
    } else {
      if (typeof space.embedding_model !== 'string' || space.embedding_model === '__unconfigured__'
        || !Number.isInteger(space.dimension) || space.dimension < 1) return false;
      if (vectorEntryRows(database, objectKind).some(({ embedding_f32 }) => Buffer.from(embedding_f32).byteLength !== space.dimension * Float32Array.BYTES_PER_ELEMENT)) return false;
    }
  }
  return tableExists(database, 'vector_spaces_035') === false && tableExists(database, 'vector_entries_035') === false;
}

function dropTempTables(database) {
  for (const tableName of Object.values(TEMP_TABLES)) database.exec(`DROP TABLE IF EXISTS temp.${tableName};`);
}

function stageTempTables(database, oldSpaces, oldEntries, prepared) {
  dropTempTables(database);
  database.exec(`
    CREATE TEMP TABLE ${TEMP_TABLES.oldSpaces} (
      object_kind TEXT PRIMARY KEY,
      embedding_model TEXT NOT NULL,
      dimension INTEGER NOT NULL
    );
    CREATE TEMP TABLE ${TEMP_TABLES.oldEntries} (
      object_kind TEXT NOT NULL,
      object_id INTEGER NOT NULL,
      embedding_f32 BLOB NOT NULL,
      PRIMARY KEY (object_kind, object_id)
    );
    CREATE TEMP TABLE ${TEMP_TABLES.loraVectors} (
      object_id INTEGER PRIMARY KEY,
      source_updated_at TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_f32 BLOB NOT NULL
    );
    CREATE TEMP TABLE ${TEMP_TABLES.artistVectors} (
      object_id INTEGER PRIMARY KEY,
      source_updated_at TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding_f32 BLOB NOT NULL
    );
  `);
  const oldSpaceStatement = database.prepare(`INSERT INTO temp.${TEMP_TABLES.oldSpaces}(object_kind, embedding_model, dimension) VALUES (?, ?, ?)`);
  for (const row of oldSpaces) oldSpaceStatement.run(row.object_kind, row.embedding_model, row.dimension);
  const oldEntryStatement = database.prepare(`INSERT INTO temp.${TEMP_TABLES.oldEntries}(object_kind, object_id, embedding_f32) VALUES (?, ?, ?)`);
  for (const row of oldEntries) oldEntryStatement.run(row.object_kind, row.object_id, Buffer.from(row.embedding_f32));
  const loraStatement = database.prepare(`INSERT INTO temp.${TEMP_TABLES.loraVectors}(object_id, source_updated_at, embedding_model, dimension, embedding_f32) VALUES (?, ?, ?, ?, ?)`);
  for (const row of prepared.generation_lora.rows) loraStatement.run(row.object_id, row.source_updated_at, row.embedding_model, row.dimension, row.embedding_f32);
  const artistStatement = database.prepare(`INSERT INTO temp.${TEMP_TABLES.artistVectors}(object_id, source_updated_at, embedding_model, dimension, embedding_f32) VALUES (?, ?, ?, ?, ?)`);
  for (const row of prepared.artist_prompt_string.rows) artistStatement.run(row.object_id, row.source_updated_at, row.embedding_model, row.dimension, row.embedding_f32);
}

function stripMigrationTransactionControl(sql) {
  return sql.replace(/^\s*(?:PRAGMA\s+foreign_keys\s*=\s*(?:ON|OFF)|BEGIN(?:\s+IMMEDIATE)?|COMMIT|ROLLBACK)\s*;\s*$/gimu, '');
}

function migrationSql(repositoryRoot, readMigrationSql) {
  const path = resolve(repositoryRoot, 'schema/database/036-generation-resource-vectors.sql');
  const sql = typeof readMigrationSql === 'function' ? readMigrationSql(path) : readFileSync(path, 'utf8');
  if (typeof sql !== 'string' || sql.trim().length === 0) throw new TypeError('036 migration SQL must be a non-empty string');
  return sql;
}

function restoreForeignKeys(database) {
  database.exec('PRAGMA foreign_keys = ON;');
  const value = database.prepare('PRAGMA foreign_keys').get().foreign_keys;
  if (value !== 1) throw new Error(`foreign_keys was not restored to 1 (actual ${String(value)})`);
}

function uncertainError(error, { phase, rollbackError = null, controlFailures = [], evidence = {} } = {}) {
  return migrationError(error, {
    phase,
    status: 'uncertain',
    transactionState: TRANSACTION_STATE.UNCERTAIN,
    rollbackError,
    controlFailures,
    connectionMustClose: true,
    evidence: { ...evidence, no_further_connection_use: true }
  });
}

function readPreparedSourceRows(database) {
  return Object.fromEntries(NEW_OBJECT_KINDS.map((objectKind) => [objectKind, sourceRows(database, objectKind)]));
}

function migrationPreflight(database, { requireOfflineForNonEmpty = false } = {}) {
  const ledger = migrationLedger(database);
  if (ledger !== null) {
    if (ledger.name === GENERATION_RESOURCE_VECTOR_MIGRATION_NAME && converged(database)) {
      return Object.freeze({
        status: 'already_complete',
        version: GENERATION_RESOURCE_VECTOR_MIGRATION_VERSION,
        embedding_calls: 0
      });
    }
    throw new GenerationResourceVectorMigrationError('migration 036 is registered but its schema does not converge', {
      phase: 'preflight',
      status: 'registered_not_converged',
      transactionState: TRANSACTION_STATE.NOT_STARTED,
      evidence: { registered_version: ledger.version, registered_name: ledger.name }
    });
  }
  if (!sourceSchemaLedgerReady(database)) {
    throw new GenerationResourceVectorMigrationError('migration 035 ledger and user_version are not ready for migration 036', {
      phase: 'preflight',
      status: 'source_schema_not_ready',
      transactionState: TRANSACTION_STATE.NOT_STARTED,
      evidence: {
        required_source_version: SOURCE_SCHEMA_VERSION,
        required_source_name: SOURCE_SCHEMA_MIGRATION_NAME,
        no_prepare_started: true,
        no_write_transaction_started: true
      }
    });
  }
  const initialSources = requireOfflineForNonEmpty ? readPreparedSourceRows(database) : null;
  if (initialSources !== null && sourceRowsAreNonEmpty(initialSources)) {
    throw new OfflineGenerationResourceVectorMigrationRequiredError();
  }
  if (targetStructurePresent(database)) {
    throw new GenerationResourceVectorMigrationError('migration 036 target structure exists without its ledger entry', {
      phase: 'preflight',
      status: 'target_without_ledger',
      transactionState: TRANSACTION_STATE.NOT_STARTED
    });
  }
  if (!oldSchemaPresent(database)) {
    throw new GenerationResourceVectorMigrationError('migration 035 vector schema is not available', {
      phase: 'preflight',
      status: 'source_schema_not_ready',
      transactionState: TRANSACTION_STATE.NOT_STARTED
    });
  }

  return Object.freeze({ status: 'pending', initialSources: initialSources ?? readPreparedSourceRows(database) });
}

function emptyPreparedSources() {
  return Object.freeze(Object.fromEntries(NEW_OBJECT_KINDS.map((objectKind) => [
    objectKind,
    Object.freeze({ rows: Object.freeze([]), dimension: null, embedding_model: null })
  ])));
}

function sourceRowsAreNonEmpty(initialSources) {
  return NEW_OBJECT_KINDS.some((objectKind) => initialSources[objectKind].length > 0);
}

function runStagedMigration({
  database,
  repositoryRoot,
  initialSources,
  prepared,
  readMigrationSql,
  embeddingCalls
}) {
  const oldSpaces = database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all();
  const oldEntries = database.prepare('SELECT object_kind, object_id, embedding_f32 FROM vector_entries ORDER BY object_kind, object_id').all();
  try {
    stageTempTables(database, oldSpaces, oldEntries, prepared);
  } catch (error) {
    try { dropTempTables(database); } catch {}
    throw migrationError(error, { phase: 'temp_stage', status: 'temp_stage_failed', transactionState: TRANSACTION_STATE.NOT_STARTED });
  }

  try {
    const immediatelyBeforeTransaction = readPreparedSourceRows(database);
    for (const objectKind of NEW_OBJECT_KINDS) assertSourceRowsMatch(initialSources[objectKind], immediatelyBeforeTransaction[objectKind], objectKind, 'pre_transaction_source_check');
  } catch (error) {
    try { dropTempTables(database); } catch {}
    throw migrationError(error, { phase: 'pre_transaction_source_check', status: error?.status ?? 'source_drift', transactionState: TRANSACTION_STATE.NOT_STARTED });
  }

  let phase = 'foreign_keys_off';
  let transactionStarted = false;
  let transactionCommitted = false;
  try {
    database.exec('PRAGMA foreign_keys = OFF;');
    phase = 'begin';
    database.exec('BEGIN IMMEDIATE;');
    transactionStarted = true;
    phase = 'migration_sql';
    database.exec(stripMigrationTransactionControl(migrationSql(repositoryRoot, readMigrationSql)));
    phase = 'commit';
    database.exec('COMMIT;');
    transactionCommitted = true;
  } catch (error) {
    if (phase === 'commit') {
      throw uncertainError(error, {
        phase,
        evidence: { commit_result: 'unknown' }
      });
    }
    const controlFailures = [];
    if (transactionStarted && !transactionCommitted) {
      try {
        database.exec('ROLLBACK;');
      } catch (rollbackError) {
        controlFailures.push({ operation: 'ROLLBACK', message: errorMessage(rollbackError) });
        throw uncertainError(error, {
          phase,
          rollbackError,
          controlFailures,
          evidence: { rollback_result: 'unknown' }
        });
      }
    }
    try {
      restoreForeignKeys(database);
    } catch (restoreError) {
      controlFailures.push({ operation: 'FOREIGN_KEYS_RESTORE', message: errorMessage(restoreError) });
      throw uncertainError(error, { phase, controlFailures, evidence: { rollback_result: transactionStarted ? 'complete' : 'not_started' } });
    }
    try { dropTempTables(database); } catch (cleanupError) {
      controlFailures.push({ operation: 'TEMP_CLEANUP', message: errorMessage(cleanupError) });
      throw uncertainError(error, { phase, controlFailures, evidence: { rollback_result: transactionStarted ? 'complete' : 'not_started' } });
    }
    throw migrationError(error, {
      phase,
      status: transactionStarted ? 'rolled_back' : 'not_started',
      transactionState: transactionStarted ? TRANSACTION_STATE.ROLLED_BACK : TRANSACTION_STATE.NOT_STARTED,
      controlFailures,
      evidence: { rollback_result: transactionStarted ? 'complete' : 'not_started' }
    });
  }

  try {
    restoreForeignKeys(database);
    dropTempTables(database);
  } catch (error) {
    throw uncertainError(error, {
      phase: 'post_commit_control',
      evidence: { commit_result: 'complete', no_further_connection_use: true }
    });
  }
  if (!converged(database)) {
    throw uncertainError(new Error('migration 036 committed without a converged schema'), {
      phase: 'post_commit_assertion',
      evidence: { commit_result: 'complete' }
    });
  }
  return Object.freeze({ status: 'complete', version: GENERATION_RESOURCE_VECTOR_MIGRATION_VERSION, embedding_calls: embeddingCalls });
}

export function migrateGenerationResourceVectorsForOpen({
  database,
  repositoryRoot = defaultRepositoryRoot
} = {}) {
  requireDatabase(database);
  const preflight = migrationPreflight(database, { requireOfflineForNonEmpty: true });
  if (preflight.status === 'already_complete') return preflight;
  return runStagedMigration({
    database,
    repositoryRoot,
    initialSources: preflight.initialSources,
    prepared: emptyPreparedSources(),
    readMigrationSql: null,
    embeddingCalls: 0
  });
}

export async function migrateGenerationResourceVectors({
  database,
  repositoryRoot = defaultRepositoryRoot,
  generationLoraMaintenance,
  artistPromptStringMaintenance,
  readMigrationSql = null
} = {}) {
  requireDatabase(database);
  const preflight = migrationPreflight(database);
  if (preflight.status === 'already_complete') return preflight;

  const { initialSources } = preflight;
  let prepared;
  try {
    const maintenanceOptions = { generationLoraMaintenance, artistPromptStringMaintenance };
    const preparedRows = await Promise.all(NEW_OBJECT_KINDS.map((objectKind) => prepareRows({
      objectKind,
      rows: initialSources[objectKind],
      maintenance: maintenanceOptions[SOURCE_DEFINITIONS[objectKind].maintenanceOption]
    })));
    prepared = Object.fromEntries(NEW_OBJECT_KINDS.map((objectKind, index) => [objectKind, preparedRows[index]]));
  } catch (error) {
    throw migrationError(error, {
      phase: 'prepare',
      status: error?.status ?? 'prepare_failed',
      transactionState: transactionStateOf(error) ?? TRANSACTION_STATE.NOT_STARTED,
      evidence: { no_write_transaction_started: true }
    });
  }

  const afterPrepareSources = readPreparedSourceRows(database);
  for (const objectKind of NEW_OBJECT_KINDS) assertSourceRowsMatch(initialSources[objectKind], afterPrepareSources[objectKind], objectKind, 'pre_transaction_source_check');
  return runStagedMigration({
    database,
    repositoryRoot,
    initialSources,
    prepared,
    readMigrationSql,
    embeddingCalls: NEW_OBJECT_KINDS.reduce((count, objectKind) => count + initialSources[objectKind].length, 0)
  });
}

export const migrateGenerationResourceVectorSchema = migrateGenerationResourceVectors;
