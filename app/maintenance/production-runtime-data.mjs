import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { productionListenerPorts, tcpPortIsListening } from './production-network-probe.mjs';

const RUNTIME_FILES = Object.freeze([
  '.2x-nz-crawlee-records.json',
  'app.sqlite',
  'crawl_state.json',
  'file-cleanup.json'
]);
const RUNTIME_DIRECTORIES = Object.freeze(['media', 'raw', 'reports']);
const BACKUP_MANIFEST_FILE = 'backup-manifest.json';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isInside(root, candidate, { allowRoot = false } = {}) {
  const value = relative(resolve(root), resolve(candidate));
  return (allowRoot && value === '') || (value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function assertDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const status = lstatSync(path);
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!status.isDirectory()) throw new Error(`${label} must be a directory`);
  return resolve(path);
}

function assertRegularFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const status = lstatSync(path);
  if (status.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (!status.isFile()) throw new Error(`${label} must be a regular file`);
  return resolve(path);
}

function assertNoSymbolicLinks(root, target, label) {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  if (!isInside(absoluteRoot, absoluteTarget, { allowRoot: true })) throw new Error(`${label} escapes its root`);
  let current = absoluteRoot;
  assertDirectory(current, `${label} root`);
  for (const part of relative(absoluteRoot, absoluteTarget).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
  }
}

function assertRelativeRuntimePath(path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('\\')) throw new Error('runtime data path is invalid');
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('runtime data path is invalid');
  if (RUNTIME_FILES.includes(path)) return path;
  if (path === '.installation/.env' || path.startsWith('.installation/config/')) return path;
  if (RUNTIME_DIRECTORIES.some((directory) => path.startsWith(`${directory}/`))) return path;
  throw new Error('runtime data path is not in the defined runtime set');
}

function walkRegularFiles(root, label, prefix = '') {
  const directory = assertDirectory(root, label);
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const status = lstatSync(absolutePath);
    if (status.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
    if (status.isDirectory()) files.push(...walkRegularFiles(absolutePath, label, relativePath));
    else if (status.isFile()) files.push({ absolutePath, relativePath });
    else throw new Error(`${label} contains an unsupported entry`);
  }
  return files;
}

function collectRuntimeFiles(dataRoot) {
  const root = assertDirectory(dataRoot, 'runtime data root');
  const files = [];
  for (const runtimeFile of RUNTIME_FILES) {
    const absolutePath = resolve(root, runtimeFile);
    if(runtimeFile !== 'app.sqlite' && !existsSync(absolutePath)) continue;
    assertRegularFile(absolutePath, `runtime data file ${runtimeFile}`);
    files.push({ absolutePath, relativePath: runtimeFile });
  }
  for (const directory of RUNTIME_DIRECTORIES) {
    const directoryRoot = resolve(root, directory);
    if(directory !== 'media' && !existsSync(directoryRoot)) continue;
    for (const file of walkRegularFiles(directoryRoot, `runtime data directory ${directory}`)) {
      const relativePath = `${directory}/${file.relativePath}`;
      assertRelativeRuntimePath(relativePath);
      files.push({ absolutePath: file.absolutePath, relativePath });
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function ensureDirectory(path, label) {
  const target = resolve(path);
  const ancestors = [];
  let current = target;
  while (!existsSync(current)) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) throw new Error(`${label} has no existing parent directory`);
    current = parent;
  }
  assertDirectory(current, label);
  for (const directory of ancestors.reverse()) mkdirSync(directory, { mode: 0o700 });
  return assertDirectory(target, label);
}

function destinationPath(root, relativePath, label) {
  const target = resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error(`${label} escapes its root`);
  assertNoSymbolicLinks(root, dirname(target), label);
  ensureDirectory(dirname(target), `${label} parent directory`);
  if (existsSync(target)) assertRegularFile(target, label);
  return target;
}

function copyAndVerify(source, target, label, copyFile = copyFileSync, hashFile = sha256) {
  copyFile(source, target);
  if (hashFile(source) !== hashFile(target)) throw new Error(`${label} hash verification failed`);
}

function assertRecoveryRoot(dataRoot, { create = false } = {}) {
  const root = assertDirectory(dataRoot, 'runtime data root');
  const recoveryRoot = resolve(root, 'recovery');
  if (existsSync(recoveryRoot)) assertDirectory(recoveryRoot, 'recovery root');
  else if (create) mkdirSync(recoveryRoot, { mode: 0o700 });
  else throw new Error('recovery root is missing');
  return assertDirectory(recoveryRoot, 'recovery root');
}

function safeBackupName(name) {
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..' || !/^[A-Za-z0-9._-]+$/u.test(name)) throw new Error('backup directory name is invalid');
  return name;
}

function directBackupDirectory(dataRoot, name, { mustExist = false } = {}) {
  const recoveryRoot = assertRecoveryRoot(dataRoot);
  const target = resolve(recoveryRoot, safeBackupName(name));
  if (dirname(target) !== recoveryRoot || basename(target) !== name) throw new Error('backup directory escapes data/recovery');
  if (mustExist) assertDirectory(target, 'backup directory');
  return target;
}

function timestampName(now) {
  return now.toISOString().replace(/[:.]/gu, '-');
}

function createBackupDirectory(dataRoot, now) {
  const recoveryRoot = assertRecoveryRoot(dataRoot, { create: true });
  const base = timestampName(now);
  let name = base;
  for (let sequence = 1; existsSync(resolve(recoveryRoot, name)); sequence += 1) name = `${base}-${sequence}`;
  const backupRoot = resolve(recoveryRoot, name);
  const stagingRoot = resolve(recoveryRoot, `.${name}.staging-${process.pid}`);
  if (existsSync(stagingRoot)) throw new Error('backup staging directory already exists');
  mkdirSync(stagingRoot, { mode: 0o700 });
  return { backupRoot, name, stagingRoot };
}

function readManifest(backupRoot) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(backupRoot, BACKUP_MANIFEST_FILE), 'utf8'));
  } catch {
    throw new Error('backup manifest is missing or malformed');
  }
  if (!manifest || manifest.backup_version !== 1 || typeof manifest.created_at !== 'string' || Number.isNaN(Date.parse(manifest.created_at)) || !Array.isArray(manifest.files)) {
    throw new Error('backup manifest is invalid');
  }
  return manifest;
}

function backupFilesOnDisk(backupRoot) {
  const files = walkRegularFiles(backupRoot, 'backup directory')
    .map((file) => file.relativePath)
    .filter((path) => path !== BACKUP_MANIFEST_FILE);
  return files.sort();
}

function assertVerifiedBackupRoot(backupRoot, { hashFile = sha256 } = {}) {
  assertDirectory(backupRoot, 'backup directory');
  const manifest = readManifest(backupRoot);
  const manifestPaths = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error('backup manifest is invalid');
    const path = assertRelativeRuntimePath(entry.path);
    if (manifestPaths.has(path)) throw new Error('backup manifest lists a file more than once');
    manifestPaths.add(path);
    const source = resolve(backupRoot, path);
    if (!isInside(backupRoot, source)) throw new Error('backup manifest path escapes backup directory');
    assertNoSymbolicLinks(backupRoot, source, 'backup file');
    assertRegularFile(source, 'backup file');
    if (hashFile(source) !== entry.sha256) throw new Error('backup manifest hash verification failed');
  }
  for (const runtimeFile of ['app.sqlite']) {
    if (!manifestPaths.has(runtimeFile)) throw new Error(`backup manifest is missing required runtime file: ${runtimeFile}`);
  }
  const filesOnDisk = backupFilesOnDisk(backupRoot);
  if (filesOnDisk.length !== manifestPaths.size || filesOnDisk.some((path) => !manifestPaths.has(path))) {
    throw new Error('backup directory contains a file not listed in its manifest');
  }
  return { backupRoot, manifest };
}

function assertVerifiedBackup(dataRoot, backupName, options = {}) {
  const backupRoot = directBackupDirectory(dataRoot, backupName, { mustExist: true });
  return assertVerifiedBackupRoot(backupRoot, options);
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') throw new Error(`cannot inspect recorded production PID ${pid}`, { cause: error });
    throw error;
  }
}

function readProductionPid(productionRoot) {
  const pidFile = resolve(productionRoot, 'runtime', 'run', 'app.pid');
  if (!existsSync(pidFile)) return null;
  assertNoSymbolicLinks(productionRoot, pidFile, 'production PID file');
  assertRegularFile(pidFile, 'production PID file');
  const value = readFileSync(pidFile, 'utf8').trim();
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('production PID file is invalid');
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('production PID file is invalid');
  return { path: pidFile, pid };
}

export async function assertProductionStopped({
  productionRoot,
  runtimeConfiguration,
  isPidAlive = pidIsAlive,
  isPortListening = tcpPortIsListening
} = {}) {
  const root = assertDirectory(productionRoot, 'production root');
  const ports = productionListenerPorts(runtimeConfiguration);
  const recorded = readProductionPid(root);
  if (recorded !== null) {
    if (isPidAlive(recorded.pid)) throw new Error(`production application PID ${recorded.pid} is still running`);
    throw new Error(`production PID file remains after process ${recorded.pid} exited`);
  }
  for (const port of ports) {
    if (await isPortListening(port)) throw new Error(`configured port ${port} is already listening`);
  }
}

function checkpointProductionDatabase(databasePath, databaseFactory = (path) => new DatabaseSync(path)) {
  const database = databaseFactory(databasePath);
  try {
    const result = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (result === null || typeof result !== 'object' || !Number.isInteger(result.busy) || !Number.isInteger(result.log) || !Number.isInteger(result.checkpointed)) {
      throw new Error('SQLite WAL checkpoint returned an invalid result');
    }
    if (result.busy !== 0) throw new Error(`SQLite WAL checkpoint is busy (busy=${result.busy}, log=${result.log}, checkpointed=${result.checkpointed})`);
    if (result.log !== -1 && result.log !== result.checkpointed) {
      throw new Error(`SQLite WAL is not fully merged after checkpoint (log=${result.log}, checkpointed=${result.checkpointed})`);
    }
  } catch (error) {
    if (error?.message?.startsWith('SQLite WAL checkpoint')) throw error;
    throw new Error(`SQLite WAL checkpoint failed: ${error.message}`, { cause: error });
  } finally {
    database.close();
  }
}

function assertNoLiveProductionProcess(productionRoot) {
  const recorded = readProductionPid(productionRoot);
  if (recorded === null) return;
  try {
    if (!pidIsAlive(recorded.pid)) return;
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw new Error('cannot verify whether the production application PID is stopped', { cause: error });
  }
  throw new Error('production application PID is still running');
}

function parseBackupArgument(argument) {
  if (typeof argument !== 'string' || isAbsolute(argument) || argument.includes('\\')) throw new Error('--backup must be a relative data/recovery directory');
  const parts = argument.split('/');
  if (parts.length !== 3 || parts[0] !== 'data' || parts[1] !== 'recovery') throw new Error('--backup must name a direct data/recovery child directory');
  return safeBackupName(parts[2]);
}

export async function createProductionRuntimeBackup({
  dataRoot,
  productionRoot = resolve(dataRoot, '..'),
  runtimeConfiguration,
  isPidAlive = pidIsAlive,
  isPortListening = tcpPortIsListening,
  databaseFactory = (path) => new DatabaseSync(path),
  copyFile = copyFileSync,
  hashFile = sha256,
  now = new Date(),
  includeInstallationConfiguration = false
} = {}) {
  await assertProductionStopped({ productionRoot, runtimeConfiguration, isPidAlive, isPortListening });
  const resolvedDataRoot = assertDirectory(dataRoot, 'runtime data root');
  const databasePath = assertRegularFile(resolve(resolvedDataRoot, 'app.sqlite'), 'production database');
  checkpointProductionDatabase(databasePath, databaseFactory);
  const sourceFiles = collectRuntimeFiles(resolvedDataRoot);
  if(includeInstallationConfiguration) {
    const environment=assertRegularFile(resolve(productionRoot,'.env'),'installation .env');
    sourceFiles.push({absolutePath:environment,relativePath:'.installation/.env'});
    for(const file of walkRegularFiles(resolve(productionRoot,'config'),'installation config')) sourceFiles.push({absolutePath:file.absolutePath,relativePath:`.installation/config/${file.relativePath}`});
  }
  const { backupRoot, name, stagingRoot } = createBackupDirectory(dataRoot, now);
  let published = false;
  try {
    const manifestFiles = sourceFiles.map(({ absolutePath, relativePath }) => {
      const target = destinationPath(stagingRoot, relativePath, 'backup destination');
      copyAndVerify(absolutePath, target, 'backup file', copyFile, hashFile);
      return { path: relativePath, sha256: hashFile(target) };
    });
    const manifest = { backup_version: 1, created_at: now.toISOString(), files: manifestFiles };
    writeFileSync(resolve(stagingRoot, BACKUP_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    assertVerifiedBackupRoot(stagingRoot, { hashFile });
    renameSync(stagingRoot, backupRoot);
    published = true;
    assertVerifiedBackup(resolvedDataRoot, name, { hashFile });
    return Object.freeze({ backupRoot, name, createdAt: manifest.created_at });
  } catch (error) {
    if (published && existsSync(backupRoot)) rmSync(backupRoot, { recursive: true, force: true });
    if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function restoreProductionRuntimeBackup({ productionRoot, backupArgument } = {}) {
  const root = assertDirectory(productionRoot, 'production root');
  const dataRoot = resolve(root, 'data');
  const backupName = parseBackupArgument(backupArgument);
  assertNoLiveProductionProcess(root);
  const { backupRoot, manifest } = assertVerifiedBackup(dataRoot, backupName);

  const staging=mkdtempSync(resolve(dataRoot,'recovery','.restore-'));
  const prepared=resolve(staging,'prepared'),previous=resolve(staging,'previous');
  mkdirSync(prepared);mkdirSync(previous);
  const targets=[...RUNTIME_FILES,...RUNTIME_DIRECTORIES,'app.sqlite-wal','app.sqlite-shm'].map(path=>({key:`data/${path}`,target:resolve(dataRoot,path)}));
  if(manifest.files.some(entry=>entry.path.startsWith('.installation/'))) targets.push({key:'.env',target:resolve(root,'.env')},{key:'config',target:resolve(root,'config')});
  const moved=[];
  try {
    for(const entry of manifest.files) {
      const path=entry.path.startsWith('.installation/')?entry.path.slice('.installation/'.length):`data/${entry.path}`;
      const target=resolve(prepared,path);ensureDirectory(dirname(target),'restore staging');
      copyFileSync(resolve(backupRoot,entry.path),target);
      if(sha256(target)!==entry.sha256) throw new Error('Restored file verification failed. Preserve the backup and retry restore.');
    }
    for(const entry of targets) {
      assertNoSymbolicLinks(root,entry.target,'restore destination');
      const old=resolve(previous,entry.key),next=resolve(prepared,entry.key);
      ensureDirectory(dirname(old),'restore rollback directory');
      const existed=existsSync(entry.target);
      if(existed) renameSync(entry.target,old);
      moved.push({...entry,old,existed});
      if(existsSync(next)) renameSync(next,entry.target);
    }
  } catch(error) {
    for(const entry of moved.reverse()) {
      if(existsSync(entry.target)) rmSync(entry.target,{recursive:true,force:true});
      if(entry.existed) renameSync(entry.old,entry.target);
    }
    rmSync(staging,{recursive:true,force:true});throw error;
  }
  rmSync(staging,{recursive:true,force:true});
  return Object.freeze({ backupRoot, restoredFiles: manifest.files.length });
}
