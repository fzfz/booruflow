import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';
import { migrateStylesToBaseModel } from '../../app/database/style-schema-migration.mjs';
import { TRANSACTION_STATE } from '../../app/transaction-state.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const MIGRATION_DIRECTORY = join(ROOT, 'schema/database');
const NOW = '2026-08-05T00:00:00Z';

function historicalRepositoryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'issue-210-historical-repository-'));
  const target = join(root, 'schema/database');
  mkdirSync(target, { recursive: true });
  for (const migration of listOrderedMigrations(MIGRATION_DIRECTORY).filter(({ version }) => version <= 35)) {
    cpSync(migration.path, join(target, migration.path.split('/').at(-1)));
  }
  return root;
}

function makeLegacyFixture(t, { styles = [], images = [], trigger = null, linkedStyleIds = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'issue-210-style-migration-'));
  const repositoryRoot = historicalRepositoryRoot();
  const databasePath = join(root, 'app.sqlite');
  const mediaRoot = join(root, 'media');
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot: ROOT });
  const database = new DatabaseSync(databasePath);
  database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (7, 'anima', ?, ?), (42, 'wai', ?, ?)").run(NOW, NOW, NOW, NOW);
  for (const style of styles) {
    database.prepare(`INSERT INTO styles(
      id, source_id, source_version, name, name_normalized, aliases_json, prompt_text,
      style_description, is_available, created_at, updated_at, cover_media_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(style.id, style.source_id ?? `source-${style.id}`, style.source_version, style.name, style.name.toLocaleLowerCase('en-US'), JSON.stringify(style.aliases ?? []), style.prompt_text, style.style_description ?? null, NOW, NOW, style.cover_media_path ?? null);
  }
  for (const image of images) {
    const absolutePath = join(mediaRoot, image.media_path);
    mkdirSync(resolve(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, image.bytes ?? Buffer.from(`image-${image.id}`));
    database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (?, 'style', ?, ?, ?, ?, ?, ?)`)
      .run(image.id, image.owner_id, `hash-${image.id}`, image.media_path, image.sort_order ?? 0, NOW, NOW);
  }
  if (linkedStyleIds.length > 0) {
    database.prepare(`INSERT INTO sessions(
      id, title, status, max_rounds, rounds_used, pi_instance_id, pi_session_id, pi_session_file, base_model_id, created_at, updated_at
    ) VALUES (9001, 'linked style session', 'active', 3, 0, 'instance-9001', 'session-9001', 'session-9001.jsonl', 7, ?, ?)`)
      .run(NOW, NOW);
    database.prepare(`INSERT INTO artist_prompt_strings(
      id, title, description, artist_string, base_model_id, created_at, updated_at
    ) VALUES (9001, 'linked style artist', 'linked style artist description', 'linked style artist string', 7, ?, ?)`)
      .run(NOW, NOW);
    const insertSessionStyle = database.prepare('INSERT INTO session_style_selections(session_id, style_id, position) VALUES (9001, ?, ?)');
    const insertArtistStyle = database.prepare('INSERT INTO artist_prompt_string_styles(artist_prompt_string_id, style_id) VALUES (9001, ?)');
    linkedStyleIds.forEach((styleId, index) => {
      insertSessionStyle.run(styleId, index);
      insertArtistStyle.run(styleId);
    });
  }
  if (trigger) database.exec(trigger);
  database.close();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  return { databasePath, mediaRoot, root, repositoryRoot };
}

function makeDeferredMigrationRepository(t, afterMigrationSql) {
  const root = mkdtempSync(join(tmpdir(), 'issue-211-deferred-migrations-'));
  const migrationDirectory = join(root, 'schema', 'database');
  mkdirSync(migrationDirectory, { recursive: true });
  cpSync(join(ROOT, 'schema', 'database'), migrationDirectory, { recursive: true });
  unlinkSync(join(migrationDirectory, '027-management-skill-sessions.sql'));
  writeFileSync(join(migrationDirectory, '027-after-style.sql'), afterMigrationSql, 'utf8');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Issue #210 opens the styles table with the seven-field target structure', () => {
  const database = openCatalogDatabase();
  try {
    assert.deepEqual(database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name), [
      'id', 'base_model_id', 'name', 'aliases_json', 'prompt_text', 'style_description', 'cover_media_path'
    ]);
  } finally {
    database.close();
  }
});

test('Issue #210 maps confirmed duplicates, deletes their media, and keeps retained IDs', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [
      { id: 12237, source_version: 'ANIMA', name: 'kanzarin', prompt_text: '@k4nz4r1n' },
      { id: 12245, source_version: 'ANIMA', name: 'ogipote', prompt_text: '@ogipote' },
      { id: 8339, source_version: 'ANIMA', name: 'kanzarin', prompt_text: 'kanzarin' },
      { id: 10013, source_version: 'ANIMA', name: 'ogipote', prompt_text: 'ogipote' },
      { id: 501, source_version: 'WAI', name: 'kanzarin', prompt_text: 'wai-kanzarin' },
      { id: 502, source_version: 'ANIMA', name: 'other', prompt_text: 'anima-other' }
    ],
    images: [
      { id: 9001, owner_id: 12237, media_path: 'images/duplicate-kanzarin.png' },
      { id: 9002, owner_id: 12245, media_path: 'images/duplicate-ogipote.png' }
    ]
  });
  const database = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, repositoryRoot: fixture.repositoryRoot });
  try {
    assert.deepEqual(database.prepare('SELECT id, base_model_id, name, prompt_text FROM styles ORDER BY id').all().map((row) => ({ ...row })), [
      { id: 501, base_model_id: 42, name: 'kanzarin', prompt_text: 'wai-kanzarin' },
      { id: 502, base_model_id: 7, name: 'other', prompt_text: 'anima-other' },
      { id: 8339, base_model_id: 7, name: 'kanzarin', prompt_text: 'kanzarin' },
      { id: 10013, base_model_id: 7, name: 'ogipote', prompt_text: 'ogipote' }
    ]);
    assert.equal(existsSync(join(fixture.mediaRoot, 'images/duplicate-kanzarin.png')), false);
    assert.equal(existsSync(join(fixture.mediaRoot, 'images/duplicate-ogipote.png')), false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = 'style'").get().count, 0);
  } finally {
    database.close();
  }
});

test('Issue #210 deletes linked NULL-source Styles independently and removes all dependent rows', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [
      { id: 701, source_version: null, name: 'linked null one', prompt_text: 'linked null one' },
      { id: 702, source_version: null, name: 'linked null two', prompt_text: 'linked null two' },
      { id: 703, source_version: 'WAI', name: 'retained wai', prompt_text: 'retained wai' }
    ],
    images: [
      { id: 9701, owner_id: 701, media_path: 'images/linked-null-one.png' },
      { id: 9702, owner_id: 702, media_path: 'images/linked-null-two.png' }
    ],
    linkedStyleIds: [701, 702]
  });
  const database = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, repositoryRoot: fixture.repositoryRoot });
  try {
    assert.deepEqual(database.prepare('SELECT id, name FROM styles ORDER BY id').all().map((row) => ({ ...row })), [
      { id: 703, name: 'retained wai' }
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_string_styles').get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM item_images WHERE owner_kind = 'style'").get().count, 0);
    assert.equal(existsSync(join(fixture.mediaRoot, 'images/linked-null-one.png')), false);
    assert.equal(existsSync(join(fixture.mediaRoot, 'images/linked-null-two.png')), false);
  } finally {
    database.close();
  }
});

test('Issue #210 keeps a confirmed duplicate when its retained counterpart is missing while continuing other cleanup targets', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [
      { id: 12237, source_version: 'ANIMA', name: 'kanzarin', prompt_text: '@k4nz4r1n' },
      { id: 12245, source_version: 'ANIMA', name: 'ogipote', prompt_text: '@ogipote' },
      { id: 10013, source_version: 'ANIMA', name: 'ogipote', prompt_text: 'ogipote' },
      { id: 704, source_version: null, name: 'cleanup continues', prompt_text: 'cleanup continues' }
    ],
    images: [
      { id: 9704, owner_id: 12237, media_path: 'images/missing-counterpart.png' },
      { id: 9705, owner_id: 12245, media_path: 'images/confirmed-ogipote.png' },
      { id: 9706, owner_id: 704, media_path: 'images/cleanup-continues.png' }
    ]
  });
  const database = new DatabaseSync(fixture.databasePath);
  try {
    assert.throws(
      () => migrateStylesToBaseModel({ database, mediaRoot: fixture.mediaRoot }),
      (error) => error.phase === 'cleanup' && error.pending.includes(12237) && error.failures.some(({ id, failures }) => id === 12237 && failures?.some(({ code }) => code === 'RETAINED_MISSING'))
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 12237').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 12245').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 704').get().count, 0);
    assert.equal(existsSync(join(fixture.mediaRoot, 'images/missing-counterpart.png')), true);
    assert.equal(existsSync(join(fixture.mediaRoot, 'images/confirmed-ogipote.png')), false);
    assert.equal(existsSync(join(fixture.mediaRoot, 'images/cleanup-continues.png')), false);
    assert.deepEqual(database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name).slice(0, 5), [
      'id', 'source_id', 'source_url', 'source_version', 'source_updated_at'
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
  } finally {
    database.close();
  }
});

test('Issue #210 restores bytes and mode after one target media unlink fails, then continues other targets', (t) => {
  const previousUmask = process.umask(0o022);
  t.after(() => process.umask(previousUmask));
  const firstBytes = Buffer.from('first-style-image');
  const secondBytes = Buffer.from('second-style-image');
  const fixture = makeLegacyFixture(t, {
    styles: [
      { id: 711, source_version: null, name: 'unlink failure', prompt_text: 'unlink failure' },
      { id: 712, source_version: null, name: 'unlink succeeds', prompt_text: 'unlink succeeds' }
    ],
    images: [
      { id: 9711, owner_id: 711, media_path: 'images/unlink-first.png', bytes: firstBytes, sort_order: 0 },
      { id: 9712, owner_id: 711, media_path: 'images/unlink-second.png', bytes: secondBytes, sort_order: 1 },
      { id: 9713, owner_id: 712, media_path: 'images/unlink-other.png' }
    ]
  });
  const firstPath = join(fixture.mediaRoot, 'images/unlink-first.png');
  const secondPath = join(fixture.mediaRoot, 'images/unlink-second.png');
  const otherPath = join(fixture.mediaRoot, 'images/unlink-other.png');
  chmodSync(firstPath, 0o666);
  chmodSync(secondPath, 0o777);
  const firstMode = statSync(firstPath).mode & 0o7777;
  const secondMode = statSync(secondPath).mode & 0o7777;
  let failSecond = true;
  const fileSystem = {
    unlinkSync(path) {
      if (failSecond && path === secondPath) {
        failSecond = false;
        const error = new Error('issue-210 forced active media unlink failure');
        error.code = 'EACCES';
        throw error;
      }
      return unlinkSync(path);
    }
  };
  const database = new DatabaseSync(fixture.databasePath);
  try {
    assert.throws(() => migrateStylesToBaseModel({ database, mediaRoot: fixture.mediaRoot, fileSystem }), /active media unlink failure|style cleanup is incomplete/u);
    assert.deepEqual(readFileSync(firstPath), firstBytes);
    assert.equal(statSync(firstPath).mode & 0o7777, firstMode);
    assert.deepEqual(readFileSync(secondPath), secondBytes);
    assert.equal(statSync(secondPath).mode & 0o7777, secondMode);
    assert.equal(existsSync(otherPath), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 711').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 712').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
    assert.deepEqual(database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name).slice(0, 5), [
      'id', 'source_id', 'source_url', 'source_version', 'source_updated_at'
    ]);
  } finally {
    database.close();
  }
});

test('Issue #210 restores target media after SQL cleanup failure and continues other targets', (t) => {
  const previousUmask = process.umask(0o022);
  t.after(() => process.umask(previousUmask));
  const firstBytes = Buffer.from('sql-failure-first');
  const secondBytes = Buffer.from('sql-failure-second');
  const fixture = makeLegacyFixture(t, {
    styles: [
      { id: 721, source_version: null, name: 'sql failure', prompt_text: 'sql failure' },
      { id: 722, source_version: null, name: 'sql succeeds', prompt_text: 'sql succeeds' }
    ],
    images: [
      { id: 9721, owner_id: 721, media_path: 'images/sql-first.png', bytes: firstBytes, sort_order: 0 },
      { id: 9722, owner_id: 721, media_path: 'images/sql-second.png', bytes: secondBytes, sort_order: 1 },
      { id: 9723, owner_id: 722, media_path: 'images/sql-other.png' }
    ],
    trigger: `CREATE TRIGGER issue_210_cleanup_failure BEFORE DELETE ON styles WHEN OLD.id = 721 BEGIN SELECT RAISE(ABORT, 'issue-210 SQL cleanup failure'); END;`
  });
  const firstPath = join(fixture.mediaRoot, 'images/sql-first.png');
  const secondPath = join(fixture.mediaRoot, 'images/sql-second.png');
  chmodSync(firstPath, 0o666);
  chmodSync(secondPath, 0o777);
  const firstMode = statSync(firstPath).mode & 0o7777;
  const secondMode = statSync(secondPath).mode & 0o7777;
  const database = new DatabaseSync(fixture.databasePath);
  try {
    assert.throws(() => migrateStylesToBaseModel({ database, mediaRoot: fixture.mediaRoot }), /SQL cleanup failure|style cleanup is incomplete/u);
    assert.deepEqual(readFileSync(join(fixture.mediaRoot, 'images/sql-first.png')), firstBytes);
    assert.deepEqual(readFileSync(join(fixture.mediaRoot, 'images/sql-second.png')), secondBytes);
    assert.equal(statSync(firstPath).mode & 0o7777, firstMode);
    assert.equal(statSync(secondPath).mode & 0o7777, secondMode);
    assert.equal(existsSync(join(fixture.mediaRoot, 'images/sql-other.png')), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 721').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 722').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
  } finally {
    database.close();
  }
});

test('Issue #210 reports chmod and stat failures during current-call media rollback', (t) => {
  for (const [operation, label] of [['chmodSync', 'chmod'], ['statSync', 'stat']]) {
    const fixture = makeLegacyFixture(t, {
      styles: [{ id: 725, source_version: null, name: `${label} rollback failure`, prompt_text: `${label} rollback failure` }],
      images: [{ id: 9725, owner_id: 725, media_path: `images/${label}-rollback.png` }],
      trigger: `CREATE TRIGGER issue_210_${label}_rollback_failure BEFORE DELETE ON styles WHEN OLD.id = 725 BEGIN SELECT RAISE(ABORT, 'issue-210 ${label} rollback SQL failure'); END;`
    });
    const mediaPath = join(fixture.mediaRoot, `images/${label}-rollback.png`);
    const database = new DatabaseSync(fixture.databasePath);
    const fileSystem = {
      [operation](path) {
        if (path === mediaPath) {
          const error = new Error(`issue-210 forced ${label} failure`);
          error.code = `E${label.toUpperCase()}`;
          throw error;
        }
        return operation === 'chmodSync' ? chmodSync(path, 0o666) : statSync(path);
      }
    };
    try {
      assert.throws(
        () => migrateStylesToBaseModel({ database, mediaRoot: fixture.mediaRoot, fileSystem }),
        (error) => error.phase === 'cleanup'
          && error.failures.some(({ failures }) => failures?.some(({ code, message }) => code === 'MEDIA_RESTORE' && message.includes(`forced ${label} failure`)))
      );
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 725').get().count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
    } finally {
      database.close();
    }
  }
});

test('Issue #210 rejects an intermediate media symlink without touching bytes outside mediaRoot', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [{ id: 731, source_version: null, name: 'intermediate symlink', prompt_text: 'intermediate symlink' }],
    images: [{ id: 9731, owner_id: 731, media_path: 'images/nested/symlink.png' }]
  });
  const outsideRoot = join(fixture.root, 'outside');
  const outsidePath = join(outsideRoot, 'symlink.png');
  mkdirSync(outsideRoot, { recursive: true });
  const outsideBytes = Buffer.from('outside-bytes');
  writeFileSync(outsidePath, outsideBytes);
  rmSync(join(fixture.mediaRoot, 'images/nested'), { recursive: true, force: true });
  symlinkSync(outsideRoot, join(fixture.mediaRoot, 'images/nested'), 'dir');
  const database = new DatabaseSync(fixture.databasePath);
  try {
    assert.throws(() => migrateStylesToBaseModel({ database, mediaRoot: fixture.mediaRoot }), /symbolic link|symlink|style cleanup is incomplete/u);
    assert.deepEqual(readFileSync(outsidePath), outsideBytes);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 731').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
  } finally {
    database.close();
  }
});

test('Issue #210 enforces seven-field constraints, preserves IDs, auto-allocates new IDs, and is idempotent', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [
      { id: 100, source_version: 'WAI', name: 'same name', prompt_text: 'wai prompt' },
      { id: 200, source_version: 'ANIMA', name: 'same name', prompt_text: 'anima prompt' }
    ]
  });
  const database = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, repositoryRoot: fixture.repositoryRoot });
  try {
    assert.deepEqual(database.prepare('PRAGMA table_info(styles)').all().map(({ name, notnull }) => ({ name, notnull })), [
      { name: 'id', notnull: 0 },
      { name: 'base_model_id', notnull: 1 },
      { name: 'name', notnull: 1 },
      { name: 'aliases_json', notnull: 1 },
      { name: 'prompt_text', notnull: 1 },
      { name: 'style_description', notnull: 0 },
      { name: 'cover_media_path', notnull: 0 }
    ]);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_list(styles)').all().map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete })), [
      { from: 'base_model_id', table: 'generation_base_models', to: 'id', on_delete: 'RESTRICT' }
    ]);
    assert.throws(() => database.prepare("INSERT INTO styles(base_model_id, name, aliases_json, prompt_text) VALUES (42, 'same name', '[]', 'duplicate')").run(), /UNIQUE/u);
    assert.throws(() => database.prepare("INSERT INTO styles(base_model_id, name, aliases_json, prompt_text) VALUES (NULL, 'missing base', '[]', 'prompt')").run(), /NOT NULL/u);
    assert.throws(() => database.prepare('DELETE FROM generation_base_models WHERE id = 42').run(), /FOREIGN KEY|constraint/u);
    const inserted = database.prepare("INSERT INTO styles(base_model_id, name, aliases_json, prompt_text) VALUES (42, 'new style', '[]', 'new prompt')").run();
    assert.ok(Number(inserted.lastInsertRowid) > 200);
    const beforeColumns = database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name);
    const second = migrateStylesToBaseModel({ database, mediaRoot: fixture.mediaRoot });
    assert.equal(second.status, 'already_applied');
    assert.deepEqual(database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name), beforeColumns);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 1);
  } finally {
    database.close();
  }
});

test('Issue #210 rolls back the complete styles swap when migration SQL fails', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [{ id: 801, source_version: 'WAI', name: 'rollback style', prompt_text: 'rollback prompt' }]
  });
  const database = new DatabaseSync(fixture.databasePath);
  try {
    assert.throws(
      () => migrateStylesToBaseModel({
        database,
        mediaRoot: fixture.mediaRoot,
        readMigrationSql: () => `PRAGMA foreign_keys = OFF;
          BEGIN IMMEDIATE;
          CREATE TABLE styles_next (id INTEGER PRIMARY KEY);
          DROP TABLE styles;
          SELECT * FROM issue_210_missing_table;
          COMMIT;`
      }),
      /style migration failed|issue_210_missing_table/u
    );
    assert.deepEqual(database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name).slice(0, 5), [
      'id', 'source_id', 'source_url', 'source_version', 'source_updated_at'
    ]);
    assert.equal(database.prepare('SELECT id, prompt_text FROM styles WHERE id = 801').get().prompt_text, 'rollback prompt');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
  } finally {
    database.close();
  }
});

test('Issue #210 runs foreign-key and integrity checks before the final migration commit', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [{ id: 802, source_version: 'WAI', name: 'check order style', prompt_text: 'check order prompt' }]
  });
  const database = new DatabaseSync(fixture.databasePath);
  const calls = [];
  const trackedDatabase = {
    prepare(sql) {
      calls.push(`prepare:${sql}`);
      return database.prepare(sql);
    },
    exec(sql) {
      calls.push(`exec:${sql}`);
      return database.exec(sql);
    }
  };
  try {
    assert.equal(migrateStylesToBaseModel({ database: trackedDatabase, mediaRoot: fixture.mediaRoot }).status, 'complete');
    const finalCommit = calls.map((call, index) => ({ call, index }))
      .filter(({ call }) => call === 'exec:COMMIT;')
      .at(-1)?.index;
    const foreignKeyCheck = calls.findIndex((call) => call === 'prepare:PRAGMA foreign_key_check');
    const integrityCheck = calls.findIndex((call) => call === 'prepare:PRAGMA integrity_check');
    assert.ok(finalCommit !== undefined);
    assert.ok(foreignKeyCheck >= 0 && foreignKeyCheck < finalCommit);
    assert.ok(integrityCheck >= 0 && integrityCheck < finalCommit);
  } finally {
    database.close();
  }
});

test('Issue #210 aggregates ROLLBACK control failure, preserves media evidence, and stops later targets', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [
      { id: 741, source_version: null, name: 'rollback control failure', prompt_text: 'rollback control failure' },
      { id: 742, source_version: null, name: 'must not continue', prompt_text: 'must not continue' }
    ],
    images: [{ id: 9741, owner_id: 741, media_path: 'images/rollback-control.png' }],
    trigger: `CREATE TRIGGER issue_210_rollback_control BEFORE DELETE ON styles WHEN OLD.id = 741 BEGIN SELECT RAISE(ABORT, 'issue-210 forced cleanup SQL failure'); END;`
  });
  const database = new DatabaseSync(fixture.databasePath);
  const trackedDatabase = {
    prepare(sql) { return database.prepare(sql); },
    exec(sql) {
      if (sql === 'ROLLBACK;') throw new Error('issue-210 forced ROLLBACK control failure');
      return database.exec(sql);
    }
  };
  try {
    let observedError = null;
    assert.throws(
      () => migrateStylesToBaseModel({ database: trackedDatabase, mediaRoot: fixture.mediaRoot }),
      (error) => {
        observedError = error;
        return error.phase === 'cleanup'
          && error.transactionState === TRANSACTION_STATE.UNCERTAIN
          && error.controlFailures.some(({ operation, code }) => operation === 'ROLLBACK' && code === 'ROLLBACK_FAILED')
          && error.message.includes('ROLLBACK failed');
      }
    );
    assert.match(observedError.originalError.message, /issue-210 forced cleanup SQL failure/u);
    assert.match(observedError.rollbackError.message, /issue-210 forced ROLLBACK control failure/u);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 742').get().count, 1);
    assert.equal(existsSync(join(fixture.mediaRoot, 'images/rollback-control.png')), true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
  } finally {
    database.close();
  }
});

test('Issue #210 reports foreign_keys restoration failure instead of returning complete', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [{ id: 751, source_version: 'WAI', name: 'foreign keys restore failure', prompt_text: 'restore failure' }]
  });
  const database = new DatabaseSync(fixture.databasePath);
  let foreignKeysOnCalls = 0;
  const trackedDatabase = {
    prepare(sql) { return database.prepare(sql); },
    exec(sql) {
      if (sql === 'PRAGMA foreign_keys = ON;') {
        foreignKeysOnCalls += 1;
        if (foreignKeysOnCalls === 3) throw new Error('issue-210 forced foreign_keys restore failure');
      }
      return database.exec(sql);
    }
  };
  try {
    assert.throws(
      () => migrateStylesToBaseModel({ database: trackedDatabase, mediaRoot: fixture.mediaRoot }),
      (error) => error.controlFailures.some(({ operation, code }) => operation === 'FOREIGN_KEYS_RESTORE' && code === 'FOREIGN_KEYS_RESTORE_FAILED')
        && error.message.includes('foreign_keys restore failure')
    );
    assert.deepEqual(database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name), [
      'id', 'base_model_id', 'name', 'aliases_json', 'prompt_text', 'style_description', 'cover_media_path'
    ]);
  } finally {
    database.close();
  }
});

test('Issue #211 deferred catalog open leaves the real legacy schema for cleanup before swap', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [{ id: 861, source_version: null, name: 'deferred cleanup', prompt_text: 'deferred cleanup' }]
  });
  const database = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, repositoryRoot: fixture.repositoryRoot, deferStyleMigration: true });
  const phases = [];
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
    assert.equal(database.prepare('PRAGMA table_info(styles)').all().some(({ name }) => name === 'source_version'), true);
    const result = migrateStylesToBaseModel({ database, mediaRoot: fixture.mediaRoot, onCleanupComplete: () => phases.push('cleanup-complete') });
    assert.equal(result.status, 'complete');
    assert.deepEqual(phases, ['cleanup-complete']);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 1);
  } finally { database.close(); }
});

test('Issue #211 cleanup failure continues targets but blocks swap and never emits cleanup-complete', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [
      { id: 871, source_version: null, name: 'deferred failure', prompt_text: 'deferred failure' },
      { id: 872, source_version: null, name: 'deferred success', prompt_text: 'deferred success' }
    ],
    trigger: `CREATE TRIGGER issue_211_deferred_failure BEFORE DELETE ON styles WHEN OLD.id = 871 BEGIN SELECT RAISE(ABORT, 'issue-211 deferred cleanup failure'); END;`
  });
  const database = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, repositoryRoot: fixture.repositoryRoot, deferStyleMigration: true });
  const phases = [];
  try {
    assert.throws(() => migrateStylesToBaseModel({ database, mediaRoot: fixture.mediaRoot, onCleanupComplete: () => phases.push('cleanup-complete') }), (error) => error.phase === 'cleanup' && error.pending.includes(871));
    assert.deepEqual(phases, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles WHERE id = 872').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
  } finally { database.close(); }
});

test('Issue #211 swap failure reports a rolled-back transaction after cleanup boundary', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [{ id: 881, source_version: 'WAI', name: 'deferred swap failure', prompt_text: 'deferred swap failure' }]
  });
  const database = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, repositoryRoot: fixture.repositoryRoot, deferStyleMigration: true });
  const phases = [];
  try {
    assert.throws(() => migrateStylesToBaseModel({
      database,
      mediaRoot: fixture.mediaRoot,
      onCleanupComplete: () => phases.push('cleanup-complete'),
      readMigrationSql: () => 'CREATE TABLE styles_next (id INTEGER PRIMARY KEY); DROP TABLE styles; SELECT * FROM issue_211_missing_table;'
    }), (error) => error.phase === 'migration' && error.transactionState === TRANSACTION_STATE.ROLLED_BACK && /transaction rolled back/u.test(error.message));
    assert.deepEqual(phases, ['cleanup-complete']);
    assert.equal(database.prepare('SELECT prompt_text FROM styles WHERE id = 881').get().prompt_text, 'deferred swap failure');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
  } finally { database.close(); }
});

test('Issue #211 cleanup callback failure leaves the legacy table, ledger, and foreign_keys setting intact', (t) => {
  const fixture = makeLegacyFixture(t, {
    styles: [{ id: 891, source_version: 'WAI', name: 'cleanup callback failure', prompt_text: 'cleanup callback failure' }]
  });
  const database = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, repositoryRoot: fixture.repositoryRoot, deferStyleMigration: true });
  const legacyColumns = database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name);
  const initialForeignKeys = database.prepare('PRAGMA foreign_keys').get().foreign_keys;
  try {
    assert.throws(
      () => migrateStylesToBaseModel({
        database,
        mediaRoot: fixture.mediaRoot,
        onCleanupComplete: () => { throw new Error('issue-211 cleanup callback failure'); }
      }),
      /issue-211 cleanup callback failure/u
    );
    assert.deepEqual(database.prepare('PRAGMA table_info(styles)').all().map(({ name }) => name), legacyColumns);
    assert.equal(database.prepare('SELECT prompt_text FROM styles WHERE id = 891').get().prompt_text, 'cleanup callback failure');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
    assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, initialForeignKeys);
  } finally { database.close(); }
});

test('Issue #211 deferStyleMigration stops before unregistered 015 and every dependent migration', (t) => {
  const repositoryRoot = makeDeferredMigrationRepository(t, `
    CREATE TABLE issue_211_after_style AS SELECT base_model_id, name FROM styles;
    INSERT INTO schema_migrations(version, name, applied_at) VALUES (27, '027-after-style', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
  const fixture = makeLegacyFixture(t, {
    styles: [{ id: 892, source_version: 'WAI', name: 'defer boundary', prompt_text: 'defer boundary' }]
  });
  const database = openCatalogDatabase({ databasePath: fixture.databasePath, mediaRoot: fixture.mediaRoot, repositoryRoot, deferStyleMigration: true });
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 16').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 22').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 23').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 24').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 25').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 27').get().count, 0);
    assert.equal(database.prepare('SELECT name FROM pragma_table_info(\'styles\') WHERE name = \'source_version\'').get().name, 'source_version');
    assert.throws(() => database.prepare('SELECT COUNT(*) AS count FROM issue_211_after_style').get(), /no such table/u);
  } finally { database.close(); }
});

test('Issue #211 deferStyleMigration continues through 027 after 015 is already registered, while default mode applies all', (t) => {
  const repositoryRoot = makeDeferredMigrationRepository(t, `
    CREATE TABLE issue_211_after_style AS SELECT base_model_id, name FROM styles;
    INSERT INTO schema_migrations(version, name, applied_at) VALUES (27, '027-after-style', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
  const deferredFixture = makeLegacyFixture(t, {
    styles: [{ id: 893, source_version: 'WAI', name: 'defer continuation', prompt_text: 'defer continuation' }]
  });
  const preMigrated = new DatabaseSync(deferredFixture.databasePath);
  try { assert.equal(migrateStylesToBaseModel({ database: preMigrated, mediaRoot: deferredFixture.mediaRoot }).status, 'complete'); }
  finally { preMigrated.close(); }
  const deferredDatabase = openCatalogDatabase({ databasePath: deferredFixture.databasePath, mediaRoot: deferredFixture.mediaRoot, repositoryRoot, deferStyleMigration: true });
  try {
    assert.equal(deferredDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 1);
    assert.equal(deferredDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 16').get().count, 1);
    assert.equal(deferredDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 22').get().count, 1);
    assert.equal(deferredDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 23').get().count, 1);
    assert.equal(deferredDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 24').get().count, 1);
    assert.equal(deferredDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 25').get().count, 1);
    assert.equal(deferredDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 27').get().count, 1);
    assert.equal(deferredDatabase.prepare('SELECT name FROM issue_211_after_style').get().name, 'defer continuation');
  } finally { deferredDatabase.close(); }

  const defaultFixture = makeLegacyFixture(t, {
    styles: [{ id: 894, source_version: 'WAI', name: 'default order', prompt_text: 'default order' }]
  });
  const defaultDatabase = openCatalogDatabase({ databasePath: defaultFixture.databasePath, mediaRoot: defaultFixture.mediaRoot, repositoryRoot });
  try {
    assert.equal(defaultDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 15').get().count, 1);
    assert.equal(defaultDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 16').get().count, 1);
    assert.equal(defaultDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 22').get().count, 1);
    assert.equal(defaultDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 23').get().count, 1);
    assert.equal(defaultDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 24').get().count, 1);
    assert.equal(defaultDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 25').get().count, 1);
    assert.equal(defaultDatabase.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 27').get().count, 1);
    assert.equal(defaultDatabase.prepare('SELECT name FROM issue_211_after_style').get().name, 'default order');
  } finally { defaultDatabase.close(); }
});
