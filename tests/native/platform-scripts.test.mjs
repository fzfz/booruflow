import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const macosBin = join(repositoryRoot, 'bin/macos');
const windowsBin = join(repositoryRoot, 'bin/windows');
const installer = join(macosBin, 'install.sh');
const shellScripts = [
  'bin/macos/install.sh', 'bin/macos/check.sh', 'bin/macos/start.sh', 'bin/macos/stop.sh',
  'bin/macos/status.sh', 'bin/macos/update.sh', 'bin/macos/backup.sh', 'bin/macos/restore.sh',
  'bin/macos/data-export.sh', 'bin/macos/data-pack.sh', 'bin/macos/data-import.sh',
  'scripts/platform/macos/operations.sh'
];
const batchScripts = [
  'bin/windows/install.bat', 'bin/windows/check.bat', 'bin/windows/start.bat',
  'bin/windows/stop.bat', 'bin/windows/status.bat', 'bin/windows/update.bat',
  'bin/windows/backup.bat', 'bin/windows/restore.bat', 'bin/windows/data-export.bat',
  'bin/windows/data-pack.bat', 'bin/windows/data-import.bat'
];
const macTest = process.platform === 'darwin' ? test : test.skip;

function temporaryDirectory(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function executable(path, contents) {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

function createInstallerTools(t, { npmStatus = 0, includeNode = true } = {}) {
  const root = temporaryDirectory(t, 'booruflow-installer-tools-');
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  if (includeNode) executable(join(bin, 'node'), `#!/bin/bash
if [ "\${1:-}" = --version ]; then echo v24.21.0; exit 0; fi
printf 'node' >> "$BF_TEST_LOG"; printf ' <%s>' "$@" >> "$BF_TEST_LOG"; printf '\n' >> "$BF_TEST_LOG"
if [ "\${1:-}" = scripts/runtime-data.mjs ] && [ "\${2:-}" = init ]; then
  mkdir -p data/media
fi
exit 0
`);
  executable(join(bin, 'npm'), `#!/bin/bash
if [ "\${1:-}" = --version ]; then echo 10.9.3; exit 0; fi
printf 'npm' >> "$BF_TEST_LOG"; printf ' <%s>' "$@" >> "$BF_TEST_LOG"; printf '\n' >> "$BF_TEST_LOG"
exit ${npmStatus}
`);
  executable(join(bin, 'git'), `#!/bin/bash
if [ "\${1:-}" = --version ]; then echo 'git version 2.55.0'; exit 0; fi
printf 'git' >> "$BF_TEST_LOG"; printf ' <%s>' "$@" >> "$BF_TEST_LOG"; printf '\n' >> "$BF_TEST_LOG"
if [ "\${1:-}" = ls-remote ]; then printf '0123456789012345678901234567890123456789\trefs/tags/v0.88.0\n'; exit 0; fi
if [ "\${1:-}" = clone ]; then
  for target in "$@"; do :; done
  mkdir -p "$target/scripts"
  printf '{}\n' > "$target/package.json"
  printf '{}\n' > "$target/package-lock.json"
  cat > "$target/.env.example" <<'ENV'
NOOBAI_PUBLIC_PORT=18082
NOOBAI_INTERNAL_PORT=18083
NOOBAI_EMBEDDING_BASE_URL=
NOOBAI_EMBEDDING_API_KEY=
NOOBAI_EMBEDDING_MODEL=
NOOBAI_RERANKER_BASE_URL=
NOOBAI_RERANKER_API_KEY=
NOOBAI_RERANKER_MODEL=
ENV
  printf '// fixture\n' > "$target/scripts/runtime-data.mjs"
  installer_source=\${BF_TEST_CLONED_INSTALLER_SOURCE:-$BF_TEST_INSTALLER_SOURCE}
  if [ "\${BF_TEST_CLONE_LAYOUT:-nested}" = legacy ]; then
    cp "$installer_source" "$target/install.sh"
    printf '#!/bin/bash\n' > "$target/start.sh"
  else
    mkdir -p "$target/bin/macos"
    cp "$installer_source" "$target/bin/macos/install.sh"
    printf '#!/bin/bash\n' > "$target/bin/macos/start.sh"
  fi
  mkdir -p "$target/.git"
fi
exit 0
`);
  executable(join(bin, 'openssl'), `#!/bin/bash
printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'
`);
  return { bin, log };
}

function runInstaller({ cwd, bin, log, input = '', args = [], installerPath = installer, environment = {} }) {
  return spawnSync('/bin/bash', [installerPath, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      BF_TEST_LOG: log,
      BF_TEST_INSTALLER_SOURCE: installer,
      ...environment,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`
    }
  });
}

function createOperationFixture(t, fixtureRoot) {
  const root = fixtureRoot ?? temporaryDirectory(t, 'booruflow-platform path-');
  mkdirSync(join(root, 'scripts/platform/macos'), { recursive: true });
  mkdirSync(join(root, 'bin/macos'), { recursive: true });
  mkdirSync(join(root, 'config/release'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules'));
  copyFileSync(join(repositoryRoot, 'scripts/platform/macos/operations.sh'), join(root, 'scripts/platform/macos/operations.sh'));
  copyFileSync(join(repositoryRoot, 'config/release/release.json'), join(root, 'config/release/release.json'));
  for (const name of ['backup.sh', 'restore.sh', 'start.sh', 'stop.sh', 'data-pack.sh', 'data-import.sh', 'status.sh']) copyFileSync(join(macosBin, name), join(root, 'bin/macos', name));
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  writeFileSync(join(root, 'scripts/runtime-data.mjs'), '// fixture\n');
  writeFileSync(join(root, 'scripts/start-local-app.mjs'), '// fixture\n');
  writeFileSync(join(root, '.env'), 'NOOBAI_PUBLIC_PORT=65431\nNOOBAI_INTERNAL_PORT=65432\n');
  const bin = join(root, 'test-bin');
  const log = join(root, 'commands.log');
  mkdirSync(bin);
  executable(join(bin, 'node'), `#!/bin/bash
printf 'node' >> "$BF_TEST_LOG"; printf ' <%s>' "$@" >> "$BF_TEST_LOG"; printf '\n' >> "$BF_TEST_LOG"
if [ "\${1:-}" = scripts/prod-backup.mjs ]; then
  mkdir -p data/recovery/fixture-backup
  printf 'Production backup fixture-backup created. SHA-256 manifest verified.\n'
fi
if [ "\${1:-}" = scripts/prod-restore.mjs ]; then
  printf 'NOOBAI_PUBLIC_PORT=65431\nNOOBAI_INTERNAL_PORT=65432\nSNAPSHOT_CONFIGURATION=restored\n' > .env
fi
exit "\${BF_TEST_NODE_STATUS:-0}"
`);
  return { root, bin, log };
}

function runFixture(fixture, script, args = [], extraEnvironment = {}, cwd = tmpdir()) {
  return spawnSync('/bin/bash', [join(fixture.root, 'bin/macos', script), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnvironment,
      BF_TEST_LOG: fixture.log,
      PATH: `${fixture.bin}:/usr/bin:/bin:/usr/sbin:/sbin`
    }
  });
}

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

async function waitUntil(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

test('release configuration is the single source for installer defaults', () => {
  const configuration = JSON.parse(readFileSync(join(repositoryRoot, 'config/release/release.json'), 'utf8'));
  const schema = JSON.parse(readFileSync(join(repositoryRoot, 'schema/release/release-config.schema.json'), 'utf8'));
  assert.equal(configuration.project_name, 'BooruFlow');
  assert.equal(configuration.repository_https, 'https://github.com/fzfz/booruflow.git');
  assert.equal(configuration.default_tag, 'v0.88.0');
  assert.equal(configuration.requirements.node_minimum, '24.21.0');
  assert.equal(configuration.requirements.npm_minimum, '10.9.3');
  assert.equal(configuration.requirements.git_minimum, '2.55.0');
  assert.equal(configuration.runtime.shutdown_file, 'runtime/run/shutdown.request');
  assert.equal(configuration.runtime.backup_version_directory, 'data/recovery');
  assert.equal(configuration.release_artifacts.macos_installer, 'install.sh');
  assert.equal(configuration.release_artifacts.windows_installer, 'install.bat');
  assert.equal(schema.properties.repository_https.const, configuration.repository_https);
  for (const script of [join(macosBin, 'install.sh'), join(windowsBin, 'install.bat')]) {
    const contents = readFileSync(script, 'utf8');
    for (const value of [configuration.repository_https, configuration.default_tag, configuration.requirements.node_minimum, configuration.requirements.npm_minimum, configuration.requirements.git_minimum]) {
      assert.match(contents, new RegExp(value.replaceAll('.', '\\.')));
    }
    assert.match(contents, /tar(?:\.exe)? --version/);
  }
  for (const script of [...shellScripts.filter((value) => !value.startsWith('scripts/')), ...batchScripts]) {
    assert.equal(existsSync(join(repositoryRoot, script)), true, script);
    assert.equal(existsSync(join(repositoryRoot, basename(script))), false, basename(script));
  }
});

macTest('all macOS scripts pass Bash 3.2 syntax parsing and bin wrappers dispatch from the repository root', () => {
  for (const relativePath of shellScripts) {
    const result = spawnSync('/bin/bash', ['-n', join(repositoryRoot, relativePath)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${relativePath}: ${result.stderr}`);
  }
  for (const name of shellScripts.filter((value) => dirname(value) === 'bin/macos')) {
    if (basename(name) === 'install.sh') continue;
    const contents = readFileSync(join(repositoryRoot, name), 'utf8');
    assert.match(contents, /BF_ROOT=.*BF_SCRIPT_DIRECTORY\/\.\.\/\.\./);
    assert.match(contents, /scripts\/platform\/macos\/operations\.sh/);
    assert.match(contents, new RegExp(`bf_main '${basename(name, '.sh')}'`));
  }
  const operations = readFileSync(join(repositoryRoot, 'scripts/platform/macos/operations.sh'), 'utf8');
  assert.match(operations, /bash \\"\$BF_ROOT\/bin\/macos\/stop\.sh\\"/);
  assert.match(operations, /bash \\"\$BF_ROOT\/bin\/macos\/restore\.sh\\"/);
});

macTest('installer uses its startup CWD as the displayed and selected default', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-default-');
  const tools = createInstallerTools(t);
  const result = runInstaller({ cwd, ...tools, input: '\n', args: ['--tag', 'v0.89.0'] });
  const physicalCwd = realpathSync(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`default installation directory: ${physicalCwd.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, new RegExp(`Final installation directory: ${physicalCwd.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(existsSync(join(cwd, 'data/media')), true);
  assert.match(readFileSync(join(cwd, '.env'), 'utf8'), /NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY=[0-9a-f]{64}/);
  assert.match(readFileSync(tools.log, 'utf8'), new RegExp(`git <clone> <--branch> <v0\\.89\\.0> <--depth> <1> <https://github\\.com/fzfz/booruflow\\.git> <${physicalCwd.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`));
});

macTest('installer can run from the default directory when it is the only existing file', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-downloaded-installer-');
  const downloadedInstaller = join(cwd, 'install.sh');
  copyFileSync(installer, downloadedInstaller);
  chmodSync(downloadedInstaller, 0o755);
  const tools = createInstallerTools(t);
  const result = runInstaller({ cwd, ...tools, input: '\n', args: ['--tag', 'v0.89.0'], installerPath: downloadedInstaller });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(cwd, '.git')), true);
  assert.equal(existsSync(downloadedInstaller), false);
  assert.equal(readFileSync(join(cwd, 'bin/macos/install.sh'), 'utf8'), readFileSync(installer, 'utf8'));
  assert.equal(existsSync(join(cwd, 'data/media')), true);
});

macTest('current installer rejects a selected release that does not use the macOS bin layout', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-legacy-caller-');
  const destination = join(cwd, 'legacy release');
  const tools = createInstallerTools(t);
  const result = runInstaller({
    cwd,
    ...tools,
    args: ['--directory', destination],
    environment: { BF_TEST_CLONE_LAYOUT: 'legacy' }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /selected release does not use the current macOS bin layout; remove ".*legacy release", then download v0\.88\.0's published install\.sh attachment/);
});

macTest('installer rejects an in-place download that differs from the selected bin-layout release installer', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-legacy-mismatch-');
  const downloadedInstaller = join(cwd, 'install.sh');
  const mismatchedInstaller = join(temporaryDirectory(t, 'booruflow-mismatched-installer-'), 'install.sh');
  copyFileSync(installer, downloadedInstaller);
  writeFileSync(mismatchedInstaller, '#!/bin/bash\nexit 1\n');
  chmodSync(downloadedInstaller, 0o755);
  const tools = createInstallerTools(t);
  const result = runInstaller({
    cwd,
    ...tools,
    input: '\n',
    args: ['--tag', 'v0.89.0'],
    installerPath: downloadedInstaller,
    environment: {
      BF_TEST_CLONED_INSTALLER_SOURCE: mismatchedInstaller
    }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /installer differs from v0\.89\.0; download that tag's install\.sh/);
});

macTest('installer resolves a relative directory with spaces and Chinese from startup CWD', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-relative-');
  const tools = createInstallerTools(t);
  const relative = '应用 A&B (100%)/BooruFlow 安装';
  const destination = join(realpathSync(cwd), relative);
  const result = runInstaller({ cwd, ...tools, args: ['--directory', relative, '--tag', 'v0.89.0'] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Final installation directory: ${destination.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(existsSync(join(destination, 'data/media')), true);
});

macTest('installer reports missing Node after displaying and selecting the installation directory', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-missing-node-');
  const tools = createInstallerTools(t, { includeNode: false });
  const result = runInstaller({ cwd, ...tools, input: '\n', args: ['--tag', 'v0.89.0'] });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Startup working directory and default installation directory/);
  assert.match(result.stdout, /Final installation directory/);
  assert.match(result.stderr, /node is missing or PATH does not contain its executable/);
  assert.match(result.stderr, /24\.21\.0 or later/);
  assert.match(result.stderr, /https:\/\/nodejs\.org\/en\/download/);
});

macTest('installer stops after npm ci failure and does not initialize the database', (t) => {
  const cwd = temporaryDirectory(t, 'booruflow-npm-failure-');
  const tools = createInstallerTools(t, { npmStatus: 23 });
  const result = runInstaller({ cwd, ...tools, input: '\n', args: ['--tag', 'v0.89.0'] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm ci failed/);
  const log = readFileSync(tools.log, 'utf8');
  assert.match(log, /npm <ci>/);
  assert.doesNotMatch(log, /runtime-data\.mjs/);
});

macTest('data-pack validates through the app CLI and creates a native tar archive at a spaced path', (t) => {
  const fixture = createOperationFixture(t);
  const input = join(fixture.root, 'export 资料');
  const output = join(fixture.root, 'package output.tar.gz');
  mkdirSync(input);
  writeFileSync(join(input, 'manifest.json'), '{"format_version":1}\n');
  const result = runFixture(fixture, 'data-pack.sh', ['--input', input, '--output', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(output), true);
  assert.match(readFileSync(fixture.log, 'utf8'), /<scripts\/runtime-data\.mjs> <data-validate>/);
  const listing = spawnSync('tar', ['-tzf', output], { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /manifest\.json/);
});

macTest('data paths are resolved from the caller before platform scripts change directory', (t) => {
  const fixture = createOperationFixture(t);
  const caller = temporaryDirectory(t, 'booruflow-data-caller-');
  const physicalCaller = realpathSync(caller);
  const relativeInput = 'same name';
  mkdirSync(join(caller, relativeInput));
  mkdirSync(join(fixture.root, relativeInput));
  writeFileSync(join(caller, relativeInput, 'caller.txt'), 'caller\n');
  writeFileSync(join(fixture.root, relativeInput, 'root.txt'), 'root\n');
  const packed = runFixture(fixture, 'data-pack.sh', ['--input', relativeInput, '--output', 'caller package.tar.gz'], {}, caller);
  assert.equal(packed.status, 0, packed.stderr);
  const listing = spawnSync('tar', ['-tzf', join(caller, 'caller package.tar.gz')], { encoding: 'utf8' });
  assert.match(listing.stdout, /caller\.txt/);
  assert.doesNotMatch(listing.stdout, /root\.txt/);
  assert.match(readFileSync(fixture.log, 'utf8'), new RegExp(`<--input> <${join(physicalCaller, relativeInput).replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`));

  writeFileSync(fixture.log, '');
  const imported = runFixture(fixture, 'data-import.sh', ['--input', relativeInput, '--check'], {}, caller);
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(readFileSync(fixture.log, 'utf8'), new RegExp(`<--input> <${join(physicalCaller, relativeInput).replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`));
});

macTest('data-import forwards directory checks and rejects archive links before the app CLI runs', (t) => {
  const fixture = createOperationFixture(t);
  const directoryInput = join(fixture.root, 'checked input');
  mkdirSync(directoryInput);
  writeFileSync(join(directoryInput, 'manifest.json'), '{}\n');
  const checked = runFixture(fixture, 'data-import.sh', ['--input', directoryInput, '--check']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(readFileSync(fixture.log, 'utf8'), new RegExp(`<data-check>.*<--input> <${directoryInput.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`));

  writeFileSync(fixture.log, '');
  const archiveRoot = join(fixture.root, 'unsafe source');
  mkdirSync(archiveRoot);
  writeFileSync(join(archiveRoot, 'target.txt'), 'fixture\n');
  symlinkSync('target.txt', join(archiveRoot, 'linked.txt'));
  const archive = join(fixture.root, 'unsafe.tar.gz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', archiveRoot, '.'], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const rejected = runFixture(fixture, 'data-import.sh', ['--input', archive, '--check']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /archive contains an unsupported entry type/);
  assert.equal(existsSync(fixture.log) ? readFileSync(fixture.log, 'utf8') : '', '');

  const fifoRoot = join(fixture.root, 'fifo source');
  mkdirSync(fifoRoot);
  const fifo = spawnSync('mkfifo', [join(fifoRoot, 'stream')], { encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.stderr);
  const fifoArchive = join(fixture.root, 'fifo.tar.gz');
  const fifoPacked = spawnSync('tar', ['-czf', fifoArchive, '-C', fifoRoot, '.'], { encoding: 'utf8' });
  assert.equal(fifoPacked.status, 0, fifoPacked.stderr);
  const fifoRejected = runFixture(fixture, 'data-import.sh', ['--input', fifoArchive, '--check']);
  assert.equal(fifoRejected.status, 1);
  assert.match(fifoRejected.stderr, /archive contains an unsupported entry type/);
  assert.equal(existsSync(fixture.log) ? readFileSync(fixture.log, 'utf8') : '', '');

  const reservedRoot = join(fixture.root, 'reserved source');
  mkdirSync(reservedRoot);
  writeFileSync(join(reservedRoot, 'CON.txt'), 'fixture\n');
  const reservedArchive = join(fixture.root, 'reserved.tar.gz');
  const reservedPacked = spawnSync('tar', ['-czf', reservedArchive, '-C', reservedRoot, '.'], { encoding: 'utf8' });
  assert.equal(reservedPacked.status, 0, reservedPacked.stderr);
  const reserved = runFixture(fixture, 'data-import.sh', ['--input', reservedArchive, '--check']);
  assert.equal(reserved.status, 1);
  assert.match(reserved.stderr, /Windows-reserved path/);
  assert.equal(existsSync(fixture.log) ? readFileSync(fixture.log, 'utf8') : '', '');

  const firstDuplicate = join(fixture.root, 'duplicate first');
  const secondDuplicate = join(fixture.root, 'duplicate second');
  mkdirSync(firstDuplicate);
  mkdirSync(secondDuplicate);
  writeFileSync(join(firstDuplicate, 'same.txt'), 'first\n');
  writeFileSync(join(secondDuplicate, 'same.txt'), 'second\n');
  const duplicateTar = join(fixture.root, 'duplicate.tar');
  assert.equal(spawnSync('tar', ['-cf', duplicateTar, '-C', firstDuplicate, 'same.txt']).status, 0);
  assert.equal(spawnSync('tar', ['-rf', duplicateTar, '-C', secondDuplicate, 'same.txt']).status, 0);
  const duplicateArchive = join(fixture.root, 'duplicate.tar.gz');
  const compressed = spawnSync('gzip', ['-c', duplicateTar], { encoding: null });
  assert.equal(compressed.status, 0, compressed.stderr?.toString());
  writeFileSync(duplicateArchive, compressed.stdout);
  const duplicate = runFixture(fixture, 'data-import.sh', ['--input', duplicateArchive, '--check']);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /unsafe or Windows-reserved path/);
  assert.equal(existsSync(fixture.log) ? readFileSync(fixture.log, 'utf8') : '', '');

  const trailingRoot = join(fixture.root, 'trailing source');
  mkdirSync(trailingRoot);
  writeFileSync(join(trailingRoot, 'trailing.'), 'fixture\n');
  const trailingArchive = join(fixture.root, 'trailing.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', trailingArchive, '-C', trailingRoot, '.']).status, 0);
  const trailing = runFixture(fixture, 'data-import.sh', ['--input', trailingArchive, '--check']);
  assert.equal(trailing.status, 1);
  assert.match(trailing.stderr, /unsafe or Windows-reserved path/);
  assert.equal(existsSync(fixture.log) ? readFileSync(fixture.log, 'utf8') : '', '');
});

macTest('backup records the exact code tag outside the manifest-protected backup directory', (t) => {
  const fixture = createOperationFixture(t);
  const git = (args) => spawnSync('git', args, { cwd: fixture.root, encoding: 'utf8' });
  assert.equal(git(['init']).status, 0);
  assert.equal(git(['config', 'user.name', 'BooruFlow test']).status, 0);
  assert.equal(git(['config', 'user.email', 'test@booruflow.invalid']).status, 0);
  assert.equal(git(['add', 'package.json', 'package-lock.json', '.env', 'scripts', 'config', 'bin/macos/backup.sh']).status, 0);
  assert.equal(git(['commit', '-m', 'fixture release']).status, 0);
  assert.equal(git(['tag', 'v0.88.0']).status, 0);
  assert.equal(git(['remote', 'add', 'origin', 'https://github.com/fzfz/booruflow.git']).status, 0);

  const result = runFixture(fixture, 'backup.sh');
  assert.equal(result.status, 0, result.stderr);
  const metadataPath = join(fixture.root, 'data/recovery/fixture-backup.json');
  assert.equal(existsSync(metadataPath), true);
  assert.deepEqual(JSON.parse(readFileSync(metadataPath, 'utf8')), {
    metadata_version: 1,
    backup: 'fixture-backup',
    tag: 'v0.88.0',
    repository_https: 'https://github.com/fzfz/booruflow.git'
  });
  assert.equal(existsSync(join(fixture.root, 'data/recovery/fixture-backup/fixture-backup.json')), false);
});

macTest('restore selects the backup code and dependencies before restoring snapshot configuration and data', (t) => {
  const fixture = createOperationFixture(t);
  mkdirSync(join(fixture.root, '.git'));
  mkdirSync(join(fixture.root, 'data/recovery/fixture-backup'), { recursive: true });
  mkdirSync(join(fixture.root, 'data/recovery/fixture-backup/.installation'), { recursive: true });
  writeFileSync(join(fixture.root, 'data/recovery/fixture-backup/.installation/.env'), 'NOOBAI_PUBLIC_PORT=65431\nNOOBAI_INTERNAL_PORT=65432\n');
  writeFileSync(join(fixture.root, 'data/recovery/fixture-backup.json'), JSON.stringify({
    metadata_version: 1,
    backup: 'fixture-backup',
    tag: 'v0.88.0',
    repository_https: 'https://github.com/fzfz/booruflow.git'
  }, null, 2));
  executable(join(fixture.bin, 'git'), `#!/bin/bash
printf 'git' >> "$BF_TEST_LOG"; printf ' <%s>' "$@" >> "$BF_TEST_LOG"; printf '\n' >> "$BF_TEST_LOG"
exit 0
`);
  executable(join(fixture.bin, 'npm'), `#!/bin/bash
printf 'npm' >> "$BF_TEST_LOG"; printf ' <%s>' "$@" >> "$BF_TEST_LOG"; printf '\n' >> "$BF_TEST_LOG"
exit 0
`);
  rmSync(join(fixture.root, '.env'));
  rmSync(join(fixture.root, 'node_modules'), { recursive: true });

  const result = runFixture(fixture, 'restore.sh', ['--backup', 'data/recovery/fixture-backup']);
  assert.equal(result.status, 0, result.stderr);
  const commands = readFileSync(fixture.log, 'utf8');
  assert.ok(commands.indexOf('git <checkout> <--detach> <v0.88.0>') < commands.indexOf('npm <ci>'));
  assert.ok(commands.indexOf('npm <ci>') < commands.indexOf('node <scripts/prod-restore.mjs>'));
  assert.match(readFileSync(join(fixture.root, '.env'), 'utf8'), /SNAPSHOT_CONFIGURATION=restored/);
});

macTest('real Node PID owns both ports and remains attributable in a Chinese installation path', async (t) => {
  const [publicPort, internalPort] = await availablePortPair();
  const parent = temporaryDirectory(t, 'booruflow-real-node-');
  const root = join(parent, '安装 test');
  mkdirSync(root);
  const fixture = createOperationFixture(t, root);
  writeFileSync(join(root, '.env'), `NOOBAI_PUBLIC_PORT=${publicPort}\nNOOBAI_INTERNAL_PORT=${internalPort}\n`);
  writeFileSync(join(root, 'scripts/runtime-data.mjs'), "if(process.argv[2] !== 'check') process.exit(2);\n");
  writeFileSync(join(root, 'scripts/start-local-app.mjs'), `
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const root = process.cwd();
const release = JSON.parse(readFileSync(join(root, 'config/release/release.json'), 'utf8'));
const shutdown = join(root, release.runtime.shutdown_file);
const servers = [Number(process.env.NOOBAI_PUBLIC_PORT), Number(process.env.NOOBAI_INTERNAL_PORT)].map((port) => createServer((_request, response) => response.end('ok')).listen(port, '127.0.0.1'));
let closing = false;
setInterval(async () => {
  if (closing || !existsSync(shutdown)) return;
  closing = true;
  await Promise.all(servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))));
  rmSync(shutdown, { force: true });
  process.exit(0);
}, release.runtime.poll_interval_seconds * 1000);
`);
  rmSync(join(fixture.bin, 'node'));
  symlinkSync(process.execPath, join(fixture.bin, 'node'));
  executable(join(fixture.bin, 'npm'), '#!/bin/bash\necho 10.9.3\n');
  executable(join(fixture.bin, 'git'), '#!/bin/bash\necho "git version 2.55.0"\n');
  const environment = {
    ...process.env,
    BF_TEST_LOG: fixture.log,
    BOORUFLOW_STARTUP_TIMEOUT_SECONDS: '10',
    PATH: `${fixture.bin}:/usr/bin:/bin:/usr/sbin:/sbin`
  };
  const started = spawn('/bin/bash', [join(root, 'bin/macos/start.sh')], { cwd: tmpdir(), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let startStdout = '';
  let startStderr = '';
  started.stdout.on('data', (chunk) => { startStdout += chunk; });
  started.stderr.on('data', (chunk) => { startStderr += chunk; });
  t.after(() => { if (started.exitCode === null) started.kill('SIGTERM'); });
  await waitUntil(() => existsSync(join(root, 'runtime/run/app.pid')));
  let status;
  await waitUntil(() => {
    status = spawnSync('/bin/bash', [join(root, 'bin/macos/status.sh')], { cwd: tmpdir(), env: environment, encoding: 'utf8' });
    return status.status === 0;
  });
  await waitUntil(() => startStdout.includes('is ready at'));
  const pid = Number(readFileSync(join(root, 'runtime/run/app.pid'), 'utf8').trim());
  const processName = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  assert.equal(processName.status, 0, processName.stderr);
  assert.match(processName.stdout, /node/);
  assert.match(status.stdout, new RegExp(`PID ${pid} is running`));
  const stopped = spawnSync('/bin/bash', [join(root, 'bin/macos/stop.sh')], { cwd: tmpdir(), env: environment, encoding: 'utf8', timeout: 15000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  const startExit = await new Promise((resolveExit) => started.once('close', resolveExit));
  assert.equal(startExit, 0, `${startStdout}\n${startStderr}`);
});

macTest('stopped status is resolved from the script location and returns the documented stopped code', (t) => {
  const fixture = createOperationFixture(t);
  const result = runFixture(fixture, 'status.sh');
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /BooruFlow is stopped/);
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:65431\//);
});

test('Windows entrypoints expose native batch orchestration without JavaScript process-manager calls', () => {
  for (const relativePath of batchScripts) assert.equal(existsSync(join(repositoryRoot, relativePath)), true, relativePath);
  const operations = readFileSync(join(repositoryRoot, 'scripts/platform/windows/operations.bat'), 'utf8');
  for (const token of ['Get-NetTCPConnection', 'Get-CimInstance Win32_Process', 'BF_SHUTDOWN_FILE', 'git fetch --tags origin', 'call npm ci', 'tar.exe -czf', 'tar.exe -tzf']) {
    assert.match(operations, new RegExp(token.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(operations, /taskkill \/PID/);
  assert.match(operations, /type nul > "%BF_SHUTDOWN_FILE%"/);
  assert.match(operations, /IndexOf\(\$env:BF_START_SCRIPT/);
  assert.doesNotMatch(operations, /prod-(?:start|stop|status)\.mjs/);
  assert.match(operations, /change to the Application root printed below, then run bin\\windows\\stop\.bat/);
  assert.match(operations, /change to the Application root printed below, then run bin\\windows\\restore\.bat/);
  assert.ok(operations.indexOf('git checkout --detach "%BF_RECOVERY_TAG%"') < operations.indexOf('node scripts\\prod-restore.mjs --backup'));
  for (const relativePath of batchScripts.filter((value) => basename(value) !== 'install.bat')) {
    const contents = readFileSync(join(repositoryRoot, relativePath), 'utf8');
    assert.match(contents, /for %%I in \("%~dp0\.\.\\\.\."\) do set "BF_ROOT=%%~fI"/);
    assert.match(contents, /scripts\\platform\\windows\\operations\.bat/);
    assert.doesNotMatch(contents, /call .*operations\.bat/i);
  }
});
