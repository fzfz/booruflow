import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { createManualIngestRunner } from '../../app/ingest/manual-ingest.mjs';
import { createConfiguredVectorModelClient, loadVectorModelConfiguration } from '../../app/vector/model-client.mjs';
import {
  createIllustriousNoobaiStyleExplorerAdapter,
  parseIllustriousNoobaiStyleExplorerGalleryData
} from '../../app/ingest/sources/illustrious-noobai-style-explorer.mjs';

const execFileAsync = promisify(execFile);
export const AUDITED_REPOSITORY_URL = 'https://github.com/ThetaCursed/Illustrious-NoobAI-Style-Explorer.git';
export const AUDITED_COMMIT = 'ef220b46f2b67f5e7f82291e92a6a8ebac9fb781';
const SOURCE_DIRECTORY_NAME = 'illustrious-noobai-style-explorer';
const SOURCE_BASE_URL = `https://raw.githubusercontent.com/ThetaCursed/Illustrious-NoobAI-Style-Explorer/${AUDITED_COMMIT}/`;
const SOURCE_BASE_MODEL_NAME = 'wai';
const MAX_SOURCE_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_GALLERY_RECORDS = 40_000;
const MAX_IMAGES = 50_000;
if (constants.O_NOFOLLOW === undefined) throw new Error('Illustrious NoobAI Style Explorer importer requires fs.O_NOFOLLOW');
const NOFOLLOW_FLAG = constants.O_NOFOLLOW;
const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  LANG: process.env.LANG ?? 'C',
  LC_ALL: process.env.LC_ALL ?? 'C',
  TMPDIR: process.env.TMPDIR ?? '/tmp',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0'
};

function fail(message) {
  throw new Error(`usage: node ingest/manual/run-illustrious-noobai-style-explorer.mjs --data-root <controlled-data-root> (${message})`);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name !== '--data-root') fail(`unsupported argument ${name}`);
    if (Object.hasOwn(values, name)) fail(`argument specified more than once: ${name}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail(`${name} requires a value`);
    values[name] = value;
    index += 1;
  }
  if (typeof values['--data-root'] !== 'string') fail('--data-root is required');
  return Object.freeze({ dataRoot: resolve(values['--data-root']) });
}

function assertDirectory(path, label, { allowMissing = false } = {}) {
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`${label} must be a non-symbolic-link directory`);
  } catch (error) {
    if (error?.code === 'ENOENT' && allowMissing) return false;
    throw error;
  }
  return true;
}

function assertControlledPath(root, candidate, label) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) throw new Error(`${label} escapes its controlled directory`);
  return resolvedCandidate;
}

function sourceDirectoryFor(dataRoot) {
  assertDirectory(dataRoot, 'data root');
  const sourcesDirectory = assertControlledPath(dataRoot, resolve(dataRoot, '.sources'), 'source directory');
  if (!assertDirectory(sourcesDirectory, 'source parent directory', { allowMissing: true })) mkdirSync(sourcesDirectory, { recursive: false, mode: 0o700 });
  assertDirectory(sourcesDirectory, 'source parent directory');
  return assertControlledPath(sourcesDirectory, resolve(sourcesDirectory, SOURCE_DIRECTORY_NAME), 'source clone directory');
}

async function runGit(args, options = {}) {
  return execFileAsync('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'credential.helper=',
    '-c', 'core.fsmonitor=false',
    ...args
  ], {
    cwd: options.cwd,
    env: GIT_ENV,
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
}

async function verifyLocalGitConfig(directory, git = runGit) {
  const { stdout } = await git(['-c', 'include.path=/dev/null', 'config', '--local', '--name-only', '--null', '--list'], { cwd: directory });
  const names = stdout.split('\0').filter(Boolean);
  const allowed = [
    /^core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/u,
    /^remote\.origin\.(?:url|tagopt|fetch|promisor|partialclonefilter)$/u,
    /^branch\.[^.]+\.(?:remote|merge)$/u
  ];
  const unexpected = names.find((name) => !allowed.some((pattern) => pattern.test(name.toLocaleLowerCase('und'))));
  if (unexpected) throw new Error(`source clone local Git config contains forbidden setting ${unexpected}`);
}

async function verifyPinnedHead(directory, git = runGit, { verifyConfig = true } = {}) {
  if (verifyConfig) await verifyLocalGitConfig(directory, git);
  const { stdout } = await git(['rev-parse', 'HEAD'], { cwd: directory });
  if (stdout.trim() !== AUDITED_COMMIT) throw new Error(`source clone HEAD must equal audited commit ${AUDITED_COMMIT}`);
  const { stdout: indexFlags } = await git(['ls-files', '-v', '-z'], { cwd: directory });
  const flagged = indexFlags.split('\0').find((entry) => /^[hSs] /u.test(entry));
  if (flagged) throw new Error(`source clone index contains a skip-worktree or assume-unchanged entry ${flagged.slice(2)}`);
  const { stdout: status } = await git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: directory });
  if (status.trim() !== '') throw new Error('source clone working tree must be clean at the audited commit');
}

export async function cloneAuditedRepository({ dataRoot, git = runGit } = {}) {
  const destination = sourceDirectoryFor(dataRoot);
  if (assertDirectory(destination, 'source clone directory', { allowMissing: true })) {
    await verifyPinnedHead(destination, git);
    return destination;
  }
  await git(['clone', '--no-checkout', '--no-tags', '--no-recurse-submodules', '--filter=blob:none', AUDITED_REPOSITORY_URL, destination]);
  try {
    await verifyLocalGitConfig(destination, git);
    await git(['fetch', '--depth=1', 'origin', AUDITED_COMMIT], { cwd: destination });
    await git(['checkout', '--detach', '--force', AUDITED_COMMIT], { cwd: destination });
    await verifyPinnedHead(destination, git, { verifyConfig: false });
    assertDirectory(destination, 'source clone directory');
    return destination;
  } catch (error) {
    throw new Error(`audited source clone is unusable: ${error.message}`);
  }
}

function safeReadFile(root, relativePath, { maxBytes, label }) {
  const absolutePath = assertControlledPath(root, resolve(root, relativePath), label);
  const segments = relativePath.split('/');
  let currentPath = resolve(root);
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') throw new Error(`${label} has an unsafe relative path`);
    currentPath = resolve(currentPath, segment);
    const currentStatus = lstatSync(currentPath);
    if (currentStatus.isSymbolicLink()) throw new Error(`${label} must not traverse symbolic links`);
  }
  const status = lstatSync(absolutePath);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`${label} must be a regular non-symbolic-link file`);
    if (status.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    const descriptor = openSync(absolutePath, constants.O_RDONLY | NOFOLLOW_FLAG);
    try {
      const openedStatus = fstatSync(descriptor);
      if (!openedStatus.isFile()) throw new Error(`${label} must be a regular non-symbolic-link file`);
      if (openedStatus.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
      const bytes = readFileSync(descriptor);
    if (bytes.length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} byte limit`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function normalizePromptLines(artistText, galleryData) {
  const withoutFinalNewline = artistText.replace(/\r?\n$/u, '');
  const artistLines = withoutFinalNewline.length === 0 ? [] : withoutFinalNewline.split(/\r?\n/u);
  if (artistLines.length < galleryData.length) throw new Error(`artist text list has fewer lines than galleryData: ${artistLines.length} < ${galleryData.length}`);
  return galleryData.map((entry, index) => `${entry.name}\t${artistLines[index].normalize('NFC').replace(/\\([()])/gu, '$1').trim()}`);
}

function sourceUrl(relativePath) {
  return new URL(relativePath, SOURCE_BASE_URL).toString();
}

function createLocalPreviewReader(sourceDirectory) {
  return async ({ sourceId, previewReference }) => {
    const relativePath = `images/${previewReference}/${sourceId}.webp`;
    const bytes = safeReadFile(sourceDirectory, relativePath, { maxBytes: MAX_IMAGE_BYTES, label: `preview image ${relativePath}` });
    return Object.freeze({ bytes, media_type: 'image/webp' });
  };
}

function createAdapter({ sourceDirectory, existingStyles, baseModelId }) {
  assertDirectory(sourceDirectory, 'source clone directory');
  const dataSource = safeReadFile(sourceDirectory, 'app/data.js', { maxBytes: MAX_SOURCE_TEXT_BYTES, label: 'app/data.js' }).toString('utf8');
  const artistText = safeReadFile(sourceDirectory, 'Illustrious-NoobAI-33k-Compatible-Artists.txt', { maxBytes: MAX_SOURCE_TEXT_BYTES, label: 'artist text list' }).toString('utf8');
  const galleryData = parseIllustriousNoobaiStyleExplorerGalleryData(dataSource);
  if (galleryData.length > MAX_GALLERY_RECORDS) throw new Error(`galleryData exceeds ${MAX_GALLERY_RECORDS} record limit`);
  const imageCount = galleryData.reduce((count, entry) => count + entry.p.length, 0);
  if (imageCount > MAX_IMAGES) throw new Error(`galleryData previews exceed ${MAX_IMAGES} image limit`);
  return createIllustriousNoobaiStyleExplorerAdapter({
    galleryData,
    promptLines: normalizePromptLines(artistText, galleryData),
    existingStyles,
    baseModelId,
    sourceBaseUrl: SOURCE_BASE_URL,
    sourceUrl: sourceUrl('app/data.js'),
    previewBaseUrl: sourceUrl('images/'),
    previewUrlBuilder: (sourceId, previewReference) => sourceUrl(`images/${encodeURIComponent(previewReference)}/${encodeURIComponent(sourceId)}.webp`),
    autoDownloadAllPreviews: true,
    readPreview: createLocalPreviewReader(sourceDirectory)
  });
}

export async function main(argv = process.argv.slice(2), { cloneRepository = cloneAuditedRepository, sourceDirectory = null, modelClient = null, vectorConfiguration = null } = {}) {
  const { dataRoot } = parseArguments(argv);
  if (typeof cloneRepository !== 'function') throw new TypeError('cloneRepository must be a function');
  const localSourceDirectory = sourceDirectory === null
    ? await cloneRepository({ dataRoot, repositoryUrl: AUDITED_REPOSITORY_URL, commit: AUDITED_COMMIT })
    : resolve(sourceDirectory);
  assertDirectory(localSourceDirectory, 'source clone directory');
  const mediaRoot = resolve(dataRoot, 'media');
  mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
  const database = openCatalogDatabase({ databasePath: resolve(dataRoot, 'app.sqlite'), mediaRoot });
  try {
    const baseModelRows = database.prepare('SELECT id FROM generation_base_models WHERE name = ?').all(SOURCE_BASE_MODEL_NAME);
    if (baseModelRows.length !== 1) throw new Error(`exactly one generation base model named ${SOURCE_BASE_MODEL_NAME} is required`);
    const baseModelId = baseModelRows[0].id;
    const existingStyles = database.prepare(`SELECT
      id, name, aliases_json, prompt_text, style_description, cover_media_path
      FROM styles WHERE base_model_id = ?`).all(baseModelId);
    const adapter = createAdapter({ sourceDirectory: localSourceDirectory, existingStyles, baseModelId });
    let runner = null;
    const handleInterrupt = () => runner?.requestStop('PROCESS_INTERRUPTED');
    try {
      runner = createManualIngestRunner({
        dataRoot,
        mediaRoot,
        sourceConfig: adapter.sourceConfig,
        adapter,
        database,
        config: { crawler: { allowed_source_origins: [new URL(SOURCE_BASE_URL).origin] } },
        vectorConfiguration: vectorConfiguration ?? loadVectorModelConfiguration(repositoryRoot),
        modelClient: modelClient ?? createConfiguredVectorModelClient({ repositoryRoot, configuration: vectorConfiguration ?? loadVectorModelConfiguration(repositoryRoot) })
      });
      process.on('SIGINT', handleInterrupt);
      process.on('SIGTERM', handleInterrupt);
      process.on('SIGHUP', handleInterrupt);
      return await runner.run();
    } finally {
      process.off('SIGINT', handleInterrupt);
      process.off('SIGTERM', handleInterrupt);
      process.off('SIGHUP', handleInterrupt);
    }
  } finally {
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
