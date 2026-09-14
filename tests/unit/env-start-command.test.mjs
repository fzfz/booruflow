import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');

test('provides a non-secret environment template for isolated runtime configuration', () => {
  const template = readFileSync(resolve(repositoryRoot, '.env.example'), 'utf8');
  for (const name of [
    'NOOBAI_PUBLIC_PORT', 'NOOBAI_INTERNAL_PORT', 'NOOBAI_HTTP_REQUEST_TIMEOUT_MS', 'NOOBAI_INTERNAL_API_TIMEOUT_MS',
    'NOOBAI_EMBEDDING_BASE_URL', 'NOOBAI_EMBEDDING_API_KEY', 'NOOBAI_EMBEDDING_MODEL',
    'NOOBAI_RERANKER_BASE_URL', 'NOOBAI_RERANKER_API_KEY', 'NOOBAI_RERANKER_MODEL'
  ]) {
    assert.match(template, new RegExp(`^${name}=`, 'm'));
  }
  for (const retired of ['NOOBAI_PI_PROMPT_TIMEOUT_MS', 'NOOBAI_PI_OFFLINE', 'NOOBAI_OPENAI_COMPATIBLE_BASE_URL', 'NOOBAI_OPENAI_COMPATIBLE_API_KEY', 'NOOBAI_OPENAI_COMPATIBLE_MODEL']) {
    assert.doesNotMatch(template, new RegExp(`^${retired}=`, 'm'));
  }
  assert.doesNotMatch(template, /sk-[A-Za-z0-9_-]{16,}/);
});
