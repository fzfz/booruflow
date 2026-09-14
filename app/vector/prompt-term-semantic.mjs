import { ApplicationError } from '../security/error-mapping.mjs';
import { inTransaction } from '../catalog/database.mjs';
import { createSemanticService } from './semantic-service.mjs';
import { deleteVectorEntry, embedProjection, normalizeEmbedding, rebuildVectorEntries, upsertVectorEntry } from './vector-store.mjs';

const OBJECT_KIND = 'prompt_term';

function aliases(row) {
  let value;
  try { value = JSON.parse(row.aliases_json); } catch { throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'prompt term aliases are invalid'); }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'prompt term aliases are invalid');
  return value;
}

export function promptTermTextProjection(row) {
  return [row.canonical_tag, ...aliases(row)].filter((part) => typeof part === 'string' && part.length > 0).join('\n');
}

function publicResult(row, retrieval) {
  return Object.freeze({ id: row.id, canonical_tag: row.canonical_tag, aliases: aliases(row), category: row.category, post_count: row.post_count, ...retrieval });
}

function agentResult(row) {
  return Object.freeze({ canonical_tag: row.canonical_tag, aliases: aliases(row) });
}

function sourceRow(database, id) {
  return database.prepare('SELECT id, canonical_tag, aliases_json, category, post_count FROM prompt_terms WHERE id = ?').get(id);
}

function sourceRows(database) {
  return database.prepare('SELECT id, canonical_tag, aliases_json, category, post_count FROM prompt_terms ORDER BY id').all();
}

function loadQueryRows(database, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return database.prepare(`SELECT id, canonical_tag, aliases_json, category, post_count FROM prompt_terms WHERE id IN (${placeholders})`).all(...ids);
}

function maintenance({ database, modelClient, configuration, now }) {
  if (!modelClient || typeof modelClient.embed !== 'function') throw new TypeError('modelClient.embed is required');
  if (typeof configuration?.embedding_model !== 'string' || configuration.embedding_model.length === 0) throw new TypeError('configuration.embedding_model is required');

  async function prepare(source) {
    const vector = normalizeEmbedding(await embedProjection(modelClient, promptTermTextProjection(source)));
    return Object.freeze({ object_kind: OBJECT_KIND, embedding_model: configuration.embedding_model, vector });
  }

  async function upsert(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('objectId must be a positive integer');
    const row = sourceRow(database, id);
    if (!row) return inTransaction(database, () => { deleteVectorEntry(database, OBJECT_KIND, id); return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'deleted' }); });
    const vector = normalizeEmbedding(await embedProjection(modelClient, promptTermTextProjection(row)));
    inTransaction(database, () => upsertVectorEntry(database, OBJECT_KIND, id, vector, { expectedModel: configuration.embedding_model }));
    return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'updated' });
  }

  function remove(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('objectId must be a positive integer');
    inTransaction(database, () => deleteVectorEntry(database, OBJECT_KIND, id));
    return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'deleted' });
  }

  async function rebuild(options = {}) {
    return rebuildVectorEntries({ database, objectKind: OBJECT_KIND, rows: sourceRows(database), project: promptTermTextProjection, modelClient, embeddingModel: configuration.embedding_model, reset: options.reset === true, now });
  }

  return Object.freeze({ prepare, upsert, delete: remove, rebuild });
}

export function createPromptTermVectorMaintenance(options) { return maintenance(options); }

export function createPromptTermSemanticService({ database, modelClient, configuration }) {
  return createSemanticService({
    database,
    objectKind: OBJECT_KIND,
    modelClient,
    configuration,
    loadRows: (ids) => loadQueryRows(database, ids),
    projectText: promptTermTextProjection,
    projectPublic: publicResult,
    projectAgent: agentResult,
    projectCatalog: (row) => Object.freeze({
      id: row.id,
      canonical_tag: row.canonical_tag,
      aliases_json: row.aliases_json,
      category: row.category,
      post_count: row.post_count
    }),
    compareCatalog: (left, right) => Buffer.from(left.canonical_tag).compare(Buffer.from(right.canonical_tag))
  });
}
