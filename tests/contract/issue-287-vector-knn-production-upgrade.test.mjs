import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPOSITORY_ROOT = resolve(new URL('../..', import.meta.url).pathname);

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8'));
}

test('offline vector KNN migration package entry is present', () => {
  const packageJson = readJson('package.json');

  assert.equal(packageJson.scripts['migrate:vector-knn'], 'node scripts/migrate-vector-knn-index.mjs');
  assert.equal(existsSync(resolve(REPOSITORY_ROOT, 'scripts/migrate-vector-knn-index.mjs')), true);
});
