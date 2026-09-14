import { randomUUID } from 'node:crypto';

import { ApplicationError } from '../security/error-mapping.mjs';
import { normalizeCatalogText, normalizeSearchText } from '../security/input-validation.mjs';

const KIND_ORDER = Object.freeze({ work: 0, character: 1, style: 2 });
const MANAGE_CURSOR_LIMIT = 1024;
const CATALOG_NAME_KEY_FUNCTION = 'catalog_name_key';

function likePattern(query) {
  return `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
}

function stableSortKey(rank, kind, normalizedName, id) {
  const nameKey = Array.from({ length: normalizedName.length }, (_, index) => normalizedName.charCodeAt(index).toString(16).padStart(4, '0')).join('');
  return `${rank}:${String(KIND_ORDER[kind]).padStart(2, '0')}:${nameKey}0000:${String(id).padStart(20, '0')}`;
}

function aliases(row) {
  try { return JSON.parse(row.aliases_json ?? '[]'); } catch { return []; }
}

function publicWork(row, meta = {}) {
  return { id: row.id, name: row.name, aliases: aliases(row), prompt_text: null, work_id: null, work_name: null, character_ids: meta.character_ids ?? [], image_count: meta.image_count ?? 0, cover_media_path: row.cover_media_path ?? null, is_available: Boolean(row.is_available) };
}

function publicCharacter(row, meta = {}) {
  return { id: row.id, work_id: row.work_id, work_name: row.work_name ?? null, name: row.name, aliases: aliases(row), prompt_text: row.prompt_text, character_ids: [], image_count: meta.image_count ?? 0, cover_media_path: row.cover_media_path ?? null, is_available: Boolean(row.is_available) };
}

function publicStyle(row, meta = {}) {
  return { id: row.id, name: row.name, aliases: aliases(row), prompt_text: row.prompt_text, style_description: row.style_description ?? null, work_id: null, work_name: null, character_ids: [], image_count: meta.image_count ?? 0, cover_media_path: row.cover_media_path ?? null, is_available: true };
}

function matches(row, normalizedQuery, allowPrompt) {
  const normalizedName = row.name_normalized;
  if (normalizedName === normalizedQuery) return { field: 'name', rank: 1 };
  if (normalizedName.startsWith(normalizedQuery)) return { field: 'name', rank: 2 };
  if (normalizedName.includes(normalizedQuery)) return { field: 'name', rank: 3 };
  const aliases = JSON.parse(row.aliases_json).map(normalizeSearchText);
  if (aliases.some((alias) => alias.includes(normalizedQuery))) return { field: 'alias', rank: 3 };
  if (allowPrompt && normalizeSearchText(row.prompt_text).includes(normalizedQuery)) return { field: 'prompt', rank: 4 };
  return null;
}

function compareCandidates(left, right) {
  return left.relevance_rank - right.relevance_rank
    || KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    || (left._normalized_name < right._normalized_name ? -1 : left._normalized_name > right._normalized_name ? 1 : 0)
    || left.id - right.id;
}

export function createCatalogRepository(database) {
  if (!database || typeof database.function !== 'function') {
    throw new TypeError('catalog database must support deterministic SQL functions');
  }
  database.function(CATALOG_NAME_KEY_FUNCTION, { deterministic: true }, normalizeCatalogText);
  const publicCursors = new Map();
  const statements = Object.freeze({
    allWorks: database.prepare(`SELECT w.id, w.name, w.name_normalized, w.aliases_json, w.cover_media_path, w.is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'work' AND i.owner_id = w.id) AS image_count
      FROM works w ORDER BY w.name_normalized COLLATE BINARY, w.id`),
    workById: database.prepare(`SELECT w.id, w.name, w.name_normalized, w.aliases_json, w.cover_media_path, w.is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'work' AND i.owner_id = w.id) AS image_count
      FROM works w WHERE w.id = ?`),
    allCharacters: database.prepare(`SELECT c.id, c.work_id, w.name AS work_name, c.name, c.name_normalized, c.aliases_json, c.prompt_text, c.cover_media_path, c.is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'character' AND i.owner_id = c.id) AS image_count
      FROM characters c JOIN works w ON w.id = c.work_id ORDER BY c.name_normalized COLLATE BINARY, c.id`),
    charactersByWork: database.prepare(`SELECT c.id, c.work_id, w.name AS work_name, c.name, c.name_normalized, c.aliases_json, c.prompt_text, c.cover_media_path, c.is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'character' AND i.owner_id = c.id) AS image_count
      FROM characters c JOIN works w ON w.id = c.work_id WHERE c.work_id = ? ORDER BY c.name_normalized COLLATE BINARY, c.id`),
    characterById: database.prepare(`SELECT c.id, c.work_id, w.name AS work_name, c.name, c.name_normalized, c.aliases_json, c.prompt_text, c.cover_media_path, c.is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'character' AND i.owner_id = c.id) AS image_count
      FROM characters c JOIN works w ON w.id = c.work_id WHERE c.id = ?`),
    allStyles: database.prepare(`SELECT s.id, s.base_model_id, s.name, s.aliases_json, s.prompt_text, s.style_description, s.cover_media_path,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'style' AND i.owner_id = s.id) AS image_count
      FROM styles s ORDER BY lower(s.name) COLLATE BINARY, s.id`),
    styleById: database.prepare(`SELECT s.id, s.base_model_id, s.name, s.aliases_json, s.prompt_text, s.style_description, s.cover_media_path,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'style' AND i.owner_id = s.id) AS image_count
      FROM styles s WHERE s.id = ?`),
    imageById: database.prepare('SELECT id, owner_kind, owner_id, media_path FROM item_images WHERE id = ?'),
    imagesByOwner: database.prepare('SELECT id, owner_kind, owner_id, media_path, sort_order FROM item_images WHERE owner_kind = ? AND owner_id = ? ORDER BY sort_order, id'),
    manageDetailWork: database.prepare(`SELECT 'work' AS kind, w.id, w.name, NULL AS work_id, NULL AS work_name, w.aliases_json, NULL AS prompt_text,
      NULL AS style_description, w.category_name, NULL AS base_model_id, NULL AS base_model_name, w.cover_media_path, w.is_available, w.created_at, w.updated_at,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'work' AND i.owner_id = w.id) AS image_count
      FROM works w WHERE w.id = ?`),
    manageDetailCharacter: database.prepare(`SELECT 'character' AS kind, c.id, c.name, c.work_id, w.name AS work_name, c.aliases_json, c.prompt_text,
      NULL AS style_description, NULL AS category_name, NULL AS base_model_id, NULL AS base_model_name, c.cover_media_path, c.is_available, c.created_at, c.updated_at,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'character' AND i.owner_id = c.id) AS image_count
      FROM characters c JOIN works w ON w.id = c.work_id WHERE c.id = ?`),
    manageDetailStyle: database.prepare(`SELECT 'style' AS kind, s.id, s.name, NULL AS work_id, NULL AS work_name, s.aliases_json, s.prompt_text,
      s.style_description, NULL AS category_name, s.base_model_id, base.name AS base_model_name, s.cover_media_path, NULL AS is_available, NULL AS created_at, NULL AS updated_at,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'style' AND i.owner_id = s.id) AS image_count
      FROM styles s JOIN generation_base_models base ON base.id = s.base_model_id WHERE s.id = ?`),
    characterIdsByWork: database.prepare('SELECT id FROM characters WHERE work_id = ? AND is_available = 1 ORDER BY name_normalized COLLATE BINARY, id')
  });

  const manageSelect = Object.freeze({
    work: `SELECT 0 AS kind_order, 'work' AS kind, w.id, w.name, w.name_normalized AS cursor_key, NULL AS work_name,
      w.aliases_json, NULL AS prompt_text, NULL AS style_description, w.category_name, NULL AS base_model_id, NULL AS base_model_name, w.cover_media_path, w.is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'work' AND i.owner_id = w.id) AS image_count
      FROM works w`,
    character: `SELECT 1 AS kind_order, 'character' AS kind, c.id, c.name, c.name_normalized AS cursor_key, w.name AS work_name,
      c.aliases_json, c.prompt_text, NULL AS style_description, NULL AS category_name, NULL AS base_model_id, NULL AS base_model_name, c.cover_media_path, c.is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'character' AND i.owner_id = c.id) AS image_count
      FROM characters c JOIN works w ON w.id = c.work_id`,
    style: `SELECT 2 AS kind_order, 'style' AS kind, s.id, s.name, ${CATALOG_NAME_KEY_FUNCTION}(s.name) AS cursor_key, NULL AS work_name,
      s.aliases_json, s.prompt_text, s.style_description, NULL AS category_name, s.base_model_id, base.name AS base_model_name, s.cover_media_path, NULL AS is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'style' AND i.owner_id = s.id) AS image_count
      FROM styles s JOIN generation_base_models base ON base.id = s.base_model_id`
  });

  const publicSelect = Object.freeze({
    work: `SELECT w.id, w.name, w.name_normalized AS cursor_key, w.aliases_json, NULL AS prompt_text, NULL AS style_description, NULL AS work_id, NULL AS work_name,
      w.cover_media_path, w.is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'work' AND i.owner_id = w.id) AS image_count
      FROM works w`,
    character: `SELECT c.id, c.name, c.name_normalized AS cursor_key, c.aliases_json, c.prompt_text, NULL AS style_description, c.work_id, w.name AS work_name,
      c.cover_media_path, c.is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'character' AND i.owner_id = c.id) AS image_count
      FROM characters c JOIN works w ON w.id = c.work_id WHERE w.is_available = 1`,
    style: `SELECT s.id, s.name, ${CATALOG_NAME_KEY_FUNCTION}(s.name) AS cursor_key, s.aliases_json, s.prompt_text, s.style_description, NULL AS work_id, NULL AS work_name,
      s.cover_media_path, NULL AS is_available,
      (SELECT COUNT(*) FROM item_images i WHERE i.owner_kind = 'style' AND i.owner_id = s.id) AS image_count
      FROM styles s`
  });

  function publicCursor(state) {
    const token = randomUUID();
    publicCursors.set(token, Object.freeze(state));
    while (publicCursors.size > MANAGE_CURSOR_LIMIT) publicCursors.delete(publicCursors.keys().next().value);
    return token;
  }

  function manageRows({ kind, query, page, limit, baseModelId, availability }) {
    const sources = kind === 'all' ? Object.values(manageSelect) : [manageSelect[kind]];
    const union = sources.join(' UNION ALL ');
    const sql = `SELECT * FROM (${union}) AS catalog_items
      WHERE (? = '' OR catalog_items.cursor_key LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM json_each(catalog_items.aliases_json) AS alias WHERE ${CATALOG_NAME_KEY_FUNCTION}(alias.value) LIKE ? ESCAPE '\\')
        OR ${CATALOG_NAME_KEY_FUNCTION}(COALESCE(catalog_items.prompt_text, '')) LIKE ? ESCAPE '\\'
        OR ${CATALOG_NAME_KEY_FUNCTION}(COALESCE(catalog_items.work_name, '')) LIKE ? ESCAPE '\\'
        OR ${CATALOG_NAME_KEY_FUNCTION}(COALESCE(catalog_items.style_description, '')) LIKE ? ESCAPE '\\')
      AND (? IS NULL OR catalog_items.base_model_id = ?)
      AND (? IS NULL OR COALESCE(catalog_items.is_available, TRUE) = ?)
      ORDER BY catalog_items.cursor_key COLLATE BINARY, catalog_items.kind_order, catalog_items.id
      LIMIT ? OFFSET ?`;
    const pattern = likePattern(query);
    return database.prepare(sql).all(query, pattern, pattern, pattern, pattern, pattern, baseModelId, baseModelId, availability, availability, limit, (page - 1) * limit);
  }

  function manageTotal({ kind, query, baseModelId, availability }) {
    const sources = kind === 'all' ? Object.values(manageSelect) : [manageSelect[kind]];
    const union = sources.join(' UNION ALL ');
    const sql = `SELECT COUNT(*) AS count FROM (${union}) AS catalog_items
      WHERE (? = '' OR catalog_items.cursor_key LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM json_each(catalog_items.aliases_json) AS alias WHERE ${CATALOG_NAME_KEY_FUNCTION}(alias.value) LIKE ? ESCAPE '\\')
        OR ${CATALOG_NAME_KEY_FUNCTION}(COALESCE(catalog_items.prompt_text, '')) LIKE ? ESCAPE '\\'
        OR ${CATALOG_NAME_KEY_FUNCTION}(COALESCE(catalog_items.work_name, '')) LIKE ? ESCAPE '\\'
        OR ${CATALOG_NAME_KEY_FUNCTION}(COALESCE(catalog_items.style_description, '')) LIKE ? ESCAPE '\\')
      AND (? IS NULL OR catalog_items.base_model_id = ?)
      AND (? IS NULL OR COALESCE(catalog_items.is_available, TRUE) = ?)`;
    const pattern = likePattern(query);
    return database.prepare(sql).get(query, pattern, pattern, pattern, pattern, pattern, baseModelId, baseModelId, availability, availability).count;
  }

  function publicRows({ kind, query, workId, cursor, limit }) {
    const source = publicSelect[kind];
    const ownerClause = kind === 'character' && workId !== null ? 'WHERE catalog_items.work_id = ?' : 'WHERE 1 = 1';
    const availabilityClause = kind === 'style' ? '' : 'AND catalog_items.is_available = 1';
    const sql = `SELECT * FROM (${source}) AS catalog_items
      ${ownerClause}
      ${availabilityClause}
      AND (? = '' OR catalog_items.cursor_key LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM json_each(catalog_items.aliases_json) AS alias WHERE ${CATALOG_NAME_KEY_FUNCTION}(alias.value) LIKE ? ESCAPE '\\')
        OR ${CATALOG_NAME_KEY_FUNCTION}(COALESCE(catalog_items.prompt_text, '')) LIKE ? ESCAPE '\\')
      AND (? IS NULL OR catalog_items.cursor_key > ?
        OR (catalog_items.cursor_key = ? AND catalog_items.id > ?))
      ORDER BY catalog_items.cursor_key COLLATE BINARY, catalog_items.id
      LIMIT ?`;
    const pattern = likePattern(query);
    const after = cursor === null ? [null, null, null, null] : [cursor.key, cursor.key, cursor.key, cursor.id];
    const values = [
      ...(kind === 'character' && workId !== null ? [workId] : []),
      query, pattern, pattern, pattern, ...after, limit + 1
    ];
    return database.prepare(sql).all(...values);
  }

  function mapPublicItem(kind, row) {
    if (kind === 'work') return publicWork(row, { image_count: row.image_count });
    if (kind === 'character') return publicCharacter(row, { image_count: row.image_count });
    return publicStyle(row, { image_count: row.image_count });
  }

  function mapManageItem(row) {
    return {
      kind: row.kind,
      id: row.id,
      name: row.name,
      ...(Object.hasOwn(row, 'work_id') ? { work_id: row.work_id ?? null } : {}),
      work_name: row.work_name ?? null,
      aliases: aliases(row),
      prompt_text: row.prompt_text ?? null,
      style_description: row.style_description ?? null,
      category_name: row.category_name ?? null,
      base_model_id: row.base_model_id ?? null,
      base_model_name: row.base_model_name ?? null,
      cover_media_path: row.cover_media_path ?? null,
      image_count: row.image_count,
      is_available: row.kind === 'style' ? true : Boolean(row.is_available)
    };
  }

  function writeProjection(kind, row) {
    if (!row) return null;
    return Object.freeze({
      kind,
      id: row.id,
      ...(kind === 'character' ? { work_id: row.work_id, work_name: row.work_name } : {}),
      ...(kind === 'style' ? { base_model_id: row.base_model_id, base_model_name: row.base_model_name } : {}),
      name: row.name,
      aliases_json: Object.freeze(aliases(row)),
      ...(kind === 'work' ? { category_name: row.category_name ?? null, is_available: Boolean(row.is_available) } : {}),
      ...(kind === 'character' ? { prompt_text: row.prompt_text, is_available: Boolean(row.is_available) } : {}),
      ...(kind === 'style' ? { prompt_text: row.prompt_text, style_description: row.style_description ?? null } : {}),
      cover_media_path: row.cover_media_path ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null
    });
  }

  function getManageWriteItem(kind, id) {
    const table = kind === 'work' ? 'works' : kind === 'character' ? 'characters' : 'styles';
    const relation = kind === 'character'
      ? ' JOIN works w ON w.id = source.work_id'
      : kind === 'style' ? ' JOIN generation_base_models base ON base.id = source.base_model_id' : '';
    const relationProjection = kind === 'character'
      ? ', source.work_id, w.name AS work_name'
      : kind === 'style' ? ', base.name AS base_model_name' : '';
    const row = database.prepare(`SELECT source.*${relationProjection} FROM ${table} source${relation} WHERE source.id = ?`).get(id);
    return writeProjection(kind, row);
  }

  function createManageWriteItem(kind, input, timestamp) {
    let result;
    if (kind === 'work') {
      result = database.prepare(`INSERT INTO works(source_id, source_url, source_version, source_updated_at, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at)
        VALUES (NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(input.name, normalizeSearchText(input.name), JSON.stringify(input.aliases_json), input.category_name, Number(input.is_available), timestamp, timestamp);
    } else if (kind === 'character') {
      result = database.prepare(`INSERT INTO characters(work_id, source_id, source_url, source_version, source_updated_at, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
        VALUES (?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`).run(input.work_id, input.name, normalizeSearchText(input.name), JSON.stringify(input.aliases_json), input.prompt_text, Number(input.is_available), timestamp, timestamp);
    } else {
      result = database.prepare(`INSERT INTO styles(base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path)
        VALUES (?, ?, ?, ?, ?, NULL)`).run(input.base_model_id, input.name, JSON.stringify(input.aliases_json), input.prompt_text, input.style_description);
    }
    return getManageWriteItem(kind, Number(result.lastInsertRowid));
  }

  function updateManageWriteItem(kind, id, input, timestamp) {
    if (kind === 'work') {
      database.prepare(`UPDATE works SET name = ?, name_normalized = ?, aliases_json = ?, category_name = ?, is_available = ?, updated_at = ? WHERE id = ?`)
        .run(input.name, normalizeSearchText(input.name), JSON.stringify(input.aliases_json), input.category_name, Number(input.is_available), timestamp, id);
    } else if (kind === 'character') {
      database.prepare(`UPDATE characters SET work_id = ?, name = ?, name_normalized = ?, aliases_json = ?, prompt_text = ?, is_available = ?, updated_at = ? WHERE id = ?`)
        .run(input.work_id, input.name, normalizeSearchText(input.name), JSON.stringify(input.aliases_json), input.prompt_text, Number(input.is_available), timestamp, id);
    } else {
      database.prepare(`UPDATE styles SET base_model_id = ?, name = ?, aliases_json = ?, prompt_text = ?, style_description = ? WHERE id = ?`)
        .run(input.base_model_id, input.name, JSON.stringify(input.aliases_json), input.prompt_text, input.style_description, id);
    }
    return getManageWriteItem(kind, id);
  }

  function manageDetailRow(kind, id) {
    return (kind === 'work' ? statements.manageDetailWork : kind === 'character' ? statements.manageDetailCharacter : statements.manageDetailStyle).get(id);
  }

  function listCatalogBaseModels({ query, page, page_size: pageSize }) {
    const where = query === '' ? '' : "WHERE lower(name) LIKE ? ESCAPE '\\'";
    const pattern = query === '' ? undefined : likePattern(query);
    const order = query === '' ? 'id DESC' : 'name COLLATE BINARY ASC, id ASC';
    const pageRows = database.prepare(`SELECT id, name
      FROM generation_base_models
      ${where}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`).all(...(pattern === undefined ? [] : [pattern]), pageSize, (page - 1) * pageSize);
    const total = database.prepare(`SELECT COUNT(*) AS count
      FROM generation_base_models
      ${where}`).get(...(pattern === undefined ? [] : [pattern])).count;
    return Object.freeze({ rows: Object.freeze(pageRows.map((row) => Object.freeze(row))), total_count: total });
  }

  function getCatalogBaseModel(id) {
    return database.prepare('SELECT id, name FROM generation_base_models WHERE id = ?').get(id) ?? null;
  }

  function listCatalogWorks({ page, page_size: pageSize }) {
    const rows = database.prepare(`SELECT id, name, aliases_json, category_name, cover_media_path, is_available
      FROM works
      WHERE is_available = 1
      ORDER BY id DESC
      LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize);
    const total = database.prepare('SELECT COUNT(*) AS count FROM works WHERE is_available = 1').get().count;
    return Object.freeze({
      rows: Object.freeze(rows.map((row) => Object.freeze(row))),
      total_count: total
    });
  }

  function getCatalogWork(id) {
    return database.prepare(`SELECT id, name, aliases_json, category_name, cover_media_path, is_available
      FROM works WHERE id = ?`).get(id) ?? null;
  }

  function listCatalogCharacters({ page, page_size: pageSize, work_id: workId = null }) {
    const relation = workId === null || workId === undefined ? '' : ' AND c.work_id = ?';
    const values = workId === null || workId === undefined ? [] : [workId];
    const projection = `c.id, c.work_id, w.name AS "works.name", c.name, c.aliases_json, c.prompt_text,
      c.cover_media_path, c.is_available, w.is_available AS work_is_available`;
    const rows = database.prepare(`SELECT ${projection}
      FROM characters c
      JOIN works w ON w.id = c.work_id
      WHERE c.is_available = 1 AND w.is_available = 1${relation}
      ORDER BY c.id DESC
      LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
    const total = database.prepare(`SELECT COUNT(*) AS count
      FROM characters c
      JOIN works w ON w.id = c.work_id
      WHERE c.is_available = 1 AND w.is_available = 1${relation}`).get(...values).count;
    return Object.freeze({
      rows: Object.freeze(rows.map((row) => Object.freeze(row))),
      total_count: total
    });
  }

  function getCatalogCharacter(id) {
    return database.prepare(`SELECT c.id, c.work_id, w.name AS "works.name", c.name, c.aliases_json, c.prompt_text,
      c.cover_media_path, c.is_available, w.is_available AS work_is_available
      FROM characters c
      JOIN works w ON w.id = c.work_id
      WHERE c.id = ?`).get(id) ?? null;
  }

  function listCatalogStyles({ page, page_size: pageSize, base_model_id: baseModelId = null }) {
    const relation = baseModelId === null || baseModelId === undefined ? '' : ' WHERE base_model_id = ?';
    const values = baseModelId === null || baseModelId === undefined ? [] : [baseModelId];
    const projection = 'id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path';
    const rows = database.prepare(`SELECT ${projection}
      FROM styles${relation}
      ORDER BY id DESC
      LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
    const total = database.prepare(`SELECT COUNT(*) AS count
      FROM styles${relation}`).get(...values).count;
    return Object.freeze({
      rows: Object.freeze(rows.map((row) => Object.freeze(row))),
      total_count: total
    });
  }

  function getCatalogStyle(id) {
    return database.prepare('SELECT id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path FROM styles WHERE id = ?').get(id) ?? null;
  }

  function listCatalogPromptTerms({ page, page_size: pageSize }) {
    const rows = database.prepare(`SELECT id, canonical_tag, aliases_json, category, post_count
      FROM prompt_terms
      ORDER BY id DESC
      LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize);
    const total = database.prepare('SELECT COUNT(*) AS count FROM prompt_terms').get().count;
    return Object.freeze({
      rows: Object.freeze(rows.map((row) => Object.freeze(row))),
      total_count: total
    });
  }

  function getCatalogPromptTerm(id) {
    return database.prepare('SELECT id, canonical_tag, aliases_json, category, post_count FROM prompt_terms WHERE id = ?').get(id) ?? null;
  }

  function withArtistPromptStringStyleIds(rows) {
    if (rows.length === 0) return rows;
    const placeholders = rows.map(() => '?').join(', ');
    const styleRows = database.prepare(`SELECT artist_prompt_string_id, style_id
      FROM artist_prompt_string_styles
      WHERE artist_prompt_string_id IN (${placeholders})
      ORDER BY artist_prompt_string_id, style_id`).all(...rows.map(({ id }) => id));
    const stylesByArtist = new Map();
    for (const styleRow of styleRows) {
      const styles = stylesByArtist.get(styleRow.artist_prompt_string_id) ?? [];
      styles.push(styleRow.style_id);
      stylesByArtist.set(styleRow.artist_prompt_string_id, styles);
    }
    return rows.map((row) => Object.freeze({
      ...row,
      style_ids: Object.freeze(stylesByArtist.get(row.id) ?? [])
    }));
  }

  function listCatalogArtistPromptStrings({ page, page_size: pageSize, base_model_id: baseModelId = null }) {
    const relation = baseModelId === null || baseModelId === undefined ? '' : ' WHERE base_model_id = ?';
    const values = baseModelId === null || baseModelId === undefined ? [] : [baseModelId];
    const rows = database.prepare(`SELECT id, title, description, artist_string, base_model_id, cover_media_path
      FROM artist_prompt_strings${relation}
      ORDER BY id DESC
      LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
    const total = database.prepare(`SELECT COUNT(*) AS count
      FROM artist_prompt_strings${relation}`).get(...values).count;
    return Object.freeze({
      rows: Object.freeze(withArtistPromptStringStyleIds(rows)),
      total_count: total
    });
  }

  function getCatalogArtistPromptString(id) {
    const row = database.prepare('SELECT id, title, description, artist_string, base_model_id, cover_media_path FROM artist_prompt_strings WHERE id = ?').get(id);
    return row ? withArtistPromptStringStyleIds([row])[0] : null;
  }

  function listCatalogGenerationModels({ query, page, page_size: pageSize, base_model_id: baseModelId = null }) {
    const conditions = [];
    const values = [];
    if (query !== '') {
      conditions.push("lower(file_name) LIKE ? ESCAPE '\\'");
      values.push(likePattern(query));
    }
    if (baseModelId !== null && baseModelId !== undefined) {
      conditions.push('base_model_id = ?');
      values.push(baseModelId);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const order = query === '' ? 'id DESC' : 'file_name COLLATE BINARY ASC, id ASC';
    const projection = `id, base_model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, published_at, description, usage, skill_name, cover_media_path`;
    const rows = database.prepare(`SELECT ${projection}
      FROM generation_models
      ${where}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
    const total = database.prepare(`SELECT COUNT(*) AS count
      FROM generation_models
      ${where}`).get(...values).count;
    return Object.freeze({
      rows: Object.freeze(rows.map((row) => Object.freeze(row))),
      total_count: total
    });
  }

  function getCatalogGenerationModel(id) {
    return database.prepare(`SELECT id, base_model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, published_at, description, usage, skill_name, cover_media_path
      FROM generation_models WHERE id = ?`).get(id) ?? null;
  }

  function listCatalogLoras({ page, page_size: pageSize, base_model_id: baseModelId = null }) {
    const relation = baseModelId === null || baseModelId === undefined ? '' : ' WHERE base_model_id = ?';
    const values = baseModelId === null || baseModelId === undefined ? [] : [baseModelId];
    const projection = `id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      author, version, description, usage, trigger_words_json, weight, cover_media_path`;
    const rows = database.prepare(`SELECT ${projection}
      FROM generation_loras${relation}
      ORDER BY id DESC
      LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
    const total = database.prepare(`SELECT COUNT(*) AS count
      FROM generation_loras${relation}`).get(...values).count;
    return Object.freeze({
      rows: Object.freeze(rows.map((row) => Object.freeze(row))),
      total_count: total
    });
  }

  function getCatalogLora(id) {
    return database.prepare(`SELECT id, base_model_id, model_id, file_name, file_format, precision_or_quantization,
      author, version, description, usage, trigger_words_json, weight, cover_media_path
      FROM generation_loras WHERE id = ?`).get(id) ?? null;
  }

  function listCatalogComfyuiInstances({ query, page, page_size: pageSize }) {
    const where = query === '' ? '' : "WHERE lower(title) LIKE ? ESCAPE '\\'";
    const pattern = query === '' ? undefined : likePattern(query);
    const order = query === '' ? 'id DESC' : 'title COLLATE BINARY ASC, id ASC';
    const projection = 'id, title, is_enabled, is_valid';
    const rows = database.prepare(`SELECT ${projection}
      FROM comfyui_instances
      ${where}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`).all(...(pattern === undefined ? [] : [pattern]), pageSize, (page - 1) * pageSize);
    const total = database.prepare(`SELECT COUNT(*) AS count
      FROM comfyui_instances
      ${where}`).get(...(pattern === undefined ? [] : [pattern])).count;
    return Object.freeze({
      rows: Object.freeze(rows.map((row) => Object.freeze(row))),
      total_count: total
    });
  }

  function getCatalogComfyuiInstance(id) {
    return database.prepare('SELECT id, title, is_enabled, is_valid FROM comfyui_instances WHERE id = ?').get(id) ?? null;
  }

  const comfyuiTemplateCatalogProjection = `t.id, t.base_model_id, t.model_id, t.lora_id, t.template_type, t.title,
    t.cover_media_path, t.template_json AS workflow_json`;

  function listCatalogComfyuiTemplates({ query, page, page_size: pageSize, base_model_id: baseModelId = null }) {
    const conditions = ["lower(t.title) LIKE ? ESCAPE '\\'"];
    const values = [likePattern(query)];
    if (baseModelId !== null) {
      conditions.push('t.base_model_id = ?');
      values.push(baseModelId);
    }
    const where = conditions.join(' AND ');
    const order = query === '' ? 't.id DESC' : 't.title COLLATE BINARY ASC, t.id ASC';
    const rows = database.prepare(`SELECT ${comfyuiTemplateCatalogProjection}
      FROM comfyui_templates t
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
    const total = database.prepare(`SELECT COUNT(*) AS count
      FROM comfyui_templates t
      WHERE ${where}`).get(...values).count;
    return Object.freeze({
      rows: Object.freeze(rows.map((row) => Object.freeze(row))),
      total_count: total
    });
  }

  function getCatalogComfyuiTemplate(id) {
    return database.prepare(`SELECT ${comfyuiTemplateCatalogProjection}
      FROM comfyui_templates t
      WHERE t.id = ?`).get(id) ?? null;
  }

  function listCatalogImagesByOwners(ownerKind, ownerIds) {
    if (!Array.isArray(ownerIds)) throw new TypeError('Catalog image owner IDs must be an array');
    const uniqueOwnerIds = [...new Set(ownerIds)];
    if (uniqueOwnerIds.length === 0) return Object.freeze([]);
    const placeholders = uniqueOwnerIds.map(() => '?').join(', ');
    const rows = database.prepare(`SELECT id, owner_kind, owner_id, media_path, sort_order
      FROM item_images
      WHERE owner_kind = ? AND owner_id IN (${placeholders})
      ORDER BY owner_id, sort_order, id`).all(ownerKind, ...uniqueOwnerIds);
    return Object.freeze(rows.map((row) => Object.freeze(row)));
  }

  function workMeta(row) {
    return { character_ids: statements.characterIdsByWork.all(row.id).map((character) => character.id), image_count: row.image_count };
  }

  const searches = Object.freeze({
    works: database.prepare(`SELECT id, name, name_normalized, aliases_json, is_available FROM works
      WHERE name_normalized LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM json_each(aliases_json) AS alias WHERE lower(alias.value) LIKE ? ESCAPE '\\')`),
    characters: database.prepare(`SELECT c.id, c.work_id, c.name, c.name_normalized, c.aliases_json, c.prompt_text, c.is_available,
      w.name AS work_name, w.is_available AS work_is_available
      FROM characters c JOIN works w ON w.id = c.work_id
      WHERE c.name_normalized LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM json_each(c.aliases_json) AS alias WHERE lower(alias.value) LIKE ? ESCAPE '\\')
      OR lower(c.prompt_text) LIKE ? ESCAPE '\\'`),
    styles: database.prepare(`SELECT id, name, aliases_json, prompt_text FROM styles
      WHERE ${CATALOG_NAME_KEY_FUNCTION}(name) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM json_each(aliases_json) AS alias WHERE ${CATALOG_NAME_KEY_FUNCTION}(alias.value) LIKE ? ESCAPE '\\')
      OR ${CATALOG_NAME_KEY_FUNCTION}(prompt_text) LIKE ? ESCAPE '\\'`)
  });

  function searchRows(query, availableOnly) {
    const candidates = [];
    const pattern = likePattern(query);
    for (const [kind, rows, allowPrompt] of [
      ['work', searches.works.all(pattern, pattern), false],
      ['character', searches.characters.all(pattern, pattern, pattern), true],
      ['style', searches.styles.all(pattern, pattern, pattern), true]
    ]) {
      for (const row of rows) {
        if (availableOnly && kind !== 'style' && !row.is_available) continue;
        if (kind === 'character' && availableOnly && !row.work_is_available) continue;
        const normalizedName = kind === 'style' ? normalizeSearchText(row.name) : row.name_normalized;
        const matchRow = { ...row, name_normalized: normalizedName };
        const match = matches(matchRow, query, allowPrompt);
        if (!match) continue;
        const candidate = {
          query,
          kind,
          id: row.id,
          name: row.name,
          prompt_text: kind === 'work' ? null : row.prompt_text,
          match_field: match.field,
          relevance_rank: match.rank,
          stable_sort_key: stableSortKey(match.rank, kind, normalizedName, row.id),
          _normalized_name: normalizedName
        };
        if (kind === 'character') {
          candidate.work_id = row.work_id;
          candidate.work_name = row.work_name;
        }
        candidates.push(candidate);
      }
    }
    return candidates.sort(compareCandidates).map(({ _normalized_name, ...candidate }) => candidate);
  }

  return Object.freeze({
    listWorks: () => statements.allWorks.all().map((row) => publicWork(row, workMeta(row))),
    getWork: (id) => {
      const row = statements.workById.get(id);
      return row ? publicWork(row, workMeta(row)) : null;
    },
    listCharacters: () => statements.allCharacters.all().map((row) => publicCharacter(row, { image_count: row.image_count })),
    getCharacter: (id) => {
      const row = statements.characterById.get(id);
      return row ? publicCharacter(row, { image_count: row.image_count }) : null;
    },
    listStyles: () => statements.allStyles.all().map((row) => publicStyle(row, { image_count: row.image_count })),
    getStyle: (id) => {
      const row = statements.styleById.get(id);
      return row ? publicStyle(row, { image_count: row.image_count }) : null;
    },
    listWorkCharacters: (workId) => statements.charactersByWork.all(workId).map((row) => publicCharacter(row, { image_count: row.image_count })),
    listPublicCatalog({ kind, query, workId, limit, cursor }) {
      const previous = cursor === null ? null : publicCursors.get(cursor);
      if (cursor !== null && (!previous || previous.kind !== kind || previous.query !== query || previous.workId !== workId)) {
        throw new ApplicationError('INVALID_CURSOR', 'home catalog cursor is invalid or does not match the query');
      }
      const rows = publicRows({ kind, query, workId, limit, cursor: previous });
      const page = rows.slice(0, limit).map((row) => mapPublicItem(kind, row));
      const last = rows.length > limit ? rows[limit - 1] : null;
      return Object.freeze({
        items: Object.freeze(page),
        next_cursor: last === null ? null : publicCursor({ kind, query, workId, key: last.cursor_key, id: last.id })
      });
    },
    searchPublic: (query) => searchRows(query, false),
    listManageItems({ kind, query, limit, page, baseModelId, availability }) {
      const rows = manageRows({ kind, query, page, limit, baseModelId, availability });
      return Object.freeze({
        items: Object.freeze(rows.map(mapManageItem)),
        total_count: manageTotal({ kind, query, baseModelId, availability }),
        page,
        page_size: limit
      });
    },
    getManageItemDetail(kind, id) {
      const row = manageDetailRow(kind, id);
      if (!row) return null;
      const characters = kind === 'work'
        ? database.prepare(`SELECT id, name, cover_media_path, is_available
          FROM characters WHERE work_id = ? ORDER BY name_normalized COLLATE BINARY, id`).all(id)
          .map((character) => Object.freeze({ id: character.id, name: character.name, cover_media_path: character.cover_media_path ?? null, is_available: Boolean(character.is_available) }))
        : null;
      return Object.freeze({
        ...mapManageItem(row),
        created_at: row.created_at ?? null,
        updated_at: row.updated_at ?? null,
        images: Object.freeze(statements.imagesByOwner.all(kind, id).map((image) => Object.freeze({ id: image.id, media_path: image.media_path, sort_order: image.sort_order }))),
        ...(characters === null ? {} : { characters: Object.freeze(characters) })
      });
    },
    getManageWriteItem,
    createManageWriteItem,
    updateManageWriteItem,
    workExists: (id) => database.prepare('SELECT 1 FROM works WHERE id = ?').get(id) !== undefined,
    baseModelExists: (id) => database.prepare('SELECT 1 FROM generation_base_models WHERE id = ?').get(id) !== undefined,
    availableCharactersForWork(workId, workName) {
      return Object.freeze(database.prepare(`SELECT id, work_id, name, aliases_json, prompt_text, ? AS work_name
        FROM characters WHERE work_id = ? AND is_available = 1 ORDER BY id`).all(workName, workId).map((row) => Object.freeze(row)));
    },
    listCatalogBaseModels,
    getCatalogBaseModel,
    listCatalogWorks,
    getCatalogWork,
    listCatalogCharacters,
    getCatalogCharacter,
    listCatalogStyles,
    getCatalogStyle,
    listCatalogPromptTerms,
    getCatalogPromptTerm,
    listCatalogArtistPromptStrings,
    getCatalogArtistPromptString,
    listCatalogGenerationModels,
    getCatalogGenerationModel,
    listCatalogLoras,
    getCatalogLora,
    listCatalogComfyuiInstances,
    getCatalogComfyuiInstance,
    listCatalogComfyuiTemplates,
    getCatalogComfyuiTemplate,
    listCatalogImagesByOwners
  });
}
