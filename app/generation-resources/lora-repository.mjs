import { createHash } from 'node:crypto';

function likePattern(query) {
  return `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
}

function impactToken(impact) {
  return createHash('sha256').update(JSON.stringify({
    target: impact.target,
    cascade_deleted: impact.cascade_deleted,
    retained: impact.retained
  }), 'utf8').digest('hex');
}

function templateProjection(row) {
  return Object.freeze({ kind: 'template', id: row.id, name: row.title });
}

function imageProjection(row) {
  return Object.freeze({ kind: 'image', id: row.id, owner_kind: row.owner_kind, owner_id: row.owner_id, media_path: row.media_path });
}

function loraProjection(row) {
  const { trigger_words_json: triggerWordsJson, ...fields } = row;
  const triggerWords = JSON.parse(triggerWordsJson);
  return Object.freeze({ ...fields, trigger_words: Object.freeze(triggerWords) });
}

export function createLoraRepository(database) {
  const projection = `lora.id, lora.base_model_id, base.name AS base_model_name,
    lora.model_id, model.file_name AS model_name, lora.file_name, lora.file_format,
    lora.precision_or_quantization, lora.author, lora.version, lora.release_url, lora.description,
    lora.usage, lora.trigger_words_json, lora.weight, lora.cover_media_path, lora.created_at, lora.updated_at`;
  const statements = Object.freeze({
    list: database.prepare(`SELECT ${projection}
      FROM generation_loras AS lora
      JOIN generation_base_models AS base ON base.id = lora.base_model_id
      JOIN generation_models AS model ON model.id = lora.model_id
      WHERE (lower(lora.file_name) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(lora.author, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(lora.version, '')) LIKE ? ESCAPE '\\'
        OR lower(lora.description) LIKE ? ESCAPE '\\'
        OR lower(lora.usage) LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM json_each(lora.trigger_words_json) AS trigger_word
          WHERE lower(trigger_word.value) LIKE ? ESCAPE '\\'))
        AND (? IS NULL OR lora.base_model_id = ?)
        AND (? IS NULL OR lora.model_id = ?)
        AND (? IS NULL OR lora.file_format = ?)
        AND (? IS NULL OR lora.precision_or_quantization = ?)
      ORDER BY lower(lora.file_name) COLLATE BINARY, lora.id
      LIMIT ? OFFSET ?`),
    total: database.prepare(`SELECT COUNT(*) AS count
      FROM generation_loras
      WHERE (lower(file_name) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(author, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(version, '')) LIKE ? ESCAPE '\\'
        OR lower(description) LIKE ? ESCAPE '\\'
        OR lower(usage) LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM json_each(trigger_words_json) AS trigger_word
          WHERE lower(trigger_word.value) LIKE ? ESCAPE '\\'))
        AND (? IS NULL OR base_model_id = ?)
        AND (? IS NULL OR model_id = ?)
        AND (? IS NULL OR file_format = ?)
        AND (? IS NULL OR precision_or_quantization = ?)`),
    get: database.prepare(`SELECT ${projection} FROM generation_loras AS lora
      JOIN generation_base_models AS base ON base.id = lora.base_model_id
      JOIN generation_models AS model ON model.id = lora.model_id
      WHERE lora.id = ?`),
    modelInBase: database.prepare('SELECT id FROM generation_models WHERE id = ? AND base_model_id = ?'),
    insert: database.prepare(`INSERT INTO generation_loras(
      base_model_id, model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, description, usage, trigger_words_json, weight, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: database.prepare(`UPDATE generation_loras SET
      base_model_id = ?, model_id = ?, file_name = ?, file_format = ?, precision_or_quantization = ?,
      author = ?, version = ?, release_url = ?, description = ?, usage = ?, trigger_words_json = ?, weight = ?, updated_at = ?
      WHERE id = ?`),
    remove: database.prepare('DELETE FROM generation_loras WHERE id = ?'),
    templates: database.prepare('SELECT id, title FROM comfyui_templates WHERE lora_id = ? ORDER BY id'),
    images: database.prepare(`SELECT id, owner_kind, owner_id, media_path
      FROM item_images
      WHERE (owner_kind = 'lora' AND owner_id = ?)
         OR (owner_kind = 'template' AND owner_id IN (SELECT id FROM comfyui_templates WHERE lora_id = ?))
      ORDER BY owner_kind, owner_id, id`)
  });

  function get(id) {
    const row = statements.get.get(id);
    return row ? loraProjection(row) : null;
  }

  function getImpact(id) {
    const target = get(id);
    if (!target) return null;
    const impact = {
      target: Object.freeze({ id: target.id, name: target.file_name }),
      cascade_deleted: Object.freeze([
        ...statements.templates.all(id).map(templateProjection),
        ...statements.images.all(id, id).map(imageProjection)
      ]),
      retained: Object.freeze([])
    };
    return Object.freeze({ ...impact, impact_token: impactToken(impact) });
  }

  return Object.freeze({
    list({ page, page_size: pageSize, q, base_model_id: baseModelId, model_id: modelId, file_format: fileFormat, precision_or_quantization: precision }) {
      const pattern = likePattern(q);
      const search = Array(6).fill(pattern);
      const filters = [baseModelId ?? null, modelId ?? null, fileFormat ?? null, precision ?? null];
      return Object.freeze({
        items: Object.freeze(statements.list.all(...search, ...filters.flatMap((filter) => [filter, filter]), pageSize, (page - 1) * pageSize).map(loraProjection)),
        page,
        page_size: pageSize,
        total_count: statements.total.get(...search, ...filters.flatMap((filter) => [filter, filter])).count
      });
    },
    get,
    modelInBase: (modelId, baseModelId) => Boolean(statements.modelInBase.get(modelId, baseModelId)),
    create({ base_model_id: baseModelId, model_id: modelId, file_name: fileName, file_format: fileFormat, precision_or_quantization: precision, author, version, release_url: releaseUrl, description, usage, trigger_words: triggerWords, weight, timestamp }) {
      const triggerWordsJson = JSON.stringify(triggerWords);
      const result = statements.insert.run(baseModelId, modelId, fileName, fileFormat, precision, author, version, releaseUrl, description, usage, triggerWordsJson, weight, timestamp, timestamp);
      return get(Number(result.lastInsertRowid));
    },
    update({ id, base_model_id: baseModelId, model_id: modelId, file_name: fileName, file_format: fileFormat, precision_or_quantization: precision, author, version, release_url: releaseUrl, description, usage, trigger_words: triggerWords, weight, timestamp }) {
      const triggerWordsJson = JSON.stringify(triggerWords);
      statements.update.run(baseModelId, modelId, fileName, fileFormat, precision, author, version, releaseUrl, description, usage, triggerWordsJson, weight, timestamp, id);
      return get(id);
    },
    getImpact,
    remove: (id) => statements.remove.run(id)
  });
}
