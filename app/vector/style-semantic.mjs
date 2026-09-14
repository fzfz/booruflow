import { ApplicationError } from '../security/error-mapping.mjs';
import { assertBaseModelName, normalizeSearchText, validateSemanticQueryRequest } from '../security/input-validation.mjs';
import { inTransaction } from '../catalog/database.mjs';
import { cosineScoreFromDistance, createSemanticService } from './semantic-service.mjs';
import { deleteVectorEntry, embedProjection, normalizeEmbedding, readVectorEntryDistance, rebuildVectorEntries, upsertVectorEntry } from './vector-store.mjs';

const OBJECT_KIND = 'style';

function aliases(row) {
  let value;
  try { value = JSON.parse(row.aliases_json); } catch { throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'style aliases are invalid'); }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'style aliases are invalid');
  return value;
}

export function styleTextProjection(row) {
  return [row.name, ...aliases(row), row.style_description, row.prompt_text]
    .filter((part) => typeof part === 'string' && part.length > 0).join('\n');
}

function publicResult(row) {
  return Object.freeze({ id: row.id, name: row.name, aliases: aliases(row), prompt_text: row.prompt_text, style_description: row.style_description ?? null });
}

function agentResult(row) {
  return Object.freeze({ name: row.name, aliases: aliases(row), style_description: row.style_description ?? null, prompt_text: row.prompt_text });
}

function sourceRow(database, id) {
  return database.prepare(`SELECT id, base_model_id, name, aliases_json, style_description, prompt_text
    FROM styles WHERE id = ?`).get(id);
}

function sourceRows(database) {
  return database.prepare(`SELECT id, base_model_id, name, aliases_json, style_description, prompt_text
    FROM styles ORDER BY id`).all();
}

function loadQueryRows(database, ids, { base_model_id: baseModelId = undefined } = {}) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const relation = baseModelId === undefined || baseModelId === null ? '' : ' AND base_model_id = ?';
  return database.prepare(`SELECT id, base_model_id, name, aliases_json, style_description, prompt_text, cover_media_path
    FROM styles WHERE id IN (${placeholders})${relation}`).all(...ids, ...(relation === '' ? [] : [baseModelId]));
}

function validateStyleSemanticRequest(request) {
  return validateSemanticQueryRequest(request, { requireBaseModelName: true });
}

function resolveBaseModel(database, value) {
  const name = assertBaseModelName(value);
  const row = database.prepare('SELECT id FROM generation_base_models WHERE name = ?').get(name);
  if (!row) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', 'base_model_name does not identify an existing generation base model');
  return row.id;
}

function resolveCatalogBaseModel(database, value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ApplicationError('CATALOG_REQUEST_INVALID', 'base_model_id does not identify an existing generation base model');
  const row = database.prepare('SELECT id FROM generation_base_models WHERE id = ?').get(id);
  if (!row) throw new ApplicationError('CATALOG_REQUEST_INVALID', 'base_model_id does not identify an existing generation base model');
  return row.id;
}

function beforeLoad(database, options = {}) {
  const catalog = options.catalog === true;
  if (Object.hasOwn(options, 'base_model_id')) {
    const { catalog: _catalog, ...rest } = options;
    return Object.freeze({ ...rest, base_model_id: resolveCatalogBaseModel(database, options.base_model_id) });
  }
  if (Object.hasOwn(options, 'base_model_name')) {
    const { catalog: _catalog, ...rest } = options;
    return Object.freeze({ ...rest, base_model_id: resolveBaseModel(database, options.base_model_name) });
  }
  if (catalog) {
    const { catalog: _catalog, ...rest } = options;
    return rest;
  }
  return Object.freeze({ ...options, base_model_id: resolveBaseModel(database, options.base_model_name) });
}

function ensureExactStyleCandidates(database, { entries, query, query_vector: queryVector, options, candidate_limit: candidateLimit }) {
  const relation = options.base_model_id === undefined || options.base_model_id === null ? '' : ' AND base_model_id = ?';
  const relationValues = relation === '' ? [] : [options.base_model_id];
  const exactIds = database.prepare(`SELECT id
    FROM styles
    WHERE catalog_name_key(name) = ?${relation}
    ORDER BY id
    LIMIT ?`).all(query, ...relationValues, candidateLimit).map(({ id }) => id);
  const existing = new Set(entries.map(({ object_id: objectId }) => objectId));
  const missing = exactIds.filter((objectId) => !existing.has(objectId)).map((objectId) => {
    const distance = readVectorEntryDistance(database, OBJECT_KIND, objectId, queryVector);
    if (distance === null) return null;
    const vectorScore = cosineScoreFromDistance(distance.distance);
    return vectorScore > 0 ? { object_id: objectId, vector_score: vectorScore } : null;
  }).filter((entry) => entry !== null);
  const replacementCount = Math.min(missing.length, entries.length, candidateLimit);
  const retained = entries.slice(0, entries.length < candidateLimit ? entries.length : candidateLimit - replacementCount);
  return [...retained, ...missing.slice(0, candidateLimit - retained.length)];
}

function catalogResult(row) {
  return Object.freeze({
    id: row.id,
    base_model_id: row.base_model_id,
    name: row.name,
    aliases_json: row.aliases_json,
    prompt_text: row.prompt_text,
    style_description: row.style_description,
    cover_media_path: row.cover_media_path ?? null
  });
}

function maintenance({ database, modelClient, configuration, now }) {
  if (!modelClient || typeof modelClient.embed !== 'function') throw new TypeError('modelClient.embed is required');
  if (typeof configuration?.embedding_model !== 'string' || configuration.embedding_model.length === 0) throw new TypeError('configuration.embedding_model is required');

  async function upsert(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('objectId must be a positive integer');
    const row = sourceRow(database, id);
    if (!row) return inTransaction(database, () => { deleteVectorEntry(database, OBJECT_KIND, id); return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'deleted' }); });
    const vector = normalizeEmbedding(await embedProjection(modelClient, styleTextProjection(row)));
    inTransaction(database, () => upsertVectorEntry(database, OBJECT_KIND, id, vector, { expectedModel: configuration.embedding_model }));
    return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'updated' });
  }

  function remove(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('objectId must be a positive integer');
    inTransaction(database, () => deleteVectorEntry(database, OBJECT_KIND, id));
    return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'deleted' });
  }

  async function rebuild(options = {}) {
    return rebuildVectorEntries({ database, objectKind: OBJECT_KIND, rows: sourceRows(database), project: styleTextProjection, modelClient, embeddingModel: configuration.embedding_model, reset: options.reset === true, now, onProgress: options.onProgress ?? null });
  }

  return Object.freeze({ upsert, delete: remove, rebuild });
}

export function createStyleVectorMaintenance(options) { return maintenance(options); }

export function createStyleSemanticService({ database, modelClient, configuration }) {
  database.function('catalog_name_key', { deterministic: true }, normalizeSearchText);
  return createSemanticService({
    database,
    objectKind: OBJECT_KIND,
    modelClient,
    configuration,
    loadRows: (ids, options) => loadQueryRows(database, ids, options),
    projectText: styleTextProjection,
    projectPublic: publicResult,
    projectAgent: agentResult,
    projectCatalog: catalogResult,
    compareCatalog: (left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)),
    requestValidator: validateStyleSemanticRequest,
    unconfiguredErrorCode: 'INTERNAL_ERROR',
    beforeLoad: (options) => beforeLoad(database, options),
    candidatePriority: (row, normalizedQuery) => normalizeSearchText(row.name) === normalizedQuery,
    ensureCandidate: (options) => ensureExactStyleCandidates(database, options)
  });
}
