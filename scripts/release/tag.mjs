import { spawnSync } from 'node:child_process';

import { requireReleaseMetadata, VERSION_TAG } from './release-context.mjs';

function fail(message) {
  throw new Error(message);
}

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' });
  if (result.error) fail(`无法运行 git ${args.join(' ')}：${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`git ${args.join(' ')} 失败${detail ? `：${detail}` : ''}`);
  }
  return result;
}

function output(args) {
  return runGit(args).stdout.trim();
}

function requireCleanMain() {
  if (output(['branch', '--show-current']) !== 'main') {
    fail('只能从 main 分支创建发布标签');
  }
  if (output(['status', '--porcelain=v1']) !== '') {
    fail('工作树必须干净');
  }
}

function requireSynchronizedMain() {
  runGit(['fetch', '--quiet', 'origin', 'main']);
  const [ahead, behind] = output(['rev-list', '--left-right', '--count', 'main...FETCH_HEAD'])
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10));
  if (ahead !== 0 || behind !== 0) {
    fail(`main 必须与 origin/main 同步（领先 ${ahead}，落后 ${behind}）`);
  }
}

function requireUnusedTag(tag) {
  if (runGit(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { allowFailure: true }).status === 0) {
    fail(`标签 ${tag} 已存在于本地仓库`);
  }
  const remoteTag = runGit(['ls-remote', '--exit-code', '--refs', 'origin', `refs/tags/${tag}`], { allowFailure: true });
  if (remoteTag.status === 0) {
    fail(`标签 ${tag} 已存在于 origin`);
  }
  if (remoteTag.status !== 2) {
    const detail = (remoteTag.stderr || remoteTag.stdout || '').trim();
    fail(`无法确认 origin 中的标签 ${tag}${detail ? `：${detail}` : ''}`);
  }
}

function main() {
  const argumentsAfterCommand = process.argv.slice(2);
  if (argumentsAfterCommand.length !== 1 || !VERSION_TAG.test(argumentsAfterCommand[0])) {
    fail('用法：npm run release:tag -- vX.Y.Z');
  }
  const [tag] = argumentsAfterCommand;
  requireCleanMain();
  requireSynchronizedMain();
  requireUnusedTag(tag);
  requireReleaseMetadata(tag);
  runGit(['tag', '--annotate', tag, '--message', `Release ${tag}`]);
  runGit(['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
  process.stdout.write(`已创建并推送带注释标签 ${tag}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
