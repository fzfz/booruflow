import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireReleaseContext, runCommand } from './release-context.mjs';

function prepareInstallers(context, root) {
  const directory = mkdtempSync(join(tmpdir(), 'booruflow-release-'));
  const windowsName = context.releaseConfig.release_artifacts.windows_installer;
  const macosName = context.releaseConfig.release_artifacts.macos_installer;
  if (basename(windowsName) !== windowsName || basename(macosName) !== macosName) {
    throw new Error('Release artifact names must be plain file names');
  }
  const windowsTarget = join(directory, windowsName);
  const macosTarget = join(directory, macosName);
  const windowsSource = resolve(root, 'bin', 'windows', 'install.bat');
  const macosSource = resolve(root, 'bin', 'macos', 'install.sh');
  const windowsText = readFileSync(windowsSource, 'utf8').replace(/\r?\n/gu, '\r\n');
  writeFileSync(windowsTarget, windowsText, 'utf8');
  copyFileSync(macosSource, macosTarget);
  chmodSync(macosTarget, 0o755);
  return Object.freeze({ directory, windowsTarget, macosTarget });
}

export function main([tag, expectedSha, repository] = process.argv.slice(2)) {
  if (!tag || !expectedSha || !repository || process.argv.slice(2).length !== 3) {
    throw new Error('Usage: node scripts/release/publish.mjs vX.Y.Z COMMIT_SHA OWNER/REPOSITORY');
  }
  const root = process.cwd();
  const context = requireReleaseContext({ tag, expectedSha, repository, root });
  const installers = prepareInstallers(context, root);
  try {
    runCommand('gh', [
      'release', 'create', tag,
      '--repo', repository,
      '--draft',
      '--verify-tag',
      '--title', `${context.releaseConfig.project_name} ${tag}`,
      '--notes-file', context.notesPath
    ], { cwd: root });
    runCommand('gh', [
      'release', 'upload', tag,
      installers.windowsTarget,
      installers.macosTarget,
      '--repo', repository
    ], { cwd: root });
    runCommand('gh', [
      'release', 'edit', tag,
      '--repo', repository,
      '--draft=false'
    ], { cwd: root });
  } finally {
    rmSync(installers.directory, { recursive: true, force: true });
  }
  process.stdout.write(`Published GitHub Release ${tag} with ${basename(installers.windowsTarget)} and ${basename(installers.macosTarget)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
