import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const targetColumns = Object.freeze(['id', 'base_model_id', 'name', 'aliases_json', 'prompt_text', 'style_description', 'cover_media_path']);
const styleRuntimeFiles = Object.freeze([
  'app/catalog/catalog-repository.mjs',
  'app/maintenance/maintenance-service.mjs',
  'app/ingest/manual-ingest.mjs',
  'app/vector/style-semantic.mjs',
  'ingest/manual/run-illustrious-noobai-style-explorer.mjs'
]);
const persistentDatabaseOpeners = Object.freeze([
  'app/data-package/database.mjs',
  'app/server/local-app.mjs',
  'scripts/maintenance/rebuild-character-vectors.mjs',
  'scripts/maintenance/rebuild-artist-prompt-string-vectors.mjs',
  'scripts/maintenance/rebuild-generation-lora-vectors.mjs',
  'scripts/maintenance/rebuild-prompt-term-vectors.mjs',
  'scripts/maintenance/rebuild-style-vectors.mjs',
  'scripts/maintenance/rebuild-work-vectors.mjs',
  'scripts/testing/start-test-app.mjs',
]);
const persistentOpenCall = /\bopenCatalogDatabase\s*\(\s*\{(?<arguments>[^{}]*)\}\s*\)/gu;

function read(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

function listMjs(directory, relativeDirectory = '') {
  return readdirSync(resolve(directory, relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listMjs(directory, relativePath);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [relativePath] : [];
  });
}

test('Issue #210 enumerates every production persistent database opener and passes its managed mediaRoot', () => {
  const expected = new Set(persistentDatabaseOpeners);
  const productionSources = [
    ...listMjs(resolve(repositoryRoot, 'app')).map((path) => `app/${path}`),
    ...listMjs(resolve(repositoryRoot, 'scripts')).map((path) => `scripts/${path}`)
  ];
  const discovered = new Set();
  for (const relativePath of productionSources) {
    const calls = [...read(relativePath).matchAll(persistentOpenCall)];
    if (calls.length === 0) continue;
    for (const call of calls) {
      if (!/\bdatabasePath\b/u.test(call.groups.arguments)) continue;
      discovered.add(relativePath);
      assert.ok(expected.has(relativePath), `${relativePath} contains an unenumerated persistent database opener`);
      assert.match(call.groups.arguments, /\bmediaRoot\b/u, `${relativePath} must pass mediaRoot to openCatalogDatabase`);
    }
  }
  assert.deepEqual([...discovered].sort(), [...expected].sort());
});

test('Issue #210 target SQL declares only the seven Style columns in order', () => {
  const sql = read('schema/database/015-style-base-model.sql');
  const create = /CREATE TABLE styles_next\s*\((?<body>[\s\S]*?)\n\);/u.exec(sql)?.groups?.body ?? '';
  const columns = [...create.matchAll(/^\s*([a-z_]+)\s+/gmu)].map((match) => match[1]);
  assert.deepEqual(columns, targetColumns);
  assert.match(sql, /UNIQUE \(base_model_id, name\)/u);
  assert.match(sql, /base_model_id INTEGER NOT NULL REFERENCES generation_base_models\(id\) ON DELETE RESTRICT/u);
});

test('Issue #210 current Style callers do not reference removed database columns', () => {
  const text = styleRuntimeFiles.map((relativePath) => `${relativePath}\n${read(relativePath)}`).join('\n');
  for (const column of ['source_id', 'source_url', 'source_version', 'source_updated_at', 'category_name', 'created_at', 'updated_at']) {
    assert.doesNotMatch(text, new RegExp(`(?:styles|style[s]?\\.)[^\\n;]*\\b${column}\\b`, 'u'), `Style callers still read removed ${column}`);
  }
  assert.doesNotMatch(text, /\b(?:styles|s)\.name_normalized\b/u, 'Style callers must not read styles.name_normalized');
  assert.doesNotMatch(text, /\b(?:styles|s)\.is_available\b/u, 'Style callers must not read styles.is_available');
  assert.doesNotMatch(text, /INSERT\s+INTO\s+styles\s*\([^)]*(?:source_|name_normalized|category_name|is_available|created_at|updated_at)/iu);
  assert.doesNotMatch(text, /UPDATE\s+styles\s+SET\s+[^;]*(?:source_|name_normalized|category_name|is_available|created_at|updated_at)/iu);
});

test('Issue #210 Style callers derive compatibility fields outside SQL', () => {
  const text = styleRuntimeFiles.map((relativePath) => `${relativePath}\n${read(relativePath)}`).join('\n');
  assert.doesNotMatch(text, /lower\(\s*(?:styles?|s)\.name\s*\)\s+AS\s+name_normalized/iu);
  assert.doesNotMatch(text, /\b1\s+AS\s+is_available\b/iu);
});
