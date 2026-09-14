import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const windowsTest = process.platform === 'win32' ? test : test.skip;
const commandProcessor = process.env.ComSpec ?? 'cmd.exe';

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function writeCommand(path, contents) {
  writeFileSync(path, contents.replaceAll('\n', '\r\n'), 'utf8');
}

function exposeNode(bin) {
  const target = join(bin, 'node.exe');
  try {
    linkSync(process.execPath, target);
  } catch {
    copyFileSync(process.execPath, target);
  }
}

function systemPath() {
  const windows = process.env.SystemRoot ?? String.raw`C:\Windows`;
  return [String.raw`${windows}\System32`, String.raw`${windows}\System32\WindowsPowerShell\v1.0`].join(';');
}

function createWindowsTools(t, { includeNode = true } = {}) {
  const toolsRoot = temporaryDirectory(t, 'booruflow-win-tools-');
  const bin = join(toolsRoot, 'bin');
  const log = join(toolsRoot, 'commands.log');
  mkdirSync(bin);
  if (includeNode) exposeNode(bin);
  writeFileSync(join(bin, 'git-fixture.mjs'), `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.BF_TEST_LOG, 'git ' + args.map((value) => '<' + value + '>').join(' ') + '\\n');
if (args[0] === '--version') { console.log('git version 2.55.0'); process.exit(0); }
if (args[0] === 'ls-remote') { console.log('0123456789012345678901234567890123456789\\trefs/tags/v0.88.0'); process.exit(0); }
if (args[0] === 'clone') {
  const target = args.at(-1);
  mkdirSync(join(target, 'scripts'), { recursive: true });
  writeFileSync(join(target, 'package.json'), '{}\\n');
  writeFileSync(join(target, 'package-lock.json'), '{}\\n');
  writeFileSync(join(target, '.env.example'), [
    'NOOBAI_PUBLIC_PORT=18082',
    'NOOBAI_INTERNAL_PORT=18083',
    'NOOBAI_EMBEDDING_BASE_URL=',
    'NOOBAI_EMBEDDING_API_KEY=',
    'NOOBAI_EMBEDDING_MODEL=',
    'NOOBAI_RERANKER_BASE_URL=',
    'NOOBAI_RERANKER_API_KEY=',
    'NOOBAI_RERANKER_MODEL=',
    ''
  ].join('\\n'));
  writeFileSync(join(target, 'scripts/runtime-data.mjs'), \
    "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('data/media', { recursive: true }); writeFileSync('data/catalog.sqlite', '');\\n");
  writeFileSync(join(target, 'install.bat'), readFileSync(process.env.BF_TEST_INSTALLER_SOURCE));
  mkdirSync(join(target, '.git'));
}
`);
  writeCommand(join(bin, 'git.cmd'), '@"%~dp0node.exe" "%~dp0git-fixture.mjs" %*\n');
  writeCommand(join(bin, 'npm.cmd'), `@echo off
if "%~1"=="--version" (
  echo 10.9.3
  exit /b 0
)
>>"%BF_TEST_LOG%" echo npm ^<%~1^>
if defined BF_TEST_NPM_STATUS exit /b %BF_TEST_NPM_STATUS%
if /I "%~1"=="ci" if not exist node_modules mkdir node_modules
exit /b 0
`);
  return { bin, log };
}

function runBatch(script, { args = [], cwd, environment = {}, input = '' }) {
  return spawnSync(commandProcessor, ['/d', '/c', script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    input,
    timeout: 30000,
    windowsHide: true
  });
}

function installerEnvironment(tools, extra = {}) {
  return {
    BF_TEST_LOG: tools.log,
    BF_TEST_INSTALLER_SOURCE: join(repositoryRoot, 'install.bat'),
    Path: `${tools.bin};${systemPath()}`,
    PATH: `${tools.bin};${systemPath()}`,
    ...extra
  };
}

windowsTest('Windows installer uses startup CWD and initializes an empty runtime', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-win-default-');
  const secondCwd = temporaryDirectory(t, 'booruflow-win-second-');
  const tools = createWindowsTools(t);
  const result = runBatch(join(repositoryRoot, 'install.bat'), {
    cwd,
    environment: installerEnvironment(tools),
    input: '\r\n'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Startup working directory and default installation directory:/);
  assert.equal(existsSync(join(cwd, 'data/media')), true);
  assert.equal(existsSync(join(cwd, 'data/catalog.sqlite')), true);
  const firstKey = readFileSync(join(cwd, '.env'), 'utf8').match(/NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY=([0-9a-f]{64})/)?.[1];
  assert.ok(firstKey);
  assert.notEqual(firstKey, '0'.repeat(64));
  assert.match(readFileSync(tools.log, 'utf8'), /git <clone> <--branch> <v0\.88\.0> <--depth> <1>/);

  const second = runBatch(join(repositoryRoot, 'install.bat'), {
    cwd: secondCwd,
    environment: installerEnvironment(tools),
    input: '\r\n'
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr, '');
  const secondKey = readFileSync(join(secondCwd, '.env'), 'utf8').match(/NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY=([0-9a-f]{64})/)?.[1];
  assert.ok(secondKey);
  assert.notEqual(secondKey, '0'.repeat(64));
  assert.notEqual(secondKey, firstKey);
});

windowsTest('Windows installer can run from the default directory when it is the only existing file', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-win-downloaded-');
  const downloadedInstaller = join(cwd, 'install.bat');
  copyFileSync(join(repositoryRoot, 'install.bat'), downloadedInstaller);
  const tools = createWindowsTools(t);
  const result = runBatch(downloadedInstaller, {
    cwd,
    environment: installerEnvironment(tools),
    input: '\r\n'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(join(cwd, '.git')), true);
  assert.equal(readFileSync(downloadedInstaller, 'utf8'), readFileSync(join(repositoryRoot, 'install.bat'), 'utf8'));
  assert.equal(existsSync(join(cwd, 'data/catalog.sqlite')), true);
});

windowsTest('Windows installer resolves a relative Unicode path from startup CWD', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-win-relative-');
  const tools = createWindowsTools(t);
  const relative = String.raw`应用 A&B (100%)\BooruFlow 安装`;
  const result = runBatch(join(repositoryRoot, 'install.bat'), {
    args: ['--directory', relative],
    cwd,
    environment: installerEnvironment(tools)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(cwd, relative, 'data/catalog.sqlite')), true);
});

windowsTest('Windows installer preserves metacharacters returned by the default CWD', (t) => {
  const parent = temporaryDirectory(t, 'booruflow-win-cwd-parent-');
  const cwd = join(parent, 'default A&B (%PATH%)');
  mkdirSync(cwd);
  const tools = createWindowsTools(t);
  const result = runBatch(join(repositoryRoot, 'install.bat'), {
    cwd,
    environment: installerEnvironment(tools),
    input: '\r\n'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(cwd, 'data/catalog.sqlite')), true);
  assert.match(result.stdout, /default A&B \(%PATH%\)/);
});

windowsTest('Windows installer reports missing Node after selecting the default directory', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-win-missing-node-');
  const tools = createWindowsTools(t, { includeNode: false });
  const result = runBatch(join(repositoryRoot, 'install.bat'), {
    cwd,
    environment: installerEnvironment(tools),
    input: '\r\n'
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Final installation directory:/);
  assert.match(result.stderr, /node is missing or PATH does not contain its executable/);
  assert.match(result.stderr, /24\.21\.0 or later/);
  assert.match(result.stderr, /https:\/\/nodejs\.org\/en\/download/);
});

windowsTest('Windows installer stops after npm ci fails and skips runtime initialization', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-win-npm-failure-');
  const tools = createWindowsTools(t);
  const result = runBatch(join(repositoryRoot, 'install.bat'), {
    cwd,
    environment: installerEnvironment(tools, { BF_TEST_NPM_STATUS: '23' }),
    input: '\r\n'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm ci failed/);
  assert.equal(existsSync(join(cwd, 'data/catalog.sqlite')), false);
});

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function availablePortPair() {
  const first = await availablePort();
  let second = await availablePort();
  while (second === first) second = await availablePort();
  return [first, second];
}

function createRuntimeFixture(t, publicPort, internalPort, fixtureRoot) {
  const root = fixtureRoot ?? temporaryDirectory(t, 'booruflow-win-runtime path-');
  for (const directory of ['config/release', 'scripts/platform/windows', 'scripts', 'node_modules']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const release = JSON.parse(readFileSync(join(repositoryRoot, 'config/release/release.json'), 'utf8'));
  release.runtime.shutdown_file = 'runtime/run/custom.shutdown';
  writeFileSync(join(root, 'config/release/release.json'), JSON.stringify(release, null, 2));
  copyFileSync(join(repositoryRoot, 'scripts/platform/windows/operations.bat'), join(root, 'scripts/platform/windows/operations.bat'));
  for (const name of ['check.bat', 'start.bat', 'status.bat', 'stop.bat', 'restore.bat', 'data-pack.bat', 'data-import.bat']) copyFileSync(join(repositoryRoot, name), join(root, name));
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  writeFileSync(join(root, '.env'), `NOOBAI_PUBLIC_PORT=${publicPort}\nNOOBAI_INTERNAL_PORT=${internalPort}\n`);
  writeFileSync(join(root, 'scripts/runtime-data.mjs'), `
import { appendFileSync } from 'node:fs';
if(process.env.BF_TEST_LOG) appendFileSync(process.env.BF_TEST_LOG, 'node runtime-data ' + process.argv.slice(2).join(' ') + '\\n');
if(!['check', 'data-validate', 'data-check', 'data-import', 'data-recover', 'data-export'].includes(process.argv[2])) process.exit(2);
`);
  writeFileSync(join(root, 'scripts/start-local-app.mjs'), `
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const root = process.cwd();
const release = JSON.parse(readFileSync(join(root, 'config/release/release.json'), 'utf8'));
const shutdown = join(root, release.runtime.shutdown_file);
const servers = [Number(process.env.NOOBAI_PUBLIC_PORT), Number(process.env.NOOBAI_INTERNAL_PORT)].map((port) => createServer((_request, response) => { response.statusCode = 200; response.end('ok'); }).listen(port, '127.0.0.1'));
let closing = false;
const timer = setInterval(async () => {
  if (closing || !existsSync(shutdown)) return;
  closing = true;
  clearInterval(timer);
  await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
  rmSync(shutdown, { force: true });
  writeFileSync(join(root, 'runtime/stopped.marker'), 'normal');
}, release.runtime.poll_interval_seconds * 1000);
`);
  const bin = join(root, 'test-bin');
  mkdirSync(bin);
  exposeNode(bin);
  writeCommand(join(bin, 'git.cmd'), '@echo off\nif "%~1"=="--version" echo git version 2.55.0\nexit /b 0\n');
  writeCommand(join(bin, 'npm.cmd'), '@echo off\nif "%~1"=="--version" echo 10.9.3\nexit /b 0\n');
  const path = `${bin};${systemPath()}`;
  return { root, environment: { Path: path, PATH: path } };
}

windowsTest('Windows runtime starts visibly, reports ownership, and stops through the configured shutdown file', async (t) => {
  const [publicPort, internalPort] = await availablePortPair();
  const fixture = createRuntimeFixture(t, publicPort, internalPort);
  mkdirSync(join(fixture.root, 'runtime/run'), { recursive: true });
  writeFileSync(join(fixture.root, 'runtime/run/custom.shutdown'), 'stale');
  t.after(() => {
    const pidPath = join(fixture.root, 'runtime/run/app.pid');
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, 'utf8').trim());
      try { process.kill(pid); } catch {}
    }
  });

  const started = runBatch(join(fixture.root, 'start.bat'), { cwd: tmpdir(), environment: fixture.environment });
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, new RegExp(`http://127\\.0\\.0\\.1:${publicPort}/`));
  assert.equal(existsSync(join(fixture.root, 'runtime/run/custom.shutdown')), false);

  const status = runBatch(join(fixture.root, 'status.bat'), { cwd: tmpdir(), environment: fixture.environment });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /PID [0-9]+ is running/);

  const stopped = runBatch(join(fixture.root, 'stop.bat'), { cwd: tmpdir(), environment: fixture.environment });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(existsSync(join(fixture.root, 'runtime/run/app.pid')), false);
  assert.equal(existsSync(join(fixture.root, 'runtime/run/custom.shutdown')), false);
  assert.equal(readFileSync(join(fixture.root, 'runtime/stopped.marker'), 'utf8'), 'normal');
});

windowsTest('Windows status rejects a live PID recorded by another installation', async (t) => {
  const [firstPublic, firstInternal] = await availablePortPair();
  let [secondPublic, secondInternal] = await availablePortPair();
  while ([secondPublic, secondInternal].some((port) => port === firstPublic || port === firstInternal)) {
    [secondPublic, secondInternal] = await availablePortPair();
  }
  const first = createRuntimeFixture(t, firstPublic, firstInternal);
  const second = createRuntimeFixture(t, secondPublic, secondInternal);
  t.after(() => {
    const pidPath = join(first.root, 'runtime/run/app.pid');
    if (existsSync(pidPath)) {
      try { process.kill(Number(readFileSync(pidPath, 'utf8').trim())); } catch {}
    }
  });
  const started = runBatch(join(first.root, 'start.bat'), { cwd: tmpdir(), environment: first.environment });
  assert.equal(started.status, 0, started.stderr);
  mkdirSync(join(second.root, 'runtime/run'), { recursive: true });
  copyFileSync(join(first.root, 'runtime/run/app.pid'), join(second.root, 'runtime/run/app.pid'));
  const rejected = runBatch(join(second.root, 'status.bat'), { cwd: tmpdir(), environment: second.environment });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /not the application process for this installation root/);
  const stopped = runBatch(join(first.root, 'stop.bat'), { cwd: tmpdir(), environment: first.environment });
  assert.equal(stopped.status, 0, stopped.stderr);
});

windowsTest('Windows data paths stay relative to a special-character caller directory', async (t) => {
  const [publicPort, internalPort] = await availablePortPair();
  const parent = temporaryDirectory(t, 'booruflow-win-special-');
  const root = join(parent, 'application A&B (100%)');
  const caller = join(parent, 'caller A&B (%PATH%)');
  mkdirSync(root);
  mkdirSync(caller);
  const fixture = createRuntimeFixture(t, publicPort, internalPort, root);
  const relativeInput = 'same name';
  mkdirSync(join(root, relativeInput));
  mkdirSync(join(caller, relativeInput));
  writeFileSync(join(root, relativeInput, 'root.txt'), 'root\n');
  writeFileSync(join(caller, relativeInput, 'caller.txt'), 'caller\n');
  const log = join(parent, 'data-commands.log');
  const packed = runBatch(join(root, 'data-pack.bat'), {
    args: ['--input', relativeInput, '--output', 'caller package.tar.gz'],
    cwd: caller,
    environment: { ...fixture.environment, BF_TEST_LOG: log }
  });
  assert.equal(packed.status, 0, packed.stderr);
  const listing = spawnSync('tar.exe', ['-tzf', join(caller, 'caller package.tar.gz')], { encoding: 'utf8' });
  assert.match(listing.stdout, /caller\.txt/);
  assert.doesNotMatch(listing.stdout, /root\.txt/);
  const commandLog = readFileSync(log, 'utf8');
  assert.match(commandLog, /data-validate/);
  assert.match(commandLog, new RegExp(join(caller, relativeInput).replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

windowsTest('Windows data import rejects duplicate archive paths before application validation', async (t) => {
  const [publicPort, internalPort] = await availablePortPair();
  const fixture = createRuntimeFixture(t, publicPort, internalPort);
  const first = join(fixture.root, 'first package');
  const second = join(fixture.root, 'second package');
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, 'same.txt'), 'first\n');
  writeFileSync(join(second, 'same.txt'), 'second\n');
  const rawTar = join(fixture.root, 'duplicate.tar');
  const created = spawnSync('tar.exe', ['-cf', rawTar, '-C', first, 'same.txt'], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const appended = spawnSync('tar.exe', ['-rf', rawTar, '-C', second, 'same.txt'], { encoding: 'utf8' });
  assert.equal(appended.status, 0, appended.stderr);
  const archive = join(fixture.root, 'duplicate.tar.gz');
  writeFileSync(archive, gzipSync(readFileSync(rawTar)));

  const rejected = runBatch(join(fixture.root, 'data-import.bat'), {
    args: ['--input', archive, '--check'],
    cwd: tmpdir(),
    environment: fixture.environment
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /archive contains too many, unsafe, or duplicate paths/);
});

windowsTest('Windows restore selects backup code and dependencies before restoring snapshot configuration and data', async (t) => {
  const [publicPort, internalPort] = await availablePortPair();
  const fixture = createRuntimeFixture(t, publicPort, internalPort);
  const log = join(fixture.root, 'restore-commands.log');
  mkdirSync(join(fixture.root, '.git'));
  mkdirSync(join(fixture.root, 'data/recovery/fixture-backup'), { recursive: true });
  mkdirSync(join(fixture.root, 'data/recovery/fixture-backup/.installation'), { recursive: true });
  writeFileSync(join(fixture.root, 'data/recovery/fixture-backup/.installation/.env'), `NOOBAI_PUBLIC_PORT=${publicPort}\nNOOBAI_INTERNAL_PORT=${internalPort}\n`);
  writeFileSync(join(fixture.root, 'data/recovery/fixture-backup.json'), JSON.stringify({
    metadata_version: 1,
    backup: 'fixture-backup',
    tag: 'v0.88.0',
    repository_https: 'https://github.com/fzfz/booruflow.git'
  }, null, 2));
  writeCommand(join(fixture.root, 'test-bin/git.cmd'), `@echo off
>>"%BF_TEST_LOG%" echo git %*
exit /b 0
`);
  writeCommand(join(fixture.root, 'test-bin/npm.cmd'), `@echo off
>>"%BF_TEST_LOG%" echo npm %*
exit /b 0
`);
  writeFileSync(join(fixture.root, 'scripts/prod-restore.mjs'), `
import { appendFileSync, writeFileSync } from 'node:fs';
appendFileSync(process.env.BF_TEST_LOG, 'node prod-restore ' + process.argv.slice(2).join(' ') + '\\n');
writeFileSync('.env', 'NOOBAI_PUBLIC_PORT=${publicPort}\\nNOOBAI_INTERNAL_PORT=${internalPort}\\nSNAPSHOT_CONFIGURATION=restored\\n');
`);
  rmSync(join(fixture.root, '.env'));
  rmSync(join(fixture.root, 'node_modules'), { recursive: true });

  const restored = runBatch(join(fixture.root, 'restore.bat'), {
    args: ['--backup', 'data/recovery/fixture-backup'],
    cwd: tmpdir(),
    environment: { ...fixture.environment, BF_TEST_LOG: log }
  });
  assert.equal(restored.status, 0, restored.stderr);
  const commands = readFileSync(log, 'utf8');
  assert.ok(commands.indexOf('git checkout --detach v0.88.0') < commands.indexOf('npm ci'));
  assert.ok(commands.indexOf('npm ci') < commands.indexOf('node prod-restore'));
  assert.match(readFileSync(join(fixture.root, '.env'), 'utf8'), /SNAPSHOT_CONFIGURATION=restored/);
});
