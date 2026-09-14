import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI_PATH = resolve(REPOSITORY_ROOT, 'scripts/imagegen-semantic-query.mjs');
const INSTALLER_PATH = resolve(REPOSITORY_ROOT, 'scripts/install-imagegen-semantic-query.mjs');
const NETWORK_FORBIDDEN_FIXTURE = resolve(REPOSITORY_ROOT, 'tests/fixtures/issue-180-network-forbidden.mjs');

function runProcess(command, args = [], { cwd, env = {} } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

function runNode(scriptPath, args = [], options = {}) {
  return runProcess(process.execPath, [scriptPath, ...args], options);
}

test('Issue #180 --version reports the self-contained CLI version without discovery or repository cwd', async (t) => {
  const callerDirectory = await mkdtemp(resolve(tmpdir(), 'issue-180-version-'));
  t.after(() => rm(callerDirectory, { recursive: true, force: true }));

  const result = await runNode(CLI_PATH, ['--version'], {
    cwd: callerDirectory,
    env: { NODE_OPTIONS: `--import=${pathToFileURL(NETWORK_FORBIDDEN_FIXTURE).href}` }
  });

  assert.deepEqual(result, {
    status: 0,
    signal: null,
    stdout: 'imagegen-semantic-query 2.0.0\n',
    stderr: ''
  });
});

test('Issue #180 --version rejects every additional argument locally instead of ignoring it', async () => {
  for (const args of [
    ['--version', '--port', '1'],
    ['--version', '--help'],
    ['--path', '/internal/semantic/example', '--version']
  ]) {
    const result = await runNode(CLI_PATH, args, { cwd: '/' });
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
    assert.equal(result.stderr, '{"error":{"code":"INVALID_ARGUMENT","message":"CLI arguments are invalid."}}\n', args.join(' '));
  }
});

test('Issue #180 importing the installer is side-effect free and exposes the exact default target', async () => {
  const moduleUrl = pathToFileURL(INSTALLER_PATH).href;
  const expression = `const { installationDestination } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(installationDestination([], { NODE_ENV: 'production' }) + '\\n');`;

  const result = await runProcess(process.execPath, ['--input-type=module', '--eval', expression], {
    cwd: '/',
    env: { NODE_ENV: 'test' }
  });

  assert.deepEqual(result, {
    status: 0,
    signal: null,
    stdout: `${resolve(homedir(), '.local/bin/imagegen-semantic-query')}\n`,
    stderr: ''
  });
});

test('Issue #284 manual installer copies both executable standalone CLIs to an explicit temporary test target', async (t) => {
  const testRoot = await mkdtemp(resolve(tmpdir(), 'issue-180-install-'));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const callerDirectory = resolve(testRoot, 'caller');
  const destinationDirectory = resolve(testRoot, 'target/bin');
  const destinations = {
    catalog: resolve(destinationDirectory, 'imagegen-semantic-query'),
    source: resolve(destinationDirectory, 'imagegen-comfyui-source-read')
  };
  await mkdir(callerDirectory);

  const install = await runNode(INSTALLER_PATH, ['--test-destination', destinations.catalog], {
    cwd: callerDirectory,
    env: { NODE_ENV: 'test' }
  });

  assert.deepEqual(install, {
    status: 0,
    signal: null,
    stdout: `Installed imagegen-semantic-query to ${destinations.catalog}\nInstalled imagegen-comfyui-source-read to ${destinations.source}\n`,
    stderr: ''
  });
  for (const [name, destination] of Object.entries(destinations)) {
    const status = await lstat(destination);
    assert.equal(status.isFile(), true, name);
    assert.equal(status.isSymbolicLink(), false, name);
    assert.equal(status.mode & 0o111, 0o111, name);
    const sourcePath = name === 'catalog'
      ? CLI_PATH
      : resolve(REPOSITORY_ROOT, 'scripts/imagegen-comfyui-source-read.mjs');
    assert.equal(await readFile(destination, 'utf8'), await readFile(sourcePath, 'utf8'), name);
  }

  const versions = await Promise.all([
    runProcess(destinations.catalog, ['--version'], { cwd: callerDirectory }),
    runProcess(destinations.source, ['--version'], { cwd: callerDirectory })
  ]);
  assert.deepEqual(versions.map(({ status, signal, stdout, stderr }) => ({ status, signal, stdout, stderr })), [
    { status: 0, signal: null, stdout: 'imagegen-semantic-query 2.0.0\n', stderr: '' },
    { status: 0, signal: null, stdout: 'imagegen-comfyui-source-read 1.0.0\n', stderr: '' }
  ]);
});

test('Issue #284 npm run cli:install installs and overwrite-updates both CLI files in one command', async (t) => {
  const testRoot = await mkdtemp(resolve(tmpdir(), 'issue-180-npm-install-'));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const destinationDirectory = resolve(testRoot, 'bin');
  const destinations = {
    catalog: resolve(destinationDirectory, 'imagegen-semantic-query'),
    source: resolve(destinationDirectory, 'imagegen-comfyui-source-read')
  };

  const first = await runProcess('npm', ['run', 'cli:install', '--', '--test-destination', destinations.catalog], {
    cwd: REPOSITORY_ROOT,
    env: { NODE_ENV: 'test', npm_config_cache: resolve(testRoot, 'npm-cache') }
  });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.match(first.stdout, new RegExp(`Installed imagegen-semantic-query to ${destinations.catalog.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\nInstalled imagegen-comfyui-source-read to ${destinations.source.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\n$`, 'u'));
  assert.equal(await readFile(destinations.catalog, 'utf8'), await readFile(CLI_PATH, 'utf8'));
  assert.equal(await readFile(destinations.source, 'utf8'), await readFile(resolve(REPOSITORY_ROOT, 'scripts/imagegen-comfyui-source-read.mjs'), 'utf8'));

  await Promise.all([
    writeFile(destinations.catalog, '#!/bin/false\nstale catalog content\n', 'utf8'),
    writeFile(destinations.source, '#!/bin/false\nstale source content\n', 'utf8'),
    chmod(destinations.catalog, 0o600),
    chmod(destinations.source, 0o600)
  ]);
  const update = await runProcess('npm', ['run', 'cli:install', '--', '--test-destination', destinations.catalog], {
    cwd: REPOSITORY_ROOT,
    env: { NODE_ENV: 'test', npm_config_cache: resolve(testRoot, 'npm-cache') }
  });

  assert.equal(update.status, 0, update.stderr);
  assert.equal(update.stderr, '');
  assert.equal(update.stdout, first.stdout);
  assert.equal(await readFile(destinations.catalog, 'utf8'), await readFile(CLI_PATH, 'utf8'));
  assert.equal(await readFile(destinations.source, 'utf8'), await readFile(resolve(REPOSITORY_ROOT, 'scripts/imagegen-comfyui-source-read.mjs'), 'utf8'));
  assert.equal((await lstat(destinations.catalog)).mode & 0o111, 0o111);
  assert.equal((await lstat(destinations.source)).mode & 0o111, 0o111);
});

test('Issue #180 test destination redirection is explicit, absolute, and unavailable outside test mode', async (t) => {
  const testRoot = await mkdtemp(resolve(tmpdir(), 'issue-180-test-target-'));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const destination = resolve(testRoot, 'bin/imagegen-semantic-query');
  const cases = [
    {
      args: [],
      env: { NODE_ENV: 'test' },
      message: 'test installation requires --test-destination <absolute-file>\n'
    },
    {
      args: ['--test-destination', destination],
      env: { NODE_ENV: 'production' },
      message: '--test-destination is available only when NODE_ENV=test\n'
    },
    {
      args: ['--test-destination', 'relative/imagegen-semantic-query'],
      env: { NODE_ENV: 'test' },
      message: '--test-destination must be an absolute file path\n'
    }
  ];

  for (const testCase of cases) {
    const result = await runNode(INSTALLER_PATH, testCase.args, { cwd: '/', env: testCase.env });
    assert.equal(result.status, 1, testCase.message);
    assert.equal(result.stdout, '', testCase.message);
    assert.equal(result.stderr, testCase.message);
  }
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('Issue #180 installer has one manual package entry and no automatic or uninstall trigger', async () => {
  const packageDocument = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  assert.equal(packageDocument.scripts['cli:install'], 'node scripts/install-imagegen-semantic-query.mjs');
  assert.equal(Object.keys(packageDocument.scripts).some((name) => name.includes('uninstall')), false);

  const automaticLifecycleNames = [
    'preinstall', 'install', 'postinstall', 'prepare',
    'prestart', 'poststart', 'pretest', 'posttest',
    'preprod:start', 'postprod:start', 'preprod:init', 'postprod:init'
  ];
  for (const name of automaticLifecycleNames) assert.equal(Object.hasOwn(packageDocument.scripts, name), false, name);
  for (const [name, command] of Object.entries(packageDocument.scripts)) {
    if (name === 'cli:install') continue;
    assert.doesNotMatch(command, /(?:cli:install|install-imagegen-semantic-query)/u, name);
  }

  const hooks = await runProcess('git', ['ls-files', '--', '.githooks/*', '.husky/*'], { cwd: REPOSITORY_ROOT });
  assert.equal(hooks.status, 0, hooks.stderr);
  assert.equal(hooks.stdout, '');

  const imagegenFiles = await runProcess('git', ['ls-files', '-co', '--exclude-standard', '--', '*imagegen-semantic-query*'], { cwd: REPOSITORY_ROOT });
  assert.equal(imagegenFiles.status, 0, imagegenFiles.stderr);
  assert.equal(imagegenFiles.stdout.split('\n').filter(Boolean).some((path) => path.toLowerCase().includes('uninstall')), false);

  const cliSource = await readFile(CLI_PATH, 'utf8');
  const installerSource = await readFile(INSTALLER_PATH, 'utf8');
  assert.equal(cliSource.match(/1\.0\.0/gu)?.length ?? 0, 0);
  assert.doesNotMatch(installerSource, /1\.0\.0/u);
});
