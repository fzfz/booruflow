import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';

const OBJECT_KINDS = ['artist_prompt_string', 'character', 'generation_lora', 'prompt_term', 'style', 'work'];

function columns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => ({
    name: row.name,
    type: row.type,
    notnull: row.notnull,
    pk: row.pk
  }));
}

test('Issue #209 fixes the vector schema to six configuration rows and composite object keys', () => {
  const database = openCatalogDatabase();
  try {
    assert.deepEqual(columns(database, 'vector_spaces').map(({ name, pk }) => ({ name, pk })), [
      { name: 'object_kind', pk: 1 },
      { name: 'embedding_model', pk: 0 },
      { name: 'dimension', pk: 0 }
    ]);
    assert.deepEqual(columns(database, 'vector_entries').map(({ name, pk }) => ({ name, pk })), [
      { name: 'object_kind', pk: 1 },
      { name: 'object_id', pk: 2 },
      { name: 'embedding_f32', pk: 0 }
    ]);
    assert.deepEqual(database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all().map((row) => ({ ...row })), [
      { object_kind: 'artist_prompt_string', embedding_model: '__unconfigured__', dimension: 1 },
      { object_kind: 'character', embedding_model: '__unconfigured__', dimension: 1 },
      { object_kind: 'generation_lora', embedding_model: '__unconfigured__', dimension: 1 },
      { object_kind: 'prompt_term', embedding_model: '__unconfigured__', dimension: 1 },
      { object_kind: 'style', embedding_model: '__unconfigured__', dimension: 1 },
      { object_kind: 'work', embedding_model: '__unconfigured__', dimension: 1 }
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vector_maintenance_tasks'").get(), undefined);
    assert.throws(() => database.prepare("INSERT INTO vector_spaces(object_kind, embedding_model, dimension) VALUES ('other', 'x', 2)").run(), /CHECK|UNIQUE/u);
    assert.throws(() => database.prepare("INSERT INTO vector_spaces(object_kind, embedding_model, dimension) VALUES ('work', 'x', 2)").run(), /UNIQUE/u);
    assert.throws(() => database.prepare("INSERT INTO vector_entries(object_kind, object_id, embedding_f32) VALUES ('other', 1, X'00000000')").run(), /FOREIGN KEY|CHECK/u);
  } finally {
    database.close();
  }
});
