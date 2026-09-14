import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../..', import.meta.url);
const rootPath = new URL(root).pathname;

async function assertMissing(relativePath) {
  await assert.rejects(access(new URL(relativePath, root)), (error) => error?.code === 'ENOENT');
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:mjs|json)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

test('旧目录 HTTP 处理器已移除，运行代码只保留统一入口', async () => {
  await assertMissing('app/http/catalog-routes.mjs');
  await assertMissing('app/http/internal-catalog-routes.mjs');

  const paths = [...await sourceFiles(join(rootPath, 'app')), ...await sourceFiles(join(rootPath, 'scripts')), join(rootPath, 'package.json')];
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /catalog-routes|internal-catalog-routes/u, path);
  }
});
