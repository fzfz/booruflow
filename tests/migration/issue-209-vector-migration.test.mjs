import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { CREATE_MEDIA_CUTOVER_PLAN_TABLE_SQL } from '../../app/database/media-cutover-contract.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const NOW = '2026-08-05T00:00:00Z';

function legacyDatabase() {
  const database = new DatabaseSync(':memory:');
  for (const version of [1, 2, 3, 4]) database.exec(readFileSync(resolve(ROOT, `schema/database/${String(version).padStart(3, '0')}-${['initial', 'management-media', 'media-path-foundation', 'work-cover-character-fallback'][version - 1]}.sql`), 'utf8'));
  database.exec(CREATE_MEDIA_CUTOVER_PLAN_TABLE_SQL);
  database.exec(readFileSync(resolve(ROOT, 'schema/database/005-media-cutover.sql'), 'utf8'));
  for (const version of [6, 7, 8, 9, 10, 11, 12, 13]) {
    const names = { 6: 'media-cutover-skipped-cleanup', 7: 'prompt-terms', 8: 'generation-resources', 9: 'vector-retrieval', 10: 'restore-media-cover-triggers', 11: 'style-description', 12: 'session-base-model', 13: 'session-turn-skills' };
    database.exec(readFileSync(resolve(ROOT, `schema/database/${String(version).padStart(3, '0')}-${names[version]}.sql`), 'utf8'));
  }
  return database;
}

test('014 preserves only active Work, Character and Prompt Term blobs, leaves Style entries empty, and keeps business rows unchanged', () => {
  const database = legacyDatabase();
  try {
    database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (1, 'W', 'w', '[]', 1, ?, ?)").run(NOW, NOW);
    database.prepare("INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (2, 1, 'C', 'c', '[]', 'cp', 1, ?, ?)").run(NOW, NOW);
    database.prepare("INSERT INTO styles(id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (3, 'S', 's', '[]', 'sp', 1, ?, ?)").run(NOW, NOW);
    database.prepare("INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at) VALUES (4, 'T', 0, 1, '[]', ?, ?)").run(NOW, NOW);
    const businessBefore = {
      works: database.prepare('SELECT id, name, aliases_json FROM works').all(),
      characters: database.prepare('SELECT id, name, prompt_text FROM characters').all(),
      styles: database.prepare('SELECT id, name, prompt_text FROM styles').all(),
      prompt_terms: database.prepare('SELECT id, canonical_tag, aliases_json FROM prompt_terms').all()
    };
    database.prepare(`INSERT INTO vector_spaces(object_kind, embedding_model, dimension, distance_metric, normalization, text_projection_version, chunking_version, status, created_at, activated_at)
      VALUES ('work', 'old-work', 2, 'cosine', 'l2', 'w', 'c', 'active', ?, ?),
             ('character', 'old-character', 2, 'cosine', 'l2', 'c', 'c', 'active', ?, ?),
             ('style', 'old-style', 2, 'cosine', 'l2', 's', 'c', 'active', ?, ?),
             ('prompt_term', 'old-prompt', 2, 'cosine', 'l2', 'p', 'c', 'active', ?, ?)`)
      .run(NOW, NOW, NOW, NOW, NOW, NOW, NOW, NOW);
    const blobs = { work: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), character: Buffer.from([8, 7, 6, 5, 4, 3, 2, 1]), style: Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]), prompt_term: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]) };
    database.prepare('INSERT INTO vector_entries(vector_space_id, object_id, chunk_ordinal, embedding_f32, created_at, updated_at) SELECT id, ?, 0, ?, ?, ? FROM vector_spaces WHERE object_kind = ?').run(1, blobs.work, NOW, NOW, 'work');
    database.prepare('INSERT INTO vector_entries(vector_space_id, object_id, chunk_ordinal, embedding_f32, created_at, updated_at) SELECT id, ?, 0, ?, ?, ? FROM vector_spaces WHERE object_kind = ?').run(2, blobs.character, NOW, NOW, 'character');
    database.prepare('INSERT INTO vector_entries(vector_space_id, object_id, chunk_ordinal, embedding_f32, created_at, updated_at) SELECT id, ?, 0, ?, ?, ? FROM vector_spaces WHERE object_kind = ?').run(3, blobs.style, NOW, NOW, 'style');
    database.prepare('INSERT INTO vector_entries(vector_space_id, object_id, chunk_ordinal, embedding_f32, created_at, updated_at) SELECT id, ?, 0, ?, ?, ? FROM vector_spaces WHERE object_kind = ?').run(4, blobs.prompt_term, NOW, NOW, 'prompt_term');
    database.exec(readFileSync(resolve(ROOT, 'schema/database/014-vector-convergence.sql'), 'utf8'));

    assert.deepEqual(database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all().map((row) => ({ ...row })), [
      { object_kind: 'character', embedding_model: 'old-character', dimension: 2 },
      { object_kind: 'prompt_term', embedding_model: 'old-prompt', dimension: 2 },
      { object_kind: 'style', embedding_model: 'old-style', dimension: 2 },
      { object_kind: 'work', embedding_model: 'old-work', dimension: 2 }
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 4);
    assert.deepEqual(database.prepare('SELECT object_kind, object_id FROM vector_entries ORDER BY object_kind').all().map((row) => ({ ...row })), [
      { object_kind: 'character', object_id: 2 },
      { object_kind: 'prompt_term', object_id: 4 },
      { object_kind: 'work', object_id: 1 }
    ]);
    for (const [kind, blob] of Object.entries(blobs)) {
      if (kind === 'style') continue;
      assert.deepEqual(Buffer.from(database.prepare('SELECT embedding_f32 FROM vector_entries WHERE object_kind = ?').get(kind).embedding_f32), blob);
    }
    assert.deepEqual({
      works: database.prepare('SELECT id, name, aliases_json FROM works').all(),
      characters: database.prepare('SELECT id, name, prompt_text FROM characters').all(),
      styles: database.prepare('SELECT id, name, prompt_text FROM styles').all(),
      prompt_terms: database.prepare('SELECT id, canonical_tag, aliases_json FROM prompt_terms').all()
    }, businessBefore);
  } finally { database.close(); }
});
