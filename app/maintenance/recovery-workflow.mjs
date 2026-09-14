import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openCatalogDatabase } from '../catalog/database.mjs';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function safeBackupName(name) {
  if (typeof name !== 'string' || name === '.' || name === '..' || name.length === 0 || isAbsolute(name) || name.includes('/') || name.includes('\\') || !/^[A-Za-z0-9._-]+$/u.test(name)) {
    throw new Error('recovery backup name is invalid');
  }
  return name;
}

function assertRealDirectoryChain(path, label) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`${label} is missing`);
  const status = lstatSync(resolved);
  if (status.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
  if (!status.isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
}

function assertRecoveryRoot(dataRoot, recoveryRoot, { create = false } = {}) {
  const data = assertRealDirectoryChain(dataRoot, 'data root');
  const root = resolve(recoveryRoot);
  if (root !== resolve(data, 'recovery')) throw new Error('recovery root must be the fixed data/recovery directory');
  if (!existsSync(root) && create) mkdirSync(root, { recursive: false, mode: 0o700 });
  const relativeRoot = relative(data, root);
  let current = data;
  for (const part of relativeRoot.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    assertRealDirectoryChain(current, 'recovery root');
  }
  return root;
}

function directBackupChild(dataRoot, recoveryRoot, name, { mustExist = false } = {}) {
  const root = assertRecoveryRoot(dataRoot, recoveryRoot);
  const checkedName = safeBackupName(name);
  const target = resolve(root, checkedName);
  if (dirname(target) !== root || basename(target) !== checkedName) throw new Error('recovery backup escapes its root');
  if (mustExist) {
    if (!existsSync(target)) throw new Error('recovery backup does not exist');
    const status = lstatSync(target);
    if (status.isSymbolicLink()) throw new Error('recovery backup must not be a symbolic link');
    if (!status.isDirectory()) throw new Error('recovery backup must be a directory');
  }
  return target;
}

function walkRegularFiles(root, label, prefix = '') {
  if (!existsSync(root)) return [];
  const status = lstatSync(root);
  if (status.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
  if (!status.isDirectory()) throw new Error(`${label} must be a directory`);
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = resolve(root, entry.name);
    const entryStatus = lstatSync(absolutePath);
    if (entryStatus.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
    if (entryStatus.isDirectory()) return walkRegularFiles(absolutePath, label, relativePath);
    if (!entryStatus.isFile()) throw new Error(`${label} contains an unsupported entry`);
    return [{ relativePath, absolutePath }];
  });
}

function sqliteString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function copyDatabaseSnapshot(source, target) {
  const database = new DatabaseSync(source);
  try {
    database.exec(`VACUUM INTO ${sqliteString(target)}`);
  } finally {
    database.close();
  }
}

function copyAndVerify(source, target, copyFile) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFile(source, target);
  if (sha256(source) !== sha256(target)) throw new Error(`backup file hash verification failed: ${source}`);
}

function backupManifestPath(backupRoot) {
  return resolve(backupRoot, 'backup-manifest.json');
}

function backupCompletePath(backupRoot) {
  return resolve(backupRoot, 'backup-complete.json');
}

function readBackupManifest(backupRoot) {
  let manifest;
  let complete;
  try {
    manifest = JSON.parse(readFileSync(backupManifestPath(backupRoot), 'utf8'));
    complete = JSON.parse(readFileSync(backupCompletePath(backupRoot), 'utf8'));
  } catch {
    throw new Error('recovery backup is incomplete');
  }
  if (manifest?.backup_version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.media) || complete?.backup_version !== 1 || complete.manifest_sha256 !== sha256(backupManifestPath(backupRoot))) throw new Error('recovery backup manifest is invalid');
  return manifest;
}

function assertSnapshotReferenceIntegrity(backupRoot, manifest) {
  const snapshotPath = resolveDataPath(backupRoot, 'app.sqlite', 'backup database');
  const database = openReadOnlyDatabase(snapshotPath, 'backup database');
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('backup database integrity check failed');
    assertDatabaseRelationshipIntegrity(database, 'backup database');
    let imageRows;
    try {
      const imageColumns = new Set(database.prepare('PRAGMA table_info(item_images)').all().map(({ name }) => name));
      const mediaColumn = imageColumns.has('media_path') ? 'media_path' : imageColumns.has('local_path') ? 'local_path' : null;
      if (mediaColumn === null) throw new Error('image path column is missing');
      imageRows = database.prepare(`SELECT owner_kind, owner_id, ${mediaColumn} AS media_path, content_hash FROM item_images ORDER BY id`).all();
    } catch {
      throw new Error('backup database schema is incompatible');
    }
    const mediaEntries = new Map(manifest.media.map((entry) => [entry.path, entry]));
    const mediaRoot = imageRows.length > 0 ? resolveDataPath(backupRoot, 'media', 'backup media', { directory: true }) : null;
    for (const image of imageRows) {
      if (!['work', 'character', 'style', 'model'].includes(image.owner_kind) || !Number.isInteger(image.owner_id) || typeof image.content_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(image.content_hash)) throw new Error('backup database image reference is invalid');
      const mediaPath = resolveDataPath(mediaRoot, image.media_path, 'backup media');
      if (!lstatSync(mediaPath).isFile()) throw new Error('backup media must be a regular file');
      const manifestPath = `media/${image.media_path}`;
      const entry = mediaEntries.get(manifestPath);
      if (!entry) throw new Error('backup media is missing from manifest');
      if (entry.sha256 !== image.content_hash || sha256(mediaPath) !== image.content_hash) throw new Error('backup media hash verification failed');
    }
  } finally {
    database.close();
  }
}

function assertDatabaseRelationshipIntegrity(database, label) {
  let foreignKeyViolations;
  let invalidRows;
  try {
    foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all();
    invalidRows = database.prepare(`SELECT 'character-parent' AS kind, c.id AS id
      FROM characters c LEFT JOIN works w ON w.id = c.work_id
      WHERE w.id IS NULL
      UNION ALL
      SELECT i.owner_kind AS kind, i.id AS id
      FROM item_images i
      LEFT JOIN works w ON i.owner_kind = 'work' AND w.id = i.owner_id
      LEFT JOIN characters c ON i.owner_kind = 'character' AND c.id = i.owner_id
      LEFT JOIN styles s ON i.owner_kind = 'style' AND s.id = i.owner_id
      LEFT JOIN generation_models m ON i.owner_kind = 'model' AND m.id = i.owner_id
      WHERE i.owner_kind NOT IN ('work', 'character', 'style', 'model')
         OR (i.owner_kind = 'work' AND w.id IS NULL)
         OR (i.owner_kind = 'character' AND c.id IS NULL)
         OR (i.owner_kind = 'style' AND s.id IS NULL)
         OR (i.owner_kind = 'model' AND m.id IS NULL)`).all();
  } catch {
    throw new Error(`${label} schema is incompatible`);
  }
  if (foreignKeyViolations.length > 0 || invalidRows.length > 0) throw new Error(`${label} relationship integrity failed`);
}

function assertCompleteBackup(backupRoot) {
  const manifest = readBackupManifest(backupRoot);
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || !/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9.][A-Za-z0-9._/-]*$/u.test(entry.path) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) || seen.has(entry.path)) throw new Error('recovery backup manifest is invalid');
    seen.add(entry.path);
    const path = resolveDataPath(backupRoot, entry.path, 'recovery backup file');
    if (sha256(path) !== entry.sha256) throw new Error('recovery backup manifest hash verification failed');
  }
  const mediaFiles = manifest.files.filter((entry) => entry.path.startsWith('media/'));
  if (manifest.media.length !== mediaFiles.length || !manifest.media.every((entry) => entry && seen.has(entry.path) && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(entry.sha256) && mediaFiles.some((file) => file.path === entry.path && file.sha256 === entry.sha256))) throw new Error('recovery backup manifest is invalid');
  assertSnapshotReferenceIntegrity(backupRoot, manifest);
  return manifest;
}

export function assertRecoveryBackupComplete({ dataRoot, recoveryRoot = resolve(dataRoot, 'recovery'), name } = {}) {
  const root = assertRecoveryRoot(dataRoot, recoveryRoot);
  const backupRoot = directBackupChild(dataRoot, root, name, { mustExist: true });
  assertCompleteBackup(backupRoot);
  return backupRoot;
}

function assertRegularDatabase(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`${label} must be a regular file`);
}

function openReadOnlyDatabase(path, label) {
  assertRegularDatabase(path, label);
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new Error(`cannot open ${label} read-only: ${error.message}`, { cause: error });
  }
}

function isInside(root, candidate) {
  const path = relative(resolve(root), resolve(candidate));
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

function resolveDataPath(root, relativePath, label, { dataPrefix = false, mustExist = true, directory = false } = {}) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || isAbsolute(relativePath) || relativePath.includes('\\')) throw new Error(`${label} path is invalid`);
  const relativeValue = dataPrefix && relativePath.startsWith('data/') ? relativePath.slice(5) : relativePath;
  const pieces = relativeValue.split('/');
  if (pieces.some((piece) => piece.length === 0 || piece === '.' || piece === '..')) throw new Error(`${label} path is invalid`);
  const base = resolve(root);
  if (!existsSync(base) || lstatSync(base).isSymbolicLink()) throw new Error(`${label} root is invalid`);
  const target = resolve(base, relativeValue);
  if (!isInside(base, target)) throw new Error(`${label} path escapes its root`);
  let current = base;
  for (const piece of pieces) {
    current = resolve(current, piece);
    if (!existsSync(current)) {
      if (mustExist) throw new Error(`${label} is missing`);
      break;
    }
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} path contains a symbolic link`);
  }
  if (mustExist && directory && !lstatSync(target).isDirectory()) throw new Error(`${label} must be a directory`);
  return target;
}

export function createRecoveryBackup({ dataRoot, recoveryRoot = resolve(dataRoot, 'recovery'), name, now = () => new Date(), copyFile = copyFileSync, rename = renameSync } = {}) {
  const root = assertRecoveryRoot(dataRoot, recoveryRoot, { create: true });
  const backupName = name ?? `repair-${now().toISOString().replace(/[:.]/gu, '-')}`;
  const backupRoot = directBackupChild(dataRoot, root, backupName);
  if (existsSync(backupRoot)) {
    assertCompleteBackup(backupRoot);
    throw new Error('recovery backup already exists');
  }
  const stagingRoot = resolve(root, `.${safeBackupName(backupName)}.staging-${process.pid}-${Date.now()}`);
  if (existsSync(stagingRoot)) throw new Error('recovery backup staging directory already exists');
  mkdirSync(stagingRoot, { mode: 0o700 });
  try {
    const databasePath = resolveDataPath(dataRoot, 'app.sqlite', 'production database');
    assertRegularDatabase(databasePath, 'production database');
    const snapshotPath = resolve(stagingRoot, 'app.sqlite');
    copyDatabaseSnapshot(databasePath, snapshotPath);
    assertRegularDatabase(snapshotPath, 'backup database');
    for (const file of ['crawl_state.json', '.2x-nz-crawlee-records.json']) {
      const source = resolve(dataRoot, file);
      if (!existsSync(source)) continue;
      if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isFile()) throw new Error(`backup ${file} must be a regular file`);
      copyAndVerify(source, resolve(stagingRoot, file), copyFile);
    }
    for (const report of walkRegularFiles(resolve(dataRoot, 'reports'), 'reports')) copyAndVerify(report.absolutePath, resolve(stagingRoot, 'reports', report.relativePath), copyFile);
    const media = walkRegularFiles(resolve(dataRoot, 'media'), 'media').map((file) => {
      const path = `media/${file.relativePath}`;
      const destination = resolve(stagingRoot, path);
      copyAndVerify(file.absolutePath, destination, copyFile);
      return { path, sha256: sha256(destination) };
    });
    writeFileSync(resolve(stagingRoot, 'media-manifest.json'), `${JSON.stringify({ manifest_version: 1, created_at: now().toISOString(), files: media }, null, 2)}\n`, { mode: 0o600 });
    const files = walkRegularFiles(stagingRoot, 'backup staging').map((file) => ({ path: file.relativePath, sha256: sha256(file.absolutePath) }));
    const manifest = { backup_version: 1, created_at: now().toISOString(), files, media };
    writeFileSync(backupManifestPath(stagingRoot), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    assertSnapshotReferenceIntegrity(stagingRoot, manifest);
    writeFileSync(backupCompletePath(stagingRoot), `${JSON.stringify({ backup_version: 1, manifest_sha256: sha256(backupManifestPath(stagingRoot)) }, null, 2)}\n`, { mode: 0o600 });
    assertCompleteBackup(stagingRoot);
    rename(stagingRoot, backupRoot);
    assertCompleteBackup(backupRoot);
    return Object.freeze({ backupRoot, mediaCount: media.length });
  } catch (error) {
    if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}
