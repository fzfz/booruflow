import { createImpactToken } from './base-model-repository.mjs';

function likePattern(query) {
  return `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
}

function imageProjection(row) {
  return Object.freeze({ kind: 'image', id: row.id, owner_kind: row.owner_kind, owner_id: row.owner_id, media_path: row.media_path });
}

function project(row) {
  return Object.freeze({
    id: row.id,
    base_model_id: row.base_model_id,
    base_model_name: row.base_model_name,
    model_id: row.model_id,
    model_name: row.model_name,
    lora_id: row.lora_id,
    lora_name: row.lora_name,
    template_type: row.template_type,
    title: row.title,
    template_json: JSON.parse(row.template_json),
    cover_media_path: row.cover_media_path,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function projectWorkflowSource(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    title: row.title,
    workflow_json: JSON.parse(row.template_json)
  });
}

export function createComfyuiTemplateRepository(database) {
  const projection = `template.id, template.base_model_id, base.name AS base_model_name,
    template.model_id, model.file_name AS model_name, template.lora_id, lora.file_name AS lora_name,
    template.template_type, template.title, template.template_json, template.cover_media_path,
    template.created_at, template.updated_at`;
  const statements = Object.freeze({
    list: database.prepare(`SELECT ${projection} FROM comfyui_templates AS template
      JOIN generation_base_models AS base ON base.id = template.base_model_id
      JOIN generation_models AS model ON model.id = template.model_id
      LEFT JOIN generation_loras AS lora ON lora.id = template.lora_id
      WHERE (lower(template.title) LIKE ? ESCAPE '\\' OR lower(template.template_json) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR template.base_model_id = ?)
        AND (? IS NULL OR template.model_id = ?)
        AND (? IS NULL OR template.lora_id = ?)
        AND (? IS NULL OR template.template_type = ?)
      ORDER BY lower(template.title) COLLATE BINARY, template.id LIMIT ? OFFSET ?`),
    total: database.prepare(`SELECT COUNT(*) AS count FROM comfyui_templates
      WHERE (lower(title) LIKE ? ESCAPE '\\' OR lower(template_json) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR base_model_id = ?)
        AND (? IS NULL OR model_id = ?)
        AND (? IS NULL OR lora_id = ?)
        AND (? IS NULL OR template_type = ?)`),
    get: database.prepare(`SELECT ${projection} FROM comfyui_templates AS template
      JOIN generation_base_models AS base ON base.id = template.base_model_id
      JOIN generation_models AS model ON model.id = template.model_id
      LEFT JOIN generation_loras AS lora ON lora.id = template.lora_id
      WHERE template.id = ?`),
    workflowSource: database.prepare(`SELECT id, title, template_json
      FROM comfyui_templates WHERE id = ?`),
    modelInBase: database.prepare('SELECT id FROM generation_models WHERE id = ? AND base_model_id = ?'),
    loraInEcosystem: database.prepare('SELECT id FROM generation_loras WHERE id = ? AND base_model_id = ? AND model_id = ?'),
    insert: database.prepare(`INSERT INTO comfyui_templates(
      base_model_id, model_id, lora_id, template_type, title, template_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    update: database.prepare(`UPDATE comfyui_templates SET
      base_model_id = ?, model_id = ?, lora_id = ?, template_type = ?, title = ?, template_json = ?,
      updated_at = ?
      WHERE id = ?`),
    images: database.prepare(`SELECT id, owner_kind, owner_id, media_path FROM item_images
      WHERE owner_kind = 'template' AND owner_id = ? ORDER BY id`),
    removeTemplate: database.prepare('DELETE FROM comfyui_templates WHERE id = ?')
  });

  function get(id) {
    const row = statements.get.get(id);
    return row ? project(row) : null;
  }

  function getImpact(id) {
    const target = get(id);
    if (!target) return null;
    const impact = Object.freeze({
      target: Object.freeze({ id: target.id, name: target.title }),
      cascade_deleted: Object.freeze(statements.images.all(id).map(imageProjection)),
      retained: Object.freeze([])
    });
    return Object.freeze({ ...impact, impact_token: createImpactToken(impact) });
  }

  return Object.freeze({
    list({ page, page_size: pageSize, q, base_model_id: baseModelId, model_id: modelId, lora_id: loraId, template_type: templateType }) {
      const pattern = likePattern(q);
      const filters = [baseModelId ?? null, modelId ?? null, loraId ?? null, templateType ?? null];
      const values = [pattern, pattern, ...filters.flatMap((filter) => [filter, filter])];
      return Object.freeze({
        items: Object.freeze(statements.list.all(...values, pageSize, (page - 1) * pageSize).map(project)),
        page,
        page_size: pageSize,
        total_count: statements.total.get(...values).count
      });
    },
    get,
    getWorkflowSource: (id) => projectWorkflowSource(statements.workflowSource.get(id)),
    modelInBase: (modelId, baseModelId) => Boolean(statements.modelInBase.get(modelId, baseModelId)),
    loraInEcosystem: (loraId, baseModelId, modelId) => Boolean(statements.loraInEcosystem.get(loraId, baseModelId, modelId)),
    create({ base_model_id: baseModelId, model_id: modelId, lora_id: loraId, template_type: templateType, title, template_json: templateJson, timestamp }) {
      const result = statements.insert.run(baseModelId, modelId, loraId, templateType, title, JSON.stringify(templateJson), timestamp, timestamp);
      return get(Number(result.lastInsertRowid));
    },
    update({ id, base_model_id: baseModelId, model_id: modelId, lora_id: loraId, template_type: templateType, title, template_json: templateJson, timestamp }) {
      statements.update.run(baseModelId, modelId, loraId, templateType, title, JSON.stringify(templateJson), timestamp, id);
      return get(id);
    },
    getImpact,
    remove: (id) => statements.removeTemplate.run(id)
  });
}
