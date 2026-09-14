import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { seedDatabase } from '../fixtures/vector-schema-seed.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');

test('Vector schema fixture seed uses the converged vector schema', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'noobai-vector-schema-seed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, 'catalog.sqlite');
  const mediaRoot = join(root, 'media');
  await mkdir(mediaRoot, { recursive: true });
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot });
  const database = openCatalogDatabase({ databasePath, repositoryRoot, includeBuiltinComfyuiCatalog: false });
  try {
    seedDatabase(database);
    assert.deepEqual(database.prepare('PRAGMA table_info(vector_spaces)').all().map(({ name }) => name), [
      'object_kind', 'embedding_model', 'dimension'
    ]);
    assert.deepEqual(database.prepare('PRAGMA table_info(vector_entries)').all().map(({ name }) => name), [
      'object_kind', 'object_id', 'embedding_f32'
    ]);
    assert.deepEqual(database.prepare('SELECT object_kind, embedding_model, dimension FROM vector_spaces ORDER BY object_kind').all().map((row) => ({ ...row })), [
      { object_kind: 'artist_prompt_string', embedding_model: '__unconfigured__', dimension: 1 },
      { object_kind: 'character', embedding_model: 'vector-schema-fixture-embedding', dimension: 1024 },
      { object_kind: 'generation_lora', embedding_model: '__unconfigured__', dimension: 1 },
      { object_kind: 'prompt_term', embedding_model: 'vector-schema-fixture-embedding', dimension: 1024 },
      { object_kind: 'style', embedding_model: 'vector-schema-fixture-embedding', dimension: 1024 },
      { object_kind: 'work', embedding_model: 'vector-schema-fixture-embedding', dimension: 1024 }
    ]);
    const entries = database.prepare('SELECT object_kind, object_id, embedding_f32 FROM vector_entries ORDER BY object_kind, object_id').all();
    assert.equal(entries.length, 3);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'prompt_term'").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind IN ('generation_lora', 'artist_prompt_string')").get().count, 0);
    assert.deepEqual(entries.map(({ object_kind, object_id }) => ({ object_kind, object_id })), [
      { object_kind: 'character', object_id: 22012 },
      { object_kind: 'style', object_id: 22013 },
      { object_kind: 'work', object_id: 22011 }
    ]);
    assert.deepEqual(database.prepare('SELECT object_kind, object_id FROM vector_knn_index ORDER BY object_kind, object_id').all().map((row) => ({ ...row, object_id: Number(row.object_id) })), [
      { object_kind: 'character', object_id: 22012 },
      { object_kind: 'style', object_id: 22013 },
      { object_kind: 'work', object_id: 22011 }
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_knn_index').get().count, entries.length);
    for (const entry of entries) assert.equal(Buffer.from(entry.embedding_f32).byteLength, 1024 * Float32Array.BYTES_PER_ELEMENT);
  } finally {
    database.close();
  }
});
