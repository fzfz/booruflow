import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { findStaticBoundaryViolations } from '../../scripts/check-static-test-boundaries.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'noobai-static-test-boundaries-'));
  await Promise.all([
    mkdir(join(root, 'tests', 'integration', 'nested'), { recursive: true }),
    mkdir(join(root, 'tests', 'e2e'), { recursive: true }),
    mkdir(join(root, 'tests', 'unit'), { recursive: true })
  ]);
  return root;
}

test('静态边界扫描器返回四类违规的文件、行号、类型和原文', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'tests', 'integration', 'nested', 'violations.mjs'), [
      'const server = createServer(handler);',
      'globalThis.fetch = async () => response;',
      'const dispatcher = createCatalogHttpDispatcher(options);',
      "if (request.method === 'POST' && url.pathname === '/fake') return;"
    ].join('\n'));

    assert.deepEqual(await findStaticBoundaryViolations(root), [
      { file: 'tests/integration/nested/violations.mjs', line: 1, kind: 'createServer', source: 'const server = createServer(handler);' },
      { file: 'tests/integration/nested/violations.mjs', line: 2, kind: 'fake fetch', source: 'globalThis.fetch = async () => response;' },
      { file: 'tests/integration/nested/violations.mjs', line: 3, kind: 'direct dispatcher', source: 'const dispatcher = createCatalogHttpDispatcher(options);' },
      { file: 'tests/integration/nested/violations.mjs', line: 4, kind: 'fake route', source: "if (request.method === 'POST' && url.pathname === '/fake') return;" }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('静态边界扫描器扫描集成与端到端目录并忽略单元测试目录', async () => {
  const root = await fixture();
  try {
    await Promise.all([
      writeFile(join(root, 'tests', 'integration', 'safe.mjs'), 'const value = 1;\n'),
      writeFile(join(root, 'tests', 'e2e', 'violation.mjs'), 'page.route("**/*", handler);\n'),
      writeFile(join(root, 'tests', 'unit', 'allowed.mjs'), 'const server = createServer(handler);\n')
    ]);

    assert.deepEqual(await findStaticBoundaryViolations(root), [
      { file: 'tests/e2e/violation.mjs', line: 1, kind: 'fake route', source: 'page.route("**/*", handler);' }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('静态边界扫描器在两个目标目录都无违规时返回空列表', async () => {
  const root = await fixture();
  try {
    await Promise.all([
      writeFile(join(root, 'tests', 'integration', 'safe.mjs'), 'const integration = true;\n'),
      writeFile(join(root, 'tests', 'e2e', 'safe.mjs'), 'const e2e = true;\n')
    ]);
    assert.deepEqual(await findStaticBoundaryViolations(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
