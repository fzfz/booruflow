import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runnerSource = readFileSync(resolve(repositoryRoot, 'scripts/testing/run-test-layer.mjs'), 'utf8');

test('分层测试运行器默认以 2 个文件并发执行，并且只接受显式正整数并发参数', () => {
  assert.match(runnerSource, /const DEFAULT_TEST_CONCURRENCY_OPTION = '--test-concurrency=2';/u);
  assert.match(runnerSource, /\^--test-concurrency=\[1-9\]\\d\*\$\/u/u);
  assert.match(runnerSource, /\['--test', testConcurrencyOption, \.\.\.files\]/u);
  assert.doesNotMatch(runnerSource, /--test-concurrency=1/u);
});
