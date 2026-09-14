import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { AUDITED_COMMIT, AUDITED_REPOSITORY_URL, cloneAuditedRepository, main } from '../../ingest/manual/run-illustrious-noobai-style-explorer.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const existingStyleId = 701;
const styleBaseModelId = 11103;
const now = '2026-08-04T00:00:00.000Z';
const VECTOR_CONFIGURATION = Object.freeze({ embedding_model: 'fake', reranker_candidate_limit: 20, reranker_min_relevance_score: 0 });
const MODEL_CLIENT = Object.freeze({ async embed(inputs) { return inputs.map(() => createFixtureVector()); } });
const galleryData = [
  { id: 'style-all-previews-001', name: 'Gallery Identity Style', p: ['preview-a', 'preview-b'] },
  { id: 'style-alias-002', name: 'Incoming Alias Style (External Alias)', p: 'alias-preview' }
];

function webpBytes(marker) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBPVP8X', 8, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes[20] = marker;
  return bytes;
}

function createDataRoot(t) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'issue-111-style-explorer-cli-'));
  const mediaRoot = join(dataRoot, 'media');
  const databasePath = join(dataRoot, 'app.sqlite');
  mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot });
  const database = openCatalogDatabase({ databasePath });
  try {
    database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (?, 'wai', ?, ?)").run(styleBaseModelId, now, now);
    database.prepare(`INSERT INTO styles(
      id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL)`).run(
      existingStyleId, styleBaseModelId, 'Existing Canonical Style', JSON.stringify(['External Alias']), 'second local prompt body'
    );
  } finally {
    database.prepare("UPDATE vector_spaces SET embedding_model = 'fake', dimension = 1024").run();
    database.close();
  }
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  return dataRoot;
}

function invokeMain(argv, options = {}) {
  return main(argv, { modelClient: MODEL_CLIENT, vectorConfiguration: VECTOR_CONFIGURATION, ...options });
}

function createSourceDirectory(t, { data = galleryData, artistLines = ['first local prompt body', 'second local prompt body', 'extra compatible artist tail'], missing = [], maliciousSuffix = '' } = {}) {
  const sourceDirectory = mkdtempSync(join(tmpdir(), 'issue-111-style-explorer-source-'));
  mkdirSync(join(sourceDirectory, 'app'), { recursive: true, mode: 0o700 });
  writeFileSync(join(sourceDirectory, 'app/data.js'), `const galleryData = ${JSON.stringify(data)};\n${maliciousSuffix}`, { mode: 0o600 });
  writeFileSync(join(sourceDirectory, 'Illustrious-NoobAI-33k-Compatible-Artists.txt'), `${artistLines.join('\n')}\n`, { mode: 0o600 });
  let index = 0;
  for (const entry of data) {
    const previews = Array.isArray(entry.p) ? entry.p : [entry.p];
    for (const preview of previews) {
      const relativePath = `images/${preview}/${entry.id}.webp`;
      if (!missing.includes(relativePath)) {
        mkdirSync(join(sourceDirectory, 'images', preview), { recursive: true, mode: 0o700 });
        writeFileSync(join(sourceDirectory, relativePath), webpBytes(index + 1), { mode: 0o600 });
      }
      index += 1;
    }
  }
  t.after(() => rmSync(sourceDirectory, { recursive: true, force: true }));
  return sourceDirectory;
}

test('CLI uses the fixed clone injection, imports every local p image, ignores compatible tail lines, and never fetches remotely', async (t) => {
  const dataRoot = createDataRoot(t);
  const sourceDirectory = createSourceDirectory(t);
  const cloneCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('remote fetch must not be called'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await invokeMain(['--data-root', dataRoot], {
    cloneRepository: async (arguments_) => { cloneCalls.push(arguments_); return sourceDirectory; }
  });

  assert.equal(result.state.status, 'completed');
  assert.equal(result.report.counts.discovered, 2);
  assert.equal(result.report.counts.created, 1);
  assert.equal(result.report.counts.updated, 1);
  assert.equal(result.report.counts.images_downloaded, 3);
  assert.equal(result.report.counts.images_failed, 0);
  assert.deepEqual(cloneCalls, [{ dataRoot, repositoryUrl: AUDITED_REPOSITORY_URL, commit: AUDITED_COMMIT }]);

  const database = openCatalogDatabase({ databasePath: join(dataRoot, 'app.sqlite') });
  try {
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM styles').get().count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM item_images').get().count, 3);
    assert.deepEqual(database.prepare('SELECT content_hash FROM item_images ORDER BY id').all().map(({ content_hash }) => content_hash), [
      createHash('sha256').update(webpBytes(1)).digest('hex'),
      createHash('sha256').update(webpBytes(2)).digest('hex'),
      createHash('sha256').update(webpBytes(3)).digest('hex')
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM artist_prompt_strings').get().count, 0);
    assert.deepEqual({ ...database.prepare("SELECT name, prompt_text FROM styles WHERE name = 'Gallery Identity Style'").get() }, {
      name: 'Gallery Identity Style', prompt_text: 'first local prompt body'
    });
    assert.deepEqual({ ...database.prepare('SELECT name, aliases_json, prompt_text FROM styles WHERE id = ?').get(existingStyleId) }, {
      name: 'Existing Canonical Style', aliases_json: '["External Alias","Incoming Alias Style"]', prompt_text: 'second local prompt body'
    });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM styles WHERE name = 'extra compatible artist tail'").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = 'style'").get().count, 2);
    assert.deepEqual(
      database.prepare("SELECT object_id FROM vector_entries WHERE object_kind = 'style' ORDER BY object_id").all().map(({ object_id }) => object_id),
      database.prepare('SELECT id FROM styles ORDER BY id').all().map(({ id }) => id)
    );
  } finally {
    database.close();
  }
});

test('CLI records a missing local image and continues with all remaining images', async (t) => {
  const dataRoot = createDataRoot(t);
  const sourceDirectory = createSourceDirectory(t, { missing: ['images/preview-b/style-all-previews-001.webp'] });
  const injectedClone = async () => sourceDirectory;
  const result = await invokeMain(['--data-root', dataRoot], { cloneRepository: injectedClone });
  assert.equal(result.state.status, 'completed');
  assert.equal(result.report.counts.images_downloaded, 2);
  assert.equal(result.report.counts.images_failed, 1);
  assert.equal(result.report.errors.filter((error) => error.scope === 'image').length, 1);
  assert.match(result.report.errors[0].image_source_url, /preview-b\/style-all-previews-001\.webp$/u);
});

test('CLI rejects unsupported arguments, too-short text, executable data, traversal, and preview symlinks without executing source JavaScript', async (t) => {
  const dataRoot = createDataRoot(t);
  const sourceDirectory = createSourceDirectory(t, { artistLines: ['only one line'] });
  await assert.rejects(() => invokeMain(['--data-root', dataRoot, '--source-base-url', 'https://example.test/'], { sourceDirectory }), /unsupported argument/u);
  await assert.rejects(() => invokeMain(['--data-root', dataRoot, '--resume'], { sourceDirectory }), /unsupported argument/u);
  await assert.rejects(() => invokeMain(['--data-root', dataRoot], { sourceDirectory }), /fewer lines/u);

  const sideEffectKey = '__issue111_style_explorer_data_side_effect__';
  const maliciousDirectory = createSourceDirectory(t, { maliciousSuffix: `${sideEffectKey} = true;` });
  delete globalThis[sideEffectKey];
  await assert.rejects(() => invokeMain(['--data-root', dataRoot], { sourceDirectory: maliciousDirectory }), /unexpected declaration|unsupported|expression/u);
  assert.equal(globalThis[sideEffectKey], undefined);
  delete globalThis[sideEffectKey];

  const traversalDirectory = createSourceDirectory(t, { data: [{ id: '../escape', name: 'Traversal Style', p: 'preview-a' }], artistLines: ['prompt'] });
  await assert.rejects(() => invokeMain(['--data-root', dataRoot], { sourceDirectory: traversalDirectory }), /safe preview path segment/u);

  const previewTraversalDirectory = createSourceDirectory(t, { data: [{ id: 'safe-preview-id', name: 'Traversal Preview Style', p: '../escape' }], artistLines: ['prompt'] });
  await assert.rejects(() => invokeMain(['--data-root', dataRoot], { sourceDirectory: previewTraversalDirectory }), /safe preview path segment/u);

  const symlinkDirectory = createSourceDirectory(t);
  const symlinkTarget = mkdtempSync(join(tmpdir(), 'issue-111-style-explorer-preview-target-'));
  t.after(() => rmSync(symlinkTarget, { recursive: true, force: true }));
  writeFileSync(join(symlinkTarget, 'style-all-previews-001.webp'), webpBytes(99), { mode: 0o600 });
  rmSync(join(symlinkDirectory, 'images', 'preview-a'), { recursive: true, force: true });
  symlinkSync(symlinkTarget, join(symlinkDirectory, 'images', 'preview-a'));
  const result = await invokeMain(['--data-root', dataRoot], { sourceDirectory: symlinkDirectory });
  assert.equal(result.report.counts.images_downloaded, 2);
  assert.equal(result.report.counts.images_failed, 1);
  assert.match(result.report.errors[0].message, /symbolic links/u);
});

test('CLI accepts one --data-root production argument and rejects duplicate or missing values before cloning', async (t) => {
  const dataRoot = createDataRoot(t);
  let cloneCalls = 0;
  const cloneRepository = async () => {
    cloneCalls += 1;
    throw new Error('clone must not run after argument validation');
  };
  await assert.rejects(() => invokeMain(['--data-root', dataRoot, '--data-root', dataRoot], { cloneRepository }), /specified more than once/u);
  await assert.rejects(() => invokeMain(['--data-root'], { cloneRepository }), /requires a value/u);
  assert.equal(cloneCalls, 0);
});

test('CLI rejects symbolic links for local static source files before reading their contents', async (t) => {
  const dataRoot = createDataRoot(t);
  for (const relativePath of ['app/data.js', 'Illustrious-NoobAI-33k-Compatible-Artists.txt']) {
    const sourceDirectory = createSourceDirectory(t);
    const sourcePath = join(sourceDirectory, relativePath);
    const linkTarget = join(dataRoot, `outside-${relativePath.replaceAll('/', '-')}`);
    writeFileSync(linkTarget, readFileSync(sourcePath), { mode: 0o600 });
    rmSync(sourcePath);
    symlinkSync(linkTarget, sourcePath);
    await assert.rejects(() => invokeMain(['--data-root', dataRoot], { sourceDirectory }), /symbolic links/u);
  }
});

test('controlled clone rejects an existing source directory whose HEAD differs from the audited commit', async (t) => {
  const dataRoot = createDataRoot(t);
  mkdirSync(join(dataRoot, '.sources', 'illustrious-noobai-style-explorer'), { recursive: true, mode: 0o700 });
  const calls = [];
  await assert.rejects(() => cloneAuditedRepository({
    dataRoot,
    git: async (arguments_) => {
      calls.push(arguments_);
      return { stdout: arguments_.includes('config') ? '' : 'deadbeef\n' };
    }
  }), /HEAD must equal audited commit/u);
  assert.deepEqual(calls, [
    ['-c', 'include.path=/dev/null', 'config', '--local', '--name-only', '--null', '--list'],
    ['rev-parse', 'HEAD']
  ]);
});

test('controlled clone rejects a dirty existing source directory even when HEAD is pinned', async (t) => {
  const dataRoot = createDataRoot(t);
  mkdirSync(join(dataRoot, '.sources', 'illustrious-noobai-style-explorer'), { recursive: true, mode: 0o700 });
  const calls = [];
  await assert.rejects(() => cloneAuditedRepository({
    dataRoot,
    git: async (arguments_) => {
      calls.push(arguments_);
      if (arguments_.includes('config')) return { stdout: '' };
      if (arguments_[0] === 'rev-parse') return { stdout: `${AUDITED_COMMIT}\n` };
      return { stdout: ' M app/data.js\n' };
    }
  }), /working tree must be clean/u);
  assert.deepEqual(calls, [
    ['-c', 'include.path=/dev/null', 'config', '--local', '--name-only', '--null', '--list'],
    ['rev-parse', 'HEAD'],
    ['ls-files', '-v', '-z'],
    ['status', '--porcelain=v1', '--untracked-files=all']
  ]);
});

test('controlled clone rejects skip-worktree and assume-unchanged index flags', async (t) => {
  for (const flag of ['h', 'S', 's']) {
    const dataRoot = createDataRoot(t);
    mkdirSync(join(dataRoot, '.sources', 'illustrious-noobai-style-explorer'), { recursive: true, mode: 0o700 });
    const calls = [];
    await assert.rejects(() => cloneAuditedRepository({
      dataRoot,
      git: async (arguments_) => {
        calls.push(arguments_);
        if (arguments_.includes('config')) return { stdout: '' };
        if (arguments_[0] === 'rev-parse') return { stdout: `${AUDITED_COMMIT}\n` };
        if (arguments_[0] === 'ls-files') return { stdout: `${flag} app/data.js\0` };
        return { stdout: '' };
      }
    }), /skip-worktree or assume-unchanged/u);
    assert.deepEqual(calls, [
      ['-c', 'include.path=/dev/null', 'config', '--local', '--name-only', '--null', '--list'],
      ['rev-parse', 'HEAD'],
      ['ls-files', '-v', '-z']
    ]);
  }
});

test('controlled clone accepts ordinary uppercase H index flags', async (t) => {
  const dataRoot = createDataRoot(t);
  const destination = join(dataRoot, '.sources', 'illustrious-noobai-style-explorer');
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const cloned = await cloneAuditedRepository({
    dataRoot,
    git: async (arguments_) => {
      if (arguments_.includes('config')) return { stdout: '' };
      if (arguments_[0] === 'rev-parse') return { stdout: `${AUDITED_COMMIT}\n` };
      if (arguments_[0] === 'ls-files') return { stdout: 'H app/data.js\0' };
      return { stdout: '' };
    }
  });
  assert.equal(cloned, destination);
});

test('controlled clone rejects an existing local Git filter configuration before reading the source tree', async (t) => {
  const dataRoot = createDataRoot(t);
  mkdirSync(join(dataRoot, '.sources', 'illustrious-noobai-style-explorer'), { recursive: true, mode: 0o700 });
  const calls = [];
  await assert.rejects(() => cloneAuditedRepository({
    dataRoot,
    git: async (arguments_) => {
      calls.push(arguments_);
      if (arguments_.includes('config')) return { stdout: 'filter.hostile.process\0' };
      if (arguments_[0] === 'rev-parse') return { stdout: `${AUDITED_COMMIT}\n` };
      return { stdout: 'filter.hostile.process\0' };
    }
  }), /forbidden setting filter\.hostile\.process/u);
  assert.deepEqual(calls, [[
    '-c', 'include.path=/dev/null', 'config', '--local', '--name-only', '--null', '--list'
  ]]);
});

test('controlled clone rejects a symbolic-link target before running git', async (t) => {
  const dataRoot = createDataRoot(t);
  mkdirSync(join(dataRoot, '.sources'), { recursive: true, mode: 0o700 });
  symlinkSync(tmpdir(), join(dataRoot, '.sources', 'illustrious-noobai-style-explorer'));
  await assert.rejects(() => cloneAuditedRepository({ dataRoot }), /non-symbolic-link directory/u);
});

test('controlled clone fetches, checks out, and verifies the audited fixed commit', async (t) => {
  const dataRoot = createDataRoot(t);
  const destination = join(dataRoot, '.sources', 'illustrious-noobai-style-explorer');
  const calls = [];
  const cloned = await cloneAuditedRepository({
    dataRoot,
    git: async (arguments_, options = {}) => {
      calls.push({ arguments_, cwd: options.cwd ?? null });
      if (arguments_[0] === 'clone') mkdirSync(arguments_.at(-1), { recursive: true, mode: 0o700 });
      if (arguments_[0] === 'rev-parse') return { stdout: `${AUDITED_COMMIT}\n` };
      return { stdout: '' };
    }
  });
  assert.equal(cloned, destination);
  assert.deepEqual(calls, [
    { arguments_: ['clone', '--no-checkout', '--no-tags', '--no-recurse-submodules', '--filter=blob:none', AUDITED_REPOSITORY_URL, destination], cwd: null },
    { arguments_: ['-c', 'include.path=/dev/null', 'config', '--local', '--name-only', '--null', '--list'], cwd: destination },
    { arguments_: ['fetch', '--depth=1', 'origin', AUDITED_COMMIT], cwd: destination },
    { arguments_: ['checkout', '--detach', '--force', AUDITED_COMMIT], cwd: destination },
    { arguments_: ['rev-parse', 'HEAD'], cwd: destination },
    { arguments_: ['ls-files', '-v', '-z'], cwd: destination },
    { arguments_: ['status', '--porcelain=v1', '--untracked-files=all'], cwd: destination }
  ]);
});
