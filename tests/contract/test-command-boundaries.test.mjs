import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { TEST_SUITES } from '../../scripts/testing/run-test-suite.mjs';

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
test('测试命令公开 unit → integration → e2e 三层边界并由非阻断运行器汇总', () => {
  const scripts = packageJson.scripts ?? {};
  for (const name of ['test:unit', 'test:integration', 'test:e2e']) {
    assert.equal(typeof scripts[name], 'string', `缺少公开命令 ${name}`);
  }

  assert.match(scripts['test:unit'], /tests\/unit\//u, 'test:unit 必须只指向 tests/unit/');
  assert.match(scripts['test:integration'], /run-test-suite\.mjs integration/u);
  assert.match(scripts['test:e2e'], /run-test-suite\.mjs e2e/u);
  assert.match(scripts['test:e2e:files'], /--test-concurrency=1[\s\S]*tests\/e2e\//u, 'test:e2e 必须串行运行共享全局测试端口的测试文件');

  assert.equal(typeof scripts.test, 'string', '缺少 npm test 总门禁');
  assert.match(scripts.test, /run-test-suite\.mjs all/u);
  assert.deepEqual(TEST_SUITES.all.map(({ label }) => label), [
    '契约结构检查', '契约测试', '单元测试', '静态测试边界检查', '集成测试', '端到端测试'
  ]);
  const integrationStep = TEST_SUITES.all.find(({ label }) => label === '集成测试');
  assert.deepEqual(integrationStep?.args, ['scripts/testing/run-test-layer.mjs', 'tests/integration/', '--test-concurrency=1']);
  assert.equal(TEST_SUITES.all.filter(({ label }) => label === '静态测试边界检查').length, 1, 'npm test 必须只执行一次静态测试边界检查');
  for (const name of ['test:contract', 'test:integration', 'test:e2e', 'test']) {
    assert.doesNotMatch(scripts[name], /&&/u, `${name} 不得在前一步失败后阻断后续测试`);
  }
});

test('npm test runner only collects official test roots and excludes legacy Skill runtime materials', () => {
  const roots = TEST_SUITES.all.flatMap(({ args }) => args.filter((argument) => argument.endsWith('/')));
  assert.deepEqual(roots, ['tests/contract/', 'tests/unit/', 'tests/integration/']);
  assert.equal(roots.some((root) => root.startsWith('tests/legacy/')), false);
});
