import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
const runtimeDataModule = resolve(repositoryRoot, 'app/maintenance/production-runtime-data.mjs');
const backupCommandModule = resolve(repositoryRoot, 'scripts/prod-backup.mjs');

const BACKUP_RUNTIME_FILES = Object.freeze([
  '.2x-nz-crawlee-records.json',
  'app.sqlite',
  'crawl_state.json',
  'media/images/cover.bin',
  'raw/source.json',
  'reports/latest.json'
]);
function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixtureRoot(t, beforeRemove = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'noobai-issue89-runtime-data-'));
  t.after(async () => {
    try {
      await beforeRemove();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return root;
}

function cliRelativePath(root, target) {
  return relative(root, target).split(sep).join('/');
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise, rejectPromise) => {
    child.once('exit', resolvePromise);
    child.once('error', rejectPromise);
  });
  child.kill('SIGTERM');
  await exited;
}

function writeFile(root, path, value) {
  const target = resolve(root, path);
  assert.equal(relative(root, target).startsWith('..'), false, `fixture path must remain inside its temporary root: ${path}`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function readFile(root, path) {
  return readFileSync(resolve(root, path));
}

function writeRuntimeData(dataRoot, prefix, paths = BACKUP_RUNTIME_FILES) {
  for (const path of paths) writeFile(dataRoot, path, `${prefix}:${path}\n`);
}

function writeRuntimeDatabase(dataRoot, prefix) {
  const database = new DatabaseSync(resolve(dataRoot, 'app.sqlite'));
  database.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE records (value TEXT);');
  database.prepare('INSERT INTO records VALUES (?)').run(`${prefix}:app.sqlite`);
  return database;
}

function runtimeSnapshot(dataRoot, paths = BACKUP_RUNTIME_FILES) {
  return Object.fromEntries(paths.map((path) => [path, readFile(dataRoot, path).toString('utf8')]));
}

function assertRuntimeSnapshot(dataRoot, expected) {
  for (const [path, value] of Object.entries(expected)) {
    assert.equal(readFile(dataRoot, path).toString('utf8'), value, `${path} must match the verified backup`);
  }
}

function commandScript(name) {
  const command = packageJson.scripts?.[name];
  assert.equal(typeof command, 'string', `package.json must expose ${name}`);
  const match = command.match(/^node\s+(scripts\/[A-Za-z0-9-]+\.mjs)$/u);
  assert.ok(match, `${name} must invoke one production command script directly`);
  const script = resolve(repositoryRoot, match[1]);
  assert.equal(existsSync(script), true, `${name} command script must exist`);
  return script;
}

function runProductionCommand(name, cwd, args = []) {
  return spawnSync(process.execPath, [commandScript(name), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env }
  });
}

function assertRejected(result, message) {
  assert.notEqual(result.status, 0, message);
  assert.doesNotMatch(result.stderr ?? '', /(?:Cannot find module|MODULE_NOT_FOUND)/u, `${message}: command itself must reject the input`);
}

function createManifestDirectory(directory, files) {
  for (const [path, value] of Object.entries(files)) writeFile(directory, path, value);
  const manifest = {
    backup_version: 1,
    created_at: '2026-08-02T12:00:00.000Z',
    files: Object.entries(files).map(([path, value]) => ({ path, sha256: hash(value) }))
  };
  writeFile(directory, 'backup-manifest.json', `${JSON.stringify(manifest)}\n`);
}

function createBackup(dataRoot, name, files = runtimeSnapshot(dataRoot)) {
  const backupRoot = resolve(dataRoot, 'recovery', name);
  createManifestDirectory(backupRoot, files);
  return backupRoot;
}

function backupNames(dataRoot) {
  const recoveryRoot = resolve(dataRoot, 'recovery');
  return existsSync(recoveryRoot) ? readdirSync(recoveryRoot).sort() : [];
}

async function runtimeSnapshotModule() {
  assert.equal(existsSync(runtimeDataModule), true, 'Issue #89 must provide the reusable production runtime-data module');
  return import(pathToFileURL(runtimeDataModule).href);
}

test('Issue #89 exposes only prod:backup and prod:restore as production data commands', () => {
  for (const name of ['prod:backup', 'prod:restore']) commandScript(name);
  assert.equal(packageJson.scripts?.['prod:import-snapshot'], undefined, 'snapshot importing must not remain callable after first production initialization');
});

test('prod:backup runner passes configured production roots and listener configuration to the injected backup implementation', async (t) => {
  const root = fixtureRoot(t);
  const { runProductionBackup } = await import(pathToFileURL(backupCommandModule).href);
  const calls = [];
  const output = [];
  const runtimeConfiguration = { listeners: { public: { port: 46211 }, internal: { port: 46212 } } };
  const result = await runProductionBackup({
    cwd: root,
    loadRuntimeConfiguration: ({ environmentPath, configPath }) => {
      assert.equal(environmentPath, resolve(root, '.env'));
      assert.equal(configPath, resolve(root, 'config', 'defaults.json'));
      return runtimeConfiguration;
    },
    createBackup: async (options) => {
      calls.push(options);
      return { name: '2026-08-06T12-00-00-000Z', createdAt: '2026-08-06T12:00:00.000Z' };
    },
    stdout: { write(value) { output.push(value); } }
  });
  assert.deepEqual(result, { name: '2026-08-06T12-00-00-000Z', createdAt: '2026-08-06T12:00:00.000Z' });
  assert.deepEqual(calls, [{
    productionRoot: root,
    dataRoot: resolve(root, 'data'),
    runtimeConfiguration,
    includeInstallationConfiguration: true
  }]);
  assert.match(output.join(''), /2026-08-06T12-00-00-000Z/u);
  assert.match(output.join(''), /SHA-256 manifest verified/u);
});

test('prod:backup creates the complete verified runtime set through the runner without production sockets', async (t) => {
  let database = null;
  const root = fixtureRoot(t, () => {
    if (database !== null) {
      database.close();
      database = null;
    }
  });
  const dataRoot = resolve(root, 'data');
  writeRuntimeData(dataRoot, 'source', BACKUP_RUNTIME_FILES.filter((path) => path !== 'app.sqlite'));
  database = writeRuntimeDatabase(dataRoot, 'source');
  assert.equal(existsSync(resolve(dataRoot, 'app.sqlite-wal')), true, 'the fixture must keep an uncheckpointed SQLite WAL before backup');
  assert.equal(existsSync(resolve(dataRoot, 'app.sqlite-shm')), true, 'the fixture must keep the SQLite shared-memory file while the WAL connection is open');
  writeFile(dataRoot, 'recovery/manual-keep/sentinel.txt', 'must remain and must not be backed up\n');
  writeFile(root, 'runtime/credentials/sentinel.txt', 'credential material must remain outside runtime backup\n');

  const { runProductionBackup } = await import(pathToFileURL(backupCommandModule).href);
  const runtimeData = await runtimeSnapshotModule();
  writeFile(root,'.env','NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY=fixture-key\n');
  writeFile(root,'config/defaults.json','{}');
  const output = [];
  const probedPorts = [];
  const runtimeConfiguration = { listeners: { public: { port: 46211 }, internal: { port: 46212 } } };
  const result = await runProductionBackup({
    cwd: root,
    loadRuntimeConfiguration: () => runtimeConfiguration,
    createBackup: (options) => runtimeData.createProductionRuntimeBackup({
      ...options,
      isPidAlive: () => false,
      isPortListening: (port) => {
        probedPorts.push(port);
        return false;
      },
      now: new Date('2026-08-06T12:00:00.000Z')
    }),
    stdout: { write(value) { output.push(value); } }
  });
  database.close();
  database = null;

  assert.equal(result.name, '2026-08-06T12-00-00-000Z');
  assert.equal(result.createdAt, '2026-08-06T12:00:00.000Z');
  assert.deepEqual(probedPorts, [46211, 46212], 'backup must check both configured listeners through the injected probe');
  const names = backupNames(dataRoot);
  assert.deepEqual(names, ['2026-08-06T12-00-00-000Z', 'manual-keep']);
  const backupRoot = resolve(dataRoot, 'recovery', result.name);
  const manifest = JSON.parse(readFile(backupRoot, 'backup-manifest.json').toString('utf8'));
  assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), [...BACKUP_RUNTIME_FILES,'.installation/.env','.installation/config/defaults.json'].sort());
  for (const entry of manifest.files) {
    assert.equal(entry.path.startsWith('/'), false, 'manifest paths must be relative');
    assert.equal(entry.path.split('/').includes('..'), false, 'manifest paths must stay below the data root');
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u, 'manifest must record SHA-256 for each file');
    const source = entry.path.startsWith('.installation/') ? readFile(root,entry.path.slice('.installation/'.length)) : readFile(dataRoot, entry.path);
    const copied = readFile(backupRoot, entry.path);
    assert.deepEqual(copied, source, `${entry.path} bytes must match the source runtime file`);
    assert.equal(hash(copied), entry.sha256, `${entry.path} hash must match copied bytes`);
  }
  assert.equal(existsSync(resolve(backupRoot, 'recovery')), false, 'a backup must never recursively include data/recovery');
  assert.equal(readFile(dataRoot, 'recovery/manual-keep/sentinel.txt').toString('utf8'), 'must remain and must not be backed up\n');
  assert.equal(readFile(root, 'runtime/credentials/sentinel.txt').toString('utf8'), 'credential material must remain outside runtime backup\n');
  assert.match(output.join(''), new RegExp(result.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), 'output must identify the backup');
  assert.match(output.join(''), /(?:20\d{2}|sha-?256|校验|验证|verified)/iu, 'output must report creation time and verification result');
  assert.doesNotMatch(output.join(''), /media\/images\/cover\.bin|raw\/source\.json/u, 'backup output must not expand into a per-file report');
});

test('prod:restore requires --backup and restores only the verified runtime set without a pre-restore backup', (t) => {
  const root = fixtureRoot(t);
  const dataRoot = resolve(root, 'data');
  writeRuntimeData(dataRoot, 'backup');
  const backupValues = runtimeSnapshot(dataRoot);
  const backupRoot = createBackup(dataRoot, '2026-08-02T12-00-00Z', backupValues);
  writeRuntimeData(dataRoot, 'target');
  writeFile(dataRoot, 'unmanaged/sentinel.txt', 'not runtime data\n');
  writeFile(dataRoot, 'recovery/retain/sentinel.txt', 'existing recovery history\n');
  writeFile(root, 'runtime/credentials/sentinel.txt', 'not runtime data\n');
  const beforeNames = backupNames(dataRoot);
  const targetBefore = runtimeSnapshot(dataRoot);

  const omitted = runProductionCommand('prod:restore', root);
  assertRejected(omitted, 'restore without an explicit backup directory must fail');
  assertRuntimeSnapshot(dataRoot, targetBefore);

  const outsideBackupRoot = resolve(root, 'untrusted-backup');
  createManifestDirectory(outsideBackupRoot, backupValues);
  const outside = runProductionCommand('prod:restore', root, ['--backup', cliRelativePath(root, outsideBackupRoot)]);
  assertRejected(outside, 'restore must reject a backup directory outside data/recovery');
  assertRuntimeSnapshot(dataRoot, targetBefore);

  const result = runProductionCommand('prod:restore', root, ['--backup', cliRelativePath(root, backupRoot)]);
  assert.equal(result.status, 0, result.stderr);
  assertRuntimeSnapshot(dataRoot, backupValues);
  assert.equal(readFile(dataRoot, 'unmanaged/sentinel.txt').toString('utf8'), 'not runtime data\n', 'restore must not overwrite data outside the defined runtime set');
  assert.equal(readFile(dataRoot, 'recovery/retain/sentinel.txt').toString('utf8'), 'existing recovery history\n', 'restore must not modify other recovery history');
  assert.equal(readFile(root, 'runtime/credentials/sentinel.txt').toString('utf8'), 'not runtime data\n', 'restore must not overwrite credentials outside data/');
  assert.deepEqual(backupNames(dataRoot), beforeNames, 'restore must not create an automatic pre-restore backup');
  assert.match(result.stdout, /(?:校验|验证|verified|sha-?256)/iu, 'restore output must report verification');
  assert.equal(existsSync(backupRoot), true, 'selected backup remains available after restore');
});

test('prod:restore refuses an active production PID before it changes temporary fixture data', (t) => {
  let child = null;
  const root = fixtureRoot(t, async () => {
    if (child !== null) await terminateChild(child);
  });
  const dataRoot = resolve(root, 'data');
  writeRuntimeData(dataRoot, 'backup');
  const backupRoot = createBackup(dataRoot, '2026-08-02T12-01-00Z');
  writeRuntimeData(dataRoot, 'target');
  const before = runtimeSnapshot(dataRoot);
  child = spawn(process.execPath, ['--input-type=module', '--eval', 'setInterval(() => {}, 1000)'], { cwd: root, stdio: 'ignore' });
  writeFile(root, 'runtime/run/app.pid', `${child.pid}\n`);

  const result = runProductionCommand('prod:restore', root, ['--backup', cliRelativePath(root, backupRoot)]);
  assertRejected(result, 'restore while the production application PID is alive must fail');
  assertRuntimeSnapshot(dataRoot, before);
});

test('prod:restore verifies every manifest path and hash before overwriting temporary fixture data', (t) => {
  const cases = [
    {
      name: 'missing-manifest',
      prepare(root, dataRoot) {
        const backupRoot = resolve(dataRoot, 'recovery', 'missing-manifest');
        writeFile(backupRoot, 'app.sqlite', 'backup:app.sqlite\n');
        return backupRoot;
      }
    },
    {
      name: 'missing-listed-file',
      prepare(root, dataRoot) {
        const backupRoot = createBackup(dataRoot, 'missing-listed-file');
        rmSync(resolve(backupRoot, 'media/images/cover.bin'));
        return backupRoot;
      }
    },
    {
      name: 'hash-mismatch',
      prepare(root, dataRoot) {
        const backupRoot = createBackup(dataRoot, 'hash-mismatch');
        writeFile(backupRoot, 'raw/source.json', 'changed after manifest\n');
        return backupRoot;
      }
    },
    {
      name: 'unlisted-file',
      prepare(root, dataRoot) {
        const backupRoot = createBackup(dataRoot, 'unlisted-file');
        writeFile(backupRoot, 'reports/unlisted.json', 'not present in manifest\n');
        return backupRoot;
      }
    },
    {
      name: 'path-traversal',
      prepare(root, dataRoot) {
        const backupRoot = createBackup(dataRoot, 'path-traversal');
        const manifestPath = resolve(backupRoot, 'backup-manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest.files[0].path = '../outside-target.txt';
        manifest.files[0].sha256 = hash('outside must remain\n');
        writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
        writeFile(root, 'outside-target.txt', 'outside must remain\n');
        return backupRoot;
      }
    }
  ];

  for (const scenario of cases) {
    const root = fixtureRoot(t);
    const dataRoot = resolve(root, 'data');
    writeRuntimeData(dataRoot, 'backup');
    const backupRoot = scenario.prepare(root, dataRoot);
    writeRuntimeData(dataRoot, `target:${scenario.name}`);
    const before = runtimeSnapshot(dataRoot);
    const result = runProductionCommand('prod:restore', root, ['--backup', cliRelativePath(root, backupRoot)]);
    assertRejected(result, `${scenario.name} must be rejected`);
    assertRuntimeSnapshot(dataRoot, before);
    if (scenario.name === 'path-traversal') {
      assert.equal(readFile(root, 'outside-target.txt').toString('utf8'), 'outside must remain\n', 'path traversal must not touch an outside temporary fixture file');
    }
  }
});

test('prod:restore rejects a backup that omits a required fixed runtime file before changing temporary fixture data', (t) => {
  const root = fixtureRoot(t);
  const dataRoot = resolve(root, 'data');
  writeRuntimeData(dataRoot, 'backup');
  const incompleteBackupValues = runtimeSnapshot(dataRoot);
  delete incompleteBackupValues['app.sqlite'];
  const backupRoot = createBackup(dataRoot, 'missing-required-app-sqlite', incompleteBackupValues);
  writeRuntimeData(dataRoot, 'target');
  const before = runtimeSnapshot(dataRoot);

  const result = runProductionCommand('prod:restore', root, ['--backup', cliRelativePath(root, backupRoot)]);
  assertRejected(result, 'restore must reject a backup missing the required app.sqlite runtime file');
  assertRuntimeSnapshot(dataRoot, before);
});

test('fresh installation backup restores configuration and removes later media without crawler state',async t=>{
 const root=fixtureRoot(t),dataRoot=resolve(root,'data');mkdirSync(resolve(dataRoot,'media'),{recursive:true});
 writeRuntimeDatabase(dataRoot,'fresh').close();writeFile(dataRoot,'media/one.png','before');writeFile(root,'.env','KEY=before\n');writeFile(root,'config/defaults.json','{"test":true}');
 const runtime=await runtimeSnapshotModule();
 const backup=await runtime.createProductionRuntimeBackup({productionRoot:root,dataRoot,runtimeConfiguration:{listeners:{public:{port:49991},internal:{port:49992}}},isPidAlive:()=>false,isPortListening:()=>false,includeInstallationConfiguration:true});
 writeFile(dataRoot,'media/later.png','later');writeFile(root,'.env','KEY=after\n');writeFile(root,'config/defaults.json','{"test":false}');
 runtime.restoreProductionRuntimeBackup({productionRoot:root,backupArgument:`data/recovery/${backup.name}`});
 assert.equal(readFile(root,'.env').toString(),'KEY=before\n');assert.equal(readFile(root,'config/defaults.json').toString(),'{"test":true}');assert.equal(existsSync(resolve(dataRoot,'media/later.png')),false);assert.equal(readFile(dataRoot,'media/one.png').toString(),'before');
});
