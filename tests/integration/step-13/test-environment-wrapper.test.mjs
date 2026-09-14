import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { test } from 'node:test';

import { MANAGE_TEST_PORTS, startManageTestApp } from '../../../scripts/start-manage-test-app.mjs';

const expectedSystemPathNames = Object.freeze([
  'home',
  'tmp',
  'xdgConfigHome',
  'xdgDataHome',
  'xdgCacheHome'
]);
const expectedSystemEnvironmentNames = Object.freeze({
  home: 'HOME',
  tmp: 'TMPDIR',
  xdgConfigHome: 'XDG_CONFIG_HOME',
  xdgDataHome: 'XDG_DATA_HOME',
  xdgCacheHome: 'XDG_CACHE_HOME'
});

async function closeIfStarted(app) {
  if (app) await app.close();
}

test('隔离测试应用在没有模型服务配置时使用 fake 语义适配器启动', async () => {
  const app = await startManageTestApp({ testMode: true });
  try {
    assert.equal(app.baseUrl, `http://127.0.0.1:${MANAGE_TEST_PORTS.public}`);
    assert.equal(app.internalBaseUrl, `http://127.0.0.1:${MANAGE_TEST_PORTS.internal}`);
    assert.equal(typeof app.processId, 'number', '包装器必须公开真实应用进程标识');

    assert.ok(app.paths && typeof app.paths === 'object', '包装器必须公开隔离路径清单');
    for (const pathName of [
      'database',
      'media',
      'diagnosticLog',
      ...expectedSystemPathNames
    ]) {
      assert.equal(typeof app.paths[pathName], 'string', `缺少公开路径：${pathName}`);
      const relativePath = relative(app.root, app.paths[pathName]);
      assert.ok(relativePath && !isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`), `${pathName} 必须位于临时根目录内`);
    }

    assert.ok(app.environment && typeof app.environment === 'object', '包装器必须公开子进程环境快照');
    for (const pathName of expectedSystemPathNames) {
      const environmentName = expectedSystemEnvironmentNames[pathName];
      assert.equal(app.environment[environmentName], app.paths[pathName], `${environmentName} 必须指向临时根目录`);
    }
    assert.deepEqual(app.inheritedEnvironmentKeys, [], '子进程不得整体继承父环境');
    assert.equal(app.environment.NOOBAI_TEST_MODE, '1');
  } finally {
    await app.close();
  }
});

test('统一环境从空数据库完成迁移并导入共享样本，真实双端口就绪后可访问', async () => {
  const app = await startManageTestApp({ testMode: true });
  try {
    await access(app.paths.database);
    const works = await fetch(`${app.baseUrl}/api/works`, { headers: { 'x-request-id': 'issue-9-works' } });
    assert.equal(works.status, 200);
    assert.equal((await works.json()).data.items.length, 1, '共享样本必须在迁移后导入数据库');

    const internal = await fetch(`${app.internalBaseUrl}/internal/semantic`);
    assert.equal(internal.status, 200, '内部真实端口必须完成就绪等待');
  } finally {
    await app.close();
  }
});

test('统一环境关闭时退出子进程并删除临时根，下一次运行使用新的隔离根', async () => {
  const first = await startManageTestApp({ testMode: true });
  const firstRoot = first.root;
  await first.close();
  await assert.rejects(access(firstRoot), /ENOENT/u);

  const second = await startManageTestApp({ testMode: true });
  try {
    assert.notEqual(second.root, firstRoot);
    assert.notEqual(second.processId, first.processId);
  } finally {
    const secondRoot = second.root;
    await second.close();
    await assert.rejects(access(secondRoot), /ENOENT/u);
  }
});

test('真实 API 配置缺失时统一环境启动失败并传播原因', async () => {
  let app;
  try {
    await assert.rejects(
      async () => {
        app = await startManageTestApp({
          testMode: true,
          requireRealApi: true,
          apiConfig: null
        });
      },
      /API|配置|configuration/u
    );
  } finally {
    await closeIfStarted(app);
  }
});

test('迁移、导入和启动失败向调用方传播，测试不会静默改用假服务', async () => {
  for (const [stage, options] of [
    ['migration', { failStage: 'migration' }],
    ['import', { failStage: 'import' }]
  ]) {
    let app;
    try {
      await assert.rejects(
        async () => { app = await startManageTestApp({ testMode: true, ...options }); },
        new RegExp(stage, 'iu')
      );
    } finally {
      await closeIfStarted(app);
    }
  }
});
