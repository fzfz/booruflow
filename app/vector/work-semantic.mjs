import { ApplicationError } from '../security/error-mapping.mjs';
import { inTransaction } from '../catalog/database.mjs';
import { createSemanticService } from './semantic-service.mjs';
import {
  deleteVectorEntry,
  embedProjection,
  normalizeEmbedding,
  rebuildVectorEntries,
  upsertVectorEntry
} from './vector-store.mjs';

const OBJECT_KIND = 'work';

function aliases(row) {
  let value;
  try { value = JSON.parse(row.aliases_json); } catch { throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'work aliases are invalid'); }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'work aliases are invalid');
  return value;
}

export function workTextProjection(row) {
  return [row.name, ...aliases(row), row.category_name].filter((part) => typeof part === 'string' && part.length > 0).join('\n');
}

function publicResult(row, retrieval) {
  return Object.freeze({ id: row.id, name: row.name, aliases: aliases(row), category_name: row.category_name ?? null, ...retrieval });
}

function catalogResult(database, row) {
  const characterNames = database.prepare('SELECT name FROM characters WHERE work_id = ? AND is_available = 1 ORDER BY id').all(row.id).map(({ name }) => name);
  return Object.freeze({
    id: row.id,
    name: row.name,
    aliases: aliases(row),
    category_name: row.category_name ?? null,
    character_names: Object.freeze(characterNames),
    cover_media_path: row.cover_media_path ?? null
  });
}

function agentResult(row) {
  return Object.freeze({ name: row.name, aliases: aliases(row), category_name: row.category_name ?? null, character_names: Object.freeze(row.character_names ?? []) });
}

function sourceRow(database, id) {
  return database.prepare('SELECT id, name, aliases_json, category_name, cover_media_path FROM works WHERE id = ? AND is_available = 1').get(id);
}

function sourceRows(database) {
  return database.prepare('SELECT id, name, aliases_json, category_name, cover_media_path FROM works WHERE is_available = 1 ORDER BY id').all();
}

function loadQueryRows(database, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return database.prepare(`SELECT id, name, aliases_json, category_name, cover_media_path FROM works WHERE is_available = 1 AND id IN (${placeholders})`).all(...ids);
}

function maintenance({ database, modelClient, configuration, now }) {
  if (!modelClient || typeof modelClient.embed !== 'function') throw new TypeError('modelClient.embed is required');
  if (typeof configuration?.embedding_model !== 'string' || configuration.embedding_model.length === 0) throw new TypeError('configuration.embedding_model is required');

  async function upsert(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('objectId must be a positive integer');
    const row = sourceRow(database, id);
    if (!row) return inTransaction(database, () => { deleteVectorEntry(database, OBJECT_KIND, id); return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'deleted' }); });
    const vector = normalizeEmbedding(await embedProjection(modelClient, workTextProjection(row)));
    inTransaction(database, () => upsertVectorEntry(database, OBJECT_KIND, id, vector, { expectedModel: configuration.embedding_model }));
    return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'updated' });
  }

  function remove(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('objectId must be a positive integer');
    inTransaction(database, () => deleteVectorEntry(database, OBJECT_KIND, id));
    return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'deleted' });
  }

  async function rebuild(options = {}) {
    return rebuildVectorEntries({ database, objectKind: OBJECT_KIND, rows: sourceRows(database), project: workTextProjection, modelClient, embeddingModel: configuration.embedding_model, reset: options.reset === true, now });
  }

  return Object.freeze({ upsert, delete: remove, rebuild });
}

export function createWorkVectorMaintenance(options) { return maintenance(options); }

export function createWorkSemanticService({ database, modelClient, configuration }) {
  return createSemanticService({
    database,
    objectKind: OBJECT_KIND,
    modelClient,
    configuration,
    loadRows: (ids) => loadQueryRows(database, ids),
    projectText: workTextProjection,
    projectPublic: publicResult,
    projectCatalog: (row) => catalogResult(database, row),
    compareCatalog: (left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)),
    projectAgent: (row) => {
      const names = database.prepare('SELECT name FROM characters WHERE work_id = ? AND is_available = 1 ORDER BY id').all(row.id).map(({ name }) => name);
      return agentResult({ ...row, character_names: names });
    }
  });
}
