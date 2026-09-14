import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../../app/catalog/database.mjs';
import { runMediaCutover } from '../../../app/database/media-cutover.mjs';
import { assertRecoveryBackupComplete, createRecoveryBackup } from '../../../app/maintenance/recovery-workflow.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

function root(t) {
  const value = mkdtempSync(join(tmpdir(), 'noobai-recovery-'));
  t.after(() => rmSync(value, { recursive: true, force: true }));
  return value;
}

function openPersistentCatalogDatabase(dataRoot) {
  const databasePath = join(dataRoot, 'app.sqlite');
  runMediaCutover({ databasePath, mediaRoot: join(dataRoot, 'media') });
  return openCatalogDatabase({ databasePath, includeBuiltinComfyuiCatalog: false });
}

test('S16-B01 creates and reopens a complete recovery backup without a deletion path', (t) => {
  const dataRoot = root(t);
  mkdirSync(join(dataRoot, 'reports'), { recursive: true });
  mkdirSync(join(dataRoot, 'media', 'images'), { recursive: true });
  openPersistentCatalogDatabase(dataRoot).close();
  writeFileSync(join(dataRoot, 'crawl_state.json'), '{"status":"paused"}');
  writeFileSync(join(dataRoot, 'reports', 'latest.json'), '{"status":"paused"}');
  writeFileSync(join(dataRoot, 'media', 'images', 'one.png'), PNG);

  const backup = createRecoveryBackup({ dataRoot, name: 'repair-proof' });

  assert.equal(backup.mediaCount, 1);
  assert.equal(existsSync(join(backup.backupRoot, 'app.sqlite')), true);
  assert.equal(assertRecoveryBackupComplete({ dataRoot, name: 'repair-proof' }), backup.backupRoot);
});

test('S16-B02 preserves database and media hashes in the backup manifest', (t) => {
  const dataRoot = root(t);
  mkdirSync(join(dataRoot, 'media', 'images'), { recursive: true });
  openPersistentCatalogDatabase(dataRoot).close();
  writeFileSync(join(dataRoot, 'media', 'images', 'one.png'), PNG);

  const backup = createRecoveryBackup({ dataRoot, name: 'hash-proof' });
  const manifest = JSON.parse(readFileSync(join(backup.backupRoot, 'backup-manifest.json'), 'utf8'));
  const mediaEntry = manifest.media.find((entry) => entry.path === 'media/images/one.png');

  assert.equal(mediaEntry.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.equal(assertRecoveryBackupComplete({ dataRoot, name: 'hash-proof' }), backup.backupRoot);
});

test('S18-B03 rejects a symbolic-link recovery root before creating a backup', (t) => {
  const dataRoot = root(t);
  const outside = root(t);
  mkdirSync(join(dataRoot, 'media'), { recursive: true });
  openPersistentCatalogDatabase(dataRoot).close();
  const recoveryRoot = join(dataRoot, 'recovery');
  symlinkSync(outside, recoveryRoot);
  assert.throws(() => createRecoveryBackup({ dataRoot, recoveryRoot, name: 'blocked' }), /symbolic link/u);
});
