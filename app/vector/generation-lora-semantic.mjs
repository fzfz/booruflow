import { ApplicationError } from '../security/error-mapping.mjs';
import { assertBaseModelName, validateSemanticGenerationLorasInternalRequest } from '../security/input-validation.mjs';
import { createSemanticService } from './semantic-service.mjs';
import { embedProjection, normalizeEmbedding, rebuildVectorEntries } from './vector-store.mjs';

const OBJECT_KIND = 'generation_lora';

function triggerWords(row) {
  let value;
  try { value = JSON.parse(row.trigger_words_json); } catch { throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'generation lora trigger words are invalid'); }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ApplicationError('MODEL_PROTOCOL_ERROR', 'generation lora trigger words are invalid');
  }
  return value;
}

export function generationLoraTextProjection(row) {
  return [row.file_name, ...triggerWords(row), row.description, row.usage]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n');
}

function resolveBaseModel(database, value) {
  const name = assertBaseModelName(value);
  const row = database.prepare('SELECT id FROM generation_base_models WHERE name = ?').get(name);
  if (!row) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', 'base_model_name does not identify an existing generation base model');
  return row.id;
}

function resolveGenerationLoraScope(database, options) {
  if (options.catalog === true) {
    return Object.freeze({
      ...options,
      ...(options.base_model_id === undefined ? {} : { base_model_id: Number(options.base_model_id) })
    });
  }
  const baseModelId = resolveBaseModel(database, options.base_model_name);
  if (options.model_id !== undefined) {
    const row = database.prepare('SELECT id FROM generation_models WHERE id = ? AND base_model_id = ?').get(options.model_id, baseModelId);
    if (!row) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', 'model_id does not belong to the selected base model');
  }
  return Object.freeze({ ...options, base_model_id: baseModelId });
}

function loadLoraRows(database, ids, options) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const baseModelFilter = options.base_model_id === undefined ? '' : ' AND generation_loras.base_model_id = ?';
  const modelFilter = options.model_id === undefined ? '' : ' AND generation_loras.model_id = ?';
  const parameters = [
    ...ids,
    ...(options.base_model_id === undefined ? [] : [options.base_model_id]),
    ...(options.model_id === undefined ? [] : [options.model_id])
  ];
  return database.prepare(`SELECT generation_loras.id, generation_loras.base_model_id, generation_loras.model_id,
      generation_models.file_name AS model_file_name,
      generation_loras.file_name, generation_loras.file_format, generation_loras.precision_or_quantization,
      generation_loras.author, generation_loras.version, generation_loras.description, generation_loras.usage,
      generation_loras.trigger_words_json, generation_loras.weight, generation_loras.cover_media_path
    FROM generation_loras
    JOIN generation_models ON generation_models.id = generation_loras.model_id
    WHERE generation_loras.id IN (${placeholders})
      ${baseModelFilter}${modelFilter}
    ORDER BY generation_loras.id`).all(...parameters);
}

function loraResult(row) {
  return Object.freeze({
    id: row.id,
    base_model_id: row.base_model_id,
    model_id: row.model_id,
    model_file_name: row.model_file_name,
    file_name: row.file_name,
    description: row.description,
    usage: row.usage,
    trigger_words: Object.freeze(triggerWords(row)),
    weight: row.weight
  });
}

function sourceRows(database) {
  return database.prepare(`SELECT id, file_name, description, usage, trigger_words_json
    FROM generation_loras ORDER BY id`).all();
}

function maintenance({ database, modelClient, configuration, now }) {
  if (!modelClient || typeof modelClient.embed !== 'function') throw new TypeError('modelClient.embed is required');
  if (typeof configuration?.embedding_model !== 'string' || configuration.embedding_model.length === 0) throw new TypeError('configuration.embedding_model is required');

  async function prepare(sourceRow) {
    const vector = normalizeEmbedding(await embedProjection(modelClient, generationLoraTextProjection(sourceRow)));
    return Object.freeze({ object_kind: OBJECT_KIND, embedding_model: configuration.embedding_model, vector });
  }

  async function rebuild(options = {}) {
    return rebuildVectorEntries({
      database,
      objectKind: OBJECT_KIND,
      rows: sourceRows(database),
      project: generationLoraTextProjection,
      modelClient,
      embeddingModel: configuration.embedding_model,
      reset: options.reset === true,
      now,
      onProgress: options.onProgress ?? null
    });
  }

  return Object.freeze({ prepare, rebuild });
}

export function createGenerationLoraVectorMaintenance(options) { return maintenance(options); }

export function createGenerationLoraSemanticService({ database, modelClient, configuration }) {
  return createSemanticService({
    database,
    objectKind: OBJECT_KIND,
    modelClient,
    configuration,
    loadRows: (ids, options) => loadLoraRows(database, ids, options),
    projectText: generationLoraTextProjection,
    projectPublic: loraResult,
    projectCatalog: (row) => Object.freeze({ ...row }),
    compareCatalog: (left, right) => Buffer.from(left.file_name).compare(Buffer.from(right.file_name)),
    requestValidator: validateSemanticGenerationLorasInternalRequest,
    beforeLoad: (options) => resolveGenerationLoraScope(database, options)
  });
}
