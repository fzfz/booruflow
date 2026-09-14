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

function loraProjection(row) {
  return Object.freeze({ kind: 'lora', id: row.id, name: row.file_name });
}

function templateProjection(row) {
  return Object.freeze({ kind: 'template', id: row.id, name: row.title });
}

function imageProjection(row) {
  return Object.freeze({ kind: 'image', id: row.id, owner_kind: row.owner_kind, owner_id: row.owner_id, media_path: row.media_path });
}

export function createModelRepository(database) {
  const projection = `model.id, model.base_model_id, base.name AS base_model_name,
    model.file_name, model.file_format, model.precision_or_quantization,
    model.author, model.version, model.release_url, model.published_at, model.description, model.usage,
    model.skill_name, model.cover_media_path, model.created_at, model.updated_at`;
  const statements = Object.freeze({
    list: database.prepare(`SELECT ${projection}
      FROM generation_models AS model
      JOIN generation_base_models AS base ON base.id = model.base_model_id
      WHERE (lower(model.file_name) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(model.author, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(model.version, '')) LIKE ? ESCAPE '\\'
        OR lower(model.description) LIKE ? ESCAPE '\\'
        OR lower(model.usage) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(model.skill_name, '')) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR model.base_model_id = ?)
        AND (? IS NULL OR model.file_format = ?)
        AND (? IS NULL OR model.precision_or_quantization = ?)
      ORDER BY lower(model.file_name) COLLATE BINARY, model.id
      LIMIT ? OFFSET ?`),
    total: database.prepare(`SELECT COUNT(*) AS count
      FROM generation_models
      WHERE (lower(file_name) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(author, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(version, '')) LIKE ? ESCAPE '\\'
        OR lower(description) LIKE ? ESCAPE '\\'
        OR lower(usage) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(skill_name, '')) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR base_model_id = ?)
        AND (? IS NULL OR file_format = ?)
        AND (? IS NULL OR precision_or_quantization = ?)`),
    get: database.prepare(`SELECT ${projection} FROM generation_models AS model
      JOIN generation_base_models AS base ON base.id = model.base_model_id
      WHERE model.id = ?`),
    baseModel: database.prepare('SELECT id FROM generation_base_models WHERE id = ?'),
    insert: database.prepare(`INSERT INTO generation_models(
      base_model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, published_at, description, usage, skill_name,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: database.prepare(`UPDATE generation_models SET
      base_model_id = ?, file_name = ?, file_format = ?, precision_or_quantization = ?,
      author = ?, version = ?, release_url = ?, published_at = ?, description = ?, usage = ?, skill_name = ?,
      updated_at = ?
      WHERE id = ?`),
    dependentLora: database.prepare('SELECT 1 FROM generation_loras WHERE model_id = ? LIMIT 1'),
    dependentTemplate: database.prepare('SELECT 1 FROM comfyui_templates WHERE model_id = ? LIMIT 1'),
    remove: database.prepare('DELETE FROM generation_models WHERE id = ?'),
    loras: database.prepare('SELECT id, file_name FROM generation_loras WHERE model_id = ? ORDER BY id'),
    templates: database.prepare('SELECT id, title FROM comfyui_templates WHERE model_id = ? ORDER BY id'),
    images: database.prepare(`SELECT id, owner_kind, owner_id, media_path
      FROM item_images
      WHERE (owner_kind = 'model' AND owner_id = ?)
         OR (owner_kind = 'lora' AND owner_id IN (SELECT id FROM generation_loras WHERE model_id = ?))
         OR (owner_kind = 'template' AND owner_id IN (SELECT id FROM comfyui_templates WHERE model_id = ?))
      ORDER BY owner_kind, owner_id, id`)
  });

  function get(id) {
    const row = statements.get.get(id);
    return row ? Object.freeze(row) : null;
  }

  function getImpact(id) {
    const target = get(id);
    if (!target) return null;
    const impact = {
      target: Object.freeze({ id: target.id, name: target.file_name }),
      cascade_deleted: Object.freeze([
        ...statements.loras.all(id).map(loraProjection),
        ...statements.templates.all(id).map(templateProjection),
        ...statements.images.all(id, id, id).map(imageProjection)
      ]),
      retained: Object.freeze([])
    };
    return Object.freeze({ ...impact, impact_token: impactToken(impact) });
  }

  return Object.freeze({
    list({ page, page_size: pageSize, q, base_model_id: baseModelId, file_format: fileFormat, precision_or_quantization: precision }) {
      const pattern = likePattern(q);
      const search = Array(6).fill(pattern);
      const filters = [baseModelId ?? null, fileFormat ?? null, precision ?? null];
      return Object.freeze({
        items: Object.freeze(statements.list.all(...search, filters[0], filters[0], filters[1], filters[1], filters[2], filters[2], pageSize, (page - 1) * pageSize).map((row) => Object.freeze(row))),
        page,
        page_size: pageSize,
        total_count: statements.total.get(...search, filters[0], filters[0], filters[1], filters[1], filters[2], filters[2]).count
      });
    },
    get,
    baseModelExists: (id) => Boolean(statements.baseModel.get(id)),
    hasDependents: (id) => Boolean(statements.dependentLora.get(id) || statements.dependentTemplate.get(id)),
    create({ base_model_id: baseModelId, file_name: fileName, file_format: fileFormat, precision_or_quantization: precision, author, version, release_url: releaseUrl, published_at: publishedAt, description, usage, skill_name: skillName, timestamp }) {
      const result = statements.insert.run(baseModelId, fileName, fileFormat, precision, author, version, releaseUrl, publishedAt, description, usage, skillName, timestamp, timestamp);
      return get(Number(result.lastInsertRowid));
    },
    update({ id, base_model_id: baseModelId, file_name: fileName, file_format: fileFormat, precision_or_quantization: precision, author, version, release_url: releaseUrl, published_at: publishedAt, description, usage, skill_name: skillName, timestamp }) {
      statements.update.run(baseModelId, fileName, fileFormat, precision, author, version, releaseUrl, publishedAt, description, usage, skillName, timestamp, id);
      return get(id);
    },
    getImpact,
    remove: (id) => statements.remove.run(id)
  });
}
