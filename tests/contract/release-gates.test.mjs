import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parse as parseYaml } from 'yaml';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const node = process.execPath;
const preflightScript = resolve(repositoryRoot, 'scripts/release/preflight.mjs');
const publishScript = resolve(repositoryRoot, 'scripts/release/publish.mjs');
const jobResultScript = resolve(repositoryRoot, 'scripts/release/check-job-results.mjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createReleaseFixture({
  metadataVersion = '1.2.3',
  defaultTag = 'v1.2.3',
  applicationVersion = '1.2.3',
  includeNotes = true,
  notMain = false,
  tagPointsElsewhere = false
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'booruflow-release-gate-'));
  const remote = join(root, 'remote.git');
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  git(checkout, ['init', '--initial-branch=main']);
  git(checkout, ['config', 'user.email', 'release-gate@example.invalid']);
  git(checkout, ['config', 'user.name', 'Release Gate Test']);
  mkdirSync(join(checkout, 'config', 'release'), { recursive: true });
  mkdirSync(join(checkout, 'schema', 'data-package'), { recursive: true });
  mkdirSync(join(checkout, 'docs', 'releases'), { recursive: true });
  mkdirSync(join(checkout, 'bin', 'windows'), { recursive: true });
  mkdirSync(join(checkout, 'bin', 'macos'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), `${JSON.stringify({ version: metadataVersion })}\n`);
  writeFileSync(join(checkout, 'config', 'release', 'release.json'), `${JSON.stringify({
    project_name: 'BooruFlow',
    default_tag: defaultTag,
    release_artifacts: { windows_installer: 'install.bat', macos_installer: 'install.sh' }
  })}\n`);
  writeFileSync(join(checkout, 'schema', 'data-package', 'definition.json'), `${JSON.stringify({ application_version: applicationVersion })}\n`);
  writeFileSync(join(checkout, 'bin', 'windows', 'install.bat'), '@echo off\necho install\n');
  writeFileSync(join(checkout, 'bin', 'macos', 'install.sh'), '#!/usr/bin/env bash\necho install\n');
  if (includeNotes) writeFileSync(join(checkout, 'docs', 'releases', 'v1.2.3.md'), 'four-language fixture\n');
  git(checkout, ['add', '.']);
  git(checkout, ['commit', '-m', 'release fixture']);
  git(root, ['init', '--bare', remote]);
  git(checkout, ['remote', 'add', 'origin', remote]);
  git(checkout, ['push', '--set-upstream', 'origin', 'main']);

  if (notMain) {
    git(checkout, ['switch', '-c', 'feature']);
    writeFileSync(join(checkout, 'feature.txt'), 'feature release\n');
    git(checkout, ['add', 'feature.txt']);
    git(checkout, ['commit', '-m', 'feature release']);
  }
  git(checkout, ['tag', '--annotate', 'v1.2.3', '--message', 'Release v1.2.3']);
  if (tagPointsElsewhere) {
    writeFileSync(join(checkout, 'after-tag.txt'), 'after tag\n');
    git(checkout, ['add', 'after-tag.txt']);
    git(checkout, ['commit', '-m', 'advance main after tag']);
    git(checkout, ['push', 'origin', 'main']);
  }
  return { root, checkout, sha: git(checkout, ['rev-parse', 'HEAD']) };
}

function installGhMock(fixtureRoot) {
  const bin = join(fixtureRoot, 'mock-bin');
  const log = join(fixtureRoot, 'gh-calls.jsonl');
  mkdirSync(bin);
  const executable = join(bin, 'gh');
  writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const record = { args };
if (args[0] === 'release' && args[1] === 'upload') {
  record.assets = args.slice(3, args.indexOf('--repo')).map((path) => ({ path, data: readFileSync(path).toString('base64') }));
}
appendFileSync(process.env.RELEASE_TEST_GH_LOG, JSON.stringify(record) + '\\n');
if (args[0] === 'api') {
  if (process.env.RELEASE_TEST_API_FAILURE) {
    process.stderr.write(process.env.RELEASE_TEST_API_FAILURE + '\\n');
    process.exit(1);
  }
  if (process.env.RELEASE_TEST_EXISTING === '1') {
    process.stdout.write('{"tag_name":"v1.2.3"}\\n');
    process.exit(0);
  }
  process.stderr.write('gh: Not Found (HTTP 404)\\n');
  process.exit(1);
}
if (process.env.RELEASE_TEST_FAIL_ON && args[0] === 'release' && args[1] === process.env.RELEASE_TEST_FAIL_ON) {
  process.stderr.write('injected gh failure\\n');
  process.exit(1);
}
process.exit(0);
`);
  chmodSync(executable, 0o755);
  return { bin, log };
}

function runReleaseScript(script, fixture, extraEnv = {}) {
  const gh = installGhMock(fixture.root);
  const result = spawnSync(node, [script, 'v1.2.3', fixture.sha, 'fzfz/booruflow'], {
    cwd: fixture.checkout,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${gh.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      RELEASE_TEST_GH_LOG: gh.log
    }
  });
  const calls = existsSync(gh.log)
    ? readFileSync(gh.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { result, calls };
}

function assertRejected(result, pattern) {
  assert.notEqual(result.status, 0, 'command must reject the invalid release');
  assert.match(result.stderr, pattern);
}

function readWorkflow(name) {
  const source = readFileSync(resolve(repositoryRoot, '.github', 'workflows', name), 'utf8');
  return { source, document: parseYaml(source) };
}

test('CI Gate runs on Ubuntu after verify and interchange and evaluates results even after failures', () => {
  const { document } = readWorkflow('fast.yml');
  const gate = document.jobs['ci-gate'];
  assert.equal(gate.name, 'CI Gate');
  assert.equal(gate['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(gate.needs, ['verify', 'interchange']);
  assert.match(gate.if, /always\(\)/u);
  assert.match(gate.steps.at(-1).run, /check-job-results\.mjs/u);
  assert.match(gate.steps.at(-1).run, /verify=.*interchange=/u);
});

test('Release Gate covers preflight, full verify, and interchange while publish remains tag-only and write-scoped', () => {
  const { source, document } = readWorkflow('release.yml');
  const gate = document.jobs['release-gate'];
  const publish = document.jobs.publish;
  assert.equal(document.permissions.contents, 'read');
  assert.equal(document.jobs.preflight['runs-on'], 'ubuntu-24.04');
  assert.equal(document.jobs.verify.needs, 'preflight');
  assert.equal(gate.name, 'Release Gate');
  assert.equal(gate['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(gate.needs, ['preflight', 'verify', 'interchange']);
  assert.match(gate.if, /always\(\)/u);
  assert.equal(publish.environment, 'github-release');
  assert.equal(publish['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(publish.permissions, { contents: 'write' });
  assert.equal(publish.needs, 'release-gate');
  assert.match(publish.if, /ref_type\s*==\s*'tag'/u);
  assert.match(publish.if, /needs\.release-gate\.result\s*==\s*'success'/u);
  assert.match(source, /ref:\s*\$\{\{ github\.sha \}\}/u);
});

test('gate predicate accepts only success for every required job', () => {
  const passing = spawnSync(node, [jobResultScript, 'verify=success', 'interchange=success'], { encoding: 'utf8' });
  assert.equal(passing.status, 0, passing.stderr);
  for (const result of ['failure', 'skipped', 'cancelled', '']) {
    const rejected = spawnSync(node, [jobResultScript, 'verify=success', `interchange=${result}`], { encoding: 'utf8' });
    assertRejected(rejected, /interchange=/u);
  }
  assertRejected(spawnSync(node, [jobResultScript], { encoding: 'utf8' }), /at least one job result/u);
  assertRejected(spawnSync(node, [jobResultScript, 'verify'], { encoding: 'utf8' }), /verify=missing/u);
});

test('release preflight accepts an exact tag and metadata on a commit reachable from origin/main', (context) => {
  const fixture = createReleaseFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const { result, calls } = runReleaseScript(preflightScript, fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map(({ args }) => args[0]), ['api']);
});

test('release preflight rejects a tag pointing at a different commit', (context) => {
  const fixture = createReleaseFixture({ tagPointsElsewhere: true });
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const { result, calls } = runReleaseScript(preflightScript, fixture);
  assertRejected(result, /Tag v1\.2\.3 points to .* not release commit/u);
  assert.deepEqual(calls, []);
});

test('release preflight rejects mismatched metadata, a non-main commit, and missing notes', (context) => {
  const cases = [
    [createReleaseFixture({ metadataVersion: '1.2.4' }), /package\.json version must equal 1\.2\.3/u],
    [createReleaseFixture({ defaultTag: 'v1.2.4' }), /default_tag must equal v1\.2\.3/u],
    [createReleaseFixture({ applicationVersion: '1.2.4' }), /application_version must equal 1\.2\.3/u],
    [createReleaseFixture({ notMain: true }), /not reachable from origin\/main/u],
    [createReleaseFixture({ includeNotes: false }), /Release notes are missing/u]
  ];
  context.after(() => cases.forEach(([fixture]) => rmSync(fixture.root, { recursive: true, force: true })));
  for (const [fixture, pattern] of cases) {
    const { result, calls } = runReleaseScript(preflightScript, fixture);
    assertRejected(result, pattern);
    assert.deepEqual(calls, []);
  }
});

test('release publication rejects an existing GitHub Release before creating or uploading anything', (context) => {
  const fixture = createReleaseFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const { result, calls } = runReleaseScript(publishScript, fixture, { RELEASE_TEST_EXISTING: '1' });
  assertRejected(result, /already exists/u);
  assert.deepEqual(calls.map(({ args }) => args.slice(0, 2)), [['api', 'repos/fzfz/booruflow/releases/tags/v1.2.3']]);
});

test('release publication rejects authorization and network errors while checking for an existing release', (context) => {
  const fixtures = [createReleaseFixture(), createReleaseFixture()];
  context.after(() => fixtures.forEach((fixture) => rmSync(fixture.root, { recursive: true, force: true })));
  const failures = ['gh: HTTP 403: Forbidden', 'could not resolve api.github.com'];
  for (let index = 0; index < failures.length; index += 1) {
    const { result, calls } = runReleaseScript(publishScript, fixtures[index], { RELEASE_TEST_API_FAILURE: failures[index] });
    assertRejected(result, /Could not prove that GitHub Release v1\.2\.3 is unused/u);
    assert.deepEqual(calls.map(({ args }) => args[0]), ['api']);
  }
});

test('release publication stages a draft, uploads normalized installers without clobber, then publishes', (context) => {
  const fixture = createReleaseFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const { result, calls } = runReleaseScript(publishScript, fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map(({ args }) => args.slice(0, 2)), [
    ['api', 'repos/fzfz/booruflow/releases/tags/v1.2.3'],
    ['release', 'create'],
    ['release', 'upload'],
    ['release', 'edit']
  ]);
  const create = calls[1].args;
  assert.ok(create.includes('--draft'));
  assert.ok(create.includes('--verify-tag'));
  assert.ok(create.includes('--notes-file'));
  const upload = calls[2];
  assert.equal(upload.args.includes('--clobber'), false);
  assert.deepEqual(upload.assets.map(({ path }) => path.split('/').at(-1)), ['install.bat', 'install.sh']);
  const windowsBytes = Buffer.from(upload.assets[0].data, 'base64');
  for (let index = 0; index < windowsBytes.length; index += 1) {
    if (windowsBytes[index] === 0x0a) assert.equal(windowsBytes[index - 1], 0x0d, 'install.bat LF must be preceded by CR');
  }
  assert.ok(calls[3].args.includes('--draft=false'));
});

test('release publication leaves the release as a draft when installer upload fails', (context) => {
  const fixture = createReleaseFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const { result, calls } = runReleaseScript(publishScript, fixture, { RELEASE_TEST_FAIL_ON: 'upload' });
  assertRejected(result, /injected gh failure/u);
  assert.deepEqual(calls.map(({ args }) => args.slice(0, 2)), [
    ['api', 'repos/fzfz/booruflow/releases/tags/v1.2.3'],
    ['release', 'create'],
    ['release', 'upload']
  ]);
});
