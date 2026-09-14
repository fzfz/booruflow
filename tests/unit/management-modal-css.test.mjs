import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const managementCss = await readFile(new URL('../../app/web/assets/management.css', import.meta.url), 'utf8');
const legacyModalCss = await readFile(new URL('../../app/web/assets/management-modal.css', import.meta.url), 'utf8');
const managementPages = await Promise.all([
  'loras.html',
  'artist-prompt-strings.html',
  'comfyui-instances.html'
].map((fileName) => readFile(new URL(`../../app/web/${fileName}`, import.meta.url), 'utf8')));
const legacyPage = await readFile(new URL('../../app/web/generation-resources.html', import.meta.url), 'utf8');

test('管理模态弹窗打开时锁定背景页面滚动', () => {
  assert.match(managementCss, /body:has\(dialog:modal\)\s*\{\s*overflow:\s*hidden;\s*\}/u);
  for (const page of managementPages) {
    assert.match(page, /<link rel="stylesheet" href="\/app\/web\/assets\/management\.css">/u);
    assert.doesNotMatch(page, /management-modal\.css/u);
  }

  assert.match(legacyModalCss, /body:has\(dialog:modal\)\s*\{\s*overflow:\s*hidden;\s*\}/u);
  assert.match(legacyPage, /<link rel="stylesheet" href="\/app\/web\/assets\/management-modal\.css">/u);
});
