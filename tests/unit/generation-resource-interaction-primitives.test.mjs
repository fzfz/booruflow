import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

import { TEST_BROWSER_LAUNCH_OPTIONS } from '../../scripts/test-browser-launch-options.mjs';

const sharedSource = await readFile(new URL('../../app/web/assets/generation-resource-shared.js', import.meta.url), 'utf8');
const modelHtml = await readFile(new URL('../../app/web/models.html', import.meta.url), 'utf8');
const loraHtml = await readFile(new URL('../../app/web/loras.html', import.meta.url), 'utf8');
const executableSharedSource = `${sharedSource.replace(/^export .*?;\n/gmu, '')}
window.__createEditableComboboxForTest = createEditableCombobox;
window.__createPendingMediaCollectionForTest = createPendingMediaCollection;`;

async function openPrimitivePage() {
  const browser = await chromium.launch(TEST_BROWSER_LAUNCH_OPTIONS);
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div class="editable-combobox">
      <input id="format" role="combobox" aria-expanded="false" aria-controls="format-options">
      <div id="format-options" role="listbox" hidden></div>
    </div>
    <button id="outside" type="button">页面其他区域</button>
  </body></html>`);
  await page.evaluate(() => {
    globalThis.__NOOBAI_URLS__ = {};
    globalThis.__NOOBAI_HTTP__ = {};
    globalThis.__NOOBAI_PAGINATION__ = {};
  });
  await page.addScriptTag({ content: executableSharedSource });
  return { browser, page };
}

test('模型和 LoRA 文件格式及精度使用可编辑下拉而不是硬编码 datalist', () => {
  for (const html of [modelHtml, loraHtml]) {
    assert.doesNotMatch(html, /<datalist/u);
    assert.match(html, /role="combobox"/u);
    assert.match(html, /role="listbox"/u);
  }
});

test('可编辑下拉支持筛选建议、键盘选择和保留自定义值', async () => {
  const { browser, page } = await openPrimitivePage();
  try {
    await page.evaluate(() => {
      const combobox = window.__createEditableComboboxForTest({
        input: document.querySelector('#format'),
        listbox: document.querySelector('#format-options')
      });
      combobox.setSuggestions(['safetensors', 'gguf', 'diffusers']);
    });

    const input = page.locator('#format');
    await input.fill('gg');
    assert.equal(await page.locator('#format-options [role="option"]').count(), 1);
    assert.equal(await page.locator('#format-options [role="option"]').textContent(), 'gguf');
    await input.press('ArrowDown');
    await input.press('Enter');
    assert.equal(await input.inputValue(), 'gguf');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');

    await input.fill('custom-container');
    assert.match(await page.locator('#format-options').textContent(), /可以直接保存当前输入/u);
    await input.press('Escape');
    assert.equal(await input.inputValue(), 'custom-container');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
  } finally {
    await browser.close();
  }
});

test('待上传图片集合维护封面和顺序并释放不再使用的本地 URL', async () => {
  const { browser, page } = await openPrimitivePage();
  try {
    const result = await page.evaluate(() => {
      const created = [];
      const revoked = [];
      URL.createObjectURL = (file) => {
        const value = `blob:test/${file.name}`;
        created.push(value);
        return value;
      };
      URL.revokeObjectURL = (value) => revoked.push(value);
      const collection = window.__createPendingMediaCollectionForTest();
      collection.add([
        new File(['a'], 'a.png', { type: 'image/png' }),
        new File(['b'], 'b.webp', { type: 'image/webp' }),
        new File(['c'], 'c.jpg', { type: 'image/jpeg' })
      ]);
      collection.setCover('pending-2');
      collection.move('pending-3', -1);
      const beforeDelete = collection.snapshot();
      collection.remove('pending-2');
      const afterDelete = collection.snapshot();
      collection.clear();
      return {
        created,
        revoked,
        beforeDelete: {
          cover: beforeDelete.cover_media_path,
          ids: beforeDelete.images.map(({ id }) => id)
        },
        afterDelete: {
          cover: afterDelete.cover_media_path,
          ids: afterDelete.images.map(({ id }) => id)
        },
        finalSize: collection.size
      };
    });

    assert.deepEqual(result.created, ['blob:test/a.png', 'blob:test/b.webp', 'blob:test/c.jpg']);
    assert.deepEqual(result.beforeDelete, { cover: 'blob:test/b.webp', ids: ['pending-1', 'pending-3', 'pending-2'] });
    assert.deepEqual(result.afterDelete, { cover: 'blob:test/a.png', ids: ['pending-1', 'pending-3'] });
    assert.deepEqual(result.revoked, ['blob:test/b.webp', 'blob:test/a.png', 'blob:test/c.jpg']);
    assert.equal(result.finalSize, 0);
  } finally {
    await browser.close();
  }
});
