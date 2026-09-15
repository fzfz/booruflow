import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const releaseScript = resolve(repositoryRoot, 'scripts/release/tag.mjs');
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: options.stdio ?? 'pipe' }).trim();
}

function createGitFixture({ branch = 'main', dirty = false, ahead = false, behind = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'noobai-issue86-git-'));
  const remote = join(root, 'remote.git');
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  git(checkout, ['init', '--initial-branch=main']);
  git(checkout, ['config', 'user.email', 'issue86@example.invalid']);
  git(checkout, ['config', 'user.name', 'Issue 86 Test']);
  writeFileSync(join(checkout, 'README.md'), 'fixture\n');
  mkdirSync(join(checkout, 'config', 'release'), { recursive: true });
  mkdirSync(join(checkout, 'schema', 'data-package'), { recursive: true });
  mkdirSync(join(checkout, 'docs', 'releases'), { recursive: true });
  writeFileSync(join(checkout, 'package.json'), '{"version":"1.2.3"}\n');
  writeFileSync(join(checkout, 'config', 'release', 'release.json'), '{"default_tag":"v1.2.3"}\n');
  writeFileSync(join(checkout, 'schema', 'data-package', 'definition.json'), '{"application_version":"1.2.3"}\n');
  writeFileSync(join(checkout, 'docs', 'releases', 'v1.2.3.md'), 'fixture release notes\n');
  git(checkout, ['add', '.']);
  git(checkout, ['commit', '-m', 'fixture']);
  git(root, ['init', '--bare', remote]);
  git(checkout, ['remote', 'add', 'origin', remote]);
  git(checkout, ['push', '--set-upstream', 'origin', 'main']);

  if (behind) {
    const advance = join(root, 'remote-advance');
    git(root, ['clone', '--branch', 'main', remote, advance]);
    git(advance, ['config', 'user.email', 'issue86@example.invalid']);
    git(advance, ['config', 'user.name', 'Issue 86 Test']);
    writeFileSync(join(advance, 'remote-advance.txt'), 'remote advance\n');
    git(advance, ['add', 'remote-advance.txt']);
    git(advance, ['commit', '-m', 'advance remote main']);
    git(advance, ['push', 'origin', 'main']);
  }

  if (branch !== 'main') git(checkout, ['switch', '-c', branch]);
  if (ahead) {
    writeFileSync(join(checkout, 'ahead.txt'), 'ahead\n');
    git(checkout, ['add', 'ahead.txt']);
    git(checkout, ['commit', '-m', 'ahead']);
  }
  if (dirty) writeFileSync(join(checkout, 'README.md'), 'dirty\n');
  return { root, checkout, remote };
}

function installPushRecordingGit(fixtureRoot) {
  const bin = join(fixtureRoot, 'bin');
  mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const log = join(fixtureRoot, 'git-push.log');
  const shim = join(bin, 'git');
  writeFileSync(shim, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst args = process.argv.slice(2);\nif (args[0] === 'push') { appendFileSync(process.env.ISSUE86_PUSH_LOG, JSON.stringify(args) + '\\n'); process.exit(0); }\nconst result = spawnSync(process.env.ISSUE86_REAL_GIT, args, { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`);
  chmodSync(shim, 0o755);
  return { bin, log, realGit };
}

function runReleaseTag(checkout, tag, fixtureRoot, extraEnv = {}) {
  const pushShim = installPushRecordingGit(fixtureRoot);
  const path = `${pushShim.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  return {
    pushLog: pushShim.log,
    result: spawnSync(process.execPath, [releaseScript, tag], {
      cwd: checkout,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        PATH: path,
        ISSUE86_PUSH_LOG: pushShim.log,
        ISSUE86_REAL_GIT: pushShim.realGit
      }
    })
  };
}

function pushCalls(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function assertRejected(result, message) {
  assert.doesNotMatch(result.stderr ?? '', /(?:Cannot find module|MODULE_NOT_FOUND)/u, `${message} 的失败必须来自发布命令本身`);
  assert.notEqual(result.status, 0, message);
}

function nonCommentLines(source) {
  return source.split('\n').map((line) => (/^\s*#/u.test(line) ? '' : line));
}

function workflowRunBlocks(source) {
  const lines = nonCommentLines(source);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run\s*:\s*(.*)$/u);
    if (!match) continue;
    const indent = match[1].length;
    const values = [];
    if (match[2].trim()) values.push(match[2].trim());
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim() && line.search(/\S/u) <= indent) break;
      if (line.trim()) values.push(line.trim());
      index = next;
    }
    blocks.push(values.join('\n'));
  }
  return blocks;
}

function assertWorkflowShape(source, file) {
  const lines = nonCommentLines(source);
  assert.match(lines.join('\n'), /^(?:name|['"]name['"]):\s*\S/mu, `${file} 必须声明顶层 name`);
  assert.match(lines.join('\n'), /^(?:on|['"]on['"]):(?:\s*\S|\s*$)/mu, `${file} 必须声明顶层 on`);
  assert.match(lines.join('\n'), /^jobs:\s*$/mu, `${file} 必须声明顶层 jobs`);
  assert.ok(workflowRunBlocks(source).length > 0, `${file} 必须至少包含一个实际 job 的 run 步骤`);
}

function assertNoProductionAccess(source, file) {
  const target = file.endsWith('.yml')
    ? [...workflowRunBlocks(source), ...nonCommentLines(source).filter((line) => /working-directory\s*:/u.test(line))].join('\n')
    : source;
  assert.doesNotMatch(
    target,
    /(?:\b(?:cd|git\s+-C|find|rm|cp|mv)\b[^\n]*(?:production|prod(?:uction)?[\\/])|working-directory\s*:[^\n]*(?:production|prod(?:uction)?[\\/])|(?:PRODUCTION_DIR|NOOBAI_PRODUCTION_DIR|prod:(?:start|stop|status)))/iu,
    `${file} 不得访问或修改本机生产目录`
  );
}

function assertFastCiSteps(source, file, { requireTriggers = true } = {}) {
  assertWorkflowShape(source, file);
  const runSource = workflowRunBlocks(source).join('\n');
  if (requireTriggers) {
    const structure = nonCommentLines(source).join('\n');
    assert.match(structure, /pull_request\s*:/u, `${file} 必须在 PR 触发`);
    assert.match(structure, /push\s*:[\s\S]*?branches\s*:\s*(?:\[[^\]]*\bmain\b|[\s\S]{0,100}-\s*main\b)/u, `${file} 必须在 main 推送触发`);
  }
  assert.match(runSource, /npm\s+ci\b/u, `${file} 必须执行锁定依赖安装`);
  assert.match(runSource, /git\s+(?:diff|apply)\s+--check\b/u, `${file} 必须执行 Git 空白检查`);
  assert.match(runSource, /(?:(?:rg|grep|git\s+grep|scan|check)[^\n]*(?:secret|credential)|(?:secret|credential)[^\n]*(?:rg|grep|scan|check))/iu, `${file} 必须执行凭据泄漏扫描`);
  for (const command of ['test:contract', 'test:unit', 'test:integration']) {
    assert.match(runSource, new RegExp(`npm\\s+run\\s+${command}\\b`, 'u'), `${file} 必须执行 ${command}`);
  }
}

test('Issue #86 发布标签命令公开 release:tag → scripts/release/tag.mjs 接口', () => {
  assert.match(packageJson.scripts?.['release:tag'] ?? '', /node\s+scripts\/release\/tag\.mjs\b/u);
  assert.equal(existsSync(releaseScript), true, '发布脚本必须存在');
});

test('发布标签命令在干净且同步的 main 上创建带注释标签并模拟 push', () => {
  const fixture = createGitFixture();
  const production = join(fixture.root, 'production-sentinel');
  mkdirSync(production);
  writeFileSync(join(production, 'sentinel.txt'), 'must remain untouched\n');
  const before = readFileSync(join(production, 'sentinel.txt'), 'utf8');
  const { result, pushLog } = runReleaseTag(fixture.checkout, 'v1.2.3', fixture.root, { ISSUE86_PRODUCTION_DIR: production });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(fixture.checkout, ['cat-file', '-t', 'v1.2.3']), 'tag', '标签必须是 annotated tag 对象');
  const tagObject = git(fixture.checkout, ['cat-file', '-p', 'v1.2.3']);
  assert.match(tagObject, /\ntag v1\.2\.3\n/u, 'annotated tag 必须记录目标版本名');
  assert.match(tagObject.split('\n\n').slice(1).join('\n\n').trim(), /\S/u, 'annotated tag 必须包含非空发布说明');
  const pushes = pushCalls(pushLog);
  assert.equal(pushes.length, 1, '命令必须只执行一次模拟 push');
  assert.ok(pushes[0].includes('origin'), 'push 必须指向 origin');
  assert.ok(pushes[0].some((argument) => argument.includes('v1.2.3')), 'push 必须只包含目标版本标签');
  assert.equal(readFileSync(join(production, 'sentinel.txt'), 'utf8'), before, '发布命令不得修改生产目录');
  const remoteTag = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/tags/v1.2.3'], {
    cwd: fixture.remote,
    encoding: 'utf8'
  });
  assert.equal(remoteTag.status, 1, '模拟 push 不得修改临时远程');
});

test('发布标签命令拒绝非 main、脏工作树、未同步 main 与非法语义版本', () => {
  const cases = [
    ['non-main', createGitFixture({ branch: 'feature' }), 'v1.2.3'],
    ['dirty', createGitFixture({ dirty: true }), 'v1.2.4'],
    ['ahead-of-origin', createGitFixture({ ahead: true }), 'v1.2.5'],
    ['behind-origin', createGitFixture({ behind: true }), 'v1.2.6'],
    ['invalid-semver', createGitFixture(), '1.2.3']
  ];
  for (const [name, fixture, tag] of cases) {
    const { result, pushLog } = runReleaseTag(fixture.checkout, tag, fixture.root);
    assertRejected(result, `${name} 必须拒绝发布标签`);
    assert.deepEqual(pushCalls(pushLog), [], `${name} 拒绝时不得 push`);
    assert.equal(git(fixture.checkout, ['tag', '--list', tag]), '', `${name} 拒绝时不得创建标签`);
  }
});

test('fast CI 在 PR/main 运行快速门禁，且不访问生产目录', () => {
  const workflowPath = resolve(repositoryRoot, '.github/workflows/fast.yml');
  const source = readFileSync(workflowPath, 'utf8');
  assertFastCiSteps(source, '.github/workflows/fast.yml');
  assertNoProductionAccess(source, '.github/workflows/fast.yml');
});

test('release CI 仅在 vX.Y.Z 标签运行快速门禁并额外运行现有 E2E，且不访问生产目录', () => {
  const workflowPath = resolve(repositoryRoot, '.github/workflows/release.yml');
  const source = readFileSync(workflowPath, 'utf8');
  assertWorkflowShape(source, '.github/workflows/release.yml');
  const structure = nonCommentLines(source).join('\n');
  assert.match(structure, /push\s*:/u, 'release CI 必须由 push 事件触发');
  assert.match(structure, /tags\s*:/u, 'release CI 必须声明 tags 过滤器');
  assert.match(structure, /tags\s*:[\s\S]{0,160}(?:v\*|v\[[0-9]|v\d|semantic)/iu, 'release CI 必须限定 vX.Y.Z 版本标签触发');
  if (/\.\/\.github\/workflows\/fast\.yml/u.test(source)) {
    assert.match(source, /uses\s*:\s*\.\/\.github\/workflows\/fast\.yml/u, 'release CI 必须复用 fast workflow');
  } else {
    assertFastCiSteps(source, '.github/workflows/release.yml', { requireTriggers: false });
  }
  assert.match(workflowRunBlocks(source).join('\n'), /node\s+scripts\/testing\/run-e2e-tests\.mjs\b/u, 'release CI 必须额外运行 E2E');
  assertNoProductionAccess(source, '.github/workflows/release.yml');
});

test('fast and release CI credential scans require the same token boundary before credential prefixes', () => {
  for (const workflow of ['fast.yml', 'release.yml']) {
    const source = readFileSync(resolve(repositoryRoot, '.github/workflows', workflow), 'utf8');
    const scan = workflowRunBlocks(source).find((block) => /credential leak detected/u.test(block));
    assert.equal(typeof scan, 'string', workflow);
    assert.match(scan, /\(\^\|\[\^\[:alnum:\]_\]\)\(sk-/u, workflow);
  }
});

test('发布标签脚本自身不包含生产目录访问边界', () => {
  assertNoProductionAccess(readFileSync(releaseScript, 'utf8'), 'scripts/release/tag.mjs');
});
