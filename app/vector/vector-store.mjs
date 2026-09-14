import { ApplicationError } from '../security/error-mapping.mjs';
import { inTransaction } from '../catalog/database.mjs';
import {
  TRANSACTION_STATE,
  hasTransactionState,
  markTransactionState,
  preserveTransactionEvidence
} from '../transaction-state.mjs';
import { OBJECT_KINDS, VECTOR_SOURCE_DEFINITIONS } from './vector-source-definitions.mjs';

export { OBJECT_KINDS };
export const UNCONFIGURED_EMBEDDING_MODEL = '__unconfigured__';
export const VECTOR_DIMENSION = 1024;

function assertObjectKind(objectKind) {
  if (!OBJECT_KINDS.includes(objectKind)) throw new TypeError(`unsupported vector object kind: ${objectKind}`);
  return objectKind;
}

export function normalizeEmbedding(vector) {
  const values = Array.isArray(vector) ? vector : vector instanceof Float32Array ? [...vector] : null;
  if (values === null || values.length === 0 || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'embedding response has an invalid vector');
  }
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'embedding response has a zero vector');
  return Float32Array.from(values.map((value) => value / magnitude));
}

export function encodeEmbedding(vector) {
  const normalized = vector instanceof Float32Array ? vector : normalizeEmbedding(vector);
  return Buffer.from(new Uint8Array(normalized.buffer, normalized.byteOffset, normalized.byteLength));
}

export function readVectorSpace(database, objectKind) {
  assertObjectKind(objectKind);
  const row = database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces WHERE object_kind = ?').get(objectKind);
  if (!row) throw new ApplicationError('INTERNAL_ERROR', `${objectKind} vector space configuration is missing`);
  return row;
}

export function readVectorSpaces(database) {
  const rows = database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all();
  if (rows.length !== OBJECT_KINDS.length || rows.some((row, index) => row.object_kind !== [...OBJECT_KINDS].sort()[index])) {
    throw new ApplicationError('INTERNAL_ERROR', 'vector space configuration is incomplete');
  }
  return rows;
}

export function writeVectorSpaceConfiguration(database, objectKind, { embeddingModel, dimension }) {
  assertObjectKind(objectKind);
  if (typeof embeddingModel !== 'string' || embeddingModel.trim().length === 0) throw new TypeError('embeddingModel must be a non-empty string');
  if (dimension !== VECTOR_DIMENSION) throw new TypeError('dimension must be exactly 1024');
  const result = database.prepare('UPDATE vector_spaces SET embedding_model = ?, dimension = ? WHERE object_kind = ?')
    .run(embeddingModel, dimension, objectKind);
  if (result.changes !== 1) throw new ApplicationError('INTERNAL_ERROR', `${objectKind} vector space configuration is missing`);
}

export function upsertVectorEntry(database, objectKind, objectId, vector, { expectedModel = null, replaceModel = false } = {}) {
  assertObjectKind(objectKind);
  if (!Number.isSafeInteger(objectId) || objectId < 1) throw new TypeError('objectId must be a positive integer');
  const normalized = normalizeEmbedding(vector);
  if (normalized.length !== VECTOR_DIMENSION) {
    throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'stored embedding dimension must be exactly 1024');
  }
  let space = readVectorSpace(database, objectKind);
  if (space.embedding_model === UNCONFIGURED_EMBEDDING_MODEL) {
    if (expectedModel === null) throw new ApplicationError('INTERNAL_ERROR', `${objectKind} vector space requires an embedding model`);
    writeVectorSpaceConfiguration(database, objectKind, { embeddingModel: expectedModel, dimension: VECTOR_DIMENSION });
    space = readVectorSpace(database, objectKind);
  } else if (expectedModel !== null && space.embedding_model !== expectedModel) {
    if (replaceModel !== true) throw new ApplicationError('INTERNAL_ERROR', `${objectKind} vector space uses a different embedding model`);
    writeVectorSpaceConfiguration(database, objectKind, { embeddingModel: expectedModel, dimension: VECTOR_DIMENSION });
    space = readVectorSpace(database, objectKind);
  }
  if (space.dimension !== VECTOR_DIMENSION) {
    throw new ApplicationError('INTERNAL_ERROR', `${objectKind} vector space dimension must be exactly 1024`);
  }
  database.prepare(`INSERT INTO vector_entries(object_kind, object_id, embedding_f32)
    VALUES (?, ?, ?)
    ON CONFLICT(object_kind, object_id) DO UPDATE SET embedding_f32 = excluded.embedding_f32`)
    .run(objectKind, objectId, encodeEmbedding(normalized));
  replaceKnnIndexEntry(database, objectKind, objectId, encodeEmbedding(normalized));
  return normalized;
}

export function deleteVectorEntry(database, objectKind, objectId) {
  assertObjectKind(objectKind);
  if (!Number.isSafeInteger(objectId) || objectId < 1) throw new TypeError('objectId must be a positive integer');
  const result = database.prepare('DELETE FROM vector_entries WHERE object_kind = ? AND object_id = ?').run(objectKind, objectId).changes;
  database.prepare('DELETE FROM vector_knn_index WHERE object_kind = ? AND object_id = ?')
    .run(objectKind, BigInt(objectId));
  return result;
}

function replaceKnnIndexEntry(database, objectKind, objectId, embedding) {
  const bytes = Buffer.from(embedding ?? []);
  if (bytes.byteLength !== VECTOR_DIMENSION * Float32Array.BYTES_PER_ELEMENT) {
    throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'stored embedding dimension must be exactly 1024');
  }
  database.prepare('DELETE FROM vector_knn_index WHERE object_kind = ? AND object_id = ?')
    .run(objectKind, BigInt(objectId));
  database.prepare('INSERT INTO vector_knn_index(object_kind, object_id, embedding) VALUES (?, ?, ?)')
    .run(objectKind, BigInt(objectId), bytes);
}

export function searchVectorEntries(database, objectKind, queryVector, limit) {
  assertObjectKind(objectKind);
  if (!(queryVector instanceof Float32Array) || queryVector.length !== VECTOR_DIMENSION) {
    throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'query embedding dimension must be exactly 1024');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  return database.prepare(`SELECT object_id, distance
    FROM vector_knn_index
    WHERE embedding MATCH ?
      AND k = ?
      AND object_kind = ?
    ORDER BY distance`).all(encodeEmbedding(queryVector), BigInt(limit), objectKind);
}

export function readVectorEntryDistance(database, objectKind, objectId, queryVector) {
  assertObjectKind(objectKind);
  if (!Number.isSafeInteger(objectId) || objectId < 1) throw new TypeError('objectId must be a positive integer');
  if (!(queryVector instanceof Float32Array) || queryVector.length !== VECTOR_DIMENSION) {
    throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'query embedding dimension must be exactly 1024');
  }
  return database.prepare(`SELECT object_id, vec_distance_l2(embedding, ?) AS distance
    FROM vector_knn_index
    WHERE object_kind = ? AND object_id = ?`).get(encodeEmbedding(queryVector), objectKind, BigInt(objectId)) ?? null;
}

async function embedOne(modelClient, projection) {
  let response;
  try { response = await modelClient.embed([projection]); }
  catch (error) {
    const embeddingError = error instanceof ApplicationError || hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN)
      ? error
      : new ApplicationError('MODEL_PROTOCOL_ERROR', 'embedding service failed');
    throw markTransactionState(embeddingError, TRANSACTION_STATE.NOT_STARTED);
  }
  if (!Array.isArray(response) || response.length !== 1) throw markTransactionState(new ApplicationError('MODEL_PROTOCOL_ERROR', 'embedding response count differs from the request'), TRANSACTION_STATE.NOT_STARTED);
  try {
    const normalized = normalizeEmbedding(response[0]);
    if (normalized.length !== VECTOR_DIMENSION) throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'embedding response dimension must be exactly 1024');
    return normalized;
  } catch (error) {
    throw markTransactionState(error, TRANSACTION_STATE.NOT_STARTED);
  }
}

export async function rebuildVectorEntries({ database, objectKind, rows, project, modelClient, embeddingModel, reset = false, now = () => new Date(), onProgress = null }) {
  const sourceDefinition = VECTOR_SOURCE_DEFINITIONS[assertObjectKind(objectKind)];
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (typeof project !== 'function') throw new TypeError('project must be a function');
  if (!modelClient || typeof modelClient.embed !== 'function') throw new TypeError('modelClient.embed is required');
  if (typeof embeddingModel !== 'string' || embeddingModel.trim().length === 0) throw new TypeError('embeddingModel is required');
  if (onProgress !== null && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function or null');
  const space = readVectorSpace(database, objectKind);
  // This reader is private to offline rebuild. Online search uses vec0 KNN and
  // never reads the complete embedding set.
  const existing = new Map(database.prepare('SELECT object_id, embedding_f32 FROM vector_entries WHERE object_kind = ? ORDER BY object_id').all(objectKind).map((row) => [row.object_id, row]));
  const existingIndex = new Map(database.prepare('SELECT object_id, embedding FROM vector_knn_index WHERE object_kind = ?').all(objectKind).map((row) => [row.object_id, row]));
  const modelChanged = space.embedding_model !== embeddingModel;
  const resetRequested = reset === true;
  const completed = [];
  const failures = [];
  let configuredDimension = modelChanged || space.embedding_model === UNCONFIGURED_EMBEDDING_MODEL ? null : space.dimension;

  if (resetRequested || modelChanged) {
    inTransaction(database, () => {
      database.prepare('DELETE FROM vector_entries WHERE object_kind = ?').run(objectKind);
      database.prepare('DELETE FROM vector_knn_index WHERE object_kind = ?').run(objectKind);
    });
  }
  const existingEntries = resetRequested || modelChanged ? new Map() : existing;

  const notifyProgress = (event) => {
    // Progress delivery is an observation boundary, not part of the vector
    // write transaction. A callback failure propagates to the caller after a
    // committed write and is never recorded as an embedding/SQL failure.
    onProgress?.(Object.freeze(event));
  };
  const notifyFailureProgress = (event, error) => {
    try {
      notifyProgress(event);
    } catch (progressError) {
      if (hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN)) {
        throw preserveTransactionEvidence(error, { progressError });
      }
      throw progressError;
    }
    if (hasTransactionState(error, TRANSACTION_STATE.UNCERTAIN)) throw error;
  };

  let processed = 0;
  for (const row of rows) {
    const stored = existingEntries.get(row.id);
    const storedIsUsable = stored !== undefined && configuredDimension !== null
      && Buffer.from(stored.embedding_f32).byteLength === configuredDimension * Float32Array.BYTES_PER_ELEMENT;
    const storedIndex = existingIndex.get(row.id);
    const indexIsUsable = storedIsUsable && storedIndex !== undefined
      && Buffer.from(storedIndex.embedding).equals(Buffer.from(stored.embedding_f32));
    if (indexIsUsable) {
      completed.push(row.id);
      processed += 1;
      notifyProgress({ processed, total: rows.length, row, status: 'completed', error: null });
      continue;
    }
    if (storedIsUsable) {
      try {
        inTransaction(database, () => replaceKnnIndexEntry(database, objectKind, row.id, stored.embedding_f32));
        completed.push(row.id);
        processed += 1;
        notifyProgress({ processed, total: rows.length, row, status: 'completed', error: null });
        continue;
      } catch (error) {
        failures.push(Object.freeze({ object_id: row.id, error }));
        processed += 1;
        notifyFailureProgress({ processed, total: rows.length, row, status: 'failed', error }, error);
        continue;
      }
    }
    let vector;
    try { vector = await embedOne(modelClient, project(row)); }
    catch (error) {
      failures.push(Object.freeze({ object_id: row.id, error }));
      processed += 1;
      notifyFailureProgress({ processed, total: rows.length, row, status: 'failed', error }, error);
      continue;
    }
    if (configuredDimension !== null && vector.length !== configuredDimension) {
      const error = markTransactionState(new ApplicationError('MODEL_PROTOCOL_ERROR', `${objectKind} embedding dimension differs from its vector space`), TRANSACTION_STATE.NOT_STARTED);
      failures.push(Object.freeze({ object_id: row.id, error }));
      processed += 1;
      notifyProgress({ processed, total: rows.length, row, status: 'failed', error });
      continue;
    }
    try {
      if (configuredDimension === null) {
        const candidateDimension = vector.length;
        inTransaction(database, () => {
          upsertVectorEntry(database, objectKind, row.id, vector, { expectedModel: embeddingModel, replaceModel: modelChanged });
        });
        configuredDimension = candidateDimension;
      } else {
        inTransaction(database, () => upsertVectorEntry(database, objectKind, row.id, vector, { expectedModel: embeddingModel, replaceModel: modelChanged }));
      }
      completed.push(row.id);
      processed += 1;
    } catch (error) {
      failures.push(Object.freeze({ object_id: row.id, error }));
      processed += 1;
      notifyFailureProgress({ processed, total: rows.length, row, status: 'failed', error }, error);
      continue;
    }
    notifyProgress({ processed, total: rows.length, row, status: 'completed', error: null });
  }

  const at = now().toISOString();
  inTransaction(database, () => {
    database.prepare(`DELETE FROM vector_entries WHERE object_kind = ? AND object_id NOT IN (
      SELECT id FROM ${sourceDefinition.table} WHERE ${sourceDefinition.availableWhere}
    )`).run(objectKind);
    database.prepare(`DELETE FROM vector_knn_index WHERE object_kind = ? AND object_id NOT IN (
      SELECT id FROM ${sourceDefinition.table} WHERE ${sourceDefinition.availableWhere}
    )`).run(objectKind);
  });
  return Object.freeze({ object_kind: objectKind, completed: Object.freeze(completed), failures: Object.freeze(failures), rebuilt_at: at });
}

export async function embedProjection(modelClient, projection) {
  if (!modelClient || typeof modelClient.embed !== 'function') throw new TypeError('modelClient.embed is required');
  return embedOne(modelClient, projection);
}
