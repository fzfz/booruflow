import { ApplicationError } from '../security/error-mapping.mjs';
import { assertIdentifier, InputValidationError } from '../security/input-validation.mjs';
import { inTransaction } from '../catalog/database.mjs';
import { createSemanticService } from './semantic-service.mjs';
import { deleteVectorEntry, embedProjection, normalizeEmbedding, rebuildVectorEntries, upsertVectorEntry } from './vector-store.mjs';

const OBJECT_KIND = 'character';

function aliases(row) {
  let value;
  try { value = JSON.parse(row.aliases_json); } catch { throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'character aliases are invalid'); }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'character aliases are invalid');
  return value;
}

export function characterTextProjection(row) {
  return [row.work_name, row.name, ...aliases(row), row.prompt_text].filter((part) => typeof part === 'string' && part.length > 0).join('\n');
}

function publicResult(row, retrieval) {
  return Object.freeze({ id: row.id, work_id: row.work_id, name: row.name, aliases: aliases(row), prompt_text: row.prompt_text, ...retrieval });
}

function agentResult(row) {
  return Object.freeze({ work_name: row.work_name ?? null, name: row.name, aliases: aliases(row), prompt_text: row.prompt_text });
}

function catalogResult(row) {
  return Object.freeze({
    id: row.id,
    work_id: row.work_id,
    work_name: row.work_name,
    name: row.name,
    aliases: aliases(row),
    prompt_text: row.prompt_text,
    cover_media_path: row.cover_media_path ?? null
  });
}

function validateWorkId(options) {
  if (!Object.hasOwn(options, 'work_id') || options.work_id === null) return;
  const workId = options.catalog === true && typeof options.work_id === 'string' && /^[1-9][0-9]{0,19}$/u.test(options.work_id)
    ? Number(options.work_id)
    : options.work_id;
  try { assertIdentifier(workId, 'work_id'); }
  catch (error) {
    if (error instanceof InputValidationError) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', error.message);
    throw error;
  }
  return workId === options.work_id ? options : Object.freeze({ ...options, work_id: workId });
}

function sourceRow(database, id) {
  return database.prepare(`SELECT characters.id, characters.work_id, characters.name, characters.aliases_json, characters.prompt_text, characters.cover_media_path, works.name AS work_name
    FROM characters JOIN works ON works.id = characters.work_id
    WHERE characters.id = ? AND characters.is_available = 1 AND works.is_available = 1`).get(id);
}

function sourceRows(database) {
  return database.prepare(`SELECT characters.id, characters.work_id, characters.name, characters.aliases_json, characters.prompt_text, characters.cover_media_path, works.name AS work_name
    FROM characters JOIN works ON works.id = characters.work_id
    WHERE characters.is_available = 1 AND works.is_available = 1 ORDER BY characters.id`).all();
}

function loadQueryRows(database, ids, { work_id: workId = null } = {}) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return database.prepare(`SELECT characters.id, characters.work_id, characters.name, characters.aliases_json, characters.prompt_text, characters.cover_media_path, works.name AS work_name
    FROM characters JOIN works ON works.id = characters.work_id
    WHERE characters.is_available = 1 AND works.is_available = 1 AND characters.id IN (${placeholders})${workId === null ? '' : ' AND characters.work_id = ?'}`)
    .all(...ids, ...(workId === null ? [] : [workId]));
}

function maintenance({ database, modelClient, configuration, now }) {
  if (!modelClient || typeof modelClient.embed !== 'function') throw new TypeError('modelClient.embed is required');
  if (typeof configuration?.embedding_model !== 'string' || configuration.embedding_model.length === 0) throw new TypeError('configuration.embedding_model is required');

  async function upsert(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('objectId must be a positive integer');
    const row = sourceRow(database, id);
    if (!row) return inTransaction(database, () => { deleteVectorEntry(database, OBJECT_KIND, id); return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'deleted' }); });
    const vector = normalizeEmbedding(await embedProjection(modelClient, characterTextProjection(row)));
    inTransaction(database, () => upsertVectorEntry(database, OBJECT_KIND, id, vector, { expectedModel: configuration.embedding_model }));
    return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'updated' });
  }

  function remove(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('objectId must be a positive integer');
    inTransaction(database, () => deleteVectorEntry(database, OBJECT_KIND, id));
    return Object.freeze({ object_kind: OBJECT_KIND, object_id: id, status: 'deleted' });
  }

  async function rebuild(options = {}) {
    return rebuildVectorEntries({ database, objectKind: OBJECT_KIND, rows: sourceRows(database), project: characterTextProjection, modelClient, embeddingModel: configuration.embedding_model, reset: options.reset === true, now });
  }

  return Object.freeze({ upsert, delete: remove, rebuild });
}

export function createCharacterVectorMaintenance(options) { return maintenance(options); }

export function createCharacterSemanticService({ database, modelClient, configuration }) {
  return createSemanticService({
    database,
    objectKind: OBJECT_KIND,
    modelClient,
    configuration,
    loadRows: (ids, options) => loadQueryRows(database, ids, options),
    projectText: characterTextProjection,
    projectPublic: publicResult,
    projectAgent: agentResult,
    projectCatalog: catalogResult,
    compareCatalog: (left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)),
    beforeLoad: validateWorkId
  });
}
