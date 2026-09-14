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

import { main, runVectorKnnMigration } from '../../scripts/migrate-vector-knn-index.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const ENVIRONMENT = [
  'NOOBAI_PUBLIC_PORT=28082',
  'NOOBAI_INTERNAL_PORT=28083',
  'NOOBAI_INTERNAL_API_TIMEOUT_MS=60000',
  'NOOBAI_EMBEDDING_BASE_URL=http://127.0.0.1:1/v1',
  'NOOBAI_EMBEDDING_API_KEY=test-key',
  'NOOBAI_EMBEDDING_MODEL=test-embedding',
  'NOOBAI_RERANKER_BASE_URL=http://127.0.0.1:1/v1',
  'NOOBAI_RERANKER_API_KEY=test-key',
  'NOOBAI_RERANKER_MODEL=test-reranker'
].join('\n');

function vector(seed) {
  const values = new Float32Array(1024);
  values[seed] = 1;
  return Buffer.from(values.buffer);
}

function createProductionRoot({ complete = false, duplicateVectorIds = false } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'issue-287-production-'));
  mkdirSync(resolve(root, 'config'), { recursive: true });
  mkdirSync(resolve(root, 'schema/database'), { recursive: true });
  mkdirSync(resolve(root, 'data'), { recursive: true });
  copyFileSync(resolve(ROOT, 'config/defaults.json'), resolve(root, 'config/defaults.json'));
  copyFileSync(resolve(ROOT, 'schema/database/037-vector-knn-index.sql'), resolve(root, 'schema/database/037-vector-knn-index.sql'));
  writeFileSync(resolve(root, '.env'), ENVIRONMENT);
  const databasePath = resolve(root, 'data/app.sqlite');
  const database = new DatabaseSync(databasePath, { allowExtension: true });
  sqliteVec.load(database);
  database.exec(`
    PRAGMA user_version = ${complete ? 37 : 36};
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(36, '036-generation-resource-vectors', '2026-08-23T00:00:00Z');
    CREATE TABLE vector_spaces(object_kind TEXT PRIMARY KEY, embedding_model TEXT NOT NULL, dimension INTEGER NOT NULL);
    CREATE TABLE vector_entries(object_kind TEXT NOT NULL, object_id INTEGER NOT NULL, embedding_f32 BLOB NOT NULL, PRIMARY KEY(object_kind, object_id));
    INSERT INTO vector_spaces VALUES
      ('work', 'test-model', 1024), ('character', 'test-model', 1024), ('style', 'test-model', 1024),
      ('prompt_term', 'test-model', 1024), ('generation_lora', 'test-model', 1024), ('artist_prompt_string', '__unconfigured__', 1);
  `);
  database.prepare('INSERT INTO vector_entries VALUES(?, ?, ?)').run('work', 1, vector(1));
  if (duplicateVectorIds) {
    database.prepare('INSERT INTO vector_entries VALUES(?, ?, ?)').run('generation_lora', 2, vector(2));
    database.prepare('INSERT INTO vector_entries VALUES(?, ?, ?)').run('generation_lora', 4, vector(2));
  }
  if (complete) {
    database.exec(`
      CREATE VIRTUAL TABLE vector_knn_index USING vec0(object_kind TEXT partition key, object_id INTEGER, embedding FLOAT[1024]);
      INSERT INTO vector_knn_index(object_kind, object_id, embedding) SELECT object_kind, object_id, embedding_f32 FROM vector_entries;
      INSERT INTO schema_migrations VALUES(37, '037-vector-knn-index', '2026-08-23T00:00:00Z');
    `);
  }
  database.close();
  return { root, databasePath };
}

function outputBuffer() {
  const chunks = [];
  return { stream: { write(chunk) { chunks.push(String(chunk)); } }, text: () => chunks.join('') };
}

test('offline CLI checks production stop before opening the database', async () => {
  const fixture = createProductionRoot();
  let opened = false;
  try {
    await assert.rejects(
      runVectorKnnMigration({
        productionRoot: fixture.root,
        assertStopped: async () => { throw new Error('production application PID is still running'); },
        databaseFactory: () => { opened = true; throw new Error('database must not open'); }
      }),
      /production application PID is still running/u
    );
    assert.equal(opened, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('offline CLI verifies per-kind counts without reading IDs or querying nearest neighbors', async () => {
  const fixture = createProductionRoot({ duplicateVectorIds: true });
  try {
    let openCount = 0;
    const verificationQueries = [];
    const databaseFactory = (path) => {
      openCount += 1;
      const database = new DatabaseSync(path, { allowExtension: true });
      sqliteVec.load(database);
      if (openCount === 2) {
        const originalPrepare = database.prepare.bind(database);
        database.prepare = (sql, ...parameters) => {
          verificationQueries.push(String(sql));
          return originalPrepare(sql, ...parameters);
        };
      }
      return database;
    };
    const first = await runVectorKnnMigration({ productionRoot: fixture.root, assertStopped: async () => {}, databaseFactory });
    assert.deepEqual({ status: first.status, version: first.version, indexed_count: first.indexed_count }, { status: 'complete', version: 37, indexed_count: 3 });
    assert.equal(openCount, 2);
    assert.ok(verificationQueries.some((sql) => /SELECT object_kind, COUNT\(\*\) AS count FROM vector_entries GROUP BY object_kind/u.test(sql)));
    assert.ok(verificationQueries.some((sql) => /SELECT object_kind, COUNT\(\*\) AS count FROM vector_knn_index GROUP BY object_kind/u.test(sql)));
    assert.equal(verificationQueries.some((sql) => /SELECT object_kind, object_id/u.test(sql)), false);
    assert.equal(verificationQueries.some((sql) => /embedding MATCH/u.test(sql)), false);
    const second = await runVectorKnnMigration({ productionRoot: fixture.root, assertStopped: async () => {} });
    assert.deepEqual({ status: second.status, version: second.version, indexed_count: second.indexed_count }, { status: 'already_complete', version: 37, indexed_count: 3 });

    const stdout = outputBuffer();
    const stderr = outputBuffer();
    assert.equal(await main(['--production-root', fixture.root], { stdout: stdout.stream, stderr: stderr.stream, assertStopped: async () => {} }), 0);
    assert.equal(stderr.text(), '');
    assert.deepEqual(JSON.parse(stdout.text()), {
      ok: true,
      decision: 'GO',
      status: 'already_complete',
      migration_version: 37,
      indexed_count: 3,
      production_root: fixture.root,
      database_path: fixture.databasePath
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('offline CLI rejects a verification connection whose per-kind index count is smaller', async () => {
  const fixture = createProductionRoot();
  try {
    let openCount = 0;
    const databaseFactory = (path) => {
      openCount += 1;
      const database = new DatabaseSync(path, { allowExtension: true });
      sqliteVec.load(database);
      if (openCount === 2) {
        database.prepare('DELETE FROM vector_knn_index WHERE object_kind = ? AND object_id = ?').run('work', 1n);
      }
      return database;
    };

    await assert.rejects(
      runVectorKnnMigration({ productionRoot: fixture.root, assertStopped: async () => {}, databaseFactory }),
      /did not converge on its verification connection/u
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('offline CLI rejects a verification connection whose per-kind index count is larger', async () => {
  const fixture = createProductionRoot();
  try {
    let openCount = 0;
    const databaseFactory = (path) => {
      openCount += 1;
      const database = new DatabaseSync(path, { allowExtension: true });
      sqliteVec.load(database);
      if (openCount === 2) {
        database.prepare('INSERT INTO vector_knn_index(object_kind, object_id, embedding) VALUES (?, ?, ?)')
          .run('work', 99n, vector(2));
      }
      return database;
    };

    await assert.rejects(
      runVectorKnnMigration({ productionRoot: fixture.root, assertStopped: async () => {}, databaseFactory }),
      /did not converge on its verification connection/u
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('offline CLI emits one NO-GO JSON line and no stdout for a malformed old vector', async () => {
  const fixture = createProductionRoot();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("UPDATE vector_entries SET embedding_f32 = X'0000'").run();
    database.close();
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    assert.equal(await main(['--production-root', fixture.root], { stdout: stdout.stream, stderr: stderr.stream, assertStopped: async () => {} }), 1);
    assert.equal(stdout.text(), '');
    const result = JSON.parse(stderr.text());
    assert.equal(result.ok, false);
    assert.equal(result.decision, 'NO-GO');
    assert.equal(result.error.status, 'source_invalid');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
