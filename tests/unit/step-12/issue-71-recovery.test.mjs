import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { runMediaCutover } from '../../../app/database/media-cutover.mjs';
import { assertRecoveryBackupComplete, createRecoveryBackup } from '../../../app/maintenance/recovery-workflow.mjs';

const NOW = '2026-08-03T00:00:00Z';
const MODEL_IMAGE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

function fixtureRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'noobai-issue71-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function createMigratedDataRoot(t) {
  const root = fixtureRoot(t);
  const dataRoot = join(root, 'data');
  const databasePath = join(dataRoot, 'app.sqlite');
  const mediaRoot = join(dataRoot, 'media');
  mkdirSync(mediaRoot, { recursive: true });
  runMediaCutover({ databasePath, mediaRoot });
  return Object.freeze({ dataRoot, databasePath, mediaRoot });
}

function modelImageFixture(fixture, { orphan = false } = {}) {
  const mediaPath = orphan ? 'images/orphan-model.png' : 'images/model-cover.png';
  const mediaFile = join(fixture.mediaRoot, mediaPath);
  mkdirSync(join(fixture.mediaRoot, 'images'), { recursive: true });
  writeFileSync(mediaFile, MODEL_IMAGE, { mode: 0o600 });
  const contentHash = createHash('sha256').update(MODEL_IMAGE).digest('hex');
  const database = openCatalogDatabase({ databasePath: fixture.databasePath, includeBuiltinComfyuiCatalog: false });
  try {
    if (orphan) database.exec('DROP TRIGGER item_images_owner_exists_before_insert');
    else {
      database.prepare('INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(1, 'WAI', NOW, NOW);
      database.prepare(`INSERT INTO generation_models(
        id, base_model_id, file_name, file_format, precision_or_quantization,
        description, usage, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(10, 1, 'model.safetensors', 'safetensors', 'fp16', 'model description', 'model usage', NOW, NOW);
    }
    database.prepare(`INSERT INTO item_images(
      id, owner_kind, owner_id, content_hash, media_path, sort_order, created_at, updated_at
    ) VALUES (?, 'model', ?, ?, ?, 0, ?, ?)`)
      .run(orphan ? 901 : 900, orphan ? 404 : 10, contentHash, mediaPath, NOW, NOW);
  } finally {
    database.close();
  }
  return Object.freeze({ contentHash, mediaPath });
}

test('真实正式媒体迁移后的 generation model 图片会进入 createRecoveryBackup 及其快照校验', (t) => {
  const fixture = createMigratedDataRoot(t);
  const image = modelImageFixture(fixture);

  const backup = createRecoveryBackup({ dataRoot: fixture.dataRoot, name: 'model-media' });
  const manifest = JSON.parse(readFileSync(join(backup.backupRoot, 'backup-manifest.json'), 'utf8'));
  const manifestEntry = manifest.media.find((entry) => entry.path === `media/${image.mediaPath}`);

  assert.equal(backup.mediaCount, 1);
  assert.deepEqual(manifestEntry, { path: `media/${image.mediaPath}`, sha256: image.contentHash });
  assert.deepEqual(readFileSync(join(backup.backupRoot, 'media', image.mediaPath)), MODEL_IMAGE);
  assert.equal(assertRecoveryBackupComplete({ dataRoot: fixture.dataRoot, name: 'model-media' }), backup.backupRoot);

  const snapshot = new DatabaseSync(join(backup.backupRoot, 'app.sqlite'), { readOnly: true });
  try {
    assert.deepEqual({ ...snapshot.prepare('SELECT id, base_model_id FROM generation_models WHERE id = 10').get() }, { id: 10, base_model_id: 1 });
    assert.deepEqual(
      { ...snapshot.prepare('SELECT owner_kind, owner_id, content_hash, media_path FROM item_images WHERE id = 900').get() },
      { owner_kind: 'model', owner_id: 10, content_hash: image.contentHash, media_path: image.mediaPath }
    );
  } finally {
    snapshot.close();
  }
});

test('真实正式媒体迁移后的孤立 model 图片会使 createRecoveryBackup 返回数据库关系完整性错误', (t) => {
  const fixture = createMigratedDataRoot(t);
  modelImageFixture(fixture, { orphan: true });

  assert.throws(
    () => createRecoveryBackup({ dataRoot: fixture.dataRoot, name: 'orphan-model-media' }),
    /backup database relationship integrity failed/u
  );
  assert.equal(existsSync(join(fixture.dataRoot, 'recovery', 'orphan-model-media')), false);
});
