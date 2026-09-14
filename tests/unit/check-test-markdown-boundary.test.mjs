import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { findTestMarkdownBoundaryViolations } from '../../scripts/testing/check-test-markdown-boundary.mjs';

test('测试 Markdown 边界扫描器拦截 Markdown 引用和读取命令', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noobai-test-markdown-boundary-'));
  const markdownToken = ['.', 'md'].join('');
  const readFileKind = ['readFile(...', 'md'].join('');
  const readFileSyncKind = ['readFileSync(...', 'md'].join('');
  const readTextKind = ['read_text(...', 'md'].join('');
  const openKind = ['open(...', 'md'].join('');
  const grepKind = ['grep/rg ...', 'md'].join('');
  try {
    await mkdir(join(root, 'tests', 'unit'), { recursive: true });
    await writeFile(join(root, 'tests', 'unit', 'violations.test.mjs'), [
      `const path = 'guide${markdownToken}';`,
      `readFile('guide${markdownToken}');`,
      `readFileSync('guide${markdownToken}');`,
      `read_text('guide${markdownToken}');`,
      `open('guide${markdownToken}');`,
      `rg 'guide${markdownToken}';`
    ].join('\n'));

    const violations = await findTestMarkdownBoundaryViolations(root);
    assert.equal(violations.length, 5);
    assert.deepEqual(violations.map(({ line, kind }) => ({ line, kind })), [
      { line: 2, kind: readFileKind },
      { line: 3, kind: readFileSyncKind },
      { line: 4, kind: readTextKind },
      { line: 5, kind: openKind },
      { line: 6, kind: grepKind }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('测试 Markdown 边界扫描器只扫描测试源码', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noobai-test-markdown-boundary-'));
  const markdownToken = ['.', 'md'].join('');
  try {
    await mkdir(join(root, 'tests', 'unit'), { recursive: true });
    await writeFile(join(root, 'tests', 'unit', 'safe.test.mjs'), 'const value = 1;\n');
    await writeFile(join(root, 'tests', 'unit', `fixture${markdownToken}`), 'documentation\n');
    assert.deepEqual(await findTestMarkdownBoundaryViolations(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('测试 Markdown 边界扫描器拦截跨行读取调用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noobai-test-markdown-boundary-'));
  const markdownToken = ['.', 'md'].join('');
  try {
    await mkdir(join(root, 'tests', 'unit'), { recursive: true });
    await writeFile(join(root, 'tests', 'unit', 'multiline.test.mjs'), [
      'readFile(',
      `  'guide${markdownToken}'`,
      ');'
    ].join('\n'));
    assert.deepEqual(
      (await findTestMarkdownBoundaryViolations(root)).map(({ line, kind }) => ({ line, kind })),
      [{ line: 1, kind: ['readFile(...', 'md'].join('') }]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('测试 Markdown 边界扫描器允许文件名 fixture 和普通参数字符串', async () => {
  const root = await mkdtemp(join(tmpdir(), 'noobai-test-markdown-boundary-'));
  try {
    await mkdir(join(root, 'tests', 'unit'), { recursive: true });
    await writeFile(join(root, 'tests', 'unit', 'safe.test.mjs'), [
      "writeFile('SKILL.md', 'fixture');",
      "existsSync('SKILL.md');",
      "symlink('outside.md', 'SKILL.md');",
      "git('add', 'README.md');",
      "const argument = 'foo.md';"
    ].join('\n'));
    assert.deepEqual(await findTestMarkdownBoundaryViolations(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
