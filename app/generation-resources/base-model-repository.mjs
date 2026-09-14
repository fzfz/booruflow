import { createHash, timingSafeEqual } from 'node:crypto';

function likePattern(query) {
  return `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
}

function modelProjection(row) {
  return Object.freeze({ id: row.id, name: row.file_name });
}

function loraProjection(row) {
  return Object.freeze({ id: row.id, name: row.file_name });
}

function templateProjection(row) {
  return Object.freeze({ id: row.id, name: row.title });
}

function artistProjection(row) {
  return Object.freeze({ id: row.id, name: row.title });
}

function imageProjection(row) {
  return Object.freeze({ id: row.id, owner_kind: row.owner_kind, owner_id: row.owner_id, media_path: row.media_path });
}

function canonicalImpactSnapshot(impact) {
  return JSON.stringify({
    target: impact.target,
    cascade_deleted: impact.cascade_deleted,
    retained: impact.retained
  });
}

export function createImpactToken(impact) {
  return createHash('sha256').update(canonicalImpactSnapshot(impact), 'utf8').digest('hex');
}

export function impactTokensMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createBaseModelRepository(database) {
  const baseModelProjection = `SELECT base.id, base.name, base.created_at, base.updated_at,
      (SELECT COUNT(*) FROM generation_models AS model WHERE model.base_model_id = base.id) AS model_count,
      (SELECT COUNT(*) FROM generation_loras AS lora WHERE lora.base_model_id = base.id) AS lora_count,
      (SELECT COUNT(*) FROM styles AS style WHERE style.base_model_id = base.id) AS style_count
    FROM generation_base_models AS base`;
  const statements = Object.freeze({
    list: database.prepare(`${baseModelProjection}
      WHERE lower(base.name) LIKE ? ESCAPE '\\'
      ORDER BY lower(base.name) COLLATE BINARY, base.id
      LIMIT ? OFFSET ?`),
    total: database.prepare(`SELECT COUNT(*) AS count
      FROM generation_base_models
      WHERE lower(name) LIKE ? ESCAPE '\\'`),
    get: database.prepare(`${baseModelProjection} WHERE base.id = ?`),
    insert: database.prepare(`INSERT INTO generation_base_models(name, created_at, updated_at)
      VALUES (?, ?, ?)`),
    update: database.prepare('UPDATE generation_base_models SET name = ?, updated_at = ? WHERE id = ?'),
    remove: database.prepare('DELETE FROM generation_base_models WHERE id = ?'),
    models: database.prepare('SELECT id, file_name FROM generation_models WHERE base_model_id = ? ORDER BY id'),
    loras: database.prepare('SELECT id, file_name FROM generation_loras WHERE base_model_id = ? ORDER BY id'),
    templates: database.prepare('SELECT id, title FROM comfyui_templates WHERE base_model_id = ? ORDER BY id'),
    artists: database.prepare('SELECT id, title FROM artist_prompt_strings WHERE base_model_id = ? ORDER BY id'),
    images: database.prepare(`SELECT id, owner_kind, owner_id, media_path
      FROM item_images
      WHERE (owner_kind = 'model' AND owner_id IN (SELECT id FROM generation_models WHERE base_model_id = ?))
         OR (owner_kind = 'lora' AND owner_id IN (SELECT id FROM generation_loras WHERE base_model_id = ?))
         OR (owner_kind = 'template' AND owner_id IN (SELECT id FROM comfyui_templates WHERE base_model_id = ?))
      ORDER BY owner_kind, owner_id, id`)
  });

  function getImpact(id) {
    const target = statements.get.get(id);
    if (!target) return null;
    const impact = {
      target: Object.freeze({ id: target.id, name: target.name }),
      cascade_deleted: Object.freeze([
        ...statements.models.all(id).map((row) => Object.freeze({ kind: 'model', ...modelProjection(row) })),
        ...statements.loras.all(id).map((row) => Object.freeze({ kind: 'lora', ...loraProjection(row) })),
        ...statements.templates.all(id).map((row) => Object.freeze({ kind: 'template', ...templateProjection(row) })),
        ...statements.images.all(id, id, id).map((row) => Object.freeze({ kind: 'image', ...imageProjection(row) }))
      ]),
      retained: Object.freeze(statements.artists.all(id).map((row) => Object.freeze({ kind: 'artist_prompt_string', ...artistProjection(row) })))
    };
    return Object.freeze({ ...impact, impact_token: createImpactToken(impact) });
  }

  return Object.freeze({
    list({ page, page_size: pageSize, q }) {
      const pattern = likePattern(q);
      return Object.freeze({
        items: Object.freeze(statements.list.all(pattern, pageSize, (page - 1) * pageSize).map((row) => Object.freeze(row))),
        page,
        page_size: pageSize,
        total_count: statements.total.get(pattern).count
      });
    },
    get: (id) => {
      const row = statements.get.get(id);
      return row ? Object.freeze(row) : null;
    },
    create({ name, timestamp }) {
      const result = statements.insert.run(name, timestamp, timestamp);
      return this.get(Number(result.lastInsertRowid));
    },
    update({ id, name, timestamp }) {
      statements.update.run(name, timestamp, id);
      return this.get(id);
    },
    getImpact,
    remove: (id) => statements.remove.run(id)
  });
}
