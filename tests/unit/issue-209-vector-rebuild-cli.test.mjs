import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { runMediaCutover } from '../../app/database/media-cutover.mjs';
import { createFixtureVector } from '../fixtures/vector/fake-semantic-model-client.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const NOW = '2026-08-05T00:00:00.000Z';
const FIXTURE_VECTOR_JSON = JSON.stringify(createFixtureVector());
const scripts = Object.freeze([
  ['work', 'works', 'scripts/rebuild-work-vectors.mjs', 1],
  ['character', 'characters', 'scripts/rebuild-character-vectors.mjs', 2],
  ['style', 'styles', 'scripts/rebuild-style-vectors.mjs', 3],
  ['prompt_term', 'prompt_terms', 'scripts/rebuild-prompt-term-vectors.mjs', 4]
]);

const modelWrapper = (scriptPath, args) => `
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  return { ok: true, status: 200, async json() { return { data: body.input.map((_, index) => ({ index, embedding: ${FIXTURE_VECTOR_JSON} })) }; } };
};
process.env.NOOBAI_EMBEDDING_BASE_URL = 'http://embedding.test/v1/';
process.env.NOOBAI_EMBEDDING_API_KEY = 'test-key';
process.env.NOOBAI_EMBEDDING_MODEL = 'fake';
process.env.NOOBAI_RERANKER_BASE_URL = 'http://reranker.test/v1/';
process.env.NOOBAI_RERANKER_API_KEY = 'test-key';
process.env.NOOBAI_RERANKER_MODEL = 'fake-reranker';
process.argv = ${JSON.stringify([process.execPath, scriptPath, ...args])};
await import(${JSON.stringify(scriptPath)});
`;

function createDatabase(t, kind, table, id, { fail = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), `issue-209-rebuild-cli-${kind}-`));
  const mediaRoot = join(root, 'media');
  const databasePath = join(root, 'catalog.sqlite');
  mkdirSync(mediaRoot, { recursive: true });
  runMediaCutover({ databasePath, mediaRoot, repositoryRoot });
  const database = openCatalogDatabase({ databasePath });
  try {
    if (kind === 'work') database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, category_name, is_available, created_at, updated_at) VALUES (1, 'work one', 'work one', '[]', 'x', 1, ?, ?)").run(NOW, NOW);
    if (kind === 'character') {
      database.prepare("INSERT INTO works(id, name, name_normalized, aliases_json, is_available, created_at, updated_at) VALUES (1, 'work one', 'work one', '[]', 1, ?, ?)").run(NOW, NOW);
      database.prepare("INSERT INTO characters(id, work_id, name, name_normalized, aliases_json, prompt_text, is_available, created_at, updated_at) VALUES (2, 1, 'character one', 'character one', '[]', 'cp', 1, ?, ?)").run(NOW, NOW);
    }
    if (kind === 'style') {
      database.prepare("INSERT INTO generation_base_models(id, name, created_at, updated_at) VALUES (20902, 'wai', ?, ?)").run(NOW, NOW);
      database.prepare("INSERT INTO styles(id, base_model_id, name, aliases_json, prompt_text, style_description, cover_media_path) VALUES (3, 20902, 'style one', '[]', 'sp', 'sd', NULL)").run();
    }
    if (kind === 'prompt_term') database.prepare("INSERT INTO prompt_terms(id, canonical_tag, category, post_count, aliases_json, created_at, updated_at) VALUES (4, 'prompt one', 0, 1, '[]', ?, ?)").run(NOW, NOW);
    if (fail) database.exec(`CREATE TRIGGER issue_209_cli_${kind.replace(/[^a-z]/gu, '_')}_fail BEFORE INSERT ON vector_entries WHEN NEW.object_kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'cli vector write failed'); END;`);
  } finally { database.close(); }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { databasePath, mediaRoot, id, table };
}

function runCli(scriptRelativePath, args) {
  const scriptPath = resolve(repositoryRoot, scriptRelativePath);
  return spawnSync(process.execPath, ['--input-type=module', '-e', modelWrapper(scriptPath, args)], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
}

test('all four rebuild CLIs report a successful direct rebuild and accept --reset', (t) => {
  for (const [kind, table, scriptPath, id] of scripts) {
    const fixture = createDatabase(t, kind, table, id);
    const args = ['--database', fixture.databasePath, '--media-root', fixture.mediaRoot, '--reset'];
    const result = runCli(scriptPath, args);
    assert.equal(result.status, 0, `${scriptPath} stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.deepEqual({ object_kind: output.object_kind, completed: output.completed, failures: output.failures }, { object_kind: kind, completed: [id], failures: [] });
    assert.equal(typeof output.rebuilt_at, 'string');
    const database = openCatalogDatabase({ databasePath: fixture.databasePath });
    try {
      assert.deepEqual({ ...database.prepare('SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = ?').get(kind) }, { embedding_model: 'fake', dimension: 1024 });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ? AND object_id = ?').get(kind, id).count, 1);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally { database.close(); }
  }
});

test('all four rebuild CLIs reject missing --database values before opening a database', () => {
  for (const [, , scriptPath] of scripts) {
    const result = runCli(scriptPath, []);
    assert.notEqual(result.status, 0, scriptPath);
    assert.match(result.stderr, /usage: node scripts\/rebuild-/u);
  }
});

test('all four rebuild CLIs reject a missing --media-root before opening a persistent database', () => {
  for (const [, , scriptPath] of scripts) {
    const result = runCli(scriptPath, ['--database', '/tmp/issue-210-vector-cli-missing-media.sqlite']);
    assert.notEqual(result.status, 0, scriptPath);
    assert.match(result.stderr, /--media-root <data\/media>/u, scriptPath);
  }
});

test('all four rebuild CLIs report per-object failures and exit nonzero without losing the six-space schema', (t) => {
  for (const [kind, table, scriptPath, id] of scripts) {
    const fixture = createDatabase(t, kind, table, id, { fail: true });
    const args = ['--database', fixture.databasePath, '--media-root', fixture.mediaRoot];
    const result = runCli(scriptPath, args);
    assert.equal(result.status, 1, `${scriptPath} stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.object_kind, kind);
    assert.deepEqual(output.completed, []);
    assert.deepEqual(output.failures.map(({ object_id, message }) => ({ object_id, message })), [{ object_id: id, message: 'cli vector write failed' }]);
    assert.equal(typeof output.rebuilt_at, 'string');
    const database = openCatalogDatabase({ databasePath: fixture.databasePath });
    try {
      assert.deepEqual({ ...database.prepare('SELECT embedding_model, dimension FROM vector_spaces WHERE object_kind = ?').get(kind) }, { embedding_model: '__unconfigured__', dimension: 1 });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_entries WHERE object_kind = ?').get(kind).count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM vector_spaces').get().count, 6);
    } finally { database.close(); }
  }
});
