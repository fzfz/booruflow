import { ApplicationError } from '../security/error-mapping.mjs';
import { assertBaseModelName, validateSemanticArtistPromptStringsInternalRequest } from '../security/input-validation.mjs';
import { createSemanticService } from './semantic-service.mjs';
import { embedProjection, normalizeEmbedding, rebuildVectorEntries } from './vector-store.mjs';

const OBJECT_KIND = 'artist_prompt_string';

export function artistPromptStringTextProjection(row) {
  return [row.title, row.description, row.artist_string]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n');
}

function resolveBaseModel(database, value) {
  const name = assertBaseModelName(value);
  const row = database.prepare('SELECT id FROM generation_base_models WHERE name = ?').get(name);
  if (!row) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', 'base_model_name does not identify an existing generation base model');
  return row.id;
}

function resolveArtistPromptStringScope(database, options) {
  if (options.catalog === true) {
    if (!Object.hasOwn(options, 'base_model_id')) return Object.freeze({ ...options });
    const baseModelId = Number(options.base_model_id);
    if (!Number.isSafeInteger(baseModelId) || baseModelId < 1
      || !database.prepare('SELECT id FROM generation_base_models WHERE id = ?').get(baseModelId)) {
      throw new ApplicationError('CATALOG_REQUEST_INVALID', 'base_model_id does not identify an existing generation base model');
    }
    return Object.freeze({ ...options, base_model_id: baseModelId });
  }
  const baseModelId = resolveBaseModel(database, options.base_model_name);
  if (options.style_id !== undefined) {
    const row = database.prepare('SELECT id FROM styles WHERE id = ?').get(options.style_id);
    if (!row) throw new ApplicationError('SEMANTIC_QUERY_VALIDATION', 'style_id does not identify an existing style');
  }
  return Object.freeze({ ...options, base_model_id: baseModelId });
}

function styleFilter(options) {
  return options.style_id === undefined
    ? { sql: '', parameters: [] }
    : {
        sql: ` AND EXISTS (
          SELECT 1 FROM artist_prompt_string_styles filter_styles
          WHERE filter_styles.artist_prompt_string_id = artist_prompt_strings.id
            AND filter_styles.style_id = ?
        )`,
        parameters: [options.style_id]
      };
}

function loadArtistPromptStringRows(database, ids, options) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const filter = styleFilter(options);
  const scopedCatalog = options.catalog === true;
  const baseModelFilter = scopedCatalog
    ? (options.base_model_id === undefined || options.base_model_id === null
      ? { sql: '', parameters: [] }
      : { sql: 'AND artist_prompt_strings.base_model_id = ?', parameters: [options.base_model_id] })
    : { sql: 'AND (artist_prompt_strings.base_model_id IS NULL OR artist_prompt_strings.base_model_id = ?)', parameters: [options.base_model_id] };
  const rows = database.prepare(`SELECT artist_prompt_strings.id, artist_prompt_strings.title,
      artist_prompt_strings.description, artist_prompt_strings.artist_string, artist_prompt_strings.base_model_id
    FROM artist_prompt_strings
    WHERE artist_prompt_strings.id IN (${placeholders})
      ${baseModelFilter.sql}
      ${filter.sql}
    ORDER BY artist_prompt_strings.id`).all(...ids, ...baseModelFilter.parameters, ...filter.parameters);
  const styleRows = database.prepare(`SELECT artist_prompt_string_id, style_id
    FROM artist_prompt_string_styles
    WHERE artist_prompt_string_id IN (${placeholders})
    ORDER BY artist_prompt_string_id, style_id`).all(...ids);
  const stylesById = new Map();
  for (const styleRow of styleRows) {
    const styles = stylesById.get(styleRow.artist_prompt_string_id) ?? [];
    styles.push(styleRow.style_id);
    stylesById.set(styleRow.artist_prompt_string_id, styles);
  }
  return rows.map((row) => ({ ...row, style_ids: Object.freeze(stylesById.get(row.id) ?? []) }));
}

function artistPromptStringResult(row) {
  return Object.freeze({
    id: row.id,
    title: row.title,
    description: row.description,
    artist_string: row.artist_string,
    base_model_id: row.base_model_id,
    style_ids: Object.freeze([...row.style_ids])
  });
}

function catalogResult(row) {
  return Object.freeze({
    id: row.id,
    title: row.title,
    description: row.description,
    artist_string: row.artist_string,
    base_model_id: row.base_model_id,
    style_ids: Object.freeze([...row.style_ids])
  });
}

function sourceRows(database) {
  return database.prepare(`SELECT id, title, description, artist_string
    FROM artist_prompt_strings ORDER BY id`).all();
}

function maintenance({ database, modelClient, configuration, now }) {
  if (!modelClient || typeof modelClient.embed !== 'function') throw new TypeError('modelClient.embed is required');
  if (typeof configuration?.embedding_model !== 'string' || configuration.embedding_model.length === 0) throw new TypeError('configuration.embedding_model is required');

  async function prepare(sourceRow) {
    const vector = normalizeEmbedding(await embedProjection(modelClient, artistPromptStringTextProjection(sourceRow)));
    return Object.freeze({ object_kind: OBJECT_KIND, embedding_model: configuration.embedding_model, vector });
  }

  async function rebuild(options = {}) {
    return rebuildVectorEntries({
      database,
      objectKind: OBJECT_KIND,
      rows: sourceRows(database),
      project: artistPromptStringTextProjection,
      modelClient,
      embeddingModel: configuration.embedding_model,
      reset: options.reset === true,
      now,
      onProgress: options.onProgress ?? null
    });
  }

  return Object.freeze({ prepare, rebuild });
}

export function createArtistPromptStringVectorMaintenance(options) { return maintenance(options); }

export function createArtistPromptStringSemanticService({ database, modelClient, configuration }) {
  return createSemanticService({
    database,
    objectKind: OBJECT_KIND,
    modelClient,
    configuration,
    loadRows: (ids, options) => loadArtistPromptStringRows(database, ids, options),
    projectText: artistPromptStringTextProjection,
    projectPublic: artistPromptStringResult,
    projectCatalog: catalogResult,
    compareCatalog: (left, right) => Buffer.from(left.title).compare(Buffer.from(right.title)),
    requestValidator: validateSemanticArtistPromptStringsInternalRequest,
    beforeLoad: (options) => resolveArtistPromptStringScope(database, options)
  });
}
