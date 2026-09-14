function likePattern(query) {
  return `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
}

function aliases(value) {
  const parsed = JSON.parse(value);
  return Object.freeze(parsed);
}

function projection(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    canonical_tag: row.canonical_tag,
    category: row.category,
    aliases_json: aliases(row.aliases_json),
    post_count: row.post_count,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

export function createPromptTermManagementRepository(database) {
  const listWhere = `(lower(prompt_terms.canonical_tag) LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM json_each(prompt_terms.aliases_json)
        WHERE lower(json_each.value) LIKE ? ESCAPE '\\'
      ))
    AND (? IS NULL OR prompt_terms.category = ?)
    AND (? IS NULL OR prompt_terms.post_count >= ?)
    AND (? IS NULL OR prompt_terms.post_count <= ?)`;
  const statements = Object.freeze({
    list: database.prepare(`SELECT id, canonical_tag, category, aliases_json, post_count, created_at, updated_at
      FROM prompt_terms
      WHERE ${listWhere}
      ORDER BY lower(canonical_tag) COLLATE BINARY, id
      LIMIT ? OFFSET ?`),
    total: database.prepare(`SELECT COUNT(*) AS count FROM prompt_terms WHERE ${listWhere}`),
    get: database.prepare('SELECT id, canonical_tag, category, aliases_json, post_count, created_at, updated_at FROM prompt_terms WHERE id = ?'),
    insert: database.prepare(`INSERT INTO prompt_terms(canonical_tag, category, aliases_json, post_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    update: database.prepare(`UPDATE prompt_terms
      SET canonical_tag = ?, category = ?, aliases_json = ?, post_count = ?, updated_at = ?
      WHERE id = ?`),
    remove: database.prepare('DELETE FROM prompt_terms WHERE id = ?')
  });

  function filterParameters({ q, category, post_count_min: postCountMin, post_count_max: postCountMax }) {
    const pattern = likePattern(q);
    return [pattern, pattern, category ?? null, category ?? null, postCountMin ?? null, postCountMin ?? null, postCountMax ?? null, postCountMax ?? null];
  }

  return Object.freeze({
    list(input) {
      const parameters = filterParameters(input);
      return Object.freeze({
        items: Object.freeze(statements.list.all(...parameters, input.page_size, (input.page - 1) * input.page_size).map(projection)),
        page: input.page,
        page_size: input.page_size,
        total_count: statements.total.get(...parameters).count
      });
    },
    get(id) {
      return projection(statements.get.get(id));
    },
    create({ canonical_tag: canonicalTag, category, aliases_json: aliasesJson, post_count: postCount, timestamp }) {
      const result = statements.insert.run(canonicalTag, category, JSON.stringify(aliasesJson), postCount, timestamp, timestamp);
      return this.get(Number(result.lastInsertRowid));
    },
    update({ id, canonical_tag: canonicalTag, category, aliases_json: aliasesJson, post_count: postCount, timestamp }) {
      statements.update.run(canonicalTag, category, JSON.stringify(aliasesJson), postCount, timestamp, id);
      return this.get(id);
    },
    remove(id) {
      return statements.remove.run(id);
    }
  });
}
