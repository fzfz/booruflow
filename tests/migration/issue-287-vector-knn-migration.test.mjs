import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

import {
  OfflineVectorKnnMigrationRequiredError,
  openCatalogDatabase
} from '../../app/catalog/database.mjs';
import {
  migrateVectorKnnIndex,
  VectorKnnMigrationError
} from '../../app/catalog/vector-knn-migration.mjs';
import { transactionStateOf } from '../../app/transaction-state.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const OBJECT_KINDS = Object.freeze([
  'work',
  'character',
  'style',
  'prompt_term',
  'generation_lora',
  'artist_prompt_string'
]);

function vector(seed) {
  const values = new Float32Array(1024);
  values[seed % values.length] = 1;
  return Buffer.from(values.buffer);
}

function makeRepositoryRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'issue-287-repository-'));
  mkdirSync(resolve(root, 'schema/database'), { recursive: true });
  copyFileSync(resolve(ROOT, 'schema/database/005-media-cutover.sql'), resolve(root, 'schema/database/005-media-cutover.sql'));
  copyFileSync(resolve(ROOT, 'schema/database/037-vector-knn-index.sql'), resolve(root, 'schema/database/037-vector-knn-index.sql'));
  return root;
}

function makeVersion36Database({ entries = [], spaces = null } = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'issue-287-knn-database-'));
  const path = resolve(directory, 'app.sqlite');
  const database = new DatabaseSync(path, { allowExtension: true });
  sqliteVec.load(database);
  database.exec(`
    PRAGMA user_version = 36;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(5, '005-media-cutover', '2026-08-23T00:00:00Z');
    INSERT INTO schema_migrations VALUES(36, '036-generation-resource-vectors', '2026-08-23T00:00:00Z');
    CREATE TABLE vector_spaces(object_kind TEXT PRIMARY KEY, embedding_model TEXT NOT NULL, dimension INTEGER NOT NULL);
    CREATE TABLE vector_entries(object_kind TEXT NOT NULL, object_id INTEGER NOT NULL, embedding_f32 BLOB NOT NULL, PRIMARY KEY(object_kind, object_id));
  `);
  const configuredSpaces = spaces ?? OBJECT_KINDS.map((objectKind) => [objectKind, objectKind === 'artist_prompt_string' ? '__unconfigured__' : 'issue-287-model', objectKind === 'artist_prompt_string' ? 1 : 1024]);
  const insertSpace = database.prepare('INSERT INTO vector_spaces(object_kind, embedding_model, dimension) VALUES(?, ?, ?)');
  for (const space of configuredSpaces) insertSpace.run(...space);
  const insertEntry = database.prepare('INSERT INTO vector_entries(object_kind, object_id, embedding_f32) VALUES(?, ?, ?)');
  for (const entry of entries) insertEntry.run(entry.object_kind, entry.object_id, entry.embedding_f32);
  database.close();
  return { directory, path };
}

function cleanup(...paths) {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

test('openCatalogDatabase loads sqlite-vec v0.1.9 and creates an empty KNN index', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    assert.equal(database.prepare('SELECT vec_version() AS version').get().version, 'v0.1.9');
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 40);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_knn_index").get().count, 0);
  } finally {
    database.close();
  }
});

test('ordinary startup creates an empty KNN index for an empty 036 database', () => {
  const fixture = makeVersion36Database();
  const repositoryRoot = makeRepositoryRoot();
  try {
    const database = openCatalogDatabase({ databasePath: fixture.path, repositoryRoot, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 37);
      assert.deepEqual(database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row })), [
        { version: 5, name: '005-media-cutover' },
        { version: 36, name: '036-generation-resource-vectors' },
        { version: 37, name: '037-vector-knn-index' }
      ]);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_knn_index').get().count, 0);
    } finally {
      database.close();
    }
  } finally {
    cleanup(fixture.directory, repositoryRoot);
  }
});

test('ordinary startup rejects a non-empty 036 database before writing', () => {
  const fixture = makeVersion36Database({ entries: [{ object_kind: 'work', object_id: 7, embedding_f32: vector(7) }] });
  const repositoryRoot = makeRepositoryRoot();
  try {
    assert.throws(
      () => openCatalogDatabase({ databasePath: fixture.path, repositoryRoot, includeBuiltinComfyuiCatalog: false }),
      (error) => error instanceof OfflineVectorKnnMigrationRequiredError
        && error.code === 'OFFLINE_VECTOR_KNN_MIGRATION_REQUIRED'
        && error.phase === 'preflight'
    );
    const unchanged = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 36);
      assert.equal(unchanged.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 37").get().count, 0);
      assert.equal(unchanged.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'vector_knn_index'").get().count, 0);
    } finally {
      unchanged.close();
    }
  } finally {
    cleanup(fixture.directory, repositoryRoot);
  }
});

test('ordinary startup checks a completed 037 database without loading every vector identity', () => {
  const fixture = makeVersion36Database({ entries: [{ object_kind: 'work', object_id: 7, embedding_f32: vector(7) }] });
  const repositoryRoot = makeRepositoryRoot();
  const initial = new DatabaseSync(fixture.path, { allowExtension: true });
  sqliteVec.load(initial);
  migrateVectorKnnIndex({ database: initial, repositoryRoot: ROOT });
  initial.close();
  const originalPrepare = DatabaseSync.prototype.prepare;
  let forbiddenQuerySeen = false;
  DatabaseSync.prototype.prepare = function prepare(sql, ...parameters) {
    if (/SELECT object_kind, object_id FROM vector_entries/u.test(String(sql))) {
      forbiddenQuerySeen = true;
      throw new Error('full vector identity scan is not allowed during ordinary startup');
    }
    return originalPrepare.call(this, sql, ...parameters);
  };
  try {
    const database = openCatalogDatabase({ databasePath: fixture.path, repositoryRoot, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 37);
    } finally {
      database.close();
    }
    assert.equal(forbiddenQuerySeen, false);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    cleanup(fixture.directory, repositoryRoot);
  }
});

test('ordinary startup skips registered migration 037 after later vector data changes', () => {
  const fixture = makeVersion36Database({ entries: [{ object_kind: 'work', object_id: 7, embedding_f32: vector(7) }] });
  const repositoryRoot = makeRepositoryRoot();
  try {
    const migrated = new DatabaseSync(fixture.path, { allowExtension: true });
    sqliteVec.load(migrated);
    migrateVectorKnnIndex({ database: migrated, repositoryRoot: ROOT });
    migrated.prepare('INSERT INTO vector_entries(object_kind, object_id, embedding_f32) VALUES (?, ?, ?)')
      .run('work', 8, vector(8));
    migrated.close();

    const reopened = openCatalogDatabase({ databasePath: fixture.path, repositoryRoot, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 37);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'work'").get().count, 2);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM vector_knn_index WHERE object_kind = 'work'").get().count, 1);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(fixture.directory, repositoryRoot);
  }
});

test('real application connection with trusted_schema OFF deletes vector_entries without a vec0-writing trigger', () => {
  const fixture = makeVersion36Database({ entries: [{ object_kind: 'work', object_id: 7, embedding_f32: vector(7) }] });
  const repositoryRoot = makeRepositoryRoot();
  try {
    const initial = new DatabaseSync(fixture.path, { allowExtension: true });
    sqliteVec.load(initial);
    migrateVectorKnnIndex({ database: initial, repositoryRoot: ROOT });
    initial.close();
    const database = openCatalogDatabase({ databasePath: fixture.path, repositoryRoot, includeBuiltinComfyuiCatalog: false });
    try {
      assert.equal(database.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);
      assert.doesNotThrow(() => database.prepare('DELETE FROM vector_entries WHERE object_kind = ? AND object_id = ?').run('work', 7));
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%vector_knn_index%'").all(), []);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'work' AND object_id = 7").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_knn_index WHERE object_kind = 'work' AND object_id = 7").get().count, 1);
    } finally {
      database.close();
    }
  } finally {
    cleanup(fixture.directory, repositoryRoot);
  }
});

test('offline migration copies five 1024-dimensional kinds and preserves the original BLOB bytes', () => {
  const entries = OBJECT_KINDS.slice(0, 5).map((object_kind, index) => ({ object_kind, object_id: index + 1, embedding_f32: vector(index + 3) }));
  const fixture = makeVersion36Database({ entries });
  try {
    const database = new DatabaseSync(fixture.path, { allowExtension: true });
    sqliteVec.load(database);
    try {
      assert.deepEqual(migrateVectorKnnIndex({ database, repositoryRoot: ROOT }), {
        status: 'complete',
        version: 37,
        indexed_count: 5
      });
      assert.deepEqual(database.prepare('SELECT object_kind, COUNT(*) AS count FROM vector_knn_index GROUP BY object_kind ORDER BY object_kind').all().map((row) => ({ ...row })), [
        { object_kind: 'character', count: 1 },
        { object_kind: 'generation_lora', count: 1 },
        { object_kind: 'prompt_term', count: 1 },
        { object_kind: 'style', count: 1 },
        { object_kind: 'work', count: 1 }
      ]);
      const source = database.prepare('SELECT object_kind, object_id, embedding_f32 FROM vector_entries ORDER BY object_kind').all();
      const indexed = database.prepare('SELECT object_kind, object_id, embedding FROM vector_knn_index ORDER BY object_kind').all();
      assert.equal(indexed.length, source.length);
      for (const [index, row] of source.entries()) {
        assert.equal(indexed[index].object_kind, row.object_kind);
        assert.equal(indexed[index].object_id, row.object_id);
        assert.deepEqual(Buffer.from(indexed[index].embedding), Buffer.from(row.embedding_f32));
      }
      assert.equal(database.prepare("SELECT dimension FROM vector_spaces WHERE object_kind = 'artist_prompt_string'").get().dimension, 1);
      assert.deepEqual(migrateVectorKnnIndex({ database, repositoryRoot: ROOT }), {
        status: 'already_complete',
        version: 37,
        indexed_count: 5
      });
    } finally {
      database.close();
    }
  } finally {
    cleanup(fixture.directory);
  }
});

test('offline migration returns NO-GO for invalid source dimension and invalid BLOB length', () => {
  const invalidDimension = makeVersion36Database({
    spaces: OBJECT_KINDS.map((objectKind) => [objectKind, objectKind === 'artist_prompt_string' ? '__unconfigured__' : 'issue-287-model', objectKind === 'work' ? 768 : objectKind === 'artist_prompt_string' ? 1 : 1024]),
    entries: [{ object_kind: 'work', object_id: 1, embedding_f32: vector(1) }]
  });
  const invalidBlob = makeVersion36Database({ entries: [{ object_kind: 'work', object_id: 1, embedding_f32: Buffer.alloc(8) }] });
  try {
    for (const fixture of [invalidDimension, invalidBlob]) {
      const database = new DatabaseSync(fixture.path, { allowExtension: true });
      sqliteVec.load(database);
      try {
        assert.throws(() => migrateVectorKnnIndex({ database, repositoryRoot: ROOT }), (error) => error instanceof VectorKnnMigrationError && error.status === 'source_invalid');
        assert.equal(database.prepare('PRAGMA user_version').get().user_version, 36);
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'vector_knn_index'").get().count, 0);
      } finally {
        database.close();
      }
    }
  } finally {
    cleanup(invalidDimension.directory, invalidBlob.directory);
  }
});

test('offline migration rejects an inconsistent ledger and a target without its ledger', () => {
  const registered = makeVersion36Database({ entries: [{ object_kind: 'work', object_id: 1, embedding_f32: vector(1) }] });
  const targetWithoutLedger = makeVersion36Database({ entries: [{ object_kind: 'work', object_id: 1, embedding_f32: vector(1) }] });
  try {
    for (const fixture of [registered, targetWithoutLedger]) {
      const database = new DatabaseSync(fixture.path, { allowExtension: true });
      sqliteVec.load(database);
      try {
        if (fixture === registered) database.exec("INSERT INTO schema_migrations VALUES(37, '037-vector-knn-index', '2026-08-23T00:00:00Z'); PRAGMA user_version = 37;");
        else database.exec('CREATE VIRTUAL TABLE vector_knn_index USING vec0(object_kind TEXT partition key, object_id INTEGER, embedding FLOAT[1024]);');
        assert.throws(() => migrateVectorKnnIndex({ database, repositoryRoot: ROOT }), (error) => error instanceof VectorKnnMigrationError && error.status === (fixture === registered ? 'registered_not_converged' : 'target_without_ledger'));
      } finally {
        database.close();
      }
    }
  } finally {
    cleanup(registered.directory, targetWithoutLedger.directory);
  }
});

test('migration SQL failure rolls back the KNN target and ledger', () => {
  const fixture = makeVersion36Database({ entries: [{ object_kind: 'work', object_id: 1, embedding_f32: vector(1) }] });
  const repositoryRoot = makeRepositoryRoot();
  const validSql = readFileSync(resolve(ROOT, 'schema/database/037-vector-knn-index.sql'), 'utf8');
  writeFileSync(resolve(repositoryRoot, 'schema/database/037-vector-knn-index.sql'), validSql.replace('PRAGMA user_version = 37;', 'THIS IS INVALID SQL;\nPRAGMA user_version = 37;'));
  try {
    const database = new DatabaseSync(fixture.path, { allowExtension: true });
    sqliteVec.load(database);
    try {
      assert.throws(() => migrateVectorKnnIndex({ database, repositoryRoot }), (error) => error instanceof VectorKnnMigrationError && error.status === 'rolled_back');
      assert.equal(database.prepare('PRAGMA user_version').get().user_version, 36);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 37").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'vector_knn_index'").get().count, 0);
    } finally {
      database.close();
    }
  } finally {
    cleanup(fixture.directory, repositoryRoot);
  }
});

test('COMMIT failure is uncertain and closes the migration connection', () => {
  const fixture = makeVersion36Database({ entries: [{ object_kind: 'work', object_id: 1, embedding_f32: vector(1) }] });
  const database = new DatabaseSync(fixture.path, { allowExtension: true });
  sqliteVec.load(database);
  let closeCalls = 0;
  const failingCommitDatabase = {
    prepare: database.prepare.bind(database),
    exec(sql) {
      if (/COMMIT/u.test(String(sql))) throw new Error('forced COMMIT failure');
      return database.exec(sql);
    },
    get isTransaction() { return database.isTransaction; },
    get isOpen() { return database.isOpen; },
    close() {
      closeCalls += 1;
      if (database.isOpen) database.close();
    }
  };
  try {
    assert.throws(
      () => migrateVectorKnnIndex({ database: failingCommitDatabase, repositoryRoot: ROOT }),
      (error) => error instanceof VectorKnnMigrationError
        && error.status === 'uncertain'
        && transactionStateOf(error) === 'uncertain'
        && error.connection_must_close === true
    );
    assert.equal(closeCalls, 1);
    assert.equal(database.isOpen, false);
  } finally {
    if (database.isOpen) database.close();
    cleanup(fixture.directory);
  }
});
