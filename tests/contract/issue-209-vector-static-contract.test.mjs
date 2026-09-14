import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');

const CURRENT_VECTOR_RUNTIME_FILES = Object.freeze([
  'app/vector/character-semantic.mjs',
  'app/vector/model-client.mjs',
  'app/vector/prompt-term-semantic.mjs',
  'app/vector/semantic-service.mjs',
  'app/vector/style-semantic.mjs',
  'app/vector/vector-store.mjs',
  'app/vector/work-semantic.mjs',
  'app/ingest/manual-ingest.mjs',
  'ingest/manual/run-illustrious-noobai-style-explorer.mjs',
  'scripts/maintenance/rebuild-character-vectors.mjs',
  'scripts/maintenance/rebuild-prompt-term-vectors.mjs',
  'scripts/maintenance/rebuild-style-vectors.mjs',
  'scripts/maintenance/rebuild-work-vectors.mjs'
]);

const VECTOR_REBUILD_SCRIPT_FILES = Object.freeze([
  'scripts/maintenance/rebuild-character-vectors.mjs',
  'scripts/maintenance/rebuild-prompt-term-vectors.mjs',
  'scripts/maintenance/rebuild-style-vectors.mjs',
  'scripts/maintenance/rebuild-work-vectors.mjs'
]);

const FORBIDDEN_VECTOR_LEGACY_TERMS = Object.freeze([
  /\bvector_space_id\b/gu,
  /\bchunk_ordinal\b/gu,
  /\btext_projection_version\b/gu,
  /\bchunking_version\b/gu,
  /\bdistance_metric\b/gu,
  /\bvector_maintenance_tasks\b/gu,
  /\b(?:enqueue|runNext)\w*\b/gu,
  /(?:vector-lifecycle|recover-vector-derived-data|retry-vector-maintenance-task)/gu,
  /\b(?:active|retired|building|staging|failed)\s+(?:vector\s+)?spaces?\b/giu,
  /\b(?:active|retired|building|staging|failed)_space\b/giu
]);

function readRelative(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

function assertNoLegacyVectorTerms(relativePath) {
  const text = readRelative(relativePath);
  for (const pattern of FORBIDDEN_VECTOR_LEGACY_TERMS) {
    assert.doesNotMatch(text, pattern, `${relativePath} contains removed vector contract ${pattern}`);
  }
  return text;
}

test('Issue #209 runtime does not retain the removed vector-space contract', () => {
  for (const relativePath of CURRENT_VECTOR_RUNTIME_FILES) assertNoLegacyVectorTerms(relativePath);

  const runtimeText = CURRENT_VECTOR_RUNTIME_FILES.map((relativePath) => readRelative(relativePath)).join('\n');
  assert.doesNotMatch(runtimeText, /\bINSERT\s+INTO\s+vector_spaces\b/iu, 'runtime must not create vector configuration rows');
  assert.doesNotMatch(runtimeText, /\bvector_spaces\b[^\n;]*\b(?:status|created_at|activated_at)\b/iu, 'runtime must not depend on removed vector-space lifecycle columns');
});

test('Issue #209 rebuild scripts expose explicit reset and report direct rebuild results', () => {
  for (const relativePath of VECTOR_REBUILD_SCRIPT_FILES) {
    const text = readRelative(relativePath);
    assert.match(text, /const reset = process\.argv\.includes\('--reset'\)/u, `${relativePath} must parse --reset`);
    assert.match(text, /\.rebuild\(\{ reset \}\)/u, `${relativePath} must pass reset to direct rebuild`);
    assert.match(text, /completed/u, `${relativePath} must report completed IDs`);
    assert.match(text, /failures/u, `${relativePath} must report per-item failures`);
    assert.match(text, /rebuilt_at/u, `${relativePath} must report completion time`);
  }
});

test('Issue #210 Style rebuild keeps the media root an explicit controlled argument', () => {
  for (const relativePath of VECTOR_REBUILD_SCRIPT_FILES) {
    const text = readRelative(relativePath);
    assert.match(text, /const mediaRootFlag = process\.argv\.indexOf\('--media-root'\)/u, relativePath);
    assert.match(text, /--database <app\.sqlite> --media-root <data\/media>/u, relativePath);
    assert.match(text, /mediaRoot:\s*resolve\(process\.argv\[mediaRootFlag \+ 1\]\)/u, relativePath);
  }
});
