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

function freezeArtist(row, styleIds) {
  return Object.freeze({ ...row, style_ids: Object.freeze(styleIds) });
}

export function createArtistPromptStringRepository(database) {
  const projection = `artist.id, artist.title, artist.description, artist.artist_string, artist.base_model_id,
    base.name AS base_model_name, artist.cover_media_path, artist.created_at, artist.updated_at`;
  const statements = Object.freeze({
    list: database.prepare(`SELECT ${projection}
      FROM artist_prompt_strings AS artist
      LEFT JOIN generation_base_models AS base ON base.id = artist.base_model_id
      WHERE (lower(artist.title) LIKE ? ESCAPE '\\'
        OR lower(artist.artist_string) LIKE ? ESCAPE '\\'
        OR lower(artist.description) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR artist.base_model_id = ?)
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM artist_prompt_string_styles
          WHERE artist_prompt_string_id = artist.id AND style_id = ?
        ))
      ORDER BY lower(artist.title) COLLATE BINARY, artist.id
      LIMIT ? OFFSET ?`),
    total: database.prepare(`SELECT COUNT(*) AS count
      FROM artist_prompt_strings
      WHERE (lower(title) LIKE ? ESCAPE '\\'
        OR lower(artist_string) LIKE ? ESCAPE '\\'
        OR lower(description) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR base_model_id = ?)
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM artist_prompt_string_styles
          WHERE artist_prompt_string_id = artist_prompt_strings.id AND style_id = ?
        ))`),
    get: database.prepare(`SELECT ${projection} FROM artist_prompt_strings AS artist
      LEFT JOIN generation_base_models AS base ON base.id = artist.base_model_id
      WHERE artist.id = ?`),
    styleIds: database.prepare(`SELECT style_id FROM artist_prompt_string_styles
      WHERE artist_prompt_string_id = ? ORDER BY style_id`),
    baseModelExists: database.prepare('SELECT id FROM generation_base_models WHERE id = ?'),
    styleExists: database.prepare('SELECT id FROM styles WHERE id = ?'),
    insert: database.prepare(`INSERT INTO artist_prompt_strings(
      title, description, artist_string, base_model_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`),
    update: database.prepare(`UPDATE artist_prompt_strings SET
      title = ?, description = ?, artist_string = ?, base_model_id = ?, updated_at = ?
      WHERE id = ?`),
    remove: database.prepare('DELETE FROM artist_prompt_strings WHERE id = ?'),
    clearStyles: database.prepare('DELETE FROM artist_prompt_string_styles WHERE artist_prompt_string_id = ?'),
    addStyle: database.prepare(`INSERT INTO artist_prompt_string_styles(artist_prompt_string_id, style_id)
      VALUES (?, ?)`),
    retainedStyles: database.prepare(`SELECT styles.id, styles.name
      FROM artist_prompt_string_styles
      JOIN styles ON styles.id = artist_prompt_string_styles.style_id
      WHERE artist_prompt_string_id = ?
      ORDER BY styles.id`),
    images: database.prepare(`SELECT id, owner_kind, owner_id, media_path
      FROM item_images
      WHERE owner_kind = 'artist_prompt_string' AND owner_id = ?
      ORDER BY id`)
  });

  function get(id) {
    const row = statements.get.get(id);
    return row ? freezeArtist(row, statements.styleIds.all(id).map(({ style_id: styleId }) => styleId)) : null;
  }

  return Object.freeze({
    list({ page, page_size: pageSize, q, base_model_id: baseModelId, style_id: styleId }) {
      const pattern = likePattern(q);
      const search = [pattern, pattern, pattern];
      const baseFilter = baseModelId ?? null;
      const styleFilter = styleId ?? null;
      const rows = statements.list.all(...search, baseFilter, baseFilter, styleFilter, styleFilter, pageSize, (page - 1) * pageSize);
      return Object.freeze({
        items: Object.freeze(rows.map((row) => freezeArtist(row, statements.styleIds.all(row.id).map(({ style_id: artistStyleId }) => artistStyleId)))),
        page,
        page_size: pageSize,
        total_count: statements.total.get(...search, baseFilter, baseFilter, styleFilter, styleFilter).count
      });
    },
    get,
    baseModelExists: (id) => Boolean(statements.baseModelExists.get(id)),
    styleExists: (id) => Boolean(statements.styleExists.get(id)),
    create({ title, description, artist_string: artistString, base_model_id: baseModelId, timestamp }) {
      const result = statements.insert.run(title, description, artistString, baseModelId, timestamp, timestamp);
      return Number(result.lastInsertRowid);
    },
    update({ id, title, description, artist_string: artistString, base_model_id: baseModelId, timestamp }) {
      statements.update.run(title, description, artistString, baseModelId, timestamp, id);
    },
    replaceStyleIds(id, styleIds) {
      statements.clearStyles.run(id);
      for (const styleId of styleIds) statements.addStyle.run(id, styleId);
    },
    getImpact(id) {
      const artist = get(id);
      if (!artist) return null;
      const impact = {
        target: Object.freeze({ id: artist.id, name: artist.title }),
        cascade_deleted: Object.freeze(statements.images.all(id).map((row) => Object.freeze({ kind: 'image', ...row }))),
        retained: Object.freeze(statements.retainedStyles.all(id).map((row) => Object.freeze({ kind: 'style', id: row.id, name: row.name })))
      };
      return Object.freeze({ ...impact, impact_token: impactToken(impact) });
    },
    remove: (id) => statements.remove.run(id)
  });
}
