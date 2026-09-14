import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';

const migrationSql = readFileSync(new URL('../../schema/database/025-remove-session-selections.sql', import.meta.url), 'utf8');

function createVersion24Database({ omitStyleSelections = false } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA user_version = 24;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(24, '024-generation-lora-trigger-weight', '2026-08-13T00:00:00Z');
    CREATE TABLE sessions(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    INSERT INTO sessions VALUES(1, '保留的会话');
    CREATE TABLE session_character_selections(session_id INTEGER NOT NULL, character_id INTEGER NOT NULL);
    INSERT INTO session_character_selections VALUES(1, 11);
    ${omitStyleSelections ? '' : `CREATE TABLE session_style_selections(session_id INTEGER NOT NULL, style_id INTEGER NOT NULL);
    INSERT INTO session_style_selections VALUES(1, 21);`}
  `);
  return database;
}

test('Issue #230 latest database removes both session-level selection tables', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    const ledger = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    assert.deepEqual({ ...ledger.at(-1) }, { version: 40, name: '040-data-import-batches' });
    for (const table of ['session_character_selections', 'session_style_selections']) {
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table).count, 0, table);
    }
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('Issue #230 migration upgrades a populated version 24 database and preserves non-selection data', () => {
  const database = createVersion24Database();
  try {
    database.exec(migrationSql);
    assert.deepEqual(database.prepare('SELECT * FROM sessions').all().map((row) => ({ ...row })), [{ id: 1, title: '保留的会话' }]);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 25);
    assert.deepEqual({ ...database.prepare('SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1').get() }, {
      version: 25,
      name: '025-remove-session-selections'
    });
  } finally {
    database.close();
  }
});

test('Issue #230 migration rolls back its first drop and version ledger when the second legacy table is missing', () => {
  const database = createVersion24Database({ omitStyleSelections: true });
  try {
    assert.throws(() => database.exec(migrationSql), /no such table: session_style_selections/u);
    database.exec('ROLLBACK');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'session_character_selections'").get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM session_character_selections').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 25').get().count, 0);
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 24);
  } finally {
    database.close();
  }
});
