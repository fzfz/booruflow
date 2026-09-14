import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/testing/test-browser-launch-options.mjs';

const repositoryRoot = resolve(new URL('../..', import.meta.url).pathname);
const browserLaunchCallers = Object.freeze([
  Object.freeze({ path: 'tests/e2e/management-navigation.test.mjs', launches: 5 }),
  Object.freeze({ path: 'tests/e2e/manage-page.test.mjs', launches: 3 })
]);

test('浏览器测试和度量统一通过 Playwright Chrome channel 启动，不绑定 macOS 可执行文件路径', async () => {
  assert.deepEqual(TEST_BROWSER_LAUNCH_OPTIONS, Object.freeze({ headless: true, channel: 'chrome' }));

  for (const { path, launches } of browserLaunchCallers) {
    const source = await readFile(resolve(repositoryRoot, path), 'utf8');
    assert.match(source, /test-browser-launch-options\.mjs/u, `${path} 必须导入测试浏览器启动选项`);
    assert.equal(source.includes('executablePath'), false, `${path} 不得绑定操作系统专属浏览器路径`);
    assert.equal(
      source.match(/chromium\.launch\(TEST_BROWSER_LAUNCH_OPTIONS\)/gu)?.length,
      launches,
      `${path} 的每个 Chromium 启动必须使用唯一的测试启动选项`
    );
  }
});
