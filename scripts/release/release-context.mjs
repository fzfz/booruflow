import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const VERSION_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function fail(message) {
  throw new Error(message);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} must be valid JSON: ${path} (${error.message})`);
  }
}

function run(command, args, { allowFailure = false, cwd = process.cwd(), env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function gitOutput(args, options) {
  return run('git', args, options).stdout.trim();
}

export function releaseNotesPath(tag, root = process.cwd()) {
  return resolve(root, 'docs', 'releases', `${tag}.md`);
}

export function requireReleaseMetadata(tag, root = process.cwd()) {
  if (!VERSION_TAG.test(tag)) fail(`Release tag must match vX.Y.Z exactly: ${tag}`);
  const version = tag.slice(1);
  const packagePath = resolve(root, 'package.json');
  const releaseConfigPath = resolve(root, 'config', 'release', 'release.json');
  const dataPackagePath = resolve(root, 'schema', 'data-package', 'definition.json');
  const packageDocument = readJson(packagePath, 'Package metadata');
  const releaseConfig = readJson(releaseConfigPath, 'Release configuration');
  const dataPackageDefinition = readJson(dataPackagePath, 'Data-package definition');
  const facts = [
    ['package.json version', packageDocument.version, version],
    ['config/release/release.json default_tag', releaseConfig.default_tag, tag],
    ['schema/data-package/definition.json application_version', dataPackageDefinition.application_version, version]
  ];
  for (const [label, actual, expected] of facts) {
    if (actual !== expected) fail(`${label} must equal ${expected}; received ${String(actual)}`);
  }
  const notesPath = releaseNotesPath(tag, root);
  if (!existsSync(notesPath)) {
    fail(`Release notes are missing. Add the maintained four-language file: docs/releases/${tag}.md`);
  }
  return Object.freeze({ tag, version, notesPath, releaseConfig });
}

export function requireReleaseCommit(tag, expectedSha, root = process.cwd()) {
  if (!/^[0-9a-f]{40,64}$/u.test(expectedSha)) fail(`Expected commit SHA is invalid: ${expectedSha}`);
  const head = gitOutput(['rev-parse', 'HEAD'], { cwd: root });
  if (head !== expectedSha) fail(`Checked-out commit ${head} does not equal release commit ${expectedSha}`);
  const tagCommit = gitOutput(['rev-parse', `refs/tags/${tag}^{commit}`], { cwd: root });
  if (tagCommit !== expectedSha) fail(`Tag ${tag} points to ${tagCommit}, not release commit ${expectedSha}`);
  const originMain = gitOutput(['rev-parse', 'refs/remotes/origin/main^{commit}'], { cwd: root });
  const ancestry = run('git', ['merge-base', '--is-ancestor', expectedSha, originMain], {
    cwd: root,
    allowFailure: true
  });
  if (ancestry.status === 1) fail(`Release commit ${expectedSha} is not reachable from origin/main`);
  if (ancestry.status !== 0) {
    const detail = (ancestry.stderr || ancestry.stdout || '').trim();
    fail(`Could not verify that release commit ${expectedSha} is reachable from origin/main${detail ? `: ${detail}` : ''}`);
  }
}

export function requireMissingGitHubRelease(tag, repository, options = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail(`GitHub repository must use owner/name syntax: ${repository}`);
  }
  const result = run('gh', ['api', `repos/${repository}/releases/tags/${tag}`], {
    ...options,
    allowFailure: true
  });
  if (result.status === 0) fail(`A GitHub Release already exists for ${tag}; publication will not overwrite it`);
  const detail = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (!/\bHTTP\s+404\b/u.test(detail)) {
    fail(`Could not prove that GitHub Release ${tag} is unused${detail.trim() ? `: ${detail.trim()}` : ''}`);
  }
}

export function requireReleaseContext({ tag, expectedSha, repository, root = process.cwd(), env = process.env }) {
  const context = requireReleaseMetadata(tag, root);
  requireReleaseCommit(tag, expectedSha, root);
  requireMissingGitHubRelease(tag, repository, { cwd: root, env });
  return context;
}

export function runCommand(command, args, options) {
  return run(command, args, options);
}
