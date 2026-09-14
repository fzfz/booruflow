import { createHash, timingSafeEqual } from 'node:crypto';

function likePattern(query) {
  return `%${query.replace(/[\\%_]/gu, '\\$&')}%`;
}

function instanceProjection(row) {
  return Object.freeze({
    id: row.id,
    title: row.title,
    url: row.url,
    credential_type: row.credential_type,
    is_enabled: row.is_enabled === 1,
    is_valid: row.is_valid === 1,
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function tokenFor(impact) {
  return createHash('sha256').update(JSON.stringify(impact), 'utf8').digest('hex');
}

export function comfyuiImpactTokensMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createComfyuiInstanceRepository(database) {
  const statements = Object.freeze({
    list: database.prepare(`SELECT id, title, url, credential_type, is_enabled, is_valid, created_at, updated_at
      FROM comfyui_instances WHERE (lower(title) LIKE ? ESCAPE '\\' OR lower(url) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR credential_type = ?)
        AND (? IS NULL OR is_valid = ?)
        AND (? IS NULL OR is_enabled = ?)
      ORDER BY lower(title) COLLATE BINARY, id LIMIT ? OFFSET ?`),
    total: database.prepare(`SELECT COUNT(*) AS count FROM comfyui_instances
      WHERE (lower(title) LIKE ? ESCAPE '\\' OR lower(url) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR credential_type = ?)
        AND (? IS NULL OR is_valid = ?)
        AND (? IS NULL OR is_enabled = ?)`),
    get: database.prepare('SELECT id, title, url, credential_type, is_enabled, is_valid, created_at, updated_at FROM comfyui_instances WHERE id = ?'),
    stored: database.prepare('SELECT id, title, url, credential_type, credential_ciphertext, is_enabled, is_valid, created_at, updated_at FROM comfyui_instances WHERE id = ?'),
    insert: database.prepare(`INSERT INTO comfyui_instances(title, url, credential_type, credential_ciphertext, is_enabled, is_valid, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    updateConnection: database.prepare(`UPDATE comfyui_instances
      SET title = ?, url = ?, credential_type = ?, credential_ciphertext = ?, is_enabled = ?, is_valid = ?, updated_at = ?
      WHERE id = ?`),
    updateState: database.prepare(`UPDATE comfyui_instances
      SET title = ?, is_enabled = ?, is_valid = ?, updated_at = ? WHERE id = ?`),
    validation: database.prepare('UPDATE comfyui_instances SET is_valid = ?, is_enabled = ?, updated_at = ? WHERE id = ?'),
    remove: database.prepare('DELETE FROM comfyui_instances WHERE id = ?')
  });

  return Object.freeze({
    list({ page, page_size: pageSize, q, credential_type: credentialType, is_valid: isValid, is_enabled: isEnabled }) {
      const pattern = likePattern(q);
      const filters = [credentialType ?? null, isValid === undefined ? null : Number(isValid), isEnabled === undefined ? null : Number(isEnabled)];
      const values = [pattern, pattern, ...filters.flatMap((filter) => [filter, filter])];
      return Object.freeze({
        items: Object.freeze(statements.list.all(...values, pageSize, (page - 1) * pageSize).map(instanceProjection)),
        page,
        page_size: pageSize,
        total_count: statements.total.get(...values).count
      });
    },
    get(id) {
      const row = statements.get.get(id);
      return row ? instanceProjection(row) : null;
    },
    getStored(id) {
      const row = statements.stored.get(id);
      return row ? Object.freeze(row) : null;
    },
    create({ title, url, credential_type: credentialType, credential_ciphertext: credentialCiphertext, timestamp }) {
      const result = statements.insert.run(title, url, credentialType, credentialCiphertext, 0, 0, timestamp, timestamp);
      return this.get(Number(result.lastInsertRowid));
    },
    update({ id, title, url, credential_type: credentialType, credential_ciphertext: credentialCiphertext, is_enabled: isEnabled, is_valid: isValid, connection_changed: connectionChanged, timestamp }) {
      if (connectionChanged) statements.updateConnection.run(title, url, credentialType, credentialCiphertext, isEnabled ? 1 : 0, isValid ? 1 : 0, timestamp, id);
      else statements.updateState.run(title, isEnabled ? 1 : 0, isValid ? 1 : 0, timestamp, id);
      return this.get(id);
    },
    setValidation({ id, is_valid: isValid, is_enabled: isEnabled, timestamp }) {
      statements.validation.run(isValid ? 1 : 0, isEnabled ? 1 : 0, timestamp, id);
      return this.get(id);
    },
    getImpact(id) {
      const target = this.get(id);
      if (!target) return null;
      const impact = Object.freeze({ target: Object.freeze({ id: target.id, name: target.title }), cascade_deleted: Object.freeze([]), retained: Object.freeze([]) });
      return Object.freeze({ ...impact, impact_token: tokenFor(impact) });
    },
    remove: (id) => statements.remove.run(id)
  });
}
