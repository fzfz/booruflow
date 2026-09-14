import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { OfflineMediaCutoverRequiredError, openCatalogDatabase } from '../../app/catalog/database.mjs';
import { MediaCutoverError, runMediaCutover } from '../../app/database/media-cutover.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const migrations = resolve(root, 'schema/database');
const timestamp = '2026-08-01T00:00:00Z';

function historicalRepositoryRoot(directory) {
  const repositoryRoot = join(directory, 'repository');
  const target = join(repositoryRoot, 'schema/database');
  mkdirSync(target, { recursive: true });
  for (const migration of listOrderedMigrations(migrations).filter(({ version }) => version <= 35)) {
    cpSync(migration.path, join(target, migration.path.split('/').at(-1)));
  }
  return repositoryRoot;
}

function legacyDatabase(path) {
  const database = new DatabaseSync(path);
  for (const name of ['001-initial.sql', '002-management-media.sql', '003-media-path-foundation.sql', '004-work-cover-character-fallback.sql']) {
    database.exec(readFileSync(resolve(migrations, name), 'utf8'));
  }
  database.prepare(`INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at)
    VALUES (1, 'Work', 'work', '[]', 1, ?, ?)` ).run(timestamp, timestamp);
  database.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
    VALUES (2, 1, 'Character', 'character', '[]', 'ink', 1, ?, ?)` ).run(timestamp, timestamp);
  database.prepare(`INSERT INTO item_images(id, owner_kind, owner_id, content_hash, local_path, media_path, sort_order, created_at, updated_at)
    VALUES (9, 'character', 2, 'hash', 'images/legacy.png', 'images/legacy.png', 0, ?, ?)` ).run(timestamp, timestamp);
  database.prepare('UPDATE characters SET cover_media_path = ? WHERE id = 2').run('images/legacy.png');
  return database;
}

function seedStyleBaseModels(path) {
  const database = new DatabaseSync(path);
  database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (7, 'anima', ?, ?), (42, 'wai', ?, ?)")
    .run(timestamp, timestamp, timestamp, timestamp);
  database.close();
}

test('持久化空数据库也必须通过停机命令完成媒体迁移', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-media-cutover-empty-'));
  const databasePath = join(directory, 'app.sqlite');
  const mediaRoot = join(directory, 'media');
  try {
    assert.throws(() => openCatalogDatabase({ databasePath }), OfflineMediaCutoverRequiredError);
    assert.equal(runMediaCutover({ databasePath, mediaRoot }).moved_count, 0);
    openCatalogDatabase({ databasePath }).close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('停机媒体迁移移动旧文件、更新路径并删除旧数据库字段', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-media-cutover-'));
  const databasePath = join(directory, 'app.sqlite');
  const mediaRoot = join(directory, 'media');
  const legacy = legacyDatabase(databasePath);
  legacy.close();
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  writeFileSync(join(mediaRoot, 'images', 'legacy.png'), Buffer.from('legacy-png'));
  try {
    assert.throws(() => openCatalogDatabase({ databasePath }), OfflineMediaCutoverRequiredError);
    const result = runMediaCutover({ databasePath, mediaRoot, makeId: () => '01234567-89ab-4def-8123-456789abcdef', makeRandomDigits: () => '54321' });
    assert.equal(result.status, 'complete');
    const database = openCatalogDatabase({ databasePath, repositoryRoot: historicalRepositoryRoot(directory) });
    try {
      const image = database.prepare('SELECT media_path FROM item_images WHERE id = 9').get();
      assert.equal(image.media_path, 'images/01/01234567-89ab-4def-8123-456789abcdef-54321.png');
      assert.equal(database.prepare('SELECT cover_media_path FROM characters WHERE id = 2').get().cover_media_path, image.media_path);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('item_images') WHERE name = 'local_path'").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('characters') WHERE name = 'cover_image_id'").get().count, 0);
      assert.equal(existsSync(join(mediaRoot, image.media_path)), true);
      assert.equal(existsSync(join(mediaRoot, 'images', 'legacy.png')), false);
    } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('停机媒体迁移跳过无法识别为图片的旧 .img 文件，并删除对应目录记录', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-media-cutover-skip-invalid-'));
  const databasePath = join(directory, 'app.sqlite');
  const mediaRoot = join(directory, 'media');
  const legacy = legacyDatabase(databasePath);
  legacy.prepare(`INSERT INTO item_images(id, owner_kind, owner_id, content_hash, local_path, media_path, sort_order, created_at, updated_at)
    VALUES (10, 'character', 2, 'invalid-hash', 'images/invalid.img', 'images/invalid.img', 1, ?, ?)` ).run(timestamp, timestamp);
  legacy.close();
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  writeFileSync(join(mediaRoot, 'images', 'legacy.png'), Buffer.from('legacy-png'));
  writeFileSync(join(mediaRoot, 'images', 'invalid.img'), Buffer.from('00000000ftypisom00000000'));
  try {
    const result = runMediaCutover({ databasePath, mediaRoot, makeId: () => '01234567-89ab-4def-8123-456789abcdef', makeRandomDigits: () => '54321' });
    const evidence = JSON.parse(readFileSync(result.evidence_path, 'utf8'));
    assert.equal(result.moved_count, 2);
    assert.equal(evidence.skipped[0].image_id, 10);
    assert.equal(evidence.skipped[0].source_path, 'images/invalid.img');
    assert.equal(evidence.skipped[0].reason, 'unsupported_image_bytes');
    const database = openCatalogDatabase({ databasePath, repositoryRoot: historicalRepositoryRoot(directory) });
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images').get().count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = 10').get().count, 0);
      assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 35);
    } finally { database.close(); }
    assert.equal(existsSync(join(mediaRoot, 'images', 'invalid.img')), false);
    assert.equal(existsSync(evidence.skipped[0].quarantine_path), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('已完成 005 的数据库再次执行停机命令会在未注册 015 时停在 014', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-media-cutover-post-upgrade-'));
  const databasePath = join(directory, 'app.sqlite');
  const mediaRoot = join(directory, 'media');
  const legacy = legacyDatabase(databasePath);
  legacy.close();
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  writeFileSync(join(mediaRoot, 'images', 'legacy.png'), Buffer.from('legacy-png'));
  try {
    runMediaCutover({ databasePath, mediaRoot, makeId: () => '01234567-89ab-4def-8123-456789abcdef', makeRandomDigits: () => '54321', applyPostMigrations() {} });
    const result = runMediaCutover({ databasePath, mediaRoot });
    assert.equal(result.already_applied, true);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 14);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'session_work_selections'").get().count, 1);
    }
    finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('006 失败后保留 005 的新文件路径并留下恢复证据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-media-cutover-post-failure-'));
  const databasePath = join(directory, 'app.sqlite');
  const mediaRoot = join(directory, 'media');
  const legacy = legacyDatabase(databasePath);
  legacy.close();
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  writeFileSync(join(mediaRoot, 'images', 'legacy.png'), Buffer.from('legacy-png'));
  try {
    let evidencePath;
    assert.throws(() => runMediaCutover({
      databasePath, mediaRoot, makeId: () => '01234567-89ab-4def-8123-456789abcdef', makeRandomDigits: () => '54321',
      applyPostMigrations() { throw new Error('simulated 006 failure'); }
    }), (error) => { evidencePath = error.evidencePath; return error.name === 'MediaCutoverError'; });
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(evidence.status, 'recovery_required');
    assert.equal(existsSync(join(mediaRoot, 'images', 'legacy.png')), false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5); }
    finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('006 失败后重试会保留 skipped ID 并删除无效图片记录', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-media-cutover-skipped-retry-'));
  const databasePath = join(directory, 'app.sqlite');
  const mediaRoot = join(directory, 'media');
  const legacy = legacyDatabase(databasePath);
  legacy.prepare(`INSERT INTO item_images(id, owner_kind, owner_id, content_hash, local_path, media_path, sort_order, created_at, updated_at)
    VALUES (10, 'character', 2, 'invalid-hash', 'images/invalid.img', 'images/invalid.img', 1, ?, ?)` ).run(timestamp, timestamp);
  legacy.close();
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  writeFileSync(join(mediaRoot, 'images', 'legacy.png'), Buffer.from('legacy-png'));
  writeFileSync(join(mediaRoot, 'images', 'invalid.img'), Buffer.from('00000000ftypisom00000000'));
  try {
    assert.throws(() => runMediaCutover({ databasePath, mediaRoot, makeId: () => '01234567-89ab-4def-8123-456789abcdef', makeRandomDigits: () => '54321', applyPostMigrations() { throw new Error('simulated 006 failure'); } }), MediaCutoverError);
    runMediaCutover({ databasePath, mediaRoot });
    const database = openCatalogDatabase({ databasePath });
    try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images WHERE id = 10').get().count, 0); }
    finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('停机迁移遇到目标冲突时保留旧文件和未迁移数据库', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-media-cutover-conflict-'));
  const databasePath = join(directory, 'app.sqlite');
  const mediaRoot = join(directory, 'media');
  const legacy = legacyDatabase(databasePath);
  legacy.close();
  const target = join(mediaRoot, 'images', '01', '01234567-89ab-4def-8123-456789abcdef-54321.png');
  mkdirSync(join(mediaRoot, 'images', '01'), { recursive: true });
  writeFileSync(join(mediaRoot, 'images', 'legacy.png'), Buffer.from('legacy-png'));
  writeFileSync(target, Buffer.from('existing-target'));
  try {
    assert.throws(
      () => runMediaCutover({ databasePath, mediaRoot, makeId: () => '01234567-89ab-4def-8123-456789abcdef', makeRandomDigits: () => '54321' }),
      (error) => error?.name === 'MediaCutoverError' && typeof error.evidencePath === 'string'
    );
    assert.equal(existsSync(join(mediaRoot, 'images', 'legacy.png')), true);
    assert.equal(readFileSync(target, 'utf8'), 'existing-target');
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4); } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('停机迁移在数据库写入失败后恢复已移动文件并记录可检查证据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-media-cutover-rollback-'));
  const databasePath = join(directory, 'app.sqlite');
  const mediaRoot = join(directory, 'media');
  const legacy = legacyDatabase(databasePath);
  legacy.close();
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  writeFileSync(join(mediaRoot, 'images', 'legacy.png'), Buffer.from('legacy-png'));
  try {
    let evidencePath;
    assert.throws(
      () => runMediaCutover({
        databasePath,
        mediaRoot,
        makeId: () => '01234567-89ab-4def-8123-456789abcdef',
        makeRandomDigits: () => '54321',
        readMigrationSql: () => 'BEGIN IMMEDIATE; SELECT * FROM table_that_does_not_exist; COMMIT;'
      }),
      (error) => {
        evidencePath = error?.evidencePath;
        return error?.name === 'MediaCutoverError' && typeof evidencePath === 'string';
      }
    );
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(evidence.status, 'failed_reverted');
    assert.deepEqual(evidence.recovery, []);
    assert.equal(existsSync(join(mediaRoot, 'images', 'legacy.png')), true);
    assert.equal(existsSync(join(mediaRoot, 'images', '01', '01234567-89ab-4def-8123-456789abcdef-54321.png')), false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4); } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('停机迁移无法恢复文件时保留待恢复路径证据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-media-cutover-recovery-required-'));
  const databasePath = join(directory, 'app.sqlite');
  const mediaRoot = join(directory, 'media');
  const legacy = legacyDatabase(databasePath);
  legacy.close();
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  writeFileSync(join(mediaRoot, 'images', 'legacy.png'), Buffer.from('legacy-png'));
  try {
    let evidencePath;
    assert.throws(
      () => runMediaCutover({
        databasePath,
        mediaRoot,
        makeId: () => '01234567-89ab-4def-8123-456789abcdef',
        makeRandomDigits: () => '54321',
        readMigrationSql: () => 'BEGIN IMMEDIATE; SELECT * FROM table_that_does_not_exist; COMMIT;',
        reverse: () => { throw new Error('simulated rollback failure'); }
      }),
      (error) => {
        evidencePath = error?.evidencePath;
        return error?.name === 'MediaCutoverError' && typeof evidencePath === 'string';
      }
    );
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.equal(evidence.status, 'recovery_required');
    assert.equal(evidence.recovery[0].source_path, 'images/legacy.png');
    assert.equal(existsSync(join(mediaRoot, 'images', 'legacy.png')), false);
    assert.equal(existsSync(join(mediaRoot, 'images', '01', '01234567-89ab-4def-8123-456789abcdef-54321.png')), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('停机迁移按数据库候选顺序修复空值和无效作品封面', () => {
  const directory = mkdtempSync(join(tmpdir(), 'noobai-media-cutover-cover-'));
  const databasePath = join(directory, 'app.sqlite');
  const mediaRoot = join(directory, 'media');
  const legacy = legacyDatabase(databasePath);
  legacy.prepare(`INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
    VALUES (4, 1, 'Alpha', 'alpha', '[]', 'line', 1, ?, ?)` ).run(timestamp, timestamp);
  legacy.prepare(`INSERT INTO styles(id, source_version, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at)
    VALUES (3, 'WAI', 'Style', 'style', '[]', 'paper', 1, ?, ?)` ).run(timestamp, timestamp);
  legacy.prepare(`INSERT INTO item_images(id, owner_kind, owner_id, content_hash, local_path, media_path, sort_order, created_at, updated_at)
    VALUES (10, 'character', 4, 'alpha-hash', 'images/alpha.png', 'images/alpha.png', 1, ?, ?),
           (11, 'style', 3, 'style-hash', 'images/style.png', 'images/style.png', 0, ?, ?)` ).run(timestamp, timestamp, timestamp, timestamp);
  legacy.exec('DROP TRIGGER works_cover_media_path_must_belong_before_update;');
  legacy.prepare('UPDATE works SET cover_media_path = ? WHERE id = 1').run('images/style.png');
  legacy.prepare('UPDATE characters SET cover_media_path = NULL WHERE id = 2').run();
  legacy.prepare('UPDATE styles SET cover_media_path = NULL WHERE id = 3').run();
  legacy.close();
  mkdirSync(join(mediaRoot, 'images'), { recursive: true });
  for (const name of ['legacy.png', 'alpha.png', 'style.png']) writeFileSync(join(mediaRoot, 'images', name), Buffer.from(name));
  const ids = [
    '01234567-89ab-4def-8123-456789abcdef',
    '11234567-89ab-4def-8123-456789abcdef',
    '21234567-89ab-4def-8123-456789abcdef'
  ];
  try {
    runMediaCutover({ databasePath, mediaRoot, makeId: () => ids.shift(), makeRandomDigits: () => '54321' });
    seedStyleBaseModels(databasePath);
    const database = openCatalogDatabase({ databasePath, mediaRoot });
    try {
      assert.equal(database.prepare('SELECT cover_media_path FROM works WHERE id = 1').get().cover_media_path, 'images/11/11234567-89ab-4def-8123-456789abcdef-54321.png');
      assert.equal(database.prepare('SELECT cover_media_path FROM characters WHERE id = 2').get().cover_media_path, 'images/01/01234567-89ab-4def-8123-456789abcdef-54321.png');
      assert.equal(database.prepare('SELECT cover_media_path FROM styles WHERE id = 3').get().cover_media_path, 'images/21/21234567-89ab-4def-8123-456789abcdef-54321.png');
    } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
